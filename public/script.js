import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, setLogLevel } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

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
const userInfo = document.getElementById('user-info');
const attachFileButton = document.getElementById('attach-file-button');

// WebSocket (Mock/Stub for actual connection)
let ws = null;
let isConnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;

// State
let isProcessing = false;
let currentMessageElement = null;
let pendingFiles = [];
let conversationStarted = false;
let db = null;
let auth = null;
let userId = null;

// --- MANDATORY ENVIRONMENT SETUP ---
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = JSON.parse(typeof __firebase_config !== 'undefined' ? __firebase_config : '{}');

// Initialize Firebase
if (Object.keys(firebaseConfig).length > 0) {
    try {
        const app = initializeApp(firebaseConfig);
        db = getFirestore(app);
        auth = getAuth(app);
        setLogLevel('Debug');
        
        // Handle Auth
        onAuthStateChanged(auth, async (user) => {
            if (user) {
                userId = user.uid;
                userInfo.textContent = userId;
                // Once authenticated, you can start listening to Firestore data here if needed.
            } else {
                // Sign in anonymously if no token is available
                userId = crypto.randomUUID(); // Fallback ID for display
                userInfo.textContent = userId;
                try {
                    if (typeof __initial_auth_token !== 'undefined') {
                        await signInWithCustomToken(auth, __initial_auth_token);
                    } else {
                        await signInAnonymously(auth);
                    }
                } catch (error) {
                    console.error("Firebase Auth Error:", error);
                    // This error is usually handled by the onAuthStateChanged listener failing to return a user.
                }
            }
        });

    } catch (e) {
        console.error("Failed to initialize Firebase:", e);
    }
} else {
    console.error("Firebase configuration is missing.");
    userId = crypto.randomUUID();
    userInfo.textContent = userId;
}
// --- END MANDATORY SETUP ---

// Configure marked.js
marked.setOptions({
  breaks: true,
  gfm: true,
  headerIds: false,
  mangle: false,
  highlight: function(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  }
});

// Helper: Scroll to Bottom
function scrollToBottom() {
  const messagesArea = document.getElementById('messages-area');
  // Use a small timeout to ensure the DOM has finished rendering the new message
  setTimeout(() => {
    messagesArea.scrollTop = messagesArea.scrollHeight;
  }, 10);
}

// Helper: Toast Notification
function showToast(message, type = 'info') {
  const colors = {
    success: 'bg-green-600',
    error: 'bg-red-600',
    info: 'bg-blue-600'
  };
  
  const toast = document.createElement('div');
  toast.className = `fixed bottom-20 right-4 ${colors[type]} text-white px-4 py-3 rounded-xl shadow-xl z-50 animate-slide-in text-sm`;
  toast.textContent = message;
  
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.classList.add('animate-slide-out');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Helper: Message Element Creation (IMPROVED for responsiveness)
/**
 * Creates the HTML structure for a single chat message.
 * @param {string} role - 'user' or 'agent'
 * @param {string} content - The message content (will be parsed as Markdown)
 * @param {Object[]} [files=[]] - Array of file objects for the user message
 */
function createMessageElement(role, content, files = []) {
  const container = document.createElement('div');
  container.className = `message-container w-full py-4 px-4 md:px-6 transition-colors duration-300 
    ${role === 'user' ? 'bg-[#2a2a2a] border-b border-gray-800' : 'bg-[#1e1e1e] border-b border-gray-800'}`;

  // Content wrapper: max-w-4xl for readability, centered
  const wrapper = document.createElement('div');
  
  // CRITICAL CHANGE: Agent response uses flex-col for avatar-on-top layout
  const flexClass = role === 'agent' ? 'flex-col' : 'items-start gap-4';
  wrapper.className = `max-w-4xl mx-auto flex ${flexClass}`;

  // AVATAR/ICON AREA
  const avatarWrapper = document.createElement('div');
  
  if (role === 'agent') {
    avatarWrapper.className = 'flex items-center space-x-3 mb-2';
    avatarWrapper.innerHTML = `
      <div class="w-8 h-8 flex-shrink-0 bg-teal-600 rounded-full flex items-center justify-center text-white">
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9.663 17h4.673M12 3v13m-3-8h6m-3 4h.01" />
        </svg>
      </div>
      <span class="font-bold text-teal-400">Orion</span>
    `;
  } else {
    avatarWrapper.className = 'w-8 h-8 flex-shrink-0 bg-white rounded-full flex items-center justify-center text-gray-900 font-bold text-sm mt-1';
    avatarWrapper.textContent = 'Y'; // Placeholder for 'You'
  }
  
  // CONTENT AREA
  const contentWrapper = document.createElement('div');
  // For agent, content is full width. For user, it takes remaining space.
  contentWrapper.className = `message-content ${role === 'agent' ? 'w-full' : 'flex-1'} min-w-0`; 
  
  // Assemble the message
  wrapper.appendChild(avatarWrapper);
  
  // Render Markdown content (Initial load or stream placeholder)
  const htmlContent = marked.parse(content);
  contentWrapper.innerHTML = htmlContent;

  if (role === 'user') {
      // Add files below content for user message
      if (files.length > 0) {
          const filesDiv = document.createElement('div');
          filesDiv.className = 'mt-3 pt-3 border-t border-gray-700/50 flex flex-wrap gap-2';
          files.forEach(file => {
              filesDiv.innerHTML += `<span class="bg-teal-800/20 text-teal-300 px-3 py-1 rounded-full text-xs flex items-center gap-1">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 01-2.828 0 2 2 0 010-2.828l6.586-6.586m5.656 5.656l-6.586 6.586a2 2 0 01-2.828 0 2 2 0 010-2.828l6.586-6.586m-2.828-2.828l.707-.707A1 1 0 0017 4a1 1 0 00-1-1v1a1 1 0 01-1 1h1a1 1 0 00.707.293z" /></svg>
                  ${file.name}
              </span>`;
          });
          contentWrapper.appendChild(filesDiv);
      }
      wrapper.appendChild(contentWrapper);
  } else {
      // For agent message, avatar is already first in flex-col, content second
      wrapper.appendChild(contentWrapper);
  }

  container.appendChild(wrapper);
  return container;
}

// Function to inject a message into the UI
function appendMessage(element) {
  welcomeMessage.style.display = 'none';
  messagesWrapper.appendChild(element);
  scrollToBottom();
}

// Function to generate the user's message
function generateUserMessage(prompt) {
    // Create a copy of pendingFiles for the message element before clearing global state
    const filesSnapshot = [...pendingFiles]; 
    const userMessage = createMessageElement('user', prompt, filesSnapshot);
    appendMessage(userMessage);

    // Clear pending files and preview after sending
    pendingFiles = [];
    filePreview.innerHTML = '';
}

// Function to start the agent's response
function startAgentResponse() {
    typingIndicator.style.display = 'flex';
    currentMessageElement = createMessageElement('agent', '', []); 
    appendMessage(currentMessageElement);
    scrollToBottom();
}

// Function to stream content (Mock implementation)
function streamAgentContent(chunk) {
    if (currentMessageElement) {
        const contentDiv = currentMessageElement.querySelector('.message-content');
        // Simple append for streaming mock
        contentDiv.textContent += chunk; 
        scrollToBottom();
    }
}

// Function to finish response
function finishAgentResponse() {
    typingIndicator.style.display = 'none';
    if (currentMessageElement) {
        const contentDiv = currentMessageElement.querySelector('.message-content');
        const rawContent = contentDiv.textContent; 
        contentDiv.innerHTML = marked.parse(rawContent); // Final render
        addSuggestions(currentMessageElement);
        hljs.highlightAll(); // Highlight code blocks
    }
    isProcessing = false;
    currentMessageElement = null;
    scrollToBottom();
}

// Mock function for adding suggestions
function addSuggestions(messageElement) {
  const suggestions = [
    "What are the best practices for Tailwind CSS?",
    "Explain the event loop in JavaScript.",
    "Draft a short email to my manager."
  ];

  const suggestionArea = document.createElement('div');
  suggestionArea.className = 'mt-4 pt-4 border-t border-gray-700/50';
  suggestionArea.innerHTML = '<p class="text-sm font-semibold mb-2 text-gray-400">Suggestions:</p>';
  
  const tags = document.createElement('div');
  tags.className = 'flex flex-wrap gap-2';

  suggestions.forEach(text => {
    const tag = document.createElement('button');
    tag.type = 'button';
    tag.className = 'use-suggestion bg-gray-700/50 text-white text-sm px-3 py-1.5 rounded-full hover:bg-gray-700 transition-colors';
    tag.textContent = text;
    tag.onclick = () => useSuggestion(tag); 
    tags.appendChild(tag);
  });

  suggestionArea.appendChild(tags);
  // Find the message wrapper inside the container and append suggestions to it
  messageElement.querySelector('.max-w-4xl').appendChild(suggestionArea);
}


// Use Suggestion
function useSuggestion(element) {
  const text = element.textContent;
  chatInput.value = text;
  // Auto-resize the textarea
  chatInput.style.height = 'auto';
  chatInput.style.height = chatInput.scrollHeight + 'px';
  chatInput.focus();
}


// File Handling
function handleFileSelect(e) {
  const files = Array.from(e.target.files);
  pendingFiles = files.map(file => ({
    name: file.name,
    type: file.type,
    size: file.size,
    data: null // In a real app, you'd convert to Base64 here
  }));
  renderFilePreview();
  e.target.value = ''; // Clear file input
}

function renderFilePreview() {
  filePreview.innerHTML = '';
  pendingFiles.forEach((file, index) => {
    const fileTag = document.createElement('span');
    fileTag.className = 'bg-gray-700 text-white px-3 py-1 rounded-full text-sm flex items-center gap-2';
    fileTag.innerHTML = `
      <svg class="w-4 h-4 text-teal-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 01-2.828 0 2 2 0 010-2.828l6.586-6.586m5.656 5.656l-6.586 6.586a2 2 0 01-2.828 0 2 2 0 010-2.828l6.586-6.586m-2.828-2.828l.707-.707A1 1 0 0017 4a1 1 0 00-1-1v1a1 1 0 01-1 1h1a1 1 0 00.707.293z" />
      </svg>
      ${file.name}
      <button type="button" class="ml-1 text-gray-400 hover:text-white" onclick="removeFile(${index})">
        <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
      </button>
    `;
    filePreview.appendChild(fileTag);
  });
}

function removeFile(index) {
  pendingFiles.splice(index, 1);
  renderFilePreview();
}


// Clear Chat (Updated to use Toast instead of confirm)
async function clearChat() {
  showToast('Starting a new chat...', 'info');
  try {
    // Mock API call to clear conversation history
    const response = await fetch('/api/clear', { method: 'POST' }); 
    if (response.ok) {
      messagesWrapper.innerHTML = '';
      pendingFiles = [];
      filePreview.innerHTML = '';
      conversationStarted = false;
      welcomeMessage.style.display = 'flex'; // Show welcome message again
      
      showToast('New chat started. Conversation cleared.', 'success');
    }
  } catch (error) {
    console.error('Error clearing chat:', error);
    showToast('Failed to clear chat', 'error');
  }
}


// Core Logic: Send Message
async function handleFormSubmit(e) {
  e.preventDefault();
  const prompt = chatInput.value.trim();

  if (!prompt && pendingFiles.length === 0) return;
  if (isProcessing) return;

  isProcessing = true;
  chatInput.value = '';
  chatInput.style.height = 'auto'; // Reset textarea size

  // 1. Generate User Message UI
  generateUserMessage(prompt);
  
  // 2. Start Agent Response UI
  startAgentResponse();
  
  // 3. Mock the Agent's Response (Replace with actual WebSocket/API call)
  const mockResponse = `Hello there! I see you asked about: **${prompt || 'a file upload'}**
    
As a large language model, I can now respond to your query.
    
Here is a sample code block:
    
\`\`\`javascript
function calculateSum(a, b) {
  return a + b; // Always returns the sum
}
\`\`\`
    
* I've updated the layout for better mobile responsiveness.
* The header and input area are now fixed.
* My avatar is placed above the response for improved readability on small screens.
    
How else can I assist you today?`;

  const words = mockResponse.split(' ');
  let charIndex = 0;

  const typeChunk = () => {
    if (charIndex < mockResponse.length) {
      const chunk = mockResponse.substring(charIndex, charIndex + 5); // Stream 5 characters at a time
      streamAgentContent(chunk);
      charIndex += 5;
      setTimeout(typeChunk, 15); // Adjust typing speed here
    } else {
      finishAgentResponse();
    }
  };

  typeChunk();
}


// Sidebar & Tools UI Handlers
function toggleSidebar() {
  const isHidden = sidebar.classList.contains('-translate-x-full');
  sidebar.classList.toggle('-translate-x-full', !isHidden);
  overlay.classList.toggle('hidden', !isHidden);
}

function toggleToolsPopup() {
    const isHidden = toolsPopup.classList.contains('opacity-0');
    if (isHidden) {
        toolsPopup.classList.remove('opacity-0', 'translate-y-2', 'pointer-events-none');
    } else {
        toolsPopup.classList.add('opacity-0', 'translate-y-2', 'pointer-events-none');
    }
}

// Textarea Auto-Resize
function autoResizeTextarea() {
  this.style.height = 'auto';
  this.style.height = this.scrollHeight + 'px';
}


// Event Listeners
document.addEventListener('DOMContentLoaded', () => {
    // Initial welcome message check
    if (messagesWrapper.children.length === 0) {
        welcomeMessage.style.display = 'flex';
    }

    // Attach form submit handler
    chatForm.addEventListener('submit', handleFormSubmit);

    // Attach tools button handler
    toolsBtn.addEventListener('click', toggleToolsPopup);

    // Attach file button handler
    attachFileButton.addEventListener('click', () => {
        fileInput.click();
        toggleToolsPopup(); // Close popup after clicking
    });

    // Attach file input handler
    fileInput.addEventListener('change', handleFileSelect);

    // Textarea resize handler
    chatInput.addEventListener('input', autoResizeTextarea);

    // Sidebar handlers
    menuBtn.addEventListener('click', toggleSidebar);
    overlay.addEventListener('click', toggleSidebar);

    // Close tools popup when clicking outside (simple approach)
    document.addEventListener('click', (e) => {
        if (!toolsPopup.contains(e.target) && !toolsBtn.contains(e.target)) {
            toolsPopup.classList.add('opacity-0', 'translate-y-2', 'pointer-events-none');
        }
    });
});

// Expose functions globally for HTML calls (e.g., clearChat, removeFile)
window.clearChat = clearChat;
window.removeFile = removeFile;
window.useSuggestion = useSuggestion;

