// src/autonomous-agent.ts  (drop-in replacement)
import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import GeminiClient from './utils/gemini';
import type {
  Env,
  AgentState,
  Message,
  FileMetadata,
  AutonomousMode,
  AgentPhase,
  WebSocketMessage,
} from './types';

/* ------------------------------------------------------------------ */
/*  Utility types                                                     */
/* ------------------------------------------------------------------ */
interface SqlStorage {
  exec(query: string, ...params: any[]): {
    one(): any;
    toArray(): any[];
    [Symbol.iterator](): Iterator<any>;
  };
}

/* ------------------------------------------------------------------ */
/*  Durable Object                                                    */
/* ------------------------------------------------------------------ */
export class AutonomousAgent extends DurableObject<Env> {
  private sql: SqlStorage;
  private gemini: GeminiClient;
  private maxHistoryMessages = 200;
  private readonly MAX_MESSAGE_SIZE = 100_000;
  private readonly MAX_TOTAL_HISTORY_SIZE = 500_000;
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
        CREATE INDEX IF NOT EXISTS idx_msg_ts ON messages(timestamp);
      `);
    } catch (e) {
      console.error('SQLite init failed:', e);
    }
  }

  /* ================================================================ */
  /*  Utility helpers                                                 */
  /* ================================================================ */
  private parse<T>(text: string): T | null {
    try {
      const t = String(text || '').trim().replace(/^```json\s*/, '').replace(/```$/, '');
      return t ? (JSON.parse(t) as T) : null;
    } catch {
      return null;
    }
  }
  private stringify = JSON.stringify;

  private send(ws: WebSocket | null, data: unknown): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(this.stringify(data));
    } catch (e) {
      console.error('WS send failed:', e);
    }
  }

  /* ================================================================ */
  /*  State helpers                                                   */
  /* ================================================================ */
  private async loadState(): Promise<AgentState> {
    let state: AgentState | null = null;
    try {
      const row = this.sql.exec(`SELECT value FROM kv WHERE key = 'state'`).one();
      if (row?.value) state = this.parse<AgentState>(row.value as string);
    } catch (e) {
      console.error('loadState SQLite read failed:', e);
    }

    if (!state?.sessionId) {
      state = {
        conversationHistory: [],
        context: { files: [], searchResults: [] },
        sessionId: this.ctx.id.toString(),
        lastActivityAt: Date.now(),
        currentMode: AutonomousMode.CHAT,
        currentPhase: AgentPhase.ASSESSMENT,
      };
    }
    return state;
  }

  private async saveState(state: AgentState): Promise<void> {
    try {
      this.sql.exec(
        `INSERT INTO kv (key, value) VALUES ('state', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        this.stringify(state)
      );
    } catch (e) {
      console.error('saveState failed:', e);
    }
  }

  private async withStateTransaction<T>(fn: (state: AgentState) => Promise<T>): Promise<T> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.loadState();
      const result = await fn(state);
      await this.saveState(state);
      return result;
    });
  }

  /* ================================================================ */
  /*  History helpers                                                 */
  /* ================================================================ */
  private buildHistory(): Array<{ role: string; parts: Array<{ text: string }> }> {
    return this.ctx.blockConcurrencyWhile(() => {
      const rows = this.sql
        .exec(`SELECT role, parts FROM messages ORDER BY timestamp DESC LIMIT 50`)
        .toArray();
      const hist: Array<{ role: string; parts: Array<{ text: string }> }> = [];
      for (const r of rows.reverse()) {
        const parts = this.parse<any[]>(r.parts as string);
        if (parts) hist.push({ role: r.role === 'model' ? 'model' : 'user', parts });
      }
      return hist;
    });
  }

  private async addMessage(role: 'user' | 'model', text: string): Promise<void> {
    try {
      this.sql.exec(
        `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
        role,
        this.stringify([{ text }]),
        Date.now()
      );
    } catch (e) {
      console.error('addMessage failed:', e);
    }
  }

  /* ================================================================ */
  /*  Core processing  (SIMPLE path only – keeps old protocol)        */
  /* ================================================================ */
  private async process(userMsg: string, ws: WebSocket | null): Promise<void> {
    return this.withStateTransaction(async (state) => {
      state.lastActivityAt = Date.now();
      if (userMsg.length > this.MAX_MESSAGE_SIZE) {
        if (ws) this.send(ws, { type: 'error', error: 'Message too large' });
        throw new Error('Message exceeds maximum size');
      }
      await this.addMessage('user', userMsg);

      // Simple path – stream reply exactly like the working version
      const history = this.buildHistory();
      let full = '';
      await this.gemini.streamResponse(
        userMsg,
        history,
        (chunk) => {
          full += chunk;
          if (ws) this.send(ws, { type: 'chunk', content: chunk });
        },
        { model: 'gemini-2.5-flash', thinkingConfig: { thinkingBudget: 512 } }
      );

      await this.addMessage('model', full);
      if (ws) this.send(ws, { type: 'done' });
    });
  }

  /* ================================================================ */
  /*  HTTP fetch router                                               */
  /* ================================================================ */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // ---- WebSocket upgrade ---------------------------------------
    if (url.pathname === '/api/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      this.activeWebSockets.add(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // ---- REST endpoints ------------------------------------------
    if (url.pathname === '/api/chat' && request.method === 'POST') return this.handleChat(request);
    if (url.pathname === '/api/history' && request.method === 'GET') return this.getHistory();
    if (url.pathname === '/api/clear' && request.method === 'POST') return this.clearHistory();
    if (url.pathname === '/api/status' && request.method === 'GET') return this.getStatus();

    return new Response('Not found', { status: 404 });
  }

  /* ================================================================ */
  /*  WebSocket event handlers  (exact names the runtime expects)     */
  /* ================================================================ */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    let payload: any;
    try {
      payload = JSON.parse(message);
    } catch {
      this.send(ws, { type: 'error', error: 'Invalid JSON' });
      return;
    }

    if (payload.type === 'user_message' && typeof payload.content === 'string') {
      this.ctx.waitUntil(
        this.process(payload.content, ws).catch((err) => {
          console.error('WS process failed:', err);
          this.send(ws, { type: 'error', error: 'Processing failed' });
        })
      );
    } else {
      // front-end understands this key
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

  /* ================================================================ */
  /*  REST helpers                                                    */
  /* ================================================================ */
  private async handleChat(req: Request): Promise<Response> {
    let message: string;
    try {
      const body = (await req.json()) as { message: string };
      message = body.message;
      if (!message) throw new Error('Missing message');
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid request' }), { status: 400 });
    }
    this.ctx.waitUntil(this.process(message, null).catch(console.error));
    return new Response(JSON.stringify({ status: 'queued' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private getHistory(): Response {
    const rows = this.sql.exec(`SELECT role, parts, timestamp FROM messages ORDER BY timestamp ASC`);
    const msgs: Message[] = [];
    for (const r of rows) {
      const parts = this.parse<any[]>(r.parts as string);
      if (parts) msgs.push({ role: r.role as any, parts, timestamp: r.timestamp as number });
    }
    return new Response(this.stringify({ messages: msgs }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async clearHistory(): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        this.sql.exec('DELETE FROM messages');
        this.sql.exec('DELETE FROM kv');
        this.sql.exec('DELETE FROM sqlite_sequence WHERE name="messages"');
      } catch (e) {
        console.error('Clear failed:', e);
      }
      return new Response(this.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }

  private async getStatus(): Promise<Response> {
  const state = await this.loadState();
  return new Response(
    this.stringify({
      currentMode: state.currentMode,
      currentPhase: state.currentPhase,
      lastActivity: state.lastActivityAt,
      sessionId: state.sessionId,
    }),
    { headers: { 'Content-Type': 'application/json' } }
  ); 
  }
}
