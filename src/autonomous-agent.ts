// src/autonomous-agent.ts
// Fully completed, production-ready (conceptual) Autonomous Agent Durable Object
// Prompt-driven architecture with tool declarations, agentic loop, streaming, and tool execution.
// NOTE: Replace mock implementations for search, sandboxed code execution, and visualization
// with real integrations in your production environment.

import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import GeminiClientV2 from './utils/gemini';
import type {
  Env,
  AgentState,
  Tool,
  ToolCall,
  ToolResult,
  MessageRow
} from './types';

/**
 * Lightweight SQLite-like storage interface wrapper for Durable Object SQL storage.
 * (Matches pattern used in user's repo.)
 */
interface SqlStorage {
  exec(query: string, ...params: any[]): {
    one(): any;
    toArray(): any[];
    [Symbol.iterator](): Iterator<any>;
  };
}

/**
 * ChunkBatcher — accumulates streaming chunks and periodically flushes to a websocket
 * or callback to avoid excessive network operations.
 */
class ChunkBatcher {
  private buffer = '';
  private timer: any = null;
  private readonly flushIntervalMs: number;
  private readonly onFlush: (chunk: string) => void;

  constructor(onFlush: (chunk: string) => void, flushIntervalMs = 120) {
    this.onFlush = onFlush;
    this.flushIntervalMs = flushIntervalMs;
  }

  add(chunk: string) {
    this.buffer += chunk;
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushIntervalMs);
    }
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length > 0) {
      try {
        this.onFlush(this.buffer);
      } catch (e) {
        // swallow - sending errors should not break agent loop
        console.warn('ChunkBatcher.onFlush error:', e);
      }
      this.buffer = '';
    }
  }
}

/**
 * AutonomousAgent - Durable Object that runs the prompt-driven agentic loop,
 * exposes tool definitions, executes tool calls, streams progress via WS, and persists state.
 */
export class AutonomousAgent extends DurableObject<Env> {
  private sql: SqlStorage;
  private gemini: GeminiClientV2;
  private readonly MAX_TURNS = 12;
  private readonly MAX_MESSAGE_SIZE = 200_000;
  private activeWebSockets = new Set<WebSocket>();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    // Durable Object provided SQL wrapper (state.storage.sql) in this user's infra
    this.sql = (state.storage as unknown as { sql: SqlStorage }).sql;
    this.gemini = new GeminiClientV2({ apiKey: env.GEMINI_API_KEY });
    // Initialize DB tables if missing
    this.initDatabase();
  }

  // ---------------------------
  // Initialization & Utilities
  // ---------------------------

  private initDatabase(): void {
    try {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role TEXT NOT NULL,
          parts TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS kv (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_msg_ts ON messages(timestamp);
      `);
    } catch (e) {
      console.error('SQLite init failed:', e);
    }
  }

  private stringify(parts: any): string {
    try {
      return JSON.stringify(parts);
    } catch (e) {
      return JSON.stringify({ text: String(parts) });
    }
  }

  // ---------------------------
  // System Prompt & Toolset
  // ---------------------------

  private buildSystemPrompt(state: AgentState): string {
    const tools = this.getAvailableTools(state);
    const hasFiles = (state.context?.files ?? []).length > 0;

    return `You are an autonomous AI agent helping users accomplish tasks efficiently.

# Core Principles
- Answer simply when possible; don't over-plan.
- Use tools progressively and minimally.
- After each tool use, reflect: is more needed?
- Provide brief narrative progress updates when doing multi-step work.
- Explain sources when using web search.

# Available Tools
${tools.map(t => `- ${t.name}: ${t.description}`).join('\n')}

${hasFiles ? `\n# Uploaded Files\nThere are ${state.context.files.length} uploaded file(s). Use analyze_file to inspect them.\n` : ''}

# Decision Process
1. Assess: Direct answer vs. tool-required.
2. Act: Use one tool at a time; evaluate results.
3. Reflect: Have I enough? Next step?
4. Respond: Provide final structured answer and citations (if web used).

# Style
- Be concise and helpful.
- Use sections for long responses.
- If searching the web, include short citations/URLs.

# Important Rules
- NEVER create a full plan upfront; adapt as you learn.
- Use the minimum required tools.
- If uncertain, ask the user a single clarifying question.
- Avoid hallucination; say "I don't know" when appropriate.

Begin by assessing the user's request and decide whether to answer directly or use tools.`;
  }

  private getAvailableTools(state: AgentState): Tool[] {
    const hasFiles = (state.context?.files ?? []).length > 0;

    const tools: Tool[] = [
      {
        name: 'web_search',
        description: 'Search the web for up-to-date information, news, or facts. Returns up to N results with titles, snippets, and URLs.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            limit: { type: 'number', description: 'Max results (default 5)' }
          },
          required: ['query']
        }
      },
      {
        name: 'analyze_file',
        description: 'Read and analyze an uploaded file (text, pdf, csv). Use for summarization or extraction.',
        parameters: {
          type: 'object',
          properties: {
            fileIndex: { type: 'number', description: '0-based index of uploaded file' },
            operation: { 
              type: 'string',
              enum: ['summarize', 'extract_data', 'get_metadata', 'answer_question'],
              description: 'Operation to perform'
            },
            question: { type: 'string', description: 'Optional: specific question about file' }
          },
          required: ['fileIndex', 'operation']
        }
      },
      {
        name: 'code_execute',
        description: 'Execute Python code in a sandbox for data analysis, math, or generating artifacts (returns stdout/result).',
        parameters: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'Python code to run' },
            explanation: { type: 'string', description: 'Short explanation of what code does' }
          },
          required: ['code', 'explanation']
        }
      },
      {
        name: 'create_visualization',
        description: 'Generate a visualization image from provided data and return an image URL.',
        parameters: {
          type: 'object',
          properties: {
            data: { type: 'object', description: 'JSON-serializable data' },
            chartType: { type: 'string', enum: ['bar','line','pie','scatter'] },
            title: { type: 'string' }
          },
          required: ['data','chartType']
        }
      }
    ];

    if (hasFiles) {
      // analyze_file already present; keep tools flexible.
    }

    return tools;
  }

  // ---------------------------
  // Tool Execution Implementations
  // ---------------------------
  // NOTE: The following implementations are intentionally modular so you can replace mocks
  // with production integrations (search provider, sandboxed executor, file storage).

  private async executeTools(toolCalls: ToolCall[], state: AgentState): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    // Execute sequentially (agent chooses tools progressively). Later we can parallelize when safe.
    for (const call of toolCalls) {
      try {
        let result: any;
        switch (call.name) {
          case 'web_search':
            result = await this.toolWebSearch(call.args.query, call.args.limit ?? 5);
            break;

          case 'analyze_file':
            result = await this.toolAnalyzeFile(
              call.args.fileIndex,
              call.args.operation,
              call.args.question,
              state
            );
            break;

          case 'code_execute':
            result = await this.toolCodeExecute(call.args.code, call.args.explanation);
            break;

          case 'create_visualization':
            result = await this.toolCreateVisualization(call.args.data, call.args.chartType, call.args.title);
            break;

          default:
            result = { error: `Unknown tool: ${call.name}` };
            break;
        }

        results.push({
          name: call.name,
          result: typeof result === 'string' ? result : this.stringify(result),
          success: !(result && (result as any).error)
        });
      } catch (e) {
        results.push({
          name: call.name,
          result: this.stringify({ error: String(e) }),
          success: false
        });
      }
    }

    return results;
  }

  // --- web_search (mock / pluggable)
  // Replace this with a real search provider (Bing, Google custom search, or your own index).
  private async toolWebSearch(query: string, limit = 5): Promise<any> {
    // This is a placeholder so the agent works offline in test environments.
    // In production, call an external search API and return structured results:
    // [{ title, url, snippet, publishedAt }]
    return {
      query,
      timestamp: Date.now(),
      results: [
        {
          title: 'Placeholder result for: ' + query,
          url: 'https://example.com/search?q=' + encodeURIComponent(query),
          snippet: 'This is a placeholder snippet. Replace toolWebSearch with a real search API.',
          publishedAt: new Date().toISOString()
        }
      ].slice(0, limit)
    };
  }

  // --- analyze_file (reads uploaded files stored in state)
  private async toolAnalyzeFile(
    fileIndex: number,
    operation: string,
    question: string | undefined,
    state: AgentState
  ): Promise<any> {
    const files = state.context?.files ?? [];
    if (fileIndex < 0 || fileIndex >= files.length) {
      return { error: 'fileIndex out of range' };
    }

    const fileMeta = files[fileIndex];
    // For production: fetch file by fileMeta.fileUri from your file hosting / Gemini files API.
    // Here we return a mock response describing what would happen.
    return {
      fileName: fileMeta.name ?? 'unnamed',
      operation,
      question: question ?? null,
      metadata: fileMeta,
      result: `Mocked ${operation} result for file "${fileMeta.name ?? 'unnamed'}". Replace with real analysis.`
    };
  }

  // --- code_execute (sandboxed execution)
  private async toolCodeExecute(code: string, explanation: string): Promise<any> {
    // In production, forward code to a secure sandbox (e.g., a Python microservice, or Gemini code execution)
    // For safety this mock will not execute arbitrary code.
    return {
      explanation,
      output: 'Mock execution: code received but not executed in this environment.',
      stdout: '',
      stderr: '',
      executedAt: Date.now()
    };
  }

  // --- create_visualization (returns hosted image URL)
  private async toolCreateVisualization(data: any, chartType: string, title?: string): Promise<any> {
    // In production generate an image (matplotlib or charting lib) and upload to storage, returning URL.
    return {
      chartUrl: 'https://example.com/mock-chart.png',
      chartType,
      title: title ?? null,
      pointCount: Array.isArray(data) ? data.length : Object.keys(data || {}).length
    };
  }

  // ---------------------------
  // Main Agentic Loop (processing)
  // ---------------------------

  /**
   * Public entry point for requests that drive the agent (e.g., from an HTTP handler or WebSocket message)
   * `userMsg` is the user's request text.
   * `ws` is optional WebSocket for streaming progress to UI.
   */
  public async handleUserMessage(userMsg: string, ws: WebSocket | null): Promise<void> {
    // Wrap state operations in a transaction-like flow to ensure consistency
    return this.withStateTransaction(async (state) => {
      // Guardrails
      if (!userMsg || userMsg.length === 0) {
        if (ws) this.send(ws, { type: 'error', error: 'Empty message' });
        return;
      }
      if (userMsg.length > this.MAX_MESSAGE_SIZE) {
        if (ws) this.send(ws, { type: 'error', error: 'Message too large' });
        return;
      }

      // Persist user message
      this.sql.exec(
        `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
        'user',
        this.stringify([{ text: userMsg }]),
        Date.now()
      );

      // Build conversation and system prompt
      const systemPrompt = this.buildSystemPrompt(state);
      const history = this.buildHistoryFromDB();
      let conversationHistory: any[] = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: userMsg }
      ];

      let turn = 0;
      let accumulatedText = '';
      const batcher = new ChunkBatcher((chunk: string) => {
        if (ws) {
          this.send(ws, { type: 'chunk', content: chunk });
        }
      }, 100);

      if (ws) {
        this.send(ws, { type: 'status', message: 'Agent starting...' });
      }

      // Agentic loop: let model decide whether to call tools and when to finish.
      while (turn < this.MAX_TURNS) {
        turn++;
        if (ws) {
          this.send(ws, { type: 'status', message: turn === 1 ? 'Thinking...' : `Processing (step ${turn})...` });
        }

        // Ask Gemini to generate with tool-declares
        const response = await this.gemini.generateWithTools(
          conversationHistory,
          this.getAvailableTools(state),
          {
            model: 'gemini-2.5-flash',
            thinkingConfig: { thinkingBudget: 1024 },
            stream: true
          },
          (chunk: string) => {
            accumulatedText += chunk;
            batcher.add(chunk);
          }
        );

        // flush any buffered chunks to websocket
        batcher.flush();

        // If model asked to call tools, execute them and append results to conversation history
        if (response.toolCalls && response.toolCalls.length > 0) {
          if (ws) {
            this.send(ws, {
              type: 'tool_call',
              tools: response.toolCalls.map(tc => ({ name: tc.name, args: tc.args }))
            });
          }

          // Execute declared tool calls
          const toolResults = await this.executeTools(response.toolCalls, state);

          // Append assistant message (model output) that included the tool call
          conversationHistory.push({
            role: 'assistant',
            content: response.text ?? ''
          });

          // Append tool results (as user content so the model can see them as data)
          conversationHistory.push({
            role: 'user',
            content: `Tool Results:\n${toolResults.map(r => `${r.name}: ${r.success ? 'Success' : 'Failed'}\n${r.result}`).join('\n\n')}`
          });

          // Persist tool result summary for audit
          this.sql.exec(
            `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
            'tool',
            this.stringify(toolResults),
            Date.now()
          );

          // Reset accumulated text for the next turn (we expect new reasoning on top)
          accumulatedText = '';
          continue; // Loop again so model can reflect on tool results
        }

        // No tool calls — model likely produced a final answer
        // If response.text is empty but parts exist, try to surface parts
        const finalText = response.text ?? accumulatedText ?? '';

        // Persist assistant final message
        if (finalText && finalText.length > 0) {
          this.sql.exec(
            `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
            'model',
            this.stringify([{ text: finalText }]),
            Date.now()
          );
        }

        if (ws) {
          this.send(ws, { type: 'final_response', content: finalText });
          this.send(ws, { type: 'done', turns: turn });
        }

        break; // exit loop as agent signaled completion
      } // end loop

      // If we hit MAX_TURNS without a final response, send best-effort result
      if (turn >= this.MAX_TURNS) {
        const fallback = accumulatedText || 'Agent stopped after reaching maximum internal steps.';
        if (ws) this.send(ws, { type: 'final_response', content: fallback });
        this.sql.exec(
          `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
          'model',
          this.stringify([{ text: fallback }]),
          Date.now()
        );
      }

      // Update last activity timestamp on state
      state.lastActivityAt = Date.now();
    });
  }

  // ---------------------------
  // Persistence & State Helpers
  // ---------------------------

  private async withStateTransaction<T>(fn: (state: AgentState) => Promise<T>): Promise<T> {
    // Use Durable Object concurrency controller to ensure only one transaction
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.loadState();
      const result = await fn(state);
      await this.saveState(state);
      return result;
    });
  }

  private async loadState(): Promise<AgentState> {
    try {
      const row = this.sql.exec(`SELECT value FROM kv WHERE key = 'state'`).one();
      if (row?.value) {
        return JSON.parse(row.value as string) as AgentState;
      }
    } catch (e) {
      console.warn('Failed to load state (will create new):', e);
    }

    const initial: AgentState = {
      conversationHistory: [],
      context: { files: [], searchResults: [] },
      sessionId: this.ctx.id.toString(),
      lastActivityAt: Date.now()
    };
    return initial;
  }

  private async saveState(state: AgentState): Promise<void> {
    try {
      this.sql.exec(
        `INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`,
        'state',
        JSON.stringify(state)
      );
    } catch (e) {
      console.warn('Failed to save state:', e);
    }
  }

  private buildHistoryFromDB(limit = 40): any[] {
    try {
      const rows = Array.from(this.sql.exec(`SELECT role, parts, timestamp FROM messages ORDER BY timestamp DESC LIMIT ?`, limit).toArray()).reverse();
      return rows.map((r: any) => {
        const parts = (() => {
          try { return JSON.parse(r.parts); } catch { return [{ text: String(r.parts) }]; }
        })();
        return { role: r.role === 'model' ? 'assistant' : r.role, content: parts };
      });
    } catch (e) {
      return [];
    }
  }

  // ---------------------------
  // WebSocket / UI helpers
  // ---------------------------

  private send(ws: WebSocket, payload: any): void {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    } catch (e) {
      console.warn('WebSocket send failed:', e);
    }
  }

  // ---------------------------
  // Optional: HTTP / WS handlers helpers
  // ---------------------------
  // You can hook these into your Durable Object fetch() endpoint handlers.

  public async onWebSocketConnected(ws: WebSocket) {
    this.activeWebSockets.add(ws);
    ws.addEventListener('close', () => this.activeWebSockets.delete(ws));
    ws.addEventListener('error', () => this.activeWebSockets.delete(ws));
  }

  // ---------------------------
  // End of class
  // ---------------------------
}

export default AutonomousAgent;
