// src/agent-core.ts - Core Agent Logic (Gemini 2.5 Flash Optimised, Cloudflare-ready)
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
  /** Optional: token budget for history pruning (default 50k) */
  tokenBudget?: number;
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
  onDone?: (turns: number, totalLength: number, tokensUsed?: number) => void;
}

/**
 * Core Agent – autonomous, lightweight, Gemini-2.5-Flash-optimised.
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
      tokenBudget: config.tokenBudget ?? 50_000,
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

  // ===== System Prompt (Gemini-2.5-Flash-aware) =====
  private buildSystemPrompt(state: AgentState): string {
    const hasFiles = (state.context?.files?.length ?? 0) > 0;
    const toolNames = this.toolRegistry.getAll().map(t => t.name);
    const hasExternalTools = toolNames.length > 0;
    const cutoffDate = 'November 2025'; // keep in sync with deployment

    return `You are a lightweight, autonomous general intelligence agent powered by Gemini 2.5 Flash. Like Manus or Genspark, turn natural language into executed actions—plan dynamically, reason deeply, act efficiently.

Gemini 2.5 Flash Strengths:
- 1M token context → rich chain-of-thought (CoT) reasoning.
- Native tools (search, code execution, maps grounding, vision) run inline.
- Low-latency streaming for responsive UX.
- Precise function calling for external tools.

Autonomous Strategy (Internal Planning First):
1. **Plan Internally (Tool-Free)**: Use CoT to break the task:
   • Goal → Sub-tasks → Knowledge gaps.
   If you can answer with knowledge up to ${cutoffDate}, do so directly. No tools needed.
2. **Native Tools Only When Required**: Use search for recency, code for calculations, vision/maps for media.
   Explain: "To verify X, searching Y."
3. **External Tools**: ${hasExternalTools ? toolNames.join(', ') : 'none'}.
   Call only for custom actions.
4. **Finalize**: End with <FINAL_ANSWER>…</FINAL_ANSWER> when complete.

Guidelines:
- Be concise (200-500 tokens/turn).
- Self-critique: “Is this sufficient?”
- Safety: Confirm sensitive actions.
- Files: ${hasFiles ? 'Analyse uploaded files inline.' : 'None.'}

Knowledge cutoff: ${cutoffDate}. Use natives for anything newer. Think aloud briefly.`;
  }

  // ===== Main Processing Logic =====
  async processMessage(
    userMessage: string,
    conversationHistory: Message[],
    state: AgentState,
    callbacks: AgentCallbacks = {},
    signal?: AbortSignal
  ): Promise<{ response: string; turns: number; tokensUsed?: number }> {
    if (userMessage.length > this.config.maxMessageSize) {
      throw new Error('Message exceeds maximum size');
    }

    const systemPrompt = this.buildSystemPrompt(state);
    let history = this.formatHistory(conversationHistory, systemPrompt, userMessage);
    history = await this.trimHistory(history, this.config.tokenBudget);

    let turn = 0;
    let fullResponse = '';
    const batcher = this.createChunkBatcher(callbacks.onChunk);

    try {
      while (turn < this.config.maxTurns) {
        turn++;
        callbacks.onStatus?.(turn === 1 ? 'Planning...' : `Step ${turn}...`);

        const options: GenerateOptions = {
          model: this.config.model,
          thinkingConfig: { thinkingBudget: this.config.thinkingBudget * 2 }, // boost CoT
          temperature: this.config.temperature,
          stream: true,
          useSearch: this.config.useSearch,
          useCodeExecution: this.config.useCodeExecution,
          useMapsGrounding: this.config.useMapsGrounding,
          useVision: this.config.useVision,
          files: state.context?.files ?? [],
          stopSequences: ['<FINAL_ANSWER>'],
        };

        const response = await this.gemini.generateWithTools(
          history,
          this.toolRegistry.getAll(),
          options,
          (chunk: string) => {
            fullResponse += chunk;
            batcher.add(chunk);
          },
          signal
        );
        batcher.flush();

        // ---- Final answer detection ----
        const isFinal =
          response.finishReason === 'stop' ||
          fullResponse.includes('<FINAL_ANSWER>') ||
          (!response.toolCalls?.length && turn > 1);

        if (isFinal) {
          console.log(`[Agent] Completed autonomously at turn ${turn}`);
          break;
        }

        // ---- External tool calls ----
        if (response.toolCalls?.length) {
          callbacks.onToolUse?.(response.toolCalls.map(t => t.name));
          const toolResults = await this.executeTools(response.toolCalls, state, signal);

          // Append assistant message
          history.push({
            role: 'assistant',
            content: response.text || '[tool planning]',
            toolCalls: response.toolCalls,
          });

          // Append concise results (truncate per-result)
          const resultsText = toolResults
            .map(r => `${r.name}: ${r.success ? 'OK' : 'ERR'}\n${r.result.substring(0, 1500)}`)
            .join('\n\n');
          history.push({ role: 'user', content: `Tool Results:\n${resultsText}` });

          // Prune again after adding large results
          history = await this.trimHistory(history, this.config.tokenBudget);
          fullResponse = '';
          continue;
        }
      }

      // Estimate tokens (optional)
      const tokensUsed =
        typeof this.gemini.countTokens === 'function'
          ? await this.gemini.countTokens(history)
          : Math.ceil(fullResponse.length / 4);

      callbacks.onDone?.(turn, fullResponse.length, tokensUsed);
      return { response: fullResponse, turns: turn, tokensUsed };
    } catch (e: any) {
      console.error('[Agent] Fatal error:', e);
      callbacks.onError?.(String(e));
      throw e;
    }
  }

  // ===== Parallel + Timeout Tool Execution =====
  private async executeTools(
    toolCalls: ToolCall[],
    state: AgentState,
    signal?: AbortSignal
  ): Promise<ToolResult[]> {
    const TOOL_TIMEOUT_MS = 15_000;
    const MAX_RETRIES = 1;

    const tasks = toolCalls.map(async call => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS);
      const abort = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const result = await this.toolRegistry.execute(call.name, call.args, state, abort);
          clearTimeout(timeout);
          return result;
        } catch (err: any) {
          if (attempt === MAX_RETRIES || abort.aborted) {
            clearTimeout(timeout);
            return {
              name: call.name,
              success: false,
              result: `Tool failed: ${err.message ?? String(err)}`,
            };
          }
          // simple back-off
          await new Promise(r => self.setTimeout(r, 300));
        }
      }
      return { name: call.name, success: false, result: 'Tool timed out' };
    });

    const settled = await Promise.allSettled(tasks);
    return settled.map(r =>
      r.status === 'fulfilled' ? r.value : { name: 'unknown', success: false, result: `Rejected: ${r.reason}` }
    );
  }

  // ===== History Formatting =====
  private formatHistory(
    messages: Message[],
    systemPrompt: string,
    currentUserMessage: string
  ): any[] {
    const formatted: any[] = [{ role: 'system', content: systemPrompt }];

    for (const msg of messages) {
      const text = Array.isArray(msg.parts)
        ? msg.parts.map((p: any) => p.text ?? '').join('\n')
        : msg.content ?? '';
      formatted.push({
        role: msg.role === 'model' ? 'model' : 'user',
        content: text,
      });
    }

    formatted.push({ role: 'user', content: currentUserMessage });
    return formatted;
  }

  // ===== Token-aware History Pruning =====
  private async trimHistory(history: any[], tokenBudget: number): Promise<any[]> {
    // If Gemini provides countTokens, use it
    if (typeof this.gemini.countTokens === 'function') {
      const system = history[0];
      let used = await this.gemini.countTokens([system]);
      const kept = [system];

      for (let i = history.length - 1; i > 0; i--) {
        const msgTokens = await this.gemini.countTokens([history[i]]);
        if (used + msgTokens > tokenBudget) break;
        used += msgTokens;
        kept.unshift(history[i]);
      }
      return kept;
    }

    // Fallback: message count
    const max = this.config.maxHistoryMessages;
    return history.slice(-max);
  }

  // ===== Cloudflare-compatible Chunk Batcher =====
  private createChunkBatcher(
    onChunk?: ChunkCallback,
    flushInterval = 50
  ): { add: (chunk: string) => void; flush: () => void } {
    let buffer = '';
    let handle: number | null = null;

    const flush = () => {
      if (buffer && onChunk) {
        try {
          onChunk(buffer);
        } catch (e) {
          console.error('[Agent] Chunk callback error:', e);
        }
      }
      buffer = '';
      handle = null;
    };

    return {
      add(chunk: string) {
        buffer += chunk;
        if (!handle) {
          handle = self.setTimeout(flush, flushInterval);
        }
      },
      flush,
    };
  }
}
