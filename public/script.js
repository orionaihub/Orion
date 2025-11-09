/**
 * Fully Adapted Orion Frontend (from provided index.html.txt and styles.css.txt)
 * - Fixed all DOM ID mismatches.
 * - Implemented smooth scrolling on streaming chunks.
 */

// --- DOM elements (CRITICAL FIXES APPLIED) ---
// The main scrolling container from index.html: <div id="chat-container" class="flex-1 overflow-y-auto custom-scrollbar">
const chatContainer = document.getElementById("chat-container");
// The inner wrapper for all messages from index.html: <div id="messages-wrapper" class="max-w-4xl mx-auto pb-4 pt-6">
const chatMessages = document.getElementById("messages-wrapper");
// Welcome message container from index.html: <div id="welcome-message" ...>
const welcomeScreen = document.getElementById("welcome-message"); 
// Input elements from index.html
const userInput = document.getElementById("chat-input"); 
const sendButton = document.getElementById("send-button");
// Typing indicator container from index.html: <div id="typing-indicator" ...>
const typingIndicator = document.getElementById("typing-indicator");
const typingText = document.getElementById("typing-text");
// File elements
const fileInput = document.getElementById("file-input");
const filePreview = document.getElementById("file-preview"); 
// Sidebar and mobile controls
const sidebar = document.getElementById("sidebar");
const menuBtn = document.getElementById("menu-btn");
const overlay = document.getElementById("overlay");

// WebSocket connection
let ws = null;
let isConnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;

// Chat state
let isProcessing = false;
let currentMessageElement = null;
let pendingFiles = [];
let conversationStarted = false;

// Configure marked.js for better markdown rendering
marked.setOptions({
  breaks: true,
  gfm: true,
  headerIds: false,
  mangle: false,
  highlight: function(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang }).value;
      } catch (err) {
        console.error('Highlight error:', err);
      }
    }
    return hljs.highlightAuto(code).value;
  }
});

// Load chat history on page load
window.addEventListener('DOMContentLoaded', () => {
  loadChatHistory();
  connectWebSocket();
  setupFileUpload();
  setupInputHandlers();
  setupSidebarToggle(); 
  checkMobileView();
});

// Window resize handler
window.addEventListener('resize', checkMobileView);

/**
 * Check if mobile view and adjust sidebar
 */
function checkMobileView() {
  const isMobile = window.innerWidth <= 768;
  if (!isMobile) {
    sidebar.classList.remove('-translate-x-full');
    overlay.classList.add('hidden');
  } else {
    if (!sidebar.classList.contains('-translate-x-full')) {
       sidebar.classList.add('-translate-x-full');
    }
    overlay.classList.add('hidden');
  }
}

/**
 * Setup mobile sidebar toggle handlers
 */
function setupSidebarToggle() {
  // Mobile menu button (ID: menu-btn)
  if (menuBtn) {
    menuBtn.addEventListener('click', () => {
      sidebar.classList.toggle('-translate-x-full');
      overlay.classList.toggle('hidden');
    });
  }
  
  // Overlay click to close (ID: overlay)
  if (overlay) {
    overlay.addEventListener('click', () => {
      sidebar.classList.add('-translate-x-full');
      overlay.classList.add('hidden');
    });
  }
  
  // New Chat button from sidebar (ID: new-chat-btn)
  const newChatBtn = document.getElementById('new-chat-btn');
  if (newChatBtn) {
      newChatBtn.addEventListener('click', () => {
          clearChat();
          // Hide sidebar on mobile after clicking
          if (window.innerWidth <= 768) {
              sidebar.classList.add('-translate-x-full');
              overlay.classList.add('hidden');
          }
      });
  }
}

/**
 * Setup file upload handler
 */
function setupFileUpload() {
  fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) {
        addToast(`File ${file.name} is too large (max 20MB)`, 'error');
        continue;
      }

      try {
        const base64 = await fileToBase64(file);
        const fileData = {
          data: base64.split(',')[1],
          mimeType: file.type,
          name: file.name,
          size: file.size
        };
        
        pendingFiles.push(fileData);
        addFileChip(file);
        
        addToast(`Added: ${file.name}`, 'success');
      } catch (error) {
        console.error('File reading failed:', error);
        addToast(`Failed to read ${file.name}`, 'error');
      }
    }

    fileInput.value = '';
    updateFilePreview();
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

/**
 * Add file chip to UI (ID: file-preview)
 */
function addFileChip(file) {
  const chip = document.createElement('div');
  chip.className = 'flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 text-xs text-white';
  chip.dataset.fileName = file.name;
  
  const icon = getFileIcon(file.type, file.name);
  
  chip.innerHTML = `
    <span>${icon}</span>
    <span class="truncate max-w-[150px]">${escapeHtml(file.name)}</span>
    <span class="text-gray-400">(${formatFileSize(file.size)})</span>
    <button type="button" class="text-gray-400 hover:text-white transition-colors ml-1" onclick="removeFileChip('${escapeHtml(file.name)}')" aria-label="Remove file">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
        </svg>
    </button>
  `;
  
  filePreview.appendChild(chip);
}

function getFileIcon(mimeType, fileName) {
  if (mimeType.startsWith('image/')) return '🖼️';
  if (mimeType.includes('pdf')) return '📄';
  if (mimeType.includes('word') || fileName.endsWith('.doc') || fileName.endsWith('.docx')) return '📝';
  if (mimeType.includes('sheet') || fileName.endsWith('.csv') || fileName.endsWith('.xlsx')) return '📊';
  if (mimeType.includes('json')) return '📋';
  if (mimeType.includes('text')) return '📃';
  return '📎';
}

/**
 * Remove file chip (exposed globally)
 */
window.removeFileChip = function(fileName) {
  pendingFiles = pendingFiles.filter(f => f.name !== fileName);
  
  const chips = filePreview.querySelectorAll('[data-file-name]');
  chips.forEach(chip => {
    if (chip.dataset.fileName === fileName) {
      chip.remove();
    }
  });
  
  updateFilePreview();
}

function updateFilePreview() {
  // Logic remains for potential future expansion
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * Setup input handlers (Focus fixed on form submit)
 */
function setupInputHandlers() {
  const chatForm = document.getElementById('chat-form'); // ID from index.html

  // Auto-resize textarea
  userInput.addEventListener("input", function () {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 200) + "px";
  });

  // Handle form submission (prevents default focus jump)
  if (chatForm) {
      chatForm.addEventListener('submit', (e) => {
          e.preventDefault(); // Prevent default form submission
          sendMessage();
      });
  } else {
      // Fallback for enter key
      userInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
      sendButton.addEventListener("click", sendMessage);
  }

  // Tools Button Toggle
  const toolsBtn = document.getElementById('tools-btn');
  const toolsPopup = document.getElementById('tools-popup');
  
  if (toolsBtn && toolsPopup) {
      toolsBtn.addEventListener('click', () => {
          toolsPopup.classList.toggle('opacity-0');
          toolsPopup.classList.toggle('scale-95');
          toolsPopup.classList.toggle('pointer-events-none');
      });
      
      document.addEventListener('click', (e) => {
          if (!toolsPopup.contains(e.target) && !toolsBtn.contains(e.target) && !toolsPopup.classList.contains('opacity-0')) {
              toolsPopup.classList.add('opacity-0');
              toolsPopup.classList.add('scale-95');
              toolsPopup.classList.add('pointer-events-none');
          }
      });
  }
}

/**
 * Connect to WebSocket (Standard logic retained)
 */
function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (isConnecting) return;

  isConnecting = true;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const port = location.port ? `:${location.port}` : '';
  const wsUrl = `${protocol}//${location.hostname}${port}/api/ws`;

  console.log('Connecting to WebSocket:', wsUrl);

  updateConnectionStatus('Connecting...', 'bg-gray-500');

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('WebSocket connected');
    isConnecting = false;
    reconnectAttempts = 0;
    updateConnectionStatus('Connected', 'bg-teal-500');
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleServerMessage(data);
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
    }
  };

  ws.onclose = (event) => {
    console.log('WebSocket closed:', event.code, event.reason);
    isConnecting = false;
    updateConnectionStatus('Disconnected', 'bg-red-500');
    
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
    console.log(`Reconnecting in ${delay}ms...`);
    setTimeout(connectWebSocket, delay);
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    isConnecting = false;
    updateConnectionStatus('Error', 'bg-red-500');
  };
}

/**
 * Update connection status UI (Fixed IDs: status-indicator, status-text)
 */
function updateConnectionStatus(text, colorClass) {
  const indicator = document.getElementById('status-indicator');
  const statusText = document.getElementById('status-text');
  
  if (indicator) {
    indicator.className = `w-2 h-2 rounded-full ${colorClass}`;
  }
  if (statusText) {
    statusText.textContent = text;
  }
}

/**
 * Handle messages from the server
 */
function handleServerMessage(data) {
  console.log('Received:', data.type, data);

  switch (data.type) {
    case 'status':
      updateTypingIndicator(data.message);
      break;

    case 'chunk':
      if (!currentMessageElement) {
        hideWelcome();
        currentMessageElement = createMessageElement('assistant');
      }
      appendToMessage(currentMessageElement, data.content);
      // 🔥 CRITICAL UX FIX: Smooth scroll on every chunk
      scrollToBottom(true); 
      break;

    case 'tool_use':
      if (data.tools && data.tools.length > 0) {
        showToolUse(data.tools);
      }
      break;

    case 'done':
      hideTypingIndicator();
      if (currentMessageElement) {
        finalizeMessage(currentMessageElement);
      }
      currentMessageElement = null;
      isProcessing = false;
      // Removed enableInput() focus call here to prevent cursor jump
      enableInput(false); 
      
      // Final smooth scroll after rendering markdown
      scrollToBottom(true);
      
      // Clear pending files after successful send
      pendingFiles = [];
      filePreview.innerHTML = ''; 
      updateFilePreview();
      break;

    case 'error':
      hideTypingIndicator();
      addToast(`Error: ${data.error}`, 'error');
      currentMessageElement = null;
      isProcessing = false;
      enableInput(true); // Re-focus on error
      break;

    default:
      console.log('Unknown message type:', data.type);
  }
}

/**
 * Show tool usage indicator
 */
function showToolUse(tools) {
  if (!currentMessageElement) {
    hideWelcome();
    currentMessageElement = createMessageElement('assistant');
  }
  
  const toolIndicator = document.createElement('div');
  toolIndicator.className = 'text-xs text-gray-400 mt-2 p-2 bg-white/5 rounded-lg border border-white/10';
  toolIndicator.innerHTML = `🔧 Using tools: **${tools.join(', ')}**`;
  
  const content = currentMessageElement.querySelector('.message-content');
  content.appendChild(toolIndicator);
  scrollToBottom(true);
}

/**
 * Send message to the agent
 */
async function sendMessage() {
  const message = userInput.value.trim();

  if (message === "" && pendingFiles.length === 0 || isProcessing) return;

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    addToast('Connecting to server...', 'info');
    connectWebSocket();
    setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        sendMessage();
      }
    }, 1000);
    return;
  }

  isProcessing = true;
  disableInput();

  hideWelcome();

  addUserMessage(message || 'Sent files for analysis.');

  userInput.value = "";
  userInput.style.height = "auto";

  showTypingIndicator('Processing your request...');

  try {
    const payload = {
      type: 'user_message',
      content: message
    };

    if (pendingFiles.length > 0) {
      payload.files = pendingFiles;
    }

    ws.send(JSON.stringify(payload));
  } catch (error) {
    console.error('Error sending message:', error);
    addToast('Failed to send message. Please try again.', 'error');
    isProcessing = false;
    enableInput(true);
    hideTypingIndicator();
  }
}

function hideWelcome() {
  if (!conversationStarted) {
    if (welcomeScreen) {
        welcomeScreen.classList.add('hidden');
    }
    conversationStarted = true;
  }
}

/**
 * Load chat history (Standard logic retained)
 */
async function loadChatHistory() {
  try {
    const response = await fetch('/api/history');
    if (response.ok) {
      const data = await response.json();
      
      if (data.messages && data.messages.length > 0) {
        hideWelcome();
        
        data.messages.forEach(msg => {
          const role = msg.role === 'model' ? 'assistant' : 'user';
          if (msg.parts && msg.parts.length > 0) {
            const textParts = msg.parts
              .filter(p => p.text)
              .map(p => p.text)
              .join('\n');
            if (textParts) {
              if (role === 'user') {
                addUserMessage(textParts, false);
              } else {
                addAssistantMessage(textParts, false);
              }
            }
          }
        });
        
        scrollToBottom(false);
      }
    }
  } catch (error) {
    console.error('Error loading chat history:', error);
  }
}

/**
 * Create a message element (Corrected for Orion/Assistant icon)
 */
function createMessageElement(role) {
  const isUser = role === 'user';
  const wrapper = document.createElement("div");
  wrapper.className = "p-4 md:p-6";
  
  const messageEl = document.createElement("div");
  messageEl.className = "flex items-start gap-4 max-w-4xl mx-auto";
  
  const avatarBg = isUser ? 'bg-gray-500' : 'bg-teal-600';
  const senderText = isUser ? 'You' : 'Orion'; 
  const iconSvg = `<svg class="w-5 h-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
    </svg>`;
    
  const avatar = isUser ? '👤' : iconSvg; 

  messageEl.innerHTML = `
    <div class="w-8 h-8 flex-shrink-0 rounded-full flex items-center justify-center text-white ${avatarBg}">
      ${avatar}
    </div>
    <div class="flex-1 min-w-0">
      <h3 class="font-semibold mb-2">${senderText}</h3>
      <div class="message-content text-gray-200"></div>
    </div>
  `;
  
  // Append to the wrapper: messages-wrapper
  chatMessages.appendChild(wrapper);
  
  return messageEl;
}

/**
 * Append content to a message (streaming)
 */
function appendToMessage(element, content) {
  const contentDiv = element.querySelector('.message-content');
  
  if (!contentDiv.dataset.streaming) {
    contentDiv.dataset.streaming = 'true';
    contentDiv.dataset.rawContent = '';
  }
  
  contentDiv.dataset.rawContent += content;
  contentDiv.textContent = contentDiv.dataset.rawContent;
}

/**
 * Finalize message (render markdown and highlight)
 */
function finalizeMessage(element) {
  const contentDiv = element.querySelector('.message-content');
  const rawContent = contentDiv.dataset.rawContent || contentDiv.textContent;
  
  contentDiv.innerHTML = marked.parse(rawContent);
  
  // Highlight code blocks
  contentDiv.querySelectorAll('pre code').forEach((block) => {
    hljs.highlightElement(block);
  });
  
  delete contentDiv.dataset.streaming;
  delete contentDiv.dataset.rawContent;
}

function addUserMessage(content, scroll = true) {
  const messageEl = createMessageElement('user');
  const contentDiv = messageEl.querySelector('.message-content');
  contentDiv.textContent = content;
  
  if (scroll) scrollToBottom(true);
}

function addAssistantMessage(content, scroll = true) {
  const messageEl = createMessageElement('assistant');
  const contentDiv = messageEl.querySelector('.message-content');
  contentDiv.innerHTML = marked.parse(content);
  
  contentDiv.querySelectorAll('pre code').forEach((block) => {
    hljs.highlightElement(block);
  });
  
  if (scroll) scrollToBottom(false);
}

/**
 * Typing indicator functions
 */
function showTypingIndicator(message = 'Thinking...') {
  typingText.textContent = message;
  typingIndicator.classList.remove("hidden");
  scrollToBottom(true);
}

function updateTypingIndicator(message) {
  typingText.textContent = message;
}

function hideTypingIndicator() {
  typingIndicator.classList.add("hidden");
}

/**
 * Input control functions (Modified to optionally skip focus)
 * @param {boolean} focus - Whether to focus the input area. Default is true.
 */
function disableInput() {
  userInput.disabled = true;
  sendButton.disabled = true;
}

function enableInput(focus = true) {
  userInput.disabled = false;
  sendButton.disabled = false;
  if (focus) {
    userInput.focus(); // Only focus when explicitly requested (e.g., on error)
  }
}

/**
 * Scroll to bottom enhancement (ID: chat-container)
 * Uses the dedicated scrolling container.
 * @param {boolean} smooth - Use smooth scrolling
 */
function scrollToBottom(smooth = false) {
  if (chatContainer) {
    chatContainer.scrollTo({
      top: chatContainer.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto'
    });
  }
}

/**
 * Toast notification (Standard logic retained)
 */
function addToast(message, type = 'info') {
  const toastContainer = document.querySelector('body');
  const baseClasses = 'fixed bottom-5 right-5 p-3 rounded-lg shadow-xl z-50 transition-all duration-300';
  
  let colorClasses;
  switch(type) {
    case 'error':
      colorClasses = 'bg-red-600';
      break;
    case 'success':
      colorClasses = 'bg-teal-600';
      break;
    default:
      colorClasses = 'bg-blue-600';
  }
  
  const toast = document.createElement('div');
  toast.className = `${baseClasses} ${colorClasses} opacity-0 translate-x-full text-white text-sm`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  
  setTimeout(() => {
    toast.classList.remove('opacity-0');
    toast.classList.remove('translate-x-full');
  }, 10);

  setTimeout(() => {
    toast.classList.add('opacity-0');
    toast.classList.add('translate-x-full');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

/**
 * Clear chat history (exposed globally)
 */
window.clearChat = async function() {
  if (!confirm('Start a new chat? This will clear the current conversation.')) {
    return;
  }

  try {
    const response = await fetch('/api/clear', { method: 'POST' });
    if (response.ok) {
      chatMessages.innerHTML = '';
      pendingFiles = [];
      filePreview.innerHTML = ''; 
      conversationStarted = false;
      
      const welcomeHTML = `
        <div id="welcome-message" class="text-center py-20 px-4">
            <div class="inline-block bg-gradient-to-br from-teal-500 to-blue-600 rounded-full p-3 mb-6 shadow-lg">
                <svg class="w-10 h-10 text-white" xmlns="http://www.w3.org/2000/svg" 
                    fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                </svg>
            </div>
            <h2 class="text-3xl md:text-4xl font-bold text-white mb-4">How can I help you today?</h2>
            <p class="text-gray-400 mb-8">I can search the web, execute code, analyze files, and help with complex tasks</p>
            
            <div class="flex flex-wrap gap-2 justify-center max-w-2xl mx-auto">
                <button onclick="useSuggestion(this)" class="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-full text-sm transition-colors">
                    What's Bitcoin's price? 💰
                </button>
                <button onclick="useSuggestion(this)" class="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-full text-sm transition-colors">
                    Analyze this dataset 📊
                </button>
                <button onclick="useSuggestion(this)" class="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-full text-sm transition-colors">
                    Write Python code 💻
                </button>
                <button onclick="useSuggestion(this)" class="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-full text-sm transition-colors">
                    Latest AI news 🔍
                </button>
            </div>
        </div>
      `;
      
      chatMessages.innerHTML = welcomeHTML;
      // Re-assign welcome screen reference after clearing HTML
      window.welcomeScreen = document.getElementById('welcome-message');
      
      addToast('Chat cleared successfully', 'success');
    }
  } catch (error) {
    console.error('Error clearing chat:', error);
    addToast('Failed to clear chat', 'error');
  }
}

/**
 * Use a suggestion chip (exposed globally)
 */
window.useSuggestion = function(element) {
  // Extract text and remove emojis
  const text = element.textContent.trim().replace(/[\uD800-\uDBFF\uDC00-\uDFFF].*$/g, '').trim();
  userInput.value = text;
  userInput.style.height = "auto";
  userInput.style.height = Math.min(userInput.scrollHeight, 200) + "px";
  userInput.focus();
}

/**
 * Escape HTML
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
