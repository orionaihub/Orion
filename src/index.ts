import { AutonomousAgent } from './autonomous-agent';
import type { Env } from './types';

export { AutonomousAgent };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const id = env.AGENT.idFromName('singleton');
      const obj = env.AGENT.get(id);
      return obj.fetch(request);
    }
    return new Response('Use /api/ws, /api/chat, /api/history', { status: 200 });
  },
} satisfies ExportedHandler<Env>;
