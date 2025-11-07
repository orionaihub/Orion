// src/autonomous-agent-simplified.ts - Drop-in replacement with minimal changes
import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import GeminiClient from './utils/gemini';
import type { Env, AgentState, Message } from './types';

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
  private maxHistoryMessages = 200;
  private readonly MAX_MESSAGE_SIZE = 100_000;
  private readonly MAX_TURNS = 8;
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

  // ===== System Prompt =====

  private getSystemPrompt(hasFiles: boolean): string {
    return `You are an autonomous AI assistant. Follow these guidelines:

# Response Strategy
1. For simple questions (greetings, definitions, facts): Answer directly and concisely
2. For complex tasks (research, analysis, multi-step): Break down your approach and execute progressively
3. Always explain your reasoning briefly

# Available Capabilities
- General knowledge and reasoning
- Step-by-step problem solving
- Data analysis and calculations
${hasFiles ? '- File analysis (user has uploaded files)' : ''}

# Style
- Be conversational and helpful
- Provide structured responses for complex topics
- Cite sources when discussing recent information
- Admit if you don't know something

# Rules
- Respond directly without unnecessary planning
- Don't overthink simple queries
- For research topics, acknowledge your knowledge cutoff (January 2025)

Think about the user's request and respond naturally.`;
  }

  // ===== Core Processing =====

  private async process(userMsg: string, ws: WebSocket | null): Promise<void> {
    return this.withStateTransaction(async (state) => {
      state.lastActivityAt = Date.now();

      if (userMsg.length > this.MAX_MESSAGE_SIZE) {
        if (ws) this.send(ws, { type: 'error', error: 'Message too large' });
        throw new Error('Message exceeds maximum size');
      }

      // Save user message
      try {
        this.sql.exec(
          `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
          'user',
          JSON.stringify([{ text: userMsg }]),
          Date.now()
        );
      } catch (e) {
        console.error('Failed to save user message:', e);
        if (ws) this.send(ws, { type: 'error', error: 'Save failed' });
        throw e;
      }

      // Build context
      const hasFiles = (state.context?.files ?? []).length > 0;
      const systemPrompt = this.getSystemPrompt(hasFiles);
      const history = this.buildHistory();

      // Send status
      if (ws) this.send(ws, { type: 'status', message: 'Thinking...' });

      // Create enhanced prompt with system instructions
      const enhancedPrompt = `${systemPrompt}

User Query: ${userMsg}`;

      const batcher = this.createChunkBatcher(ws, 'chunk');
      let fullResponse = '';

      try {
        // Use the existing streamResponse method from your original gemini client
        await this.gemini.streamResponse(
          enhancedPrompt,
          history,
          (chunk) => {
            fullResponse += chunk;
            batcher.add(chunk);
          },
          { 
            model: 'gemini-2.5-flash', 
            thinkingConfig: { thinkingBudget: 1024 } 
          }
        );

        batcher.flush();

        // Save model response
        try {
          this.sql.exec(
            `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
            'model',
            JSON.stringify([{ text: fullResponse }]),
            Date.now()
          );
        } catch (e) {
          console.error('Failed to save model response:', e);
        }

        if (ws) {
          this.send(ws, { type: 'final_response', content: fullResponse });
          this.send(ws, { type: 'done', turns: 1 });
        }
      } catch (e) {
        console.error('Process error:', e);
        if (ws) this.send(ws, { type: 'error', error: 'Processing failed' });
        throw e;
      }
    });
  }

  // ===== State Management =====

  private async loadState(): Promise<AgentState> {
    let state: AgentState | null = null;
    try {
      const row = this.sql.exec(`SELECT value FROM kv WHERE key = 'state'`).one();
      if (row && typeof row.value === 'string') {
        state = JSON.parse(row.value);
      }
    } catch (e) {
      console.error('SQLite read failed:', e);
    }

    if (!state || !state.sessionId) {
      state = {
        conversationHistory: [],
        context: { files: [], searchResults: [] },
        sessionId: this.ctx?.id?.toString ? this.ctx.id.toString() : Date.now().toString(),
        lastActivityAt: Date.now(),
      } as AgentState;
    }

    return state;
  }

  private async saveState(state: AgentState): Promise<void> {
    try {
      const stateStr = JSON.stringify(state);
      this.sql.exec(
        `INSERT INTO kv (key, value) VALUES ('state', ?) 
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        stateStr
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

  private buildHistory(): Array<{ role: string; parts: Array<{ text: string }> }> {
    return this.ctx.blockConcurrencyWhile(() => {
      const rows = this.sql
        .exec(
          `SELECT role, parts FROM messages ORDER BY timestamp DESC LIMIT ?`,
          Math.min(this.maxHistoryMessages, 50)
        )
        .toArray();

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

      // Remove consecutive duplicates
      let i = hist.length - 1;
      while (i > 0) {
        if (hist[i].role === 'user' && hist[i - 1].role === 'user') {
          hist.splice(i, 1);
        }
        i--;
      }

      return hist;
    });
  }

  // ===== WebSocket Management =====

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

  // ===== HTTP Fetch Handler =====

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      this.activeWebSockets.add(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/api/chat' && request.method === 'POST') return this.handleChat(request);
    if (url.pathname === '/api/history' && request.method === 'GET') return this.getHistory();
    if (url.pathname === '/api/clear' && request.method === 'POST') return this.clearHistory();
    if (url.pathname === '/api/status' && request.method === 'GET') return this.getStatus();

    return new Response('Not found', { status: 404 });
  }

  // ===== WebSocket Handlers =====

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    if (ws.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket not open, discarding message');
      return;
    }

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
          console.error('WebSocket process failed:', err);
          this.send(ws, { type: 'error', error: 'Processing failed' });
        })
      );
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

  // ===== HTTP Handlers =====

  private async handleChat(req: Request): Promise<Response> {
    let message: string;
    try {
      const body = (await req.json()) as { message: string };
      message = body.message;
      if (!message) throw new Error('Missing message');
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid request' }), { status: 400 });
    }

    this.ctx.waitUntil(
      this.process(message, null).catch((err) => {
        console.error('Background process failed:', err);
      })
    );

    return new Response(JSON.stringify({ status: 'queued' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private getHistory(): Response {
    const rows = this.sql.exec(`SELECT role, parts, timestamp FROM messages ORDER BY timestamp ASC`);
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
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        this.sql.exec('DELETE FROM messages');
        this.sql.exec('DELETE FROM kv');
        this.sql.exec('DELETE FROM sqlite_sequence WHERE name IN ("messages")');
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
      const row = this.sql.exec(`SELECT value FROM kv WHERE key='state'`).one();
      state = row ? JSON.parse(row.value as string) : null;
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
