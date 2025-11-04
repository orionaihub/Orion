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

  // -----------------------------------------------------------------
  // Constructor – ONLY synchronous work
  // -----------------------------------------------------------------
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    this.genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

    // Create tables (idempotent) – wrapped in try/catch
    try {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS kv (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role TEXT NOT NULL,
          parts TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_history_ts ON history(timestamp);
      `);
    } catch (e) {
      console.error('Table init error:', e);
    }
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
  // Load state – **no save here** (prevents deadlock)
  // -----------------------------------------------------------------
  private async loadState(): Promise<AgentState> {
    const row = this.sql.exec(`SELECT value FROM kv WHERE key = 'state'`).one();
    if (row) {
      try {
        return this.parse<AgentState>(row.value as string);
      } catch (e) {
        console.error('Corrupted state, resetting:', e);
      }
    }

    // First-time defaults
    return {
      conversationHistory: [],
      context: { files: [], searchResults: [] },
      sessionId: this.ctx.id.toString(),
      lastActivityAt: Date.now(),
      currentPlan: undefined,
    };
  }

  // -----------------------------------------------------------------
  // Save state – serialized with blockConcurrencyWhile
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
  // fetch – all async work starts here
  // -----------------------------------------------------------------
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // ---------- WebSocket ----------
    if (url.pathname === '/api/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // Load state (now safe)
    let state: AgentState;
    try {
      state = await this.loadState();
      console.log('State loaded – sessionId:', state.sessionId);
    } catch (e) {
      console.error('State load failed:', e);
      return new Response(JSON.stringify({ error: 'Failed to load state' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ---------- HTTP API ----------
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      return this.handleChatRequest(request, state);
    }
    if (url.pathname === '/api/history' && request.method === 'GET') {
      return this.getHistory();
    }
    if (url.pathname === '/api/clear' && request.method === 'POST') {
      return this.clearHistory(state);
    }
    if (url.pathname === '/api/status' && request.method === 'GET') {
      return this.getStatus(state);
    }

    return new Response('Not found', { status: 404 });
  }

  // -----------------------------------------------------------------
  // WebSocket message handler
  // -----------------------------------------------------------------
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') {
      this.send(ws, { type: 'error', error: 'Binary not supported' });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      this.send(ws, { type: 'error', error: 'Invalid JSON' });
      return;
    }

    if (payload.type === 'user_message') {
      await this.processUserMessage(payload.content, ws);
    }
  }

  // -----------------------------------------------------------------
  // Core processing
  // -----------------------------------------------------------------
  private async processUserMessage(userMsg: string, ws: WebSocket | null) {
    let state = await this.loadState();
    state.lastActivityAt = Date.now();

    // Store user message
    this.sql.exec(
      `INSERT INTO history (role, parts, timestamp) VALUES ('user', ?, ?)`,
      this.stringify([{ text: userMsg }]),
      Date.now()
    );

    try {
      const complexity = await this.analyzeTaskComplexity(userMsg);
      if (complexity.type === 'simple') {
        await this.handleSimpleQuery(userMsg, ws, state);
      } else {
        await this.handleComplexTask(userMsg, complexity, ws, state);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      if (ws) this.send(ws, { type: 'error', error: msg });
    } finally {
      // Persist state after processing
      await this.saveState(state);
    }
  }

  // -----------------------------------------------------------------
  // Send helper
  // -----------------------------------------------------------------
  private send(ws: WebSocket, data: unknown) {
    try {
      ws.send(this.stringify(data));
    } catch (err) {
      console.error('WS send error:', err);
    }
  }

  // -----------------------------------------------------------------
  // Complexity analysis
  // -----------------------------------------------------------------
  private async analyzeTaskComplexity(query: string): Promise<TaskComplexity> {
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { responseMimeType: 'application/json' },
    });
    const result = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [{ text: `Analyze this request and respond in JSON only:
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
  // Simple query – streaming
  // -----------------------------------------------------------------
  private async handleSimpleQuery(
    query: string,
    ws: WebSocket | null,
    state: AgentState
  ) {
    if (ws) this.send(ws, { type: 'status', message: 'Thinking…' });

    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      tools: [{ googleSearchRetrieval: {} }, { codeExecution: {} }],
    });

    const history = this.buildGeminiHistory();
    const chat = model.startChat({ history });

    const result = await chat.sendMessageStream(query);
    let full = '';
    for await (const chunk of result.stream) {
      const txt = chunk.text();
      full += txt;
      if (ws) this.send(ws, { type: 'chunk', content: txt });
    }

    this.sql.exec(
      `INSERT INTO history (role, parts, timestamp) VALUES ('model', ?, ?)`,
      this.stringify([{ text: full }]),
      Date.now()
    );

    if (ws) this.send(ws, { type: 'done' });
  }

  // -----------------------------------------------------------------
  // Complex task – plan + steps
  // -----------------------------------------------------------------
  private async handleComplexTask(
    query: string,
    complexity: TaskComplexity,
    ws: WebSocket | null,
    state: AgentState
  ) {
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

    await this.synthesizeFinalResponse(ws, state);
    plan.status = 'completed';
    plan.completedAt = Date.now();
    await this.saveState(state);
  }

  // -----------------------------------------------------------------
  // Plan generation
  // -----------------------------------------------------------------
  private async generatePlan(query: string, complexity: TaskComplexity): Promise<ExecutionPlan> {
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { responseMimeType: 'application/json' },
    });
    const prompt = `Return ONLY a JSON array of steps:
[
  { "id": "s1", "description": "...", "action": "search|analyze|code_execute|api_call|synthesize" }
]
User request: ${query}
Complexity: ${this.stringify(complexity)}`;

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
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

  // -----------------------------------------------------------------
  // Step execution
  // -----------------------------------------------------------------
  private async executeStep(step: PlanStep, state: AgentState): Promise<string> {
    const prompt = this.buildStepPrompt(step, state);
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      tools: [{ googleSearchRetrieval: {} }, { codeExecution: {} }],
    });
    const chat = model.startChat({ history: this.buildGeminiHistory() });
    const result = await chat.sendMessage(prompt);
    return (await result.response).text();
  }

  private buildStepPrompt(step: PlanStep, state: AgentState): string {
    const plan = state.currentPlan!;
    const completed = plan.steps
      .filter(s => s.status === 'completed')
      .map(s => `${s.description}: ${s.result ?? ''}`)
      .join('\n');
    return `PLAN OVERVIEW: ${plan.steps.map(s => s.description).join(' → ')}

COMPLETED:
${completed || 'None'}

CURRENT STEP: ${step.description}
ACTION: ${step.action}

Provide the result for this step only.`;
  }

  // -----------------------------------------------------------------
  // Final synthesis
  // -----------------------------------------------------------------
  private async synthesizeFinalResponse(ws: WebSocket | null, state: AgentState) {
    if (ws) this.send(ws, { type: 'status', message: 'Summarizing…' });

    const plan = state.currentPlan!;
    const lastUser = this.sql
      .exec(`SELECT parts FROM history WHERE role='user' ORDER BY timestamp DESC LIMIT 1`)
      .one()?.parts as string | undefined;
    const original = lastUser ? this.parse<any[]>(lastUser)[0].text : '…';

    const prompt = `Original request: ${original}

Execution results:
${plan.steps
  .map((s, i) => `Step ${i + 1} (${s.description}): ${s.result ?? ''}`)
  .join('\n\n')}

Give a concise, user-facing answer.`;

    const model = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    const answer = (await result.response).text();

    this.sql.exec(
      `INSERT INTO history (role, parts, timestamp) VALUES ('model', ?, ?)`,
      this.stringify([{ text: answer }]),
      Date.now()
    );

    if (ws) {
      this.send(ws, { type: 'final_response', content: answer });
      this.send(ws, { type: 'done' });
    }
  }

  // -----------------------------------------------------------------
  // HTTP handlers
  // -----------------------------------------------------------------
  private async handleChatRequest(req: Request, state: AgentState): Promise<Response> {
    const { message } = await req.json<{ message: string }>();
    this.ctx.waitUntil(this.processUserMessage(message, null));
    return new Response(JSON.stringify({ status: 'queued' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private getHistory(): Response {
    const rows = this.sql.exec(`SELECT role, parts, timestamp FROM history ORDER BY timestamp ASC`);
    const messages: Message[] = [];
    for (const r of rows) {
      messages.push({
        role: r.role as 'user' | 'model',
        parts: this.parse(r.parts as string),
        timestamp: r.timestamp as number,
      });
    }
    const stateRow = this.sql.exec(`SELECT value FROM kv WHERE key='state'`).one();
    const sessionId = stateRow ? this.parse<AgentState>(stateRow.value as string).sessionId : 'unknown';
    return new Response(
      this.stringify({
        history: messages,
        sessionId,
        messageCount: messages.length,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  private async clearHistory(state: AgentState): Promise<Response> {
    this.sql.exec(`DELETE FROM history`);
    this.sql.exec(`DELETE FROM kv WHERE key='state'`);
    state.conversationHistory = [];
    state.currentPlan = undefined;
    state.lastActivityAt = Date.now();
    await this.saveState(state);
    return new Response(JSON.stringify({ status: 'cleared' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private getStatus(state: AgentState): Response {
    return new Response(
      this.stringify({
        status: state.currentPlan ? 'executing_plan' : 'idle',
        currentPlan: state.currentPlan,
        messageCount: state.conversationHistory.length,
        fileCount: state.context.files.length,
        lastActivity: state.lastActivityAt,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  // -----------------------------------------------------------------
  // Build Gemini history from SQLite
  // -----------------------------------------------------------------
  private buildGeminiHistory() {
    const rows = this.sql.exec(`SELECT role, parts FROM history ORDER BY timestamp ASC`);
    const hist: Array<{ role: string; parts: Array<{ text: string }> }> = [];
    for (const r of rows) {
      const parts = this.parse<any[]>(r.parts as string);
      hist.push({
        role: r.role === 'model' ? 'model' : 'user',
        parts,
      });
    }
    if (hist.length > 0 && hist[hist.length - 1].role === 'user') hist.pop();
    return hist;
  }
}
