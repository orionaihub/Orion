// src/agent-core.ts - Core Agent Logic (Refactored)
import type { AgentState, Message } from './types';
import type { GeminiClient, GenerateOptions } from './gemini';
import type { Tool, ToolCall, ToolResult } from './tools/types';
import { ToolRegistry } from './tools/registry';

export interface AgentConfig {
  maxHistoryMessages?: number;
  maxMessageSize?: number;
  maxTurns?: number;
  model?: string;
  thinkingBudget?: number;
  temperature?: number;
  useSearch?: boolean;
  useCodeExecution?: boolean;
  useMapsGrounding?: boolean;
  useVision?: boolean;
}

export interface ChunkCallback {
  (chunk: string): void;
}

export interface StatusCallback {
  (message: string): void;
}

export interface ToolUseCallback {
  (tools: string[]): void;
}

export interface AgentCallbacks {
  onChunk?: ChunkCallback;
  onStatus?: StatusCallback;
  onToolUse?: ToolUseCallback;
  onError?: (error: string) => void;
  onDone?: (turns: number, totalLength: number) => void;
}

/**
 * Core Agent class - handles conversation logic, tool orchestration, and LLM interaction
 * Separated from Durable Object concerns
 */
export class Agent {
  private config: Required<AgentConfig>;
  private gemini: GeminiClient;
  private toolRegistry: ToolRegistry;

  constructor(gemini: GeminiClient, config: AgentConfig = {}) {
    this.gemini = gemini;
    this.toolRegistry = new ToolRegistry();
    
    this.config = {
      maxHistoryMessages: config.maxHistoryMessages ?? 200,
      maxMessageSize: config.maxMessageSize ?? 100_000,
      maxTurns: config.maxTurns ?? 8,
      model: config.model ?? 'gemini-2.5-flash',
      thinkingBudget: config.thinkingBudget ?? 1024,
      temperature: config.temperature ?? 0.7,
      useSearch: config.useSearch ?? true,
      useCodeExecution: config.useCodeExecution ?? true,
      useMapsGrounding: config.useMapsGrounding ?? false,
      useVision: config.useVision ?? false,
    };
  }

  // ===== Configuration =====

  getConfig(): Readonly<Required<AgentConfig>> {
    return { ...this.config };
  }

  updateConfig(updates: Partial<AgentConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  // ===== Tool Registry =====

  registerTool(tool: Tool): void {
    this.toolRegistry.register(tool);
  }

  unregisterTool(name: string): void {
    this.toolRegistry.unregister(name);
  }

  getRegisteredTools(): Tool[] {
    return this.toolRegistry.getAll();
  }

  // ===== System Prompt =====

  private buildSystemPrompt(state: AgentState): string {
    const hasFiles = (state.context?.files?.length ?? 0) > 0;
    const toolNames = this.toolRegistry.getAll().map(t => t.name);
    const hasExternalTools = toolNames.length > 0;
    
    return `You are an autonomous AI assistant with tool-use capabilities. Your goal is to help users by breaking down complex tasks and using available tools when needed.

# Response Strategy
1. For simple questions: Answer directly without using tools
2. For complex tasks: Use available tools iteratively to gather information and complete the task
3. When you have enough information: Provide a comprehensive final answer

# Available Tools
You have access to native tools (web search, code execution${hasFiles ? ', file analysis' : ''}) that run automatically.
${hasExternalTools ? `\nYou also have external tools: ${toolNames.join(', ')}` : ''}

# Tool Usage Guidelines
- Use tools when you need current information, need to perform calculations, or analyze data
- After receiving tool results, decide if you need more information or can provide a final answer
- Don't use tools unnecessarily for questions you can answer directly
- You can use multiple tools across multiple steps to accomplish complex tasks

# Important
- Always explain your reasoning briefly
- When using tools, tell the user what you're doing
- Provide clear, actionable final answers
${hasFiles ? '- User has uploaded files available for analysis' : ''}

Your knowledge cutoff is January 2025. Use tools to access current information when needed.`;
  }

  // ===== Main Processing Logic =====

  /**
   * Process a user message through the agentic loop
   * @param userMessage - The user's message
   * @param conversationHistory - Previous conversation history
   * @param state - Current agent state
   * @param callbacks - Callbacks for streaming, status, etc.
   * @returns The final response text and metadata
   */
  async processMessage(
    userMessage: string,
    conversationHistory: Message[],
    state: AgentState,
    callbacks: AgentCallbacks = {}
  ): Promise<{ response: string; turns: number }> {
    // Validate message size
    if (userMessage.length > this.config.maxMessageSize) {
      throw new Error('Message exceeds maximum size');
    }

    // Build system prompt and format history
    const systemPrompt = this.buildSystemPrompt(state);
    const formattedHistory = this.formatHistory(conversationHistory, systemPrompt, userMessage);

    let turn = 0;
    let fullResponse = '';
    const batcher = this.createChunkBatcher(callbacks.onChunk);

    try {
      // Agentic loop - model decides when to stop
      while (turn < this.config.maxTurns) {
        turn++;

        // Status callback
        if (callbacks.onStatus) {
          callbacks.onStatus(
            turn === 1 ? 'Thinking...' : `Processing step ${turn}...`
          );
        }

        console.log(`[Agent] Turn ${turn}/${this.config.maxTurns}`);

        // Build generation options
        const options: GenerateOptions = {
          model: this.config.model,
          thinkingConfig: { thinkingBudget: this.config.thinkingBudget },
          temperature: this.config.temperature,
          stream: true,
          useSearch: this.config.useSearch,
          useCodeExecution: this.config.useCodeExecution,
          useMapsGrounding: this.config.useMapsGrounding,
          useVision: this.config.useVision,
          files: state.context?.files ?? [],
        };

        // Generate response with tool capability
        const response = await this.gemini.generateWithTools(
          formattedHistory,
          this.toolRegistry.getAll(),
          options,
          (chunk: string) => {
            fullResponse += chunk;
            batcher.add(chunk);
          }
        );

        batcher.flush();

        // Handle external tool calls
        if (response.toolCalls && response.toolCalls.length > 0) {
          console.log(
            `[Agent] External tool calls: ${response.toolCalls.map(t => t.name).join(', ')}`
          );

          if (callbacks.onToolUse) {
            callbacks.onToolUse(response.toolCalls.map(t => t.name));
          }

          // Execute external tools
          const toolResults = await this.executeTools(response.toolCalls, state);

          // Add assistant's response with tool calls to history
          formattedHistory.push({
            role: 'assistant',
            content: response.text || '[used external tools]',
            toolCalls: response.toolCalls,
          });

          // Add tool results to history
          const resultsText = toolResults
            .map(r => `${r.name}: ${r.success ? 'Success' : 'Failed'}\n${r.result}`)
            .join('\n\n');

          formattedHistory.push({
            role: 'user',
            content: `Tool Results:\n${resultsText}`,
          });

          // Reset for next turn
          fullResponse = '';
          continue;
        }

        // No external tool calls - native tools ran inline
        console.log('[Agent] Final answer received, stopping loop');
        break;
      }

      // Done callback
      if (callbacks.onDone) {
        callbacks.onDone(turn, fullResponse.length);
      }

      return { response: fullResponse, turns: turn };
    } catch (e) {
      console.error('[Agent] Process error:', e);
      if (callbacks.onError) {
        callbacks.onError(String(e));
      }
      throw e;
    }
  }

  // ===== Tool Execution =====

  private async executeTools(
    toolCalls: ToolCall[],
    state: AgentState
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const call of toolCalls) {
      try {
        const result = await this.toolRegistry.execute(call.name, call.args, state);
        results.push(result);
      } catch (e) {
        results.push({
          name: call.name,
          success: false,
          result: `Tool execution failed: ${String(e)}`,
        });
      }
    }

    return results;
  }

  // ===== History Formatting =====

  private formatHistory(
    messages: Message[],
    systemPrompt: string,
    currentUserMessage: string
  ): any[] {
    const formatted: any[] = [
      { role: 'system', content: systemPrompt },
    ];

    // Add previous messages
    for (const msg of messages) {
      formatted.push({
        role: msg.role === 'model' ? 'model' : 'user',
        content: msg.parts.map((p: any) => p.text).join('\n'),
      });
    }

    // Add current user message
    formatted.push({
      role: 'user',
      content: currentUserMessage,
    });

    return formatted;
  }

  // ===== Chunk Batching =====

  private createChunkBatcher(
    onChunk?: ChunkCallback,
    flushInterval = 50
  ): { add: (chunk: string) => void; flush: () => void } {
    let buffer = '';
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      if (buffer && onChunk) {
        try {
          onChunk(buffer);
          buffer = '';
        } catch (e) {
          console.error('[Agent] Chunk callback error:', e);
        }
      }
      timer = null;
    };

    return {
      add: (chunk: string) => {
        buffer += chunk;
        if (!timer) {
          timer = setTimeout(flush, flushInterval);
        }
      },
      flush,
    };
  }
}
