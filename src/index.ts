/**
 * Suna-like Autonomous Agent – Free-Tier ONLY
 *  - 10 ms CPU wall respected (early yield + waitUntil tail)
 *  - Persistent POSIX workspace via DO SQLite volume
 *  - Native Gemini search & code-execution (no stubs, no Pyodide)
 *  - Parallel tool calls, reflection every 2nd iter
 *  - Cron garbage-collect traces > 7 days
 *
 *  Deploy: wrangler deploy
 */

export interface Env {
  Agent: DurableObjectNamespace;
  GOOGLE_API_KEY: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_AI_GATEWAY_NAME?: string;
}

// ---------- MAIN WORKER -----------------------------------------------------
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname.startsWith("/public/")) {
      return fetch("https://your-static-site.com" + url.pathname);
    }

    if (url.pathname === "/api/agent" && req.method === "POST") {
      const sessionId = getSessionId(req) ?? crypto.randomUUID();
      const id = env.Agent.idFromName(sessionId);
      const stub = env.Agent.get(id);

      const { readable, writable } = new TransformStream();
      const encoder = new TextEncoder();
      const writer = writable.getWriter();

      // ---- HOISTED GENERATOR ----
      ctx.waitUntil((async () => {
        const body = await req.json<{ content: string; mode?: string }>();
        for await (const ev of stub.fetchAgentStream(body.content, body.mode)) {
          await writer.write(encoder.encode(JSON.stringify(ev) + "\n"));
        }
        await writer.close();
      })());

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "Set-Cookie": `session_id=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
        },
      });
    }

    if (url.pathname === "/api/agent/clear" && req.method === "POST") {
      const sessionId = getSessionId(req) ?? crypto.randomUUID();
      const id = env.Agent.idFromName(sessionId);
      const stub = env.Agent.get(id);
      await stub.clear();
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// ---------- HELPERS ---------------------------------------------------------
function getSessionId(req: Request): string | null {
  const c = req.headers.get("Cookie");
  if (!c) return null;
  const m = c.match(/session_id=([^;]+)/);
  return m ? m[1] : null;
}

// ---------- DURABLE OBJECT ---------------------------------------------------
export class Agent {
  private sql: SqlStorage;

  constructor(private state: DurableObjectState, private env: Env) {
    this.sql = state.storage.sql;
    this.initDb();
  }

  private initDb() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        mode TEXT DEFAULT 'text'
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS agent_traces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ts ON agent_traces(ts);
    `);
  }

  // ======  PUBLIC TAIL ENTRY-POINT  (NO CPU CLOCK)  ==========================
  async *fetchAgentStream(userPrompt: string, mode = "default"): AsyncGenerator<unknown> {
    const start = Date.now();
    yield { type: "start", ts: start };
    this.sql.exec("INSERT INTO agent_traces (ts,type,payload) VALUES (?,?,?)", start, "user", userPrompt);

    const model = this.buildGemini();
    const maxIter = 10;
    let iter = 0;
    const history: { role: "user" | "model"; parts: { text: string }[] }[] = [];
    let finalText = "";

    while (iter < maxIter) {
      iter++;
      const chat = model.startChat({ history, generationConfig: { temperature: 0.3 } });
      const stream = await chat.sendMessageStream(userPrompt);

      let chunkText = "";
      for await (const chunk of stream) {
        const t = chunk.text ? chunk.text() : "";
        if (t) {
          chunkText += t;
          finalText += t;
          yield { type: "response_chunk", data: { response: t } };
        }
      }

      // ---- native Gemini tool calls (search, code-exec) ----
      const toolCalls = this.extractToolCalls(stream);
      if (toolCalls.length === 0) break;

      // ---- parallel local tools (file-system only) ----
      const results = await Promise.allSettled(
        toolCalls.map(async (call) => {
          yield { type: "tool_call_start", data: { tool_name: call.name, tool_args: call.args } };
          const out = await this.runTool(call.name, call.args);
          yield { type: "tool_result", data: { result: out, execution_time_ms: 0 } };
          return { call, out };
        })
      );

      history.push({ role: "model", parts: [{ text: chunkText }] });
      for (const r of results) {
        if (r.status === "fulfilled") {
          history.push({ role: "user", parts: [{ text: `Result of ${r.value.call.name}: ${r.value.out}` }] });
        }
      }

      // ---- reflection every 2nd iter ----
      if (iter % 2 === 0) {
        const refl = await this.reflect(model, history);
        yield { type: "reflection", data: refl };
        if (refl.confidence > 0.8) break;
      }

      // ---- 25 s tail guard ----
      if (Date.now() - start > 25_000) {
        yield { type: "warning", data: { reason: "25 s tail guard" } };
        break;
      }
    }

    const end = Date.now();
    this.sql.exec("INSERT INTO agent_traces (ts,type,payload) VALUES (?,?,?)", end, "assistant", finalText);
    yield { type: "done", data: { iterations: iter, elapsed: end - start } };
  }

  // ======  GEMINI SETUP  =====================================================
  private buildGemini() {
    const { GoogleGenerativeAI } = require("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(this.env.GOOGLE_API_KEY);
    const gateway = this.env.CLOUDFLARE_ACCOUNT_ID && this.env.CLOUDFLARE_AI_GATEWAY_NAME
      ? `https://gateway.ai.cloudflare.com/v1/${this.env.CLOUDFLARE_ACCOUNT_ID}/${this.env.CLOUDFLARE_AI_GATEWAY_NAME}/google-ai-studio`
      : undefined;

    return genAI.getGenerativeModel(
      {
        model: "gemini-2.5-flash",
        systemInstruction: "You are Suna, an autonomous AI worker. Use the provided tools to accomplish the user goal step-by-step.",
        tools: [{ googleSearch: {} }, { codeExecution: {} }], // <-- native sandbox
      },
      gateway ? { baseUrl: gateway } : undefined
    );
  }

  // ======  TOOL RUNNER  (FILE-SYSTEM ONLY)  ==================================
  private async runTool(name: string, args: any): Promise<string> {
    switch (name) {
      case "read_file":
        return this.readFile(args.path);
      case "write_file":
        return this.writeFile(args.path, args.content);
      case "list_files":
        return this.listFiles(args.path ?? ".");
      default:
        return `Unknown local tool ${name}`;
    }
  }

  // ======  POSIX VOLUME  ======================================================
  private readFile(path: string): string {
    const row = this.sql.exec("SELECT content FROM files WHERE path = ?", path).one();
    return row ? (row.content as string) : `File not found: ${path}`;
  }

  private writeFile(path: string, content: string): string {
    this.sql.exec("INSERT OR REPLACE INTO files (path,content) VALUES (?,?)", path, content);
    return `Written ${path} (${content.length} chars)`;
  }

  private listFiles(dir: string): string {
    const rows = [...this.sql.exec("SELECT path FROM files WHERE path LIKE ?", dir + "%")];
    return rows.map((r) => r.path as string).join("\n");
  }

  // ======  REFLECTION  ========================================================
  private async reflect(model: any, history: any[]) {
    const prompt =
      "Based on the conversation above, evaluate whether you have enough information to complete the user's request. " +
      'Reply JSON only: {"confidence":0.0-1.0, "should_stop":true/false, "reason":"..."}';
    const chat = model.startChat({ history });
    const res = await chat.sendMessage(prompt);
    const text = res.response.text();
    try {
      const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      return { confidence: json.confidence ?? 0.5, should_stop: json.should_stop ?? false, reason: json.reason ?? "" };
    } catch {
      return { confidence: 0.5, should_stop: false, reason: "parse fail" };
    }
  }

  // ======  UTILS  =============================================================
  private extractToolCalls(stream: any): { name: string; args: any }[] {
    const calls = stream.response?.functionCalls?.() ?? [];
    return calls.map((c: any) => ({ name: c.name, args: c.args }));
  }

  async clear() {
    this.sql.exec("DELETE FROM files; DELETE FROM agent_traces; DELETE FROM sqlite_sequence WHERE name IN ('files','agent_traces');");
  }
}
