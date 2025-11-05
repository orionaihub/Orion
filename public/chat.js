/**
 * Suna-Lite Frontend with File Upload Support
 *
 * Handles chat UI, WebSocket communication, and file uploads
 */

// DOM elements
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const fileInput = document.getElementById("file-input");
const uploadedFilesArea = document.getElementById("uploaded-files-area");
const capabilitiesEl = document.getElementById("capabilities");

// WebSocket connection
let ws = null;
let isConnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000; // 30 seconds

// Chat state
let isProcessing = false;
let currentMessageElement = null;
let currentPlanElement = null;
let uploadedFiles = [];
let pendingFiles = [];

// Load chat history on page load
window.addEventListener('DOMContentLoaded', () => {
  loadChatHistory();
  connectWebSocket();
  setupFileUpload();
});

/**
 * Setup file upload handler
 */
function setupFileUpload() {
  fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    
    for (const file of files) {
      if (file.size > 10 * 1024 * 1024) { // 10MB limit
        addStatusMessage(`File ${file.name} is too large (max 10MB)`, 'error');
        continue;
      }

      try {
        const base64 = await fileToBase64(file);
        pendingFiles.push({
          data: base64.split(',')[1], // Remove data:xxx;base64, prefix
          mimeType: file.type,
          name: file.name,
          size: file.size
        });

        addFileChip(file.name, file.size);
      } catch (error) {
        console.error('File reading failed:', error);
        addStatusMessage(`Failed to read ${file.name}`, 'error');
      }
    }

    // Clear file input
    fileInput.value = '';
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
function addFileChip(name, size) {
  uploadedFilesArea.classList.remove('empty');
  
  const chip = document.createElement('div');
  chip.className = 'file-chip';
  chip.innerHTML = `
    <span>📄 ${name} (${formatFileSize(size)})</span>
    <span class="remove" onclick="removeFileChip(this, '${name}')">✕</span>
  `;
  
  uploadedFilesArea.appendChild(chip);
}

/**
 * Remove file chip
 */
function removeFileChip(element, fileName) {
  pendingFiles = pendingFiles.filter(f => f.name !== fileName);
  element.parentElement.remove();
  
  if (pendingFiles.length === 0) {
    uploadedFilesArea.classList.add('empty');
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
  };
}

/**
 * Handle messages from the server
 */
function handleServerMessage(data) {
  console.log('Received:', data.type);

  switch (data.type) {
    case 'connected':
      console.log('Session ID:', data.sessionId);
      if (data.capabilities) {
        displayCapabilities(data.capabilities);
      }
      break;

    case 'status':
      updateTypingIndicator(data.message);
      break;

    case 'chunk':
      if (!currentMessageElement) {
        currentMessageElement = createMessageElement('assistant');
      }
      appendToMessage(currentMessageElement, data.content);
      scrollToBottom();
      break;

    case 'plan':
      currentPlanElement = createPlanElement(data.plan);
      scrollToBottom();
      break;

    case 'step_start':
      updateTypingIndicator(`Step ${data.step}/${data.total}: ${data.description}`);
      if (currentPlanElement) {
        updatePlanStep(currentPlanElement, data.step - 1, 'active');
      }
      break;

    case 'step_complete':
      if (currentPlanElement) {
        updatePlanStep(currentPlanElement, data.step - 1, 'completed');
      }
      break;

    case 'step_error':
      if (currentPlanElement) {
        updatePlanStep(currentPlanElement, data.step - 1, 'failed');
      }
      addStatusMessage(`Error in step ${data.step}: ${data.error}`, 'error');
      break;

    case 'file_uploaded':
      addStatusMessage(`✓ Uploaded: ${data.file.name} (${formatFileSize(data.file.size)})`, 'success');
      break;

    case 'file_analyzed':
      addStatusMessage(`✓ Analyzed file: ${data.fileName}`, 'success');
      break;

    case 'code_executing':
      addStatusMessage('⚙️ Executing code...', 'info');
      break;

    case 'code_result':
      if (data.result) {
        addCodeResultElement(data.result);
      }
      break;

    case 'final_response':
      currentMessageElement = createMessageElement('assistant');
      appendToMessage(currentMessageElement, data.content);
      scrollToBottom();
      break;

    case 'sources':
      if (data.sources && data.sources.length > 0) {
        addSourcesElement(data.sources);
      }
      break;

    case 'thinking':
      addThinkingElement(data.thoughts);
      break;

    case 'done':
      hideTypingIndicator();
      currentMessageElement = null;
      currentPlanElement = null;
      isProcessing = false;
      enableInput();
      
      // Clear pending files after successful send
      pendingFiles = [];
      uploadedFilesArea.innerHTML = '';
      uploadedFilesArea.classList.add('empty');
      break;

    case 'error':
      hideTypingIndicator();
      addStatusMessage(`Error: ${data.error}`, 'error');
      currentMessageElement = null;
      isProcessing = false;
      enableInput();
      break;

    default:
      console.log('Unknown message type:', data.type);
  }
}

/**
 * Display capabilities
 */
function displayCapabilities(capabilities) {
  capabilitiesEl.innerHTML = '';
  
  const capabilityIcons = {
    'search': '🔍 Search',
    'code_execution': '💻 Code',
    'file_analysis': '📄 Files',
    'vision': '👁️ Vision',
    'data_analysis': '📊 Data',
    'image_generation': '🎨 Images'
  };

  capabilities.forEach(cap => {
    const badge = document.createElement('span');
    badge.className = 'capability-badge';
    badge.textContent = capabilityIcons[cap] || cap;
    capabilitiesEl.appendChild(badge);
  });
}

/**
 * Send message to the agent
 */
async function sendMessage() {
  const message = userInput.value.trim();

  if (message === "" || isProcessing) return;

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    addStatusMessage('Connecting to server...', 'info');
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

  // Add user message to chat
  addMessageToChat("user", message);

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
    addStatusMessage('Failed to send message. Please try again.', 'error');
    isProcessing = false;
    enableInput();
    hideTypingIndicator();
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
      
      chatMessages.innerHTML = '';
      
      if (data.history && data.history.length > 0) {
        data.history.forEach(msg => {
          const role = msg.role === 'model' ? 'assistant' : msg.role;
          if (msg.parts && msg.parts.length > 0) {
            const textParts = msg.parts
              .filter(p => p.text)
              .map(p => p.text)
              .join('\n');
            if (textParts) {
              addMessageToChat(role, textParts, false);
            }
          }
        });
      } else {
        showWelcomeMessage();
      }

      // Display uploaded files
      if (data.files && data.files.length > 0) {
        uploadedFiles = data.files;
      }
    } else {
      showWelcomeMessage();
    }
  } catch (error) {
    console.error('Error loading chat history:', error);
    showWelcomeMessage();
  }
}

/**
 * Show welcome message
 */
function showWelcomeMessage() {
  chatMessages.innerHTML = '';
  const welcomeEl = document.createElement('div');
  welcomeEl.className = 'message assistant-message';
  welcomeEl.innerHTML = `
    <p><strong>🤖 Welcome to Suna-Lite!</strong></p>
    <p>I'm an autonomous AI agent powered by Gemini 2.0 Flash with enhanced capabilities:</p>
    <ul>
      <li>🔍 <strong>Web Search</strong> - Real-time information from Google</li>
      <li>💻 <strong>Code Execution</strong> - Run Python code for calculations and analysis</li>
      <li>📄 <strong>File Analysis</strong> - Process PDFs, CSVs, TXT, and more</li>
      <li>👁️ <strong>Vision</strong> - Analyze and understand images</li>
      <li>📊 <strong>Data Analysis</strong> - Comprehensive data processing</li>
      <li>🧠 <strong>Multi-step Tasks</strong> - Complex task planning and execution</li>
    </ul>
    <p><strong>Try uploading files</strong> with the 📎 button and asking me to analyze them!</p>
  `;
  chatMessages.appendChild(welcomeEl);
}

/**
 * Create a message element
 */
function createMessageElement(role) {
  const messageEl = document.createElement("div");
  messageEl.className = `message ${role}-message`;
  messageEl.innerHTML = "<p></p>";
  chatMessages.appendChild(messageEl);
  return messageEl;
}

/**
 * Append content to a message element
 */
function appendToMessage(element, content) {
  const p = element.querySelector('p');
  p.textContent += content;
}

/**
 * Add a complete message to chat
 */
function addMessageToChat(role, content, scroll = true) {
  const messageEl = document.createElement("div");
  messageEl.className = `message ${role}-message`;
  messageEl.innerHTML = `<p>${escapeHtml(content)}</p>`;
  chatMessages.appendChild(messageEl);

  if (scroll) {
    scrollToBottom();
  }
}

/**
 * Create execution plan element with sections
 */
function createPlanElement(plan) {
  const planEl = document.createElement('div');
  planEl.className = 'plan-container';
  
  const totalSteps = plan.steps?.length || 0;
  
  planEl.innerHTML = `
    <div class="plan-header">
      <strong>📋 Execution Plan</strong>
      <span class="plan-status">${totalSteps} steps</span>
    </div>
    <div class="plan-sections"></div>
  `;

  const sectionsContainer = planEl.querySelector('.plan-sections');

  if (plan.sections && plan.sections.length > 0) {
    // Display with sections
    plan.sections.forEach((section, sectionIdx) => {
      const sectionEl = document.createElement('div');
      sectionEl.className = 'plan-section';
      sectionEl.innerHTML = `
        <div class="section-header">${section.name}</div>
        <div class="plan-steps"></div>
      `;

      const stepsContainer = sectionEl.querySelector('.plan-steps');
      section.steps.forEach((step, stepIdx) => {
        const globalIndex = plan.steps.findIndex(s => s.id === step.id);
        const stepEl = createStepElement(step, globalIndex);
        stepsContainer.appendChild(stepEl);
      });

      sectionsContainer.appendChild(sectionEl);
    });
  } else {
    // Display without sections (flat list)
    const sectionEl = document.createElement('div');
    sectionEl.className = 'plan-steps';
    
    plan.steps.forEach((step, index) => {
      const stepEl = createStepElement(step, index);
      sectionEl.appendChild(stepEl);
    });
    
    sectionsContainer.appendChild(sectionEl);
  }

  chatMessages.appendChild(planEl);
  return planEl;
}

/**
 * Create step element
 */
function createStepElement(step, index) {
  const stepEl = document.createElement('div');
  stepEl.className = 'plan-step';
  stepEl.dataset.index = index;
  stepEl.innerHTML = `
    <span class="step-number">${index + 1}</span>
    <span class="step-description">${escapeHtml(step.description)}</span>
    <span class="step-status">pending</span>
  `;
  return stepEl;
}

/**
 * Update plan step status
 */
function updatePlanStep(planElement, stepIndex, status) {
  const step = planElement.querySelector(`[data-index="${stepIndex}"]`);
  if (step) {
    step.classList.remove('pending', 'active', 'completed', 'failed');
    step.classList.add(status);
    const statusSpan = step.querySelector('.step-status');
    statusSpan.textContent = status;
  }
}

/**
 * Add status message
 */
function addStatusMessage(message, type = 'info') {
  const statusEl = document.createElement('div');
  statusEl.className = `status-message status-${type}`;
  const icon = type === 'error' ? '⚠️' : type === 'success' ? '✓' : 'ℹ️';
  statusEl.innerHTML = `<p>${icon} ${escapeHtml(message)}</p>`;
  chatMessages.appendChild(statusEl);
  scrollToBottom();
}

/**
 * Add code result element
 */
function addCodeResultElement(result) {
  const codeEl = document.createElement('div');
  codeEl.className = 'code-result-container';
  codeEl.innerHTML = `
    <div class="code-header"><strong>💻 Code Result</strong></div>
    <pre>${escapeHtml(result)}</pre>
  `;
  chatMessages.appendChild(codeEl);
  scrollToBottom();
}

/**
 * Add sources element
 */
function addSourcesElement(sources) {
  const sourcesEl = document.createElement('div');
  sourcesEl.className = 'sources-container';
  sourcesEl.innerHTML = `
    <div class="sources-header"><strong>📚 Sources</strong></div>
    <ul class="sources-list">
      ${sources.map(source => `<li>${escapeHtml(source)}</li>`).join('')}
    </ul>
  `;
  chatMessages.appendChild(sourcesEl);
  scrollToBottom();
}

/**
 * Add thinking element
 */
function addThinkingElement(thoughts) {
  const thinkingEl = document.createElement('div');
  thinkingEl.className = 'thinking-container';
  thinkingEl.innerHTML = `
    <div class="thinking-header"><strong>🧠 Thinking Process</strong></div>
    <p>${escapeHtml(thoughts)}</p>
  `;
  chatMessages.appendChild(thinkingEl);
  scrollToBottom();
}

/**
 * Typing indicator functions
 */
function showTypingIndicator(message = 'AI is thinking...') {
  typingIndicator.textContent = message;
  typingIndicator.classList.add("visible");
}

function updateTypingIndicator(message) {
  typingIndicator.textContent = message;
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
 * Connection status indicator
 */
function updateConnectionStatus(status) {
  console.log('Connection status:', status);
}

/**
 * Scroll to bottom
 */
function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Clear chat history
 */
async function clearChat() {
  if (!confirm('Are you sure you want to clear the chat history and all uploaded files?')) {
    return;
  }

  try {
    const response = await fetch('/api/clear', { method: 'POST' });
    if (response.ok) {
      chatMessages.innerHTML = '';
      uploadedFiles = [];
      pendingFiles = [];
      uploadedFilesArea.innerHTML = '';
      uploadedFilesArea.classList.add('empty');
      showWelcomeMessage();
    }
  } catch (error) {
    console.error('Error clearing chat:', error);
    addStatusMessage('Failed to clear chat history', 'error');
  }
}

// Auto-resize textarea as user types
userInput.addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = this.scrollHeight + "px";
});

// Send message on Enter (without Shift)
userInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Send button click handler
sendButton.addEventListener("click", sendMessage);
