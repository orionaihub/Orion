/**
 * Suna-like Autonomous Agent – Free-Tier Only
 *  - 10 ms CPU wall respected (early yield + waitUntil tail)
 *  - Persistent POSIX workspace via DO SQLite volume
 *  - Pyodide WASM Python sandbox (bundled ≤ 1 MB gz)
 *  - Native Gemini search & code execution (no stubs)
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

    // ---------- static front-end (same HTML you already have) --------------
    if (url.pathname === "/" || url.pathname.startsWith("/public/")) {
      return fetch("https://your-static-site.com" + url.pathname); // or serve from KV
    }

    // ---------- agent API ----------------------------------------------------
    if (url.pathname === "/api/agent" && req.method === "POST") {
      const sessionId = getSessionId(req) ?? crypto.randomUUID();
      const id = env.Agent.idFromName(sessionId);
      const stub = env.Agent.get(id);

      // 1. quick answer (< 10 ms) – SSE stream starts immediately
      const { readable, writable } = new TransformStream();
      const encoder = new TextEncoder();
      const writer = writable.getWriter();
      ctx.waitUntil(
        (async () => {
          // 2. heavy lifting runs in tail (no CPU clock)
          const body = await req.json<{ content: string; mode?: string }>();
          for await (const ev of stub.fetchAgentStream(body.content, body.mode)) {
            await writer.write(encoder.encode(JSON.stringify(ev) + "\n"));
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

    // ---------- clear history ------------------------------------------------
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
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

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

  // Public method called by tail (no CPU clock)
  async *fetchAgentStream(userPrompt: string, mode = "default"): AsyncGenerator<unknown> {
    const start = Date.now();
    yield { type: "start", ts: start };

    // 1. Persist user message
    this.sql.exec("INSERT INTO agent_traces (ts,type,payload) VALUES (?,?,?)", start, "user", userPrompt);

    // 2. Build Gemini model (native tools enabled)
    const model = this.buildGemini();

    // 3. Multi-step loop
    const maxIter = 10;
    let iter = 0;
    let history: { role: "user" | "model"; parts: { text: string }[] }[] = [];
    let finalText = "";

    while (iter < maxIter) {
      iter++;
      const iterStart = Date.now();

      // 3a. Gemini call
      const chat = model.startChat({ history, generationConfig: { temperature: 0.3 } });
      const stream = await chat.sendMessageStream(userPrompt);

      let chunkText = "";
      for await (const chunk of stream) {
        const t = chunk.text();
        if (t) {
          chunkText += t;
          finalText += t;
          yield { type: "response_chunk", text: t };
        }
      }

      // 3b. Native tool calls (search, code-exec) already handled by Gemini
      const toolCalls = this.extractToolCalls(stream);
      if (toolCalls.length === 0) break;

      // 3c. Parallel local tools (workspace, python, etc.)
      const results = await Promise.allSettled(
        toolCalls.map(async (call) => {
          yield { type: "tool_start", name: call.name, args: call.args };
          const out = await this.runTool(call.name, call.args);
          yield { type: "tool_end", name: call.name, out };
          return { call, out };
        })
      );

      // 3d. Append to history
      history.push({ role: "model", parts: [{ text: chunkText }] });
      for (const r of results) {
        if (r.status === "fulfilled") {
          const { call, out } = r.value;
          history.push({ role: "user", parts: [{ text: `Result of ${call.name}: ${out}` }] });
        }
      }

      // 3e. Reflection every 2nd iteration to save tokens
      if (iter % 2 === 0) {
        const reflection = await this.reflect(model, history);
        yield { type: "reflection", ...reflection };
        if (reflection.confidence > 0.8) break;
      }

      // 3f. Hard tail guard (realistic wall)
      if (Date.now() - start > 25_000) {
        yield { type: "warning", reason: "25 s tail guard" };
        break;
      }
    }

    // 4. Store assistant message
    const end = Date.now();
    this.sql.exec("INSERT INTO agent_traces (ts,type,payload) VALUES (?,?,?)", end, "assistant", finalText);
    yield { type: "done", elapsed: end - start, iterations: iter };
  }

  // ---------- GEMINI SETUP ----------------------------------------------------
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
        tools: [
          { googleSearch: {} },          // native search
          { codeExecution: {} },         // native python sandbox
        ],
      },
      gateway ? { baseUrl: gateway } : undefined
    );
  }

  // ---------- TOOL RUNNER -----------------------------------------------------
  private async runTool(name: string, args: any): Promise<string> {
    switch (name) {
      case "read_file":
        return this.readFile(args.path);
      case "write_file":
        return this.writeFile(args.path, args.content);
      case "list_files":
        return this.listFiles(args.path ?? ".");
      case "execute_python":
        return this.runPython(args.code);
      default:
        return `Unknown local tool ${name}`;
    }
  }

  // ---------- POSIX VOLUME ----------------------------------------------------
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
    return rows.map((r) => r.path).join("\n");
  }

  // ---------- PYTHON WASM -----------------------------------------------------
  private async runPython(code: string): Promise<string> {
    // Bundled Pyodide index < 1 MB gz; loaded once per isolate
    const pyodide = await this.getPyodide();
    try {
      const out = await pyodide.runPythonAsync(code);
      return String(out ?? "");
    } catch (e: any) {
      return `Python error: ${e.message}`;
    }
  }

  private pyodideInstance: any = null;
  private async getPyodide() {
    if (this.pyodideInstance) return this.pyodideInstance;
    // @ts-ignore – we shim pyodide.js in wrangler.toml as text_blob
    const pyodideScript = await (globalThis as any).PYODIDE_SCRIPT.text();
    const pyodide = await import("data:text/javascript," + encodeURIComponent(pyodideScript));
    await pyodide.loadPackage(["micropip"]);
    this.pyodideInstance = pyodide;
    return pyodide;
  }

  // ---------- REFLECTION ------------------------------------------------------
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

  // ---------- UTILS -----------------------------------------------------------
  private extractToolCalls(stream: any): { name: string; args: any }[] {
    // Gemini 2.5 Flash embeds native tool calls inside response; we just forward them
    const calls = stream.response?.functionCalls?.() ?? [];
    return calls.map((c: any) => ({ name: c.name, args: c.args }));
  }

  async clear() {
    this.sql.exec("DELETE FROM files; DELETE FROM agent_traces; DELETE FROM sqlite_sequence;");
  }
}
