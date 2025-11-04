// src/autonomous-agent.ts
import { DurableObject } from 'cloudflare:workers';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type {
  Env,
  AgentState,
  Message,
  ExecutionPlan,
  PlanStep,
  TaskComplexity,
} from './types';

export class AutonomousAgent extends DurableObject<Env> {
  private sql: SqlStorage;
  private genAI: GoogleGenerativeAI;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    this.genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

    // Tables: history + state
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
  }

  // -----------------------------------------------------------------
  // JSON helpers
  // -----------------------------------------------------------------
  private parse<T>(text: string): T {
    const trimmed = text.trim().replace(/^```json\s*/, '').replace(/```$/, '');
    return JSON.parse(trimmed) as T;
  }
  private stringify(obj: unknown): string {
    return JSON.stringify(obj);
  }

  // -----------------------------------------------------------------
  // Load state – returns defaults if missing (NO save here!)
  // -----------------------------------------------------------------
  private async loadState(): Promise<AgentState> {
    const row = this.sql.exec(`SELECT value FROM kv WHERE key = 'state'`).one();
    if (row) {
      try {
        return this.parse<AgentState>(row.value as string);
      } catch (e) {
        console.error('Corrupted state:', e);
      }
    }
    return {
      conversationHistory: [],
      context: { files: [], searchResults: [] },
      sessionId: this.ctx.id.toString(),
      lastActivityAt: Date.now(),
      currentPlan: undefined,
    };
  }

  // -----------------------------------------------------------------
  // Save state – called only at the end
  // -----------------------------------------------------------------
  private async saveState(state: AgentState): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(
        `INSERT INTO kv (key, value) VALUES ('state', ?) 
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        this.stringify(state)
      );
    });
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

    if (url.pathname === '/api/chat' && request.method === 'POST') return this.handleChat(request);
    if (url.pathname === '/api/history' && request.method === 'GET') return this.getHistory();
    if (url.pathname === '/api/clear' && request.method === 'POST') return this.clearHistory();
    if (url.pathname === '/api/status' && request.method === 'GET') return this.getStatus();

    return new Response('Not found', { status: 404 });
  }

  // -----------------------------------------------------------------
  // WebSocket
  // -----------------------------------------------------------------
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return;
    let payload;
    try { payload = JSON.parse(message); } catch { return; }
    if (payload.type === 'user_message') await this.process(payload.content, ws);
  }

  // -----------------------------------------------------------------
  // Core processing
  // -----------------------------------------------------------------
  private async process(userMsg: string, ws: WebSocket | null) {
    let state = await this.loadState();
    state.lastActivityAt = Date.now();

    // Save user message
    this.sql.exec(
      `INSERT INTO messages (role, parts, timestamp) VALUES ('user', ?, ?)`,
      this.stringify([{ text: userMsg }]),
      Date.now()
    );

    try {
      const complexity = await this.analyzeComplexity(userMsg);
      if (complexity.type === 'simple') {
        await this.handleSimple(userMsg, ws, state);
      } else {
        await this.handleComplex(userMsg, complexity, ws, state);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error';
      if (ws) this.send(ws, { type: 'error', error: msg });
    } finally {
      await this.saveState(state);
    }
  }

  private send(ws: WebSocket, data: unknown) {
    try { ws.send(this.stringify(data)); } catch {}
  }

  // -----------------------------------------------------------------
  // Complexity
  // -----------------------------------------------------------------
  private async analyzeComplexity(query: string): Promise<TaskComplexity> {
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { responseMimeType: 'application/json' },
    });
    const result = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [{ text: `Analyze: return JSON only:
{
  "type": "simple" | "complex",
  "requiredTools": string[],
  "estimatedSteps": number,
  "reasoning": "short"
}
Request: ${query}` }]
      }],
    });
    return this.parse<TaskComplexity>((await result.response).text());
  }

  // -----------------------------------------------------------------
  // Simple query
  // -----------------------------------------------------------------
  private async handleSimple(query: string, ws: WebSocket | null, state: AgentState) {
    if (ws) this.send(ws, { type: 'status', message: 'Thinking…' });

    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      tools: [{ googleSearchRetrieval: {} }, { codeExecution: {} }],
    });
    const chat = model.startChat({ history: this.buildHistory() });
    const result = await chat.sendMessageStream(query);

    let full = '';
    for await (const chunk of result.stream) {
      const txt = chunk.text();
      full += txt;
      if (ws) this.send(ws, { type: 'chunk', content: txt });
    }

    this.sql.exec(
      `INSERT INTO messages (role, parts, timestamp) VALUES ('model', ?, ?)`,
      this.stringify([{ text: full }]),
      Date.now()
    );
    if (ws) this.send(ws, { type: 'done' });
  }

  // -----------------------------------------------------------------
  // Complex task
  // -----------------------------------------------------------------
  private async handleComplex(query: string, complexity: TaskComplexity, ws: WebSocket | null, state: AgentState) {
    if (ws) this.send(ws, { type: 'status', message: 'Planning…' });
    const plan = await this.generatePlan(query, complexity);
    state.currentPlan = plan;
    await this.saveState(state);
    if (ws) this.send(ws, { type: 'plan', plan });

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      plan.currentStepIndex = i;
      if (ws) this.send(ws, { type: 'step_start', step: i + 1, description: step.description });

      try {
        step.status = 'executing';
        step.startedAt = Date.now();
        const result = await this.executeStep(step, state);
        step.result = result;
        step.status = 'completed';
        step.completedAt = Date.now();
        step.durationMs = step.completedAt - step.startedAt;
        if (ws) this.send(ws, { type: 'step_complete', step: i + 1, result });
        await this.saveState(state);
      } catch (e) {
        step.status = 'failed';
        step.error = e instanceof Error ? e.message : 'unknown';
        if (ws) this.send(ws, { type: 'step_error', step: i + 1, error: step.error });
        break;
      }
    }

    await this.synthesize(ws, state);
    plan.status нравится 'completed';
    plan.completedAt = Date.now();
    await this.saveState(state);
  }

  private async generatePlan(query: string, complexity: TaskComplexity): Promise<ExecutionPlan> {
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { responseMimeType: 'application/json' },
    });
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: `Plan as JSON array:
[
  { "id": "s1", "description": "...", "action": "search|analyze|code_execute|api_call|synthesize" }
]
Request: ${query}
Complexity: ${this.stringify(complexity)}` }] }],
    });
    const steps = this.parse<any[]>((await result.response).text());
    return {
      steps: steps.map((s, i) => ({
        ...s,
        id: s.id ?? `step_${i + 1}`,
        status: 'pending' as const,
      })),
      currentStepIndex: 0,
      status: 'executing',
      createdAt: Date.now(),
    };
  }

  private async executeStep(step: PlanStep, state: AgentState): Promise<string> {
    const prompt = this.buildPrompt(step, state);
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      tools: [{ googleSearchRetrieval: {} }, { codeExecution: {} }],
    });
    const chat = model.startChat({ history: this.buildHistory() });
    const result = await chat.sendMessage(prompt);
    return (await result.response).text();
  }

  private buildPrompt(step: PlanStep, state: AgentState): string {
    const plan = state.currentPlan!;
    const done = plan.steps
      .filter(s => s.status === 'completed')
      .map(s => `${s.description}: ${s.result ?? ''}`)
      .join('\n');
    return `PLAN: ${plan.steps.map(s => s.description).join(' → ')}

DONE:
${done || 'None'}

STEP: ${step.description}
ACTION: ${step.action}

Result only:`;
  }

  private async synthesize(ws: WebSocket | null, state: AgentState) {
    if (ws) this.send(ws, { type: 'status', message: 'Summarizing…' });

    const plan = state.currentPlan!;
    const lastUser = this.sql.exec(`SELECT parts FROM messages WHERE role='user' ORDER BY timestamp DESC LIMIT 1`).one()?.parts as string;
    const original = lastUser ? this.parse<any[]>(lastUser)[0].text : '';

    const prompt = `Request: ${original}

Results:
${plan.steps.map((s, i) => `Step ${i + 1}: ${s.result ?? ''}`).join('\n\n')}

Concise answer:`;

    const model = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }] });
    const answer = (await result.response).text();

    this.sql.exec(
      `INSERT INTO messages (role, parts, timestamp) VALUES ('model', ?, ?)`,
      this.stringify([{ text: answer }]),
      Date.now()
    );

    if (ws) {
      this.send(ws, { type: 'final_response', content: answer });
      this.send(ws, { type: 'done' });
    }
  }

  private buildHistory() {
    const rows = this.sql.exec(`SELECT role, parts FROM messages ORDER BY timestamp ASC`);
    const hist: Array<{ role: string; parts: Array<{ text: string }> }> = [];
    for (const r of rows) {
      hist.push({
        role: r.role === 'model' ? 'model' : 'user',
        parts: this.parse(r.parts as string),
      });
    }
    if (hist.length && hist[hist.length - 1].role === 'user') hist.pop();
    return hist;
  }

  // -----------------------------------------------------------------
  // HTTP
  // -----------------------------------------------------------------
  private async handleChat(req: Request): Promise<Response> {
    const { message } = await req.json<{ message: string }>();
    if (!message) return new Response(JSON.stringify({ error: 'no message' }), { status: 400 });
    this.ctx.waitUntil(this.process(message, null));
    return new Response(JSON.stringify({ status: 'queued' }));
  }

  private getHistory(): Response {
    const rows = this.sql.exec(`SELECT role, parts, timestamp FROM messages ORDER BY timestamp ASC`);
    const msgs: Message[] = [];
    for (const r of rows) {
      msgs.push({
        role: r.role as any,
        parts: this.parse(r.parts as string),
        timestamp: r.timestamp as number,
      });
    }
    return new Response(JSON.stringify({ messages: msgs }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async clearHistory(): Promise<Response> {
    this.sql.exec('DELETE FROM messages');
    this.sql.exec('DELETE FROM kv');
    this.sql.exec('DELETE FROM sqlite_sequence WHERE name IN ("messages")');
    return new Response(JSON.stringify({ ok: true }));
  }

  private getStatus(): Response {
    const stateRow = this.sql.exec(`SELECT value FROM kv WHERE key='state'`).one();
    const state = stateRow ? this.parse<AgentState>(stateRow.value as string) : null;
    return new Response(JSON.stringify({ plan: state?.currentPlan, lastActivity: state?.lastActivityAt }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
