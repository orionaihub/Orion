/**
 * LLM Chat App Frontend with Gemini
 *
 * Handles the chat UI interactions and communication with the backend API.
 * Supports persistent chat sessions with Durable Objects.
 */

// DOM elements
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");

// Chat state
let isProcessing = false;

// Load chat history on page load
window.addEventListener('DOMContentLoaded', loadChatHistory);

/**
 * Load existing chat history from the server
 */
async function loadChatHistory() {
  try {
    const response = await fetch('/api/history');
    if (response.ok) {
      const data = await response.json();
      
      // Clear initial message
      chatMessages.innerHTML = '';
      
      // Load messages
      if (data.messages && data.messages.length > 0) {
        data.messages.forEach(msg => {
          addMessageToChat(msg.role, msg.content, false);
        });
      } else {
        // Show welcome message if no history
        addMessageToChat(
          'assistant',
          "Hello! I'm an LLM chat app powered by Gemini 2.0 Flash. How can I help you today?",
          false
        );
      }
    }
  } catch (error) {
    console.error('Error loading chat history:', error);
    // Show welcome message on error
    chatMessages.innerHTML = '';
    addMessageToChat(
      'assistant',
      "Hello! I'm an LLM chat app powered by Gemini 2.0 Flash. How can I help you today?",
      false
    );
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

/**
 * Sends a message to the chat API and processes the response
 */
async function sendMessage() {
  const message = userInput.value.trim();

  // Don't send empty messages
  if (message === "" || isProcessing) return;

  // Disable input while processing
  isProcessing = true;
  userInput.disabled = true;
  sendButton.disabled = true;

  // Add user message to chat
  addMessageToChat("user", message, true);

  // Clear input
  userInput.value = "";
  userInput.style.height = "auto";

  // Show typing indicator
  typingIndicator.classList.add("visible");

  try {
    // Create new assistant response element
    const assistantMessageEl = document.createElement("div");
    assistantMessageEl.className = "message assistant-message";
    assistantMessageEl.innerHTML = "<p></p>";
    chatMessages.appendChild(assistantMessageEl);

    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Send request to API
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: message,
      }),
    });

    // Handle errors
    if (!response.ok) {
      throw new Error("Failed to get response");
    }

    // Process streaming response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let responseText = "";

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      // Decode chunk
      const chunk = decoder.decode(value, { stream: true });

      // Process newline-delimited JSON
      const lines = chunk.split("\n").filter(line => line.trim());
      
      for (const line of lines) {
        try {
          const jsonData = JSON.parse(line);
          
          if (jsonData.error) {
            console.error('Error from server:', jsonData.error);
            assistantMessageEl.querySelector("p").textContent = 
              "Sorry, there was an error: " + (jsonData.details || jsonData.error);
          } else if (jsonData.response) {
            // Append new content to existing text
            responseText += jsonData.response;
            assistantMessageEl.querySelector("p").textContent = responseText;

            // Scroll to bottom
            chatMessages.scrollTop = chatMessages.scrollHeight;
          }
        } catch (e) {
          // Skip non-JSON lines
          console.debug("Skipping non-JSON line:", line);
        }
      }
    }

    // If no response was received, show error
    if (!responseText) {
      assistantMessageEl.querySelector("p").textContent = 
        "Sorry, I couldn't generate a response.";
    }
  } catch (error) {
    console.error("Error:", error);
    addMessageToChat(
      "assistant",
      "Sorry, there was an error processing your request.",
      true
    );
  } finally {
    // Hide typing indicator
    typingIndicator.classList.remove("visible");

    // Re-enable input
    isProcessing = false;
    userInput.disabled = false;
    sendButton.disabled = false;
    userInput.focus();
  }
}

/**
 * Helper function to add message to chat
 */
function addMessageToChat(role, content, scroll = true) {
  const messageEl = document.createElement("div");
  messageEl.className = `message ${role}-message`;
  messageEl.innerHTML = `<p>${escapeHtml(content)}</p>`;
  chatMessages.appendChild(messageEl);

  // Scroll to bottom
  if (scroll) {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
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
 * Clear chat history (optional feature)
 */
async function clearChat() {
  if (!confirm('Are you sure you want to clear the chat history?')) {
    return;
  }

  try {
    const response = await fetch('/api/clear', { method: 'POST' });
    if (response.ok) {
      chatMessages.innerHTML = '';
      addMessageToChat(
        'assistant',
        "Chat history cleared. How can I help you today?",
        true
      );
    }
  } catch (error) {
    console.error('Error clearing chat:', error);
  }
}
