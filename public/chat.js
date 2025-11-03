/**
 * Autonomous Agent Frontend with WebSocket Support
 *
 * Handles the chat UI interactions and WebSocket communication with the backend.
 * Supports real-time streaming, execution plans, and multi-step autonomous tasks.
 */

// DOM elements
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");

// WebSocket connection
let ws = null;
let isConnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000; // 30 seconds

// Chat state
let isProcessing = false;
let currentMessageElement = null;
let currentPlanElement = null;

// Load chat history on page load
window.addEventListener('DOMContentLoaded', () => {
  loadChatHistory();
  connectWebSocket();
});

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
    
    // Attempt to reconnect with exponential backoff
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
 * Send message to the agent
 */
async function sendMessage() {
  const message = userInput.value.trim();

  // Don't send empty messages
  if (message === "" || isProcessing) return;

  // Check WebSocket connection
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    addStatusMessage('Connecting to server...', 'info');
    connectWebSocket();
    // Retry after connection attempt
    setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        sendMessage();
      }
    }, 1000);
    return;
  }

  // Disable input while processing
  isProcessing = true;
  disableInput();

  // Add user message to chat
  addMessageToChat("user", message);

  // Clear input
  userInput.value = "";
  userInput.style.height = "auto";

  // Show typing indicator
  showTypingIndicator('Processing your request...');

  // Send via WebSocket
  try {
    ws.send(JSON.stringify({
      type: 'user_message',
      content: message
    }));
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
      
      // Clear initial message
      chatMessages.innerHTML = '';
      
      // Load messages
      if (data.history && data.history.length > 0) {
        data.history.forEach(msg => {
          const role = msg.role === 'model' ? 'assistant' : msg.role;
          if (msg.parts && msg.parts.length > 0) {
            const text = msg.parts
              .filter(p => p.text)
              .map(p => p.text)
              .join('\n');
            if (text) {
              addMessageToChat(role, text, false);
            }
          }
        });
      } else {
        // Show welcome message if no history
        showWelcomeMessage();
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
    <p><strong>🤖 Welcome to the Autonomous Agent!</strong></p>
    <p>I'm powered by Gemini 2.5 Flash and can help you with:</p>
    <ul>
      <li>🔍 Web research using Google Search</li>
      <li>💻 Code execution (Python)</li>
      <li>📄 Document analysis</li>
      <li>🧠 Multi-step complex tasks</li>
      <li>🌐 URL analysis and web scraping</li>
    </ul>
    <p>For complex tasks, I'll create an execution plan and work through it step by step!</p>
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
 * Create execution plan element
 */
function createPlanElement(plan) {
  const planEl = document.createElement('div');
  planEl.className = 'plan-container';
  planEl.innerHTML = `
    <div class="plan-header">
      <strong>📋 Execution Plan</strong>
      <span class="plan-status">${plan.steps.length} steps</span>
    </div>
    <div class="plan-steps"></div>
  `;

  const stepsContainer = planEl.querySelector('.plan-steps');
  plan.steps.forEach((step, index) => {
    const stepEl = document.createElement('div');
    stepEl.className = 'plan-step';
    stepEl.dataset.index = index;
    stepEl.innerHTML = `
      <span class="step-number">${index + 1}</span>
      <span class="step-description">${escapeHtml(step.description)}</span>
      <span class="step-status">pending</span>
    `;
    stepsContainer.appendChild(stepEl);
  });

  chatMessages.appendChild(planEl);
  return planEl;
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
  const icon = type === 'error' ? '⚠️' : 'ℹ️';
  statusEl.innerHTML = `<p>${icon} ${escapeHtml(message)}</p>`;
  chatMessages.appendChild(statusEl);
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
  // You can add a visual indicator in the UI if desired
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
  if (!confirm('Are you sure you want to clear the chat history?')) {
    return;
  }

  try {
    const response = await fetch('/api/clear', { method: 'POST' });
    if (response.ok) {
      chatMessages.innerHTML = '';
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

// Optional: Add clear button functionality
// Create a clear button in your HTML and uncomment this:
// document.getElementById('clear-button')?.addEventListener('click', clearChat);
