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

// NOTE: SqlStorage type is provided by Workers' Durable Object sqlite integration in your repo.
// If the name differs, adapt accordingly.
type SqlStorage = any;

export class AutonomousAgent extends DurableObject<Env> {
  private sql: SqlStorage;
  private gemini: GeminiClient;
  private maxHistoryMessages = 200; // keep history manageable for Workers (tweak as needed)

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    // Durable Object helpers available off this.ctx in your codebase (preserved behavior)
    // state.storage.sql used for SQLite
    this.sql = state.storage.sql;
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

  // JSON helpers
  private parse<T>(text: string): T | null {
    try {
      const trimmed = String(text || '').trim().replace(/^```json\s*/, '').replace(/```$/, '');
      if (!trimmed) return null;
      return JSON.parse(trimmed) as T;
    } catch (e) {
      console.error('JSON parse failed:', e, 'Raw:', text);
      return null;
    }
  }

  private stringify(obj: unknown): string {
    return JSON.stringify(obj);
  }

  // Load state (from kv table)
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
      // create default state
      state = {
        conversationHistory: [],
        context: { files: [], searchResults: [] },
        sessionId: (this.ctx?.id?.toString ? this.ctx.id.toString() : Date.now().toString()),
        lastActivityAt: Date.now(),
        currentPlan: undefined,
      } as AgentState;
    }
    return state;
  }

  // Save state (use blockConcurrencyWhile to avoid races)
  private async saveState(state: AgentState): Promise<void> {
    try {
      await this.ctx.blockConcurrencyWhile(async () => {
        this.sql.exec(
          `INSERT INTO kv (key, value) VALUES ('state', ?) 
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          this.stringify(state)
        );
      });
    } catch (e) {
      console.error('saveState failed:', e);
    }
  }

  // HTTP fetch handler
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      // WebSocket upgrade for realtime streaming
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // Accept on server side
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/api/chat' && request.method === 'POST') return this.handleChat(request);
    if (url.pathname === '/api/history' && request.method === 'GET') return this.getHistory();
    if (url.pathname === '/api/clear' && request.method === 'POST') return this.clearHistory();
    if (url.pathname === '/api/status' && request.method === 'GET') return this.getStatus();

    return new Response('Not found', { status: 404 });
  }

  // WebSocket message handler (Cloudflare DO auto-calls webSocketMessage)
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return;

    let payload: any;
    try {
      payload = JSON.parse(message);
    } catch {
      this.send(ws, { type: 'error', error: 'Invalid JSON' });
      return;
    }

    if (payload.type === 'user_message' && typeof payload.content === 'string') {
      // Process in background, notify on failures
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

  private send(ws: WebSocket, data: unknown) {
    try {
      ws.send(this.stringify(data));
    } catch (e) {
      console.error('WebSocket send failed:', e);
    }
  }

  // Top-level process: save user, analyze complexity, branch simple vs complex
  private async process(userMsg: string, ws: WebSocket | null) {
    // Load and update state
    let state = await this.loadState();
    state.lastActivityAt = Date.now();

    // Save user message to DB
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
      return;
    }

    // Trim history if too large (simple truncation)
    try {
      const count = this.sql.exec(`SELECT COUNT(1) as c FROM messages`).one()?.c ?? 0;
      if (count > this.maxHistoryMessages) {
        // delete oldest messages to keep last maxHistoryMessages
        const toDrop = count - this.maxHistoryMessages;
        try {
          this.sql.exec(
            `DELETE FROM messages WHERE id IN (SELECT id FROM messages ORDER BY timestamp ASC LIMIT ?)`,
            toDrop
          );
        } catch (e) {
          console.warn('History truncation failed:', e);
        }
      }
    } catch (e) {
      // ignore
    }

    // Analyze complexity using Gemini client
    let complexity: TaskComplexity;
    try {
      complexity = await this.gemini.analyzeComplexity(userMsg, (state.context?.files ?? []).length > 0);
    } catch (e) {
      console.error('Complexity analysis failed:', e);
      complexity = { type: 'simple', requiredTools: [], estimatedSteps: 1, reasoning: 'error' };
    }

    try {
      if (complexity.type === 'simple') {
        await this.handleSimple(userMsg, ws, state);
      } else {
        await this.handleComplex(userMsg, complexity, ws, state);
      }
    } catch (e) {
      console.error('Process error:', e);
      if (ws) this.send(ws, { type: 'error', error: 'Processing failed' });
    } finally {
      // persist state safely
      try {
        await this.saveState(state);
      } catch (e) {
        console.error('Final saveState failed:', e);
      }
    }
  }

  // Simple streaming path (no tools) — stable streaming
  private async handleSimple(query: string, ws: WebSocket | null, state: AgentState) {
    if (ws) this.send(ws, { type: 'status', message: 'Thinking…' });

    try {
      // Build history for the model
      const history = this.buildHistory();

      // streamResponse will call onChunk for each text fragment
      let full = '';
      await this.gemini.streamResponse(
        query,
        history,
        (chunk) => {
          full += chunk;
          if (ws) this.send(ws, { type: 'chunk', content: chunk });
        },
        { model: 'gemini-2.5-flash', thinkingConfig: { thinkingBudget: 512 } }
      );

      // Save model response to DB
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

      if (ws) {
        this.send(ws, { type: 'done' });
      }
    } catch (e) {
      console.error('handleSimple streaming failed:', e);
      if (ws) this.send(ws, { type: 'error', error: 'Streaming failed' });
    }
  }

  // Complex path: planning, per-step execution (streaming per step), synthesis
  private async handleComplex(query: string, complexity: TaskComplexity, ws: WebSocket | null, state: AgentState) {
    if (ws) this.send(ws, { type: 'status', message: 'Planning…' });

    // Generate plan using Gemini client (with thinking budget)
    let plan: ExecutionPlan;
    try {
      plan = await this.gemini.generatePlan(query, complexity, (state.context?.files ?? []).length > 0);
    } catch (e) {
      console.error('generatePlan failed:', e);
      plan = {
        steps: [{ id: 's1', description: 'Answer directly', action: 'synthesize', status: 'pending' }],
        currentStepIndex: 0,
        status: 'executing',
        createdAt: Date.now(),
      } as ExecutionPlan;
    }

    // attach to state and persist
    state.currentPlan = plan;
    try {
      await this.saveState(state);
    } catch (e) {
      console.error('saveState after plan failed:', e);
    }

    if (ws) this.send(ws, { type: 'plan', plan });

    // Execute steps sequentially
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i] as PlanStep;
      plan.currentStepIndex = i;

      if (ws) this.send(ws, { type: 'step_start', step: i + 1, description: step.description });

      try {
        step.status = 'executing';
        step.startedAt = Date.now();

        // Execute the step with streaming enabled so the user sees progress
        const result = await this.executeStep(step, state, (chunk) => {
          // forward each chunk to WS as step_chunk
          if (ws) this.send(ws, { type: 'step_chunk', step: i + 1, content: chunk });
        });

        step.result = result;
        step.status = 'completed';
        step.completedAt = Date.now();
        step.durationMs = (step.completedAt ?? Date.now()) - (step.startedAt ?? Date.now());

        // Persist step result to DB and state
        try {
          // Save model chunk as model message (append)
          this.sql.exec(
            `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
            'model',
            this.stringify([{ text: `Step ${i + 1} result: ${result}` }]),
            Date.now()
          );
        } catch (e) {
          console.error('Failed to save step model result:', e);
        }

        if (ws) this.send(ws, { type: 'step_complete', step: i + 1, result });
        await this.saveState(state);
      } catch (e) {
        console.error('Step execution failed:', e);
        step.status = 'failed';
        step.error = e instanceof Error ? e.message : String(e);
        if (ws) this.send(ws, { type: 'step_error', step: i + 1, error: step.error });
        await this.saveState(state);
        // Stop executing remaining steps after failure (you may adjust to continue)
        break;
      }
    }

    // After steps: synthesize final answer and stream to WS
    await this.synthesize(ws, state);

    // finalize plan
    plan.status = 'completed';
    plan.completedAt = Date.now();
    state.currentPlan = plan;

    try {
      await this.saveState(state);
    } catch (e) {
      console.error('saveState after completion failed:', e);
    }
  }

  // Execute individual plan step (streams progress via onChunk)
  private async executeStep(step: PlanStep, state: AgentState, onChunk?: (text: string) => void): Promise<string> {
    // Build a focused prompt using the step and previous completed results
    const prompt = this.buildPrompt(step, state);

    // Build history to provide to model (recent conversation)
    const history = this.buildHistory();

    // Setup execution config for action -> tools mapping
    const execConfig: ExecutionConfig = {
      model: 'gemini-2.5-flash',
      stream: true,
      timeoutMs: 120_000, // 2 minutes per step (tweak as appropriate)
      thinkingConfig: { thinkingBudget: 1024 },
      files: state.context?.files ?? [],
      urlList: state.context?.searchResults ? state.context.searchResults.map((r: any) => r.url).filter(Boolean) : [],
      // stepAction will tell GeminiClient to enable the correct tools
      // we store action name for automatic mapping
      // @ts-expect-error stepAction is dynamic extension to ExecutionConfig
      stepAction: step.action,
    } as unknown as ExecutionConfig;

    // Use gemini.executeWithConfig with streaming onChunk
    const result = await this.gemini.executeWithConfig(prompt, history, execConfig, (chunk) => {
      if (onChunk) onChunk(chunk);
    });

    return result;
  }

  // Build a prompt for a given step and completed steps in the plan
  private buildPrompt(step: PlanStep, state: AgentState): string {
    const plan = state.currentPlan!;
    const done = plan.steps
      .filter((s) => s.status === 'completed')
      .map((s) => `${s.description}: ${s.result ?? ''}`)
      .join('\n') || 'None';

    const prompt = `PLAN:
${plan.steps.map((s) => s.description).join(' -> ')}

DONE:
${done}

STEP:
${step.description}

ACTION:
${step.action}

Provide result only (concise):`;

    return prompt;
  }

  // Synthesize final answer after plan execution (streaming to ws)
  private async synthesize(ws: WebSocket | null, state: AgentState) {
    if (ws) this.send(ws, { type: 'status', message: 'Summarizing…' });

    const plan = state.currentPlan!;
    const lastUserRow = this.sql.exec(`SELECT parts FROM messages WHERE role='user' ORDER BY timestamp DESC LIMIT 1`).one();
    const lastUserPartsStr = lastUserRow?.parts as string | undefined;
    const original = lastUserPartsStr ? this.parse<any[]>(lastUserPartsStr)?.[0]?.text || '' : '';

    const prompt = `Request: ${original}

Results:
${plan.steps.map((s, i) => `Step ${i + 1}: ${s.result ?? ''}`).join('\n\n')}

Concise answer:`;

    try {
      // Use streaming to send synthesis in chunks to WS
      let full = '';
      await this.gemini.executeWithConfig(
        prompt,
        this.buildHistory(),
        {
          model: 'gemini-2.5-flash',
          stream: true,
          timeoutMs: 120_000,
          thinkingConfig: { thinkingBudget: 1536 },
        } as unknown as ExecutionConfig,
        (chunk) => {
          full += chunk;
          if (ws) this.send(ws, { type: 'final_chunk', content: chunk });
        }
      );

      // Save final answer to messages table
      try {
        this.sql.exec(
          `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
          'model',
          this.stringify([{ text: full }]),
          Date.now()
        );
      } catch (e) {
        console.error('Failed to save final model response:', e);
      }

      if (ws) {
        this.send(ws, { type: 'final_response', content: full });
        this.send(ws, { type: 'done' });
      }
    } catch (e) {
      console.error('Synthesis failed:', e);
      if (ws) this.send(ws, { type: 'error', error: 'Synthesis failed' });
    }
  }

  // Build history from messages table - returns array of { role, parts }
  private buildHistory(): Array<{ role: string; parts: Array<{ text: string }> }> {
    const rows = this.sql.exec(`SELECT role, parts FROM messages ORDER BY timestamp ASC`);
    const hist: Array<{ role: string; parts: Array<{ text: string }> }> = [];
    try {
      for (const r of rows) {
        const parts = this.parse<any[]>(r.parts as string);
        if (parts) {
          hist.push({
            role: r.role === 'model' ? 'model' : 'user',
            parts,
          });
        }
      }
    } catch (e) {
      console.error('buildHistory parse error:', e);
    }

    // Avoid consecutive duplicate user entries
    while (hist.length > 1 && hist[hist.length - 1].role === 'user' && hist[hist.length - 2].role === 'user') {
      hist.pop();
    }

    return hist;
  }

  // HTTP handler: enqueue message (background processing)
  private async handleChat(req: Request): Promise<Response> {
    let message: string;
    try {
      const body = await req.json<{ message: string }>();
      message = body.message;
      if (!message) throw new Error('Missing message');
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
    }

    // Process asynchronously (Durable Object will keep running)
    this.ctx.waitUntil(
      this.process(message, null).catch((err) => {
        console.error('Background process failed:', err);
      })
    );

    return new Response(JSON.stringify({ status: 'queued' }), { headers: { 'Content-Type': 'application/json' } });
  }

  // Return conversation history (simple JSON)
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

  // Clear DB tables and state
  private async clearHistory(): Promise<Response> {
    try {
      this.sql.exec('DELETE FROM messages');
      this.sql.exec('DELETE FROM kv');
      this.sql.exec('DELETE FROM sqlite_sequence WHERE name IN ("messages")');
    } catch (e) {
      console.error('Clear failed:', e);
    }
    return new Response(this.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  // Return status: current plan and last activity
  private getStatus(): Response {
    let state: AgentState | null = null;
    try {
      const row = this.sql.exec(`SELECT value FROM kv WHERE key='state'`).one();
      state = row ? this.parse<AgentState>(row.value as string) : null;
    } catch (e) {
      console.error('getStatus read failed:', e);
    }

    return new Response(this.stringify({
      plan: state?.currentPlan,
      lastActivity: state?.lastActivityAt,
    }), { headers: { 'Content-Type': 'application/json' } });
  }
}

export default AutonomousAgent;
