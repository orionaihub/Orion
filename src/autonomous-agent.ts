// src/autonomous-agent.ts - Performance Optimized with Mode Routing
import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import GeminiClient from './utils/gemini';
import type {
  Env,
  AgentState as OriginalAgentState, // Rename original
  Message,
  ExecutionPlan,
  PlanStep,
  TaskComplexity,
  FileMetadata,
  AgentPhase, // <-- NEW: Import AgentPhase
} from './types';

// ... (SqlStorage, StepExecutionOptions, Metrics interfaces remain the same) ...

// --- NEW: Updated AgentState ---
interface AgentState extends OriginalAgentState {
  // All original properties from types.ts are included
  // Plus these new ones for routing:
  autonomousMode: 'orchestrated' | 'unified';
  currentPhase: AgentPhase; // Tracks state for unified mode
}

export class AutonomousAgent extends DurableObject<Env> {
  // ... (All original properties: sql, gemini, maxHistoryMessages, etc. remain) ...

  constructor(state: DurableObjectState, env: Env) {
    // ... (Original constructor remains the same) ...
  }

  // ... (Utility Methods: parse, stringify, withErrorContext, trackRequest remain the same) ...

  // ===== Enhanced Complexity Analysis =====
  // ... (analyzeComplexityEnhanced remains the same) ...

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
        conversationHistory: [], // This is not how it's stored, but matches original
        context: { files: [], searchResults: [] },
        sessionId: this.ctx?.id?.toString ? this.ctx.id.toString() : Date.now().toString(),
        lastActivityAt: Date.now(),
        currentPlan: undefined,
        // --- NEW: Default values ---
        autonomousMode: 'orchestrated', // Default to working mode
        currentPhase: 'ASSESSMENT',
      } as AgentState;
    }
    
    // Ensure new properties exist on old state
    if (!state.autonomousMode) state.autonomousMode = 'orchestrated';
    if (!state.currentPhase) state.currentPhase = 'ASSESSMENT';

    await this.checkMemoryPressure();
    return state;
  }

  // ... (saveState, withStateTransaction remain the same) ...

  // ... (Memory Management: estimateHistorySize, checkMemoryPressure, trimHistoryIfNeeded remain the same) ...

  // ... (WebSocket Management: send, createChunkBatcher remain the same) ...

  // ... (HTTP Fetch Handler: fetch remains the same) ...

  // ... (WebSocket Handlers: webSocketMessage, webSocketClose, webSocketError remain the same) ...
  // webSocketMessage will call process(), which now handles routing.

  // ===== Core Processing Logic =====

  /**
   * NEW: This function is now a router.
   * It directs traffic to either the original orchestrated logic
   * or the new unified autonomous logic based on agent state.
   */
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

      // --- NEW: Mode Switching Commands ---
      const trimmedMsg = userMsg.trim().toLowerCase();
      if (trimmedMsg === '/unified') {
        state.autonomousMode = 'unified';
        state.currentPhase = 'ASSESSMENT'; // Reset phase
        this.send(ws, { type: 'status', message: 'Switched to Unified Autonomous Mode.' });
        await this.saveState(state); // Save immediately
        return;
      }
      if (trimmedMsg === '/orchestrated') {
        state.autonomousMode = 'orchestrated';
        this.send(ws, { type: 'status', message: 'Switched to Orchestrated (Default) Mode.' });
        await this.saveState(state); // Save immediately
        return;
      }

      // --- NEW: Routing ---
      if (state.autonomousMode === 'unified') {
        // Every new message starts a new unified flow
        state.currentPhase = 'ASSESSMENT';
        await this.handleUnified(userMsg, ws, state);
      } else {
        // The original, working "orchestrated" logic
        await this.handleOrchestrated(userMsg, ws, state);
      }
    });
  }

  /**
   * NEW: This function contains the original "process" logic
   * for the orchestrated, multi-step agent.
   */
  private async handleOrchestrated(query: string, ws: WebSocket | null, state: AgentState): Promise<void> {
    // This is the original logic from your process() function
    const complexity = await this.analyzeComplexityEnhanced(
      query,
      (state.context?.files ?? []).length > 0
    );

    console.log(`[Complexity] ${complexity.type} - ${complexity.reasoning}`);

    try {
      if (complexity.type === 'simple') {
        await this.handleSimple(query, ws, state);
      } else {
        await this.handleComplexOptimized(query, complexity, ws, state, {
          continueOnFailure: false,
          maxRetries: 2,
          parallelExecution: false,
        });
      }
    } catch (e) {
      console.error('Orchestrated process error:', e);
      if (ws) this.send(ws, { type: 'error', error: 'Processing failed' });
      throw e;
    }
  }

  /**
   * NEW: This function handles the "Unified Autonomous" flow.
   * It calls the new gemini function and manages the phase loop.
   */
  private async handleUnified(userMsg: string, ws: WebSocket | null, state: AgentState): Promise<void> {
    return this.withErrorContext('handleUnified', async () => {
      if (ws) this.send(ws, { type: 'status', message: 'Thinking... (Unified Mode)' });

      let currentMessage = userMsg;
      let loopGuard = 0;
      const MAX_LOOPS = 10; // Prevent infinite loops

      // We loop until the agent completes or needs clarification
      while (
        state.currentPhase !== 'COMPLETION' &&
        state.currentPhase !== 'CLARIFICATION' &&
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
            currentPhase: state.currentPhase as AgentPhase,
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
            // !! CAVEAT !!
            // This is where the unified model shows its weakness. It doesn't
            // have the 'PlanStep' logic of the orchestrated agent.
            // We must map the tool name (e.g., 'googleSearch') to our
            // execution logic. This is a simple placeholder.
            
            let executionResult = `[Tool Call: ${call.tool} with params ${JSON.stringify(call.params)} - Execution not fully implemented in this hybrid model]`;
            
            // TODO: Add logic here to map call.tool (e.g., "googleSearch")
            // to the actual tool execution, similar to `executeStep`.
            
            toolResultsText.push(executionResult);
            if (ws) this.send(ws, { type: 'step_complete', step: call.tool, result: executionResult });
          }
          
          // Prepare for the next loop: feed the tool results back to the model
          state.currentPhase = 'EXECUTION'; // Stay in execution
          currentMessage = `[Tool Results]: \n${toolResultsText.join('\n')}\n\n[User]: Now, continue based on these results.`;
          
          // Save this "function" response to history so the model sees it
          try {
            this.sql.exec(
              `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
              'user', // Pretend it's a "function" role
              this.stringify([{ text: currentMessage }]),
              Date.now()
            );
          } catch (e) { console.error('Failed to save tool result message:', e); }

          continue; // Go to the next loop iteration
        }

        // 2. Handle Phase Changes
        let newPhase = state.currentPhase;
        if (result.phaseChanges && result.phaseChanges.length > 0) {
          newPhase = result.phaseChanges[result.phaseChanges.length - 1]; [cite_start]//[span_18](end_span)[span_19](end_span)
        }
        
        // 3. Handle Clarifications
        [span_20](start_span)[span_21](start_span)if (result.clarificationRequests && result.clarificationRequests.length > 0) {[span_20](end_span)[span_21](end_span)
          newPhase = 'CLARIFICATION';
        }
        
        state.currentPhase = newPhase as AgentPhase; // Update state

        if (state.currentPhase === 'COMPLETION' || state.currentPhase === 'CLARIFICATION') {
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

  // ===== Simple Path =====
  // ... (handleSimple remains the same) ...

  // ===== Optimized Complex Path =====
  // ... (handleComplexOptimized remains the same) ...

  // ... (Plan Optimization: optimizePlan remains the same) ...

  // ... (Step Execution: executeStep, buildPrompt remain the same) ...

  // ... (Synthesis: synthesize remains the same) ...

  // ... (History Building: buildHistory remains the same) ...

  // ... (HTTP Handlers: handleChat, getHistory, clearHistory, getStatus, getMetrics remain the same) ...
}

export default AutonomousAgent;
