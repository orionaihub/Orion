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
  tokenBudget?: number;
}

export interface ChunkCallback { (chunk: string): void; }
export interface StatusCallback { (message: string): void; }
export interface ToolUseCallback { (tools: string[]): void; }

export interface AgentCallbacks {
  onChunk?: ChunkCallback;
  onStatus?: StatusCallback;
  onToolUse?: ToolUseCallback;
  onError?: (error: string) => void;
  onDone?: (turns: number, totalLength: number, tokensUsed?: number) => void;
}

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
      maxTurns: config.maxTurns ?? 40, // increased base
      model: config.model ?? 'gemini-1.5-flash',
      thinkingBudget: config.thinkingBudget ?? 4096, // raised base
      temperature: config.temperature ?? 0.7,
      useSearch: config.useSearch ?? true,
      useCodeExecution: config.useCodeExecution ?? true,
      useMapsGrounding: config.useMapsGrounding ?? false,
      useVision: config.useVision ?? false,
      tokenBudget: config.tokenBudget ?? 200_000, // raised base
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

  // ===== System Prompt (Hardened for Convergence) =====
  private buildSystemPrompt(state: AgentState): string {
    const hasFiles = (state.context?.files?.length ?? 0) > 0;
    const toolNames = this.toolRegistry.getAll().map(t => t.name);
    const hasExternalTools = toolNames.length > 0;
    const cutoffDate = 'November 2025';

    return `You are a lightweight autonomous general intelligence agent powered by Gemini 1.5 Flash — designed for speed, precision, and true independence.

GEMINI 1.5 FLASH SUPERPOWERS:
- 1M token context → deep chain-of-thought
- Native tools run inline instantly
- Lightning-fast streaming & structured reasoning

AUTONOMOUS WORKFLOW (PRIORITIZE INTERNAL THINKING):
1. PLAN FIRST — ALWAYS use step-by-step CoT in <thinking> tags:
   <thinking>
   • Goal: [restate user intent]
   • Subtasks: [1. ..., 2. ..., 3. ...]
   • Knowledge gaps: [list only real unknowns]
   </thinking>

2. SOLVE TOOL-FREE IF POSSIBLE — 70% of tasks don’t need tools. Use knowledge (cutoff: ${cutoffDate}) and reasoning.

3. USE NATIVE TOOLS ONLY WHEN NECESSARY:
   - Current events → search
   - Math/data → code execution
   - Images/files → vision
   - Location → maps grounding

4. EXTERNAL TOOLS (${hasExternalTools ? toolNames.join(', ') : 'none'}) → only for custom actions.

5. FINALIZE:
   - Wrap complete answer in <FINAL_ANSWER>...</FINAL_ANSWER>
   - If incomplete and no tools needed, use <EVOLVE>brief reason</EVOLVE>

CRITICAL CONVERGENCE RULES:
- ALWAYS close <FINAL_ANSWER>...</FINAL_ANSWER> even if thinkingBudget exhausts.
- If deeper reasoning needed without tools, end with <EVOLVE>reason</EVOLVE>
- NEVER output naked text after <thinking> without a terminal tag.
- Self-check: "Did I close the tag? Is this ready for the user?"
- Files available: ${hasFiles ? 'Yes → analyze inline' : 'No'}

Be concise yet thorough (200–800 tokens/turn). Think aloud. Act decisively.`;
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

    // === Complexity Detection & Budget Boost ===
    const messageTokens = userMessage.length / 4;
    const historyTokens = conversationHistory.reduce((sum, m) => sum + (m.content?.length || 0) / 4, 0);
    const fileCount = state.context?.files?.length ?? 0;
    const complexityScore = messageTokens + historyTokens + fileCount * 20_000;

    const localThinkingBudget = complexityScore > 30_000 ? 8192 : this.config.thinkingBudget;
    const localTokenBudget = complexityScore > 30_000 ? 500_000 : this.config.tokenBudget;
    const localMaxTurns = complexityScore > 30_000 ? 50 : this.config.maxTurns;

    if (complexityScore > 30_000) {
      callbacks.onStatus?.('Complex task detected — boosting budgets (thinking: 8k, tokens: 500k, turns: 50)');
    }

    const systemPrompt = this.buildSystemPrompt(state);
    let history = this.formatHistory(conversationHistory, systemPrompt, userMessage);
    history = await this.trimHistory(history, localTokenBudget);

    let turn = 0;
    let fullResponse = '';
    const batcher = this.createChunkBatcher(callbacks.onChunk);

    try {
      while (turn < localMaxTurns) {
        turn++;
        callbacks.onStatus?.(turn === 1 ? 'Planning autonomously...' : `Turn ${turn}/${localMaxTurns}...`);

        console.log(`%c[Agent] Turn ${turn}/${localMaxTurns}`, 'color: #00ff88');

        const options: GenerateOptions = {
          model: this.config.model,
          thinkingConfig: { thinkingBudget: localThinkingBudget },
          temperature: this.config.temperature,
          stream: true,
          useSearch: this.config.useSearch,
          useCodeExecution: this.config.useCodeExecution,
          useMapsGrounding: this.config.useMapsGrounding,
          useVision: this.config.useVision,
          files: state.context?.files ?? [],
          stopSequences: [], // Removed — caused early truncation
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

        // === Always push assistant message first ===
        history.push({
          role: 'assistant',
          content: response.text || fullResponse || '[empty]',
          toolCalls: response.toolCalls,
        });
        history = await this.trimHistory(history, localTokenBudget);

        // === Robust Final Answer Detection (accepts unclosed) ===
        const finalMatch = fullResponse.match(/<FINAL_ANSWER>([\s\S]*?)<\/FINAL_ANSWER>/i) ||
                           fullResponse.match(/<FINAL_ANSWER>([\s\S]*)/i);
        if (finalMatch) {
          fullResponse = finalMatch[1].trim();
          console.log('%c[Agent] Final answer delivered', 'color: gold');
          break;
        }

        // === Tool Calls ===
        if (response.toolCalls?.length) {
          callbacks.onToolUse?.(response.toolCalls.map(t => t.name));

          const toolResults = await this.executeTools(response.toolCalls, state, signal);

          const resultsText = toolResults
            .map(r => `${r.name}: ${r.success ? 'Success' : 'Failed'}\n${r.result.substring(0, 1500)}`)
            .join('\n\n');

          history.push({
            role: 'user',
            content: `Tool Results:\n${resultsText}`,
          });

          history = await this.trimHistory(history, localTokenBudget);
          fullResponse = '';
          continue;
        }

        // === Evolve Tag ===
        const evolveMatch = fullResponse.match(/<EVOLVE>([\s\S]*?)<\/EVOLVE>/i);
        if (evolveMatch) {
          const reason = evolveMatch[1].trim() || 'continue refinement';
          history.push({
            role: 'user',
            content: `Continue evolving: ${reason}`,
          });
          fullResponse = '';
          continue;
        }

        // === Fallback Convergence ===
        if (turn > 1) {
          console.log('%c[Agent] No terminal tag — assuming final (consecutive text turn)', 'color: orange');
          break;
        }

        if (turn >= 4) {
          history.push({
            role: 'user',
            content: 'You have not used <FINAL_ANSWER> or <EVOLVE> recently. Finalize the answer now.',
          });
          fullResponse = '';
          continue;
        }

        // First turn no tags → natural continuation
        fullResponse = '';
      }

      const tokensUsed = await this.gemini.countTokens?.(history) ?? Math.ceil(fullResponse.length / 4);
      callbacks.onDone?.(turn, fullResponse.length, tokensUsed);
      return { response: fullResponse.trim(), turns: turn, tokensUsed };
    } catch (e: any) {
      console.error('[Agent] Fatal error:', e);
      callbacks.onError?.(e.message || String(e));
      throw e;
    }
  }

  // ===== Per-Tool Timeout (30s each) =====
  private async executeTools(
    toolCalls: ToolCall[],
    state: AgentState,
    signal?: AbortSignal
  ): Promise<ToolResult[]> {
    const tasks = toolCalls.map(async (call) => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const toolPromise = this.toolRegistry.execute(call.name, call.args, state);
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Tool timeout (30s)')), 30_000)
          );
          const result = await Promise.race([toolPromise, timeoutPromise]);
          return {
            name: call.name,
            success: true,
            result: typeof result === 'string' ? result : JSON.stringify(result),
          };
        } catch (e) {
          if (attempt === 2) {
            return {
              name: call.name,
              success: false,
              result: `Failed after retry: ${String(e)}`,
            };
          }
          await new Promise(r => setTimeout(r, 600));
        }
      }
      return { name: call.name, success: false, result: 'Unknown error' };
    });

    const settled = await Promise.allSettled(tasks);
    return settled.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { name: toolCalls[i].name, success: false, result: `Rejected: ${String(r.reason)}` }
    );
  }

  // ===== Token-Aware History Trimming (with override) =====
  private async trimHistory(history: any[], budgetOverride?: number): Promise<any[]> {
    const budget = budgetOverride ?? this.config.tokenBudget;
    if (!this.gemini.countTokens) {
      return history.slice(-this.config.maxHistoryMessages);
    }

    const system = history[0];
    let used = await this.gemini.countTokens([system]);
    const kept = [system];

    for (let i = history.length - 1; i > 0; i--) {
      const msgTokens = await this.gemini.countTokens([history[i]]);
      if (used + msgTokens > budget) break;
      used += msgTokens;
      kept.unshift(history[i]);
    }

    return kept;
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
        ? msg.parts.map((p: any) => p.text || '').join('\n')
        : msg.content || '';
      formatted.push({
        role: msg.role === 'model' ? 'model' : 'user',
        content: text,
      });
    }

    formatted.push({ role: 'user', content: currentUserMessage });
    return formatted;
  }

  // ===== Cloudflare Workers-Compatible Chunk Batcher =====
  private createChunkBatcher(
    onChunk?: ChunkCallback,
    flushInterval = 50
  ): { add: (chunk: string) => void; flush: () => void } {
    let buffer = '';
    let handle: any = null;

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
      add: (chunk: string) => {
        buffer += chunk;
        if (!handle) {
          handle = self.setTimeout(flush, flushInterval);
        }
      },
      flush,
    };
  }
}""
