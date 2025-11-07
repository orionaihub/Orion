// src/autonomous-agent.ts
// Stable Prompt-Driven Autonomous Agent with working WebSocket streaming

import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import GeminiClient from './utils/gemini';
import type { Env, AgentState, Tool, ToolCall, ToolResult } from './types';

interface SqlStorage {
  exec(query: string, ...params: any[]): {
    one(): any;
    toArray(): any[];
    [Symbol.iterator](): Iterator<any>;
  };
}

export class AutonomousAgent extends DurableObject<Env> {
  private sql: SqlStorage;
  private gemini: GeminiClient;
  private readonly MAX_TURNS = 10;
  private readonly MAX_MESSAGE_SIZE = 120_000;
  private activeWebSockets = new Set<WebSocket>();

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

  // -----------------------------
  // Utility helpers
  // -----------------------------
  private stringify(obj: any): string {
    try { return JSON.stringify(obj); } catch { return String(obj); }
  }

  private parse<T>(text: string): T | null {
    try { return JSON.parse(text); } catch { return null; }
  }

  private send(ws: WebSocket | null, data: unknown): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(data)); } catch {}
  }

  private createChunkBatcher(ws: WebSocket | null, interval = 80) {
    let buffer = ''; let timer: any = null;
    const flush = () => {
      if (buffer && ws) {
        this.send(ws, { type: 'chunk', content: buffer });
        buffer = '';
      }
      timer = null;
    };
    return {
      add: (chunk: string) => {
        buffer += chunk;
        if (!timer) timer = setTimeout(flush, interval);
      },
      flush,
    };
  }

  // -----------------------------
  // Agent System Prompt
  // -----------------------------
  private buildSystemPrompt(): string {
    return `You are an autonomous AI agent that assists users efficiently.

# Rules
- If the query is simple, answer directly.
- If complex, reason step by step and respond progressively.
- Do not overthink.
- Always provide a final, clear answer.

# Behavior
- Provide small progress updates while reasoning.
- End with your final comprehensive answer.`;
  }

  // -----------------------------
  // Tool support
  // -----------------------------
  private getAvailableTools(): Tool[] {
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

  private async executeTools(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const call of toolCalls) {
      try {
        if (call.name === 'web_search') {
          results.push({
            name: 'web_search',
            success: true,
            result: this.stringify({
              query: call.args.query,
              results: [
                { title: `Mocked result for ${call.args.query}`, url: 'https://example.com' },
              ],
            }),
          });
        } else {
          results.push({ name: call.name, success: false, result: this.stringify({ error: 'Unknown tool' }) });
        }
      } catch (e) {
        results.push({ name: call.name, success: false, result: this.stringify({ error: String(e) }) });
      }
    }
    return results;
  }

  // -----------------------------
  // Main Process
  // -----------------------------
  private async process(userMsg: string, ws: WebSocket | null): Promise<void> {
    console.log('Processing user message:', userMsg);
    return this.withStateTransaction(async (state) => {
      if (userMsg.length > this.MAX_MESSAGE_SIZE)
        return this.send(ws, { type: 'error', error: 'Message too large' });

      this.sql.exec(
        `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
        'user',
        this.stringify([{ text: userMsg }]),
        Date.now()
      );

      const systemPrompt = this.buildSystemPrompt();
      const history = this.buildHistory();
      let conversation = [
        { role: 'system', parts: [{ text: systemPrompt }] },
        ...history,
        { role: 'user', parts: [{ text: userMsg }] },
      ];

      const batcher = this.createChunkBatcher(ws);
      let finalText = '';

      for (let turn = 0; turn < this.MAX_TURNS; turn++) {
        const response = await this.gemini.generateWithTools(
          conversation,
          this.getAvailableTools(),
          {
            model: 'gemini-2.5-flash',
            stream: true,
            thinkingConfig: { thinkingBudget: 1024 },
          },
          (chunk) => {
            batcher.add(chunk);
            finalText += chunk;
          }
        );

        batcher.flush();

        if (response.toolCalls && response.toolCalls.length > 0) {
          const toolResults = await this.executeTools(response.toolCalls);
          conversation.push({ role: 'model', parts: response.parts });
          conversation.push({
            role: 'user',
            parts: toolResults.map(r => ({ functionResponse: { name: r.name, response: r.result } })),
          });
          continue;
        }

        break;
      }

      batcher.flush();
      console.log('Final response length:', finalText.length);

      this.sql.exec(
        `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
        'model',
        this.stringify([{ text: finalText }]),
        Date.now()
      );

      this.send(ws, { type: 'final_response', content: finalText || '(no output)' });
      this.send(ws, { type: 'done' });
    });
  }

  // -----------------------------
  // State / History Helpers
  // -----------------------------
  private async loadState(): Promise<AgentState> {
    try {
      const row = this.sql.exec(`SELECT value FROM kv WHERE key='state'`).one();
      if (row?.value) return JSON.parse(row.value as string);
    } catch {}
    return { conversationHistory: [], context: { files: [], searchResults: [] }, sessionId: this.ctx.id.toString(), lastActivityAt: Date.now() } as AgentState;
  }

  private async saveState(state: AgentState): Promise<void> {
    this.sql.exec(
      `INSERT OR REPLACE INTO kv (key, value) VALUES ('state', ?)`,
      JSON.stringify(state)
    );
  }

  private async withStateTransaction<T>(fn: (state: AgentState) => Promise<T>): Promise<T> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.loadState();
      const result = await fn(state);
      await this.saveState(state);
      return result;
    });
  }

  private buildHistory(): any[] {
    try {
      const rows = this.sql.exec(`SELECT role, parts FROM messages ORDER BY timestamp ASC LIMIT 50`).toArray();
      return rows.map((r: any) => ({ role: r.role, parts: this.parse<any[]>(r.parts) || [] }));
    } catch { return []; }
  }

  // -----------------------------
  // WebSocket + HTTP handlers
  // -----------------------------
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket endpoint
    if (url.pathname === '/api/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      this.activeWebSockets.add(server);
      console.log('WebSocket connected');
      return new Response(null, { status: 101, webSocket: client });
    }

    // REST /api/chat
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const msg = body.message;
      this.ctx.waitUntil(this.process(msg, null));
      return new Response(JSON.stringify({ status: 'queued' }), { headers: { 'Content-Type': 'application/json' } });
    }

    // REST /api/history
    if (url.pathname === '/api/history' && request.method === 'GET') {
      const rows = this.sql.exec(`SELECT role, parts, timestamp FROM messages ORDER BY timestamp ASC`);
      const messages = Array.from(rows).map((r: any) => ({
        role: r.role,
        parts: this.parse<any[]>(r.parts),
        timestamp: r.timestamp,
      }));
      return new Response(JSON.stringify({ messages }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    let payload;
    try { payload = JSON.parse(message); } catch { return; }

    if (payload.type === 'user_message' && typeof payload.content === 'string') {
      console.log('Received user message via WebSocket');
      this.ctx.waitUntil(this.process(payload.content, ws));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    console.log(`WebSocket closed: ${code} - ${reason}`);
    this.activeWebSockets.delete(ws);
  }

  async webSocketError(ws: WebSocket, err: unknown): Promise<void> {
    console.error('WebSocket error:', err);
    this.activeWebSockets.delete(ws);
  }
}

export default AutonomousAgent;
