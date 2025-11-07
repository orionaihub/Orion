// src/utils/gemini.ts - Complete Updated Version
import { GoogleGenAI } from '@google/genai';
import type { TaskComplexity, ExecutionPlan, FileMetadata } from '../types';

export interface ExecutionConfig {
  model?: string;
  stream?: boolean;
  timeoutMs?: number;
  thinkingConfig?: { thinkingBudget: number };
  files?: FileMetadata[];
  urlList?: string[];
  useSearch?: boolean;
  useCodeExecution?: boolean;
  useMapsGrounding?: boolean;
  useUrlContext?: boolean;
  allowComputerUse?: boolean;
  useVision?: boolean;
  stepAction?: string;
}

interface ToolConfig {
  tools: Array<Record<string, unknown>>;
  requiresFiles?: boolean;
  requiresUrls?: boolean;
}

class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private readonly threshold = 5;
  private readonly resetTimeout = 60000;

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isOpen()) {
      throw new Error('Circuit breaker open - too many recent failures');
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (e) {
      this.onFailure();
      throw e;
    }
  }

  private isOpen(): boolean {
    if (this.failures >= this.threshold) {
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.reset();
        return false;
      }
      return true;
    }
    return false;
  }

  private onSuccess(): void {
    this.failures = 0;
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
  }

  private reset(): void {
    this.failures = 0;
  }

  getStatus(): { failures: number; isOpen: boolean } {
    return {
      failures: this.failures,
      isOpen: this.isOpen(),
    };
  }
}

export class GeminiClient {
  private ai: ReturnType<typeof GoogleGenAI>;
  private maxRetries = 3;
  private baseBackoff = 1000;
  private defaultTimeoutMs = 60_000;
  private circuitBreaker = new CircuitBreaker();

  private readonly ACTION_TOOL_MAP: Record<string, ToolConfig> = {
    search: { tools: [{ googleSearch: {} }] },
    research: { tools: [{ googleSearch: {} }] },
    code_execute: { tools: [{ codeExecution: {} }] },
    code: { tools: [{ codeExecution: {} }] },
    file_analysis: {
      tools: [{ fileAnalysis: {} }],
      requiresFiles: true,
    },
    file: {
      tools: [{ fileAnalysis: {} }],
      requiresFiles: true,
    },
    vision_analysis: { tools: [{ vision: {} }] },
    vision: { tools: [{ vision: {} }] },
    maps: { tools: [{ googleMaps: {} }] },
    url_context: {
      tools: [{ urlContext: {} }],
      requiresUrls: true,
    },
    url_analysis: {
      tools: [{ urlContext: {} }],
      requiresUrls: true,
    },
    computer: { tools: [{ computerUse: {} }] },
    data_analysis: { tools: [{ codeExecution: {} }] },
    synthesize: { tools: [] },
    analyze: { tools: [] },
  };

  constructor(opts?: { apiKey?: string }) {
    this.ai = new GoogleGenAI({ apiKey: opts?.apiKey });
  }

  private parse<T>(text: string): T | null {
    try {
      if (!text) return null;
      const trimmed = text.trim().replace(/^```json\s*/, '').replace(/```$/, '');
      if (!trimmed) return null;
      return JSON.parse(trimmed) as T;
    } catch (e) {
      console.warn('[GeminiClient] JSON parse failed', e);
      return null;
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: any;
    for (let i = 0; i < this.maxRetries; i++) {
      try {
        return await this.circuitBreaker.execute(fn);
      } catch (err) {
        lastErr = err;
        console.warn(`[GeminiClient] Attempt ${i + 1}/${this.maxRetries} failed:`, err);
        if (i < this.maxRetries - 1) {
          const delay = this.baseBackoff * Math.pow(2, i);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastErr;
  }

  private async withTimeout<T>(promise: Promise<T>, errorMsg = 'timeout', ms?: number): Promise<T> {
    const tm = ms ?? this.defaultTimeoutMs;
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(errorMsg)), tm)),
    ]);
  }

  // ===== Files API =====

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
        state: (meta.state as any) ?? 'ACTIVE',
        expiresAt: meta.expirationTime ? new Date(meta.expirationTime).getTime() : undefined,
      } as FileMetadata;
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

  private mapActionToTools(
    action: string | undefined,
    context: { hasFiles: boolean; hasUrls: boolean }
  ): Array<Record<string, unknown>> {
    if (!action) return [];

    const key = action.toLowerCase().trim();
    const config = this.ACTION_TOOL_MAP[key];

    if (!config) {
      console.warn(`[GeminiClient] Unknown action: ${action}`);
      return [];
    }

    if (config.requiresFiles && !context.hasFiles) {
      console.warn(`[GeminiClient] Action ${action} requires files but none available`);
      return [];
    }

    if (config.requiresUrls && !context.hasUrls) {
      console.warn(`[GeminiClient] Action ${action} requires URLs but none available`);
      return [];
    }

    return config.tools;
  }

  private buildContents(
    prompt: string,
    history?: Array<{ role: string; parts: any[] }>,
    files?: FileMetadata[],
    urlList?: string[]
  ): any[] {
    const contents: any[] = [];

    if (history && history.length) {
      for (const msg of history) {
        contents.push({ role: msg.role, parts: msg.parts });
      }
    }

    if (files && files.length) {
      const fileParts = files
        .filter((f) => f && f.state === 'ACTIVE' && f.fileUri)
        .map((f) => ({
          file_data: { mime_type: f.mimeType, file_uri: f.fileUri },
        }));
      if (fileParts.length) {
        contents.push({ parts: fileParts });
      }
    }

    if (urlList && urlList.length) {
      const urlParts = urlList.map((u) => ({ url: u }));
      contents.push({ parts: urlParts });
    }

    contents.push({ parts: [{ text: prompt }] });

    return contents;
  }

  private extractTextFromChunk(chunk: any): string {
    return chunk?.text ?? chunk?.delta ?? chunk?.content?.text ?? '';
  }

  private async extractTextFromResponse(response: any): Promise<string> {
    if (typeof response?.text === 'string') return response.text;
    if (typeof response?.text === 'function') return await response.text();
    if (response?.response?.text) {
      return typeof response.response.text === 'function'
        ? await response.response.text()
        : response.response.text;
    }
    return '';
  }

  private async handleStreamedResponse(
    streamResp: any,
    onChunk?: (text: string) => void
  ): Promise<string> {
    let fullText = '';

    try {
      console.log('[GeminiClient] Starting stream handling...');
      
      // Check if it's an async iterable
      if (streamResp && typeof streamResp[Symbol.asyncIterator] === 'function') {
        console.log('[GeminiClient] Using async iterator');
        for await (const chunk of streamResp) {
          const text = this.extractTextFromChunk(chunk);
          if (text) {
            fullText += text;
            if (onChunk) {
              try {
                onChunk(text);
              } catch (e) {
                console.warn('[GeminiClient] onChunk error:', e);
              }
            }
          }
        }
        console.log('[GeminiClient] Stream completed, total length:', fullText.length);
        return fullText;
      }

      // Fallback: try to get text directly
      console.log('[GeminiClient] No async iterator, trying direct text extraction');
      const result = await Promise.resolve(streamResp);
      const text = await this.extractTextFromResponse(result);
      if (text) {
        fullText = text;
        if (onChunk) {
          try {
            onChunk(text);
          } catch (e) {
            console.warn('[GeminiClient] onChunk error:', e);
          }
        }
      }

      console.log('[GeminiClient] Extracted text length:', fullText.length);
      return fullText;
    } catch (e) {
      console.error('[GeminiClient] Stream handling failed:', e);
      throw e;
    }
  }

  async analyzeComplexity(query: string, hasFiles = false): Promise<TaskComplexity> {
    return this.withRetry(async () => {
      const prompt = `Analyze request complexity - respond with JSON only:
{
  "type": "simple" | "complex",
  "requiredTools": string[],
  "estimatedSteps": number,
  "reasoning": "brief",
  "requiresFiles": boolean,
  "requiresCode": boolean,
  "requiresVision": boolean
}

Rules:
- simple: greetings, basic questions, single-step tasks
- complex: research, multi-step analysis, file processing

Files: ${hasFiles ? 'YES' : 'NO'}
Query: ${query}`;

      const resp = await this.withTimeout(
        this.ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
          config: { thinkingConfig: { thinkingBudget: 512 } },
        }),
        'analyzeComplexity timed out',
        30_000
      );

      const text = (resp?.text ?? '') as string;
      const parsed = this.parse<TaskComplexity>(text);
      if (parsed) return parsed;

      return {
        type: 'simple',
        requiredTools: [],
        estimatedSteps: 1,
        reasoning: 'fallback',
        requiresFiles: hasFiles,
        requiresCode: false,
        requiresVision: false,
      } as TaskComplexity;
    });
  }

  async generatePlanOptimized(
    query: string,
    complexity: TaskComplexity,
    hasFiles: boolean,
    maxSteps: number = 5
  ): Promise<ExecutionPlan> {
    return this.withRetry(async () => {
      const prompt = `Create execution plan (MAX ${maxSteps} steps) - JSON only:
{
  "steps": [
    {
      "id": "s1",
      "description": "concise action",
      "action": "search|code_execute|file_analysis|analyze|synthesize"
    }
  ]
}

Rules:
- Keep steps minimal and focused
- Combine related actions
- Use "search" for research, "analyze" for thinking, "synthesize" for final answer
- MAX ${maxSteps} steps total

Context: ${hasFiles ? 'Has files' : 'No files'}
Tools needed: ${complexity.requiredTools.join(', ') || 'none'}

Query: ${query}`;

      const resp = await this.withTimeout(
        this.ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
          config: { thinkingConfig: { thinkingBudget: 1024 } },
        }),
        'generatePlan timed out',
        30_000
      );

      const text = (resp?.text ?? '') as string;
      const parsed = this.parse<{ steps: any[] }>(text);

      if (!parsed || !parsed.steps) {
        return {
          steps: [
            {
              id: 's1',
              description: 'Provide direct answer',
              action: 'synthesize',
              status: 'pending',
            },
          ],
          currentStepIndex: 0,
          status: 'executing',
          createdAt: Date.now(),
        } as ExecutionPlan;
      }

      const limitedSteps = parsed.steps.slice(0, maxSteps).map((s: any, i: number) => ({
        id: s.id ?? `s${i + 1}`,
        description: s.description ?? 'Step',
        action: s.action ?? 'analyze',
        status: 'pending' as const,
      }));

      return {
        steps: limitedSteps,
        currentStepIndex: 0,
        status: 'executing',
        createdAt: Date.now(),
      } as ExecutionPlan;
    });
  }

  async generatePlan(query: string, complexity: TaskComplexity, hasFiles: boolean): Promise<ExecutionPlan> {
    return this.generatePlanOptimized(query, complexity, hasFiles, 8);
  }

  async streamResponse(
    query: string,
    history: Array<{ role: string; parts: any[] }>,
    onChunk?: (text: string) => void,
    opts?: { model?: string; thinkingConfig?: any; timeoutMs?: number }
  ): Promise<string> {
    return this.withRetry(async () => {
      const modelName = opts?.model ?? 'gemini-2.5-flash';
      const contents = this.buildContents(query, history);

      console.log('[GeminiClient] streamResponse called');
      console.log('[GeminiClient] Model:', modelName);
      console.log('[GeminiClient] Contents length:', contents.length);

      try {
        const streamCall = this.ai.models.generateContent({
          model: modelName,
          contents,
          config: {
            thinkingConfig: opts?.thinkingConfig ?? { thinkingBudget: 512 },
          },
        } as any);

        console.log('[GeminiClient] Generate content called, awaiting response...');
        
        const result = await this.withTimeout(
          streamCall,
          'streamResponse timed out',
          opts?.timeoutMs ?? this.defaultTimeoutMs
        );

        console.log('[GeminiClient] Response received');
        
        // Extract text from response
        let fullText = '';
        if (typeof result?.text === 'string') {
          fullText = result.text;
        } else if (typeof result?.text === 'function') {
          fullText = await result.text();
        }

        console.log('[GeminiClient] Extracted text length:', fullText.length);

        // Call onChunk with full text if provided
        if (fullText && onChunk) {
          try {
            onChunk(fullText);
          } catch (e) {
            console.warn('[GeminiClient] onChunk error:', e);
          }
        }

        return fullText;
      } catch (e) {
        console.error('[GeminiClient] streamResponse error:', e);
        throw e;
      }
    });
  }

  async executeWithConfig(
    prompt: string,
    history: Array<{ role: string; parts: any[] }>,
    config: ExecutionConfig,
    onChunk?: (text: string) => void
  ): Promise<string> {
    return this.withRetry(async () => {
      let tools: Array<Record<string, unknown>> = [];

      const hasFiles = (config.files ?? []).length > 0;
      const hasUrls = (config.urlList ?? []).length > 0;

      if (config.stepAction) {
        tools = this.mapActionToTools(config.stepAction, { hasFiles, hasUrls });
      } else {
        if (config.useSearch) tools.push({ googleSearch: {} });
        if (config.useCodeExecution) tools.push({ codeExecution: {} });
        if (config.useMapsGrounding) tools.push({ googleMaps: {} });
        if (config.useUrlContext && hasUrls) tools.push({ urlContext: {} });
        if (config.allowComputerUse) tools.push({ computerUse: {} });
        if (hasFiles) tools.push({ fileAnalysis: {} });
        if (config.useVision) tools.push({ vision: {} });
      }

      const contents = this.buildContents(prompt, history, config.files ?? [], config.urlList ?? []);

      const call = this.ai.models.generateContent({
        model: config.model ?? 'gemini-2.5-flash',
        contents,
        config: {
          thinkingConfig: config.thinkingConfig ?? { thinkingBudget: 512 },
          tools: tools.length ? tools : undefined,
        },
      } as any);

      const resp = await this.withTimeout(call, 'executeWithConfig timed out', config.timeoutMs);
      
      let text = '';
      if (typeof resp?.text === 'string') {
        text = resp.text;
      } else if (typeof resp?.text === 'function') {
        text = await resp.text();
      }

      if (text && onChunk) {
        try {
          onChunk(text);
        } catch (e) {
          console.warn('[GeminiClient] onChunk error:', e);
        }
      }

      return text || '[no-result]';
    });
  }

  async synthesize(
    originalQuery: string,
    stepResults: Array<{ description: string; result: string }>,
    history: Array<{ role: string; parts: any[] }>
  ): Promise<string> {
    return this.withRetry(async () => {
      const prompt = `Request: ${originalQuery}

Results:
${stepResults.map((s, i) => `${i + 1}. ${s.description}: ${s.result.substring(0, 300)}`).join('\n')}

Provide comprehensive answer:`;

      const resp = await this.withTimeout(
        this.ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
          config: { thinkingConfig: { thinkingBudget: 1024 } },
        }),
        'synthesize timed out',
        45_000
      );

      let text = '';
      if (typeof resp?.text === 'string') {
        text = resp.text;
      } else if (typeof resp?.text === 'function') {
        text = await resp.text();
      }

      return text || '[no-answer]';
    });
  }

  getCircuitBreakerStatus() {
    return this.circuitBreaker.getStatus();
  }
}

export default GeminiClient;
