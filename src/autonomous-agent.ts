// src/autonomous-agent.ts
import { DurableObject } from 'cloudflare:workers';
import type { Env, AgentState, PlanStep, TaskComplexity } from './types';
import { GeminiClient } from './utils/gemini';
import { StorageManager } from './storage/manager';
import { ToolRegistry, executeTool, type ToolExecutionParams } from './tools';
import { 
  AgentError, 
  ResponseCache, 
  sanitizeInput, 
  buildStepPrompt,
  stringifyJSON 
} from './utils/helpers';

export class AutonomousAgent extends DurableObject<Env> {
  private storage: StorageManager;
  private gemini: GeminiClient;
  private toolRegistry: ToolRegistry;
  private cache: ResponseCache;
  private activeConnections: Set<WebSocket> = new Set();
  private requestQueue: Array<{ userMsg: string; ws: WebSocket | null }> = [];
  private isProcessingQueue = false;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.storage = new StorageManager(state.storage.sql);
    this.gemini = new GeminiClient(env.GEMINI_API_KEY);
    this.toolRegistry = new ToolRegistry();
    this.cache = new ResponseCache();

    // Schedule cleanup alarm
    this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000); // 1 hour
  }

  /**
   * HTTP request handler
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade
    if (url.pathname === '/api/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      this.send(server, { type: 'connected', sessionId: this.ctx.id.toString() });
      return new Response(null, { status: 101, webSocket: client });
    }

    // REST endpoints
    if (url.pathname === '/api/chat' && request.method === 'POST') return this.handleChat(request);
    if (url.pathname === '/api/history' && request.method === 'GET') return this.getHistory();
    if (url.pathname === '/api/clear' && request.method === 'POST') return this.clearHistory();
    if (url.pathname === '/api/status' && request.method === 'GET') return this.getStatus();

    return new Response('Not found', { status: 404 });
  }

  /**
   * WebSocket message handler
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;

    this.activeConnections.add(ws);

    let payload: any;
    try {
      payload = JSON.parse(message);
    } catch {
      this.send(ws, { type: 'error', error: 'Invalid JSON' });
      return;
    }

    if (payload.type === 'user_message' && typeof payload.content === 'string') {
      // Add to queue for processing
      this.requestQueue.push({ userMsg: sanitizeInput(payload.content), ws });
      this.processQueue();
    } else {
      this.send(ws, { type: 'error', error: 'Invalid payload' });
    }
  }

  /**
   * WebSocket close handler
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.activeConnections.delete(ws);
    console.log(`WebSocket closed: ${code} - ${reason}`);
  }

  /**
   * WebSocket error handler
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    this.activeConnections.delete(ws);
    console.error('WebSocket error:', error);
  }

  /**
   * Process request queue
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.requestQueue.length === 0) return;

    this.isProcessingQueue = true;

    while (this.requestQueue.length > 0) {
      const request = this.requestQueue.shift()!;
      try {
        await this.process(request.userMsg, request.ws);
      } catch (err) {
        console.error('Queue processing failed:', err);
        if (request.ws) {
          this.send(request.ws, {
            type: 'error',
            error: err instanceof Error ? err.message : 'Processing failed'
          });
        }
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Main processing logic
   */
  private async process(userMsg: string, ws: WebSocket | null): Promise<void> {
    let state = await this.storage.loadState();
    state.lastActivityAt = Date.now();

    // Check cache first
    const cached = this.cache.get(userMsg);
    if (cached && ws) {
      this.send(ws, { type: 'chunk', content: cached });
      this.send(ws, { type: 'done' });
      return;
    }

    try {
      // Analyze complexity
      if (ws) this.send(ws, { type: 'status', message: 'Analyzing request...' });
      const complexity = await this.gemini.analyzeComplexity(userMsg);

      // Save user message AFTER successful analysis
      this.storage.saveMessage('user', [{ text: userMsg }], Date.now());

      // Route based on complexity
      if (complexity.type === 'simple') {
        await this.handleSimple(userMsg, ws, state);
      } else {
        await this.handleComplex(userMsg, complexity, ws, state);
      }

      await this.storage.saveState(state);
    } catch (error) {
      console.error('Process error:', error);
      if (ws) {
        this.send(ws, {
          type: 'error',
          error: error instanceof AgentError ? error.message : 'Processing failed'
        });
      }
      throw error;
    }
  }

  /**
   * Handle simple queries (streaming, no tools)
   */
  private async handleSimple(query: string, ws: WebSocket | null, state: AgentState): Promise<void> {
    if (ws) this.send(ws, { type: 'status', message: 'Thinking...' });

    const history = this.storage.buildGeminiHistory();
    let fullResponse = '';

    try {
      fullResponse = await this.gemini.streamResponse(query, history, (chunk) => {
        if (ws) this.send(ws, { type: 'chunk', content: chunk });
      });

      // Save assistant response
      this.storage.saveMessage('model', [{ text: fullResponse }], Date.now());

      // Cache the response
      this.cache.set(query, fullResponse);

      if (ws) this.send(ws, { type: 'done' });
    } catch (error) {
      console.error('Simple query failed:', error);
      if (ws) this.send(ws, { type: 'error', error: 'Failed to generate response' });
      throw error;
    }
  }

  /**
   * Handle complex queries (multi-step with plan)
   */
  private async handleComplex(
    query: string,
    complexity: TaskComplexity,
    ws: WebSocket | null,
    state: AgentState
  ): Promise<void> {
    // Generate plan
    if (ws) this.send(ws, { type: 'status', message: 'Creating execution plan...' });
    const plan = await this.gemini.generatePlan(query, complexity);
    
    state.currentPlan = plan;
    await this.storage.saveState(state);
    
    if (ws) this.send(ws, { type: 'plan', plan });

    // Execute steps
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      plan.currentStepIndex = i;

      if (ws) {
        this.send(ws, {
          type: 'step_start',
          step: i + 1,
          total: plan.steps.length,
          description: step.description
        });
      }

      try {
        step.status = 'executing';
        step.startedAt = Date.now();

        const result = await this.executeStep(step, state);

        step.result = result;
        step.status = 'completed';
        step.completedAt = Date.now();
        step.durationMs = step.completedAt - step.startedAt;

        if (ws) this.send(ws, { type: 'step_complete', step: i + 1, result });
        await this.storage.saveState(state);
      } catch (error) {
        step.status = 'failed';
        step.error = error instanceof Error ? error.message : 'Unknown error';
        step.completedAt = Date.now();
        step.durationMs = step.completedAt - (step.startedAt || step.completedAt);

        if (ws) this.send(ws, { type: 'step_error', step: i + 1, error: step.error });
        
        // Continue with other steps even if one fails
        console.error(`Step ${i + 1} failed:`, error);
      }
    }

    // Synthesize final response
    await this.synthesize(query, ws, state);

    plan.status = 'completed';
    plan.completedAt = Date.now();
    await this.storage.saveState(state);
  }

  /**
   * Execute a single step using the tool registry
   */
  private async executeStep(step: PlanStep, state: AgentState): Promise<string> {
    const completedSteps = state.currentPlan!.steps.filter(s => s.status === 'completed');
    const allSteps = state.currentPlan!.steps;
    
    const prompt = buildStepPrompt(step, completedSteps, allSteps);
    const history = this.storage.buildGeminiHistory();

    // Create gemini executor function for tools
    const geminiExecutor = async (toolPrompt: string, useTools: boolean): Promise<string> => {
      return await this.gemini.executeWithTools(toolPrompt, history, useTools);
    };

    const params: ToolExecutionParams = {
      step,
      state,
      prompt,
      geminiExecutor,
    };

    // Execute using tool registry
    const tool = this.toolRegistry.getToolForAction(step.action);
    if (!tool) {
      throw new AgentError(
        `Unknown action: ${step.action}`,
        'UNKNOWN_ACTION',
        { action: step.action }
      );
    }

    return await executeTool(tool.name, params, this.toolRegistry);
  }

  /**
   * Synthesize final response from step results
   */
  private async synthesize(originalQuery: string, ws: WebSocket | null, state: AgentState): Promise<void> {
    if (ws) this.send(ws, { type: 'status', message: 'Synthesizing final answer...' });

    const plan = state.currentPlan!;
    const stepResults = plan.steps.map(s => ({
      description: s.description,
      result: s.result || `[Step ${s.status}]`
    }));

    const history = this.storage.buildGeminiHistory();

    try {
      const answer = await this.gemini.synthesize(originalQuery, stepResults, history);

      // Save final response
      this.storage.saveMessage('model', [{ text: answer }], Date.now());

      if (ws) {
        this.send(ws, { type: 'final_response', content: answer });
        this.send(ws, { type: 'done' });
      }
    } catch (error) {
      console.error('Synthesis failed:', error);
      if (ws) this.send(ws, { type: 'error', error: 'Failed to synthesize response' });
      throw error;
    }
  }

  /**
   * Send data via WebSocket
   */
  private send(ws: WebSocket, data: unknown): void {
    try {
      ws.send(stringifyJSON(data));
    } catch (e) {
      console.error('WebSocket send failed:', e);
    }
  }

  /**
   * REST API: Handle chat request
   */
  private async handleChat(req: Request): Promise<Response> {
    let message: string;
    try {
      const body = await req.json<{ message: string }>();
      message = sanitizeInput(body.message);
      if (!message) throw new Error('Empty message');
    } catch {
      return new Response(stringifyJSON({ error: 'Invalid request' }), { status: 400 });
    }

    // Queue for background processing
    this.ctx.waitUntil(
      this.process(message, null).catch(err => {
        console.error('Background process failed:', err);
      })
    );

    return new Response(stringifyJSON({ status: 'queued' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  /**
   * REST API: Get conversation history
   */
  private getHistory(): Response {
    const messages = this.storage.getHistory();
    return new Response(stringifyJSON({ history: messages }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  /**
   * REST API: Clear history
   */
  private async clearHistory(): Promise<Response> {
    try {
      this.storage.clearHistory();
      this.cache.clear();
      return new Response(stringifyJSON({ ok: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(stringifyJSON({ error: 'Failed to clear history' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  /**
   * REST API: Get current status
   */
  private getStatus(): Response {
    const state = this.ctx.blockConcurrencyWhile(async () => {
      return await this.storage.loadState();
    });

    return new Response(stringifyJSON({
      plan: state.currentPlan,
      lastActivity: state.lastActivityAt,
      messageCount: this.storage.getMessageCount(),
      activeConnections: this.activeConnections.size,
      cacheSize: this.cache.size(),
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  /**
   * Alarm handler for cleanup
   */
  async alarm(): Promise<void> {
    const state = await this.storage.loadState();
    const inactiveThreshold = 30 * 60 * 1000; // 30 minutes

    if (Date.now() - state.lastActivityAt > inactiveThreshold) {
      console.log('Session inactive, clearing cache...');
      this.cache.clear();
    }

    // Schedule next cleanup
    await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000); // 1 hour
  }
}
