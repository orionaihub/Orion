/**
 * Suna-like Autonomous Agent – Cloudflare Workers Free Tier
 *  - Sequential tool execution (one at a time)
 *  - Respects 10ms CPU wall time by yielding to event loop
 *  - Persistent workspace via Durable Object SQLite
 *  - Gemini 2.0 Flash with native search & code execution
 *  - Proper error handling & streaming
 *  - 30s wall-clock timeout for free tier
 */

import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";

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

    // API routes
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

    // Let Cloudflare serve static assets from /public directory
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

// ---------- HELPERS ---------------------------------------------------------
function getSessionId(req: Request): string | null {
  const c = req.headers.get("Cookie");
  if (!c) return null;
  const m = c.match(/session_id=([^;]+)/);
  return m ? m[1] : null;
}

// Helper to yield control back to event loop (respects 10ms CPU limit)
async function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------- TYPES -----------------------------------------------------------
interface StreamEvent {
  type: string;
  data?: any;
}

interface ConversationPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, any> };
  functionResponse?: { name: string; response: any };
}

interface HistoryItem {
  role: "user" | "model" | "function";
  parts: ConversationPart[];
}

// ---------- DURABLE OBJECT ---------------------------------------------------
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
    // Auto-cleanup old traces on startup
    this.cleanupOldTraces();
  }

  // ======  PUBLIC API  ========================================================
  async *fetchAgentStream(userPrompt: string): AsyncGenerator<StreamEvent> {
    const startTime = Date.now();
    const maxIter = 15;
    const wallClockTimeout = 28_000; // 28s wall-clock (leave 2s buffer)

    yield { type: "start", data: { ts: startTime, prompt: userPrompt } };
    this.logTrace(startTime, "user", userPrompt);

    try {
      const model = this.getModel();
      const history: HistoryItem[] = [];
      let iter = 0;
      let fullResponse = "";

      while (iter < maxIter) {
        iter++;
        yield { type: "iteration", data: { iteration: iter } };

        // Check wall-clock timeout
        if (Date.now() - startTime > wallClockTimeout) {
          yield {
            type: "warning",
            data: { reason: "Approaching 30s wall-clock timeout", elapsed: Date.now() - startTime },
          };
          break;
        }

        // Yield to event loop before heavy computation (respects 10ms CPU limit)
        await yieldToEventLoop();

        // Send message (first iteration uses user prompt, subsequent use empty to continue)
        const prompt = iter === 1 ? userPrompt : "";
        const { response, chunks } = await this.streamWithChunks(model, history, prompt);

        // Yield response chunks (stream already yields to event loop naturally)
        for (const chunk of chunks) {
          yield { type: "response_chunk", data: { text: chunk } };
          fullResponse += chunk;
        }

        // Yield to event loop after streaming
        await yieldToEventLoop();

        // Check for function calls
        const functionCalls = response.functionCalls();
        
        if (!functionCalls || functionCalls.length === 0) {
          // No more function calls - conversation complete
          yield { type: "complete", data: { final_response: fullResponse } };
          break;
        }

        // Add model's function call to history
        history.push({
          role: "model",
          parts: functionCalls.map((fc) => ({
            functionCall: { name: fc.name, args: fc.args },
          })),
        });

        // Execute function calls sequentially (one at a time)
        const toolResults: Array<{ name: string; response: any; execution_time_ms: number }> = [];

        for (const fc of functionCalls) {
          yield {
            type: "function_call",
            data: { name: fc.name, args: fc.args },
          };

          // Yield to event loop before tool execution
          await yieldToEventLoop();

          const toolStart = Date.now();
          try {
            const result = await this.executeTool(fc.name, fc.args);
            const toolResult = {
              name: fc.name,
              response: { success: true, result },
              execution_time_ms: Date.now() - toolStart,
            };
            toolResults.push(toolResult);

            yield {
              type: "function_result",
              data: toolResult,
            };
          } catch (error) {
            const err = error as Error;
            const toolResult = {
              name: fc.name,
              response: { success: false, error: err.message },
              execution_time_ms: Date.now() - toolStart,
            };
            toolResults.push(toolResult);

            yield {
              type: "function_result",
              data: toolResult,
            };
          }

          // Yield to event loop after each tool execution
          await yieldToEventLoop();
        }

        // Add function responses to history
        history.push({
          role: "function",
          parts: toolResults.map((result) => ({
            functionResponse: {
              name: result.name,
              response: result.response,
            },
          })),
        });
      }

      const endTime = Date.now();
      this.logTrace(endTime, "assistant", fullResponse);

      yield {
        type: "done",
        data: {
          iterations: iter,
          elapsed: endTime - startTime,
          response_length: fullResponse.length,
        },
      };
    } catch (error) {
      const err = error as Error;
      yield {
        type: "error",
        data: { message: err.message, stack: err.stack },
      };
      this.logTrace(Date.now(), "error", err.message);
    }
  }

  // ======  GEMINI INTEGRATION  ===============================================
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
          "You are Suna, an autonomous AI assistant. You have access to a persistent file system and can use tools to help accomplish user goals. " +
          "When working with files, always use absolute paths or paths relative to the current directory. " +
          "Use the available tools step by step to complete tasks efficiently. " +
          "Call only ONE tool at a time - do not make parallel function calls.",
        tools: [
          {
            functionDeclarations: [
              {
                name: "read_file",
                description: "Read the contents of a file from the persistent workspace",
                parameters: {
                  type: "OBJECT" as const,
                  properties: {
                    path: {
                      type: "STRING" as const,
                      description: "The path to the file to read",
                    },
                  },
                  required: ["path"],
                },
              },
              {
                name: "write_file",
                description: "Write or update a file in the persistent workspace",
                parameters: {
                  type: "OBJECT" as const,
                  properties: {
                    path: {
                      type: "STRING" as const,
                      description: "The path where the file should be written",
                    },
                    content: {
                      type: "STRING" as const,
                      description: "The content to write to the file",
                    },
                  },
                  required: ["path", "content"],
                },
              },
              {
                name: "list_files",
                description: "List all files in the workspace, optionally filtered by path prefix",
                parameters: {
                  type: "OBJECT" as const,
                  properties: {
                    prefix: {
                      type: "STRING" as const,
                      description: "Optional path prefix to filter files (e.g., 'src/' to list files in src directory)",
                    },
                  },
                },
              },
              {
                name: "delete_file",
                description: "Delete a file from the workspace",
                parameters: {
                  type: "OBJECT" as const,
                  properties: {
                    path: {
                      type: "STRING" as const,
                      description: "The path to the file to delete",
                    },
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

  private async streamWithChunks(
    model: GenerativeModel,
    history: HistoryItem[],
    prompt: string
  ): Promise<{ response: any; chunks: string[] }> {
    const chat = model.startChat({
      history,
      generationConfig: { temperature: 0.3 },
    });

    // sendMessageStream is async and yields naturally to event loop
    const result = await chat.sendMessageStream(prompt);
    const chunks: string[] = [];

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        chunks.push(text);
      }
      // Async iteration naturally yields to event loop
    }

    const response = await result.response;
    return { response, chunks };
  }

  // ======  TOOL EXECUTION  ===================================================
  private async executeTool(name: string, args: Record<string, any>): Promise<string> {
    // Tool execution is I/O bound (SQL queries), naturally yields to event loop
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

  // ======  FILE SYSTEM OPERATIONS  ===========================================
  private readFile(path: string): string {
    const normalized = this.normalizePath(path);
    // SQL exec is synchronous but fast (<1ms typically)
    const row = this.sql.exec("SELECT content FROM files WHERE path = ?", normalized).one();
    if (!row) {
      throw new Error(`File not found: ${normalized}`);
    }
    return row.content as string;
  }

  private writeFile(path: string, content: string): string {
    const normalized = this.normalizePath(path);
    const now = Date.now();
    // Check if file exists (fast query)
    const existing = this.sql.exec("SELECT path FROM files WHERE path = ?", normalized).one();

    if (existing) {
      this.sql.exec(
        "UPDATE files SET content = ?, updated_at = ? WHERE path = ?",
        content,
        now,
        normalized
      );
      return `Updated file: ${normalized} (${content.length} bytes)`;
    } else {
      this.sql.exec(
        "INSERT INTO files (path, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
        normalized,
        content,
        now,
        now
      );
      return `Created file: ${normalized} (${content.length} bytes)`;
    }
  }

  private listFiles(prefix?: string): string {
    const pattern = prefix ? `${this.normalizePath(prefix)}%` : "%";
    // SQL query is fast, results are small (just filenames)
    const rows = [...this.sql.exec("SELECT path, updated_at FROM files WHERE path LIKE ?", pattern)];

    if (rows.length === 0) {
      return prefix ? `No files found with prefix: ${prefix}` : "No files in workspace";
    }

    const files = rows.map((r) => {
      const date = new Date(r.updated_at as number).toISOString();
      return `${r.path} (modified: ${date})`;
    });

    return files.join("\n");
  }

  private deleteFile(path: string): string {
    const normalized = this.normalizePath(path);
    const result = this.sql.exec("DELETE FROM files WHERE path = ?", normalized);

    if (result.changes === 0) {
      throw new Error(`File not found: ${normalized}`);
    }

    return `Deleted file: ${normalized}`;
  }

  private normalizePath(path: string): string {
    // Simple string operation, <1ms
    return path.replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
  }

  // ======  SESSION MANAGEMENT  ===============================================
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

  // ======  TRACE MANAGEMENT  =================================================
  private logTrace(ts: number, type: string, payload: string): void {
    try {
      // Fast insert, payload limited to 1000 chars
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
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
      // Fast DELETE with index
      this.sql.exec("DELETE FROM agent_traces WHERE ts < ?", cutoff);
    } catch (error) {
      console.error("Failed to cleanup traces:", error);
    }
  }
}
