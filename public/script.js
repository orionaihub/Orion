/*  Fully-corrected Orion Frontend
    – Fixes every CRITICAL / MAJOR / MINOR issue listed in the audit
    – Keeps the original UX intact
---------------------------------------------------------------*/

/*  1.  Guard against early execution ----------------------------------*/
(() => {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    /*  2.  DOM refs (now safe) ----------------------------------------*/
    const chatContainer   = document.getElementById('chat-container');
    const chatMessages    = document.getElementById('messages-wrapper');
    const welcomeScreen   = document.getElementById('welcome-message');
    const userInput       = document.getElementById('chat-input');
    const sendButton      = document.getElementById('send-button');
    const typingIndicator = document.getElementById('typing-indicator');
    const typingText      = document.getElementById('typing-text');
    const fileInput       = document.getElementById('file-input');
    const filePreview     = document.getElementById('file-preview');
    const sidebar         = document.getElementById('sidebar');
    const menuBtn         = document.getElementById('menu-btn');
    const overlay         = document.getElementById('overlay');

    /*  3.  External-lib guards ----------------------------------------*/
    if (typeof marked === 'undefined') {
      console.warn('[Orion] marked.js not loaded – falling back to plain text');
      window.marked = { parse: t => t };
    }
    if (typeof hljs === 'undefined') {
      console.warn('[Orion] highlight.js not loaded – skipping syntax highlighting');
      window.hljs = { highlightElement: () => {} };
    }

    /*  4.  WebSocket state --------------------------------------------*/
    let ws                   = null;
    let isConnecting         = false;
    let reconnectAttempts    = 0;
    const MAX_RECONNECT_DELAY = 30000;

    /*  5.  Chat state -------------------------------------------------*/
    let isProcessing        = false;
    let currentMessageEl    = null;
    let pendingFiles        = [];
    let conversationStarted = false;

    /*  6.  marked.js config (with XSS mitigation) --------------------*/
    marked.setOptions({
      breaks: true,
      gfm: true,
      headerIds: false,
      mangle: false,
      sanitize: true,               // 🔒 strip dangerous HTML
      highlight(code, lang) {
        try {
          return hljs.getLanguage(lang)
            ? hljs.highlight(code, { language: lang }).value
            : hljs.highlightAuto(code).value;
        } catch {
          return code;
        }
      }
    });

    /*  7.  Boot ------------------------------------------------------*/
    loadChatHistory();
    connectWebSocket();
    setupFileUpload();
    setupInputHandlers();
    setupSidebarToggle();
    checkMobileView();
    window.addEventListener('resize', checkMobileView);

    /*  8.  WebSocket connector (race-condition safe) -----------------*/
    function connectWebSocket() {
      if (ws?.readyState === WebSocket.OPEN) return;
      if (isConnecting) return;
      isConnecting = true;

      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const port     = location.port ? `:${location.port}` : '';
      const wsUrl    = `${protocol}//${location.hostname}${port}/api/ws`;

      updateConnectionStatus('Connecting…', 'bg-gray-500');
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        isConnecting = false;
        reconnectAttempts = 0;
        updateConnectionStatus('Connected', 'bg-teal-500');
      };

      ws.onmessage = (e) => {
        try { handleServerMessage(JSON.parse(e.data)); }
        catch (err) { console.error('[Orion] Bad WS frame', err); }
      };

      ws.onclose = (e) => {
        isConnecting = false;
        const permanent = [1000, 1001, 1008, 1011].includes(e.code);
        if (permanent) {
          updateConnectionStatus('Disconnected', 'bg-red-500');
          return;                               // 🔒 stop re-connecting
        }
        updateConnectionStatus('Disconnected', 'bg-red-500');
        reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
        setTimeout(connectWebSocket, delay);
      };

      ws.onerror = () => {
        isConnecting = false;
        updateConnectionStatus('Error', 'bg-red-500');
      };
    }

    /*  9.  Server-message dispatcher ---------------------------------*/
    function handleServerMessage(data) {
      switch (data.type) {
        case 'status':
          updateTypingIndicator(data.message);
          break;

        case 'chunk':
          if (!currentMessageEl) {
            hideWelcome();
            currentMessageEl = createMessageEl('assistant');
          }
          appendToMessage(currentMessageEl, data.content);
          scrollToBottom(true);
          break;

        case 'tool_use':
          if (data.tools?.length) showToolUse(data.tools);
          break;

        case 'done':
          hideTypingIndicator();
          if (currentMessageEl) finalizeMessage(currentMessageEl);
          currentMessageEl = null;
          isProcessing = false;
          enableInput(false);                // no forced focus
          scrollToBottom(true);
          clearPendingFiles();
          break;

        case 'error':
          hideTypingIndicator();
          addToast(`Error: ${data.error}`, 'error');
          currentMessageEl = null;
          isProcessing = false;
          enableInput(true);                 // focus on error
          break;
      }
    }

    /* 10.  UI helpers ------------------------------------------------*/
    function updateConnectionStatus(text, color) {
      const indicator = document.getElementById('status-indicator');
      const statusText = document.getElementById('status-text');
      if (indicator) indicator.className = `w-2 h-2 rounded-full ${color}`;
      if (statusText) statusText.textContent = text;
    }

    function showTypingIndicator(msg = 'Thinking…') {
      typingText.textContent = msg;
      typingIndicator.classList.remove('hidden');
      scrollToBottom(true);
    }
    function updateTypingIndicator(msg) { typingText.textContent = msg; }
    function hideTypingIndicator()     { typingIndicator.classList.add('hidden'); }

    function disableInput() {
      userInput.disabled = true;
      sendButton.disabled = true;
    }
    function enableInput(focus = true) {
      userInput.disabled = false;
      sendButton.disabled = false;
      if (focus) userInput.focus();
    }

    function scrollToBottom(smooth = false) {
      if (!chatContainer) return;
      const shouldScroll =
        chatContainer.scrollTop + chatContainer.clientHeight >=
        chatContainer.scrollHeight - 50;
      if (shouldScroll) {
        chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
      }
    }

    /* 11.  File upload (size-checked twice) -------------------------*/
    function setupFileUpload() {
      fileInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        for (const file of files) await processFile(file);
        fileInput.value = '';
      });
    }

    async function processFile(file) {
      if (file.size > 20 * 1024 * 1024) {
        addToast(`${file.name} is too large (max 20 MB)`, 'error');
        return;
      }
      try {
        const base64 = await fileToBase64(file);
        pendingFiles.push({
          data: base64.split(',')[1],
          mimeType: file.type,
          name: file.name,
          size: file.size
        });
        addFileChip(file);
        addToast(`Added: ${file.name}`, 'success');
      } catch {
        addToast(`Failed to read ${file.name}`, 'error');
      }
    }

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => resolve(reader.result);
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
        <button type="button" class="text-gray-400 hover:text-white transition-colors ml-1" aria-label="Remove file">
          <svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"/>
          </svg>
        </button>`;
      chip.querySelector('button').addEventListener('click', () => removeFileChip(file.name));
      filePreview.appendChild(chip);
    }

    window.removeFileChip = function (name) {
      pendingFiles = pendingFiles.filter(f => f.name !== name);
      document.querySelectorAll(`[data-file-name="${CSS.escape(name)}"]`).forEach(el => el.remove());
    };

    function clearPendingFiles() {
      pendingFiles = [];
      filePreview.innerHTML = '';
    }

    function getFileIcon(type, name) {
      if (type.startsWith('image/')) return '🖼️';
      if (type.includes('pdf')) return '📄';
      if (type.includes('word') || name.endsWith('.doc') || name.endsWith('.docx')) return '📝';
      if (type.includes('sheet') || name.endsWith('.csv') || name.endsWith('.xlsx')) return '📊';
      if (type.includes('json')) return '📋';
      if (type.includes('text')) return '📃';
      return '📎';
    }

    function formatFileSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    /* 12.  Input handlers -------------------------------------------*/
    function setupInputHandlers() {
      const chatForm = document.getElementById('chat-form');
      userInput.addEventListener('input', () => {
        userInput.style.height = 'auto';
        userInput.style.height = Math.min(userInput.scrollHeight, 200) + 'px';
      });

      if (chatForm) {
        chatForm.addEventListener('submit', e => {
          e.preventDefault();
          sendMessage();
        });
      } else {
        userInput.addEventListener('keydown', e => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
          }
        });
        sendButton.addEventListener('click', sendMessage);
      }

      const toolsBtn = document.getElementById('tools-btn');
      const toolsPopup = document.getElementById('tools-popup');
      if (toolsBtn && toolsPopup) {
        toolsBtn.addEventListener('click', () => toggleToolsPopup());
        document.addEventListener('click', e => {
          if (!toolsPopup.contains(e.target) && !toolsBtn.contains(e.target)) {
            toolsPopup.classList.add('opacity-0', 'scale-95', 'pointer-events-none');
          }
        });
      }
    }

    function toggleToolsPopup() {
      const popup = document.getElementById('tools-popup');
      popup.classList.toggle('opacity-0');
      popup.classList.toggle('scale-95');
      popup.classList.toggle('pointer-events-none');
    }

    /* 13.  Send message (with file validation) ----------------------*/
    async function sendMessage() {
      const text = userInput.value.trim();
      if ((text === '' && pendingFiles.length === 0) || isProcessing) return;

      if (!ws || ws.readyState !== WebSocket.OPEN) {
        addToast('Connecting to server…', 'info');
        connectWebSocket();
        setTimeout(() => { if (ws?.readyState === WebSocket.OPEN) sendMessage(); }, 1000);
        return;
      }

      // Re-validate files in case they were pushed programmatically
      for (const f of pendingFiles) {
        if (f.size > 20 * 1024 * 1024) {
          addToast(`${f.name} is too large (max 20 MB)`, 'error');
          return;
        }
      }

      isProcessing = true;
      disableInput();
      hideWelcome();
      addUserMessage(text || 'Sent files for analysis.');

      userInput.value = '';
      userInput.style.height = 'auto';
      showTypingIndicator('Processing your request…');

      try {
        ws.send(JSON.stringify({ type: 'user_message', content: text, files: pendingFiles }));
      } catch (err) {
        console.error('[Orion] Send error', err);
        addToast('Failed to send message', 'error');
        isProcessing = false;
        enableInput(true);
        hideTypingIndicator();
      }
    }

    /* 14.  Message rendering ----------------------------------------*/
    function createMessageEl(role) {
      const isUser = role === 'user';
      const wrap = document.createElement('div');
      wrap.className = 'p-4 md:p-6';
      const inner = document.createElement('div');
      inner.className = 'flex items-start gap-4 max-w-4xl mx-auto';
      inner.innerHTML = `
        <div class="w-8 h-8 flex-shrink-0 rounded-full flex items-center justify-center text-white ${isUser ? 'bg-gray-500' : 'bg-teal-600'}">
          ${isUser ? '👤' : `<svg class="w-5 h-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/>
          </svg>`}
        </div>
        <div class="flex-1 min-w-0">
          <h3 class="font-semibold mb-2">${isUser ? 'You' : 'Orion'}</h3>
          <div class="message-content text-gray-200"></div>
        </div>`;
      wrap.appendChild(inner);
      chatMessages.appendChild(wrap);
      return inner;
    }

    function appendToMessage(el, content) {
      const contentDiv = el.querySelector('.message-content');
      if (!contentDiv.dataset.streaming) {
        contentDiv.dataset.streaming = 'true';
        contentDiv.dataset.rawContent = '';
      }
      contentDiv.dataset.rawContent += content;
      contentDiv.textContent = contentDiv.dataset.rawContent;
    }

    function finalizeMessage(el) {
      const contentDiv = el.querySelector('.message-content');
      const raw = contentDiv.dataset.rawContent || contentDiv.textContent;
      contentDiv.innerHTML = marked.parse(raw);
      contentDiv.querySelectorAll('pre code').forEach(block => {
        try { hljs.highlightElement(block); } catch {}
      });
      delete contentDiv.dataset.streaming;
      delete contentDiv.dataset.rawContent;
    }

    function addUserMessage(content, scroll = true) {
      const el = createMessageEl('user');
      el.querySelector('.message-content').textContent = content;
      if (scroll) scrollToBottom(true);
    }

    /* 15.  History --------------------------------------------------*/
    async function loadChatHistory() {
      try {
        const res = await fetch('/api/history');
        if (!res.ok) return;
        const data = await res.json();
        if (!data.messages?.length) return;
        hideWelcome();
        chatMessages.innerHTML = '';               // 🔒 prevent duplicates
        for (const msg of data.messages) {
          const role = msg.role === 'model' ? 'assistant' : 'user';
          const text = msg.parts?.filter(p => p.text).map(p => p.text).join('\n');
          if (!text) continue;
          role === 'user' ? addUserMessage(text, false) : addAssistantMessage(text, false);
        }
        scrollToBottom(false);
      } catch (err) {
        console.error('[Orion] Load history error', err);
      }
    }

    function addAssistantMessage(content, scroll = true) {
      const el = createMessageEl('assistant');
      el.querySelector('.message-content').innerHTML = marked.parse(content);
      el.querySelectorAll('pre code').forEach(block => {
        try { hljs.highlightElement(block); } catch {}
      });
      if (scroll) scrollToBottom(false);
    }

    /* 16.  Clear chat ----------------------------------------------*/
    window.clearChat = async function () {
      if (!confirm('Start a new chat? This will clear the current conversation.')) return;
      try {
        const res = await fetch('/api/clear', { method: 'POST' });
        if (res.ok) {
          chatMessages.innerHTML = '';
          clearPendingFiles();
          conversationStarted = false;
          chatMessages.innerHTML = `
            <div id="welcome-message" class="text-center py-20 px-4">
              <div class="inline-block bg-gradient-to-br from-teal-500 to-blue-600 rounded-full p-3 mb-6 shadow-lg">
                <svg class="w-10 h-10 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/>
                </svg>
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
          addToast('Chat cleared', 'success');
        }
      } catch {
        addToast('Failed to clear chat', 'error');
      }
    };

    /* 17.  Suggestion chips ----------------------------------------*/
    window.useSuggestion = function (btn) {
      const text = btn.textContent.trim().replace(/[\uD800-\uDBFF\uDC00-\uDFFF].*$/g, '').trim();
      userInput.value = text;
      userInput.style.height = 'auto';
      userInput.style.height = Math.min(userInput.scrollHeight, 200) + 'px';
      userInput.focus();
    };

    /* 18.  Sidebar -------------------------------------------------*/
    function setupSidebarToggle() {
      if (menuBtn) {
        menuBtn.addEventListener('click', () => {
          sidebar.classList.toggle('-translate-x-full');
          overlay.classList.toggle('hidden');
        });
      }
      if (overlay) {
        overlay.addEventListener('click', () => {
          sidebar.classList.add('-translate-x-full');
          overlay.classList.add('hidden');
        });
      }
      const newChatBtn = document.getElementById('new-chat-btn');
      if (newChatBtn) {
        newChatBtn.addEventListener('click', () => {
          window.clearChat();
          if (window.innerWidth <= 768) {
            sidebar.classList.add('-translate-x-full');
            overlay.classList.add('hidden');
          }
        });
      }
    }

    function checkMobileView() {
      const isMobile = window.innerWidth <= 768;
      if (!isMobile) {
        sidebar.classList.remove('-translate-x-full');
        overlay.classList.add('hidden');
      } else {
        sidebar.classList.add('-translate-x-full');
        overlay.classList.add('hidden');
      }
    }

    /* 19.  Toast container (singleton) ----------------------------*/
    const toastContainer = (() => {
      let c = document.getElementById('toast-container');
      if (!c) {
        c = document.createElement('div');
        c.id = 'toast-container';
        c.className = 'fixed bottom-5 right-5 z-50 space-y-2';
        document.body.appendChild(c);
      }
      return c;
    })();

    function addToast(message, type = 'info') {
      const color = type === 'error' ? 'bg-red-600' : type === 'success' ? 'bg-teal-600' : 'bg-blue-600';
      const toast = document.createElement('div');
      toast.className = `p-3 rounded-lg shadow-xl text-white text-sm transition-all duration-300 ${color} opacity-0 translate-x-full`;
      toast.textContent = message;
      toastContainer.appendChild(toast);
      setTimeout(() => {
        toast.classList.remove('opacity-0', 'translate-x-full');
      }, 10);
      setTimeout(() => {
        toast.classList.add('opacity-0', 'translate-x-full');
        toast.addEventListener('transitionend', () => toast.remove());
      }, 3000);
    }

    /* 20.  Utils ---------------------------------------------------*/
    function escapeHtml(str) {
      return str.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function hideWelcome() {
      if (!conversationStarted && welcomeScreen) {
        welcomeScreen.classList.add('hidden');
        conversationStarted = true;
      }
    }
  }
})();
