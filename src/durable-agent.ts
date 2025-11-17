// src/durable-agent.ts - FIXED based on working implementation
import { DurableObject } from 'cloudflare:workers';
import type { Env, Message, AgentConfig, StatusResponse } from './types';
import { Agent } from './agent-core';
import { GeminiClient } from './gemini';
import { D1Manager } from './storage/d1-manager';

export class AutonomousAgent extends DurableObject {
  private agent: Agent;
  private gemini: GeminiClient;
  private d1?: D1Manager;
  private sessionId: string;
  private env: Env;
  private activeWebSockets = new Set<WebSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    console.log('[DurableAgent] 🚀 Constructor called');
    
    this.env = env;
    this.sessionId = ctx.id.toString();
    console.log('[DurableAgent] 📝 Session ID:', this.sessionId);

    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });
    console.log('[DurableAgent] 🤖 Gemini client initialized');

    const config: AgentConfig = {
      model: 'gemini-2.0-flash-exp',
      temperature: 0.7,
      maxTokens: 8192,
      useSearch: false,
      useCodeExecution: false,
      enableMemory: false,
      maxHistoryMessages: 50,
    };
    this.agent = new Agent(this.gemini, config);
    console.log('[DurableAgent] 🧠 Agent initialized');

    if (env.DB) {
      this.d1 = new D1Manager(env.DB);
      console.log('[DurableAgent] 💾 D1 enabled');
    }
  }

  // ===== Main fetch handler =====
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    console.log('[DurableAgent] 📨 Fetch called, path:', path);

    // WebSocket upgrade
    if (path === '/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      console.log('[DurableAgent] 🔌 WebSocket upgrade detected');
      return this.handleWebSocketUpgrade(request);
    }

    // HTTP endpoints
    if (path === '/chat' && request.method === 'POST') {
      return this.handleChat(request);
    }
    if (path === '/history' && request.method === 'GET') {
      return this.getHistory();
    }
    if (path === '/clear' && request.method === 'POST') {
      return this.clearHistory();
    }
    if (path === '/status' && request.method === 'GET') {
      return this.getStatus();
    }

    console.log('[DurableAgent] ❌ Unknown path:', path);
    return new Response('Not found', { status: 404 });
  }

  // ===== WebSocket Handling =====
  private handleWebSocketUpgrade(request: Request): Response {
    console.log('[DurableAgent] 🔌 Creating WebSocket pair...');
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    // Accept the WebSocket (important for Cloudflare Workers)
    try {
      (server as any).accept?.();
      console.log('[DurableAgent] ✅ WebSocket accepted');
    } catch (e) {
      console.error('[DurableAgent] ❌ Failed to accept WebSocket:', e);
    }

    // Set up event handlers
    server.addEventListener('message', (evt: MessageEvent) => {
      console.log('[DurableAgent] 📨 Message received');
      this.ctx.waitUntil(
        this.handleWebSocketMessage(server, evt.data).catch(err => {
          console.error('[DurableAgent] ❌ Message handler error:', err);
        })
      );
    });

    server.addEventListener('close', (evt: CloseEvent) => {
      console.log('[DurableAgent] 🔌 WebSocket closed:', evt.code, evt.reason);
      this.activeWebSockets.delete(server);
    });

    server.addEventListener('error', (evt: Event) => {
      console.error('[DurableAgent] ❌ WebSocket error:', evt);
      this.activeWebSockets.delete(server);
    });

    this.activeWebSockets.add(server);
    console.log('[DurableAgent] ✅ WebSocket setup complete, active:', this.activeWebSockets.size);

    return new Response(null, { 
      status: 101, 
      webSocket: client 
    });
  }

  private async handleWebSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') {
      console.log('[DurableAgent] ⚠️ Non-string message received');
      return;
    }

    if (ws.readyState !== WebSocket.OPEN) {
      console.log('[DurableAgent] ⚠️ WebSocket not open');
      return;
    }

    console.log('[DurableAgent] 📨 Processing message:', message.substring(0, 100));

    let payload: any;
    try {
      payload = JSON.parse(message);
      console.log('[DurableAgent] 📦 Parsed payload type:', payload.type);
    } catch (e) {
      console.error('[DurableAgent] ❌ JSON parse error:', e);
      this.wsSend(ws, { type: 'error', error: 'Invalid JSON' });
      return;
    }

    // Handle both message formats: "message" and "user_message"
    const messageType = payload.type;
    const content = payload.content;

    if ((messageType === 'message' || messageType === 'user_message') && typeof content === 'string') {
      console.log('[DurableAgent] 💬 Processing chat message:', content.substring(0, 50));
      await this.processMessage(content, ws);
    } else {
      console.log('[DurableAgent] ❌ Invalid payload format');
      this.wsSend(ws, { type: 'error', error: 'Invalid payload format' });
    }
  }

  // ===== Message Processing =====
  private async processMessage(userMsg: string, ws: WebSocket | null): Promise<void> {
    console.log('[DurableAgent] 🔄 Processing message...');
    
    try {
      // Send status
      if (ws) this.wsSend(ws, { type: 'status', message: 'Processing your message...' });

      // Load history
      const history = await this.loadHistory();
      console.log('[DurableAgent] 📚 History loaded, length:', history.length);

      // Process with agent (with streaming)
      let fullResponse = '';
      const agentResponse = await this.agent.processMessage(
        userMsg,
        history,
        '',
        this.sessionId,
        (chunk: string) => {
          console.log('[DurableAgent] 📤 Chunk:', chunk.substring(0, 30));
          fullResponse += chunk;
          if (ws) this.wsSend(ws, { type: 'chunk', content: chunk });
        }
      );

      console.log('[DurableAgent] ✅ Processing complete, response length:', agentResponse.response.length);

      // Save history
      await this.saveHistory(agentResponse.conversationHistory);

      // Flush to D1 (background)
      if (this.d1) {
        this.ctx.waitUntil(
          this.flushToD1(agentResponse.conversationHistory)
        );
      }

      // Send completion
      if (ws) {
        this.wsSend(ws, { 
          type: 'done',
          turns: 1,
          totalLength: agentResponse.response.length
        });
      }

    } catch (error) {
      console.error('[DurableAgent] ❌ Processing error:', error);
      if (ws) {
        this.wsSend(ws, { 
          type: 'error', 
          error: error instanceof Error ? error.message : String(error)
        });
      }
      throw error;
    }
  }

  // ===== HTTP Handlers =====
  private async handleChat(request: Request): Promise<Response> {
    console.log('[DurableAgent] 💬 HTTP chat request');
    
    let message: string;
    try {
      const body = await request.json() as { message: string };
      message = body.message;
      if (!message) throw new Error('Missing message');
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid request' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Process in background
    this.ctx.waitUntil(
      this.processMessage(message, null).catch(err => {
        console.error('[DurableAgent] Background process failed:', err);
      })
    );

    return new Response(JSON.stringify({ status: 'queued' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async getHistory(): Promise<Response> {
    console.log('[DurableAgent] 📚 Get history request');
    const messages = await this.loadHistory();
    return new Response(JSON.stringify({ messages }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async clearHistory(): Promise<Response> {
    console.log('[DurableAgent] 🗑️ Clear history request');
    await this.ctx.storage.delete('history');
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async getStatus(): Promise<Response> {
    console.log('[DurableAgent] 📊 Status request');
    const history = await this.loadHistory();
    const config = this.agent.getConfig();

    const status: StatusResponse = {
      sessionId: this.sessionId,
      status: history.length > 0 ? 'active' : 'idle',
      messageCount: history.length,
      lastActivity: history.length > 0 ? history[history.length - 1].timestamp : 0,
      configuration: {
        model: config.model,
        memoryEnabled: false,
        d1Enabled: !!this.d1,
        vectorizeEnabled: false,
      },
    };

    return new Response(JSON.stringify(status), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ===== Storage Helpers =====
  private async loadHistory(): Promise<Message[]> {
    try {
      const stored = await this.ctx.storage.get<Message[]>('history');
      return stored || [];
    } catch (error) {
      console.error('[DurableAgent] Failed to load history:', error);
      return [];
    }
  }

  private async saveHistory(history: Message[]): Promise<void> {
    try {
      const trimmed = history.slice(-50);
      await this.ctx.storage.put('history', trimmed);
      console.log('[DurableAgent] 💾 History saved');
    } catch (error) {
      console.error('[DurableAgent] Failed to save history:', error);
    }
  }

  private async flushToD1(history: Message[]): Promise<void> {
    if (!this.d1) return;

    try {
      await this.d1.saveMessages(this.sessionId, history);
      await this.d1.updateSessionActivity(this.sessionId);
      console.log(`[DurableAgent] 💾 Flushed to D1`);
    } catch (error) {
      console.error('[DurableAgent] D1 flush failed:', error);
    }
  }

  // ===== WebSocket Utility =====
  private wsSend(ws: WebSocket | null, data: unknown): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(data));
    } catch (e) {
      console.error('[DurableAgent] WebSocket send failed:', e);
    }
  }

  // ===== RPC Methods for backwards compatibility =====
  async processMessageRPC(userMessage: string): Promise<string> {
    const history = await this.loadHistory();
    const agentResponse = await this.agent.processMessage(
      userMessage,
      history,
      '',
      this.sessionId
    );
    await this.saveHistory(agentResponse.conversationHistory);
    if (this.d1) {
      this.ctx.waitUntil(this.flushToD1(agentResponse.conversationHistory));
    }
    return agentResponse.response;
  }

  async getHistoryRPC(limit: number = 50): Promise<Message[]> {
    const history = await this.loadHistory();
    return history.slice(-limit);
  }

  async clearHistoryRPC(): Promise<void> {
    await this.ctx.storage.delete('history');
  }

  async getStatusRPC(): Promise<StatusResponse> {
    const history = await this.loadHistory();
    const config = this.agent.getConfig();
    return {
      sessionId: this.sessionId,
      status: history.length > 0 ? 'active' : 'idle',
      messageCount: history.length,
      lastActivity: history.length > 0 ? history[history.length - 1].timestamp : 0,
      configuration: {
        model: config.model,
        memoryEnabled: false,
        d1Enabled: !!this.d1,
        vectorizeEnabled: false,
      },
    };
  }

  async updateConfigRPC(config: Partial<AgentConfig>): Promise<void> {
    this.agent.updateConfig(config);
  }
}

export default AutonomousAgent;
