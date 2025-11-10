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
  responseModality?: 'text' | 'audio';
  safetySettings?: Array<{ category: string; threshold: string }>;
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
      maxHistoryMessages: config.maxHistoryMessages ?? 250,
      maxMessageSize: config.maxMessageSize ?? 150_000,
      maxTurns: config.maxTurns ?? 50,
      model: config.model ?? 'gemini-2.0-flash-exp', // Updated model
      thinkingBudget: config.thinkingBudget ?? 8192, // Higher for 2.5
      temperature: config.temperature ?? 0.8, // Slightly higher for creativity
      useSearch: config.useSearch ?? true,
      useCodeExecution: config.useCodeExecution ?? true,
      useMapsGrounding: config.useMapsGrounding ?? false,
      useVision: config.useVision ?? false,
      tokenBudget: config.tokenBudget ?? 1_000_000, // 2.5 Flash has 1M context
      responseModality: config.responseModality ?? 'text',
      safetySettings: config.safetySettings ?? [],
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

  // ===== Enhanced System Prompt for Gemini 2.5 Flash =====
  private buildSystemPrompt(state: AgentState): string {
    const hasFiles = (state.context?.files?.length ?? 0) > 0;
    const toolNames = this.toolRegistry.getAll().map(t => t.name);
    const hasExternalTools = toolNames.length > 0;
    const cutoffDate = 'December 2024';

    return `You are an advanced autonomous agent powered by Gemini 2.5 Flash — the fastest, most efficient multimodal AI with breakthrough capabilities.

🚀 GEMINI 2.5 FLASH CAPABILITIES:
• 1M token context window → comprehensive understanding
• Multimodal reasoning → seamlessly process text, code, images, audio, video
• Native function calling → execute tools with precision
• Enhanced code execution → run Python, analyze data, create visualizations
• Real-time search integration → access current information
• Improved multilingual support → 100+ languages with cultural nuance
• Low latency streaming → instant responses
• Advanced reasoning → superior logic, math, and problem-solving

⚡ OPERATIONAL FRAMEWORK (AUTONOMOUS & EFFICIENT):

1. STRUCTURED REASONING — Use chain-of-thought in <thinking> tags for complex tasks:
   <thinking>
   OBJECTIVE: [Restate user's goal precisely]
   ANALYSIS: [Break down the problem]
   APPROACH: [Outline solution strategy]
   CONSTRAINTS: [Note any limitations or assumptions]
   KNOWLEDGE_CHECK: [What do I know vs. what needs verification?]
   </thinking>

2. DIRECT SOLUTION — For 80% of queries, leverage internal knowledge (cutoff: ${cutoffDate}):
   • Factual questions → Answer directly with confidence
   • Analysis tasks → Provide structured insights
   • Creative requests → Generate original content
   • Code tasks → Write efficient, well-documented code
   ⚠️ Only use tools when internal knowledge is insufficient

3. TOOL USAGE HIERARCHY (Use strategically):
   PRIMARY (Native):
   • search → Current events, news, recent data (post-cutoff)
   • code_execution → Complex calculations, data analysis, visualizations
   • maps_grounding → Location services, directions, place information
   • vision → Image analysis, OCR, visual understanding
   
   SECONDARY (Custom):${hasExternalTools ? `
   • ${toolNames.join('\n   • ')}` : '\n   [None registered]'}
   
   RULES:
   • Minimize tool calls — combine multiple needs into single execution
   • Verify if internal knowledge suffices before calling
   • Parallel execution when possible
   • Always explain tool usage to user

4. RESPONSE COMPLETION PROTOCOL:
   STANDARD RESPONSE:
   • Provide complete answer directly
   • Use markdown for clarity (headers, lists, code blocks)
   • Cite sources when using external information
   
   COMPLEX TASKS:
   • Wrap comprehensive answer in <FINAL_ANSWER>...</FINAL_ANSWER>
   • If iterative refinement needed: <EVOLVE>specific reason for continuation</EVOLVE>
   
   CONVERGENCE GUARANTEES:
   • ALWAYS provide actionable output every turn
   • Self-verify completeness before responding
   • Use <FINAL_ANSWER> when task is complete
   • Use <EVOLVE> only when genuinely beneficial (not loops)

🎯 QUALITY STANDARDS:
• Accuracy > Speed (but maintain efficiency)
• Clarity > Brevity (but avoid verbosity)
• Depth appropriate to query complexity
• Proactive error handling and edge case consideration
• Natural, conversational tone with technical precision
• Target: 300-1200 tokens per response (scale with complexity)

📁 CONTEXT AWARENESS:
• Files available: ${hasFiles ? `Yes (${state.context?.files?.length}) → analyze and reference as needed` : 'No'}
• Conversation history: Maintained for continuity
• User preferences: Adapt to demonstrated needs

🔒 SAFETY & ETHICS:
• Refuse harmful, illegal, or unethical requests
• Protect privacy and sensitive information
• Acknowledge uncertainty rather than confabulate
• Provide balanced perspectives on controversial topics

CRITICAL: You are an autonomous agent. Think deeply, act decisively, verify rigorously. Your goal is to provide complete, accurate, helpful responses while minimizing unnecessary iterations.`;
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
      throw new Error(`Message exceeds maximum size of ${this.config.maxMessageSize} characters`);
    }

    // === Enhanced Complexity Detection ===
    const messageTokens = this.estimateTokens(userMessage);
    const historyTokens = conversationHistory.reduce(
      (sum, m) => sum + this.estimateTokens(m.content || ''), 
      0
    );
    const fileCount = state.context?.files?.length ?? 0;
    const fileTokens = fileCount * 25_000; // Estimate for file content
    
    // Detect code, math, or analysis keywords
    const complexityKeywords = /\b(analyze|calculate|debug|optimize|compare|implement|design|evaluate|research)\b/i;
    const hasComplexKeywords = complexityKeywords.test(userMessage);
    
    const complexityScore = messageTokens + historyTokens + fileTokens + (hasComplexKeywords ? 10_000 : 0);

    // Dynamic budget allocation based on complexity
    let localThinkingBudget = this.config.thinkingBudget;
    let localTokenBudget = this.config.tokenBudget;
    let localMaxTurns = this.config.maxTurns;

    if (complexityScore > 50_000) {
      localThinkingBudget = 16384;
      localTokenBudget = 800_000;
      localMaxTurns = 60;
      callbacks.onStatus?.('🔥 High complexity detected — expanding resources (thinking: 16k, context: 800k, turns: 60)');
    } else if (complexityScore > 30_000) {
      localThinkingBudget = 12288;
      localTokenBudget = 500_000;
      localMaxTurns = 50;
      callbacks.onStatus?.('⚡ Medium complexity — boosting budgets (thinking: 12k, context: 500k, turns: 50)');
    }

    const systemPrompt = this.buildSystemPrompt(state);
    let history = this.formatHistory(conversationHistory, systemPrompt, userMessage);
    history = await this.trimHistory(history, localTokenBudget);

    let turn = 0;
    let fullResponse = '';
    let accumulatedThinking = '';
    const batcher = this.createChunkBatcher(callbacks.onChunk);

    try {
      while (turn < localMaxTurns) {
        turn++;
        const statusMsg = turn === 1 
          ? '🤖 Analyzing and planning...' 
          : `🔄 Iteration ${turn}/${localMaxTurns}`;
        callbacks.onStatus?.(statusMsg);

        console.log(`%c[Agent] Turn ${turn}/${localMaxTurns} | Tokens used: ~${this.estimateTokens(fullResponse)}`, 
          'color: #00ff88; font-weight: bold');

        const options: GenerateOptions = {
          model: this.config.model,
          thinkingConfig: { 
            thinkingBudget: localThinkingBudget,
            thinkingMode: complexityScore > 30_000 ? 'extended' : 'standard'
          },
          temperature: this.config.temperature,
          topP: 0.95,
          topK: 40,
          stream: true,
          useSearch: this.config.useSearch,
          useCodeExecution: this.config.useCodeExecution,
          useMapsGrounding: this.config.useMapsGrounding,
          useVision: this.config.useVision,
          files: state.context?.files ?? [],
          responseModality: this.config.responseModality,
          safetySettings: this.config.safetySettings,
          candidateCount: 1,
        };

        let currentResponse = '';
        const response = await this.gemini.generateWithTools(
          history,
          this.toolRegistry.getAll(),
          options,
          (chunk: string) => {
            currentResponse += chunk;
            fullResponse += chunk;
            batcher.add(chunk);
          },
          signal
        );

        batcher.flush();

        // Extract thinking content if present
        const thinkingMatch = currentResponse.match(/<thinking>([\s\S]*?)<\/thinking>/i);
        if (thinkingMatch) {
          accumulatedThinking += thinkingMatch[1] + '\n\n';
        }

        // === Append assistant response to history ===
        history.push({
          role: 'model',
          content: response.text || currentResponse || '[empty response]',
          toolCalls: response.toolCalls,
        });
        history = await this.trimHistory(history, localTokenBudget);

        // === Check for completion markers ===
        const finalAnswerMatch = fullResponse.match(/<FINAL_ANSWER>([\s\S]*?)<\/FINAL_ANSWER>/i);
        if (finalAnswerMatch) {
          fullResponse = this.cleanResponse(finalAnswerMatch[1]);
          console.log('%c[Agent] ✅ Task completed successfully', 'color: #00ff00; font-weight: bold');
          break;
        }

        // === Handle tool calls ===
        if (response.toolCalls && response.toolCalls.length > 0) {
          const toolList = response.toolCalls.map(t => t.name).join(', ');
          callbacks.onToolUse?.(response.toolCalls.map(t => t.name));
          callbacks.onStatus?.(`🔧 Executing tools: ${toolList}`);

          const toolResults = await this.executeTools(response.toolCalls, state, signal);
          
          const resultsText = toolResults
            .map(r => {
              const status = r.success ? '✓' : '✗';
              const preview = r.result.substring(0, 2000);
              return `${status} ${r.name}:\n${preview}${r.result.length > 2000 ? '...(truncated)' : ''}`;
            })
            .join('\n\n---\n\n');

          history.push({
            role: 'user',
            content: `Tool Execution Results:\n\n${resultsText}`,
          });

          history = await this.trimHistory(history, localTokenBudget);
          fullResponse = ''; // Reset for next turn
          continue;
        }

        // === Check for evolution request ===
        const evolveMatch = fullResponse.match(/<EVOLVE>([\s\S]*?)<\/EVOLVE>/i);
        if (evolveMatch) {
          const reason = evolveMatch[1].trim() || 'continue refinement';
          callbacks.onStatus?.(`🔄 Evolving: ${reason}`);
          
          history.push({
            role: 'user',
            content: `Continue with: ${reason}\n\nProvide the next iteration or finalize with <FINAL_ANSWER>.`,
          });
          
          fullResponse = '';
          continue;
        }

        // === Natural completion detection ===
        if (turn === 1 && !response.toolCalls?.length) {
          // First turn with direct answer — likely complete
          console.log('%c[Agent] ✅ Direct answer provided', 'color: #00ff00');
          break;
        }

        // === Convergence safeguards ===
        if (turn >= 3 && fullResponse.length > 200) {
          // Has substantial content after multiple turns
          console.log('%c[Agent] ⚠️ Assuming completion (sufficient content)', 'color: #ffaa00');
          break;
        }

        if (turn >= 5) {
          // Force convergence
          history.push({
            role: 'user',
            content: '⚠️ Please finalize your response now. Wrap your complete answer in <FINAL_ANSWER>...</FINAL_ANSWER> tags.',
          });
          fullResponse = '';
        }

        if (turn === localMaxTurns - 1) {
          callbacks.onStatus?.('⚠️ Approaching turn limit — finalizing...');
        }
      }

      // === Post-processing ===
      const cleanedResponse = this.cleanResponse(fullResponse);
      const tokensUsed = await this.gemini.countTokens?.(history) 
        ?? this.estimateTokens(cleanedResponse);
      
      callbacks.onDone?.(turn, cleanedResponse.length, tokensUsed);
      
      return { 
        response: cleanedResponse, 
        turns: turn, 
        tokensUsed 
      };

    } catch (e: any) {
      const errorMsg = e.message || String(e);
      console.error('%c[Agent] ❌ Fatal error:', 'color: #ff0000; font-weight: bold', errorMsg);
      callbacks.onError?.(errorMsg);
      
      // Attempt graceful fallback
      if (fullResponse.length > 50) {
        console.log('%c[Agent] 🔄 Returning partial response', 'color: #ffaa00');
        return { 
          response: this.cleanResponse(fullResponse) + '\n\n⚠️ [Response incomplete due to error]', 
          turns: turn,
          tokensUsed: this.estimateTokens(fullResponse)
        };
      }
      
      throw e;
    }
  }

  // ===== Tool Execution with Enhanced Error Handling =====
  private async executeTools(
    toolCalls: ToolCall[],
    state: AgentState,
    signal?: AbortSignal
  ): Promise<ToolResult[]> {
    const TOOL_TIMEOUT = 45_000; // 45s per tool for Gemini 2.5
    const MAX_RETRIES = 2;

    const executeWithRetry = async (call: ToolCall): Promise<ToolResult> => {
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), TOOL_TIMEOUT);

          const toolPromise = this.toolRegistry.execute(
            call.name, 
            call.args, 
            state,
            controller.signal
          );

          const result = await toolPromise;
          clearTimeout(timeoutId);

          return {
            name: call.name,
            success: true,
            result: typeof result === 'string' 
              ? result 
              : JSON.stringify(result, null, 2),
          };
        } catch (e: any) {
          const isLastAttempt = attempt === MAX_RETRIES;
          const errorMsg = e.message || String(e);

          if (e.name === 'AbortError' || errorMsg.includes('timeout')) {
            if (isLastAttempt) {
              return {
                name: call.name,
                success: false,
                result: `❌ Tool timeout after ${TOOL_TIMEOUT}ms (${MAX_RETRIES} attempts)`,
              };
            }
          } else if (isLastAttempt) {
            return {
              name: call.name,
              success: false,
              result: `❌ Failed after ${MAX_RETRIES} attempts: ${errorMsg}`,
            };
          }

          // Exponential backoff
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }

      return { 
        name: call.name, 
        success: false, 
        result: '❌ Unknown error after retries' 
      };
    };

    // Execute tools in parallel with Promise.allSettled
    const results = await Promise.allSettled(
      toolCalls.map(call => executeWithRetry(call))
    );

    return results.map((result, i) => 
      result.status === 'fulfilled'
        ? result.value
        : {
            name: toolCalls[i].name,
            success: false,
            result: `❌ Execution rejected: ${String(result.reason)}`,
          }
    );
  }

  // ===== Smart History Trimming with Priority =====
  private async trimHistory(history: any[], budgetOverride?: number): Promise<any[]> {
    const budget = budgetOverride ?? this.config.tokenBudget;
    
    if (!this.gemini.countTokens) {
      // Fallback: keep recent messages
      const maxMessages = Math.min(this.config.maxHistoryMessages, history.length);
      return [history[0], ...history.slice(-maxMessages + 1)];
    }

    const system = history[0];
    let usedTokens = await this.gemini.countTokens([system]);
    const kept: any[] = [system];

    // Priority: Keep recent messages first (they're most relevant)
    for (let i = history.length - 1; i > 0; i--) {
      const msg = history[i];
      const msgTokens = await this.gemini.countTokens([msg]);
      
      if (usedTokens + msgTokens > budget) {
        // Budget exceeded — stop here
        break;
      }
      
      usedTokens += msgTokens;
      kept.unshift(msg);
    }

    const percentUsed = ((usedTokens / budget) * 100).toFixed(1);
    console.log(`%c[Agent] Context: ${usedTokens.toLocaleString()}/${budget.toLocaleString()} tokens (${percentUsed}%)`, 
      'color: #00aaff');

    return kept;
  }

  // ===== History Formatting for Gemini API =====
  private formatHistory(
    messages: Message[],
    systemPrompt: string,
    currentUserMessage: string
  ): any[] {
    const formatted: any[] = [
      { 
        role: 'system', 
        content: systemPrompt 
      }
    ];

    for (const msg of messages) {
      const content = Array.isArray(msg.parts)
        ? msg.parts.map((p: any) => p.text || '').join('\n')
        : msg.content || '';
      
      formatted.push({
        role: msg.role === 'model' ? 'model' : 'user',
        content: content.trim(),
      });
    }

    formatted.push({ 
      role: 'user', 
      content: currentUserMessage 
    });

    return formatted;
  }

  // ===== Optimized Chunk Batcher =====
  private createChunkBatcher(
    onChunk?: ChunkCallback,
    flushInterval = 30 // Lower latency for 2.5 Flash
  ): { add: (chunk: string) => void; flush: () => void } {
    let buffer = '';
    let timeoutHandle: any = null;

    const flush = () => {
      if (buffer && onChunk) {
        try {
          onChunk(buffer);
        } catch (e) {
          console.error('[Agent] Chunk callback error:', e);
        }
      }
      buffer = '';
      timeoutHandle = null;
    };

    return {
      add: (chunk: string) => {
        buffer += chunk;
        
        if (!timeoutHandle) {
          timeoutHandle = setTimeout(flush, flushInterval);
        }
        
        // Flush on sentence boundaries for smoother UX
        if (buffer.length > 200 && /[.!?]\s$/.test(buffer)) {
          clearTimeout(timeoutHandle);
          flush();
        }
      },
      flush: () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        flush();
      },
    };
  }

  // ===== Utility Methods =====
  private estimateTokens(text: string): number {
    // Rough estimate: 1 token ≈ 4 characters for English
    // More accurate than simple division
    return Math.ceil(text.length / 3.8);
  }

  private cleanResponse(text: string): string {
    return text
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '') // Remove thinking tags
      .replace(/<EVOLVE>[\s\S]*?<\/EVOLVE>/gi, '') // Remove evolve tags
      .replace(/<FINAL_ANSWER>/gi, '') // Remove opening tag
      .replace(/<\/FINAL_ANSWER>/gi, '') // Remove closing tag
      .trim()
      .replace(/\n{3,}/g, '\n\n'); // Normalize whitespace
  }
}
