/* script.js — FIXED VERSION WITH BETTER ERROR HANDLING */

/* ---------- Utility ---------- */

function $(id) { return document.getElementById(id); }

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function renderMarkdown(md) {
  const html = marked.parse(md || "");
  const w = document.createElement("div");
  w.innerHTML = html;
  w.querySelectorAll("pre code").forEach(c => hljs.highlightElement(c));
  return w.innerHTML;
}

/* ---------- DOM ---------- */

const sessionsDrawer = $("sessions-drawer");
const openDrawerBtn = $("open-drawer-btn");
const closeDrawerBtn = $("close-drawer-btn");
const sessionsList = $("sessions-list");
const selectedSession = $("selected-session");
const newSessionBtn = $("new-session-btn");

const messagesWrapper = $("messages-wrapper");
const chatForm = $("chat-form");
const chatInput = $("chat-input");
const sendButton = $("send-button");
const fileInput = $("file-input");
const filePreview = $("file-preview");

const typingIndicator = $("typing-indicator");
const clearSessionBtn = $("clear-session-btn");
const statusDot = $("status-dot");
const statusText = $("status-text");

/* ---------- State ---------- */

let sessionId = localStorage.getItem("orion:sessionId") || null;
let ws = null;
let wsOpen = false;
let streamingEl = null;
let streamBuffer = '';
let isSending = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;

/* ---------- Status ---------- */

function setStatus(t, c) {
  statusText.textContent = t;
  statusDot.className = `w-2 h-2 rounded-full ${c}`;
}

function showTyping(t = "Thinking…") {
  typingIndicator.textContent = t;
  typingIndicator.classList.remove("hidden");
}

function hideTyping() {
  typingIndicator.classList.add("hidden");
}

function scrollBottom() {
  const el = document.getElementById("messages-area");
  if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
}

/* ---------- Sessions ---------- */

async function loadSessions() {
  try {
    const r = await fetch("/api/sessions");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    renderSessions(d.sessions || []);
  } catch (e) {
    console.error('Failed to load sessions:', e);
    sessionsList.innerHTML = `<div class="text-sm text-red-400 p-2">Failed to load sessions</div>`;
  }
}

function renderSessions(list) {
  sessionsList.innerHTML = "";
  if (!list.length) {
    sessionsList.innerHTML = `<div class="text-sm text-gray-500 p-2">No sessions. Tap New.</div>`;
    selectedSession.textContent = "none";
    return;
  }
  list.forEach(s => {
    const i = document.createElement("div");
    i.className = "flex items-center justify-between p-2 rounded hover:bg-white/5";
    i.innerHTML = `
      <div class="flex-1 min-w-0">
        <div class="text-sm font-medium truncate">${escapeHtml(s.title || s.sessionId)}</div>
        <div class="text-xs text-gray-400 truncate">${new Date(s.lastActivityAt || s.createdAt).toLocaleString()}</div>
      </div>
      <div class="flex items-center gap-2 ml-3">
        <button class="text-xs px-2 py-1 bg-white/10 rounded open-btn">Open</button>
        <button class="text-xs px-2 py-1 bg-red-600 rounded delete-btn">Del</button>
      </div>`;
    i.querySelector(".open-btn").onclick = e => { e.stopPropagation(); selectSession(s.sessionId); };
    i.querySelector(".delete-btn").onclick = async e => {
      e.stopPropagation();
      if (!confirm("Delete this session?")) return;
      try {
        await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}`, { method: "DELETE" });
        if (sessionId === s.sessionId) {
          sessionId = null;
          localStorage.removeItem("orion:sessionId");
          messagesWrapper.innerHTML = "";
          selectedSession.textContent = "none";
        }
        loadSessions();
      } catch (err) {
        console.error('Delete failed:', err);
        alert('Failed to delete session');
      }
    };
    sessionsList.appendChild(i);
  });
}

/* ---------- Create Session ---------- */

async function createSession(auto = false) {
  const title = auto ? "New Chat" : (prompt("Session title:", "New Chat") || "New Chat");
  try {
    const r = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title })
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    sessionId = d.sessionId;
    localStorage.setItem("orion:sessionId", sessionId);
    messagesWrapper.innerHTML = "";
    selectedSession.textContent = d.sessionId;
    filePreview.innerHTML = "";
    clearSessionBtn.classList.remove("hidden");
    console.log('Created session:', sessionId);
  } catch (e) {
    console.error('Create session failed:', e);
    alert("Cannot create session");
  }
}

async function selectSession(id) {
  sessionId = id;
  localStorage.setItem("orion:sessionId", id);
  selectedSession.textContent = id;
  closeWs();
  await loadHistory();
  clearSessionBtn.classList.remove("hidden");
  sessionsDrawer.classList.add("translate-y-full");
  console.log('Selected session:', id);
}

/* ---------- History ---------- */

async function loadHistory() {
  if (!sessionId) return;
  messagesWrapper.innerHTML = "";
  try {
    const r = await fetch(`/api/history?session_id=${encodeURIComponent(sessionId)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (!d.messages.length) {
      messagesWrapper.innerHTML = `<div class="p-6 text-center text-gray-400">No messages yet. Start chatting!</div>`;
      return;
    }
    d.messages.forEach(m => {
      const role = m.role === "model" ? "assistant" : "user";
      const text = (m.parts || []).map(p => p.text || "").join("\n");
      if (role === "user") insertUserBubble(text);
      else insertAssistantBubble(text);
    });
    scrollBottom();
  } catch (e) {
    console.error('Load history failed:', e);
    messagesWrapper.innerHTML = `<div class="p-6 text-center text-red-400">Failed to load history</div>`;
  }
}

/* ---------- Render Messages ---------- */

function insertUserBubble(t) {
  const r = document.createElement("div");
  r.className = "message justify-end";
  r.innerHTML = `
    <div class="msg-bubble msg-user">${escapeHtml(t)}</div>
    <div class="avatar bg-gray-700 ml-3 text-sm">You</div>`;
  messagesWrapper.appendChild(r);
  scrollBottom();
}

function insertAssistantBubble(md) {
  const r = document.createElement("div");
  r.className = "message";
  r.innerHTML = `
    <div class="avatar bg-gradient-to-br from-teal-500 to-indigo-600 mr-3">O</div>
    <div class="msg-bubble msg-assistant message-content">${renderMarkdown(md)}</div>`;
  messagesWrapper.appendChild(r);
  scrollBottom();
}

function startStreamingBubble() {
  streamingEl = document.createElement("div");
  streamingEl.className = "message";
  streamingEl.innerHTML = `
    <div class="avatar bg-gradient-to-br from-teal-500 to-indigo-600 mr-3">O</div>
    <div class="msg-bubble msg-assistant message-stream"></div>`;
  messagesWrapper.appendChild(streamingEl);
  streamBuffer = '';
  scrollBottom();
}

function appendChunk(t) {
  if (!streamingEl) startStreamingBubble();
  streamBuffer += t;
  const b = streamingEl.querySelector(".message-stream");
  b.textContent = streamBuffer;
  scrollBottom();
}

function finalizeStreaming() {
  if (!streamingEl) return;
  const b = streamingEl.querySelector(".message-stream");
  b.innerHTML = renderMarkdown(streamBuffer);
  streamingEl = null;
  streamBuffer = '';
  scrollBottom();
}

/* ---------- WebSocket ---------- */

function closeWs() {
  try {
    if (ws) {
      ws.close();
      ws = null;
    }
  } catch (e) {
    console.error('WS close error:', e);
  }
  wsOpen = false;
  setStatus("Disconnected", "bg-red-500");
}

async function openWs() {
  if (!sessionId) {
    console.error('Cannot open WS: no sessionId');
    return false;
  }

  closeWs();
  
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${location.host}/api/ws?session_id=${encodeURIComponent(sessionId)}`;
  
  console.log('Opening WebSocket:', wsUrl);

  return new Promise((resolve, reject) => {
    try {
      ws = new WebSocket(wsUrl);
      
      ws.onopen = () => {
        wsOpen = true;
        reconnectAttempts = 0;
        setStatus("Connected", "bg-teal-500");
        console.log('WebSocket connected');
        resolve(true);
      };

      ws.onmessage = e => {
        try {
          const msg = JSON.parse(e.data);
          handleWsMessage(msg);
        } catch (err) {
          console.error("WS parse error:", err);
        }
      };

      ws.onclose = () => {
        wsOpen = false;
        setStatus("Disconnected", "bg-red-500");
        console.log('WebSocket closed');
        
        // Auto-reconnect if we were in the middle of something
        if (isSending && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++;
          console.log(`Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
          setTimeout(() => openWs(), 2000);
        }
      };

      ws.onerror = err => {
        console.error('WebSocket error:', err);
        setStatus("Error", "bg-red-500");
        reject(err);
      };

    } catch (err) {
      console.error('Failed to create WebSocket:', err);
      reject(err);
    }
  });
}

function handleWsMessage(m) {
  console.log('WS message:', m.type);
  
  switch (m.type) {
    case "status":
      showTyping(m.content || "Processing...");
      break;
    case "chunk":
      if (m.content) {
        showTyping();
        appendChunk(m.content);
      }
      break;
    case "complete":
      hideTyping();
      finalizeStreaming();
      isSending = false;
      sendButton.disabled = false;
      chatInput.disabled = false;
      console.log('Message complete');
      break;
    case "error":
      hideTyping();
      alert("Server error: " + (m.error || 'Unknown error'));
      isSending = false;
      sendButton.disabled = false;
      chatInput.disabled = false;
      break;
  }
}

/* ---------- Send Message ---------- */

async function sendMessage(t) {
  if (!sessionId) {
    alert("No session selected");
    return;
  }

  if (isSending) {
    console.log('Already sending, ignoring duplicate request');
    return;
  }

  isSending = true;
  sendButton.disabled = true;
  chatInput.disabled = true;

  insertUserBubble(t || "(message)");
  showTyping("Connecting...");

  try {
    // Ensure WebSocket is open
    if (!wsOpen) {
      console.log('Opening WebSocket connection...');
      await openWs();
    }

    if (!wsOpen) {
      throw new Error('Failed to establish WebSocket connection');
    }

    // Send message via WebSocket (use "user_message" to match DO)
    console.log('Sending message via WebSocket');
    ws.send(JSON.stringify({
      type: "user_message",
      content: t
    }));

    chatInput.value = "";
    
  } catch (e) {
    console.error('Send failed:', e);
    hideTyping();
    alert("Failed to send message: " + e.message);
    isSending = false;
    sendButton.disabled = false;
    chatInput.disabled = false;
  }
}

/* ---------- Events ---------- */

chatForm.onsubmit = e => {
  e.preventDefault();
  const t = chatInput.value.trim();
  if (!t) return;
  sendMessage(t);
};

newSessionBtn.onclick = () => createSession(false);
openDrawerBtn.onclick = () => sessionsDrawer.classList.remove("translate-y-full");
closeDrawerBtn.onclick = () => sessionsDrawer.classList.add("translate-y-full");

clearSessionBtn.onclick = async () => {
  if (!sessionId) return;
  if (!confirm("Clear conversation?")) return;
  try {
    await fetch(`/api/clear?session_id=${encodeURIComponent(sessionId)}`, { 
      method: "POST" 
    });
    messagesWrapper.innerHTML = "";
    console.log('Conversation cleared');
  } catch (e) {
    console.error('Clear failed:', e);
    alert('Failed to clear conversation');
  }
};

/* ---------- Init ---------- */

(async function init() {
  console.log('Initializing Orion Chat...');
  setStatus("Disconnected", "bg-red-500");
  
  await loadSessions();
  
  if (sessionId) {
    console.log('Restoring session:', sessionId);
    selectedSession.textContent = sessionId;
    await loadHistory();
    clearSessionBtn.classList.remove("hidden");
  } else {
    console.log('Creating new session...');
    await createSession(true);
  }
  
  console.log('Initialization complete');
})();
