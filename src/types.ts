// src/autonomous-agent.ts
import { DurableObject } from 'cloudflare:workers';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { Env, Message } from './types';

const SYSTEM_PROMPT = "You are a helpful, friendly assistant. Provide concise and accurate responses.";

export class AutonomousAgent extends DurableObject<Env> {
  private sql: SqlStorage;
  private genAI: GoogleGenerativeAI;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    this.genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

    // Tables – sync, idempotent
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ts ON messages(timestamp);
    `);
  }

  // -----------------------------------------------------------------
  // fetch
  // -----------------------------------------------------------------
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/api/chat' && request.method === 'POST') {
      return this.handleChat(request);
    }
    if (url.pathname === '/api/history' && request.method === 'GET') {
      return this.getHistory();
    }
    if (url.pathname === '/api/clear' && request.method === 'POST') {
      return this.clearHistory();
    }
    if (url.pathname === '/api/status' && request.method === 'GET') {
      return this.getStatus();
    }

    return new Response('Not found', { status: 404 });
  }

  // -----------------------------------------------------------------
  // WebSocket
  // -----------------------------------------------------------------
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return;
    let payload;
    try { payload = JSON.parse(message); } catch { return; }
    if (payload.type === 'user_message') {
      await this.processMessage(payload.content, ws);
    }
  }

  // -----------------------------------------------------------------
  // Core message processing (shared by WS and HTTP)
  // -----------------------------------------------------------------
  private async processMessage(userMsg: string, ws: WebSocket | null) {
    const timestamp = Date.now();

    // Save user message
    this.sql.exec(
      'INSERT INTO messages (role, content, timestamp) VALUES (?, ?, ?)',
      'user', userMsg, timestamp
    );

    // Stream response
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    this.ctx.waitUntil(
      this.streamGeminiResponse(userMsg, writer, encoder, ws)
    );

    if (ws) {
      // For WS, we don't return a stream – we send via WS
      return;
    }

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }

  // -----------------------------------------------------------------
  // Gemini streaming (same as working example)
  // -----------------------------------------------------------------
  private async streamGeminiResponse(
    userMessage: string,
    writer: WritableStreamDefaultWriter,
    encoder: TextEncoder,
    ws: WebSocket | null
  ) {
    try {
      const model = this.genAI.getGenerativeModel({
        model: 'gemini-2.0-flash-exp',
        systemInstruction: SYSTEM_PROMPT,
      });

      const cursor = this.sql.exec(`
        SELECT role, content FROM messages
        WHERE role != 'system'
        ORDER BY timestamp ASC
      `);

      const history: Array<{ role: string; parts: Array<{ text: string }> }> = [];
      for (const row of cursor) {
        history.push({
          role: row.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: row.content as string }],
        });
      }
      if (history.length > 0) history.pop(); // remove current user msg

      const chat = model.startChat({ history });
      const result = await chat.sendMessageStream(userMessage);

      let full = '';
      for await (const chunk of result.stream) {
        const txt = chunk.text();
        full += txt;
        const data = JSON.stringify({ response: txt }) + '\n';
        if (ws) {
          try { ws.send(data); } catch {}
        } else {
          await writer.write(encoder.encode(data));
        }
      }

      // Save assistant reply
      this.sql.exec(
        'INSERT INTO messages (role, content, timestamp) VALUES (?, ?, ?)',
        'assistant', full, Date.now()
      );

      if (!ws) await writer.close();
      if (ws) try { ws.send(JSON.stringify({ type: 'done' })); } catch {}
    } catch (err) {
      console.error('Gemini error:', err);
      const msg = { error: 'Gemini failed', details: err instanceof Error ? err.message : 'unknown' };
      const data = JSON.stringify(msg) + '\n';
      if (ws) {
        try { ws.send(data); } catch {}
      } else {
        await writer.write(encoder.encode(data));
        await writer.close();
      }
    }
  }

  // -----------------------------------------------------------------
  // HTTP handlers
  // -----------------------------------------------------------------
  private async handleChat(request: Request): Promise<Response> {
    const { message } = await request.json<{ message: string }>();
    if (!message) {
      return new Response(JSON.stringify({ error: 'Missing message' }), { status: 400 });
    }
    return this.processMessage(message, null) || new Response(JSON.stringify({ status: 'queued' }));
  }

  private getHistory(): Response {
    const cursor = this.sql.exec(`
      SELECT role, content, timestamp FROM messages
      WHERE role != 'system'
      ORDER BY timestamp ASC
    `);
    const messages: Message[] = [];
    for (const row of cursor) {
      messages.push({
        role: row.role as 'user' | 'assistant',
        content: row.content as string,
        timestamp: row.timestamp as number,
      });
    }
    return new Response(JSON.stringify({ messages }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private clearHistory(): Response {
    this.sql.exec('DELETE FROM messages');
    this.sql.exec('DELETE FROM sqlite_sequence WHERE name = "messages"');
    return new Response(JSON.stringify({ success: true }));
  }

  private getStatus(): Response {
    const first = this.sql.exec('SELECT timestamp FROM messages ORDER BY timestamp ASC LIMIT 1').one();
    const last = this.sql.exec('SELECT timestamp FROM messages ORDER BY timestamp DESC LIMIT 1').one();
    const count = this.sql.exec('SELECT COUNT(*) AS c FROM messages').one()?.c ?? 0;
    return new Response(JSON.stringify({
      messageCount: count,
      createdAt: first?.timestamp ?? null,
      lastActivity: last?.timestamp ?? null,
    }), { headers: { 'Content-Type': 'application/json' } });
  }
}
