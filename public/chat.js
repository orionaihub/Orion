/**
 * Enhanced Suna-Lite Frontend with Markdown, Sidebar, and Full File Support
 */

// DOM elements
const chatMessages = document.getElementById("chat-messages");
const welcomeScreen = document.getElementById("welcome-screen");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const typingText = document.getElementById("typing-text");
const fileInput = document.getElementById("file-input");
const fileUploadArea = document.getElementById("file-upload-area");
const uploadedFilesContainer = document.getElementById("uploaded-files");
const sidebar = document.getElementById("sidebar");
const sidebarOverlay = document.getElementById("sidebar-overlay");
const mainContent = document.getElementById("main-content");

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
  checkMobileView();
});

// Window resize handler
window.addEventListener('resize', checkMobileView);

/**
 * Check if mobile view and adjust sidebar
 */
function checkMobileView() {
  if (window.innerWidth <= 768) {
    sidebar.classList.add('hidden');
    mainContent.classList.add('expanded');
  } else {
    sidebar.classList.remove('hidden');
    mainContent.classList.remove('expanded');
    sidebarOverlay.classList.remove('visible');
  }
}

/**
 * Toggle sidebar (mobile)
 */
function toggleSidebar() {
  if (window.innerWidth <= 768) {
    sidebar.classList.toggle('hidden');
    sidebar.classList.toggle('visible');
    sidebarOverlay.classList.toggle('visible');
  }
}

/**
 * Setup file upload handler with extended support
 */
function setupFileUpload() {
  fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    
    for (const file of files) {
      // 20MB limit
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
    updateFileUploadArea();
  });
}

/**
 * Convert file to base64
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
 * Add file chip to UI
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
  
  uploadedFilesContainer.appendChild(chip);
}

/**
 * Get appropriate icon for file type
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
 * Remove file chip
 */
function removeFileChip(fileName) {
  pendingFiles = pendingFiles.filter(f => f.name !== fileName);
  
  const chips = uploadedFilesContainer.querySelectorAll('.file-chip');
  chips.forEach(chip => {
    if (chip.dataset.fileName === fileName) {
      chip.remove();
    }
  });
  
  updateFileUploadArea();
}

/**
 * Update file upload area visibility
 */
function updateFileUploadArea() {
  if (pendingFiles.length > 0) {
    fileUploadArea.classList.add('has-files');
  } else {
    fileUploadArea.classList.remove('has-files');
  }
}

/**
 * Format file size
 */
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * Setup input handlers
 */
function setupInputHandlers() {
  // Auto-resize textarea
  userInput.addEventListener("input", function () {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 200) + "px";
  });

  // Send on Enter (without Shift)
  userInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Send button
  sendButton.addEventListener("click", sendMessage);
}

/**
 * Connect to WebSocket
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
      
      // Clear pending files after successful send
      pendingFiles = [];
      uploadedFilesContainer.innerHTML = '';
      updateFileUploadArea();
      break;

    case 'error':
      hideTypingIndicator();
      addToast(`Error: ${data.error}`, 'error');
      currentMessageElement = null;
      isProcessing = false;
      enableInput();
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
  toolIndicator.className = 'tool-use-indicator';
  toolIndicator.innerHTML = `🔧 Using tools: ${tools.join(', ')}`;
  
  const content = currentMessageElement.querySelector('.message-content');
  content.appendChild(toolIndicator);
  scrollToBottom();
}

/**
 * Send message to the agent
 */
async function sendMessage() {
  const message = userInput.value.trim();

  if (message === "" || isProcessing) return;

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

  // Hide welcome screen on first message
  hideWelcome();

  // Add user message to chat
  addUserMessage(message);

  // Clear input
  userInput.value = "";
  userInput.style.height = "auto";

  // Show typing indicator
  showTypingIndicator('Processing your request...');

  // Send via WebSocket with files
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
    enableInput();
    hideTypingIndicator();
  }
}

/**
 * Hide welcome screen
 */
function hideWelcome() {
  if (!conversationStarted) {
    welcomeScreen.classList.add('hidden');
    conversationStarted = true;
  }
}

/**
 * Load chat history from server
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
 * Create a message element
 */
function createMessageElement(role) {
  const wrapper = document.createElement("div");
  wrapper.className = "message-wrapper";
  
  const messageEl = document.createElement("div");
  messageEl.className = `message ${role}-message`;
  
  const avatar = role === 'user' ? '👤' : '🤖';
  const sender = role === 'user' ? 'You' : 'Suna-Lite';
  
  messageEl.innerHTML = `
    <div class="message-header">
      <div class="message-avatar">${avatar}</div>
      <span class="message-sender">${sender}</span>
    </div>
    <div class="message-content"></div>
  `;
  
  wrapper.appendChild(messageEl);
  chatMessages.appendChild(wrapper);
  
  return messageEl;
}

/**
 * Append content to a message (streaming)
 */
function appendToMessage(element, content) {
  const contentDiv = element.querySelector('.message-content');
  
  // For streaming, append raw text temporarily
  if (!contentDiv.dataset.streaming) {
    contentDiv.dataset.streaming = 'true';
    contentDiv.dataset.rawContent = '';
  }
  
  contentDiv.dataset.rawContent += content;
  contentDiv.textContent = contentDiv.dataset.rawContent;
}

/**
 * Finalize message (render markdown)
 */
function finalizeMessage(element) {
  const contentDiv = element.querySelector('.message-content');
  const rawContent = contentDiv.dataset.rawContent || contentDiv.textContent;
  
  // Render markdown
  contentDiv.innerHTML = marked.parse(rawContent);
  
  // Highlight code blocks
  contentDiv.querySelectorAll('pre code').forEach((block) => {
    hljs.highlightElement(block);
  });
  
  delete contentDiv.dataset.streaming;
  delete contentDiv.dataset.rawContent;
}

/**
 * Add user message
 */
function addUserMessage(content, scroll = true) {
  const messageEl = createMessageElement('user');
  const contentDiv = messageEl.querySelector('.message-content');
  contentDiv.textContent = content;
  
  if (scroll) scrollToBottom();
}

/**
 * Add assistant message (complete)
 */
function addAssistantMessage(content, scroll = true) {
  const messageEl = createMessageElement('assistant');
  const contentDiv = messageEl.querySelector('.message-content');
  contentDiv.innerHTML = marked.parse(content);
  
  // Highlight code blocks
  contentDiv.querySelectorAll('pre code').forEach((block) => {
    hljs.highlightElement(block);
  });
  
  if (scroll) scrollToBottom();
}

/**
 * Typing indicator functions
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
 * Input control functions
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
 * Scroll to bottom
 */
function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Toast notification
 */
function addToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.style.cssText = `
    position: fixed;
    bottom: 2rem;
    right: 2rem;
    padding: 1rem 1.5rem;
    background: ${type === 'error' ? '#ef4444' : type === 'success' ? '#10b981' : '#3b82f6'};
    color: white;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    z-index: 10000;
    animation: slideInRight 0.3s ease;
    max-width: 300px;
  `;
  toast.textContent = message;
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'slideOutRight 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

/**
 * Clear chat history
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
      uploadedFilesContainer.innerHTML = '';
      updateFileUploadArea();
      conversationStarted = false;
      
      // Re-add welcome screen with full content
      const welcomeHTML = `
        <div class="welcome-screen" id="welcome-screen">
          <div class="welcome-icon">🤖</div>
          <h2>Welcome to Suna-Lite</h2>
          <p>Your autonomous AI assistant powered by Gemini 2.5 Flash with advanced multi-step reasoning and tool execution capabilities</p>
          
          <div class="welcome-features">
            <div class="welcome-feature">
              <div class="welcome-feature-icon">🔍</div>
              <h3>Web Search</h3>
              <p>Access real-time information from the web to answer current questions and find the latest data</p>
            </div>
            <div class="welcome-feature">
              <div class="welcome-feature-icon">💻</div>
              <h3>Code Execution</h3>
              <p>Run Python code for complex calculations, data analysis, and algorithmic problem solving</p>
            </div>
            <div class="welcome-feature">
              <div class="welcome-feature-icon">📄</div>
              <h3>File Analysis</h3>
              <p>Process and analyze documents, spreadsheets, PDFs, images, and various data formats</p>
            </div>
            <div class="welcome-feature">
              <div class="welcome-feature-icon">🔄</div>
              <h3>Multi-Step Tasks</h3>
              <p>Autonomous planning and execution of complex tasks that require multiple steps and tools</p>
            </div>
            <div class="welcome-feature">
              <div class="welcome-feature-icon">👁️</div>
              <h3>Vision Analysis</h3>
              <p>Understand and analyze images, charts, diagrams, and visual content with AI vision</p>
            </div>
            <div class="welcome-feature">
              <div class="welcome-feature-icon">📊</div>
              <h3>Data Processing</h3>
              <p>Comprehensive data analysis, visualization, and insights from structured and unstructured data</p>
            </div>
          </div>

          <div class="welcome-cta">
            <p class="welcome-cta-text">✨ Try asking me something or choose a suggestion below:</p>
            <div class="welcome-suggestions">
              <div class="suggestion-chip" onclick="useSuggestion(this)">
                What's the current Bitcoin price?
              </div>
              <div class="suggestion-chip" onclick="useSuggestion(this)">
                Analyze this dataset for trends
              </div>
              <div class="suggestion-chip" onclick="useSuggestion(this)">
                Calculate compound interest
              </div>
              <div class="suggestion-chip" onclick="useSuggestion(this)">
                Search latest AI news
              </div>
              <div class="suggestion-chip" onclick="useSuggestion(this)">
                Explain quantum computing
              </div>
            </div>
          </div>
        </div>
      `;
      
      chatMessages.innerHTML = welcomeHTML;
      
      // Re-assign welcome screen reference
      window.welcomeScreen = document.getElementById('welcome-screen');
      
      addToast('Chat cleared successfully', 'success');
    }
  } catch (error) {
    console.error('Error clearing chat:', error);
    addToast('Failed to clear chat', 'error');
  }
}

/**
 * Use a suggestion chip
 */
function useSuggestion(element) {
  const text = element.textContent.trim();
  userInput.value = text;
  userInput.focus();
  // Optionally auto-send
  // sendMessage();
}

/**
 * Escape HTML
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Add CSS animations
const style = document.createElement('style');
style.textContent = `
  @keyframes slideInRight {
    from {
      transform: translateX(100%);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
  
  @keyframes slideOutRight {
    from {
      transform: translateX(0);
      opacity: 1;
    }
    to {
      transform: translateX(100%);
      opacity: 0;
    }
  }
`;
document.head.appendChild(style);
