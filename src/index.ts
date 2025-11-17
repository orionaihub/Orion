// src/index.ts - FIXED with proper path forwarding
import { AutonomousAgent } from './durable-agent';
import type { Env } from './types';
import { D1Manager } from './storage/d1-manager';

export { AutonomousAgent };

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Session-ID',
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    console.log('[Worker] 📨 Request:', request.method, path);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // ========================================
    // 🔌 WEBSOCKET ROUTE - Must forward to DO
    // ========================================
    if (path === '/api/ws') {
      console.log('[Worker] 🔌 WebSocket route');
      
      const sessionId = url.searchParams.get('session_id');
      if (!sessionId) {
        console.error('[Worker] ❌ No session_id');
        return new Response('session_id required', { status: 400, headers: corsHeaders() });
      }

      console.log('[Worker] 🔌 Session:', sessionId);
      const id = env.AGENT.idFromName(`session:${sessionId}`);
      const stub = env.AGENT.get(id);

      // Create new request with modified path for DO
      const doUrl = new URL(request.url);
      doUrl.pathname = '/ws'; // DO expects /ws not /api/ws
      
      const doRequest = new Request(doUrl.toString(), {
        method: request.method,
        headers: request.headers,
      });

      console.log('[Worker] 🔌 Forwarding to DO with path: /ws');
      return stub.fetch(doRequest);
    }

    // ========================================
    // 📍 OTHER ROUTES
    // ========================================

    // Health check
    if (path === '/' || path === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        message: 'Orion Agent v5.0',
        features: {
          d1: !!env.DB,
          vectorize: !!env.VECTORIZE,
          gemini: !!env.GEMINI_API_KEY,
        }
      }), {
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
      });
    }

    // Session Management
    if (path === '/api/sessions' && request.method === 'GET') {
      return listSessions(env);
    }

    if (path === '/api/sessions' && request.method === 'POST') {
      return createSession(request, env);
    }

    if (path.match(/^\/api\/sessions\/[^/]+$/) && request.method === 'GET') {
      const sessionId = path.split('/').pop()!;
      return getSession(sessionId, env);
    }

    if (path.match(/^\/api\/sessions\/[^/]+$/) && request.method === 'DELETE') {
      const sessionId = path.split('/').pop()!;
      return deleteSession(sessionId, env);
    }

    // Agent routes - forward to DO
    const sessionId = url.searchParams.get('session_id') || request.headers.get('X-Session-ID');
    
    if (!sessionId && (path.startsWith('/api/chat') || path.startsWith('/api/history') || 
        path.startsWith('/api/clear') || path.startsWith('/api/status'))) {
      return new Response(JSON.stringify({ error: 'session_id required' }), {
        status: 400,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
      });
    }

    if (sessionId) {
      const id = env.AGENT.idFromName(`session:${sessionId}`);
      const stub = env.AGENT.get(id);

      // Map paths: /api/chat -> /chat, /api/history -> /history, etc.
      const doPath = path.replace(/^\/api/, '');
      const doUrl = new URL(request.url);
      doUrl.pathname = doPath;

      const doRequest = new Request(doUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });

      console.log('[Worker] 📨 Forwarding to DO:', doPath);
      return stub.fetch(doRequest);
    }

    // D1 routes
    if (path === '/api/d1/status' && request.method === 'GET') {
      return getD1Status(env);
    }

    if (path === '/api/d1/init' && request.method === 'POST') {
      return initializeD1(env);
    }

    return new Response('Not Found', { 
      status: 404, 
      headers: corsHeaders() 
    });
  },
};

// ===== Session Management =====

async function listSessions(env: Env): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'D1 not configured' }), {
      status: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
    });
  }

  try {
    const d1 = new D1Manager(env.DB);
    const sessions = await d1.listSessions(50);
    return new Response(JSON.stringify({ sessions }), {
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
    });
  }
}

async function createSession(request: Request, env: Env): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'D1 not configured' }), {
      status: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
    });
  }

  try {
    const body = await request.json() as { title?: string };
    const title = body.title || 'New Session';
    const sessionId = crypto.randomUUID();

    const d1 = new D1Manager(env.DB);
    const session = await d1.createSession(sessionId, title);

    return new Response(JSON.stringify(session), {
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
    });
  }
}

async function getSession(sessionId: string, env: Env): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'D1 not configured' }), {
      status: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
    });
  }

  try {
    const d1 = new D1Manager(env.DB);
    const session = await d1.getSession(sessionId);

    if (!session) {
      return new Response(JSON.stringify({ error: 'Session not found' }), {
        status: 404,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify(session), {
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
    });
  }
}

async function deleteSession(sessionId: string, env: Env): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'D1 not configured' }), {
      status: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
    });
  }

  try {
    const d1 = new D1Manager(env.DB);
    await d1.deleteSession(sessionId);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
    });
  }
}

// ===== D1 Management =====

async function getD1Status(env: Env): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ enabled: false }), {
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
    });
  }

  try {
    const d1 = new D1Manager(env.DB);
    const [healthy, stats] = await Promise.all([
      d1.healthCheck(),
      d1.getStats(),
    ]);

    return new Response(JSON.stringify({
      enabled: true,
      healthy,
      initialized: d1.isInitialized(),
      stats,
    }), {
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
    });
  }
}

async function initializeD1(env: Env): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'D1 not configured' }), {
      status: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
    });
  }

  try {
    const d1 = new D1Manager(env.DB);
    await d1.reinitialize();
    const stats = await d1.getStats();

    return new Response(JSON.stringify({ ok: true, message: 'D1 initialized', stats }), {
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
    });
  }
}
