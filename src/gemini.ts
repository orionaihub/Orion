// src/utils/gemini.ts - Multi-step autonomous version (Refactored)
import { GoogleGenAI } from '@google/genai';
import type { TaskComplexity, ExecutionPlan, FileMetadata } from '../types';

// This interface is gone, as its properties are merged into GenerateOptions
// export interface ExecutionConfig { ... }

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export interface GenerateOptions {
  model?: string;
  stream?: boolean;
  timeoutMs?: number;
  thinkingConfig?: { thinkingBudget: number };
  temperature?: number;

  // === ADDED ===
  // Native tool flags
  useSearch?: boolean;
  useCodeExecution?: boolean;
  useMapsGrounding?: boolean;
  useVision?: boolean;

  // File/URL context
  files?: FileMetadata[];
  urlList?: string[];
}

export interface GenerateResponse {
  text: string;
  toolCalls?: Array<{
    name: string;
    args: Record<string, any>;
  }>;
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
  private readonly resetTimeout = 60_000;

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

  // REMOVED: ACTION_TOOL_MAP

  constructor(opts?: { apiKey?: string }) {
    this.ai = new GoogleGenAI({ apiKey: opts?.apiKey });
  }

  private parse<T>(text: string): T | null {
    try {
      if (!text) return null;
      const trimmed = text
        .trim()
        .replace(/^\s*```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '');
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

  // ===== Tool Conversion =====

  private convertToolsToFunctions(tools: Tool[]): any[] {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }));
  }

  private formatConversationHistory(history: any[]): any[] {
    return history.map(msg => {
      if (msg.role === 'system') {
        // System messages become user messages with system context
        return {
          role: 'user',
          parts: [{ text: `[System Instructions]\n${msg.content}` }]
        };
      }
      
      return {
        role: msg.role === 'model' || msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content || '' }]
      };
    });
  }

  private extractTextFromChunk(chunk: any): string {
    return chunk?.text ?? chunk?.delta ?? chunk?.content?.text ?? '';
  }

  private async extractTextFromResponse(response: any): Promise<string> {
    if (!response) return '';
    if (typeof response?.text === 'string') return response.text;
    if (typeof response?.text === 'function') return await response.text();
    if (response?.response?.text) {
      return typeof response.response.text === 'function'
        ? await response.response.text()
        : response.response.text;
    }
    if (response?.result?.text) {
      return typeof response.result.text === 'function' 
        ? await response.result.text() 
        : response.result.text;
    }
    return '';
  }

  private parseResponse(response: any): GenerateResponse {
    const result: GenerateResponse = { text: '' };

    // Extract text
    if (response?.candidates?.[0]?.content?.parts) {
      const parts = response.candidates[0].content.parts;
      result.text = parts
        .filter((p: any) => p.text)
        .map((p: any) => p.text)
        .join('');
      
      // Extract function calls (tool calls)
      const functionCalls = parts.filter((p: any) => p.functionCall);
      if (functionCalls.length > 0) {
        result.toolCalls = functionCalls.map((fc: any) => ({
          name: fc.functionCall.name,
          args: fc.functionCall.args || {}
        }));
      }
    } else if (typeof response?.text === 'string') {
      result.text = response.text;
    }

    return result;
  }

  private async handleStreamedResponse(
    streamResp: any,
    onChunk?: (text: string) => void
  ): Promise<GenerateResponse> {
    let fullText = '';
    const toolCalls: Array<{ name: string; args: Record<string, any> }> = [];

    try {
      if (streamResp && typeof streamResp[Symbol.asyncIterator] === 'function') {
        for await (const chunk of streamResp) {
          // Extract text
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

          // Extract tool calls from chunks
          if (chunk?.candidates?.[0]?.content?.parts) {
            const parts = chunk.candidates[0].content.parts;
            const functionCalls = parts.filter((p: any) => p.functionCall);
            for (const fc of functionCalls) {
              toolCalls.push({
                name: fc.functionCall.name,
                args: fc.functionCall.args || {}
              });
            }
          }
        }
        
        return { 
          text: fullText, 
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined 
        };
      }

      // Fallback
      const candidateIterable = streamResp?.stream ?? streamResp?.iterable ?? null;
      if (candidateIterable && typeof candidateIterable[Symbol.asyncIterator] === 'function') {
        for await (const chunk of candidateIterable) {
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
        return { text: fullText };
      }

      // Last fallback: direct extraction
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

      return { text: fullText };
    } catch (e) {
      console.error('[GeminiClient] Stream handling failed:', e);
      throw e;
    }
  }

  // ===== Main Multi-Step Method (Refactored) =====

  /**
   * Generate response with tool use capability
   * This is the main method for the agentic loop
   */
  async generateWithTools(
    conversationHistory: any[],
    tools: Tool[], // External tools
    options: GenerateOptions = {},
    onChunk?: (text: string) => void
  ): Promise<GenerateResponse> {
    return this.withRetry(async () => {
      const modelName = options.model ?? 'gemini-2.5-flash';
      
      // 1. Build Contents (merging logic from old buildContents)
      const contents = this.formatConversationHistory(conversationHistory);
      
      // Get the last user message to append context (files, URLs)
      const lastUserMessage = contents[contents.length - 1];
      if (lastUserMessage && lastUserMessage.role === 'user') {
        const fileParts = (options.files ?? [])
          .filter((f) => f && f.state === 'ACTIVE' && f.fileUri)
          .map((f) => ({
            file_data: { mime_type: f.mimeType, file_uri: f.fileUri },
          }));
        
        const urlParts = (options.urlList ?? []).map((u) => ({ url: u }));
        
        if (fileParts.length > 0 || urlParts.length > 0) {
          // Prepend context parts to the last user message's parts
          lastUserMessage.parts = [
            ...fileParts, 
            ...urlParts, 
            ...lastUserMessage.parts
          ];
        }
      }
      
      // 2. Build Tool Config (Native + External)
      const toolConfigs: any[] = [];
      
      // Add external tools
      const functionDeclarations = tools.length > 0 
        ? this.convertToolsToFunctions(tools) 
        : undefined;
      
      if (functionDeclarations) {
        toolConfigs.push({ functionDeclarations });
      }
      
      // Add native tools
      if (options.useSearch) toolConfigs.push({ googleSearch: {} });
      if (options.useCodeExecution) toolConfigs.push({ codeExecution: {} });
      if (options.useMapsGrounding) toolConfigs.push({ googleMaps: {} });
      if (options.useVision) toolConfigs.push({ vision: {} });
      
      // 3. Build final generation config
      const config: any = {
        thinkingConfig: options.thinkingConfig ?? { thinkingBudget: 1024 },
        temperature: options.temperature ?? 0.7,
      };
      
      if (toolConfigs.length > 0) {
        config.tools = toolConfigs;
      }
      
      // 4. Execute call
      if (options.stream) {
        // Streaming generation
        const generateCall = this.ai.models.generateContentStream({
          model: modelName,
          contents,
          config
        } as any);

        const streamResp = await this.withTimeout(
          generateCall, 
          'generateWithTools timeout', 
          options.timeoutMs
        );

        return await this.handleStreamedResponse(streamResp, onChunk);
      } else {
        // Non-streaming generation
        const generateCall = this.ai.models.generateContent({
          model: modelName,
          contents,
          config
        } as any);

        const response = await this.withTimeout(
          generateCall, 
          'generateWithTools timeout', 
          options.timeoutMs
        );

        const result = this.parseResponse(response);
        
        if (result.text && onChunk) {
          try {
            onChunk(result.text);
          } catch (e) {
            console.warn('[GeminiClient] onChunk error:', e);
          }
        }

        return result;
      }
    });
  }

  // ===== Legacy Methods (REMOVED) =====
  // REMOVED: streamResponse
  // REMOVED: executeWithConfig

  // ===== Helper Methods (REMOVED) =====
  // REMOVED: mapActionToTools
  // REMOVED: buildContents

  // ===== Files API (Unchanged) =====

  async uploadFile(fileDataBase64: string, mimeType: string, displayName: string): Promise<FileMetadata> {
    return this.withRetry(async () => {
      const buffer = Buffer.from(fileDataBase64, 'base64');
      const uploadResp: any = await this.withTimeout(
        this.ai.files.upload({ file: buffer as any, config: { mimeType, displayName } }),
        'uploadFile timed out'
      );
      const name = uploadResp?.name;
      if (!name) {
        throw new Error('uploadFile failed: no file name returned from upload');
      }
      const meta: any = await this.ai.files.get({ name });
      return {
        fileUri: meta?.uri,
        mimeType: meta?.mimeType ?? mimeType,
        name: meta?.displayName ?? displayName,
        sizeBytes: meta?.sizeBytes ?? buffer.length,
        uploadedAt: Date.now(),
        state: (meta?.state as any) ?? 'ACTIVE',
        expiresAt: meta?.expirationTime ? new Date(meta.expirationTime).getTime() : undefined,
      } as FileMetadata;
    });
  }

  async getFileStatus(fileUriOrName: string): Promise<string> {
    try {
      const name = fileUriOrName.split('/').pop() ?? fileUriOrName;
      const meta: any = await this.ai.files.get({ name });
      return meta?.state ?? 'UNKNOWN';
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
