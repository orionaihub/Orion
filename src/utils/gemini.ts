import { GoogleGenerativeAI, GoogleAIFileManager } from '@google/generative-ai';
import type { TaskComplexity, ExecutionPlan, FileMetadata } from '../types';
import type { ExecutionConfig } from '../tools';

export default class GeminiClient {
private genAI: GoogleGenerativeAI;
private fileManager: GoogleAIFileManager;
private maxRetries = 3;
private baseBackoff = 1000;
private timeout = 60000; // 60s

constructor(apiKey: string) {
this.genAI = new GoogleGenerativeAI(apiKey);
this.fileManager = new GoogleAIFileManager(apiKey);
}

private parse<T>(text: string): T | null {
try {
const trimmed = text.trim().replace(/^"json\s*/, '').replace(/"$/, '');
if (!trimmed) return null;
return JSON.parse(trimmed) as T;
} catch (e) {
console.error('JSON parse failed:', e, 'Raw:', text);
return null;
}
}

private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
for (let i = 0; i < this.maxRetries; i++) {
try {
return await fn();
} catch (error) {
if (i === this.maxRetries - 1) throw error;
const delay = this.baseBackoff * 2 ** i;
await new Promise((r) => setTimeout(r, delay));
}
}
throw new Error('Max retries exceeded');
}

private async withTimeout<T>(promise: Promise<T>, errorMessage: string): Promise<T> {
const timeoutPromise = new Promise<never>((_, reject) =>
setTimeout(() => reject(new Error(errorMessage)), this.timeout)
);
return Promise.race([promise, timeoutPromise]);
}

async uploadFile(fileData: string, mimeType: string, displayName: string): Promise<FileMetadata> {
const buffer = Buffer.from(fileData, 'base64');
const uploadResult = await this.fileManager.uploadFile(buffer as any, { mimeType, displayName });
const file = await this.fileManager.getFile(uploadResult.file.name);
return {
fileUri: file.uri,
mimeType: file.mimeType,
name: file.displayName || displayName,
sizeBytes: file.sizeBytes || buffer.length,
uploadedAt: Date.now(),
state: file.state as any,
expiresAt: file.expirationTime ? new Date(file.expirationTime).getTime() : undefined,
};
}

async getFileStatus(fileUri: string): Promise<string> {
try {
const fileName = fileUri.split('/').pop() || fileUri;
const file = await this.fileManager.getFile(fileName);
return file.state;
} catch {
return 'FAILED';
}
}

async deleteFile(fileUri: string): Promise<void> {
try {
const fileName = fileUri.split('/').pop() || fileUri;
await this.fileManager.deleteFile(fileName);
} catch (err) {
console.error('File deletion failed:', err);
}
}

async analyzeComplexity(query: string, hasFiles = false): Promise<TaskComplexity> {
return this.withRetry(async () => {
const model = this.genAI.getGenerativeModel({
model: 'gemini-2.5-flash',
generationConfig: { responseMimeType: 'application/json' },
});

  const result = await this.withTimeout(
    model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `Analyze task complexity and return JSON:

{
"type": "simple" | "complex",
"requiredTools": string[],
"estimatedSteps": number,
"reasoning": "brief explanation",
"requiresFiles": boolean,
"requiresCode": boolean,
"requiresVision": boolean
}
Context: User ${hasFiles ? 'HAS uploaded files' : 'has NOT uploaded files'}
Request: ${query}`,
},
],
},
],
}),
'Complexity analysis timed out'
);

  const text = (await result.response).text?.() ?? '{}';
  return this.parse<TaskComplexity>(text) || {
    type: 'simple',
    requiredTools: [],
    estimatedSteps: 1,
    reasoning: 'fallback',
    requiresFiles: false,
    requiresCode: false,
    requiresVision: false,
  };
});

}

async generatePlan(query: string, complexity: TaskComplexity, hasFiles: boolean): Promise<ExecutionPlan> {
return this.withRetry(async () => {
const model = this.genAI.getGenerativeModel({
model: 'gemini-2.5-flash',
generationConfig: { responseMimeType: 'application/json' },
});

  const result = await this.withTimeout(
    model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `Create detailed multi-step execution plan (JSON) with sections:

Context: ${hasFiles ? 'User HAS files' : 'User has NO files'}
Complexity: ${JSON.stringify(complexity)}
Request: ${query}`,
},
],
},
],
}),
'Plan generation timed out'
);

  const data = this.parse<{ sections: any[] }>((await result.response).text?.() ?? '{}');
  if (!data?.sections) {
    return {
      steps: [{ id: 'step_1', description: 'Directly answer query', action: 'analyze', status: 'pending' }],
      sections: [{ name: 'Execution', description: 'Direct response', steps: [], status: 'pending' }],
      currentStepIndex: 0,
      status: 'executing',
      createdAt: Date.now(),
    };
  }

  const allSteps: any[] = [];
  const sections = data.sections.map((section) => {
    const sectionSteps = section.steps.map((s: any) => {
      const step = {
        id: s.id || `step_${allSteps.length + 1}`,
        description: s.description || 'Process step',
        action: s.action || 'analyze',
        status: 'pending' as const,
        section: section.name,
      };
      allSteps.push(step);
      return step;
    });
    return { name: section.name, description: section.description || '', steps: sectionSteps, status: 'pending' as const };
  });

  return { steps: allSteps, sections, currentStepIndex: 0, status: 'executing', createdAt: Date.now() };
});

}

async executeWithConfig(prompt: string, history: any[], config: ExecutionConfig): Promise<string> {
return this.withRetry(async () => {
const tools: any[] = [];
if (config.useSearch) tools.push({ name: 'google_search', input: { query: prompt, top_k: 3 } });
if (config.useCodeExecution) tools.push({ name: 'code_execute', input: { code: prompt } });
if (config.urlList?.length) tools.push({ name: 'url_context', input: { urls: config.urlList } });
if (config.functionCalls?.length) {
tools.push(...config.functionCalls.map((fn) => ({ name: fn.name, input: fn.args })));
}

  const model = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash', tools });

  const parts: any[] = [{ text: prompt }];
  if (config.files?.length) {
    for (const file of config.files) {
      if (file.state === 'ACTIVE') parts.push({ fileData: { mimeType: file.mimeType, fileUri: file.fileUri } });
    }
  }

  const chat = model.startChat({ history });
  const result = await this.withTimeout(chat.sendMessage(parts), 'Execution timed out');
  return (await result.response).text?.() ?? '[No result]';
});

}

async streamResponse(query: string, history: any[], onChunk: (text: string) => void): Promise<string> {
const model = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
const chat = model.startChat({ history });
let fullText = '';
const result = await this.withTimeout(chat.sendMessageStream(query), 'Streaming timed out');
for await (const chunk of result.stream) {
const text = chunk.text?.() ?? '';
if (text) {
fullText += text;
onChunk(text);
}
}
return fullText;
}

async synthesize(originalQuery: string, stepResults: Array<{ description: string; result: string }>, history: any[]): Promise<string> {
return this.withRetry(async () => {
const model = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
const prompt = "Original Request: ${originalQuery}\n\nStep Results:\n${stepResults .map((s, i) => "Step ${i + 1} - ${s.description}:\n${s.result}") .join('\n\n')}\n\nTask: Synthesize into a comprehensive, well-structured answer.";
const result = await this.withTimeout(
model.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
'Synthesis timed out'
);
return (await result.response).text?.() ?? '[No answer generated]';
});
}
}
