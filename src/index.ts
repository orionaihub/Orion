/**
 * Suna Autonomous Agent - Cloudflare Workers Free Tier
 * Sequential execution, CPU compliant, NO YIELD ERRORS
 */

import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";

export interface Env {
  Agent: DurableObjectNamespace;
  GOOGLE_API_KEY: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_AI_GATEWAY_NAME?: string;
}

// ---------- WORKER ----------------------------------------------------------
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/agent" && req.method === "POST") {
      const sessionId = getSessionId(req) ?? crypto.randomUUID();
      const id = env.Agent.idFromName(sessionId);
      const stub = env.Agent.get(id);

      const { readable, writable } = new TransformStream();
      const encoder = new TextEncoder();
      const writer = writable.getWriter();

      ctx.waitUntil(
        (async () => {
          try {
            const body = await req.json<{ content: string }>();
            for await (const ev of stub.fetchAgentStream(body.content)) {
              await writer.write(encoder.encode(JSON.stringify(ev) + "\n"));
            }
          } catch (error) {
            const err = error as Error;
            await writer.write(
              encoder.encode(
                JSON.stringify({
                  type: "error",
                  data: { message: err.message, stack: err.stack },
                }) + "\n"
              )
            );
          } finally {
            await writer.close();
          }
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

    if (url.pathname === "/api/agent/clear" && req.method === "POST") {
      const sessionId = getSessionId(req) ?? crypto.randomUUID();
      const id = env.Agent.idFromName(sessionId);
      const stub = env.Agent.get(id);
      await stub.clear();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/api/agent/files" && req.method === "GET") {
      const sessionId = getSessionId(req);
      if (!sessionId) {
        return new Response(JSON.stringify({ error: "No session" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      const id = env.Agent.idFromName(sessionId);
      const stub = env.Agent.get(id);
      const files = await stub.listAllFiles();
      return new Response(JSON.stringify({ files }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

function getSessionId(req: Request): string | null {
  const c = req.headers.get("Cookie");
  if (!c) return null;
  const m = c.match(/session_id=([^;]+)/);
  return m ? m[1] : null;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- DURABLE OBJECT --------------------------------------------------
export class Agent {
  private sql: SqlStorage;
  private model: GenerativeModel | null = null;

  constructor(
    private state: DurableObjectState,
    private env: Env
  ) {
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
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS agent_traces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ts ON agent_traces(ts);
    `);
    this.cleanupOldTraces();
  }

  // === MAIN GENERATOR (ONLY PLACE WITH YIELD) ================================
  async *fetchAgentStream(userPrompt: string): AsyncGenerator<any> {
    const startTime = Date.now();
    const maxIter = 15;
    const timeout = 28000;

    yield { type: "start", data: { ts: startTime, prompt: userPrompt } };
    this.logTrace(startTime, "user", userPrompt);

    try {
      const model = this.getModel();
      const history: any[] = [];
      let iter = 0;
      let fullResponse = "";

      while (iter < maxIter) {
        iter++;
        yield { type: "iteration", data: { iteration: iter } };

        if (Date.now() - startTime > timeout) {
          yield { type: "warning", data: { reason: "Timeout approaching", elapsed: Date.now() - startTime } };
          break;
        }

        await sleep(0);

        const prompt = iter === 1 ? userPrompt : "";
        const streamResult = await this.streamResponse(model, history, prompt);

        for (const chunk of streamResult.chunks) {
          yield { type: "response_chunk", data: { text: chunk } };
          fullResponse += chunk;
        }

        await sleep(0);

        const fnCalls = streamResult.response.functionCalls();
        
        if (!fnCalls || fnCalls.length === 0) {
          yield { type: "complete", data: { final_response: fullResponse } };
          break;
        }

        history.push({
          role: "model",
          parts: fnCalls.map((fc: any) => ({
            functionCall: { name: fc.name, args: fc.args },
          })),
        });

        const toolResults = [];

        for (const fc of fnCalls) {
          yield { type: "function_call", data: { name: fc.name, args: fc.args } };

          await sleep(0);

          const result = await this.runTool(fc.name, fc.args);
          toolResults.push(result);

          yield { type: "function_result", data: result };

          await sleep(0);
        }

        history.push({
          role: "function",
          parts: toolResults.map((r) => ({
            functionResponse: { name: r.name, response: r.response },
          })),
        });
      }

      const endTime = Date.now();
      this.logTrace(endTime, "assistant", fullResponse);

      yield {
        type: "done",
        data: { iterations: iter, elapsed: endTime - startTime, response_length: fullResponse.length },
      };
    } catch (error) {
      const err = error as Error;
      yield { type: "error", data: { message: err.message, stack: err.stack } };
      this.logTrace(Date.now(), "error", err.message);
    }
  }

  // === HELPER METHODS (NO YIELD HERE) ========================================
  private getModel(): GenerativeModel {
    if (this.model) return this.model;

    const genAI = new GoogleGenerativeAI(this.env.GOOGLE_API_KEY);
    const gateway =
      this.env.CLOUDFLARE_ACCOUNT_ID && this.env.CLOUDFLARE_AI_GATEWAY_NAME
        ? `https://gateway.ai.cloudflare.com/v1/${this.env.CLOUDFLARE_ACCOUNT_ID}/${this.env.CLOUDFLARE_AI_GATEWAY_NAME}/google-ai-studio`
        : undefined;

    this.model = genAI.getGenerativeModel(
      {
        model: "gemini-2.0-flash-exp",
        systemInstruction:
          "You are Suna, an autonomous AI assistant with a persistent file system. " +
          "Use tools step by step. Call only ONE tool at a time.",
        tools: [
          {
            functionDeclarations: [
              {
                name: "read_file",
                description: "Read a file from the workspace",
                parameters: {
                  type: "OBJECT" as const,
                  properties: {
                    path: { type: "STRING" as const, description: "File path" },
                  },
                  required: ["path"],
                },
              },
              {
                name: "write_file",
                description: "Write or update a file",
                parameters: {
                  type: "OBJECT" as const,
                  properties: {
                    path: { type: "STRING" as const, description: "File path" },
                    content: { type: "STRING" as const, description: "File content" },
                  },
                  required: ["path", "content"],
                },
              },
              {
                name: "list_files",
                description: "List files in workspace",
                parameters: {
                  type: "OBJECT" as const,
                  properties: {
                    prefix: { type: "STRING" as const, description: "Path prefix filter" },
                  },
                },
              },
              {
                name: "delete_file",
                description: "Delete a file",
                parameters: {
                  type: "OBJECT" as const,
                  properties: {
                    path: { type: "STRING" as const, description: "File path" },
                  },
                  required: ["path"],
                },
              },
            ],
          },
          { googleSearch: {} },
          { codeExecution: {} },
        ],
      },
      gateway ? { baseUrl: gateway } : undefined
    );

    return this.model;
  }

  private async streamResponse(model: GenerativeModel, history: any[], prompt: string) {
    const chat = model.startChat({ history, generationConfig: { temperature: 0.3 } });
    const result = await chat.sendMessageStream(prompt);
    const chunks: string[] = [];

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) chunks.push(text);
    }

    const response = await result.response;
    return { response, chunks };
  }

  private async runTool(name: string, args: any) {
    const start = Date.now();
    try {
      const result = await this.executeTool(name, args);
      return {
        name,
        response: { success: true, result },
        execution_time_ms: Date.now() - start,
      };
    } catch (error) {
      const err = error as Error;
      return {
        name,
        response: { success: false, error: err.message },
        execution_time_ms: Date.now() - start,
      };
    }
  }

  private async executeTool(name: string, args: any): Promise<string> {
    switch (name) {
      case "read_file":
        return this.readFile(args.path);
      case "write_file":
        return this.writeFile(args.path, args.content);
      case "list_files":
        return this.listFiles(args.prefix);
      case "delete_file":
        return this.deleteFile(args.path);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  // === FILE OPERATIONS (NO YIELD) ============================================
  private readFile(path: string): string {
    const normalized = this.normalizePath(path);
    const row = this.sql.exec("SELECT content FROM files WHERE path = ?", normalized).one();
    if (!row) throw new Error(`File not found: ${normalized}`);
    return row.content as string;
  }

  private writeFile(path: string, content: string): string {
    const normalized = this.normalizePath(path);
    const now = Date.now();
    const existing = this.sql.exec("SELECT path FROM files WHERE path = ?", normalized).one();

    if (existing) {
      this.sql.exec("UPDATE files SET content = ?, updated_at = ? WHERE path = ?", content, now, normalized);
      return `Updated: ${normalized} (${content.length} bytes)`;
    } else {
      this.sql.exec(
        "INSERT INTO files (path, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
        normalized,
        content,
        now,
        now
      );
      return `Created: ${normalized} (${content.length} bytes)`;
    }
  }

  private listFiles(prefix?: string): string {
    const pattern = prefix ? `${this.normalizePath(prefix)}%` : "%";
    const rows = [...this.sql.exec("SELECT path, updated_at FROM files WHERE path LIKE ?", pattern)];

    if (rows.length === 0) {
      return prefix ? `No files with prefix: ${prefix}` : "No files in workspace";
    }

    return rows.map((r) => `${r.path} (${new Date(r.updated_at as number).toISOString()})`).join("\n");
  }

  private deleteFile(path: string): string {
    const normalized = this.normalizePath(path);
    const result = this.sql.exec("DELETE FROM files WHERE path = ?", normalized);
    if (result.changes === 0) throw new Error(`File not found: ${normalized}`);
    return `Deleted: ${normalized}`;
  }

  private normalizePath(path: string): string {
    return path.replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
  }

  // === PUBLIC METHODS (NO YIELD) =============================================
  async clear(): Promise<void> {
    this.sql.exec("DELETE FROM files; DELETE FROM agent_traces;");
  }

  async listAllFiles(): Promise<Array<{ path: string; size: number; updated_at: number }>> {
    const rows = [...this.sql.exec("SELECT path, length(content) as size, updated_at FROM files")];
    return rows.map((r) => ({
      path: r.path as string,
      size: r.size as number,
      updated_at: r.updated_at as number,
    }));
  }

  // === TRACE HELPERS (NO YIELD) ==============================================
  private logTrace(ts: number, type: string, payload: string): void {
    try {
      this.sql.exec(
        "INSERT INTO agent_traces (ts, type, payload) VALUES (?, ?, ?)",
        ts,
        type,
        payload.substring(0, 1000)
      );
    } catch (error) {
      console.error("Failed to log trace:", error);
    }
  }

  private cleanupOldTraces(): void {
    try {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      this.sql.exec("DELETE FROM agent_traces WHERE ts < ?", cutoff);
    } catch (error) {
      console.error("Failed to cleanup traces:", error);
    }
  }
}
