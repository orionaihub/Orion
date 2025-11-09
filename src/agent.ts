// src/agent.ts - Autonomous Agent Core (Updated with Persistence)
import type { DurableObjectState } from '@cloudflare/workers-types';
import GeminiClient from './gemini';
import type { GenerateOptions } from './gemini';
// Import all necessary types and persistence functions
import type { Env, AgentState, Message, Tool, ToolCall, ToolResult, SqlStorage } from './types';
import * as Persistence from './persistence';

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
    // Use type assertion for the SQL storage property
    this.sql = (state.storage as unknown as { sql?: SqlStorage }).sql as SqlStorage;
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });

    // Initialize the DB using the new persistence module
    if (this.sql) {
      Persistence.createTables(this.sql);
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

  // ===== Tool Definitions (Unchanged) =====

  private getAvailableTools(state: AgentState): Tool[] {
    const tools: Tool[] = [
      // Only include *truly* external tools here
    ];
    return tools;
  }

  // ===== Tool Execution (Unchanged) =====

  private async executeTools(toolCalls: ToolCall[], state: AgentState): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const call of toolCalls) {
      try {
        switch (call.name) {
          // Add cases for truly external tools here
          default:
            results.push({ 
              name: call.name, 
              success: false, 
              result: `Unknown external tool: ${call.name}` 
            });
        }
      } catch (e) {
        results.push({
          name: call.name,
          success: false,
          result: `External Tool execution failed: ${String(e)}`
        });
      }
    }

    return results;
  }

  // ===== Core Logic and Transaction Wrapper (Updated to use Persistence) =====

  private async process(userMsg: string, ws: WebSocket | null): Promise<void> {
    return this.withStateTransaction(async (state) => {
      state.lastActivityAt = Date.now();

      if (userMsg.length > this.MAX_MESSAGE_SIZE) {
        if (ws) this.send(ws, { type: 'error', error: 'Message too large' });
        throw new Error('Message exceeds maximum size');
      }

      // Save user message using the persistence module
      if (this.sql) {
        Persistence.saveMessage(
          this.sql,
          'user',
          [{ text: userMsg }],
          Date.now()
        );
      }

      // Build conversation history using the persistence module
      const systemPrompt = this.buildSystemPrompt(state);
      const history = Persistence.loadHistory(this.sql, this.maxHistoryMessages);
      
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
        while (turn < this.MAX_TURNS) {
          turn++;

          if (ws) {
            this.send(ws, {
              type: 'status',
              message: turn === 1 ? 'Thinking...' : `Processing step ${turn}...`
            });
          }

          console.log(`[Agent] Turn ${turn}/${this.MAX_TURNS}`);

          const options: GenerateOptions = {
            model: 'gemini-2.5-flash',
            thinkingConfig: { thinkingBudget: 1024 },
            stream: true,

            // --- Enable Native Tools ---
            useSearch: true,
            useCodeExecution: true,

            // --- Pass File/URL Context ---
            files: state.context?.files ?? [],
          };
          
          const response = await this.gemini.generateWithTools(
            conversationHistory,
            this.getAvailableTools(state), // External tools
            options, // Native tools and context
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

            fullResponse = '';
            continue;
          }

          // Native tools ran inline, final answer received.
          console.log('[Agent] Final answer received, stopping loop');
          break;
        }

        // Save final response using the persistence module
        if (fullResponse) {
          if (this.sql) {
            Persistence.saveMessage(
              this.sql,
              'model',
              [{ text: fullResponse }],
              Date.now()
            );
          }
        }

        if (ws) {
          if (!fullResponse) {
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
  
  // Wrapper for concurrency block using Persistence module
  private async withStateTransaction<T>(fn: (state: AgentState) => Promise<T>): Promise<T> {
    return this.state.blockConcurrencyWhile(async () => {
      const state = await Persistence.loadState(this.sql, this.state);
      const result = await fn(state);
      await Persistence.saveState(this.sql, state);
      return result;
    });
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

  // ===== HTTP Handlers (Refactored to use Persistence) =====

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
    // Uses Persistence module
    const msgs = Persistence.loadHistory(this.sql, this.maxHistoryMessages);
    
    // The loadHistory function returns messages oldest-first. Reverse for API consistency (newest-first).
    return new Response(JSON.stringify({ messages: msgs.reverse() }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async clearHistory(): Promise<Response> {
    return this.state.blockConcurrencyWhile(async () => {
      // Uses Persistence module
      Persistence.clearAll(this.sql);

      // Re-load and re-save state to reset to initial
      const initialState = await Persistence.loadState(this.sql, this.state);
      await Persistence.saveState(this.sql, initialState);

      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }

  private getStatus(): Response {
    let state: AgentState | null = null;
    try {
      // Load state manually for a quick status check outside a transaction
      const row = this.sql.exec(`SELECT value FROM kv WHERE key = ?`, 'state').one();
      state = row ? JSON.parse(row.value as string) : null;
    } catch (e) {
      console.error('getStatus read failed:', e);
    }

    return new Response(
      JSON.stringify({
        lastActivity: state?.lastActivityAt,
        sessionId: state?.sessionId,
        circuitBreakerStatus: this.gemini.getCircuitBreakerStatus(),
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }
}
