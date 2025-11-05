// src/utils/gemini.ts
import { GoogleGenerativeAI, GoogleAIFileManager } from '@google/generative-ai';
import type { TaskComplexity, ExecutionPlan, FileMetadata } from '../types';
import type { ExecutionConfig } from '../tools';

/**
 * Gemini API wrapper with Suna-Lite capabilities
 */
export class GeminiClient {
  private genAI: GoogleGenerativeAI;
  private fileManager: GoogleAIFileManager;
  private maxRetries = 3;
  private baseBackoff = 1000;
  private timeout = 60000; // 60 seconds for code execution

  constructor(apiKey: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.fileManager = new GoogleAIFileManager(apiKey);
  }

  /**
   * Parse JSON response with fallback
   */
  private parse<T>(text: string): T | null {
    try {
      const trimmed = text.trim().replace(/^```json\s*/, '').replace(/```$/, '');
      if (!trimmed) return null;
      return JSON.parse(trimmed) as T;
    } catch (e) {
      console.error('JSON parse failed:', e, 'Raw:', text);
      return null;
    }
  }

  /**
   * Retry wrapper for API calls
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; i < this.maxRetries; i++) {
      try {
        return await fn();
      } catch (error) {
        if (i === this.maxRetries - 1) throw error;
        
        const delay = this.baseBackoff * Math.pow(2, i);
        console.log(`Retry ${i + 1}/${this.maxRetries} after ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw new Error('Max retries exceeded');
  }

  /**
   * Timeout wrapper for API calls
   */
  private async withTimeout<T>(promise: Promise<T>, errorMessage: string): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage)), this.timeout)
    );
    return Promise.race([promise, timeoutPromise]);
  }

  /**
   * Upload file to Gemini
   */
  async uploadFile(fileData: string, mimeType: string, displayName: string): Promise<FileMetadata> {
    try {
      // Convert base64 to buffer
      const buffer = Buffer.from(fileData, 'base64');
      
      // Create temporary file
      const uploadResult = await this.fileManager.uploadFile(buffer as any, {
        mimeType,
        displayName,
      });

      // Get file details
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
    } catch (error) {
      console.error('File upload failed:', error);
      throw error;
    }
  }

  /**
   * Get file status
   */
  async getFileStatus(fileUri: string): Promise<string> {
    try {
      const fileName = fileUri.split('/').pop() || fileUri;
      const file = await this.fileManager.getFile(fileName);
      return file.state;
    } catch (error) {
      console.error('Get file status failed:', error);
      return 'FAILED';
    }
  }

  /**
   * Delete file
   */
  async deleteFile(fileUri: string): Promise<void> {
    try {
      const fileName = fileUri.split('/').pop() || fileUri;
      await this.fileManager.deleteFile(fileName);
    } catch (error) {
      console.error('File deletion failed:', error);
    }
  }

  /**
   * Analyze task complexity (enhanced with file/code awareness)
   */
  async analyzeComplexity(query: string, hasFiles: boolean = false): Promise<TaskComplexity> {
    return this.withRetry(async () => {
      const model = this.genAI.getGenerativeModel({
        model: 'gemini-2.0-flash-exp',
        generationConfig: { responseMimeType: 'application/json' },
      });

      const result = await this.withTimeout(
        model.generateContent({
          contents: [{
            role: 'user',
            parts: [{ text: `Analyze this request and return JSON only:
{
  "type": "simple" | "complex",
  "requiredTools": string[],
  "estimatedSteps": number,
  "reasoning": "brief explanation",
  "requiresFiles": boolean,
  "requiresCode": boolean,
  "requiresVision": boolean
}

Available tools: search, code_execution, file_analysis, vision, data_analysis

Rules:
- "simple": Single-step queries, direct questions, basic requests without files
- "complex": Multi-step tasks, research, analysis, file processing, code execution
- Set requiresFiles=true if user mentions files, documents, data, or analysis
- Set requiresCode=true if task needs calculations, data processing, or programming
- Set requiresVision=true if task involves images or visual content

Context: User ${hasFiles ? 'HAS uploaded files' : 'has NOT uploaded files'}

Request: ${query}` }]
          }],
        }),
        'Complexity analysis timed out'
      );

      const text = (await result.response).text?.() ?? '{}';
      const parsed = this.parse<TaskComplexity>(text);
      
      return parsed || {
        type: 'simple',
        requiredTools: [],
        estimatedSteps: 1,
        reasoning: 'fallback to simple',
        requiresFiles: false,
        requiresCode: false,
        requiresVision: false,
      };
    });
  }

  /**
   * Generate execution plan (enhanced with sections)
   */
  async generatePlan(query: string, complexity: TaskComplexity, hasFiles: boolean): Promise<ExecutionPlan> {
    return this.withRetry(async () => {
      const model = this.genAI.getGenerativeModel({
        model: 'gemini-2.0-flash-exp',
        generationConfig: { responseMimeType: 'application/json' },
      });

      const result = await this.withTimeout(
        model.generateContent({
          contents: [{
            role: 'user',
            parts: [{ text: `Create a detailed execution plan with sections as JSON:
{
  "sections": [
    {
      "name": "Research & Setup" | "Planning" | "Implementation" | "Analysis" | "Verification",
      "description": "Brief description",
      "steps": [
        {
          "id": "step_1",
          "description": "Specific action to take",
          "action": "search|research|code_execute|file_analysis|vision_analysis|data_analysis|analyze|synthesize"
        }
      ]
    }
  ]
}

Available actions:
- search/research: Web search for information
- code_execute: Execute Python code for calculations/analysis
- file_analysis: Analyze uploaded documents (PDF, CSV, TXT)
- vision_analysis: Analyze images
- data_analysis: Comprehensive data analysis with code
- analyze: Reason about information
- synthesize: Combine results into final answer

Context:
- User ${hasFiles ? 'HAS uploaded files' : 'has NOT uploaded files'}
- Complexity: ${JSON.stringify(complexity)}

Create sections in logical order: Research → Planning → Implementation → Analysis → Verification

Request: ${query}` }]
          }],
        }),
        'Plan generation timed out'
      );

      const text = (await result.response).text?.() ?? '{}';
      const data = this.parse<{ sections: any[] }>(text);

      if (!data || !data.sections) {
        return {
          steps: [{
            id: 'step_1',
            description: 'Answer the query directly',
            action: 'analyze',
            status: 'pending',
          }],
          sections: [{
            name: 'Execution',
            description: 'Direct response',
            steps: [],
            status: 'pending',
          }],
          currentStepIndex: 0,
          status: 'executing',
          createdAt: Date.now(),
        };
      }

      // Flatten steps from sections
      const allSteps: any[] = [];
      const sections = data.sections.map((section, sectionIdx) => {
        const sectionSteps = section.steps.map((s: any, stepIdx: number) => {
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

        return {
          name: section.name,
          description: section.description || '',
          steps: sectionSteps,
          status: 'pending' as const,
        };
      });

      return {
        steps: allSteps,
        sections,
        currentStepIndex: 0,
        status: 'executing',
        createdAt: Date.now(),
      };
    });
  }

  /**
   * Stream response (for simple queries, NO TOOLS)
   */
  async streamResponse(
    query: string,
    history: Array<{ role: string; parts: any[] }>,
    onChunk: (text: string) => void
  ): Promise<string> {
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.0-flash-exp',
    });

    const chat = model.startChat({ history });
    let fullText = '';

    try {
      const result = await this.withTimeout(
        chat.sendMessageStream(query),
        'Streaming response timed out'
      );

      for await (const chunk of result.stream) {
        const text = chunk.text?.() ?? '';
        if (text) {
          fullText += text;
          onChunk(text);
        }
      }

      return fullText;
    } catch (error) {
      console.error('Streaming failed:', error);
      throw error;
    }
  }

  /**
   * Execute with configuration (search, code, files)
   */
  async executeWithConfig(
    prompt: string,
    history: Array<{ role: string; parts: any[] }>,
    config: ExecutionConfig
  ): Promise<string> {
    return this.withRetry(async () => {
      const tools: any[] = [];
      
      // Add search tool
      if (config.useSearch) {
        tools.push({ googleSearch: {} });
      }
      
      // Add code execution tool
      if (config.useCodeExecution) {
        tools.push({ codeExecution: {} });
      }

      const model = this.genAI.getGenerativeModel({
        model: 'gemini-2.0-flash-exp',
        ...(tools.length > 0 && { tools }),
      });

      // Build message parts
      const parts: any[] = [{ text: prompt }];
      
      // Add file references
      if (config.files && config.files.length > 0) {
        for (const file of config.files) {
          if (file.state === 'ACTIVE') {
            parts.push({
              fileData: {
                mimeType: file.mimeType,
                fileUri: file.fileUri,
              }
            });
          }
        }
      }

      const chat = model.startChat({ history });

      const result = await this.withTimeout(
        chat.sendMessage(parts),
        'Execution timed out'
      );

      return (await result.response).text?.() ?? '[No result]';
    });
  }

  /**
   * Synthesize final response
   */
  async synthesize(
    originalQuery: string,
    stepResults: Array<{ description: string; result: string }>,
    history: Array<{ role: string; parts: any[] }>
  ): Promise<string> {
    return this.withRetry(async () => {
      const model = this.genAI.getGenerativeModel({
        model: 'gemini-2.0-flash-exp',
      });

      const prompt = `Original Request: ${originalQuery}

Step Results:
${stepResults.map((s, i) => `Step ${i + 1} - ${s.description}:\n${s.result}`).join('\n\n')}

Task: Synthesize these results into a comprehensive, well-structured answer. Be clear, detailed, and directly address the original request.`;

      const result = await this.withTimeout(
        model.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }]
        }),
        'Synthesis timed out'
      );

      return (await result.response).text?.() ?? '[No answer generated]';
    });
  }
}
