/**
 * Suna-like Agent UI upgrade
 * Adds: file-tree, python stdout, quality metrics, reflection blocks
 * Keeps: session mgmt, mode toggle, traces panel, localStorage
 */

/* --------------- STATE --------------- */
const app = {
  sessions: [],
  currentId: null,
  mode: 'chat',               // 'chat' | 'agent'
  processing: false,
  traces: [],
  ws: null,                   // optional: future WebSocket bridge
};

/* --------------- DOM CACHE --------------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const sidebar     = $('#sidebar');
const msgList     = $('#chat-messages');
const input       = $('#user-input');
const sendBtn     = $('#send-button');
const newChatBtn  = $('#new-chat-btn');
const sessionsList= $('#sessions-list');
const title       = $('#chat-title');
const clearBtn    = $('#clear-btn');
const tracesBtn   = $('#toggle-traces-btn');
const tracesPanel = $('#traces-panel');
const tracesCnt   = $('#traces-content');
const modeChat    = $('#mode-chat');
const modeAgent   = $('#mode-agent');

/* --------------- INIT --------------- */
window.addEventListener('DOMContentLoaded', () => {
  loadSessions();
  if (app.sessions.length) switchSession(app.sessions[0].id);
  else createSession();
  bindEvents();
});

function bindEvents() {
  newChatBtn.addEventListener('click', createSession);
  sendBtn.addEventListener('click', sendMessage);
  clearBtn.addEventListener('click', clearHistory);
  tracesBtn.addEventListener('click', toggleTraces);
  $('#traces-close-btn').addEventListener('click', () => tracesPanel.classList.remove('open'));
  modeChat.addEventListener('click', () => switchMode('chat'));
  modeAgent.addEventListener('click', () => switchMode('agent'));
  $('#toggle-sidebar-btn').addEventListener('click', toggleSidebar);
  $('#toggle-sidebar-btn-mobile').addEventListener('click', toggleSidebar);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
  });
}

/* --------------- SESSIONS --------------- */
function createSession() {
  const id = crypto.randomUUID();
  const name = `Chat ${new Date().toLocaleString()}`;
  app.sessions.unshift({ id, name, mode: 'chat', messages: [] });
  saveSessions();
  switchSession(id);
}

function switchSession(id) {
  app.currentId = id;
  const s = app.sessions.find((x) => x.id === id);
  if (!s) return;
  app.mode = s.mode;
  renderSessions();
  renderMode();
  renderHistory(s);
  title.textContent = `${s.mode === 'agent' ? '🤖' : '💬'} ${s.name}`;
  input.focus();
}

function deleteSession(id) {
  if (app.sessions.length === 1) return alert('Keep at least one session');
  app.sessions = app.sessions.filter((x) => x.id !== id);
  saveSessions();
  switchSession(app.sessions[0].id);
}

function renderSessions() {
  sessionsList.innerHTML = '';
  app.sessions.forEach((s) => {
    const btn = document.createElement('button');
    btn.className = `session-item ${s.id === app.currentId ? 'active' : ''}`;
    btn.innerHTML = `<span>${s.name}</span><button class="session-delete-btn">🗑</button>`;
    btn.onclick = () => switchSession(s.id);
    btn.querySelector('.session-delete-btn').onclick = (e) => {
      e.stopPropagation();
      if (confirm('Delete?')) deleteSession(s.id);
    };
    sessionsList.appendChild(btn);
  });
}

function saveSessions() {
  localStorage.setItem('chat_sessions', JSON.stringify(app.sessions));
}

function loadSessions() {
  try {
    app.sessions = JSON.parse(localStorage.getItem('chat_sessions') || '[]');
  } catch {
    app.sessions = [];
  }
}

/* --------------- MODE --------------- */
function switchMode(m) {
  app.mode = m;
  const s = app.sessions.find((x) => x.id === app.currentId);
  if (s) s.mode = m;
  saveSessions();
  renderMode();
  title.textContent = `${m === 'agent' ? '🤖' : '💬'} ${s?.name || ''}`;
}

function renderMode() {
  modeChat.classList.toggle('active', app.mode === 'chat');
  modeAgent.classList.toggle('active', app.mode === 'agent');
  tracesBtn.style.display = app.mode === 'agent' ? 'block' : 'none';
}

/* --------------- MESSAGING --------------- */
async function sendMessage() {
  const text = input.value.trim();
  if (!text || app.processing) return;
  input.value = '';
  input.style.height = 'auto';

  addMessage('user', text);
  const s = getSession();
  s.messages.push({ role: 'user', content: text, ts: Date.now() });
  saveSessions();

  app.processing = true;
  sendBtn.disabled = true;

  try {
    app.mode === 'chat' ? await chatStream(text) : await agentStream(text);
  } catch (e) {
    addMessage('assistant', `❌ ${e.message}`);
  } finally {
    app.processing = false;
    sendBtn.disabled = false;
    input.focus();
    saveSessions();
  }
}

async function chatStream(prompt) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: prompt }),
  });
  if (!res.ok) throw new Error(res.statusText);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        const msg = JSON.parse(l);
        if (msg.response) {
          full += msg.response;
          addMessage('assistant', full, true); // update
        }
      } catch {}
    }
  }
  getSession().messages.push({ role: 'assistant', content: full, ts: Date.now() });
}

async function agentStream(prompt) {
  showTyping();
  const res = await fetch('/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: prompt }),
  });
  if (!res.ok) throw new Error(res.statusText);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  let group = null;
  app.traces = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        const ev = JSON.parse(l);
        app.traces.push(ev);
        hideTyping();
        if (ev.type === 'response_chunk') {
          full += ev.data.response || '';
          group = addMessage('assistant', full, true, group);
        } else {
          group = addEvent(ev, group);
        }
      } catch {}
    }
  }
  getSession().messages.push({ role: 'assistant', content: full, ts: Date.now() });
}

/* --------------- RENDER HELPERS --------------- */
function addMessage(role, text, update = false, group = null) {
  if (!group) {
    group = document.createElement('div');
    group.className = `message-group ${role === 'user' ? 'user' : ''}`;
    const msg = document.createElement('div');
    msg.className = `message ${role}-message`;
    msg.innerHTML = `<p></p>`;
    group.appendChild(msg);
    msgList.appendChild(group);
  }
  group.querySelector('p').textContent = text;
  scroll();
  return group;
}

function addEvent(ev, group) {
  const type = ev.type;
  let html = '';
  switch (type) {
    case 'start':
      html = `<div class="event-message thinking-block"><strong>🚀 Agent started</strong></div>`;
      break;
    case 'thinking_chunk':
      html = `<div class="event-message thinking-block"><strong>🧠 Thinking</strong><pre>${ev.data.thinking}</pre></div>`;
      break;
    case 'tool_call_start':
      html = `<div class="event-message tool-call-block"><strong>🔧 ${ev.data.tool_name}</strong><pre>${JSON.stringify(ev.data.tool_args, null, 2)}</pre></div>`;
      break;
    case 'tool_result':
      html = `<div class="event-message tool-result-block"><strong>✅ Result</strong> ${ev.data.execution_time_ms ? `(${ev.data.execution_time_ms} ms)` : ''}<pre>${ev.data.result || ev.data.error || ''}</pre></div>`;
      break;
    case 'reflection':
      html = `<div class="event-message reflection-block"><strong>🔍 Reflection</strong> ${ev.data.assessment} ${ev.data.confidence ? `(confidence ${(ev.data.confidence * 100).toFixed(0)}%)` : ''}</div>`;
      break;
    case 'quality_metrics':
      const m = ev.data;
      html = `<div class="event-message quality-metrics-block"><strong>📊 Quality</strong>
        Confidence: ${(m.confidence * 100).toFixed(0)}%<br>
        Iterations: ${m.iterations}<br>
        Tools: ${m.tools_used.join(', ')}<br>
        Think: ${m.thinking_time_ms} ms<br>
        Exec: ${m.execution_time_ms} ms<br>
        Coverage: ${m.coverage_assessment}</div>`;
      break;
    case 'done':
      html = `<div class="event-message complete-block"><strong>✅ Done</strong> ${ev.data.iterations} iterations · ${ev.data.elapsed} ms</div>`;
      break;
    case 'warning':
      html = `<div class="event-message error-block"><strong>⚠️ ${ev.data.reason}</strong></div>`;
      break;
    case 'error':
      html = `<div class="event-message error-block"><strong>❌ Error</strong><pre>${ev.data.error}</pre></div>`;
      break;
  }
  if (!html) return group;
  if (!group || group.dataset.type !== 'event') {
    group = document.createElement('div');
    group.className = 'message-group';
    group.dataset.type = 'event';
    msgList.appendChild(group);
  }
  group.innerHTML = html;
  scroll();
  return group;
}

function showTyping() {
  const g = document.createElement('div');
  g.className = 'message-group';
  g.innerHTML = `<div class="typing-indicator" id="typing-indicator">
    <span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>
  </div>`;
  msgList.appendChild(g);
  scroll();
}
function hideTyping() {
  document.getElementById('typing-indicator')?.closest('.message-group')?.remove();
}

function scroll() {
  msgList.scrollTop = msgList.scrollHeight;
}

/* --------------- HISTORY --------------- */
function renderHistory(s) {
  msgList.innerHTML = '';
  if (!s.messages.length) {
    addMessage('assistant', `👋 Welcome to ${s.mode === 'agent' ? '🤖 Agent' : '💬 Chat'} mode.\nStart typing below.`);
    return;
  }
  s.messages.forEach((m) => addMessage(m.role, m.content));
}

async function clearHistory() {
  if (!confirm('Clear this chat?')) return;
  await fetch(`/api/${app.mode}/clear`, { method: 'POST' });
  const s = getSession();
  s.messages = [];
  saveSessions();
  renderHistory(s);
}

/* --------------- SIDEBAR --------------- */
function toggleSidebar() {
  sidebar.classList.toggle('collapsed');
  localStorage.setItem('sidebar_collapsed', sidebar.classList.contains('collapsed'));
}
window.addEventListener('load', () => {
  if (localStorage.getItem('sidebar_collapsed') === 'true') sidebar.classList.add('collapsed');
});

/* --------------- TRACES --------------- */
function toggleTraces() {
  tracesPanel.classList.toggle('open');
  if (tracesPanel.classList.contains('open')) renderTraces();
}
function renderTraces() {
  tracesCnt.innerHTML = '';
  if (!app.traces.length) {
    tracesCnt.innerHTML = '<p style="color:var(--text-light)">No traces yet.</p>';
    return;
  }
  app.traces.forEach((t, i) => {
    const d = document.createElement('div');
    d.className = 'trace-item';
    d.innerHTML = `
      <div class="trace-item-type">[${i + 1}] ${t.type}</div>
      <div class="trace-item-time">${new Date(t.ts || t.timestamp).toLocaleTimeString()}</div>
      <pre class="trace-item-content">${JSON.stringify(t.data, null, 2)}</pre>`;
    tracesCnt.appendChild(d);
  });
}

/* --------------- UTILS --------------- */
function getSession() {
  return app.sessions.find((s) => s.id === app.currentId);
}
