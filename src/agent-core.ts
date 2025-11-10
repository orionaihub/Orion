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

    // ===== System Prompt (ENHANCED) =====

  private buildSystemPrompt(state: AgentState): string {
    const toolNames = this.toolRegistry.getAll().map((t) => t.name);
    const hasExternalTools = toolNames.length > 0;
    const hasFiles = (state.context?.files?.length ?? 0) > 0;

    // This is the new, enhanced prompt
    return `
# 🚀 ROLE
You are a lightweight, autonomous general intelligence agent.
Your purpose is to assist users by reasoning, planning, and executing tasks.
You operate on a serverless platform, so you must be efficient and clear.

# 💎 CAPABILITIES (Gemini 2.5 Flash Native)
You have direct, native access to the following capabilities, which you can use implicitly.
* **Search Grounding:** Real-time Google Search.
* **Document Understanding:** You can read and understand the ${
      hasFiles ? `${state.context?.files?.length} file(s)` : 'any files'
    } the user has uploaded.
* **Code Execution:** You can run Python code for calculations, data analysis, or manipulation.

# 🛠️ TOOLS (External Functions)
${
  hasExternalTools
    ? `You MUST use these tools to interact with the outside world or to plan.
* ${toolNames.join('\n* ')}`
    : 'You have no external tools loaded.'
}

# 📜 CONSTRAINTS & BEHAVIOR (CRITICAL)
1.  **Efficiency:** Be concise. Avoid conversational fluff.
2.  **Task Handling:** You MUST categorize the user's request:
    * **Simple Tasks:** (e.g., "What is 2+2?", "Summarize this text") Answer directly in one response. You may use native tools (Search, Code) implicitly. Do NOT use the \`planNextStep\` tool.
    * **Complex Tasks:** (e.g., "Research X and write a report," "Analyze this data and find trends," "Compare options for Y") If a task is ambiguous or requires multiple steps, you MUST NOT answer directly.

3.  **For Complex Tasks, your FIRST response MUST be a call to the \`planNextStep\` tool.**

# 🔄 AUTONOMOUS LOOP (Your Thought Process for Complex Tasks)
When a task is complex, you will follow this internal loop.
1.  **THINK & PLAN:** The user gives a goal. You will call \`planNextStep\` with your internal thoughts, a step-by-step plan, and the first step to execute.
2.  **EXECUTE:** The system will execute the step (e.g., call a native capability, or an external tool like \`calculator\`).
3.  **REFLECT & REVISE:** The system will feed the execution result back to you. You will then call \`planNextStep\` AGAIN to update your plan, mark the step as complete, and state the *next* step.
4.  **REPEAT:** You will continue this "THINK-EXECUTE-REFLECT" loop until the plan is complete.
5.  **FINISH:** Once all steps are done, you will provide the final, complete answer to the user. Do not call \`planNextStep\` with \`status: 'COMPLETED'\`; provide the final answer as text.
`;
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
  // src/agent-core.ts (Only the processMessage method is shown for brevity)
// ASSUMES the buildSystemPrompt and other methods are as previously provided.

  // ===== Main Processing Logic (FINAL IMPLEMENTATION) =====

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
