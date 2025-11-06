import { AutonomousAgent } from './autonomous-agent';
import type { Env } from './types';

export { AutonomousAgent };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Route API calls under /api/*
    if (path.startsWith('/api/')) {
      try {
        // Fix: use AUTONOMOUS_AGENT instead of AGENT
        const id = env.AUTONOMOUS_AGENT.idFromName('default');
        const stub = env.AUTONOMOUS_AGENT.get(id);
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
