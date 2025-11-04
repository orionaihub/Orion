/**
 * Autonomous Agent Worker Entry Point
 *
 * This Worker acts as a thin routing layer (<10ms CPU) that immediately
 * delegates all agent logic to the AutonomousAgent Durable Object.
 *
 * Architecture:
 * - Worker: Routes requests, manages sessions, handles CORS
 * - Durable Object: Contains ALL agent logic, runs without CPU limits
 *
 * @license MIT
 */

import { Env } from './types';
import { AutonomousAgent } from './autonomous-agent';

// Export the Durable Object class
export { AutonomousAgent };

export default {
  /**
   * Main request handler for the Worker
   *
   * This function must stay under 10ms CPU time on Free Tier.
   * All complex logic is delegated to the Durable Object.
   */
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Handle static assets (frontend UI)
    if (url.pathname === '/' || url.pathname.startsWith('/public/')) {
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }
      // Fallback for local dev without assets binding
      return new Response(getBasicHTML(), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // All API routes go to Durable Object
    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, env, url);
    }

    // Handle 404 for unmatched routes
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Handle API requests by routing to the appropriate Durable Object
 *
 * This function creates or retrieves a Durable Object instance based on
 * the session ID, then forwards the request to it.
 */
async function handleApiRequest(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  // Get or create session ID from cookie or generate new one
  const sessionId = getSessionId(request) || generateSessionId();

  // Get the Durable Object stub for this session
  // Using idFromName ensures the same user always connects to the same instance
  const id = env.AutonomousAgent.idFromName(sessionId);
  const stub = env.AutonomousAgent.get(id);

  // Set CORS headers for cross-origin requests
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
    'Access-Control-Allow-Headers': 'Content-Type, Upgrade, Connection',
  };

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  let response: Response;

  try {
    // Route based on endpoint
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      // Send chat message (HTTP endpoint - for non-WebSocket clients)
      response = await stub.fetch(
        new Request('http://internal/chat', {
          method: 'POST',
          body: request.body,
          headers: request.headers,
        })
      );
    } else if (url.pathname === '/api/ws') {
      // WebSocket upgrade – fixed headers
      const upgradeReq = new Request('http://internal/ws', {
        headers: {
          upgrade               : 'websocket',
          connection            : 'upgrade',
          'sec-websocket-key'    : request.headers.get('Sec-WebSocket-Key')!,
          'sec-websocket-version': request.headers.get('Sec-WebSocket-Version')!,
        },
      });
      response = await stub.fetch(upgradeReq);
    } else if (url.pathname === '/api/history' && request.method === 'GET') {
      // Get conversation history
      response = await stub.fetch('http://internal/history');
    } else if (url.pathname === '/api/clear' && request.method === 'POST') {
      // Clear conversation history and reset agent state
      response = await stub.fetch('http://internal/clear', { method: 'POST' });
    } else if (url.pathname === '/api/upload' && request.method === 'POST') {
      // Upload files (images, PDFs, documents)
      response = await stub.fetch(
        new Request('http://internal/upload', {
          method: 'POST',
          body: request.body,
          headers: request.headers,
        })
      );
    } else if (url.pathname === '/api/files' && request.method === 'GET') {
      // List uploaded files
      response = await stub.fetch('http://internal/files');
    } else if (url.pathname === '/api/files' && request.method === 'DELETE') {
      // Delete a file
      response = await stub.fetch(
        new Request('http://internal/files', {
          method: 'DELETE',
          body: request.body,
          headers: request.headers,
        })
      );
    } else if (url.pathname === '/api/status' && request.method === 'GET') {
      // Get agent status and current plan
      response = await stub.fetch('http://internal/status');
    } else {
      response = new Response('Not found', { status: 404 });
    }
  } catch (error) {
    console.error('Error routing to Durable Object:', error);
    response = new Response(
      JSON.stringify({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // Add session cookie and CORS headers to response
  const headers = new Headers(response.headers);

  // Add session cookie if not present
  if (!getSessionId(request)) {
    headers.set(
      'Set-Cookie',
      `session_id=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000` // 30 days
    );
  }

  // Add CORS headers
  Object.entries(corsHeaders).forEach(([key, value]) => {
    headers.set(key, value);
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Get session ID from cookie
 */
function getSessionId(request: Request): string | null {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(';').map((c) => c.trim());
  const sessionCookie = cookies.find((c) => c.startsWith('session_id='));

  if (sessionCookie) {
    return sessionCookie.split('=')[1];
  }

  return null;
}

/**
 * Generate a unique session ID
 *
 * Format: session_timestamp_random
 * This ensures uniqueness and provides temporal ordering
 */
function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Basic HTML for testing without assets binding
 *
 * This provides a minimal UI for interacting with the agent
 * during development or when ASSETS binding is not configured.
 */
function getBasicHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Autonomous Agent</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      height: calc(100vh - 40px);
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 24px;
      text-align: center;
    }
    .header h1 { font-size: 28px; margin-bottom: 8px; }
    .header p { opacity: 0.9; font-size: 14px; }
    .chat-container {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
      background: #f8f9fa;
    }
    .message {
      margin-bottom: 16px;
      display: flex;
      gap: 12px;
      animation: slideIn 0.3s ease;
    }
    @keyframes slideIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .message.user { flex-direction: row-reverse; }
    .message-content {
      max-width: 70%;
      padding: 12px 16px;
      border-radius: 12px;
      line-height: 1.5;
    }
    .message.user .message-content {
      background: #667eea;
      color: white;
      border-bottom-right-radius: 4px;
    }
    .message.agent .message-content {
      background: white;
      color: #333;
      border-bottom-left-radius: 4px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    .message.status .message-content {
      background: #fff3cd;
      color: #856404;
      border-left: 4px solid #ffc107;
      max-width: 100%;
    }
    .plan {
      background: #e3f2fd;
      border-left: 4px solid #2196f3;
      padding: 12px;
      margin: 12px 0;
      border-radius: 4px;
    }
    .plan-step {
      padding: 8px;
      margin: 4px 0;
      background: white;
      border-radius: 4px;
      font-size: 14px;
    }
    .plan-step.active { border-left: 3px solid #4caf50; font-weight: 500; }
    .plan-step.completed { opacity: 0.6; text-decoration: line-through; }
    .input-container {
      padding: 20px;
      background: white;
      border-top: 1px solid #e0e0e0;
    }
    .input-row {
      display: flex;
      gap: 12px;
    }
    textarea {
      flex: 1;
      padding: 12px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      resize: none;
      font-family: inherit;
      font-size: 14px;
      transition: border-color 0.2s;
    }
    textarea:focus {
      outline: none;
      border-color: #667eea;
    }
    button {
      padding: 12px 24px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }
    .controls {
      display: flex;
      gap: 8px;
      margin-top: 8px;
    }
    .controls button {
      padding: 8px 16px;
      font-size: 12px;
      background: #6c757d;
    }
    .typing {
      display: inline-block;
      padding: 8px 16px;
      background: white;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    .typing span {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #667eea;
      margin: 0 2px;
      animation: typing 1.4s infinite;
    }
    .typing span:nth-child(2) { animation-delay: 0.2s; }
    .typing span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes typing {
      0%, 60%, 100% { transform: translateY(0); }
      30% { transform: translateY(-10px); }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🤖 Autonomous Agent</h1>
      <p>Powered by Gemini 2.5 Flash • Multi-step reasoning & execution</p>
    </div>

    <div class="chat-container" id="chat"></div>

    <div class="input-container">
      <div class="input-row">
        <textarea
          id="input"
          placeholder="Ask me anything or give me a complex task to execute autonomously..."
          rows="3"
        ></textarea>
        <button id="send" onclick="sendMessage()">Send</button>
      </div>
      <div class="controls">
        <button onclick="clearHistory()">Clear History</button>
        <button onclick="viewHistory()">View History</button>
      </div>
    </div>
  </div>

  <script>
    let ws = null;
    let isConnecting = false;

    // Connect to WebSocket
    function connect() {
      if (ws && ws.readyState === WebSocket.OPEN) return;
      if (isConnecting) return;

      isConnecting = true;
      const wsUrl = new URL('/api/ws', location.href);
      wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(wsUrl);

      ws.onopen = function () {
        console.log('WebSocket connected');
        isConnecting = false;
        addStatusMessage('Connected to agent');
      };

      ws.onmessage = function (event) {
        const data = JSON.parse(event.data);
        handleMessage(data);
      };

      ws.onclose = function () {
        console.log('WebSocket closed');
        isConnecting = false;
        addStatusMessage('Disconnected. Reconnecting...');
        setTimeout(connect, 2000);
      };

      ws.onerror = function (error) {
        console.error('WebSocket error:', error);
        isConnecting = false;
      };
    }

    let currentMessageEl = null;
    let currentPlanEl = null;

    function handleMessage(data) {
      switch (data.type) {
        case 'status':
          addStatusMessage(data.message);
          break;
        case 'chunk':
          if (!currentMessageEl) {
            currentMessageEl = addMessage('agent', '');
          }
          currentMessageEl.textContent += data.content;
          scrollToBottom();
          break;
        case 'plan':
          currentPlanEl = addPlan(data.plan);
          break;
        case 'step_start':
          updatePlanStep(data.step - 1, 'active');
          addStatusMessage('Executing: ' + data.description);
          break;
        case 'step_complete':
          updatePlanStep(data.step - 1, 'completed');
          break;
        case 'step_error':
          addStatusMessage('Error in step ' + data.step + ': ' + data.error, true);
          break;
        case 'final_response':
          currentMessageEl = addMessage('agent', data.content);
          break;
        case 'sources':
          addSources(data.sources);
          break;
        case 'done':
          currentMessageEl = null;
          removeTyping();
          break;
        case 'error':
          addStatusMessage('Error: ' + data.error, true);
          removeTyping();
          break;
      }
    }

    function sendMessage() {
      const input = document.getElementById('input');
      const message = input.value.trim();
      if (!message) return;

      addMessage('user', message);
      input.value = '';

      addTyping();

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'user_message', content: message }));
      } else {
        addStatusMessage('Connecting...', true);
        connect();
        setTimeout(function () {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'user_message', content: message }));
          }
        }, 1000);
      }
    }

    function addMessage(role, content) {
      const chat = document.getElementById('chat');
      const msgDiv = document.createElement('div');
      msgDiv.className = 'message ' + role;
      const contentDiv = document.createElement('div');
      contentDiv.className = 'message-content';
      contentDiv.textContent = content;
      msgDiv.appendChild(contentDiv);
      chat.appendChild(msgDiv);
      scrollToBottom();
      return contentDiv;
    }

    function addStatusMessage(message, isError) {
      const chat = document.getElementById('chat');
      const msgDiv = document.createElement('div');
      msgDiv.className = 'message status';
      const contentDiv = document.createElement('div');
      contentDiv.className = 'message-content';
      contentDiv.textContent = (isError ? '⚠️ ' : 'ℹ️ ') + message;
      msgDiv.appendChild(contentDiv);
      chat.appendChild(msgDiv);
      scrollToBottom();
    }

    function addPlan(plan) {
      const chat = document.getElementById('chat');
      const planDiv = document.createElement('div');
      planDiv.className = 'plan';
      planDiv.innerHTML = '<strong>📋 Execution Plan:</strong>';

      plan.steps.forEach(function (step, i) {
        const stepDiv = document.createElement('div');
        stepDiv.className = 'plan-step';
        stepDiv.dataset.index = i;
        stepDiv.textContent = (i + 1) + '. ' + step.description;
        planDiv.appendChild(stepDiv);
      });

      chat.appendChild(planDiv);
      scrollToBottom();
      return planDiv;
    }

    function updatePlanStep(index, status) {
      if (!currentPlanEl) return;
      const step = currentPlanEl.querySelector('[data-index="' + index + '"]');
      if (step) {
        step.className = 'plan-step ' + status;
      }
    }

    function addTyping() {
      const chat = document.getElementById('chat');
      const typingDiv = document.createElement('div');
      typingDiv.className = 'message agent';
      typingDiv.id = 'typing';
      typingDiv.innerHTML = '' +
        '<div class="typing">' +
          '<span></span><span></span><span></span>' +
        '</div>';
      chat.appendChild(typingDiv);
      scrollToBottom();
    }

    function removeTyping() {
      const typing = document.getElementById('typing');
      if (typing) typing.remove();
    }

    function addSources(sources) {
      if (!sources || sources.length === 0) return;
      const chat = document.getElementById('chat');
      const sourcesDiv = document.createElement('div');
      sourcesDiv.className = 'message status';
      sourcesDiv.innerHTML = '' +
        '<div class="message-content">' +
          '<strong>📚 Sources:</strong><br>' +
          sources.map(function (s) { return '• ' + s; }).join('<br>') +
        '</div>';
      chat.appendChild(sourcesDiv);
      scrollToBottom();
    }

    function scrollToBottom() {
      const chat = document.getElementById('chat');
      chat.scrollTop = chat.scrollHeight;
    }

    async function clearHistory() {
      if (!confirm('Clear conversation history?')) return;
      try {
        await fetch('/api/clear', { method: 'POST' });
        document.getElementById('chat').innerHTML = '';
        addStatusMessage('History cleared', false);
      } catch (error) {
        addStatusMessage('Error clearing history', true);
      }
    }

    async function viewHistory() {
      try {
        const res = await fetch('/api/history');
        const data = await res.json();
        console.log('Conversation History:', data.history);
        addStatusMessage('History has ' + data.history.length + ' messages (see console)', false);
      } catch (error) {
        addStatusMessage('Error fetching history', true);
      }
    }

    // Handle Enter key
    document.getElementById('input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Connect on load
    connect();
  </script>
</body>
</html>`;
}
