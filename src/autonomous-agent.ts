// src/autonomous-agent.ts - Unified Autonomous Agent
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

interface SqlStorage {
  exec(query: string, ...params: any[]): {
    one(): any;
    toArray(): any[];
    [Symbol.iterator](): Iterator<any>;
  };
}

interface StepExecutionOptions {
  continueOnFailure?: boolean;
  maxRetries?: number;
  parallelExecution?: boolean;
}

interface Metrics {
  requestCount: number;
  errorCount: number;
  avgResponseTime: number;
  activeConnections: number;
  totalResponseTime: number;
}

export class AutonomousAgent extends DurableObject<Env> {
  private sql: SqlStorage;
  private gemini: GeminiClient;
  private maxHistoryMessages = 200;
  private readonly MAX_MESSAGE_SIZE = 100_000;
  private readonly MAX_TOTAL_HISTORY_SIZE = 500_000;
  private readonly COMPLEXITY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private activeWebSockets = new Set<WebSocket>();
  private metrics: Metrics = {
    requestCount: 0,
    errorCount: 0,
    avgResponseTime: 0,
    activeConnections: 0,
    totalResponseTime: 0,
  };

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

  // ===== Utility Methods =====

  private parse<T>(text: string): T | null {
    try {
      const trimmed = String(text || '').trim().replace(/^```json\s*/, '').replace(/```$/, '');
      if (!trimmed) return null;
      return JSON.parse(trimmed) as T;
    } catch (e) {
      console.error('JSON parse failed:', e);
      return null;
    }
  }

  private stringify(obj: unknown): string {
    return JSON.stringify(obj);
  }

  private async withErrorContext<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      error.message = `[${operation}] ${error.message}`;
      throw error;
    }
  }

  private trackRequest<T>(fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    this.metrics.requestCount++;

    return fn()
      .then((result) => {
        const duration = Date.now() - start;
        this.metrics.totalResponseTime += duration;
        this.metrics.avgResponseTime = this.metrics.totalResponseTime / this.metrics.requestCount;
        return result;
      })
      .catch((e) => {
        this.metrics.errorCount++;
        throw e;
      });
  }

  // ===== Unified Autonomous Agent Methods =====

  private buildUnifiedContext(state: AgentState): {
    conversationHistory: Array<{ role: string; parts: any[] }>;
    availableTools: string[];
    files: FileMetadata[];
    urlList: string[];
  } {
    const conversationHistory = this.buildHistory();
    const availableTools = this.determineAvailableTools(state);
    const files = state.context?.files ?? [];
    const urlList = state.context?.searchResults?.map(r => r.url).filter(Boolean) ?? [];

    return {
      conversationHistory,
      availableTools,
      files,
      urlList,
    };
  }

  private determineAvailableTools(state: AgentState): string[] {
    const tools: string[] = [];

    // Always available native tools
    tools.push('thinking', 'search_grounding', 'url_context', 'code_execution');

    // Add external tools based on context
    if (state.context?.files && state.context.files.length > 0) {
      tools.push('file_analysis');

      // Add vision if any files are images
      if (state.context.files.some(f => f.mimeType.startsWith('image/'))) {
        tools.push('vision');
      }
    }

    if (state.context?.searchResults && state.context.searchResults.length > 0) {
      tools.push('url_context');
    }

    return tools;
  }

  private async processAutonomous(
    userMsg: string,
    ws: WebSocket | null,
    state: AgentState
  ): Promise<void> {
    return this.withErrorContext('processAutonomous', async () => {
      // Reset phase for new request
      state.currentPhase = AgentPhase.ASSESSMENT;

      const context = this.buildUnifiedContext(state);

      // Execute unified autonomous process
      const result = await this.gemini.executeUnifiedAutonomous(
        {
          userRequest: userMsg,
          currentPhase: state.currentPhase,
          conversationHistory: context.conversationHistory,
          availableTools: context.availableTools,
          files: context.files,
          urlList: context.urlList,
        },
        (chunk) => {
          // Stream chunks to WebSocket
          if (ws) {
            const batcher = this.createChunkBatcher(ws, 'chunk');
            batcher.add(chunk);
            batcher.flush();
          }
        }
      );

      // Handle phase changes
      if (result.phaseChanges) {
        for (const phase of result.phaseChanges) {
          state.currentPhase = phase;
          if (ws) {
            this.send(ws, {
              type: 'phase_change',
              phase,
              message: `Transitioning to ${phase} phase`,
            });
          }
        }
      }

      // Handle clarification requests
      if (result.clarificationRequests && result.clarificationRequests.length > 0) {
        state.currentPhase = AgentPhase.CLARIFICATION;
        state.clarificationContext = result.clarificationRequests[0];

        if (ws) {
          this.send(ws, {
            type: 'clarification_request',
            clarificationQuestion: result.clarificationRequests[0],
          });
        }
      }

      // Handle tool calls
      if (result.toolCalls) {
        for (const toolCall of result.toolCalls) {
          if (ws) {
            this.send(ws, {
              type: 'tool_call',
              toolCall,
            });
          }
        }
      }

      // Save the autonomous response
      try {
        this.sql.exec(
          `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
          'model',
          this.stringify([{ text: result.response }]),
          Date.now()
        );
      } catch (e) {
        console.error('Failed to save autonomous response:', e);
      }

      // Set completion phase and send final response
      state.currentPhase = AgentPhase.COMPLETION;
      if (ws) {
        this.send(ws, {
          type: 'final_response',
          content: result.response,
        });
        this.send(ws, { type: 'done' });
      }
    });
  }

  // ===== State Management =====

  private async loadState(): Promise<AgentState> {
    let state: AgentState | null = null;
    try {
      const row = this.sql.exec(`SELECT value FROM kv WHERE key = 'state'`).one();
      if (row && typeof row.value === 'string') {
        state = this.parse<AgentState>(row.value);
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
        // Initialize autonomous behavior fields
        currentMode: AutonomousMode.CHAT,
        currentPhase: AgentPhase.ASSESSMENT,
        clarificationContext: undefined,
        executionContext: undefined,
      } as AgentState;
    }

    // Ensure new fields exist for existing state
    if (!state.currentMode) state.currentMode = AutonomousMode.CHAT;
    if (!state.currentPhase) state.currentPhase = AgentPhase.ASSESSMENT;

    await this.checkMemoryPressure();
    return state;
  }

  private async saveState(state: AgentState): Promise<void> {
    try {
      const stateStr = this.stringify(state);
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

  // ===== Memory Management =====

  private estimateHistorySize(): number {
    try {
      const result = this.sql.exec(`SELECT SUM(LENGTH(parts)) as total FROM messages`).one();
      return result?.total ?? 0;
    } catch (e) {
      console.warn('Failed to estimate history size:', e);
      return 0;
    }
  }

  private async checkMemoryPressure(): Promise<void> {
    const historySize = this.estimateHistorySize();
    if (historySize > this.MAX_TOTAL_HISTORY_SIZE) {
      console.warn(`History size ${historySize} exceeds limit, trimming`);
      await this.trimHistoryIfNeeded();
    }
  }

  private async trimHistoryIfNeeded(): Promise<void> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const count = this.sql.exec(`SELECT COUNT(1) as c FROM messages`).one()?.c ?? 0;
        if (count > this.maxHistoryMessages) {
          const toKeep = this.maxHistoryMessages;
          this.sql.exec(
            `DELETE FROM messages 
             WHERE id NOT IN (
               SELECT id FROM messages 
               ORDER BY timestamp DESC 
               LIMIT ?
             )`,
            toKeep
          );
          console.log(`Trimmed history: kept ${toKeep} messages`);
        }
      } catch (e) {
        console.error('History truncation failed:', e);
      }
    });
  }

  // ===== WebSocket Management =====

  private send(ws: WebSocket | null, data: unknown): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(this.stringify(data));
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
      this.metrics.activeConnections = this.activeWebSockets.size;
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/api/chat' && request.method === 'POST') return this.handleChat(request);
    if (url.pathname === '/api/history' && request.method === 'GET') return this.getHistory();
    if (url.pathname === '/api/clear' && request.method === 'POST') return this.clearHistory();
    if (url.pathname === '/api/status' && request.method === 'GET') return this.getStatus();
    if (url.pathname === '/api/metrics' && request.method === 'GET') return this.getMetrics();

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
        this.trackRequest(() => this.process(payload.content, ws)).catch((err) => {
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
    this.metrics.activeConnections = this.activeWebSockets.size;
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('WebSocket error:', error);
    this.activeWebSockets.delete(ws);
    this.metrics.activeConnections = this.activeWebSockets.size;
  }

  // ===== Core Processing Logic =====

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
          this.stringify([{ text: userMsg }]),
          Date.now()
        );
      } catch (e) {
        console.error('Failed to save user message:', e);
        if (ws) this.send(ws, { type: 'error', error: 'Save failed' });
        throw e;
      }

      // Unified autonomous processing - no more complexity analysis branching
      console.log(`[Autonomous] Processing with unified approach`);

      try {
        await this.processAutonomous(userMsg, ws, state);
      } catch (e) {
        console.error('Process error:', e);
        if (ws) this.send(ws, { type: 'error', error: 'Processing failed' });
        throw e;
      }
    });
  }

  // ===== Obsolete methods removed - now using unified autonomous processing =====

  // ===== History Building =====

  private buildHistory(): Array<{ role: string; parts: Array<{ text: string }> }> {
    return this.ctx.blockConcurrencyWhile(() => {
      const rows = this.sql
        .exec(
          `SELECT role, parts FROM messages ORDER BY timestamp DESC LIMIT ?`,
          Math.min(this.maxHistoryMessages, 50) // Limit context window
        )
        .toArray();

      const hist: Array<{ role: string; parts: Array<{ text: string }> }> = [];

      for (const r of rows.reverse()) {
        const parts = this.parse<any[]>(r.parts as string);
        if (parts) {
          hist.push({
            role: r.role === 'model' ? 'model' : 'user',
            parts,
          });
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
      this.trackRequest(() => this.process(message, null)).catch((err) => {
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
      const parts = this.parse<any[]>(r.parts as string);
      if (parts) {
        msgs.push({
          role: r.role as any,
          parts,
          timestamp: r.timestamp as number,
        });
      }
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
        this.sql.exec('DELETE FROM sqlite_sequence WHERE name IN ("messages")');
      } catch (e) {
        console.error('Clear failed:', e);
      }
      return new Response(this.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }

  private getStatus(): Response {
    let state: AgentState | null = null;
    try {
      const row = this.sql.exec(`SELECT value FROM kv WHERE key='state'`).one();
      state = row ? this.parse<AgentState>(row.value as string) : null;
    } catch (e) {
      console.error('getStatus read failed:', e);
    }

    return new Response(
      this.stringify({
        currentMode: state?.currentMode,
        currentPhase: state?.currentPhase,
        lastActivity: state?.lastActivityAt,
        sessionId: state?.sessionId,
        executionContext: state?.executionContext,
        clarificationContext: state?.clarificationContext,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  private getMetrics(): Response {
    return new Response(this.stringify({
      ...this.metrics,
      circuitBreaker: this.gemini.getCircuitBreakerStatus(),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export default AutonomousAgent;
