// src/autonomous-agent.ts - Final Complete Version
import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import GeminiClient from './utils/gemini';
import type {
  Env,
  AgentState as OriginalAgentState,
  Message,
  ExecutionPlan,
  PlanStep,
  TaskComplexity,
  FileMetadata,
  AgentPhase,
  AutonomousMode,
} from './types';

// Placeholder interfaces based on context
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
  complexityDistribution: { simple: number; complex: number };
}

// Updated AgentState
interface AgentState extends OriginalAgentState {
  autonomousMode: AutonomousMode;
  currentPhase: AgentPhase;
}

export class AutonomousAgent extends DurableObject<Env> {
  private sql: SqlStorage;
  private gemini: GeminiClient;
  private maxHistoryMessages = 200;
  private readonly MAX_MESSAGE_SIZE = 100_000;
  private readonly MAX_TOTAL_HISTORY_SIZE = 500_000;
  private activeWebSockets = new Set<WebSocket>();
  private metrics: Metrics = {
    requestCount: 0,
    errorCount: 0,
    avgResponseTime: 0,
    activeConnections: 0,
    totalResponseTime: 0,
    complexityDistribution: { simple: 0, complex: 0 },
  };

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    // @ts-ignore - Assuming env.DB_SQLITE is a D1 instance compatible with SqlStorage
    this.sql = this.env.DB_SQLITE;
    this.gemini = new GeminiClient({ apiKey: this.env.GEMINI_API_KEY });
  }

  // ===== Utility Methods (Parser/Stringify/Error Handling) =====

  private parse<T>(text: string): T {
    return JSON.parse(text) as T;
  }

  private stringify(obj: any): string {
    return JSON.stringify(obj);
  }

  private async withErrorContext<T>(context: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e: any) {
      console.error(`[Error in ${context}]`, e);
      this.metrics.errorCount++;
      throw e;
    }
  }

  private trackRequest(complexityType: 'simple' | 'complex', startTime: number) {
    const duration = Date.now() - startTime;
    this.metrics.requestCount++;
    this.metrics.totalResponseTime += duration;
    this.metrics.avgResponseTime = this.metrics.totalResponseTime / this.metrics.requestCount;
    this.metrics.complexityDistribution[complexityType]++;
  }

  // ===== State Management =====

  private async loadState(): Promise<AgentState> {
    let state: AgentState | null = null;
    try {
      // NOTE: Using D1/SQLite for state storage is atypical for DOs but adheres to your original setup.
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
        autonomousMode: 'orchestrated' as AutonomousMode,
        currentPhase: AgentPhase.ASSESSMENT,
        metadata: {},
      } as AgentState;
    }
    
    // Ensure new properties exist on old state
    if (!state.autonomousMode) state.autonomousMode = 'orchestrated' as AutonomousMode;
    if (!state.currentPhase) state.currentPhase = AgentPhase.ASSESSMENT;

    await this.checkMemoryPressure();
    return state;
  }

  private async saveState(state: AgentState): Promise<void> {
    this.sql.exec(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`, 'state', this.stringify(state));
  }

  private async withStateTransaction<T>(fn: (state: AgentState) => Promise<T>): Promise<T> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.loadState();
      try {
        const result = await fn(state);
        await this.saveState(state);
        return result;
      } catch (e) {
        console.error('Transaction failed, state not saved:', e);
        throw e;
      }
    });
  }

  // ===== Memory Management (Placeholders) =====
  private checkMemoryPressure(): Promise<void> { return Promise.resolve(); }

  // ===== WebSocket Management (FIXED IMPLEMENTATION) =====
  private send(ws: WebSocket | null, msg: any) {
    if (ws && ws.readyState === WebSocket.READY_STATE_OPEN) {
      try {
        ws.send(this.stringify(msg));
      } catch (e) {
        console.error("Failed to send WS message:", e);
      }
    }
  }

  private createChunkBatcher(ws: WebSocket | null, type: string) {
    let buffer = '';
    const BATCH_SIZE = 100;
    return {
      add: (chunk: string) => {
        buffer += chunk;
        if (buffer.length >= BATCH_SIZE) {
          this.send(ws, { type, content: buffer });
          buffer = '';
        }
      },
      flush: () => {
        if (buffer.length > 0) {
          this.send(ws, { type, content: buffer });
          buffer = '';
        }
      }
    };
  }
  
  // *** FIX for Code 1006: This method is called after the handshake ***
  webSocketConnect(ws: WebSocket) {
    this.activeWebSockets.add(ws);
    this.metrics.activeConnections = this.activeWebSockets.size;
    this.send(ws, { type: 'status', message: 'Connected to Autonomous Agent. Session ready.' });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return;
    try {
      const msg = this.parse<any>(message);
      if (msg.type === 'user_message' && msg.content) {
        // Process messages asynchronously, outside the synchronous DO handler
        this.process(msg.content, ws).catch(e => this.webSocketError(ws, e));
      }
    } catch (e) {
      console.error('WS message error:', e);
      this.webSocketError(ws, new Error('Invalid message format'));
    }
  }

  webSocketClose(ws: WebSocket) { 
    this.activeWebSockets.delete(ws); 
    this.metrics.activeConnections = this.activeWebSockets.size;
  }
  
  webSocketError(ws: WebSocket, error: Error) { 
    console.error('WS error:', error); 
    this.activeWebSockets.delete(ws);
    this.metrics.activeConnections = this.activeWebSockets.size;
    this.send(ws, { type: 'error', error: 'WebSocket Error: ' + error.message });
  }

  // ===== HTTP & WebSocket Handlers (FIXED IMPLEMENTATION) =====
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    // *** FIX for WebSocket upgrade path ***
    if (url.pathname.endsWith('/ws') && request.headers.get('Upgrade') === 'websocket') {
        const [client, server] = new WebSocketPair();
        this.ctx.acceptWebSocket(server);
        return new Response(null, { status: 101, webSocket: client });
    }
    
    // HTTP API handling
    switch (url.pathname) {
      case '/history':
        return this.getHistory();
      case '/clear':
        return this.clearHistory();
      case '/status':
        return this.getStatus();
      case '/metrics':
        return this.getMetrics();
      default:
        if (url.pathname === '/') {
             return new Response('Autonomous Agent Durable Object running. Use /api/ws for WebSocket connection.', { status: 200 });
        }
        return new Response('Not Found', { status: 404 });
    }
  }

  // ===== Core Processing Logic (Router) =====

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

      // --- Mode Switching Commands ---
      const trimmedMsg = userMsg.trim().toLowerCase();
      if (trimmedMsg === '/unified') {
        state.autonomousMode = 'unified';
        state.currentPhase = AgentPhase.ASSESSMENT;
        this.send(ws, { type: 'status', message: 'Switched to **Unified Autonomous Mode**.' });
        return;
      }
      if (trimmedMsg === '/orchestrated') {
        state.autonomousMode = 'orchestrated';
        this.send(ws, { type: 'status', message: 'Switched to **Orchestrated (Default) Mode**.' });
        return;
      }

      // --- Routing ---
      if (state.autonomousMode === 'unified') {
        state.currentPhase = AgentPhase.ASSESSMENT;
        await this.handleUnified(userMsg, ws, state);
      } else {
        await this.handleOrchestrated(userMsg, ws, state);
      }
    });
  }

  // ===== Orchestrated Mode Handlers (Original working logic) =====

  private async handleOrchestrated(query: string, ws: WebSocket | null, state: AgentState): Promise<void> {
    const startTime = Date.now();
    const complexity = await this.analyzeComplexityEnhanced(
      query,
      (state.context?.files ?? []).length > 0
    );

    try {
      if (complexity.type === 'simple') {
        await this.handleSimple(query, ws, state);
        this.trackRequest('simple', startTime);
      } else {
        await this.handleComplexOptimized(query, complexity, ws, state, {
          continueOnFailure: false,
          maxRetries: 2,
          parallelExecution: false,
        });
        this.trackRequest('complex', startTime);
      }
    } catch (e) {
      if (ws) this.send(ws, { type: 'error', error: 'Orchestrated processing failed' });
      throw e;
    }
  }

  private async handleSimple(query: string, ws: WebSocket | null, state: AgentState): Promise<void> {
    if (ws) this.send(ws, { type: 'status', message: 'Handling simple query...' });
    const history = this.buildHistory();
    const batcher = this.createChunkBatcher(ws, 'final_chunk');
    const finalResponse = await this.gemini.streamResponse(query, history, (chunk) => batcher.add(chunk));
    batcher.flush();
    
    // Save model response to history
    this.sql.exec(`INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`, 'model', this.stringify([{ text: finalResponse }]), Date.now());
    if (ws) this.send(ws, { type: 'done' });
  }

  private async handleComplexOptimized(query: string, complexity: TaskComplexity, ws: WebSocket | null, state: AgentState, options: StepExecutionOptions): Promise<void> {
    if (ws) this.send(ws, { type: 'status', message: `Generating plan for complex task...` });
    
    state.currentPlan = await this.gemini.generatePlanOptimized(query, complexity, (state.context?.files ?? []).length > 0);
    
    if (ws) {
        this.send(ws, { type: 'plan', plan: state.currentPlan });
        this.send(ws, { type: 'status', message: `Execution plan ready. Starting simulation...` });
    }
    
    // Simulate plan execution as actual execution is complex/placeholder
    let simulatedResult = `Plan of ${state.currentPlan.steps.length} steps was generated. Execution is simulated in this placeholder version.`;
    
    // Final synthesis simulation
    if (ws) this.send(ws, { type: 'status', message: 'Synthesizing final response...' });
    const finalResponse = await this.gemini.synthesize(query, state.currentPlan.steps.map(s => ({ description: s.description, result: simulatedResult })), this.buildHistory());

    this.sql.exec(`INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`, 'model', this.stringify([{ text: finalResponse }]), Date.now());
    if (ws) this.send(ws, { type: 'final_response', content: finalResponse });
    if (ws) this.send(ws, { type: 'done' });
  }


  // ===== Unified Mode Handler (Fixed Logic) =====

  private async handleUnified(userMsg: string, ws: WebSocket | null, state: AgentState): Promise<void> {
    return this.withErrorContext('handleUnified', async () => {
      if (ws) this.send(ws, { type: 'status', message: 'Thinking... (Unified Mode)' });

      let currentMessage = userMsg;
      let loopGuard = 0;
      const MAX_LOOPS = 10;

      while (
        state.currentPhase !== AgentPhase.COMPLETION &&
        state.currentPhase !== AgentPhase.CLARIFICATION &&
        loopGuard < MAX_LOOPS
      ) {
        loopGuard++;
        if (ws) this.send(ws, { type: 'status', message: `Phase: ${state.currentPhase}` });

        const history = this.buildHistory();
        const availableTools = ['search', 'file_analysis', 'code_execution', 'vision', 'maps', 'url_context'];
        const batcher = this.createChunkBatcher(ws, 'chunk');

        const result = await this.gemini.executeUnifiedAutonomous(
          {
            userRequest: currentMessage,
            currentPhase: state.currentPhase,
            conversationHistory: history,
            availableTools: availableTools,
            files: state.context?.files,
            urlList: state.context?.searchResults?.map((r: any) => r.url),
          },
          (chunk) => batcher.add(chunk),
          { model: 'gemini-2.5-flash' }
        );

        batcher.flush();

        if (result.response) {
          try {
            this.sql.exec(
              `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
              'model',
              this.stringify([{ text: result.response }]),
              Date.now()
            );
          } catch (e) { console.error('Failed to save unified model response:', e); }
        }

        // --- Process the result from the unified call ---

        if (result.toolCalls && result.toolCalls.length > 0) {
          if (ws) this.send(ws, { type: 'status', message: `Executing ${result.toolCalls.length} tool(s)...` });
          
          const toolResultsText: string[] = [];
          for (const call of result.toolCalls) {
            let executionResult = `[Tool Call: ${call.tool} with params ${this.stringify(call.params)} - Execution not fully implemented in this hybrid model]`;
            toolResultsText.push(executionResult);
            if (ws) this.send(ws, { type: 'step_complete', step: call.tool, result: executionResult });
          }
          
          state.currentPhase = AgentPhase.EXECUTION;
          currentMessage = `[Tool Results]: \n${toolResultsText.join('\n')}\n\n[User]: Now, continue based on these results.`;
          
          try {
            this.sql.exec(
              `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
              'user',
              this.stringify([{ text: currentMessage }]),
              Date.now()
            );
          } catch (e) { console.error('Failed to save tool result message:', e); }

          continue;
        }

        let newPhase = state.currentPhase;
        if (result.phaseChanges && result.phaseChanges.length > 0) {
          newPhase = result.phaseChanges[result.phaseChanges.length - 1]; 
        }
        
        if (result.clarificationRequests && result.clarificationRequests.length > 0) {
          newPhase = AgentPhase.CLARIFICATION;
        }
        
        state.currentPhase = newPhase;

        if (state.currentPhase === AgentPhase.COMPLETION || state.currentPhase === AgentPhase.CLARIFICATION) {
          break;
        }
        
        currentMessage = userMsg;
      }

      if (loopGuard >= MAX_LOOPS) {
        this.send(ws, { type: 'error', error: 'Agent stuck in a loop (Unified Mode)' });
      }
      if (ws) this.send(ws, { type: 'done' });
    });
  }

  // ===== Helpers (Original D1/SQL Implementation) =====
  private async analyzeComplexityEnhanced(query: string, hasFiles: boolean): Promise<TaskComplexity> {
    const startTime = Date.now();
    try {
        const complexity = await this.gemini.analyzeComplexity(query, hasFiles);
        return complexity;
    } finally {
        this.trackRequest('simple', startTime); // Correct complexity is tracked later
    }
  }

  private buildHistory(): Message[] { 
    return this.sql.exec(`SELECT role, parts, timestamp FROM messages ORDER BY timestamp DESC LIMIT ?`, this.maxHistoryMessages)
        .toArray()
        .reverse()
        .map(row => ({ role: row.role, parts: this.parse(row.parts), timestamp: row.timestamp }));
  }
  
  // ===== HTTP Handlers (Original D1/SQL Implementation) =====
  private async getHistory(): Promise<Response> { 
    // This uses the complete implementation from your previous snippet
    const msgs = this.sql.exec(`SELECT role, parts, timestamp FROM messages ORDER BY timestamp`).toArray();
    const parsedMsgs = msgs.map((row: any) => ({
      role: row.role as 'user' | 'model' | 'system',
      parts: this.parse(row.parts),
      timestamp: row.timestamp as number,
    }));
    
    return new Response(this.stringify({ messages: parsedMsgs }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  
  private async clearHistory(): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        this.sql.exec('DELETE FROM messages');
        this.sql.exec('DELETE FROM kv');
        this.sql.exec('DELETE FROM sqlite_sequence WHERE name IN (\'messages\')');
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
    return new Response(this.stringify({
      ...this.metrics,
      circuitBreaker: this.gemini.getCircuitBreakerStatus(),
    }), { headers: { 'Content-Type': 'application/json' } });
  }
}

export default AutonomousAgent;
