/**
 * Modern Suna-Lite Frontend - ChatGPT-like UI
 */

// DOM Elements
const chatMessages = document.getElementById("chat-messages");
const welcomeScreen = document.getElementById("welcome-screen");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const typingText = document.getElementById("typing-text");
const fileInput = document.getElementById("file-input");
const filePreview = document.getElementById("file-preview");
const sidebar = document.getElementById("sidebar");
const overlay = document.getElementById("overlay");
const menuToggle = document.getElementById("menu-toggle");

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
  loadChatHistory();
  connectWebSocket();
  setupEventListeners();
});

/**
 * Setup Event Listeners
 */
function setupEventListeners() {
  // Hamburger menu
  menuToggle.addEventListener('click', toggleSidebar);
  
  // Overlay click
  overlay.addEventListener('click', closeSidebar);
  
  // File input
  fileInput.addEventListener('change', handleFileSelect);
  
  // User input
  userInput.addEventListener('input', autoResizeTextarea);
  userInput.addEventListener('keydown', handleInputKeydown);
  
  // Send button
  sendButton.addEventListener('click', sendMessage);
  
  // Close sidebar on ESC
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sidebar.classList.contains('active')) {
      closeSidebar();
    }
  });
}

/**
 * Sidebar Toggle
 */
function toggleSidebar() {
  const isActive = sidebar.classList.toggle('active');
  menuToggle.classList.toggle('active');
  overlay.classList.toggle('active');
  
  // Prevent body scroll when sidebar is open on mobile
  if (window.innerWidth < 768) {
    document.body.style.overflow = isActive ? 'hidden' : '';
  }
}

function closeSidebar() {
  sidebar.classList.remove('active');
  menuToggle.classList.remove('active');
  overlay.classList.remove('active');
  document.body.style.overflow = '';
}

/**
 * Auto-resize textarea
 */
function autoResizeTextarea() {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 200) + 'px';
}

/**
 * Handle input keydown
 */
function handleInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

/**
 * File Selection Handler
 */
async function handleFileSelect(e) {
  const files = Array.from(e.target.files);
  
  for (const file of files) {
    // 20MB limit
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
}

/**
 * File to Base64
 */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Add File Chip
 */
function addFileChip(file) {
  const chip = document.createElement('div');
  chip.className = 'file-chip';
  chip.dataset.fileName = file.name;
  
  const icon = getFileIcon(file.type, file.name);
  
  chip.innerHTML = `
    <span class="file-chip-icon">${icon}</span>
    <span>${file.name} (${formatFileSize(file.size)})</span>
    <span class="file-chip-remove" onclick="removeFileChip('${escapeHtml(file.name)}')">✕</span>
  `;
  
  filePreview.appendChild(chip);
}

/**
 * Get File Icon
 */
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
 * Remove File Chip
 */
function removeFileChip(fileName) {
  pendingFiles = pendingFiles.filter(f => f.name !== fileName);
  
  const chips = filePreview.querySelectorAll('.file-chip');
  chips.forEach(chip => {
    if (chip.dataset.fileName === fileName) {
      chip.remove();
    }
  });
}

/**
 * Format File Size
 */
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * WebSocket Connection
 */
function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (isConnecting) return;

  isConnecting = true;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}/api/ws`;

  console.log('Connecting to WebSocket:', wsUrl);

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('WebSocket connected');
    isConnecting = false;
    reconnectAttempts = 0;
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
    
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
    console.log(`Reconnecting in ${delay}ms...`);
    setTimeout(connectWebSocket, delay);
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    isConnecting = false;
  };
}

/**
 * Handle Server Messages
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

/**
 * Show Tool Use
 */
function showToolUse(tools) {
  if (!currentMessageElement) {
    hideWelcome();
    currentMessageElement = createMessageElement('assistant');
  }
  
  const toolIndicator = document.createElement('div');
  toolIndicator.className = 'tool-use-indicator';
  toolIndicator.innerHTML = `🔧 Using: ${tools.join(', ')}`;
  
  const content = currentMessageElement.querySelector('.message-content');
  content.appendChild(toolIndicator);
  scrollToBottom();
}

/**
 * Send Message
 */
async function sendMessage() {
  const message = userInput.value.trim();

  if (message === "" || isProcessing) return;

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Connecting to server...', 'info');
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

  // Close sidebar on mobile after sending
  if (window.innerWidth < 768) {
    closeSidebar();
  }

  // Add user message
  addUserMessage(message);

  // Clear input
  userInput.value = "";
  userInput.style.height = "auto";

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

/**
 * Hide Welcome
 */
function hideWelcome() {
  if (!conversationStarted) {
    welcomeScreen.classList.add('hidden');
    conversationStarted = true;
  }
}

/**
 * Load Chat History
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
        
        scrollToBottom();
      }
    }
  } catch (error) {
    console.error('Error loading chat history:', error);
  }
}

/**
 * Create Message Element
 */
function createMessageElement(role) {
  const wrapper = document.createElement("div");
  wrapper.className = "message-wrapper";
  
  const messageEl = document.createElement("div");
  messageEl.className = `message ${role}-message`;
  
  const avatar = role === 'user' ? '👤' : '🤖';
  const sender = role === 'user' ? 'You' : 'Suna-Lite';
  
  messageEl.innerHTML = `
    <div class="message-avatar">${avatar}</div>
    <div style="flex: 1;">
      <div class="message-header">
        <span class="message-sender">${sender}</span>
      </div>
      <div class="message-content"></div>
    </div>
  `;
  
  wrapper.appendChild(messageEl);
  chatMessages.appendChild(wrapper);
  
  return messageEl;
}

/**
 * Append to Message (streaming)
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
 * Finalize Message
 */
function finalizeMessage(element) {
  const contentDiv = element.querySelector('.message-content');
  const rawContent = contentDiv.dataset.rawContent || contentDiv.textContent;
  
  // Render markdown
  contentDiv.innerHTML = marked.parse(rawContent);
  
  // Highlight code
  contentDiv.querySelectorAll('pre code').forEach((block) => {
    hljs.highlightElement(block);
  });
  
  delete contentDiv.dataset.streaming;
  delete contentDiv.dataset.rawContent;
}

/**
 * Add User Message
 */
function addUserMessage(content, scroll = true) {
  const messageEl = createMessageElement('user');
  const contentDiv = messageEl.querySelector('.message-content');
  contentDiv.textContent = content;
  
  if (scroll) scrollToBottom();
}

/**
 * Add Assistant Message
 */
function addAssistantMessage(content, scroll = true) {
  const messageEl = createMessageElement('assistant');
  const contentDiv = messageEl.querySelector('.message-content');
  contentDiv.innerHTML = marked.parse(content);
  
  contentDiv.querySelectorAll('pre code').forEach((block) => {
    hljs.highlightElement(block);
  });
  
  if (scroll) scrollToBottom();
}

/**
 * Typing Indicator
 */
function showTypingIndicator(message = 'Thinking...') {
  typingText.textContent = message;
  typingIndicator.classList.add("visible");
  scrollToBottom();
}

function updateTypingIndicator(message) {
  typingText.textContent = message;
}

function hideTypingIndicator() {
  typingIndicator.classList.remove("visible");
}

/**
 * Input Control
 */
function disableInput() {
  userInput.disabled = true;
  sendButton.disabled = true;
}

function enableInput() {
  userInput.disabled = false;
  sendButton.disabled = false;
  userInput.focus();
}

/**
 * Scroll to Bottom
 */
function scrollToBottom() {
  requestAnimationFrame(() => {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });
}

/**
 * Toast Notification
 */
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container') || createToastContainer();
  
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'toastSlideOut 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function createToastContainer() {
  const container = document.createElement('div');
  container.id = 'toast-container';
  container.className = 'toast-container';
  document.body.appendChild(container);
  return container;
}

/**
 * Clear Chat
 */
async function clearChat() {
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
      welcomeScreen.classList.remove('hidden');
      
      showToast('Chat cleared', 'success');
      
      // Close sidebar on mobile
      if (window.innerWidth < 768) {
        closeSidebar();
      }
    }
  } catch (error) {
    console.error('Error clearing chat:', error);
    showToast('Failed to clear chat', 'error');
  }
}

/**
 * Use Suggestion
 */
function useSuggestion(element) {
  const text = element.textContent.trim();
  userInput.value = text;
  userInput.focus();
  autoResizeTextarea();
}

/**
 * Escape HTML
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Add toast slideout animation
const style = document.createElement('style');
style.textContent = `
  @keyframes toastSlideOut {
    from { opacity: 1; transform: translateY(0); }
    to { opacity: 0; transform: translateY(16px); }
  }
`;
document.head.appendChild(style);
