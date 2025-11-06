// src/autonomous-agent.ts
import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import GeminiClient from './utils/gemini';
import type {
  Env,
  AgentState,
  Message,
  ExecutionPlan,
  PlanStep,
  TaskComplexity,
  FileMetadata,
} from './types';

// SQLite storage interface
interface SqlStorage {
  exec(query: string, ...params: any[]): {
    one(): any;
    toArray(): any[];
    [Symbol.iterator](): Iterator<any>;
  };
  prepare?(query: string): {
    run(...params: any[]): void;
    one(...params: any[]): any;
    all(...params: any[]): any[];
  };
}

interface StepExecutionOptions {
  continueOnFailure?: boolean;
  maxRetries?: number;
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
  private readonly MAX_MESSAGE_SIZE = 100_000; // chars
  private readonly MAX_TOTAL_HISTORY_SIZE = 500_000; // chars
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

    // Initialize SQLite tables if not present
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

  // ===== State Management with Transaction Support =====

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
        currentPlan: undefined,
      } as AgentState;
    }

    // Check memory pressure
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

      // Validate message size
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

      // Analyze complexity
      let complexity: TaskComplexity;
      try {
        complexity = await this.gemini.analyzeComplexity(
          userMsg,
          (state.context?.files ?? []).length > 0
        );
      } catch (e) {
        console.error('Complexity analysis failed:', e);
        complexity = {
          type: 'simple',
          requiredTools: [],
          estimatedSteps: 1,
          reasoning: 'fallback due to analysis error',
          requiresFiles: false,
          requiresCode: false,
          requiresVision: false,
        };
      }

      // Route based on complexity
      try {
        if (complexity.type === 'simple') {
          await this.handleSimple(userMsg, ws, state);
        } else {
          await this.handleComplex(userMsg, complexity, ws, state, {
            continueOnFailure: false,
            maxRetries: 2,
          });
        }
      } catch (e) {
        console.error('Process error:', e);
        if (ws) this.send(ws, { type: 'error', error: 'Processing failed' });
        throw e;
      }
    });
  }

  // ===== Simple Path =====

  private async handleSimple(query: string, ws: WebSocket | null, state: AgentState): Promise<void> {
    return this.withErrorContext('handleSimple', async () => {
      if (ws) this.send(ws, { type: 'status', message: 'Thinking…' });

      const history = this.buildHistory();
      const batcher = this.createChunkBatcher(ws, 'chunk');

      let full = '';
      await this.gemini.streamResponse(
        query,
        history,
        (chunk) => {
          full += chunk;
          batcher.add(chunk);
        },
        { model: 'gemini-2.5-flash', thinkingConfig: { thinkingBudget: 512 } }
      );

      batcher.flush();

      // Save model response
      try {
        this.sql.exec(
          `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
          'model',
          this.stringify([{ text: full }]),
          Date.now()
        );
      } catch (e) {
        console.error('Failed to save model response:', e);
      }

      if (ws) this.send(ws, { type: 'done' });
    });
  }

  // ===== Complex Path =====

  private async handleComplex(
    query: string,
    complexity: TaskComplexity,
    ws: WebSocket | null,
    state: AgentState,
    opts: StepExecutionOptions = { continueOnFailure: false, maxRetries: 1 }
  ): Promise<void> {
    return this.withErrorContext('handleComplex', async () => {
      if (ws) this.send(ws, { type: 'status', message: 'Planning…' });

      // Generate plan
      let plan: ExecutionPlan;
      try {
        plan = await this.gemini.generatePlan(
          query,
          complexity,
          (state.context?.files ?? []).length > 0
        );
      } catch (e) {
        console.error('generatePlan failed:', e);
        plan = {
          steps: [{ id: 's1', description: 'Answer directly', action: 'synthesize', status: 'pending' }],
          currentStepIndex: 0,
          status: 'executing',
          createdAt: Date.now(),
        } as ExecutionPlan;
      }

      state.currentPlan = plan;
      if (ws) this.send(ws, { type: 'plan', plan });

      // Execute steps with retry logic
      for (let i = 0; i < plan.steps.length; i++) {
        const step = plan.steps[i] as PlanStep;
        plan.currentStepIndex = i;

        if (ws) this.send(ws, { type: 'step_start', step: i + 1, description: step.description });

        let attempts = 0;
        let lastError: Error | null = null;
        let success = false;

        while (attempts < opts.maxRetries && !success) {
          try {
            step.status = 'executing';
            step.startedAt = Date.now();

            const batcher = this.createChunkBatcher(ws, 'step_chunk');
            const result = await this.executeStep(step, state, (chunk) => {
              batcher.add(chunk);
            });
            batcher.flush();

            step.result = result;
            step.status = 'completed';
            step.completedAt = Date.now();
            step.durationMs = (step.completedAt ?? Date.now()) - (step.startedAt ?? Date.now());

            // Save step result
            try {
              this.sql.exec(
                `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
                'model',
                this.stringify([{ text: `Step ${i + 1}: ${result}` }]),
                Date.now()
              );
            } catch (e) {
              console.error('Failed to save step result:', e);
            }

            if (ws) this.send(ws, { type: 'step_complete', step: i + 1, result });
            success = true;
          } catch (e) {
            lastError = e as Error;
            attempts++;
            console.error(`Step ${i + 1} attempt ${attempts} failed:`, e);

            if (attempts < opts.maxRetries) {
              const backoffMs = 1000 * attempts;
              await new Promise((r) => setTimeout(r, backoffMs));
            }
          }
        }

        if (!success && lastError) {
          step.status = 'failed';
          step.error = lastError.message;
          if (ws) this.send(ws, { type: 'step_error', step: i + 1, error: step.error });

          if (!opts.continueOnFailure) {
            break;
          }
        }
      }

      // Synthesize final answer
      await this.synthesize(ws, state);

      plan.status = 'completed';
      plan.completedAt = Date.now();
      state.currentPlan = plan;
    });
  }

  // ===== Step Execution =====

  private async executeStep(
    step: PlanStep,
    state: AgentState,
    onChunk?: (text: string) => void
  ): Promise<string> {
    return this.withErrorContext(`executeStep(${step.id})`, async () => {
      const prompt = this.buildPrompt(step, state);
      const history = this.buildHistory();

      const hasFiles = (state.context?.files ?? []).length > 0;
      const hasUrls = (state.context?.searchResults ?? []).length > 0;

      const result = await this.gemini.executeWithConfig(
        prompt,
        history,
        {
          model: 'gemini-2.5-flash',
          stream: true,
          timeoutMs: 120_000,
          thinkingConfig: { thinkingBudget: 1024 },
          files: state.context?.files ?? [],
          urlList: hasUrls
            ? state.context.searchResults.map((r: any) => r.url).filter(Boolean)
            : [],
          stepAction: step.action,
        },
        onChunk
      );

      return result;
    });
  }

  private buildPrompt(step: PlanStep, state: AgentState): string {
    const plan = state.currentPlan!;
    const done = plan.steps
      .filter((s) => s.status === 'completed')
      .map((s) => `${s.description}: ${s.result ?? 'completed'}`)
      .join('\n');

    return `EXECUTION PLAN:
${plan.steps.map((s, i) => `${i + 1}. ${s.description}`).join('\n')}

COMPLETED STEPS:
${done || 'None yet'}

CURRENT STEP:
${step.description}

ACTION TYPE:
${step.action}

Provide a concise result for this step only:`;
  }

  // ===== Synthesis =====

  private async synthesize(ws: WebSocket | null, state: AgentState): Promise<void> {
    return this.withErrorContext('synthesize', async () => {
      if (ws) this.send(ws, { type: 'status', message: 'Summarizing…' });

      const plan = state.currentPlan!;
      const lastUserRow = this.sql
        .exec(`SELECT parts FROM messages WHERE role='user' ORDER BY timestamp DESC LIMIT 1`)
        .one();
      const lastUserPartsStr = lastUserRow?.parts as string | undefined;
      const original = lastUserPartsStr ? this.parse<any[]>(lastUserPartsStr)?.[0]?.text || '' : '';

      const prompt = `Original Request: ${original}

Execution Results:
${plan.steps.map((s, i) => `Step ${i + 1} (${s.description}): ${s.result ?? 'no result'}`).join('\n\n')}

Task: Provide a comprehensive, well-structured answer that directly addresses the original request based on the execution results above.`;

      const batcher = this.createChunkBatcher(ws, 'final_chunk');
      let full = '';

      await this.gemini.streamResponse(
        prompt,
        this.buildHistory(),
        (chunk) => {
          full += chunk;
          batcher.add(chunk);
        },
        { model: 'gemini-2.5-flash', thinkingConfig: { thinkingBudget: 1536 } }
      );

      batcher.flush();

      // Save final answer
      try {
        this.sql.exec(
          `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
          'model',
          this.stringify([{ text: full }]),
          Date.now()
        );
      } catch (e) {
        console.error('Failed to save final response:', e);
      }

      if (ws) {
        this.send(ws, { type: 'final_response', content: full });
        this.send(ws, { type: 'done' });
      }
    });
  }

  // ===== History Building =====

  private buildHistory(): Array<{ role: string; parts: Array<{ text: string }> }> {
    return this.ctx.blockConcurrencyWhile(() => {
      const rows = this.sql
        .exec(
          `SELECT role, parts FROM messages ORDER BY timestamp DESC LIMIT ?`,
          this.maxHistoryMessages
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

      // Remove consecutive duplicate user entries
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
        plan: state?.currentPlan,
        lastActivity: state?.lastActivityAt,
        sessionId: state?.sessionId,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  private getMetrics(): Response {
    return new Response(this.stringify(this.metrics), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export default AutonomousAgent;
