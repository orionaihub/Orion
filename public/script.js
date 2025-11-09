/*  Orion-Chat ‑ fixed frontend  */
/*  fixes: 1) typo “frentend” → “frontend”
          2) undeclared i18n helpers
          3) race on ws.send while CONNECTING
          4) marked hljs called before libs loaded
          5) orphan ws on page unload
          6) double-send on rapid <Enter>
          7) missing LBS/geo helper stubs          */

/* ---------- 0.  tiny helpers ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const escapeHtml = text => {                       // keep util local
  const d = document.createElement('div');
  d.textContent = String(text);
  return d.innerHTML;
};

/* ---------- 1.  wait for libs ---------- */
let libsReady = false;
function waitLibs() {
  return new Promise(res => {
    const t = setInterval(() => {
      if (typeof marked !== 'undefined' && typeof hljs !== 'undefined') {
        clearInterval(t);
        libsReady = true;
        res();
      }
    }, 60);
  });
}

/* ---------- 2.  DOM cache ---------- */
const $ = id => document.getElementById(id);
const chatContainer   = $('chat-container');
const chatMessages    = $('messages-wrapper');
const welcomeScreen   = $('welcome-message');
const userInput       = $('chat-input');
const sendButton      = $('send-button');
const typingIndicator = $('typing-indicator');
const typingText      = $('typing-text');
const fileInput       = $('file-input');
const filePreview     = $('file-preview');
const sidebar         = $('sidebar');
const menuBtn         = $('menu-btn');
const overlay         = $('overlay');

/* ---------- 3.  state ---------- */
let ws, isConnecting = false, reconnectAttempts = 0;
let isProcessing = false, currentMessageEl = null;
let pendingFiles = [], conversationStarted = false;
const MAX_RECONNECT_DELAY = 30000;

/* ---------- 4.  init ---------- */
window.addEventListener('DOMContentLoaded', async () => {
  await waitLibs();                       // ← make sure libs exist
  configureMarked();
  loadChatHistory();
  connectWebSocket();
  setupFileUpload();
  setupInputHandlers();
  setupSidebarToggle();
  checkMobileView();
});
window.addEventListener('resize', checkMobileView);
window.addEventListener('beforeunload', () => ws && ws.close()); // tidy-up

/* ---------- 5.  marked ---------- */
function configureMarked() {
  marked.setOptions({
    breaks: true,
    gfm: true,
    headerIds: false,
    mangle: false,
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try { return hljs.highlight(code, {language: lang}).value; }
        catch {}
      }
      return hljs.highlightAuto(code).value;
    }
  });
}

/* ---------- 6.  websocket ---------- */
async function connectWebSocket() {
  if ((ws && ws.readyState === WebSocket.OPEN) || isConnecting) return;
  isConnecting = true;
  updateConnectionStatus('Connecting…', 'bg-gray-500');

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const port = location.port ? ':' + location.port : '';
  const url = `${protocol}//${location.hostname}${port}/api/ws`;

  try {
    ws = new WebSocket(url);
  } catch (e) {
    console.error('WS create error', e);
    isConnecting = false;
    scheduleReconnect(); return;
  }

  ws.onopen = () => {
    isConnecting = false; reconnectAttempts = 0;
    updateConnectionStatus('Connected', 'bg-teal-500');
  };
  ws.onclose = () => { isConnecting = false; updateConnectionStatus('Disconnected', 'bg-red-500'); scheduleReconnect(); };
  ws.onerror = e => { console.error('WS error', e); updateConnectionStatus('Error', 'bg-red-500'); };
  ws.onmessage = e => {
    try { handleServerMessage(JSON.parse(e.data)); }
    catch (err) { console.error('Bad json', err, e.data); }
  };
}

function scheduleReconnect() {
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts++), MAX_RECONNECT_DELAY);
  setTimeout(connectWebSocket, delay);
}

/* ---------- 7.  mobile ---------- */
function checkMobileView() {
  const mobile = window.innerWidth <= 768;
  sidebar.classList.toggle('-translate-x-full', mobile);
  overlay.classList.toggle('hidden', true);
}
function setupSidebarToggle() {
  menuBtn?.addEventListener('click', () => {
    sidebar.classList.toggle('-translate-x-full');
    overlay.classList.toggle('hidden');
  });
  overlay?.addEventListener('click', () => {
    sidebar.classList.add('-translate-x-full');
    overlay.classList.add('hidden');
  });
  $('new-chat-btn')?.addEventListener('click', () => {
    clearChat();
    if (window.innerWidth <= 768) { sidebar.classList.add('-translate-x-full'); overlay.classList.add('hidden'); }
  });
}

/* ---------- 8.  file upload ---------- */
function setupFileUpload() {
  fileInput.addEventListener('change', async e => {
    const files = Array.from(e.target.files);
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) { addToast(`${file.name} too large`, 'error'); continue; }
      try {
        const base64 = await fileToBase64(file);
        pendingFiles.push({data: base64.split(',')[1], mimeType: file.type, name: file.name, size: file.size});
        addFileChip(file);
        addToast(`Added ${file.name}`, 'success');
      } catch { addToast(`Failed ${file.name}`, 'error'); }
    }
    fileInput.value = ''; updateFilePreview();
  });
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function addFileChip(file) {
  const chip = document.createElement('div');
  chip.className = 'flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 text-xs text-white';
  chip.dataset.fileName = file.name;
  chip.innerHTML = `
    <span>${getFileIcon(file.type, file.name)}</span>
    <span class="truncate max-w-[150px]">${escapeHtml(file.name)}</span>
    <span class="text-gray-400">(${formatFileSize(file.size)})</span>
    <button type="button" class="text-gray-400 hover:text-white transition-colors ml-1" onclick="removeFileChip('${escapeHtml(file.name)}')" aria-label="Remove file">
      <svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"/></svg>
    </button>`;
  filePreview.appendChild(chip);
}
window.removeFileChip = function(name) {
  pendingFiles = pendingFiles.filter(f => f.name !== name);
  document.querySelectorAll(`[data-file-name="${CSS.escape(name)}"]`).forEach(el => el.remove());
  updateFilePreview();
};
function updateFilePreview() {} // placeholder
function formatFileSize(b) {
  return b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
}
function getFileIcon(mime, name) {
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.includes('pdf')) return '📄';
  if (mime.includes('word') || name.endsWith('.doc') || name.endsWith('.docx')) return '📝';
  if (mime.includes('sheet') || name.endsWith('.csv') || name.endsWith('.xlsx')) return '📊';
  if (mime.includes('json')) return '📋';
  if (mime.includes('text')) return '📃';
  return '📎';
}

/* ---------- 9.  input ---------- */
function setupInputHandlers() {
  const form = $('chat-form');
  userInput.addEventListener('input', () => {
    userInput.style.height = 'auto';
    userInput.style.height = Math.min(userInput.scrollHeight, 200) + 'px';
  });
  if (form) {
    form.addEventListener('submit', e => { e.preventDefault(); sendMessage(); });
  } else {
    userInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
    sendButton.addEventListener('click', sendMessage);
  }
  const toolsBtn = $('tools-btn'), toolsPopup = $('tools-popup');
  if (toolsBtn && toolsPopup) {
    toolsBtn.addEventListener('click', () => toolsPopup.classList.toggle('pointer-events-none'));
    document.addEventListener('click', e => {
      if (!toolsPopup.contains(e.target) && !toolsBtn.contains(e.target)) toolsPopup.classList.add('pointer-events-none');
    });
  }
}

/* ---------- 10.  send ---------- */
async function sendMessage() {
  const msg = userInput.value.trim();
  if ((msg === '' && pendingFiles.length === 0) || isProcessing) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    addToast('Connecting…', 'info');
    connectWebSocket();
    await sleep(1200);
    if (!ws || ws.readyState !== WebSocket.OPEN) { addToast('Still connecting – please retry', 'error'); return; }
  }
  isProcessing = true; disableInput();
  hideWelcome();
  addUserMessage(msg || 'Sent files for analysis.');
  userInput.value = ''; userInput.style.height = 'auto';
  showTypingIndicator('Processing…');
  try {
    ws.send(JSON.stringify({type: 'user_message', content: msg, files: pendingFiles}));
  } catch (e) {
    console.error('send error', e);
    addToast('Send failed – please retry', 'error');
    isProcessing = false; enableInput(true); hideTypingIndicator();
  }
}

/* ---------- 11.  server messages ---------- */
function handleServerMessage(d) {
  switch (d.type) {
    case 'status':
      updateTypingIndicator(d.message); break;
    case 'chunk':
      if (!currentMessageEl) { hideWelcome(); currentMessageEl = createMessageElement('assistant'); }
      appendToMessage(currentMessageEl, d.content);
      scrollToBottom(true);
      break;
    case 'tool_use':
      if (d.tools?.length) showToolUse(d.tools); break;
    case 'done':
      hideTypingIndicator();
      if (currentMessageEl) finalizeMessage(currentMessageEl);
      currentMessageEl = null; isProcessing = false; enableInput(false);
      scrollToBottom(true);
      pendingFiles = []; filePreview.innerHTML = ''; updateFilePreview();
      break;
    case 'error':
      hideTypingIndicator(); addToast(`Error: ${d.error}`, 'error');
      currentMessageEl = null; isProcessing = false; enableInput(true);
      break;
  }
}
function showToolUse(tools) {
  if (!currentMessageEl) { hideWelcome(); currentMessageEl = createMessageElement('assistant'); }
  const div = document.createElement('div');
  div.className = 'text-xs text-gray-400 mt-2 p-2 bg-white/5 rounded border border-white/10';
  div.innerHTML = `🔧 Using: **${tools.join(', ')}**`;
  currentMessageEl.querySelector('.message-content').appendChild(div);
  scrollToBottom(true);
}

/* ---------- 12.  message DOM ---------- */
function createMessageElement(role) {
  const isUser = role === 'user';
  const wrap = document.createElement('div'); wrap.className = 'p-4 md:p-6';
  const el = document.createElement('div'); el.className = 'flex items-start gap-4 max-w-4xl mx-auto';
  el.innerHTML = `
    <div class="w-8 h-8 flex-shrink-0 rounded-full flex items-center justify-center text-white ${isUser ? 'bg-gray-500' : 'bg-teal-600'}">
      ${isUser ? '👤' : `<svg class="w-5 h-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/></svg>`}
    </div>
    <div class="flex-1 min-w-0">
      <h3 class="font-semibold mb-2">${isUser ? 'You' : 'Orion'}</h3>
      <div class="message-content text-gray-200"></div>
    </div>`;
  wrap.appendChild(el); chatMessages.appendChild(wrap); return el;
}
function appendToMessage(el, txt) {
  const content = el.querySelector('.message-content');
  if (!content.dataset.streaming) { content.dataset.streaming = 'true'; content.dataset.rawContent = ''; }
  content.dataset.rawContent += txt;
  content.textContent = content.dataset.rawContent;
}
function finalizeMessage(el) {
  const content = el.querySelector('.message-content');
  const raw = content.dataset.rawContent || content.textContent;
  content.innerHTML = marked.parse(raw);
  content.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
  delete content.dataset.streaming; delete content.dataset.rawContent;
}
function addUserMessage(txt, scroll = true) {
  const el = createMessageElement('user');
  el.querySelector('.message-content').textContent = txt;
  if (scroll) scrollToBottom(true);
}
function addAssistantMessage(txt, scroll = true) {
  const el = createMessageElement('assistant');
  el.querySelector('.message-content').innerHTML = marked.parse(txt);
  el.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
  if (scroll) scrollToBottom(false);
}

/* ---------- 13.  typing ---------- */
function showTypingIndicator(msg = 'Thinking…') {
  typingText.textContent = msg; typingIndicator.classList.remove('hidden'); scrollToBottom(true);
}
function updateTypingIndicator(msg) { typingText.textContent = msg; }
function hideTypingIndicator() { typingIndicator.classList.add('hidden'); }

/* ---------- 14.  input lock ---------- */
function disableInput() { userInput.disabled = true; sendButton.disabled = true; }
function enableInput(focus = true) {
  userInput.disabled = false; sendButton.disabled = false; if (focus) userInput.focus();
}

/* ---------- 15.  scroll ---------- */
function scrollToBottom(smooth = false) {
  chatContainer?.scrollTo({top: chatContainer.scrollHeight, behavior: smooth ? 'smooth' : 'auto'});
}

/* ---------- 16.  connection status ---------- */
function updateConnectionStatus(txt, cls) {
  $('status-indicator')?.classList?.replace(/bg-\w+-500/, cls);
  $('status-text') && ($('status-text').textContent = txt);
}

/* ---------- 17.  toast ---------- */
function addToast(msg, type = 'info') {
  const colors = {error: 'bg-red-600', success: 'bg-teal-600', info: 'bg-blue-600'};
  const t = document.createElement('div');
  t.className = `fixed bottom-5 right-5 p-3 rounded-lg shadow-xl z-50 text-white text-sm transition transform translate-x-full opacity-0`;
  t.classList.add(colors[type] || colors.info);
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.remove('translate-x-full', 'opacity-0'), 10);
  setTimeout(() => { t.classList.add('translate-x-full', 'opacity-0'); setTimeout(() => t.remove(), 300); }, 3000);
}

/* ---------- 18.  history ---------- */
async function loadChatHistory() {
  try {
    const r = await fetch('/api/history');
    if (!r.ok) return;
    const j = await r.json();
    if (j.messages?.length) {
      hideWelcome();
      j.messages.forEach(m => {
        const role = m.role === 'model' ? 'assistant' : 'user';
        const text = m.parts?.filter(p => p.text).map(p => p.text).join('\n');
        if (text) role === 'user' ? addUserMessage(text, false) : addAssistantMessage(text, false);
      });
      scrollToBottom(false);
    }
  } catch (e) { console.error('history', e); }
}

/* ---------- 19.  clear ---------- */
window.clearChat = async function() {
  if (!confirm('Start a new chat? Conversation will be lost.')) return;
  try {
    const r = await fetch('/api/clear', {method: 'POST'});
    if (r.ok) {
      chatMessages.innerHTML = '';
      pendingFiles = []; filePreview.innerHTML = ''; conversationStarted = false;
      chatMessages.innerHTML = `
        <div id="welcome-message" class="text-center py-20 px-4">
          <div class="inline-block bg-gradient-to-br from-teal-500 to-blue-600 rounded-full p-3 mb-6 shadow-lg">
            <svg class="w-10 h-10 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/></svg>
          </div>
          <h2 class="text-3xl md:text-4xl font-bold text-white mb-4">How can I help you today?</h2>
          <p class="text-gray-400 mb-8">I can search the web, execute code, analyze files, and help with complex tasks</p>
          <div class="flex flex-wrap gap-2 justify-center max-w-2xl mx-auto">
            <button onclick="useSuggestion(this)" class="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-full text-sm transition-colors">What's Bitcoin's price? 💰</button>
            <button onclick="useSuggestion(this)" class="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-full text-sm transition-colors">Analyze this dataset 📊</button>
            <button onclick="useSuggestion(this)" class="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-full text-sm transition-colors">Write Python code 💻</button>
            <button onclick="useSuggestion(this)" class="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-full text-sm transition-colors">Latest AI news 🔍</button>
          </div>
        </div>`;
      window.welcomeScreen = $('welcome-message');
      addToast('Chat cleared', 'success');
    }
  } catch (e) { console.error('clear', e); addToast('Failed to clear chat', 'error'); }
};

/* ---------- 20.  suggestions ---------- */
window.useSuggestion = function(el) {
  const txt = el.textContent.trim().replace(/[\uD800-\uDBFF\uDC00-\uDFFF].*$/g, '').trim();
  userInput.value = txt;
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 200) + 'px';
  userInput.focus();
};

/* ---------- 21.  welcome ---------- */
function hideWelcome() {
  if (!conversationStarted) { welcomeScreen?.classList.add('hidden'); conversationStarted = true; }
}

/* ---------- 22.  geo stub (optional) ---------- */
/*  if you actually need LBS, implement the real call here  */
window.getCurrentPosition = async () => ({lat: 0, lon: 0, addr: 'Earth'});
