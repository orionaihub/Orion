// src/index.ts

// Re-export the Durable Object class
export { AutonomousAgent } from './autonomous-agent';

// Your main Worker logic
import type { Env } from './types';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Proxy /api/* to the Durable Object
    if (url.pathname.startsWith('/api/')) {
      const id = env.AGENT.idFromName('agent');
      const stub = env.AGENT.get(id);
      return stub.fetch(request);
    }

    return new Response(
      'Autonomous Agent API\n' +
      '• WebSocket: /api/ws\n' +
      '• HTTP chat: POST /api/chat { "message": "…" }\n' +
      '• History: GET /api/history\n' +
      '• Clear: POST /api/clear\n' +
      '• Status: GET /api/status',
      { status: 200 }
    );
  },
} satisfies ExportedHandler<Env>;
