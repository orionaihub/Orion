// src/utils/gemini.ts - Fixed Streaming Implementation
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
        console.error(`[GeminiClient] Attempt ${i + 1} failed:`, err);
        if (i < this.maxRetries - 1) {
          const delay = this.baseBackoff * 2 ** i;
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

  // FIXED: Proper streaming handler
  private async handleStreamedResponse(streamResp: any, onChunk?: (text: string) => void): Promise<string> {
    let fullText = '';

    try {
      console.log('[GeminiClient] Starting stream processing');

      // Handle async iterator
      if (streamResp && Symbol.asyncIterator in streamResp) {
        for await (const chunk of streamResp) {
          let text = '';
          
          // Extract text from various possible formats
          if (chunk.text) {
            text = typeof chunk.text === 'function' ? await chunk.text() : chunk.text;
          } else if (chunk.candidates?.[0]?.content?.parts?.[0]?.text) {
            text = chunk.candidates[0].content.parts[0].text;
          } else if (chunk.delta) {
            text = chunk.delta;
          }

          if (text) {
            fullText += text;
            if (onChunk) {
              try {
                onChunk(text);
              } catch (e) {
                console.warn('[GeminiClient] onChunk callback error:', e);
              }
            }
          }
        }
        console.log('[GeminiClient] Stream completed, total length:', fullText.length);
        return fullText;
      }

      // Fallback: try to get text from response
      const result = await Promise.resolve(streamResp);
      if (result.text) {
        fullText = typeof result.text === 'function' ? await result.text() : result.text;
      } else if (result.response?.text) {
        fullText = typeof result.response.text === 'function' 
          ? await result.response.text() 
          : result.response.text;
      }

      if (fullText && onChunk) {
        onChunk(fullText);
      }

      return fullText;
    } catch (e) {
      console.error('[GeminiClient] Stream handling failed:', e);
      throw e;
    }
  }

  // FIXED: Unified Autonomous Method with proper error handling
  async executeUnifiedAutonomous(
    params: {
      userRequest: string;
      currentPhase: string;
      conversationHistory: Array<{ role: string; parts: any[] }>;
      availableTools: string[];
      files?: FileMetadata[];
      urlList?: string[];
    },
    onChunk?: (text: string) => void
  ): Promise<{
    response: string;
    phaseChanges?: string[];
    clarificationRequests?: string[];
    toolCalls?: Array<{ tool: string; params: any }>;
  }> {
    console.log('[GeminiClient] executeUnifiedAutonomous started');
    
    return this.withRetry(async () => {
      const prompt = `You are Orion, an intelligent AI assistant. 

User request: ${params.userRequest}

Provide a helpful, detailed response to the user's request. Be conversational and natural.`;

      const tools: Array<Record<string, unknown>> = [];
      const hasFiles = (params.files ?? []).length > 0;
      const hasUrls = (params.urlList ?? []).length > 0;

      // Enable tools based on availability
      if (params.availableTools.includes('search_grounding')) {
        tools.push({ googleSearch: {} });
      }
      if (params.availableTools.includes('code_execution')) {
        tools.push({ codeExecution: {} });
      }
      if (params.availableTools.includes('file_analysis') && hasFiles) {
        tools.push({ fileAnalysis: {} });
      }
      if (params.availableTools.includes('url_context') && hasUrls) {
        tools.push({ urlContext: {} });
      }
      if (params.availableTools.includes('vision') && hasFiles) {
        tools.push({ vision: {} });
      }

      const contents = this.buildContents(
        prompt,
        params.conversationHistory,
        params.files,
        params.urlList
      );

      console.log('[GeminiClient] Calling Gemini API with tools:', tools.length);

      try {
        const streamCall = this.ai.models.generateContent({
          model: 'gemini-2.0-flash-exp',
          contents,
          config: {
            temperature: 0.7,
            tools: tools.length ? tools : undefined,
          },
        } as any);

        const responseText = await this.handleStreamedResponse(streamCall, onChunk);

        console.log('[GeminiClient] Response received, length:', responseText.length);

        if (!responseText || responseText.trim().length === 0) {
          throw new Error('Empty response from Gemini API');
        }

        return {
          response: responseText,
          phaseChanges: [],
          clarificationRequests: [],
          toolCalls: [],
        };
      } catch (error) {
        console.error('[GeminiClient] API call failed:', error);
        throw error;
      }
    });
  }

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

  getCircuitBreakerStatus() {
    return this.circuitBreaker.getStatus();
  }
}

export default GeminiClient;
