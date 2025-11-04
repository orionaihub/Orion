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

  private parse<T>(text: string): T | null {
    try {
      const trimmed = text.trim().replace(/^```json\s*/, '').replace(/```$/, '');
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
        sessionId: this.ctx.id.toString(),
        lastActivityAt: Date.now(),
        currentPlan: undefined,
      };
    }
    return state;
  }

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
      this.ctx.waitUntil(
        this.process(payload.content, ws).catch(err => {
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

  private async process(userMsg: string, ws: WebSocket | null) {
    let state = await this.loadState();
    state.lastActivityAt = Date.now();

    try {
      this.sql.exec(
        `INSERT INTO messages (role, parts, timestamp) VALUES ('user', ?, ?)`,
        this.stringify([{ text: userMsg }]),
        Date.now()
      );
    } catch (e) {
      console.error('Failed to save user message:', e);
      if (ws) this.send(ws, { type: 'error', error: 'Save failed' });
      return;
    }

    try {
      const complexity = await this.analyzeComplexity(userMsg);
      if (complexity.type === 'simple') {
        await this.handleSimple(userMsg, ws, state);
      } else {
        await this.handleComplex(userMsg, complexity, ws, state);
      }
    } catch (e) {
      console.error('Process error:', e);
      if (ws) this.send(ws, { type: 'error', error: 'Processing failed' });
    } finally {
      await this.saveState(state);
    }
  }

  private async analyzeComplexity(query: string): Promise<TaskComplexity> {
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { responseMimeType: 'application/json' },
    });
    try {
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
      const text = (await result.response).text?.() ?? '{}';
      return this.parse<TaskComplexity>(text) || { type: 'simple', requiredTools: [], estimatedSteps: 1, reasoning: 'fallback' };
    } catch (e) {
      console.error('Complexity failed:', e);
      return { type: 'simple', requiredTools: [], estimatedSteps: 1, reasoning: 'error' };
    }
  }

  private async handleSimple(query: string, ws: WebSocket | null, state: AgentState) {
    if (ws) this.send(ws, { type: 'status', message: 'Thinking…' });

    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      tools: [{ googleSearchRetrieval: {} }, { codeExecution: {} }],
    });
    const chat = model.startChat({ history: this.buildHistory() });

    let full = '';
    try {
      const result = await chat.sendMessageStream(query);
      for await (const chunk of result.stream) {
        const txt = typeof chunk.text === 'function' ? chunk.text() : '';
        full += txt;
        if (ws && txt) this.send(ws, { type: 'chunk', content: txt });
      }
    } catch (e) {
      console.error('Streaming error:', e);
      if (ws) this.send(ws, { type: 'error', error: 'Streaming failed' });
    }

    try {
      this.sql.exec(
        `INSERT INTO messages (role, parts, timestamp) VALUES ('model', ?, ?)`,
        this.stringify([{ text: full }]),
        Date.now()
      );
    } catch (e) {
      console.error('Failed to save model response:', e);
    }

    if (ws) this.send(ws, { type: 'done' });
  }

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
    plan.status = 'completed';
    plan.completedAt = Date.now();
    await this.saveState(state);
  }

  private async generatePlan(query: string, complexity: TaskComplexity): Promise<ExecutionPlan> {
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { responseMimeType: 'application/json' },
    });
    try {
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: `Plan as JSON array:
[
  { "id": "s1", "description": "...", "action": "search|analyze|code_execute|api_call|synthesize" }
]
Request: ${query}
Complexity: ${this.stringify(complexity)}` }] }],
      });
      const text = (await result.response).text?.() ?? '[]';
      const steps = this.parse<any[]>(text) || [];
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
    } catch (e) {
      console.error('Plan failed:', e);
      return {
        steps: [{ id: 's1', description: 'Answer directly', action: 'synthesize', status: 'pending' }],
        currentStepIndex: 0,
        status: 'executing',
        createdAt: Date.now(),
      };
    }
  }

  private async executeStep(step: PlanStep, state: AgentState): Promise<string> {
    const prompt = this.buildPrompt(step, state);
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      tools: [{ googleSearchRetrieval: {} }, { codeExecution: {} }],
    });
    const chat = model.startChat({ history: this.buildHistory() });
    try {
      const result = await chat.sendMessage(prompt);
      return (await result.response).text?.() ?? '[No result]';
    } catch (e) {
      console.error('Step failed:', e);
      return '[Step failed]';
    }
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
    const original = lastUser ? this.parse<any[]>(lastUser)?.[0]?.text || '' : '';

    const prompt = `Request: ${original}

Results:
${plan.steps.map((s, i) => `Step ${i + 1}: ${s.result ?? ''}`).join('\n\n')}

Concise answer:`;

    const model = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    try {
      const result = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }] });
      const answer = (await result.response).text?.() ?? '[No answer]';

      this.sql.exec(
        `INSERT INTO messages (role, parts, timestamp) VALUES ('model', ?, ?)`,
        this.stringify([{ text: answer }]),
        Date.now()
      );

      if (ws) {
        this.send(ws, { type: 'final_response', content: answer });
        this.send(ws, { type: 'done' });
      }
    } catch (e) {
      console.error('Synthesis failed:', e);
      if (ws) this.send(ws, { type: 'error', error: 'Synthesis failed' });
    }
  }

  private buildHistory() {
    const rows = this.sql.exec(`SELECT role, parts FROM messages ORDER BY timestamp ASC`);
    const hist: Array<{ role: string; parts: Array<{ text: string }> }> = [];
    for (const r of rows) {
      const parts = this.parse<any[]>(r.parts as string);
      if (parts) {
        hist.push({
          role: r.role === 'model' ? 'model' : 'user',
          parts,
        });
      }
    }
    if (hist.length && hist[hist.length - 1].role === 'user') hist.pop();
    return hist;
  }

  private async handleChat(req: Request): Promise<Response> {
    let message: string;
    try {
      const body = await req.json<{ message: string }>();
      message = body.message;
      if (!message) throw new Error();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
    }

    this.ctx.waitUntil(
      this.process(message, null).catch(err => {
        console.error('Background process failed:', err);
      })
    );

    return new Response(JSON.stringify({ status: 'queued' }));
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
    try {
      this.sql.exec('DELETE FROM messages');
      this.sql.exec('DELETE FROM kv');
      this.sql.exec('DELETE FROM sqlite_sequence WHERE name IN ("messages")');
    } catch (e) {
      console.error('Clear failed:', e);
    }
    return new Response(this.stringify({ ok: true }));
  }

  private getStatus(): Response {
    const row = this.sql.exec(`SELECT value FROM kv WHERE key='state'`).one();
    const state = row ? this.parse<AgentState>(row.value as string) : null;
    return new Response(this.stringify({
      plan: state?.currentPlan,
      lastActivity: state?.lastActivityAt,
    }), { headers: { 'Content-Type': 'application/json' } });
  }
}
