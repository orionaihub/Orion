// src/durable-agent.ts - Enhanced with Memory System
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Env, Message } from './types';
import { Agent } from './agent-core';
import { DurableStorage } from './durable-storage';
import { GeminiClient } from './gemini';
import { D1Manager } from './storage/d1-manager';
import { MemoryManager } from './memory/memory-manager';
import type { AgentConfig } from './agent-core';

export class AutonomousAgent {
  private storage: DurableStorage;
  private agent: Agent;
  private gemini: GeminiClient;
  private env: Env;
  private activeSockets = new Set<WebSocket>();
  private d1?: D1Manager;
  private memory?: MemoryManager;
  private sessionId?: string;
  private pendingFlush: Message[] = [];
  private flushScheduled = false;
  private memoryEnabled = true;

  constructor(state: DurableObjectState, env: Env) {
    this.env = env;
    this.storage = new DurableStorage(state);
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });

    if (env.DB) {
      this.d1 = new D1Manager(env.DB);
      console.log('[DurableAgent] D1 persistence enabled');
    }

    const config: AgentConfig = {
      maxHistoryMessages: 200,
      maxMessageSize: 100_000,
      maxTurns: 2,
      model: 'gemini-2.5-flash',
      thinkingBudget: 1024,
      temperature: 0.7,
      useSearch: true,
      useCodeExecution: true,
      useMapsGrounding: false,
      useVision: false,
    };

    this.agent = new Agent(this.gemini, config);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Extract session ID from header or query
    this.sessionId = request.headers.get('X-Session-ID') || url.searchParams.get('session_id') || undefined;

    // Initialize memory if we have session ID and vectorize
    if (this.sessionId && this.env.VECTORIZE && !this.memory) {
      this.memory = new MemoryManager(
        this.env.VECTORIZE,
        this.env.GEMINI_API_KEY,
        this.sessionId,
        {
          longTermEnabled: true,
          ltmThreshold: 0.65,
        }
      );
      console.log('[DurableAgent] Memory system initialized');
    }

    // If session ID provided and DO memory empty, hydrate from D1
    if (this.sessionId && this.d1 && this.storage.getMessages().length === 0) {
      await this.loadFromD1(this.sessionId);
    }

    // WebSocket upgrade
    if (url.pathname === '/api/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return this.handleWebSocketUpgrade(request);
    }

    // Chat endpoint
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      return this.handleChat(request);
    }

    // History endpoint
    if (url.pathname === '/api/history' && request.method === 'GET') {
      return this.getHistory();
    }

    // Clear history endpoint
    if (url.pathname === '/api/clear' && request.method === 'POST') {
      return this.clearHistory();
    }

    // Status endpoint
    if (url.pathname === '/api/status' && request.method === 'GET') {
      return this.getStatus();
    }

    // Manual sync endpoint
    if (url.pathname === '/api/sync' && request.method === 'POST') {
      return this.syncToD1();
    }

    // Memory endpoints
    if (url.pathname === '/api/memory/search' && request.method === 'POST') {
      return this.searchMemory(request);
    }

    if (url.pathname === '/api/memory/stats' && request.method === 'GET') {
      return this.getMemoryStats();
    }

    if (url.pathname === '/api/memory/summarize' && request.method === 'POST') {
      return this.summarizeSession();
    }

    return new Response('Not Found', { status: 404 });
  }

  async alarm(alarmInfo: { scheduledTime: number; retryCount: number; isRetry: boolean }): Promise<void> {
    console.log(`[DurableAgent] Alarm fired (retry=${alarmInfo.retryCount})`);
    const doState = this.storage.getDurableObjectState();
    await doState.storage.deleteAlarm();

    await this.storage.withTransaction(async (state) => {
      const history = this.storage.getMessages();
      const lastMsg = history[history.length - 1];
      const userMsg = lastMsg?.role === 'user' ? lastMsg.parts?.map(p => p.text).join('') ?? '' : '';

      try {
        // Build memory context
        let memoryContext = '';
        if (this.memory) {
          memoryContext = await this.memory.buildContext(userMsg);
        }

        const { response, completed } = await this.agent.run(
          userMsg || '',
          history,
          state,
          {
            onStatus: (m) => console.log('[Alarm]', m),
            onToolUse: (tools) => console.log('[Alarm] Tool use:', tools),
          }
        );

        if (response && completed) {
          await this.storage.saveMessage('model', [{ text: response }]);
          this.pendingFlush.push({
            role: 'model',
            parts: [{ text: response }],
            timestamp: Date.now(),
          });

          // Save to memory
          if (this.memory) {
            await this.saveToMemory('model', response);
          }

          await this.flushPendingToD1();
          console.log('[Alarm] Completed after resume');
        } else {
          const next = Date.now() + 5000;
          await doState.storage.setAlarm(next);
          console.log(`[Alarm] Rescheduled for ${new Date(next).toISOString()}`);
        }
      } catch (err) {
        console.error('[Alarm] Error:', err);
      }

      state.lastActivityAt = Date.now();
    });
  }

  private handleWebSocketUpgrade(request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    try {
      (server as any).accept?.();
    } catch (e) {
      console.error('WebSocket accept error', e);
    }

    server.onmessage = (evt) => {
      void this.webSocketMessage(server, evt.data).catch((err) =>
        console.error('[DurableAgent] WS message error:', err)
      );
    };

    server.onclose = () => {
      this.activeSockets.delete(server);
      console.log('[DurableAgent] WebSocket closed');
    };

    server.onerror = (evt) => {
      console.error('[DurableAgent] WebSocket error:', evt);
      this.activeSockets.delete(server);
    };

    this.activeSockets.add(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    if (typeof msg !== 'string' || ws.readyState !== WebSocket.OPEN) return;

    let payload: any;
    try {
      payload = JSON.parse(msg);
    } catch {
      return this.send(ws, { type: 'error', error: 'Invalid JSON' });
    }

    if (payload.type !== 'user_message' || typeof payload.content !== 'string') {
      this.send(ws, { type: 'error', error: 'Invalid message payload' });
      return;
    }

    const userMsg = payload.content;
    try {
      this.storage.getDurableObjectState().waitUntil?.(
        this.processMessage(userMsg, ws).catch((err) => {
          console.error('[DurableAgent] processMessage failed:', err);
          this.send(ws, { type: 'error', error: 'Processing failed' });
        })
      );
    } catch {
      void this.processMessage(userMsg, ws);
    }
  }

  private async processMessage(userMsg: string, ws: WebSocket | null): Promise<void> {
    return this.storage.withTransaction(async (state) => {
      state.lastActivityAt = Date.now();

      // Save user message to DO memory
      await this.storage.saveMessage('user', [{ text: userMsg }]);
      const messageRecord: Message = {
        role: 'user',
        parts: [{ text: userMsg }],
        timestamp: Date.now(),
      };
      this.pendingFlush.push(messageRecord);

      // Save to vector memory
      if (this.memory) {
        await this.saveToMemory('user', userMsg);
      }

      const history = this.storage.getMessages();

      // 🧠 Check for high-similarity LTM (like Python's threshold check)
      let shouldUseCachedResponse = false;
      let cachedResponse = '';
      
      if (this.memory) {
        ws && this.send(ws, { 
          type: 'status', 
          message: 'Searching memory for relevant context...' 
        });
        
        try {
          const memoryResult = await this.memory.buildEnhancedContext(userMsg, undefined, {
            includeSTM: true,
            includeLTM: true,
            maxSTMResults: 5,
            maxLTMResults: 3,
          });
          
          // If we found a very similar query (>90%), consider using cached response
          if (memoryResult.hasHighSimilarity && memoryResult.similarQuery) {
            const ltmResults = await this.memory.searchLongTermMemory(userMsg, 1);
            if (ltmResults.length > 0 && ltmResults[0].score >= 0.9) {
              // Check if there's a stored answer
              const storedAnswer = ltmResults[0].metadata?.answer;
              if (storedAnswer) {
                shouldUseCachedResponse = true;
                cachedResponse = storedAnswer;
                ws && this.send(ws, {
                  type: 'status',
                  message: `Found highly similar past query (${(ltmResults[0].score * 100).toFixed(1)}% match) - using optimized response...`,
                });
              }
            }
          }
        } catch (error) {
          console.error('[DurableAgent] Memory context building failed:', error);
        }
      }

      try {
        let finalResponse = '';
        let completed = false;
        
        // Use cached response if available (like Python's direct return)
        if (shouldUseCachedResponse && cachedResponse) {
          finalResponse = `[Based on similar past query]\n\n${cachedResponse}`;
          completed = true;
          
          // Stream the cached response
          if (ws) {
            const words = finalResponse.split(' ');
            for (const word of words) {
              this.send(ws, { type: 'chunk', content: word + ' ' });
              await new Promise(r => setTimeout(r, 10)); // Small delay for natural feel
            }
          }
          
          // Update LTM access stats
          if (this.memory) {
            const ltmResults = await this.memory.searchLongTermMemory(userMsg, 1);
            if (ltmResults.length > 0 && ltmResults[0].metadata?.id) {
              // Increment interaction count
              await this.memory.updateLongTermMemory({
                ...ltmResults[0].metadata,
                lastAccessed: Date.now(),
                interactions: (ltmResults[0].metadata.interactions || 0) + 1,
              });
            }
          }
        } else {
          // Normal agent execution with memory context
          const result = await this.agent.run(
            userMsg,
            history,
            state,
            {
              onChunk: (chunk) => ws && this.send(ws, { type: 'chunk', content: chunk }),
              onStatus: (status) => ws && this.send(ws, { type: 'status', message: status }),
              onToolUse: (tools) => ws && this.send(ws, { type: 'tool_use', tools }),
              onError: (error) => ws && this.send(ws, { type: 'error', error }),
              onDone: (batchTurns, len) => {
                ws && this.send(ws, { type: 'done', turns: batchTurns, length: len });
              },
            }
          );
          
          finalResponse = result.response;
          completed = result.completed;
        }

        if (completed) {
          await this.storage.saveMessage('model', [{ text: finalResponse }]);
          const modelRecord: Message = {
            role: 'model',
            parts: [{ text: finalResponse }],
            timestamp: Date.now(),
          };
          this.pendingFlush.push(modelRecord);

          // Save assistant response to memory
          if (this.memory) {
            await this.saveToMemory('model', finalResponse);
          }

          ws && this.send(ws, { type: 'complete', response: finalResponse });

          await this.flushPendingToD1();

          // Create long-term memory summary if session is significant
          // (Like Python's save_ltm after every 15 messages)
          if (this.memory && history.length > 0 && history.length % 15 === 0) {
            ws && this.send(ws, {
              type: 'status',
              message: 'Creating long-term memory summary...',
            });
            await this.maybeCreateLTM(history, userMsg, finalResponse);
          }
        } else {
          const next = Date.now() + 2000;
          await this.storage.getDurableObjectState().storage.setAlarm(next);
          ws && this.send(ws, {
            type: 'continuing',
            message: `Chaining next reasoning step in 2s...`,
          });
        }
      } catch (err) {
        console.error('[DurableAgent] processMessage error:', err);
        ws && this.send(ws, { type: 'error', error: String(err) });
      }
    });
  }

  // =============================================================
  // Memory Helper Methods
  // =============================================================

  private async saveToMemory(role: 'user' | 'model', content: string): Promise<void> {
    if (!this.memory || !this.sessionId) return;

    try {
      await this.memory.saveMemory({
        id: `${this.sessionId}_${Date.now()}_${role}`,
        content,
        metadata: {
          sessionId: this.sessionId,
          timestamp: Date.now(),
          role,
          importance: role === 'user' ? 0.8 : 0.7, // User messages slightly more important
        },
      });
    } catch (error) {
      console.error('[DurableAgent] Failed to save to memory:', error);
    }
  }

  private async maybeCreateLTM(
    history: Message[],
    lastQuery: string,
    lastResponse: string
  ): Promise<void> {
    if (!this.memory || !this.sessionId) return;

    try {
      // Get the last N messages for summarization
      const messagesToSummarize = history.slice(-15).map(m => ({
        role: m.role,
        content: m.parts?.map(p => (typeof p === 'string' ? p : p.text)).join(' ') || '',
      }));

      // Generate summary using Gemini (like Python's summarization)
      const summary = await this.memory.summarizeConversation(messagesToSummarize);
      
      // Extract key topics (like Python's topic extraction)
      const topics = await this.memory.extractImportantTopics(summary);

      // Extract all user queries from the batch
      const userQueries = messagesToSummarize
        .filter(m => m.role === 'user')
        .map(m => m.content)
        .join(' | ');

      // Create LTM entry (similar to Python's SessionDict)
      await this.memory.addLongTermMemory({
        id: `ltm_${this.sessionId}_${Date.now()}`,
        sessionId: this.sessionId,
        query: userQueries || lastQuery,
        summary,
        importance: this.calculateImportance(summary, topics),
        timestamp: Date.now(),
        interactions: 1,
        lastAccessed: Date.now(),
        // Store the last response for potential reuse
        answer: lastResponse,
        topics: topics.join(', '),
      } as any);

      console.log('[DurableAgent] Created LTM summary with topics:', topics);
    } catch (error) {
      console.error('[DurableAgent] Failed to create LTM:', error);
    }
  }

  private calculateImportance(summary: string, topics: string[]): number {
    // Calculate importance score based on:
    // 1. Length of summary (longer = more detailed = more important)
    // 2. Number of topics (more topics = more comprehensive)
    // 3. Presence of certain keywords
    
    let score = 0.5; // Base score
    
    // Adjust for summary length
    if (summary.length > 500) score += 0.2;
    else if (summary.length > 200) score += 0.1;
    
    // Adjust for topic count
    score += Math.min(topics.length * 0.05, 0.2);
    
    // Check for important keywords
    const importantKeywords = [
      'error', 'bug', 'fix', 'solution', 'problem',
      'deploy', 'production', 'critical', 'important',
      'api', 'database', 'configuration', 'setup'
    ];
    
    const lowerSummary = summary.toLowerCase();
    const keywordMatches = importantKeywords.filter(kw => 
      lowerSummary.includes(kw)
    ).length;
    
    score += Math.min(keywordMatches * 0.05, 0.15);
    
    // Ensure score is between 0.5 and 1.0
    return Math.min(Math.max(score, 0.5), 1.0);
  }

  // =============================================================
  // Memory API Endpoints
  // =============================================================

  private async searchMemory(request: Request): Promise<Response> {
    if (!this.memory) {
      return new Response(
        JSON.stringify({ error: 'Memory system not available' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    try {
      const body = await request.json() as { query: string; topK?: number };
      const results = await this.memory.searchMemory(body.query, {
        topK: body.topK || 10,
      });

      return new Response(JSON.stringify({ results }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({ error: String(error) }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  private async getMemoryStats(): Promise<Response> {
    if (!this.memory) {
      return new Response(
        JSON.stringify({ error: 'Memory system not available' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    try {
      const stats = await this.memory.getMemoryStats();
      return new Response(JSON.stringify(stats), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({ error: String(error) }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  private async summarizeSession(): Promise<Response> {
    if (!this.memory) {
      return new Response(
        JSON.stringify({ error: 'Memory system not available' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    try {
      const history = this.storage.getMessages();
      const messages = history.map(m => ({
        role: m.role,
        content: m.parts?.map(p => (typeof p === 'string' ? p : p.text)).join(' ') || '',
      }));

      const summary = await this.memory.summarizeConversation(messages);
      const topics = await this.memory.extractImportantTopics(summary);

      return new Response(
        JSON.stringify({ summary, topics }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    } catch (error) {
      return new Response(
        JSON.stringify({ error: String(error) }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  // =============================================================
  // Existing Methods (unchanged)
  // =============================================================

  private async flushPendingToD1(): Promise<void> {
    if (!this.d1 || !this.sessionId || this.pendingFlush.length === 0) {
      this.pendingFlush = [];
      return;
    }

    if (this.flushScheduled) return;
    this.flushScheduled = true;

    try {
      await this.d1.saveMessages(this.sessionId, this.pendingFlush);
      console.log(`[DurableAgent] Flushed ${this.pendingFlush.length} messages to D1`);
      this.pendingFlush = [];
      await this.d1.updateSessionActivity(this.sessionId);
    } catch (err) {
      console.error('[DurableAgent] D1 flush failed:', err);
    } finally {
      this.flushScheduled = false;
    }
  }

  private async loadFromD1(sessionId: string): Promise<void> {
    if (!this.d1) return;

    try {
      const session = await this.d1.getSession(sessionId);
      if (!session) {
        await this.d1.createSession(sessionId, 'New Session');
      }

      const messages = await this.d1.loadMessages(sessionId, 200);
      console.log(`[DurableAgent] Loaded ${messages.length} messages from D1`);

      for (const msg of messages) {
        await this.storage.saveMessage(msg.role as any, msg.parts, msg.timestamp);
      }

      await this.d1.updateSessionActivity(sessionId);
    } catch (err) {
      console.error('[DurableAgent] D1 load failed:', err);
    }
  }

  private async syncToD1(): Promise<Response> {
    if (!this.d1 || !this.sessionId) {
      return new Response(
        JSON.stringify({ error: 'D1 not configured or no session ID' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    try {
      const localMessages = this.storage.getMessages();
      const latestRemoteTs = await this.d1.getLatestMessageTimestamp(this.sessionId);
      const toSync = localMessages.filter(m => (m.timestamp ?? 0) > (latestRemoteTs ?? 0));
      await this.d1.saveMessages(this.sessionId, toSync);

      return new Response(
        JSON.stringify({ ok: true, synced: toSync.length, sessionId: this.sessionId }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    } catch (err) {
      console.error('[DurableAgent] Sync failed:', err);
      return new Response(
        JSON.stringify({ error: String(err) }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  private async handleChat(req: Request): Promise<Response> {
    try {
      const body = (await req.json()) as { message: string };
      const message = body.message?.trim();
      if (!message) throw new Error('Missing message');

      this.storage.getDurableObjectState().waitUntil?.(
        this.processMessage(message, null).catch(console.error)
      );

      return new Response(
        JSON.stringify({
          status: 'queued',
          note: 'Response generation will continue via alarms',
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid request' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  private getHistory(): Response {
    const messages = this.storage.getMessages();
    return new Response(
      JSON.stringify({ messages }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  private async clearHistory(): Promise<Response> {
    await this.storage.clearAll();
    try {
      await this.storage.getDurableObjectState().storage.deleteAlarm();
    } catch {}
    
    // Clear memory as well
    if (this.memory) {
      await this.memory.clearSessionMemory();
    }
    
    this.pendingFlush = [];
    return new Response(
      JSON.stringify({ ok: true }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  private getStatus(): Response {
    const storageStatus = this.storage.getStatus();
    const config = this.agent.getConfig();
    const circuit = this.gemini.getCircuitBreakerStatus?.() || { healthy: true };
    const doState = this.storage.getDurableObjectState();
    const nextAlarm = doState.storage.getAlarm?.();

    return new Response(
      JSON.stringify({
        ...storageStatus,
        agentConfig: {
          model: config.model,
          maxTurns: config.maxTurns,
          useSearch: config.useSearch,
          useCodeExecution: config.useCodeExecution,
          note: 'Alarms used for chaining under CPU limits',
        },
        circuitBreaker: circuit,
        currentAlarm: nextAlarm ? new Date(nextAlarm).toISOString() : null,
        cpuLimit: '10 ms per invocation (Cloudflare Free plan)',
        d1Status: {
          enabled: !!this.d1,
          sessionId: this.sessionId || null,
          pendingFlush: this.pendingFlush.length,
        },
        memoryStatus: {
          enabled: !!this.memory,
          vectorizeAvailable: !!this.env.VECTORIZE,
        },
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  private send(ws: WebSocket | null, data: unknown): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(data));
    } catch (e) {
      console.error('[DurableAgent] WS send error:', e);
    }
  }
}

export default AutonomousAgent;
