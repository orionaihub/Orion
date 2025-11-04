// src/autonomous-agent.ts
import { DurableObject } from 'cloudflare:workers';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { Env } from './types';

const SYSTEM_PROMPT =
  "You are a helpful, friendly assistant. Provide concise and accurate responses.";

export class AutonomousAgent extends DurableObject<Env> {
  private sql: SqlStorage;
  private genAI: GoogleGenerativeAI;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    this.genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

    // ONLY ONE TABLE – exactly like the working Chat example
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

  // --------------------------------------------------------------
  // fetch
  // --------------------------------------------------------------
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket
    if (url.pathname === '/api/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // HTTP endpoints
    if (url.pathname === '/api/chat' && request.method === 'POST') return this.handleChat(request);
    if (url.pathname === '/api/history' && request.method === 'GET') return this.getHistory();
    if (url.pathname === '/api/clear' && request.method === 'POST') return this.clearHistory();

    return new Response('Not found', { status: 404 });
  }

  // --------------------------------------------------------------
  // WebSocket
  // --------------------------------------------------------------
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return;
    let payload;
    try { payload = JSON.parse(message); } catch { return; }
    if (payload.type === 'user_message') await this.process(payload.content, ws);
  }

  // --------------------------------------------------------------
  // Core processing (shared)
  // --------------------------------------------------------------
  private async process(userMsg: string, ws: WebSocket | null) {
    const ts = Date.now();
    this.sql.exec(
      'INSERT INTO messages (role, content, timestamp) VALUES (?, ?, ?)',
      'user', userMsg, ts
    );

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();

    this.ctx.waitUntil(this.streamGemini(userMsg, writer, enc, ws));

    if (ws) return; // WS gets data via send()
    return new Response(readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    });
  }

  // --------------------------------------------------------------
  // Gemini streaming
  // --------------------------------------------------------------
  private async streamGemini(
    userMsg: string,
    writer: WritableStreamDefaultWriter,
    enc: TextEncoder,
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

      const history: Array<{ role: string; parts: [{ text: string }] }> = [];
      for (const r of cursor) {
        history.push({
          role: r.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: r.content as string }],
        });
      }
      if (history.length) history.pop(); // remove current user msg

      const chat = model.startChat({ history });
      const result = await chat.sendMessageStream(userMsg);

      let full = '';
      for await (const chunk of result.stream) {
        const txt = chunk.text();
        full += txt;
        const data = JSON.stringify({ response: txt }) + '\n';
        if (ws) {
          try { ws.send(data); } catch {}
        } else {
          await writer.write(enc.encode(data));
        }
      }

      // Save assistant reply
      this.sql.exec(
        'INSERT INTO messages (role, content, timestamp) VALUES (?, ?, ?)',
        'assistant', full, Date.now()
      );

      if (!ws) await writer.close();
      if (ws) try { ws.send(JSON.stringify({ type: 'done' })); } catch {}
    } catch (e) {
      const msg = { error: 'Gemini failed', details: e instanceof Error ? e.message : 'unknown' };
      const data = JSON.stringify(msg) + '\n';
      if (ws) try { ws.send(data); } catch {}
      else {
        await writer.write(enc.encode(data));
        await writer.close();
      }
    }
  }

  // --------------------------------------------------------------
  // HTTP handlers
  // --------------------------------------------------------------
  private async handleChat(req: Request): Promise<Response> {
    const { message } = await req.json<{ message: string }>();
    if (!message) return new Response(JSON.stringify({ error: 'no message' }), { status: 400 });
    return this.process(message, null) || new Response(JSON.stringify({ status: 'queued' }));
  }

  private getHistory(): Response {
    const rows = this.sql.exec(`
      SELECT role, content, timestamp FROM messages
      WHERE role != 'system'
      ORDER BY timestamp ASC
    `);
    const msgs: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }> = [];
    for (const r of rows) {
      msgs.push({
        role: r.role as any,
        content: r.content as string,
        timestamp: r.timestamp as number,
      });
    }
    return new Response(JSON.stringify({ messages: msgs }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private clearHistory(): Response {
    this.sql.exec('DELETE FROM messages');
    this.sql.exec('DELETE FROM sqlite_sequence WHERE name = "messages"');
    return new Response(JSON.stringify({ ok: true }));
  }
}
