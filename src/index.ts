import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";

export interface Env {
  Agent: DurableObjectNamespace;
  GOOGLE_API_KEY: string;
  ASSETS: Fetcher;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_AI_GATEWAY_NAME?: string;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // === AGENT STREAM ENDPOINT ===============================================
    if (url.pathname === "/api/agent" && req.method === "POST") {
      const sessionId = getSessionId(req) ?? crypto.randomUUID();
      const id = env.Agent.idFromName(sessionId);
      const stub = env.Agent.get(id);

      const { content } = await req.json<{ content: string }>();
      const stubRes = await stub.fetch("https://agent/fetch", {
        method: "POST",
        body: JSON.stringify({ content }),
      });

      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const reader = stubRes.body!.getReader();

      ctx.waitUntil(
        (async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value);
          }
          await writer.close();
        })()
      );

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "Set-Cookie": `session_id=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
        },
      });
    }

    // === CLEAR SESSION =======================================================
    if (url.pathname === "/api/agent/clear" && req.method === "POST") {
      const sessionId = getSessionId(req);
      if (!sessionId) return new Response("No session", { status: 400 });
      const id = env.Agent.idFromName(sessionId);
      const stub = env.Agent.get(id);
      await stub.fetch("https://agent/clear");
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // === LIST FILES ==========================================================
    if (url.pathname === "/api/agent/files" && req.method === "GET") {
      const sessionId = getSessionId(req);
      if (!sessionId) return new Response("No session", { status: 400 });
      const id = env.Agent.idFromName(sessionId);
      const stub = env.Agent.get(id);
      return stub.fetch("https://agent/files");
    }

    // === STATIC SITE =========================================================
    return env.ASSETS.fetch(req);
  },
};

// Cookie reader helper
function getSessionId(req: Request): string | null {
  const c = req.headers.get("Cookie");
  if (!c) return null;
  const m = c.match(/session_id=([^;]+)/);
  return m ? m[1] : null;
}

// Sleep util
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ============================================================================
// DURABLE OBJECT
// ============================================================================
export class Agent {
  private sql: SqlStorage;
  private model: GenerativeModel | null = null;

  constructor(private state: DurableObjectState, private env: Env) {
    this.sql = state.storage.sql;
    this.initDb();
  }

  private initDb() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // === STREAM HANDLER ======================================================
    if (url.pathname === "/fetch" && req.method === "POST") {
      const { content } = await req.json<{ content: string }>();
      const { readable, writable } = new TransformStream();
      const encoder = new TextEncoder();
      const writer = writable.getWriter();

      (async () => {
        try {
          for await (const ev of this.fetchAgentStream(content)) {
            await writer.write(encoder.encode(JSON.stringify(ev) + "\n"));
          }
        } finally {
          await writer.close();
        }
      })();

      return new Response(readable, {
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      });
    }

    // === CLEAR ===============================================================
    if (url.pathname === "/clear") {
      this.sql.exec("DELETE FROM files;");
      return new Response("cleared");
    }

    // === FILE LIST ===========================================================
    if (url.pathname === "/files") {
      const rows = [...this.sql.exec("SELECT path, length(content) as size, updated_at FROM files")];
      return new Response(JSON.stringify(rows), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Agent ready");
  }

  // === STREAM GENERATOR ======================================================
  private async *fetchAgentStream(prompt: string): AsyncGenerator<any> {
    const model = this.getModel();
    const start = Date.now();
    yield { type: "start", data: { ts: start, prompt } };

    try {
      const result = await this.streamResponse(model, [], prompt);
      let output = "";
      for (const chunk of result.chunks) {
        yield { type: "response_chunk", data: { response: chunk } };
        output += chunk;
      }
      yield { type: "done", data: { elapsed: Date.now() - start, response_length: output.length } };
    } catch (e) {
      yield { type: "error", data: { message: (e as Error).message } };
    }
  }

  private getModel(): GenerativeModel {
    if (this.model) return this.model;
    const genAI = new GoogleGenerativeAI(this.env.GOOGLE_API_KEY);
    this.model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
    return this.model;
  }

  private async streamResponse(model: GenerativeModel, history: any[], prompt: string) {
    const chat = model.startChat({ history, generationConfig: { temperature: 0.4 } });
    const result = await chat.sendMessageStream(prompt);
    const chunks: string[] = [];
    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) chunks.push(text);
    }
    const response = await result.response;
    return { response, chunks };
  }
}
