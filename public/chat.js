/**
 * Suna-Lite Frontend - Modern Tailwind UI
 */

// DOM Elements
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatContainer = document.getElementById('chat-container');
const messagesWrapper = document.getElementById('messages-wrapper');
const welcomeMessage = document.getElementById('welcome-message');
const typingIndicator = document.getElementById('typing-indicator');
const typingText = document.getElementById('typing-text');
const menuBtn = document.getElementById('menu-btn');
const sidebar = document.getElementById('sidebar');
const overlay = document.getElementById('overlay');
const toolsBtn = document.getElementById('tools-btn');
const toolsPopup = document.getElementById('tools-popup');
const fileInput = document.getElementById('file-input');
const filePreview = document.getElementById('file-preview');
const sendButton = document.getElementById('send-button');
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');

// WebSocket
let ws = null;
let isConnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;

// State
let isProcessing = false;
let currentMessageElement = null;
let pendingFiles = [];
let conversationStarted = false;

// Configure marked.js
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

// Initialize
window.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  connectWebSocket();
  loadChatHistory();
});

// Event Listeners
function setupEventListeners() {
  chatForm.addEventListener('submit', handleSendMessage);
  chatInput.addEventListener('input', autoResizeTextarea);
  chatInput.addEventListener('keydown', handleKeydown);
  menuBtn.addEventListener('click', toggleSidebar);
  overlay.addEventListener('click', toggleSidebar);
  toolsBtn.addEventListener('click', toggleToolsPopup);
  fileInput.addEventListener('change', handleFileSelect);
  
  // Close popup if clicking outside
  document.addEventListener('click', (e) => {
    if (!toolsPopup.contains(e.target) && !toolsBtn.contains(e.target)) {
      hideToolsPopup();
    }
  });
  
  // ESC to close sidebar
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sidebar.classList.contains('-translate-x-full')) {
      toggleSidebar();
    }
  });
}

// Sidebar Toggle
function toggleSidebar() {
  sidebar.classList.toggle('-translate-x-full');
  overlay.classList.toggle('hidden');
}

// Tools Popup
function toggleToolsPopup() {
  const isHidden = toolsPopup.classList.contains('opacity-0');
  if (isHidden) {
    toolsPopup.classList.remove('opacity-0', 'scale-95', 'pointer-events-none');
  } else {
    hideToolsPopup();
  }
}

function hideToolsPopup() {
  toolsPopup.classList.add('opacity-0', 'scale-95', 'pointer-events-none');
}

// Auto-resize Textarea
function autoResizeTextarea() {
  chatInput.style.height = 'auto';
  const maxHeight = 200;
  const newHeight = Math.min(chatInput.scrollHeight, maxHeight);
  chatInput.style.height = newHeight + 'px';
}

function handleKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
}

// File Handling
async function handleFileSelect(e) {
  const files = Array.from(e.target.files);
  
  for (const file of files) {
    if (file.size > 20 * 1024 * 1024) {
      showToast(`File ${file.name} is too large (max 20MB)`, 'error');
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
      showToast(`Added: ${file.name}`, 'success');
    } catch (error) {
      console.error('File reading failed:', error);
      showToast(`Failed to read ${file.name}`, 'error');
    }
  }

  fileInput.value = '';
  hideToolsPopup();
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
  chip.className = 'inline-flex items-center gap-2 px-3 py-2 bg-white/10 rounded-lg text-sm';
  chip.dataset.fileName = file.name;
  
  const icon = getFileIcon(file.type, file.name);
  
  chip.innerHTML = `
    <span>${icon}</span>
    <span class="max-w-[150px] truncate">${file.name}</span>
    <button onclick="removeFileChip('${escapeHtml(file.name)}')" class="ml-1 hover:text-red-400 transition-colors">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
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

function removeFileChip(fileName) {
  pendingFiles = pendingFiles.filter(f => f.name !== fileName);
  const chips = filePreview.querySelectorAll('[data-file-name]');
  chips.forEach(chip => {
    if (chip.dataset.fileName === fileName) {
      chip.remove();
    }
  });
}

// WebSocket Connection
function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (isConnecting) return;

  isConnecting = true;
  updateConnectionStatus('connecting');
  
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}/api/ws`;

  console.log('Connecting to WebSocket:', wsUrl);
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('WebSocket connected');
    isConnecting = false;
    reconnectAttempts = 0;
    updateConnectionStatus('connected');
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
    updateConnectionStatus('disconnected');
    
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
    console.log(`Reconnecting in ${delay}ms...`);
    setTimeout(connectWebSocket, delay);
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    isConnecting = false;
    updateConnectionStatus('error');
  };
}

function updateConnectionStatus(status) {
  const statuses = {
    connecting: { color: 'bg-yellow-500', text: 'Connecting...' },
    connected: { color: 'bg-green-500', text: 'Connected' },
    disconnected: { color: 'bg-gray-500', text: 'Disconnected' },
    error: { color: 'bg-red-500', text: 'Connection Error' }
  };
  
  const config = statuses[status] || statuses.disconnected;
  statusIndicator.className = `w-2 h-2 rounded-full ${config.color}`;
  statusText.textContent = config.text;
}

// Handle Server Messages
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
      scrollToBottom();
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
      enableInput();
      
      // Clear files
      pendingFiles = [];
      filePreview.innerHTML = '';
      break;

    case 'error':
      hideTypingIndicator();
      showToast(`Error: ${data.error}`, 'error');
      currentMessageElement = null;
      isProcessing = false;
      enableInput();
      break;

    default:
      console.log('Unknown message type:', data.type);
  }
}

function showToolUse(tools) {
  if (!currentMessageElement) {
    hideWelcome();
    currentMessageElement = createMessageElement('assistant');
  }
  
  const contentDiv = currentMessageElement.querySelector('.message-content');
  const toolIndicator = document.createElement('div');
  toolIndicator.className = 'inline-flex items-center gap-2 px-3 py-1.5 bg-teal-500/20 rounded-full text-sm text-teal-400 mb-3';
  toolIndicator.innerHTML = `
    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
    </svg>
    <span>Using: ${tools.join(', ')}</span>
  `;
  
  contentDiv.appendChild(toolIndicator);
  scrollToBottom();
}

// Send Message
async function handleSendMessage(e) {
  e.preventDefault();
  const message = chatInput.value.trim();

  if (message === "" || isProcessing) return;

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Connecting to server...', 'info');
    connectWebSocket();
    setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        handleSendMessage(e);
      }
    }, 1000);
    return;
  }

  isProcessing = true;
  disableInput();
  hideWelcome();

  // Close sidebar on mobile
  if (!sidebar.classList.contains('-translate-x-full')) {
    toggleSidebar();
  }

  // Add user message
  appendMessage(message, 'user');

  // Clear input
  chatInput.value = "";
  chatInput.style.height = 'auto';

  // Show typing
  showTypingIndicator('Thinking...');

  // Send via WebSocket
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
    showToast('Failed to send message', 'error');
    isProcessing = false;
    enableInput();
    hideTypingIndicator();
  }
}

// Hide Welcome
function hideWelcome() {
  if (!conversationStarted) {
    welcomeMessage.style.display = 'none';
    conversationStarted = true;
  }
}

// Load Chat History
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
              appendMessage(textParts, role, role === 'assistant');
            }
          }
        });
        
        scrollToBottom();
      }
    }
  } catch (error) {
    console.error('Error loading chat history:', error);
  }
}

// Create Message Element
function createMessageElement(sender) {
  const isUser = sender === 'user';
  const messageWrapper = document.createElement('div');
  messageWrapper.className = `w-full ${isUser ? '' : 'bg-black/20'}`;

  const messageDiv = document.createElement('div');
  messageDiv.className = 'max-w-4xl mx-auto p-4 md:p-6 flex items-start gap-5';

  const avatarDiv = document.createElement('div');
  avatarDiv.className = 'w-8 h-8 flex-shrink-0 rounded-full flex items-center justify-center font-bold text-white';
  
  if (isUser) {
    avatarDiv.classList.add('bg-blue-600');
    avatarDiv.textContent = 'Y';
  } else {
    avatarDiv.classList.add('bg-teal-600');
    avatarDiv.innerHTML = `<svg class="w-5 h-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" /></svg>`;
  }

  const contentDiv = document.createElement('div');
  contentDiv.className = 'text-gray-200 pt-0.5 leading-relaxed message-content';

  messageDiv.appendChild(avatarDiv);
  messageDiv.appendChild(contentDiv);
  messageWrapper.appendChild(messageDiv);
  messagesWrapper.appendChild(messageWrapper);

  return messageWrapper;
}

// Append Message
function appendMessage(text, sender, isComplete = false) {
  const messageEl = createMessageElement(sender);
  const contentDiv = messageEl.querySelector('.message-content');
  
  if (isComplete) {
    // Render as markdown
    contentDiv.innerHTML = marked.parse(text);
    contentDiv.querySelectorAll('pre code').forEach((block) => {
      hljs.highlightElement(block);
    });
  } else {
    contentDiv.textContent = text;
  }
  
  scrollToBottom();
  return messageEl;
}

function appendToMessage(element, content) {
  const contentDiv = element.querySelector('.message-content');
  
  if (!contentDiv.dataset.streaming) {
    contentDiv.dataset.streaming = 'true';
    contentDiv.dataset.rawContent = '';
  }
  
  contentDiv.dataset.rawContent += content;
  contentDiv.textContent = contentDiv.dataset.rawContent;
}

function finalizeMessage(element) {
  const contentDiv = element.querySelector('.message-content');
  const rawContent = contentDiv.dataset.rawContent || contentDiv.textContent;
  
  contentDiv.innerHTML = marked.parse(rawContent);
  contentDiv.querySelectorAll('pre code').forEach((block) => {
    hljs.highlightElement(block);
  });
  
  delete contentDiv.dataset.streaming;
  delete contentDiv.dataset.rawContent;
}

// Typing Indicator
function showTypingIndicator(message = 'Thinking...') {
  typingText.textContent = message;
  typingIndicator.classList.remove('hidden');
  scrollToBottom();
}

function updateTypingIndicator(message) {
  typingText.textContent = message;
}

function hideTypingIndicator() {
  typingIndicator.classList.add('hidden');
}

// Input Control
function disableInput() {
  chatInput.disabled = true;
  sendButton.disabled = true;
}

function enableInput() {
  chatInput.disabled = false;
  sendButton.disabled = false;
  chatInput.focus();
}

// Scroll to Bottom
function scrollToBottom() {
  requestAnimationFrame(() => {
    chatContainer.scrollTop = chatContainer.scrollHeight;
  });
}

// Toast Notification
function showToast(message, type = 'info') {
  const colors = {
    success: 'bg-green-600',
    error: 'bg-red-600',
    info: 'bg-blue-600'
  };
  
  const toast = document.createElement('div');
  toast.className = `fixed bottom-4 right-4 ${colors[type]} text-white px-4 py-3 rounded-lg shadow-lg z-50 animate-slide-in`;
  toast.textContent = message;
  
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.classList.add('animate-slide-out');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Clear Chat
async function clearChat() {
  if (!confirm('Start a new chat? This will clear the current conversation.')) {
    return;
  }

  try {
    const response = await fetch('/api/clear', { method: 'POST' });
    if (response.ok) {
      messagesWrapper.innerHTML = '';
      pendingFiles = [];
      filePreview.innerHTML = '';
      conversationStarted = false;
      welcomeMessage.style.display = 'block';
      
      showToast('Chat cleared', 'success');
    }
  } catch (error) {
    console.error('Error clearing chat:', error);
    showToast('Failed to clear chat', 'error');
  }
}

// Use Suggestion
function useSuggestion(element) {
  const text = element.textContent.trim().replace(/[🔍💰📊💻]/g, '').trim();
  chatInput.value = text;
  chatInput.focus();
  autoResizeTextarea();
}

// Escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
