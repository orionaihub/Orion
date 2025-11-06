import { DurableObjectState } from '@cloudflare/workers-types';
import GeminiClient from '../utils/gemini';

interface SessionMessage {
role: 'user' | 'assistant';
content: string;
timestamp: number;
}

export class AutonomousAgent {
state: DurableObjectState;
gemini: GeminiClient;
MAX_HISTORY = 20;

constructor(state: DurableObjectState, env: any) {
this.state = state;
this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });
}

private async loadSession(sessionId: string): Promise<SessionMessage[]> {
return (await this.state.storage.get<SessionMessage[]>("sessions/${sessionId}")) ?? [];
}

private async saveSession(sessionId: string, session: SessionMessage[]) {
await this.state.storage.put("sessions/${sessionId}", session);
}

private truncateHistory(session: SessionMessage[]): SessionMessage[] {
return session.slice(-this.MAX_HISTORY);
}

async fetch(request: Request) {
if (request.method !== 'POST') {
return new Response('Method Not Allowed', { status: 405 });
}

try {
  const { sessionId, message } = await request.json();
  if (!sessionId || !message) {
    return new Response('Missing sessionId or message', { status: 400 });
  }

  // Load session
  let session = await this.loadSession(sessionId);
  session.push({ role: 'user', content: message, timestamp: Date.now() });

  // Truncated history for context
  const history = this.truncateHistory(session).map((m) => ({
    role: m.role,
    parts: [{ text: m.content }],
  }));

  let assistantReply = '';

  // Analyze complexity
  const complexity = await this.gemini.analyzeComplexity(message, false);

  if (complexity.type === 'complex') {
    // Multi-step execution
    const plan = await this.gemini.generatePlan(message, complexity, false);
    const stepResults: Array<{ description: string; result: string }> = [];

    for (const step of plan.steps) {
      let result = '[Step failed]';
      try {
        // Map step actions to tools
        const config = {
          useSearch: step.action === 'search',
          useCodeExecution: step.action === 'code_execute',
          files: [],       // Add file references if needed
          urlList: [],     // Add URLs if needed
          functionCalls: [], // Add function call definitions
          allowComputerUse: step.action === 'code_execute',
          useMapsGrounding: step.action === 'research',
        };

        result = await this.gemini.executeWithConfig(step.description, history, config);
      } catch (err: any) {
        console.error(`[Step ${step.id} failed]`, err);
        result = `[Error]: ${err.message}`;
      }
      stepResults.push({ description: step.description, result });
    }

    // Synthesize final answer
    assistantReply = await this.gemini.synthesize(message, stepResults, history);
  } else {
    // Simple query → stream response to client
    const stream = new ReadableStream({
      async start(controller) {
        await this.gemini.streamResponse(message, history, (chunk) => {
          controller.enqueue(new TextEncoder().encode(chunk));
          assistantReply += chunk;
        });
        controller.close();
      }.bind(this),
    });

    // Save assistant reply after streaming completes
    session.push({ role: 'assistant', content: assistantReply, timestamp: Date.now() });
    await this.saveSession(sessionId, session);

    return new Response(stream, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // Save assistant reply for complex queries
  session.push({ role: 'assistant', content: assistantReply, timestamp: Date.now() });
  await this.saveSession(sessionId, session);

  return new Response(JSON.stringify({ reply: assistantReply }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
} catch (err: any) {
  console.error('[AutonomousAgent] Error:', err);
  return new Response(JSON.stringify({ error: err.message || 'Internal Error' }), { status: 500 });
}

}
}

export default AutonomousAgent;
