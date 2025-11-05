// src/utils/gemini.ts
import { GoogleGenAI } from '@google/genai';
import type { TaskComplexity, ExecutionPlan, FileMetadata } from '../types';
import type { ExecutionConfig } from '../tools';

/**

* Gemini API wrapper for AI agent, streaming user responses only.
*/
export class GeminiClient {
private ai: ReturnType<typeof GoogleGenAI>;
private maxRetries = 3;
private baseBackoff = 1000;
private defaultTimeoutMs = 60_000;

constructor(opts?: { apiKey?: string }) {
this.ai = new GoogleGenAI({ apiKey: opts?.apiKey });
}

// ---------------- Helper methods ----------------

private parse<T>(text: string): T | null {
try {
const trimmed = text.trim().replace(/^"json\s*/, '').replace(/"$/, '');
return JSON.parse(trimmed) as T;
} catch (e) {
console.warn('[GeminiClient] JSON parse failed', e);
return null;
}
}

private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
let lastError: any;
for (let i = 0; i < this.maxRetries; i++) {
try {
return await fn();
} catch (err) {
lastError = err;
if (i < this.maxRetries - 1) {
const delay = this.baseBackoff * Math.pow(2, i);
await new Promise((r) => setTimeout(r, delay));
}
}
}
throw lastError;
}

private async withTimeout<T>(promise: Promise<T>, errorMsg = 'timeout', ms?: number): Promise<T> {
const timeoutMs = ms ?? this.defaultTimeoutMs;
return Promise.race([
promise,
new Promise<T>((_, reject) => setTimeout(() => reject(new Error(errorMsg)), timeoutMs))
]) as Promise<T>;
}

// ---------------- File operations ----------------

async uploadFile(fileDataBase64: string, mimeType: string, displayName: string): Promise<FileMetadata> {
return this.withRetry(async () => {
const buffer = Buffer.from(fileDataBase64, 'base64');
const uploadResp = await this.withTimeout(
this.ai.files.upload({ file: buffer as any, config: { mimeType, displayName } }),
'uploadFile timed out'
);
const name = uploadResp.name;
const meta = await this.ai.files.get({ name });
return {
fileUri: meta.uri,
mimeType: meta.mimeType,
name: meta.displayName ?? displayName,
sizeBytes: meta.sizeBytes ?? buffer.length,
uploadedAt: Date.now(),
state: meta.state as any,
expiresAt: meta.expirationTime ? new Date(meta.expirationTime).getTime() : undefined,
};
});
}

async getFileStatus(fileUriOrName: string): Promise<string> {
try {
const name = fileUriOrName.split('/').pop() ?? fileUriOrName;
const meta = await this.ai.files.get({ name });
return meta.state ?? 'UNKNOWN';
} catch (e) {
console.warn('[GeminiClient] getFileStatus failed', e);
return 'FAILED';
}
}

async deleteFile(fileUriOrName: string): Promise<void> {
try {
const name = fileUriOrName.split('/').pop() ?? fileUriOrName;
await this.ai.files.delete({ name });
} catch (e) {
console.warn('[GeminiClient] deleteFile failed', e);
}
}

// ---------------- Task complexity ----------------

async analyzeComplexity(query: string, hasFiles = false): Promise<TaskComplexity> {
return this.withRetry(async () => {
const prompt = "Analyze this request and return JSON with type, requiredTools, estimatedSteps, reasoning, requiresFiles, requiresCode, requiresVision. Context: User ${hasFiles ? 'HAS uploaded files' : 'has NOT uploaded files'} Request: ${query}";
const resp = await this.withTimeout(
this.ai.models.generateContent({
model: 'gemini-2.5-flash',
contents: [{ role: 'user', parts: [{ text: prompt }] }],
config: { thinkingConfig: { thinkingBudget: 1024 } }
}),
'analyzeComplexity timed out'
);
const parsed = this.parse<TaskComplexity>(resp.text ?? '');
return parsed ?? {
type: 'simple',
requiredTools: [],
estimatedSteps: 1,
reasoning: 'fallback',
requiresFiles: hasFiles,
requiresCode: false,
requiresVision: false
};
});
}

// ---------------- Execution plan ----------------

async generatePlan(query: string, complexity: TaskComplexity, hasFiles: boolean): Promise<ExecutionPlan> {
return this.withRetry(async () => {
const prompt = "Create a detailed execution plan with sections in JSON format. Context: User ${hasFiles ? 'HAS uploaded files' : 'has NOT uploaded files'} Complexity: ${JSON.stringify(complexity)} Request: ${query}";
const resp = await this.withTimeout(
this.ai.models.generateContent({
model: 'gemini-2.5-flash',
contents: [{ role: 'user', parts: [{ text: prompt }] }],
config: { thinkingConfig: { thinkingBudget: 2048 } }
}),
'generatePlan timed out'
);
const parsed = this.parse<{ sections: any[] }>(resp.text ?? '');
if (!parsed?.sections) {
return { steps: [], sections: [], currentStepIndex: 0, status: 'executing', createdAt: Date.now() };
}

  const allSteps: any[] = [];
  const sections = parsed.sections.map((sec) => {
    const steps = (sec.steps || []).map((s: any) => {
      const step = {
        id: s.id ?? `step_${allSteps.length + 1}`,
        description: s.description ?? '',
        action: s.action ?? 'analyze',
        status: 'pending' as const,
        section: sec.name
      };
      allSteps.push(step);
      return step;
    });
    return { name: sec.name, description: sec.description ?? '', steps, status: 'pending' as const };
  });

  return { steps: allSteps, sections, currentStepIndex: 0, status: 'executing', createdAt: Date.now() };
});

}

// ---------------- Streaming response to user only ----------------

async streamResponse(
query: string,
history: Array<{ role: string; parts: any[] }>,
onChunk: (text: string) => void
): Promise<string> {
const streamResp = await this.ai.models.generateContent({
model: 'gemini-2.5-flash',
contents: [
...history,
{ role: 'user', parts: [{ text: query }] }
],
config: { stream: true }
} as any); // cast due to SDK typings

let fullText = '';

if (streamResp[Symbol.asyncIterator]) {
  for await (const chunk of streamResp as AsyncIterable<{ text?: string }>) {
    const txt = chunk.text ?? '';
    if (txt) {
      fullText += txt;
      onChunk(txt);
    }
  }
} else {
  // fallback if SDK returns full text synchronously
  const txt = (await streamResp).text ?? '';
  fullText = txt;
  onChunk(txt);
}

return fullText;

}

// ---------------- Execute tools synchronously ----------------

async executeWithConfig(
prompt: string,
history: Array<{ role: string; parts: any[] }>,
config: ExecutionConfig
): Promise<string> {
return this.withRetry(async () => {
const tools: any[] = [];

  if (config.useSearch) tools.push({ googleSearch: {} });
  if (config.useCodeExecution) tools.push({ codeExecution: {} });
  if (config.useMapsGrounding) tools.push({ googleMaps: {} });
  if (config.useUrlContext && config.urlList?.length) tools.push({ urlContext: {} });
  if (config.allowComputerUse) tools.push({ computerUse: {} });

  const contents: any[] = [...history.map(h => ({ role: h.role, parts: h.parts }))];

  if (config.files?.length) {
    const fileParts = config.files
      .filter(f => f.state === 'ACTIVE' && f.fileUri)
      .map(f => ({ file_data: { mime_type: f.mimeType, file_uri: f.fileUri } }));
    contents.push({ parts: fileParts });
  }

  if (config.urlList?.length) {
    const urlParts = config.urlList.map(u => ({ url: u }));
    contents.push({ parts: urlParts });
  }

  contents.push({ parts: [{ text: prompt }] });

  const res = await this.withTimeout(
    this.ai.models.generateContent({
      model: config.model ?? 'gemini-2.5-flash',
      contents,
      config: { tools: tools.length ? tools : undefined }
    } as any),
    'executeWithConfig timed out',
    config.timeoutMs
  );

  return res.text ?? '[no-result]';
});

}

// ---------------- Synthesis ----------------

async synthesize(
originalQuery: string,
stepResults: Array<{ description: string; result: string }>,
history: Array<{ role: string; parts: any[] }>
): Promise<string> {
return this.withRetry(async () => {
const prompt = "Original Request: ${originalQuery}\n\nStep Results:\n${stepResults .map((s, i) => "Step ${i + 1} - ${s.description}:\n${s.result}") .join('\n\n')}\n\nTask: Synthesize into a well-structured answer.";

  const resp = await this.withTimeout(
    this.ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { thinkingConfig: { thinkingBudget: 2048 } }
    }),
    'synthesize timed out'
  );
  return resp.text ?? '[no-answer]';
});

}
}

export default GeminiClient;
