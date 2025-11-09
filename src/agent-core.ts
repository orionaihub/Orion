// src/agent-core.ts - Lightweight Autonomous Agent (Gemini 2.5 Flash Optimized)
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
  tokenBudget?: number; // NEW: soft limit for context
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
      maxTurns: config.maxTurns ?? 8,
      model: config.model ?? 'gemini-2.5-flash',
      thinkingBudget: config.thinkingBudget ?? 2048, // Doubled for deep CoT
      temperature: config.temperature ?? 0.7,
      useSearch: config.useSearch ?? true,
      useCodeExecution: config.useCodeExecution ?? true,
      useMapsGrounding: config.useMapsGrounding ?? false,
      useVision: config.useVision ?? false,
      tokenBudget: config.tokenBudget ?? 50_000, // Safe under 1M
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

  // ===== System Prompt (Gemini 2.5 Flash Autonomous Edition) =====
  private buildSystemPrompt(state: AgentState): string {
    const hasFiles = (state.context?.files?.length ?? 0) > 0;
    const toolNames = this.toolRegistry.getAll().map(t => t.name);
    const hasExternalTools = toolNames.length > 0;
    const cutoffDate = 'November 2025';

    return `You are a lightweight autonomous general intelligence agent powered by Gemini 2.5 Flash — designed for speed, precision, and true independence like Manus, Genspark, or LemonAI.

GEMINI 2.5 FLASH SUPERPOWERS:
- 1 million token context → perfect for deep chain-of-thought
- Native tools (search, code, vision, maps) run inline instantly
- Lightning-fast streaming & structured reasoning

AUTONOMOUS WORKFLOW (PRIORITIZE INTERNAL THINKING):
1. PLAN FIRST — ALWAYS use step-by-step CoT in <thinking> tags:
   <thinking>
   • Goal: [restate user intent]
   • Subtasks: [1. ..., 2. ..., 3. ...]
   • Knowledge gaps: [list only real unknowns]
   </thinking>

2. SOLVE TOOL-FREE IF POSSIBLE — 70% of tasks don’t need tools. Use your up-to-date knowledge (cutoff: ${cutoffDate}) and reasoning.

3. USE NATIVE TOOLS ONLY WHEN NECESSARY:
   - Current events → search
   - Math/data → code execution
   - Images/files → vision
   - Location → maps grounding

4. EXTERNAL TOOLS (${hasExternalTools ? toolNames.join(', ') : 'none'}) → only for custom actions.

5. FINALIZE:
   - Wrap complete answer in <FINAL_ANSWER> ... </FINAL_ANSWER>
   - If incomplete, use <EVOLVE>Reason for refinement...</EVOLVE>

GUIDELINES:
- Be concise yet thorough (200–600 tokens/turn)
- Self-critique: "Do I really need a tool?"
- Confirm dangerous actions
- Files available: ${hasFiles ? 'Yes → analyze inline' : 'No'}
- Never hallucinate dates or facts — use tools for recency

Think aloud. Act decisively. Deliver value fast.`;
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
    history = await this.trimHistory(history);

    let turn = 0;
    let fullResponse = '';
    const batcher = this.createChunkBatcher(callbacks.onChunk);

    try {
      while (turn < this.config.maxTurns) {
        turn++;
        callbacks.onStatus?.(turn === 1 ? 'Planning autonomously...' : `Step ${turn}...`);

        console.log(`%c[Agent] Turn ${turn}/${this.config.maxTurns}`, 'color: #00ff88');

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
          stopSequences: ['</FINAL_ANSWER>'],
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

        // === FINAL ANSWER DETECTION ===
        const hasFinalTag = /<FINAL_ANSWER>[\s\S]*<\/FINAL_ANSWER>/i.test(fullResponse);
        const hasEvolveTag = /<EVOLVE>/.test(fullResponse);
        const noToolCalls = !response.toolCalls?.length;

        if (hasFinalTag || (noToolCalls && turn > 1)) {
          console.log('%c[Agent] Final answer delivered', 'color: gold');
          fullResponse = fullResponse.replace(/<\/?FINAL_ANSWER>/gi, '').trim();
          break;
        }

        // === TOOL CALLS ===
        if (response.toolCalls?.length) {
          callbacks.onToolUse?.(response.toolCalls.map(t => t.name));

          const toolResults = await this.executeTools(response.toolCalls, state, signal);

          history.push({
            role: 'assistant',
            content: response.text || '[tool planning]',
            toolCalls: response.toolCalls,
          });

          const resultsText = toolResults
            .map(r => `${r.name}: ${r.success ? 'Success' : 'Failed'}\n${r.result.substring(0, 1500)}`)
            .join('\n\n');

          history.push({
            role: 'user',
            content: `Tool Results:\n${resultsText}`,
          });

          history = await this.trimHistory(history);
          fullResponse = '';
          continue;
        }

        // === SELF-EVOLUTION ===
        if (hasEvolveTag) {
          history.push({
            role: 'user',
            content: 'Continue evolving the solution based on your <EVOLVE> feedback.',
          });
          fullResponse = '';
          continue;
        }
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

  // ===== Parallel Tool Execution (Cloudflare-safe) =====
  private async executeTools(
    toolCalls: ToolCall[],
    state: AgentState,
    signal?: AbortSignal
  ): Promise<ToolResult[]> {
    const controller = new AbortController();
    const timeoutMs = 14_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const tasks = toolCalls.map(async (call) => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const result = await this.toolRegistry.execute(call.name, call.args, state);
          return result;
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
    clearTimeout(timer);

    return settled.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { name: toolCalls[i].name, success: false, result: `Rejected: ${String(r.reason)}` }
    );
  }

  // ===== Token-Aware History Trimming =====
  private async trimHistory(history: any[]): Promise<any[]> {
    if (!this.gemini.countTokens) {
      return history.slice(-this.config.maxHistoryMessages);
    }

    const system = history[0];
    let used = await this.gemini.countTokens([system]);
    const kept = [system];

    for (let i = history.length - 1; i > 0; i--) {
      const msgTokens = await this.gemini.countTokens([history[i]]);
      if (used + msgTokens > this.config.tokenBudget) break;
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
}
