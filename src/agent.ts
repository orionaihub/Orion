// src/autonomous-agent-simplified.ts - Multi-step autonomous version (Refactored)
import type { DurableObjectState } from '@cloudflare/workers-types';
import GeminiClient from './gemini';
// Import GenerateOptions
import type { GenerateOptions } from './gemini';
import type { Env, AgentState, Message } from './types';

interface SqlStorage {
  exec(query: string, ...params: any[]): {
    one(): any;
    toArray(): any[];
    [Symbol.iterator](): Iterator<any>;
  };
}

interface Tool {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

interface ToolCall {
  name: string;
  args: Record<string, any>;
}

interface ToolResult {
  name: string;
  success: boolean;
  result: string;
}

export class AutonomousAgent {
  private state: DurableObjectState;
  private env: Env;
  private sql: SqlStorage;
  private gemini: GeminiClient;
  private maxHistoryMessages = 200;
  private readonly MAX_MESSAGE_SIZE = 100_000;
  private readonly MAX_TURNS = 8;
  private activeWebSockets = new Set<WebSocket>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sql = (state.storage as unknown as { sql?: SqlStorage }).sql as SqlStorage;
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });

    try {
      if (this.sql) {
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
      }
    } catch (e) {
      console.error('SQLite init failed:', e);
    }
  }

  // ===== System Prompt (Unchanged) =====

  private buildSystemPrompt(state: AgentState): string {
    const hasFiles = (state.context?.files?.length ?? 0) > 0;
    
    return `You are an autonomous AI assistant with tool-use capabilities. Your goal is to help users by breaking down complex tasks and using available tools when needed.

# Response Strategy
1. For simple questions: Answer directly without using tools
2. For complex tasks: Use available tools iteratively to gather information and complete the task
3. When you have enough information: Provide a comprehensive final answer

# Available Tools
You have access to tools for web search, code execution, file analysis, and more. Use them when they would help answer the user's question.

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

  // ===== Tool Definitions (Refactored) =====

  private getAvailableTools(state: AgentState): Tool[] {
    const tools: Tool[] = [
      // REMOVED: 'web_search' - This is a native tool, enabled in the 'process' loop
      // REMOVED: 'code_execute' - This is a native tool, enabled in the 'process' loop
      // REMOVED: 'analyze_file' - This is a native tool, enabled by passing files
      
      /* EXAMPLE: This is where you would add a *truly* external tool
      {
        name: 'post_to_slack',
        description: 'Posts a message to a Slack channel',
        parameters: { ... }
      }
      */
    ];

    // File analysis is now handled natively, so this logic is no longer needed here.
    // if ((state.context?.files?.length ?? 0) > 0) { ... }

    return tools;
  }

  // ===== Tool Execution (Refactored) =====

  private async executeTools(toolCalls: ToolCall[], state: AgentState): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const call of toolCalls) {
      try {
        let result: string;

        switch (call.name) {
          // REMOVED: 'web_search' case
          // REMOVED: 'code_execute' case
          // REMOVED: 'analyze_file' case

          /*
          EXAMPLE: This is where you would handle a *truly* external tool
          case 'post_to_slack':
            result = await this.mySlackFunction(call.args.channel, call.args.message);
            results.push({ name: call.name, success: true, result });
            break;
          */

          default:
            results.push({ 
              name: call.name, 
              success: false, 
              result: `Unknown tool: ${call.name}` 
            });
        }
      } catch (e) {
        results.push({
          name: call.name,
          success: false,
          result: `Tool execution failed: ${String(e)}`
        });
      }
    }

    return results;
  }

  // REMOVED: executeWebSearch
  // REMOVED: executeCode
  // REMOVED: analyzeFile

  // ===== Main Processing Loop (Refactored) =====

  private async process(userMsg: string, ws: WebSocket | null): Promise<void> {
    return this.withStateTransaction(async (state) => {
      state.lastActivityAt = Date.now();

      if (userMsg.length > this.MAX_MESSAGE_SIZE) {
        if (ws) this.send(ws, { type: 'error', error: 'Message too large' });
        throw new Error('Message exceeds maximum size');
      }

      // Save user message (unchanged)
      try {
        if (this.sql) {
          this.sql.exec(
            `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
            'user',
            JSON.stringify([{ text: userMsg }]),
            Date.now()
          );
        }
      } catch (e) {
        console.error('Failed to save user message:', e);
        if (ws) this.send(ws, { type: 'error', error: 'Save failed' });
        throw e;
      }

      // Build conversation history (unchanged)
      const systemPrompt = this.buildSystemPrompt(state);
      const history = this.buildHistory();
      
      let conversationHistory: any[] = [
        { role: 'system', content: systemPrompt },
        ...history.map(h => ({
          role: h.role,
          content: h.parts.map((p: any) => p.text).join('\n')
        })),
        { role: 'user', content: userMsg }
      ];

      let turn = 0;
      let fullResponse = '';
      const batcher = this.createChunkBatcher(ws, 'chunk');

      try {
        // Agentic loop - model decides when to stop
        while (turn < this.MAX_TURNS) {
          turn++;

          if (ws) {
            this.send(ws, {
              type: 'status',
              message: turn === 1 ? 'Thinking...' : `Processing step ${turn}...`
            });
          }

          console.log(`[Agent] Turn ${turn}/${this.MAX_TURNS}`);

          // === THIS IS THE KEY CHANGE ===
          // Define all options for the upgraded generateWithTools call
          const options: GenerateOptions = {
            model: 'gemini-2.5-flash',
            thinkingConfig: { thinkingBudget: 1024 },
            stream: true,

            // --- Enable Native Tools ---
            useSearch: true,
            useCodeExecution: true,

            // --- Pass File/URL Context ---
            // Native file analysis is enabled simply by passing the files
            files: state.context?.files ?? [],
            // urlList: [] // You can add URLs to the state and pass them here
          };
          
          // Generate response with tool capability
          const response = await this.gemini.generateWithTools(
            conversationHistory,
            this.getAvailableTools(state), // Passes *external* tools (currently [])
            options, // Passes all other options (native tools, files, etc.)
            (chunk: string) => {
              fullResponse += chunk;
              batcher.add(chunk);
            }
          );

          batcher.flush();

          // This block now *only* catches *external* tool calls
          if (response.toolCalls && response.toolCalls.length > 0) {
            console.log(`[Agent] External Tool calls detected: ${response.toolCalls.map((t: ToolCall) => t.name).join(', ')}`);

            if (ws) {
              this.send(ws, {
                type: 'tool_use',
                tools: response.toolCalls.map((t: ToolCall) => t.name)
              });
            }

            // Execute *external* tools
            const toolResults = await this.executeTools(response.toolCalls, state);

            // Add assistant's response with tool calls to history
            conversationHistory.push({
              role: 'assistant',
              content: response.text || '[used external tools]',
              toolCalls: response.toolCalls
            });

            // Add tool results to history
            const resultsText = toolResults.map(r =>
              `${r.name}: ${r.success ? 'Success' : 'Failed'}\n${r.result}`
            ).join('\n\n');

            conversationHistory.push({
              role: 'user',
              content: `Tool Results:\n${resultsText}`
            });

            // Reset for next turn
            fullResponse = '';
            continue;
          }

          // No *external* tool calls.
          // Native tools (search, code, file) ran inline.
          // The loop can now stop.
          console.log('[Agent] Final answer received, stopping loop');
          break;
        }

        // Save final response (unchanged)
        if (fullResponse) {
          try {
            if (this.sql) {
              this.sql.exec(
                `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
                'model',
                JSON.stringify([{ text: fullResponse }]),
                Date.now()
              );
            }
          } catch (e) {
            console.error('Failed to save model response:', e);
          }
        }

        if (ws) {
          if (!fullResponse) {
            // If no final response collected, still signal completion
            this.send(ws, { type: 'chunk', content: '[Task completed]' });
          }
          this.send(ws, { type: 'done', turns: turn, totalLength: fullResponse.length });
        }

      } catch (e) {
        console.error('Process error:', e);
        if (ws) this.send(ws, { type: 'error', error: String(e) });
        throw e;
      }
    });
  }

  // ===== State Management (Unchanged) =====

  private async loadState(): Promise<AgentState> {
    let state: AgentState | null = null;
    try {
      if (this.sql) {
        const row = this.sql.exec(`SELECT value FROM kv WHERE key = ?`, 'state').one();
        if (row && typeof row.value === 'string') {
          state = JSON.parse(row.value);
        }
      }
    } catch (e) {
      console.error('SQLite read failed:', e);
    }

    if (!state || !state.sessionId) {
      state = {
        conversationHistory: [],
        context: { files: [], searchResults: [] },
        sessionId: this.state.id?.toString ? this.state.id.toString() : Date.now().toString(),
        lastActivityAt: Date.now(),
      } as AgentState;
    }

    return state;
  }

  private async saveState(state: AgentState): Promise<void> {
    try {
      const stateStr = JSON.stringify(state);
      if (this.sql) {
        this.sql.exec(
          `INSERT INTO kv (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          'state',
          stateStr
        );
      }
    } catch (e) {
      console.error('saveState failed:', e);
    }
  }

  private async withStateTransaction<T>(fn: (state: AgentState) => Promise<T>): Promise<T> {
    return this.state.blockConcurrencyWhile(async () => {
      const state = await this.loadState();
      const result = await fn(state);
      await this.saveState(state);
      return result;
    });
  }

  private buildHistory(): Array<{ role: string; parts: Array<{ text: string }> }> {
    const rows = this.sql
      ? this.sql
          .exec(
            `SELECT role, parts FROM messages ORDER BY timestamp DESC LIMIT ?`,
            Math.min(this.maxHistoryMessages, 50)
          )
          .toArray()
      : [];
    
    const hist: Array<{ role: string; parts: Array<{ text: string }> }> = [];

    for (const r of rows.reverse()) {
      try {
        const parts = JSON.parse(r.parts as string);
        if (parts) {
          hist.push({
            role: r.role === 'model' ? 'model' : 'user',
            parts,
          });
        }
      } catch (e) {
        console.warn('Failed to parse message:', e);
      }
    }

    // Remove consecutive duplicate user messages
    let i = hist.length - 1;
    while (i > 0) {
      if (hist[i].role === 'user' && hist[i - 1].role === 'user') {
        hist.splice(i, 1);
      }
      i--;
    }

    return hist;
  }

  // ===== WebSocket Management (Unchanged) =====

  private send(ws: WebSocket | null, data: unknown): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(data));
    } catch (e) {
      console.error('WebSocket send failed:', e);
    }
  }

  private createChunkBatcher(ws: WebSocket | null, type: string, flushInterval = 50) {
    let buffer = '';
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      if (buffer && ws) {
        this.send(ws, { type, content: buffer });
        buffer = '';
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

  // ===== HTTP Fetch Handler (Unchanged) =====

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

      try {
        (server as any).accept?.();
      } catch (e) {
        console.error('Failed to accept websocket:', e);
      }

      server.onmessage = (evt: MessageEvent) => {
        void this.webSocketMessage(server, evt.data).catch((err) => {
          console.error('webSocketMessage handler error:', err);
        });
      };

      server.onclose = (evt: CloseEvent) => {
        void this.webSocketClose(server, evt.code, evt.reason).catch((err) => {
          console.error('webSocketClose handler error:', err);
        });
      };

      server.onerror = (evt: Event | ErrorEvent) => {
        void this.webSocketError(server, evt).catch((err) => {
          console.error('webSocketError handler error:', err);
        });
      };

      this.activeWebSockets.add(server);

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/api/chat' && request.method === 'POST') return this.handleChat(request);
    if (url.pathname === '/api/history' && request.method === 'GET') return this.getHistory();
    if (url.pathname === '/api/clear' && request.method === 'POST') return this.clearHistory();
    if (url.pathname === '/api/status' && request.method === 'GET') return this.getStatus();

    return new Response('Not found', { status: 404 });
  }

  // ===== WebSocket Handlers (Unchanged) =====

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    if (ws.readyState !== WebSocket.OPEN) return;

    let payload: any;
    try {
      payload = JSON.parse(message);
    } catch {
      this.send(ws, { type: 'error', error: 'Invalid JSON' });
      return;
    }

    if (payload.type === 'user_message' && typeof payload.content === 'string') {
      try {
        this.state.waitUntil(
          this.process(payload.content, ws).catch((err) => {
            console.error('WebSocket process failed:', err);
            this.send(ws, { type: 'error', error: 'Processing failed' });
          })
        );
      } catch (e) {
        void this.process(payload.content, ws).catch((err) => {
          console.error('Background process failed:', err);
          this.send(ws, { type: 'error', error: 'Processing failed' });
        });
      }
    } else {
      this.send(ws, { type: 'error', error: 'Invalid payload' });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    console.log(`WebSocket closed: ${code} - ${reason}`);
    this.activeWebSockets.delete(ws);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('WebSocket error:', error);
    this.activeWebSockets.delete(ws);
  }

  // ===== HTTP Handlers (Unchanged) =====

  private async handleChat(req: Request): Promise<Response> {
    let message: string;
    try {
      const body = (await req.json()) as { message: string };
      message = body.message;
      if (!message) throw new Error('Missing message');
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid request' }), { status: 400 });
    }

    try {
      this.state.waitUntil(
        this.process(message, null).catch((err) => {
          console.error('Background process failed:', err);
        })
      );
    } catch (e) {
      void this.process(message, null).catch((err) => {
        console.error('Background process failed:', err);
      });
    }

    return new Response(JSON.stringify({ status: 'queued' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private getHistory(): Response {
    const rows = this.sql
      ? this.sql.exec(`SELECT role, parts, timestamp FROM messages ORDER BY timestamp ASC`).toArray()
      : [];
    const msgs: Message[] = [];
    for (const r of rows) {
      try {
        const parts = JSON.parse(r.parts as string);
        if (parts) {
          msgs.push({
            role: r.role as any,
            parts,
            timestamp: r.timestamp as number,
          });
        }
      } catch (e) {
        console.warn('Failed to parse message:', e);
      }
    }
    return new Response(JSON.stringify({ messages: msgs }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async clearHistory(): Promise<Response> {
    return this.state.blockConcurrencyWhile(async () => {
      try {
        if (this.sql) {
          this.sql.exec('DELETE FROM messages');
          this.sql.exec('DELETE FROM kv');
          this.sql.exec('DELETE FROM sqlite_sequence WHERE name IN ("messages")');
        }
      } catch (e) {
        console.error('Clear failed:', e);
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }

  private getStatus(): Response {
    let state: AgentState | null = null;
    try {
      if (this.sql) {
        const row = this.sql.exec(`SELECT value FROM kv WHERE key = ?`, 'state').one();
        state = row ? JSON.parse(row.value as string) : null;
      }
    } catch (e) {
      console.error('getStatus read failed:', e);
    }

    return new Response(
      JSON.stringify({
        lastActivity: state?.lastActivityAt,
        sessionId: state?.sessionId,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }
}

export default AutonomousAgent;
