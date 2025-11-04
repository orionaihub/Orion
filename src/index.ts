// src/index.ts
export { AutonomousAgent } from './autonomous-agent';

import type { Env } from './types';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const id = env.AGENT.idFromName('agent');
      return env.AGENT.get(id).fetch(request);
    }
    return new Response('Use /api/*', { status: 200 });
  },
} satisfies ExportedHandler<Env>;
