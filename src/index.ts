import { AutonomousAgent } from './agents/AutonomousAgent';

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Route API calls under /api/*
    if (path.startsWith('/api/')) {
      // Get Durable Object stub
      const id = env.AGENT.idFromName('default');
      const stub = env.AGENT.get(id);

      // Forward request to DO
      return stub.fetch(request);
    }

    // Optional: fallback response for root path
    return new Response(
      JSON.stringify({ status: 'ok', message: 'Autonomous Gemini Agent Worker running' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  },
};
