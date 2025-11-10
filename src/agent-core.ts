// src/agent-core.ts - Fixed Autonomous Agent (Gemini 2.5 Flash)
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
      maxTurns: config.maxTurns ?? 40,
      model: config.model ?? 'gemini-2.5-flash',
      thinkingBudget: config.thinkingBudget ?? 4096,
      temperature: config.temperature ?? 0.7,
      useSearch: config.useSearch ?? true,
      useCodeExecution: config.useCodeExecution ?? true,
      useMapsGrounding: config.useMapsGrounding ?? false,
      useVision: config.useVision ?? false,
      tokenBudget: config.tokenBudget ?? 200_000,
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

  // ===== System Prompt (Fixed for Better Convergence) =====
  private buildSystemPrompt(state: AgentState): string {
    const hasFiles = (state.context?.files?.length ?? 0) > 0;
    const toolNames = this.toolRegistry.getAll().map(t => t.name);
    const hasExternalTools = toolNames.length > 0;
    const cutoffDate = 'November 2025';

    return `You are an autonomous agent powered by Gemini 2.5 Flash with advanced reasoning capabilities.

MANDATORY WORKFLOW - FOLLOW EXACTLY:

1. THINK (optional) - Use <thinking> for planning:
   <thinking>
   - Goal: [what user wants]
   - Plan: [steps]
   - Tools: [list or "none"]
   </thinking>

2. ACT - Use tools if needed:
   ${this.config.useSearch ? '- Search: current events/recent information' : ''}
   ${this.config.useCodeExecution ? '- Code: calculations/data analysis' : ''}
   ${hasExternalTools ? `- External tools: ${toolNames.join(', ')}` : ''}

3. **RESPOND - YOU MUST ALWAYS USE THIS TAG FOR FINAL OUTPUT:**
   <FINAL_ANSWER>
   Your complete response to the user goes here.
   Include all analysis, summaries, and conclusions.
   </FINAL_ANSWER>

   **CRITICAL**: After using tools OR after your analysis is complete, you MUST wrap your response in <FINAL_ANSWER> tags. Do NOT just output text directly.

4. IF you need more thinking without tools:
   <EVOLVE>Brief reason</EVOLVE>

EXAMPLES OF CORRECT BEHAVIOR:
❌ WRONG: "Here's a summary: [content]" (no tags)
✅ CORRECT: "<FINAL_ANSWER>Here's a summary: [content]</FINAL_ANSWER>"

❌ WRONG: After tool results, output analysis directly
✅ CORRECT: After tool results, wrap analysis in <FINAL_ANSWER>

RULES:
- Tool results are provided back to you - analyze them then use <FINAL_ANSWER>
- Knowledge cutoff: ${cutoffDate}
- Be concise (200-800 tokens per turn)
${hasFiles ? '- Files available for analysis' : ''}
- **NEVER output your final response without <FINAL_ANSWER> tags**

Remember: Every complete response to the user needs <FINAL_ANSWER> tags!`;
  }

  // ===== Main Processing Logic (FIXED) =====
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
      callbacks.onStatus?.('Complex task detected — boosting budgets');
    }

    const systemPrompt = this.buildSystemPrompt(state);
    let history = this.formatHistory(conversationHistory, systemPrompt, userMessage);
    history = await this.trimHistory(history, localTokenBudget);

    let turn = 0;
    let accumulatedResponse = ''; // Accumulate final answer text
    let consecutiveEmptyTurns = 0; // Track empty responses
    let turnsWithoutProgress = 0; // Track stagnation

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
        };

        let turnResponse = '';
        const batcher = this.createChunkBatcher(callbacks.onChunk);

        const response = await this.gemini.generateWithTools(
          history,
          this.toolRegistry.getAll(),
          options,
          (chunk: string) => {
            turnResponse += chunk;
            batcher.add(chunk);
          },
          signal
        );

        batcher.flush();

        // Use the complete response text
        const fullTurnText = response.text || turnResponse;
        
        // Check for empty response
        if (!fullTurnText.trim()) {
          consecutiveEmptyTurns++;
          if (consecutiveEmptyTurns >= 2) {
            console.warn('[Agent] Multiple empty responses - forcing completion');
            break;
          }
          // Prompt model to continue
          history.push({ role: 'user', content: 'Please provide your response.' });
          continue;
        }
        
        consecutiveEmptyTurns = 0;

        // === Check for FINAL_ANSWER first (before adding to history) ===
        const finalMatch = fullTurnText.match(/<FINAL_ANSWER>([\s\S]*?)<\/FINAL_ANSWER>/i) ||
                           fullTurnText.match(/<FINAL_ANSWER>([\s\S]*)/i); // Handle unclosed
        
        if (finalMatch) {
          console.log('%c[Agent] ✓ Final answer detected', 'color: gold');
          accumulatedResponse = finalMatch[1].trim();
          
          // Add the message to history for completeness
          history.push({
            role: 'assistant',
            content: fullTurnText,
            toolCalls: response.toolCalls,
          });
          
          break; // Exit loop - task complete
        }

        // === Check for tool calls ===
        if (response.toolCalls && response.toolCalls.length > 0) {
          console.log(`%c[Agent] Executing ${response.toolCalls.length} tool(s)`, 'color: cyan');
          callbacks.onToolUse?.(response.toolCalls.map(t => t.name));

          // Add assistant message with tool calls
          history.push({
            role: 'assistant',
            content: fullTurnText,
            toolCalls: response.toolCalls,
          });

          // Execute tools
          const toolResults = await this.executeTools(response.toolCalls, state, signal);

          // Format results properly for Gemini
          const resultsText = toolResults
            .map(r => {
              const status = r.success ? '✓ Success' : '✗ Failed';
              const output = r.result.substring(0, 2000); // Prevent token overflow
              return `Tool: ${r.name}\nStatus: ${status}\nResult:\n${output}`;
            })
            .join('\n\n---\n\n');

          // Add tool results as user message (Gemini pattern)
          history.push({
            role: 'user',
            content: `Tool execution results:\n\n${resultsText}\n\n⚠️ IMPORTANT: Analyze these results and provide your FINAL ANSWER wrapped in <FINAL_ANSWER> tags. Example:\n<FINAL_ANSWER>\n[Your analysis and summary here]\n</FINAL_ANSWER>`,
          });

          history = await this.trimHistory(history, localTokenBudget);
          turnsWithoutProgress = 0; // Reset - we made progress
          continue;
        }

        // === Check for EVOLVE tag ===
        const evolveMatch = fullTurnText.match(/<EVOLVE>([\s\S]*?)<\/EVOLVE>/i);
        if (evolveMatch) {
          const reason = evolveMatch[1].trim() || 'continue refinement';
          console.log(`%c[Agent] Evolving: ${reason}`, 'color: orange');
          
          // Add assistant message
          history.push({
            role: 'assistant',
            content: fullTurnText,
          });

          // Continue evolution
          history.push({
            role: 'user',
            content: `Continue: ${reason}`,
          });

          history = await this.trimHistory(history, localTokenBudget);
          turnsWithoutProgress = 0;
          continue;
        }

        // === No recognized tags - check if this looks like a final answer ===
        turnsWithoutProgress++;
        
        // Add message to history
        history.push({
          role: 'assistant',
          content: fullTurnText,
        });

        // Heuristic: If response is substantial (>100 chars) and looks complete, treat as final
        const looksLikeFinalAnswer = fullTurnText.length > 100 && 
                                      !fullTurnText.includes('need more') &&
                                      !fullTurnText.includes('let me') &&
                                      (fullTurnText.includes('summary') || 
                                       fullTurnText.includes('conclusion') ||
                                       fullTurnText.includes('Here\'s') ||
                                       fullTurnText.includes('In summary'));
        
        if (turnsWithoutProgress >= 2 && looksLikeFinalAnswer) {
          console.warn('[Agent] Detected complete response without tags - accepting as final');
          accumulatedResponse = fullTurnText;
          break;
        }

        // Force completion after repeated turns without progress
        if (turnsWithoutProgress >= 3) {
          console.warn('[Agent] No progress for 3 turns - forcing finalization');
          history.push({
            role: 'user',
            content: '⚠️ CRITICAL: You must wrap your response in <FINAL_ANSWER> tags. Example:\n<FINAL_ANSWER>\nYour complete answer here\n</FINAL_ANSWER>\n\nDo this now.',
          });
          turnsWithoutProgress = 0; // Reset counter
          continue;
        }

        // Early turns without tags - assume thinking/planning
        if (turn <= 2) {
          console.log('[Agent] Early turn without tags - continuing');
          continue;
        }

        // Prompt for finalization with stronger language
        history.push({
          role: 'user',
          content: 'IMPORTANT: Wrap your final response in <FINAL_ANSWER> tags. If you need more analysis, use <EVOLVE> tags. Do not output text without these tags.',
        });
        
        history = await this.trimHistory(history, localTokenBudget);
      }

      // === Fallback if no final answer was extracted ===
      if (!accumulatedResponse.trim() && history.length > 0) {
        // Get last assistant message
        for (let i = history.length - 1; i >= 0; i--) {
          if (history[i].role === 'assistant') {
            accumulatedResponse = history[i].content || '';
            break;
          }
        }
      }

      const tokensUsed = await this.gemini.countTokens?.(history) ?? Math.ceil(accumulatedResponse.length / 4);
      callbacks.onDone?.(turn, accumulatedResponse.length, tokensUsed);
      
      return { 
        response: accumulatedResponse.trim() || 'Task completed with no text output.', 
        turns: turn, 
        tokensUsed 
      };

    } catch (e: any) {
      console.error('[Agent] Fatal error:', e);
      callbacks.onError?.(e.message || String(e));
      throw e;
    }
  }

  // ===== Tool Execution with Timeout =====
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
            result: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          };
        } catch (e: any) {
          if (attempt === 2) {
            return {
              name: call.name,
              success: false,
              result: `Failed after retry: ${e.message || String(e)}`,
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

  // ===== Token-Aware History Trimming =====
  private async trimHistory(history: any[], budgetOverride?: number): Promise<any[]> {
    const budget = budgetOverride ?? this.config.tokenBudget;
    
    if (!this.gemini.countTokens) {
      return history.slice(-this.config.maxHistoryMessages);
    }

    const system = history[0];
    let used = await this.gemini.countTokens([system]);
    const kept = [system];

    // Keep most recent messages within budget
    for (let i = history.length - 1; i > 0; i--) {
      const msgTokens = await this.gemini.countTokens([history[i]]);
      if (used + msgTokens > budget) break;
      used += msgTokens;
      kept.unshift(history[i]);
    }

    console.log(`[Agent] History trimmed: ${history.length} → ${kept.length} messages (${used} tokens)`);
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
        role: msg.role === 'model' ? 'assistant' : msg.role,
        content: text,
      });
    }

    formatted.push({ role: 'user', content: currentUserMessage });
    return formatted;
  }

  // ===== Chunk Batcher =====
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
          handle = setTimeout(flush, flushInterval);
        }
      },
      flush,
    };
  }
}
