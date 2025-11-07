// src/autonomous-agent.ts - Performance Optimized with Mode Routing
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

// Updated AgentState to include the new routing properties
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
  private readonly COMPLEXITY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
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

  // ===== Utility Methods (Partial placeholders for completeness) =====

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

  // ===== Enhanced Complexity Analysis (Remains the same) =====

  private async analyzeComplexityEnhanced(query: string, hasFiles: boolean): Promise<TaskComplexity> {
    // Implementation remains the same as your working code
    const startTime = Date.now();
    try {
        const complexity = await this.gemini.analyzeComplexity(query, hasFiles);
        // Placeholder for complexity cache management if needed
        return complexity;
    } finally {
        // Placeholder for tracking
        this.trackRequest('simple', startTime); // Will be corrected by the subsequent complex/simple handlers
    }
  }

  // ===== State Management (Updated to handle new properties) =====

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
        conversationHistory: [], // Messages will be loaded from DB later
        context: { files: [], searchResults: [] },
        sessionId: this.ctx.id.toString(),
        lastActivityAt: Date.now(),
        currentPlan: undefined,
        autonomousMode: 'orchestrated' as AutonomousMode,
        currentPhase: AgentPhase.ASSESSMENT,
      } as AgentState;
    }
    
    // Ensure new properties exist on old state
    if (!state.autonomousMode) state.autonomousMode = 'orchestrated' as AutonomousMode;
    if (!state.currentPhase) state.currentPhase = AgentPhase.ASSESSMENT;

    // Placeholder for history loading from messages table
    // For simplicity, we'll keep history in memory for now based on your previous code structure
    // In a real-world app, this would be a join/load from the messages table.
    
    await this.checkMemoryPressure();
    return state;
  }

  private async saveState(state: AgentState): Promise<void> {
    // Only saving core state properties to 'kv' table
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
  private estimateHistorySize(history: Message[]): number { return history.length * 200; }
  private checkMemoryPressure(): Promise<void> { return Promise.resolve(); }
  private trimHistoryIfNeeded(state: AgentState): void { /* ... */ }

  // ===== WebSocket Management (Placeholders) =====
  private send(ws: WebSocket | null, msg: any) {
    if (ws && ws.readyState === WebSocket.READY_STATE_OPEN) {
      ws.send(this.stringify(msg));
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

  // ===== HTTP & WebSocket Handlers (Placeholders) =====

  async fetch(request: Request): Promise<Response> {
    // ... (HTTP request handling logic) ...
    // Placeholder implementation for simplicity
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/ws':
        if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 });
        const [client, server] = new WebSocketPair();
        this.ctx.acceptWebSocket(server);
        return new Response(null, { status: 101, webSocket: client });
      case '/history':
        return this.getHistory();
      case '/clear':
        return this.clearHistory();
      case '/status':
        return this.getStatus();
      default:
        return new Response('Not Found', { status: 404 });
    }
  }
  
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return;
    try {
      const msg = this.parse<any>(message);
      if (msg.type === 'user_message' && msg.content) {
        this.process(msg.content, ws).catch(e => this.webSocketError(ws, e));
      }
    } catch (e) {
      console.error('WS message error:', e);
      this.webSocketError(ws, new Error('Invalid message format'));
    }
  }

  webSocketClose(ws: WebSocket) { this.activeWebSockets.delete(ws); }
  webSocketError(ws: WebSocket, error: Error) { console.error('WS error:', error); this.activeWebSockets.delete(ws); }
  webSocketConnect(ws: WebSocket) { this.activeWebSockets.add(ws); }
  
  // ===== Core Processing Logic (Router) =====

  private async process(userMsg: string, ws: WebSocket | null): Promise<void> {
    return this.withStateTransaction(async (state) => {
      state.lastActivityAt = Date.now();

      if (userMsg.length > this.MAX_MESSAGE_SIZE) {
        if (ws) this.send(ws, { type: 'error', error: 'Message too large' });
        throw new Error('Message exceeds maximum size');
      }

      // Save user message (Placeholder)
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
        state.currentPhase = AgentPhase.ASSESSMENT; // Reset phase
        this.send(ws, { type: 'status', message: 'Switched to **Unified Autonomous Mode**.' });
        return; // State is saved by withStateTransaction
      }
      if (trimmedMsg === '/orchestrated') {
        state.autonomousMode = 'orchestrated';
        this.send(ws, { type: 'status', message: 'Switched to **Orchestrated (Default) Mode**.' });
        return; // State is saved by withStateTransaction
      }

      // --- Routing ---
      if (state.autonomousMode === 'unified') {
        // Every new message starts a new unified flow
        state.currentPhase = AgentPhase.ASSESSMENT;
        await this.handleUnified(userMsg, ws, state);
      } else {
        // The original, working "orchestrated" logic
        await this.handleOrchestrated(userMsg, ws, state);
      }
    });
  }

  private async handleOrchestrated(query: string, ws: WebSocket | null, state: AgentState): Promise<void> {
    // This is the original logic from your process() function
    const startTime = Date.now();
    const complexity = await this.analyzeComplexityEnhanced(
      query,
      (state.context?.files ?? []).length > 0
    );

    console.log(`[Complexity] ${complexity.type} - ${complexity.reasoning}`);

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
      console.error('Orchestrated process error:', e);
      if (ws) this.send(ws, { type: 'error', error: 'Orchestrated processing failed' });
      throw e;
    }
  }

  // --- START OF CORRECTION ---
  // The syntax error was fixed in this function.
  private async handleUnified(userMsg: string, ws: WebSocket | null, state: AgentState): Promise<void> {
    return this.withErrorContext('handleUnified', async () => {
      if (ws) this.send(ws, { type: 'status', message: 'Thinking... (Unified Mode)' });

      let currentMessage = userMsg;
      let loopGuard = 0;
      const MAX_LOOPS = 10; // Prevent infinite loops

      // We loop until the agent completes or needs clarification
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

        batcher.flush(); // Send any remaining text

        // Save the model's text response to history
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

        // 1. Handle Tool Calls
        if (result.toolCalls && result.toolCalls.length > 0) {
          if (ws) this.send(ws, { type: 'status', message: `Executing ${result.toolCalls.length} tool(s)...` });
          
          const toolResultsText: string[] = [];
          
          for (const call of result.toolCalls) {
            // !! CAVEAT !! (Placeholder for actual tool execution logic)
            let executionResult = `[Tool Call: ${call.tool} with params ${this.stringify(call.params)} - Execution not fully implemented in this hybrid model]`;
            
            toolResultsText.push(executionResult);
            if (ws) this.send(ws, { type: 'step_complete', step: call.tool, result: executionResult });
          }
          
          // Prepare for the next loop: feed the tool results back to the model
          state.currentPhase = AgentPhase.EXECUTION; // Stay in execution
          currentMessage = `[Tool Results]: \n${toolResultsText.join('\n')}\n\n[User]: Now, continue based on these results.`;
          
          // Save this "function" response to history so the model sees it
          try {
            this.sql.exec(
              `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
              'user', // Use 'user' role for a synthetic 'function' response to keep it simple
              this.stringify([{ text: currentMessage }]),
              Date.now()
            );
          } catch (e) { console.error('Failed to save tool result message:', e); }

          continue; // Go to the next loop iteration
        }

        // 2. Handle Phase Changes
        let newPhase = state.currentPhase;
        if (result.phaseChanges && result.phaseChanges.length > 0) {
          // Use the last phase change suggested by the model
          newPhase = result.phaseChanges[result.phaseChanges.length - 1]; 
        }
        
        // 3. Handle Clarifications
        if (result.clarificationRequests && result.clarificationRequests.length > 0) {
          newPhase = AgentPhase.CLARIFICATION;
        }
        
        state.currentPhase = newPhase; // Update state

        if (state.currentPhase === AgentPhase.COMPLETION || state.currentPhase === AgentPhase.CLARIFICATION) {
          break; // Exit loop
        }
        
        // If no tools and no completion, just loop (e.g., from ASSESSMENT to PLANNING)
        currentMessage = userMsg; // Re-use original message
      }

      if (loopGuard >= MAX_LOOPS) {
        this.send(ws, { type: 'error', error: 'Agent stuck in a loop (Unified Mode)' });
      }
      if (ws) this.send(ws, { type: 'done' });
    });
  }
  // --- END OF CORRECTION ---

  // ===== Simple Path (Placeholder) =====
  private async handleSimple(query: string, ws: WebSocket | null, state: AgentState): Promise<void> {
    // ... (Original working handleSimple logic using gemini.streamResponse) ...
    const history = this.buildHistory();
    const batcher = this.createChunkBatcher(ws, 'final_chunk');
    const finalResponse = await this.gemini.streamResponse(query, history, (chunk) => batcher.add(chunk));
    batcher.flush();
    // ...
  }

  // ===== Optimized Complex Path (Placeholder) =====
  private async handleComplexOptimized(query: string, complexity: TaskComplexity, ws: WebSocket | null, state: AgentState, options: StepExecutionOptions): Promise<void> {
    // ... (Original working handleComplexOptimized logic using gemini.generatePlanOptimized, executeStep, synthesize) ...
    // Placeholder for plan generation
    state.currentPlan = await this.gemini.generatePlanOptimized(query, complexity, (state.context?.files ?? []).length > 0);
    // Placeholder for execution loop
    // await this.executePlan(state.currentPlan, ws, state);
    // Placeholder for synthesis
    // await this.synthesize(query, executionResults, ws);
    // ...
  }
  
  // ===== Step Execution & Synthesis Helpers (Placeholders) =====
  private async executeStep(step: PlanStep, ws: WebSocket | null, state: AgentState): Promise<string> { return 'Placeholder result'; }
  private buildPrompt(step: PlanStep, state: AgentState): string { return step.description; }
  private buildHistory(): Message[] { 
    // Simplified history building for the agent's context
    return this.sql.exec(`SELECT role, parts FROM messages ORDER BY timestamp DESC LIMIT ?`, this.maxHistoryMessages)
        .toArray()
        .reverse()
        .map(row => ({ role: row.role, parts: this.parse(row.parts), timestamp: 0 }));
  }
  
  // ===== HTTP Handlers (Placeholders) =====
  private async getHistory(): Promise<Response> { return new Response(this.stringify({ messages: [] })); }
  private async clearHistory(): Promise<Response> { return new Response(this.stringify({ ok: true })); }
  private getStatus(): Response { return new Response(this.stringify({})); }
  private getMetrics(): Response { return new Response(this.stringify(this.metrics)); }
}

export default AutonomousAgent;
