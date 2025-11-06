import { DurableObjectState } from '@cloudflare/workers-types';
import GeminiClient from '../utils/gemini';

interface SessionMessage {
role: 'user' | 'assistant';
content: string;
timestamp: number;
}

interface Env {
GEMINI_API_KEY: string;
}

export class AutonomousAgent {
state: DurableObjectState;
sessions: Record<string, SessionMessage[]> = {};
gemini: GeminiClient;

constructor(state: DurableObjectState, env: Env) {
this.state = state;
this.gemini = new GeminiClient(env.GEMINI_API_KEY);
}

async fetch(request: Request) {
try {
if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const { sessionId, message } = await request.json();
  if (!sessionId || !message) return new Response('Missing sessionId or message', { status: 400 });

  // Load persisted sessions if empty
  if (!this.sessions[sessionId]) {
    const stored = (await this.state.storage.get('sessions')) as Record<string, SessionMessage[]> | undefined;
    this.sessions = stored || {};
    if (!this.sessions[sessionId]) this.sessions[sessionId] = [];
  }

  // Add user message
  this.sessions[sessionId].push({ role: 'user', content: message, timestamp: Date.now() });

  // Convert to Gemini chat history format
  const history = this.sessions[sessionId].map((m) => ({ role: m.role, parts: [{ text: m.content }] }));

  // Stream assistant response
  let assistantReply = '';
  await this.gemini.streamResponse(message, history, (chunk) => {
    assistantReply += chunk;
  });

  // Save assistant response
  this.sessions[sessionId].push({ role: 'assistant', content: assistantReply, timestamp: Date.now() });

  // Persist sessions
  await this.state.storage.put('sessions', this.sessions);

  return new Response(
    JSON.stringify({ reply: assistantReply }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
} catch (err: any) {
  console.error('[AutonomousAgent] Error', err);
  return new Response(
    JSON.stringify({ error: err.message || 'Internal Error' }),
    { status: 500, headers: { 'Content-Type': 'application/json' } }
  );
}

}
}
