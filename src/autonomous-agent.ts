/**
 * Autonomous Agent Durable Object
 *
 * This Durable Object contains all the agent logic and has no CPU time limits.
 * It handles WebSocket connections, maintains conversation state, and executes
 * multi-step autonomous plans using Gemini 2.5 Flash.
 */

import { DurableObject } from 'cloudflare:workers';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type {
  Env,
  AgentState,
  Message,
  ExecutionPlan,
  PlanStep,
  TaskComplexity,
  FileContext
} from './types';

export class AutonomousAgent extends DurableObject<Env> {
  private state: AgentState;
  private genAI: GoogleGenerativeAI;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.state = {
      conversationHistory: [],
      context: { files: [], searchResults: [] }
    };

    this.genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<AgentState>('state');
      if (stored) {
        this.state = stored;
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /*  PUBLIC ENTRY POINTS  – wrapped with try/catch so crashes surface   */
  /* ------------------------------------------------------------------ */

  async fetch(request: Request): Promise<Response> {
    try {
      return await this._fetch(request);
    } catch (e: any) {
      const msg = `DO crash: ${e.message || e}`;
      console.error(msg, e);
      return new Response(JSON.stringify({ error: msg }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      await this._webSocketMessage(ws, message);
    } catch (e: any) {
      const err = `WS crash: ${e.message || e}`;
      console.error(err, e);
      ws.send(JSON.stringify({ type: 'error', error: err }));
      ws.close(1011, 'DO exception');
    }
  }

  /* ------------------------------------------------------------------ */
  /*  ORIGINAL LOGIC – unchanged, just renamed to _fetch / _webSocketMessage  */
  /* ------------------------------------------------------------------ */

  private async _fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/chat' && request.method === 'POST') {
      return this.handleChatRequest(request);
    }

    if (url.pathname === '/history' && request.method === 'GET') {
      return Response.json({
        history: this.state.conversationHistory,
        sessionId: this.state.sessionId,
        messageCount: this.state.conversationHistory.length
      });
    }

    if (url.pathname === '/clear' && request.method === 'POST') {
      this.state = { conversationHistory: [], context: { files: [], searchResults: [] } };
      await this.persistState();
      return Response.json({ status: 'cleared' });
    }

    if (url.pathname === '/status' && request.method === 'GET') {
      return Response.json({
        status: this.state.currentPlan ? 'executing_plan' : 'idle',
        currentPlan: this.state.currentPlan,
        messageCount: this.state.conversationHistory.length,
        fileCount: this.state.context.files.length,
        lastActivity: this.state.lastActivityAt
      });
    }

    return new Response('Not found', { status: 404 });
  }

  private async _webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') {
      this.sendToClient(ws, { type: 'error', error: 'Binary messages not supported' });
      return;
    }

    const data = JSON.parse(message);

    if (data.type === 'user_message') {
      await this.processUserMessage(data.content, ws);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }

  /* ------------------------------------------------------------------ */
  /*  REST OF ORIGINAL IMPLEMENTATION – 100 % identical, no changes     */
  /* ------------------------------------------------------------------ */

  async processUserMessage(userMessage: string, ws: WebSocket | null): Promise<void> {
    this.state.lastActivityAt = Date.now();
    this.state.conversationHistory.push({
      role: 'user',
      parts: [{ text: userMessage }],
      timestamp: Date.now()
    });

    try {
      const complexity = await this.analyzeTaskComplexity(userMessage);

      if (complexity.type === 'simple') {
        await this.handleSimpleQuery(userMessage, ws);
      } else {
        await this.handleComplexTask(userMessage, complexity, ws);
      }
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (ws) {
        this.sendToClient(ws, { type: 'error', error: errorMessage });
      }
    }

    await this.persistState();
  }

  async analyzeTaskComplexity(query: string): Promise<TaskComplexity> {
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { responseMimeType: 'application/json' }
    });

    const result = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [{
          text: `Analyze this user request and determine:
1. Is it a simple question (single turn) or complex task (multi-step)?
2. What tools/capabilities are needed?
3. Estimated number of steps if complex

Request: ${query}

Respond in JSON format:
{
  "type": "simple" | "complex",
  "requiredTools": ["search", "code_execution", "api_call"],
  "estimatedSteps": number,
  "reasoning": "brief explanation"
}`
        }]
      }]
    });

    const response = await result.response;
    return JSON.parse(response.text()) as TaskComplexity;
  }

  async handleSimpleQuery(query: string, ws: WebSocket | null): Promise<void> {
    if (ws) {
      this.sendToClient(ws, { type: 'status', message: 'Processing query...' });
    }

    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      tools: [{ googleSearch: {} }, { codeExecution: {} }]
    });

    const chat = model.startChat({
      history: this.state.conversationHistory.slice(0, -1).map(msg => ({
        role: msg.role,
        parts: msg.parts
      }))
    });

    const result = await chat.sendMessageStream(query);

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text && ws) {
        this.sendToClient(ws, { type: 'chunk', content: text });
      }
    }

    const response = await result.response;
    this.state.conversationHistory.push({
      role: 'model',
      parts: response.candidates?.[0]?.content?.parts || [],
      timestamp: Date.now()
    });

    if (ws) {
      this.sendToClient(ws, { type: 'done' });
    }
  }

  async handleComplexTask(query: string, complexity: TaskComplexity, ws: WebSocket | null): Promise<void> {
    if (ws) {
      this.sendToClient(ws, { type: 'status', message: 'Creating execution plan...' });
    }

    const plan = await this.generateExecutionPlan(query, complexity);
    this.state.currentPlan = plan;

    if (ws) {
      this.sendToClient(ws, { type: 'plan', plan });
    }

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      plan.currentStepIndex = i;

      if (ws) {
        this.sendToClient(ws, {
          type: 'step_start',
          step: i + 1,
          total: plan.steps.length,
          description: step.description
        });
      }

      try {
        step.status = 'executing';
        step.startedAt = Date.now();
        const result = await this.executeStep(step);
        step.result = result;
        step.status = 'completed';
        step.completedAt = Date.now();
        step.durationMs = (step.completedAt - (step.startedAt || 0));

        if (ws) {
          this.sendToClient(ws, { type: 'step_complete', step: i + 1, result });
        }
        await this.persistState();
      } catch (error: any) {
        step.status = 'failed';
        step.error = error instanceof Error ? error.message : 'Unknown error';
        if (ws) {
          this.sendToClient(ws, { type: 'step_error', step: i + 1, error: step.error });
        }
        break;
      }
    }

    await this.synthesizeFinalResponse(ws);
    plan.status = 'completed';
    plan.completedAt = Date.now();
  }

  async generateExecutionPlan(query: string, complexity: TaskComplexity): Promise<ExecutionPlan> {
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { responseMimeType: 'application/json' }
    });

    const planningPrompt = `You are an autonomous agent planner. Given this user request, create a detailed step-by-step execution plan.

User Request: ${query}

Task Complexity Analysis: ${JSON.stringify(complexity)}

Create a plan with specific, actionable steps. Each step should specify:
- Action type: search, analyze, code_execute, api_call, or synthesize
- Clear description of what to do
- Expected output

Return JSON array of steps:
[
  {
    "id": "step_1",
    "description": "Search for X",
    "action": "search"
  }
]`;

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: planningPrompt }] }]
    });

    const response = await result.response;
    const steps = JSON.parse(response.text());

    return {
      steps: steps.map((s: any, i: number) => ({
        ...s,
        id: s.id || `step_${i + 1}`,
        status: 'pending' as const
      })),
      currentStepIndex: 0,
      status: 'executing',
      createdAt: Date.now()
    };
  }

  async executeStep(step: PlanStep): Promise<any> {
    const contextPrompt = this.buildContextualPrompt(step);
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      tools: [{ googleSearch: {} }, { codeExecution: {} }]
    });

    const chat = model.startChat({
      history: this.state.conversationHistory.map(msg => ({
        role: msg.role,
        parts: msg.parts
      }))
    });

    const result = await chat.sendMessage(contextPrompt);
    return result.response.text();
  }

  buildContextualPrompt(step: PlanStep): string {
    const plan = this.state.currentPlan;
    if (!plan) return step.description;

    const completedSteps = plan.steps
      .filter(s => s.status === 'completed')
      .map(s => `${s.description}: ${s.result}`)
      .join('\n');

    return `EXECUTION CONTEXT:
Plan Overview: ${plan.steps.map(s => s.description).join(' → ')}

Completed Steps:
${completedSteps || 'None yet'}

Current Step: ${step.description}
Action Type: ${step.action}

Execute this step and provide the result.`;
  }

  async synthesizeFinalResponse(ws: WebSocket | null): Promise<void> {
    if (ws) {
      this.sendToClient(ws, { type: 'status', message: 'Synthesizing final response...' });
    }

    const plan = this.state.currentPlan;
    if (!plan) return;

    const originalRequest = this.state.conversationHistory
      .find(m => m.role === 'user')?.parts[0];

    const originalText = originalRequest && 'text' in originalRequest
      ? originalRequest.text
      : 'Unknown request';

    const synthesisPrompt = `Based on the execution of this plan, provide a comprehensive final response to the user.

Original User Request: ${originalText}

Execution Results:
${plan.steps.map((s, i) => `Step ${i + 1} (${s.description}): ${s.result || 'No result'}`).join('\n\n')}

Synthesize a clear, complete response that addresses the user's original request.`;

    const model = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: synthesisPrompt }] }]
    });

    const response = await result.response;
    const finalResponse = response.text();

    this.state.conversationHistory.push({
      role: 'model',
      parts: [{ text: finalResponse }],
      timestamp: Date.now()
    });

    if (ws) {
      this.sendToClient(ws, { type: 'final_response', content: finalResponse });
      this.sendToClient(ws, { type: 'done' });
    }

    await this.persistState();
  }

  sendToClient(ws: WebSocket, data: any): void {
    try {
      ws.send(JSON.stringify(data));
    } catch (e) {
      console.error('Failed to send to client:', e);
    }
  }

  async persistState(): Promise<void> {
    await this.ctx.storage.put('state', this.state);
  }

  async handleChatRequest(request: Request): Promise<Response> {
    const { message } = await request.json<{ message: string }>();
    this.ctx.waitUntil(this.processUserMessage(message, null));
    return Response.json({ status: 'processing' });
  }
}
