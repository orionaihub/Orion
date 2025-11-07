// src/autonomous-agent.ts
// Unified Production-Ready Prompt-Driven Agent
// Combines: Stable WebSocket system + Adaptive Agentic Loop
// Compatible with chat.js frontend and Cloudflare Workers Durable Objects

import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import GeminiClient from './utils/gemini';
import type { Env, AgentState, Tool, ToolCall, ToolResult, Message } from './types';

// -------------------------------------------
// SQLite Storage Interface
// -------------------------------------------
interface SqlStorage {
  exec(query: string, ...params: any[]): {
    one(): any;
    toArray(): any[];
    [Symbol.iterator](): Iterator<any>;
  };
}

// -------------------------------------------
// Metrics Interface
// -------------------------------------------
interface Metrics {
  requestCount: number;
  errorCount: number;
  avgResponseTime: number;
  totalResponseTime: number;
  activeConnections: number;
}

// -------------------------------------------
// Autonomous Agent Durable Object
// -------------------------------------------
export class AutonomousAgent extends DurableObject<Env> {
  private sql: SqlStorage;
  private gemini: GeminiClient;
  private readonly MAX_MESSAGE_SIZE = 120_000;
  private readonly MAX_TURNS = 10;
  private activeWebSockets = new Set<WebSocket>();
  private metrics: Metrics = {
    requestCount: 0,
    errorCount: 0,
    avgResponseTime: 0,
    totalResponseTime: 0,
    activeConnections: 0,
  };

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql as SqlStorage;
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });

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
      `);
    } catch (e) {
      console.error('DB init failed:', e);
    }
  }

  // -------------------------------------------
  // Utility Helpers
  // -------------------------------------------
  private stringify(obj: any): string {
    try { return JSON.stringify(obj); } catch { return String(obj); }
  }

  private parse<T>(s: string): T | null {
    try { return JSON.parse(s); } catch { return null; }
  }

  private send(ws: WebSocket | null, data: unknown): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(data)); } catch {}
  }

  private createChunkBatcher(ws: WebSocket | null, type: string, interval = 80) {
    let buffer = ''; let timer: any = null;
    const flush = () => {
      if (buffer && ws) this.send(ws, { type, content: buffer });
      buffer = ''; timer = null;
    };
    return {
      add: (chunk: string) => {
        buffer += chunk;
        if (!timer) timer = setTimeout(flush, interval);
      },
      flush,
    };
  }

  // -------------------------------------------
  // System Prompt & Tool Definitions
  // -------------------------------------------
  private buildSystemPrompt(state: AgentState): string {
    const tools = this.getAvailableTools(state);
    return `You are an autonomous AI agent helping users accomplish goals efficiently.

# Core Principles
- Be concise; only use tools when necessary.
- Think step-by-step and reflect briefly after each action.
- For simple queries, answer directly.
- For complex ones, use tools progressively.
- Provide progress updates (e.g., "Searching...", "Analyzing...").

# Available Tools
${tools.map(t => `- ${t.name}: ${t.description}`).join('\n')}

After each tool call:
- Evaluate if enough info is gathered.
- If yes → finalize answer.
- If no → use another tool.

User's current request follows below.`;
  }

  private getAvailableTools(state: AgentState): Tool[] {
    return [
      {
        name: 'web_search',
        description: 'Search the web for up-to-date information.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'number' },
          },
          required: ['query'],
        },
      },
    ];
  }

  // -------------------------------------------
  // Main Agentic Loop
  // -------------------------------------------
  private async processWithAgent(userMsg: string, ws: WebSocket | null, state: AgentState) {
    const systemPrompt = this.buildSystemPrompt(state);
    const history = this.buildHistory();

    let conversation: any[] = [
      { role: 'system', parts: [{ text: systemPrompt }] },
      ...history,
      { role: 'user', parts: [{ text: userMsg }] },
    ];

    const batcher = this.createChunkBatcher(ws, 'chunk');
    let finalText = '';

    for (let turn = 0; turn < this.MAX_TURNS; turn++) {
      const response = await this.gemini.generateWithTools(
        conversation,
        this.getAvailableTools(state),
        {
          model: 'gemini-2.5-flash',
          stream: true,
          thinkingConfig: { thinkingBudget: 1024 },
        },
        (chunk) => { batcher.add(chunk); finalText += chunk; }
      );

      batcher.flush();

      if (response.toolCalls && response.toolCalls.length > 0) {
        const toolResults = await this.executeTools(response.toolCalls);
        conversation.push({ role: 'model', parts: response.parts });
        conversation.push({
          role: 'user',
          parts: toolResults.map(r => ({
            functionResponse: { name: r.name, response: r.result },
          })),
        });
        continue;
      }

      // If no more tool calls, final answer
      break;
    }

    // Save model message
    this.sql.exec(
      `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
      'model',
      this.stringify([{ text: finalText }]),
      Date.now()
    );

    this.send(ws, { type: 'final_response', content: finalText });
    this.send(ws, { type: 'done' });
  }

  // -------------------------------------------
  // Tool Execution
  // -------------------------------------------
  private async executeTools(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const call of toolCalls) {
      try {
        switch (call.name) {
          case 'web_search':
            results.push({
              name: call.name,
              success: true,
              result: this.stringify(await this.toolWebSearch(call.args.query, call.args.limit ?? 3)),
            });
            break;
          default:
            results.push({
              name: call.name,
              success: false,
              result: this.stringify({ error: 'Unknown tool' }),
            });
        }
      } catch (e) {
        results.push({ name: call.name, success: false, result: this.stringify({ error: String(e) }) });
      }
    }
    return results;
  }

  private async toolWebSearch(query: string, limit = 3): Promise<any> {
    // Replace this with your real search integration
    return {
      query,
      timestamp: Date.now(),
      results: [
        { title: `Result for "${query}"`, url: 'https://example.com', snippet: 'Mocked result snippet.' },
      ].slice(0, limit),
    };
  }

  // -------------------------------------------
  // Main Processing Entry
  // -------------------------------------------
  private async process(userMsg: string, ws: WebSocket | null): Promise<void> {
    return this.withStateTransaction(async (state) => {
      if (userMsg.length > this.MAX_MESSAGE_SIZE)
        return this.send(ws, { type: 'error', error: 'Message too large' });

      this.sql.exec(
        `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
        'user',
        this.stringify([{ text: userMsg }]),
        Date.now()
      );

      await this.processWithAgent(userMsg, ws, state);
    });
  }

  // -------------------------------------------
  // State Management
  // -------------------------------------------
  private async loadState(): Promise<AgentState> {
    try {
      const row = this.sql.exec(`SELECT value FROM kv WHERE key='state'`).one();
      if (row?.value) return JSON.parse(row.value as string);
    } catch {}
    return {
      conversationHistory: [],
      context: { files: [], searchResults: [] },
      sessionId: this.ctx.id.toString(),
      lastActivityAt: Date.now(),
    } as AgentState;
  }

  private async saveState(state: AgentState): Promise<void> {
    this.sql.exec(
      `INSERT OR REPLACE INTO kv (key, value) VALUES ('state', ?)`,
      JSON.stringify(state)
    );
  }

  private async withStateTransaction<T>(fn: (state: AgentState) => Promise<T>): Promise<T> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const s = await this.loadState();
      const r = await fn(s);
      await this.saveState(s);
      return r;
    });
  }

  private buildHistory(): any[] {
    try {
      const rows = this.sql.exec(`SELECT role, parts FROM messages ORDER BY timestamp ASC LIMIT 50`).toArray();
      return rows.map((r: any) => {
        const parts = this.parse<any[]>(r.parts);
        return { role: r.role === 'model' ? 'model' : 'user', parts: parts || [] };
      });
    } catch { return []; }
  }

  // -------------------------------------------
  // WebSocket + HTTP Handlers
  // -------------------------------------------
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // ---- WebSocket Endpoint ----
    if (url.pathname === '/api/ws' &&
        request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      this.activeWebSockets.add(server);
      this.metrics.activeConnections = this.activeWebSockets.size;
      return new Response(null, { status: 101, webSocket: client });
    }

    // ---- REST: /api/chat ----
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const msg = body.message;
      this.ctx.waitUntil(this.process(msg, null));
      return new Response(JSON.stringify({ status: 'queued' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ---- REST: /api/history ----
    if (url.pathname === '/api/history' && request.method === 'GET') {
      const rows = this.sql.exec(`SELECT role, parts, timestamp FROM messages ORDER BY timestamp ASC`);
      const messages = Array.from(rows).map((r: any) => ({
        role: r.role,
        parts: this.parse<any[]>(r.parts),
        timestamp: r.timestamp,
      }));
      return new Response(JSON.stringify({ messages }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    if (typeof msg !== 'string') return;
    let payload;
    try { payload = JSON.parse(msg); } catch { return; }

    if (payload.type === 'user_message' && typeof payload.content === 'string') {
      await this.process(payload.content, ws);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    console.log(`WebSocket closed: ${code} ${reason}`);
    this.activeWebSockets.delete(ws);
    this.metrics.activeConnections = this.activeWebSockets.size;
  }

  async webSocketError(ws: WebSocket, err: unknown): Promise<void> {
    console.error('WebSocket error:', err);
    this.activeWebSockets.delete(ws);
    this.metrics.activeConnections = this.activeWebSockets.size;
  }
}

export default AutonomousAgent;
