import { AutonomousAgent } from './agents/AutonomousAgent';

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Route API calls under /api/*
    if (path.startsWith('/api/')) {
      try {
        const id = env.AGENT.idFromName('default'); // Consider idFromName(sessionId) for multiple DOs
        const stub = env.AGENT.get(id);
        return await stub.fetch(request);
      } catch (err: any) {
        console.error('[Worker] DO fetch error:', err);
        return new Response(JSON.stringify({ error: err.message || 'Durable Object Error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Optional: root / health check
    return new Response(
      JSON.stringify({ status: 'ok', message: 'Autonomous Gemini Agent Worker running' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  },
};
