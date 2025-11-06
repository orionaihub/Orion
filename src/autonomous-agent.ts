// Add better error handling to your AutonomousAgent constructor

constructor(state: DurableObjectState, env: Env) {
  super(state, env);
  
  console.log('[AutonomousAgent] Initializing...');
  
  // Validate environment
  if (!env.GEMINI_API_KEY) {
    console.error('[AutonomousAgent] FATAL: Missing GEMINI_API_KEY');
    throw new Error('GEMINI_API_KEY is required');
  }
  
  this.sql = state.storage.sql as SqlStorage;
  this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });

  try {
    console.log('[AutonomousAgent] Initializing SQLite...');
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        parts TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_msg_ts ON messages(timestamp);
    `);
    console.log('[AutonomousAgent] SQLite initialized successfully');
  } catch (e) {
    console.error('[AutonomousAgent] SQLite init failed:', e);
    throw e; // Re-throw to prevent initialization with broken DB
  }
}

// Enhanced fetch handler with better error handling
async fetch(request: Request): Promise<Response> {
  console.log(`[AutonomousAgent] ${request.method} ${request.url}`);
  
  try {
    const url = new URL(request.url);

    if (url.pathname === '/api/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      console.log('[AutonomousAgent] WebSocket upgrade request');
      
      try {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        
        this.ctx.acceptWebSocket(server);
        this.activeWebSockets.add(server);
        this.metrics.activeConnections = this.activeWebSockets.size;
        
        console.log('[AutonomousAgent] WebSocket connection accepted');
        
        return new Response(null, { 
          status: 101, 
          webSocket: client 
        });
      } catch (wsError) {
        console.error('[AutonomousAgent] WebSocket setup failed:', wsError);
        return new Response(JSON.stringify({ 
          error: 'WebSocket setup failed',
          details: wsError instanceof Error ? wsError.message : String(wsError)
        }), { 
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (url.pathname === '/api/chat' && request.method === 'POST') {
      return this.handleChat(request);
    }
    if (url.pathname === '/api/history' && request.method === 'GET') {
      return this.getHistory();
    }
    if (url.pathname === '/api/clear' && request.method === 'POST') {
      return this.clearHistory();
    }
    if (url.pathname === '/api/status' && request.method === 'GET') {
      return this.getStatus();
    }
    if (url.pathname === '/api/metrics' && request.method === 'GET') {
      return this.getMetrics();
    }

    return new Response('Not found', { status: 404 });
  } catch (error) {
    console.error('[AutonomousAgent] Fetch handler error:', error);
    return new Response(JSON.stringify({ 
      error: 'Internal server error',
      details: error instanceof Error ? error.message : String(error)
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Enhanced WebSocket message handler
async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
  console.log('[AutonomousAgent] WebSocket message received');
  
  if (typeof message !== 'string') {
    console.warn('[AutonomousAgent] Non-string message received, ignoring');
    return;
  }
  
  if (ws.readyState !== WebSocket.OPEN) {
    console.warn('[AutonomousAgent] WebSocket not open, discarding message');
    return;
  }

  let payload: any;
  try {
    payload = JSON.parse(message);
    console.log('[AutonomousAgent] Parsed message:', payload.type);
  } catch (parseError) {
    console.error('[AutonomousAgent] JSON parse failed:', parseError);
    this.send(ws, { type: 'error', error: 'Invalid JSON' });
    return;
  }

  if (payload.type === 'user_message' && typeof payload.content === 'string') {
    console.log('[AutonomousAgent] Processing user message...');
    this.ctx.waitUntil(
      this.trackRequest(() => this.process(payload.content, ws))
        .then(() => {
          console.log('[AutonomousAgent] Message processed successfully');
        })
        .catch((err) => {
          console.error('[AutonomousAgent] WebSocket process failed:', err);
          this.send(ws, { 
            type: 'error', 
            error: 'Processing failed',
            details: err instanceof Error ? err.message : String(err)
          });
        })
    );
  } else {
    console.warn('[AutonomousAgent] Invalid payload structure');
    this.send(ws, { type: 'error', error: 'Invalid payload' });
  }
}
