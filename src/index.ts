// src/index.ts
import type { Env } from './types';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // -------------------------------------------------
    // Proxy everything under /api/* to the DO
    // -------------------------------------------------
    if (url.pathname.startsWith('/api/')) {
      // Use a *singleton* DO instance called "agent".
      // For per-user sessions replace "agent" with a user id.
      const id = env.AGENT.idFromName('agent');
      const stub = env.AGENT.get(id);

      // Forward the original request unchanged.
      // For WebSocket upgrades the DO will return a 101 response
      // with the client side of the WebSocketPair – we just pass it through.
      return stub.fetch(request);
    }

    // -------------------------------------------------
    // Anything else → simple help page
    // -------------------------------------------------
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
