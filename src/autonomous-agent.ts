import { DurableObjectState } from '@cloudflare/workers-types';
import GeminiClient from '../utils/gemini';

interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export class AutonomousAgent {
  state: DurableObjectState;
  sessions: Record<string, SessionMessage[]> = {};
  gemini: GeminiClient;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });
  }

  async fetch(request: Request) {
    try {
      const url = new URL(request.url);

      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }

      const body = await request.json();
      const { sessionId, message } = body;

      if (!sessionId || !message) {
        return new Response('Missing sessionId or message', { status: 400 });
      }

      // Initialize session if missing
      if (!this.sessions[sessionId]) this.sessions[sessionId] = [];

      // Add user message
      this.sessions[sessionId].push({ role: 'user', content: message, timestamp: Date.now() });

      // Call GeminiClient for response
      const history = this.sessions[sessionId].map((m) => ({
        role: m.role,
        parts: [{ text: m.content }],
      }));

      let assistantReply = '';
      await this.gemini.streamResponse(message, history, (chunk) => {
        assistantReply += chunk;
      });

      // Save assistant response
      this.sessions[sessionId].push({ role: 'assistant', content: assistantReply, timestamp: Date.now() });

      // Persist sessions to Durable Object storage
      await this.state.storage.put('sessions', this.sessions);

      return new Response(
        JSON.stringify({ reply: assistantReply }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    } catch (err) {
      console.error('[AutonomousAgent] Error', err);
      return new Response(JSON.stringify({ error: err.message || 'Internal Error' }), { status: 500 });
    }
  }
}
