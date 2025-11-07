// src/utils/gemini-v2.ts - Tool-Driven Architecture
import { GoogleGenAI } from '@google/genai';
import type { Tool, ToolCall } from '../types';

export interface GenerateOptions {
  model?: string;
  stream?: boolean;
  thinkingConfig?: { thinkingBudget: number };
  temperature?: number;
  maxTokens?: number;
}

export interface GenerateResponse {
  text: string;
  toolCalls?: ToolCall[];
  parts: any[];
  finishReason?: string;
}

export class GeminiClient {
  private ai: ReturnType<typeof GoogleGenAI>;
  private maxRetries = 3;
  private baseBackoff = 1000;
  private defaultTimeoutMs = 60_000;

  constructor(opts?: { apiKey?: string }) {
    // NOTE: Assumes GoogleGenAI is imported and configured correctly
    this.ai = new GoogleGenAI({ apiKey: opts?.apiKey });
  }

  /**
   * Generate response with tool use capability
   * This is the main method for the agentic loop
   */
  async generateWithTools(
    conversationHistory: any[],
    tools: Tool[],
    options: GenerateOptions = {},
    onChunk?: (text: string) => void
  ): Promise<GenerateResponse> {
    return this.withRetry(async () => {
      const modelName = options.model ?? 'gemini-2.5-flash';
      
      // Convert conversation history to Gemini format
      const contents = this.formatConversationHistory(conversationHistory);
      
      // Convert tools to Gemini function declaration format
      const functionDeclarations = tools.length > 0 
        ? this.convertToolsToFunctions(tools) 
        : undefined;
      
      const config: any = {
        thinkingConfig: options.thinkingConfig ?? { thinkingBudget: 1024 },
        temperature: options.temperature ?? 0.7,
      };
      
      if (functionDeclarations) {
        config.tools = [{ functionDeclarations }];
      }
      
      if (options.stream) {
        config.stream = true;
      }
      
      const generateCall = this.ai.models.generateContent({
        model: modelName,
        contents,
        config
      });
      
      if (options.stream) {
        return await this.handleStreamedResponse(generateCall, onChunk);
      }
      
      const response = await this.withTimeout(generateCall, 'generateContent timeout');
      return this.parseResponse(response);
    });
  }

  /**
   * Simple streaming without tools - for basic chat
   */
  async streamSimple(
    prompt: string,
    history: any[] = [],
    onChunk?: (text: string) => void,
    options: GenerateOptions = {}
  ): Promise<string> {
    return this.withRetry(async () => {
      const modelName = options.model ?? 'gemini-2.5-flash';
      
      const contents = [
        ...history.map((h: any) => ({
          role: h.role === 'model' ? 'model' : 'user',
          parts: h.parts
        })),
        { role: 'user', parts: [{ text: prompt }] }
      ];
      
      const streamCall = this.ai.models.generateContent({
        model: modelName,
        contents,
        config: {
           thinkingConfig: options.thinkingConfig ?? { thinkingBudget: 512 },
          stream: true
        }
      });
      
      let fullText = '';
      
      if (streamCall && Symbol.asyncIterator in streamCall) {
        for await (const chunk of streamCall) {
          
          let text = '';
          // --- FIX: Robust extraction logic applied here as well ---
          if (typeof chunk?.text === 'string') {
            text = chunk.text;
          } else if (typeof chunk?.text === 'function') {
            text = chunk.text();
          } else if (chunk?.content?.parts) {
            text = chunk.content.parts
              .map((part: any) => part.text)
              .filter((t: string) => t)
              .join('');
          } else {
            text = chunk?.delta ?? '';
          }
          // --- END FIX ---

          if (text) {
            fullText += text;
            if (onChunk) onChunk(text);
          }
        }
      }
      
      return fullText;
    });
  }

  // ===== Helper Methods =====

  private formatConversationHistory(history: any[]): any[] {
    const formatted: any[] = [];
    for (const msg of history) {
      if (msg.role === 'system') {
        // System messages become user messages in Gemini
        formatted.push({
          role: 'user',
          parts: [{ text: msg.content }]
        });
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        formatted.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: typeof msg.content === 'string' 
            ? [{ text: msg.content }]
            : msg.parts || [{ text: String(msg.content) }]
        });
      }
    }
    
    return formatted;
  }

  private convertToolsToFunctions(tools: Tool[]): any[] {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }));
  }

  private async handleStreamedResponse(
    streamResp: any,
    onChunk?: (text: string) => void
  ): Promise<GenerateResponse> {
    let fullText = '';
    let toolCalls: ToolCall[] = [];
    let parts: any[] = [];
    let finishReason: string | undefined;
    
    try {
      if (streamResp && Symbol.asyncIterator in streamResp) {
        for await (const chunk of streamResp) {
          
          let text = '';
          
          // --- FIX: Robust multi-case text extraction from stream chunk (CRITICAL) ---
          if (typeof chunk?.text === 'string') {
            // Case 1: Text is a string property (e.g., modern @google/genai SDK)
            text = chunk.text;
          } else if (typeof chunk?.text === 'function') {
            // Case 2: Text is a function (e.g., older SDK or specific wrappers)
            text = chunk.text();
          } else if (chunk?.content?.parts) {
            // Case 3: Manual deep dive into content parts for raw text
            const partsText = chunk.content.parts
              .map((part: any) => part.text)
              .filter((t: string) => t)
              .join('');
            if (partsText) {
              text = partsText;
            }
          } else {
            // Case 4: Fallback for delta property
            text = chunk?.delta ?? ''; 
          }
          // --- END FIX ---
          
          if (text) {
            fullText += text;
            if (onChunk) {
              try {
                onChunk(text);
              } catch (e) {
                console.warn('onChunk error:', e);
              }
            }
          }
          
          // Extract function calls
          if (chunk?.functionCalls) {
            for (const fc of chunk.functionCalls) {
              toolCalls.push({
                name: fc.name,
                args: fc.args || {}
              });
            }
          }
          
          // Store parts
          if (chunk?.parts) {
            parts.push(...chunk.parts);
          }
          
          // Store finish reason
          if (chunk?.finishReason) {
            finishReason = chunk.finishReason;
          }
        }
      }
      
      return {
        text: fullText,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        parts,
        finishReason
      };
    } catch (e) {
      console.error('Stream handling failed:', e);
      throw e;
    }
  }

  private parseResponse(response: any): GenerateResponse {
    let text = '';
    let toolCalls: ToolCall[] = [];
    let parts: any[] = [];
    
    // Extract text
    if (typeof response?.text === 'string') {
      text = response.text;
    } else if (typeof response?.text === 'function') {
      text = response.text();
    }
    
    // Extract function calls
    const candidates = response?.candidates || [];
    for (const candidate of candidates) {
      const content = candidate?.content;
      if (content?.parts) {
        parts.push(...content.parts);
        for (const part of content.parts) {
          if (part.functionCall) {
            toolCalls.push({
              name: part.functionCall.name,
              args: part.functionCall.args || {}
            });
          }
        }
      }
    }
    
    return {
      text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      parts,
      finishReason: candidates[0]?.finishReason
    };
  }

  // ===== Utility Methods =====

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: any;
    for (let i = 0; i < this.maxRetries; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        console.warn(`Attempt ${i + 1} failed:`, err);
        if (i < this.maxRetries - 1) {
          const delay = this.baseBackoff * Math.pow(2, i);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    
    throw lastErr;
  }

  private async withTimeout<T>(
    promise: Promise<T>, 
    errorMsg = 'timeout', 
    ms?: number
  ): Promise<T> {
    const timeoutMs = ms ?? this.defaultTimeoutMs;
    
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => 
        setTimeout(() => reject(new Error(errorMsg)), timeoutMs)
      )
    ]);
  }

  // ===== File Management =====

  async uploadFile(
    fileDataBase64: string, 
    mimeType: string, 
    displayName: string
  ): Promise<any> {
    return this.withRetry(async () => {
      const buffer = Buffer.from(fileDataBase64, 'base64');
      
      const uploadResp = await this.withTimeout(
        this.ai.files.upload({ 
          file: buffer as any, 
          config: { mimeType, displayName } 
        }),
        'File upload timeout',
        30_000
      );
      
      const meta = await this.ai.files.get({ name: uploadResp.name });
      
      return {
        fileUri: meta.uri,
        mimeType: meta.mimeType,
        name: meta.displayName ?? displayName,
        sizeBytes: meta.sizeBytes ?? buffer.length,
        uploadedAt: Date.now(),
        state: meta.state ?? 'ACTIVE',
        expiresAt: meta.expirationTime 
          ? new Date(meta.expirationTime).getTime() 
          : undefined
      };
    });
  }

  async getFileStatus(fileUriOrName: string): Promise<string> {
    try {
      const name = fileUriOrName.split('/').pop() ?? fileUriOrName;
      const meta = await this.ai.files.get({ name });
      return meta.state ?? 'UNKNOWN';
    } catch (e) {
      console.warn('getFileStatus failed:', e);
      return 'FAILED';
    }
  }

  async deleteFile(fileUriOrName: string): Promise<void> {
    try {
      const name = fileUriOrName.split('/').pop() ?? fileUriOrName;
      await this.ai.files.delete({ name });
    } catch (e) {
      console.warn('deleteFile failed:', e);
    }
  }
}

export default GeminiClient;
