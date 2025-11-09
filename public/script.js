/**
 * Enhanced Orion Frontend with Tailwind/Custom CSS, Markdown, Sidebar, and Full File Support
 */

// DOM elements (Adapted from index.html.txt)
const chatMessages = document.getElementById("messages-wrapper"); // Changed from 'chat-messages' to 'messages-wrapper'
const welcomeScreen = document.getElementById("welcome-message"); // Changed from 'welcome-screen' to 'welcome-message'
const userInput = document.getElementById("chat-input"); // Changed from 'user-input' to 'chat-input'
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const typingText = document.getElementById("typing-text");
const fileInput = document.getElementById("file-input");
const filePreview = document.getElementById("file-preview"); // Added for file chips
const sidebar = document.getElementById("sidebar");
const menuBtn = document.getElementById("menu-btn"); // Added for mobile menu
const overlay = document.getElementById("overlay"); // Added for mobile overlay
const chatContainer = document.getElementById("chat-container"); // New element for scrolling

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
  // Highlight function remains the same, relying on loaded highlight.js
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
  setupSidebarToggle(); // New
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
    // Desktop: Ensure sidebar is visible and overlay is hidden
    sidebar.classList.remove('-translate-x-full');
    overlay.classList.add('hidden');
  } else {
    // Mobile: Ensure sidebar starts hidden
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
  // Mobile menu button
  if (menuBtn) {
    menuBtn.addEventListener('click', () => {
      sidebar.classList.toggle('-translate-x-full');
      overlay.classList.toggle('hidden');
    });
  }
  
  // Overlay click to close
  if (overlay) {
    overlay.addEventListener('click', () => {
      sidebar.classList.add('-translate-x-full');
      overlay.classList.add('hidden');
    });
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
    updateFilePreview();
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
 * Add file chip to UI (Adapted to Tailwind/index.html structure)
 */
function addFileChip(file) {
  const chip = document.createElement('div');
  chip.className = 'flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 text-xs text-white';
  chip.dataset.fileName = file.name;
  
  const icon = getFileIcon(file.type, file.name);
  
  chip.innerHTML = `
    <span>${icon}</span>
    <span class="truncate max-w-[150px]">${file.name}</span>
    <span class="text-gray-400">(${formatFileSize(file.size)})</span>
    <button type="button" class="text-gray-400 hover:text-white transition-colors ml-1" onclick="removeFileChip('${escapeHtml(file.name)}')" aria-label="Remove file">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
        </svg>
    </button>
  `;
  
  filePreview.appendChild(chip);
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
  
  const chips = filePreview.querySelectorAll('[data-file-name]');
  chips.forEach(chip => {
    if (chip.dataset.fileName === fileName) {
      chip.remove();
    }
  });
  
  updateFilePreview();
}

/**
 * Update file preview visibility (used for potential future styling, but currently managed by chip presence)
 */
function updateFilePreview() {
  // In the current index.html, the visibility is implicit based on content
  // We'll keep the function for future expansion if the UI needs to react to an empty state
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
  
  // Tools Button Toggle
  const toolsBtn = document.getElementById('tools-btn');
  const toolsPopup = document.getElementById('tools-popup');
  
  toolsBtn.addEventListener('click', () => {
      toolsPopup.classList.toggle('opacity-0');
      toolsPopup.classList.toggle('scale-95');
      toolsPopup.classList.toggle('pointer-events-none');
  });
  
  // Close popup on click outside
  document.addEventListener('click', (e) => {
      if (!toolsPopup.contains(e.target) && !toolsBtn.contains(e.target) && !toolsPopup.classList.contains('opacity-0')) {
          toolsPopup.classList.add('opacity-0');
          toolsPopup.classList.add('scale-95');
          toolsPopup.classList.add('pointer-events-none');
      }
  });
}

/**
 * Connect to WebSocket
 */
function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (isConnecting) return;

  isConnecting = true;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Check if running on a custom port for development
  const port = location.port ? `:${location.port}` : '';
  const wsUrl = `${protocol}//${location.hostname}${port}/api/ws`;

  console.log('Connecting to WebSocket:', wsUrl);

  // Update status UI
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
 * Update connection status UI (Adapted to index.html structure)
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
      // Smooth scroll on every chunk
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
      enableInput();
      // Final smooth scroll
      scrollToBottom(true);
      
      // Clear pending files after successful send
      pendingFiles = [];
      filePreview.innerHTML = ''; // Clear file chips
      updateFilePreview();
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
 * Show tool usage indicator (Adapted to Tailwind/index.html structure)
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

  // Hide welcome screen on first message
  hideWelcome();

  // Add user message to chat
  addUserMessage(message || 'Sent files for analysis.');

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
    if (welcomeScreen) {
        welcomeScreen.classList.add('hidden');
    }
    conversationStarted = true;
  }
}

/**
 * Load chat history from server (Remains the same logic)
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
 * Create a message element (Adapted to Tailwind/index.html structure)
 */
function createMessageElement(role) {
  const isUser = role === 'user';
  const wrapper = document.createElement("div");
  wrapper.className = "p-4 md:p-6";
  
  const messageEl = document.createElement("div");
  messageEl.className = "flex items-start gap-4 max-w-4xl mx-auto";
  
  const avatarBg = isUser ? 'bg-gray-500' : 'bg-teal-600';
  const senderText = isUser ? 'You' : 'Orion'; // Changed to Orion
  const iconSvg = `<svg class="w-5 h-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
    </svg>`;
    
  const avatar = isUser ? '👤' : iconSvg; // Use SVG for Orion/Assistant

  messageEl.innerHTML = `
    <div class="w-8 h-8 flex-shrink-0 rounded-full flex items-center justify-center text-white ${avatarBg}">
      ${avatar}
    </div>
    <div class="flex-1 min-w-0">
      <h3 class="font-semibold mb-2">${senderText}</h3>
      <div class="message-content text-gray-200"></div>
    </div>
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
  
  if (scroll) scrollToBottom(true);
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
  
  if (scroll) scrollToBottom(false);
}

/**
 * Typing indicator functions (Adapted to index.html structure)
 */
function showTypingIndicator(message = 'Thinking...') {
  typingText.textContent = message;
  typingIndicator.classList.remove("hidden"); // Use 'hidden' from Tailwind
  scrollToBottom(true);
}

function updateTypingIndicator(message) {
  typingText.textContent = message;
}

function hideTypingIndicator() {
  typingIndicator.classList.add("hidden"); // Use 'hidden' from Tailwind
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
 * Scroll to bottom enhancement
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
 * Toast notification (Adapted to index.html structure/styles.css)
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
  
  // Animate in (using manual class manipulation to trigger transition)
  setTimeout(() => {
    toast.classList.remove('opacity-0');
    toast.classList.remove('translate-x-full');
  }, 10);

  setTimeout(() => {
    // Animate out
    toast.classList.add('opacity-0');
    toast.classList.add('translate-x-full');
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
      filePreview.innerHTML = ''; // Clear file chips
      updateFilePreview();
      conversationStarted = false;
      
      // The original HTML welcome message is simpler, we will use it directly.
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
      
      addToast('Chat cleared successfully', 'success');
    }
  } catch (error) {
    console.error('Error clearing chat:', error);
    addToast('Failed to clear chat', 'error');
  }
}

/**
 * Use a suggestion chip (exposed globally as it's in the HTML)
 */
window.useSuggestion = function(element) {
  const text = element.textContent.trim().replace(/[\d\w\s]+?(\s*?[\uD800-\uDBFF\uDC00-\uDFFF\u2600-\u27BF\u1F600-\u1F64F\u1F300-\u1F5FF\u1F680-\u1F6FF\u1F900-\u1F9FF\u200D])/g, '').trim();
  userInput.value = text;
  userInput.style.height = "auto";
  userInput.style.height = Math.min(userInput.scrollHeight, 200) + "px";
  userInput.focus();
}

/**
 * Clear chat (exposed globally as it's in the HTML)
 */
window.clearChat = clearChat;


/**
 * Escape HTML
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// NOTE: The Tailwind CSS utility classes handle all the required styling (including animations
// like 'animate-bounce' and 'transition-colors'), so we don't need to manually inject a 
// <style> tag for the toast animations as in the original chat.js.
