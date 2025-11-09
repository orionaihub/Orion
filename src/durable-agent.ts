// src/durable-agent.ts - Durable Object Integration
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Env, Message } from './types';
import { Agent } from './agent-core';
import { DurableStorage } from './durable-storage';
import { GeminiClient } from './gemini';
import type { AgentConfig } from './agent-core';

/**
 * Durable Object wrapper for the Agent
 * Handles HTTP/WebSocket interface and persistence
 */
export class AutonomousAgent {
  private storage: DurableStorage;
  private agent: Agent;
  private gemini: GeminiClient;
  private env: Env;
  private activeWebSockets = new Set<WebSocket>();

  constructor(state: DurableObjectState, env: Env) {
    this.env = env;
    this.storage = new DurableStorage(state);
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });

    // Initialize agent with default config
    const config: AgentConfig = {
      maxHistoryMessages: 200,
      maxMessageSize: 100_000,
      maxTurns: 8,
      model: 'gemini-2.5-flash',
      useSearch: true,
      useCodeExecution: true,
    };

    this.agent = new Agent(this.gemini, config);

    // Register any external tools here
    // Example: this.agent.registerTool(myCustomTool);
  }

  // ===== HTTP Fetch Handler =====

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade
    if (
      url.pathname === '/api/ws' &&
      request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
    ) {
      return this.handleWebSocketUpgrade(request);
    }

    // HTTP endpoints
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      return this.handleChat(request);
    }
    if (url.pathname === '/api/history' && request.method === 'GET') {
      return this.getHistory();
    }
    if (url.pathname === '/api/clear' && request.method === 'POST') {
      return this.clearHistory();
    }
    if (url.pathname === '/api/status' && request.method === 'GET') {
      return this.getStatus();
    }

    return new Response('Not found', { status: 404 });
  }

  // ===== WebSocket Handling =====

  private handleWebSocketUpgrade(request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    try {
      (server as any).accept?.();
    } catch (e) {
      console.error('[DurableAgent] Failed to accept websocket:', e);
    }

    server.onmessage = (evt: MessageEvent) => {
      void this.webSocketMessage(server, evt.data).catch(err => {
        console.error('[DurableAgent] webSocketMessage error:', err);
      });
    };

    server.onclose = (evt: CloseEvent) => {
      void this.webSocketClose(server, evt.code, evt.reason).catch(err => {
        console.error('[DurableAgent] webSocketClose error:', err);
      });
    };

    server.onerror = (evt: Event | ErrorEvent) => {
      void this.webSocketError(server, evt).catch(err => {
        console.error('[DurableAgent] webSocketError error:', err);
      });
    };

    this.activeWebSockets.add(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    let payload: any;
    try {
      payload = JSON.parse(message);
    } catch {
      this.send(ws, { type: 'error', error: 'Invalid JSON' });
      return;
    }

    if (payload.type === 'user_message' && typeof payload.content === 'string') {
      try {
        this.storage.getDurableObjectState().waitUntil(
          this.processMessage(payload.content, ws).catch(err => {
            console.error('[DurableAgent] Background process failed:', err);
            this.send(ws, { type: 'error', error: 'Processing failed' });
          })
        );
      } catch (e) {
        // Fallback if waitUntil not available
        void this.processMessage(payload.content, ws).catch(err => {
          console.error('[DurableAgent] Background process failed:', err);
          this.send(ws, { type: 'error', error: 'Processing failed' });
        });
      }
    } else {
      this.send(ws, { type: 'error', error: 'Invalid payload' });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    console.log(`[DurableAgent] WebSocket closed: ${code} - ${reason}`);
    this.activeWebSockets.delete(ws);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('[DurableAgent] WebSocket error:', error);
    this.activeWebSockets.delete(ws);
  }

  // ===== Message Processing =====

  private async processMessage(userMsg: string, ws: WebSocket | null): Promise<void> {
    return this.storage.withTransaction(async state => {
      state.lastActivityAt = Date.now();

      try {
        // Save user message
        await this.storage.saveMessage('user', [{ text: userMsg }]);

        // Get conversation history
        const history = this.storage.getMessages();

        // Process through agent
        const { response, turns } = await this.agent.processMessage(
          userMsg,
          history,
          state,
          {
            onChunk: (chunk: string) => {
              if (ws) this.send(ws, { type: 'chunk', content: chunk });
            },
            onStatus: (message: string) => {
              if (ws) this.send(ws, { type: 'status', message });
            },
            onToolUse: (tools: string[]) => {
              if (ws) this.send(ws, { type: 'tool_use', tools });
            },
            onError: (error: string) => {
              if (ws) this.send(ws, { type: 'error', error });
            },
            onDone: (turns: number, totalLength: number) => {
              if (ws) this.send(ws, { type: 'done', turns, totalLength });
            },
          }
        );

        // Save model response
        if (response) {
          await this.storage.saveMessage('model', [{ text: response }]);
        }

        // If no response was collected, still signal completion
        if (!response && ws) {
          this.send(ws, { type: 'chunk', content: '[Task completed]' });
          this.send(ws, { type: 'done', turns, totalLength: 0 });
        }
      } catch (e) {
        console.error('[DurableAgent] Process error:', e);
        if (ws) this.send(ws, { type: 'error', error: String(e) });
        throw e;
      }
    });
  }

  // ===== HTTP Handlers =====

  private async handleChat(req: Request): Promise<Response> {
    let message: string;
    try {
      const body = (await req.json()) as { message: string };
      message = body.message;
      if (!message) throw new Error('Missing message');
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid request' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      this.storage.getDurableObjectState().waitUntil(
        this.processMessage(message, null).catch(err => {
          console.error('[DurableAgent] Background process failed:', err);
        })
      );
    } catch (e) {
      // Fallback
      void this.processMessage(message, null).catch(err => {
        console.error('[DurableAgent] Background process failed:', err);
      });
    }

    return new Response(JSON.stringify({ status: 'queued' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private getHistory(): Response {
    const messages = this.storage.getMessages();
    return new Response(JSON.stringify({ messages }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async clearHistory(): Promise<Response> {
    await this.storage.clearAll();
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private getStatus(): Response {
    const storageStatus = this.storage.getStatus();
    const agentConfig = this.agent.getConfig();
    const circuitBreaker = this.gemini.getCircuitBreakerStatus();

    return new Response(
      JSON.stringify({
        ...storageStatus,
        agentConfig: {
          model: agentConfig.model,
          maxTurns: agentConfig.maxTurns,
          useSearch: agentConfig.useSearch,
          useCodeExecution: agentConfig.useCodeExecution,
        },
        circuitBreaker,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  // ===== WebSocket Utilities =====

  private send(ws: WebSocket | null, data: unknown): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(data));
    } catch (e) {
      console.error('[DurableAgent] WebSocket send failed:', e);
    }
  }
}

export default AutonomousAgent;
