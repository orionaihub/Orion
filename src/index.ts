// src/index.ts - Worker Entry Point (Refactored)
import { AutonomousAgent } from './durable-agent';
import type { Env } from './types';

export { AutonomousAgent };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Route API calls to Durable Object
    if (path.startsWith('/api/')) {
      try {
        // Use a single DO instance for simplicity, or implement session-based routing
        const id = env.AGENT.idFromName('default');
        const stub = env.AGENT.get(id);
        return await stub.fetch(request);
      } catch (err: any) {
        console.error('[Worker] DO fetch error:', err);
        return new Response(
          JSON.stringify({ error: err.message || 'Durable Object Error' }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
    }

    // Health check endpoint
    if (path === '/' || path === '/health') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          message: 'Autonomous Gemini Agent Worker running',
          version: '2.0.0-refactored',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    return new Response('Not found', { status: 404 });
  },
};
