// --------------------------------------------------------------------------------------
// WARNING: SDK DEPENDENCY
// This file uses 'ai' and '@ai-sdk/google' imports. These dependencies REQUIRE a build 
// process (e.g., using `wrangler` with a full build) and will FAIL in a basic, single-file 
// Cloudflare Worker environment without one. This implementation is provided ONLY to 
// demonstrate the requested SDK usage pattern.
// --------------------------------------------------------------------------------------

import { generateContent, tool, type CoreMessage } from 'ai';
import { google } from '@ai-sdk/google';
import { DurableObject, Request, ExecutionContext } from '@cloudflare/workers-types';

// 1. ENVIRONMENT SETUP
interface Env {
  AGENT_DO: DurableObjectNamespace;
  GEMINI_API_KEY: string;
}

// Map CoreMessage to the type used for Durable Object storage (for simplicity)
type StoredMessage = CoreMessage;

// 2. DURABLE OBJECT (STATE & LOGIC)
export class AgentDurableObject implements DurableObject<Env> {
  // Use CoreMessage[] from ai-sdk for history compatibility
  private history: StoredMessage[] = []; 
  private env: Env;
  private state: DurableObjectState;
  
  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.state.blockConcurrencyWhile(async () => {
      // Load history from storage on object initialization
      this.history = (await this.state.storage.get('history')) || [];
    });
  }

  // Define the tool implementation
  private inventoryTool = tool({
    description: 'Searches the internal product inventory for availability and pricing.',
    parameters: {
      type: 'object',
      properties: {
        product_name: { type: 'string', description: 'The name of the product to search for, e.g., "Gaming Laptop"' },
      },
      required: ['product_name'],
    },
    execute: async ({ product_name }) => {
      console.log(`Executing Tool: inventorySearch for product ${product_name}`);
      
      // Mocked inventory logic
      if (product_name.toLowerCase().includes('laptop')) {
        return { 
          status: 'success', 
          result: { product_name: product_name, in_stock: true, price: 1200, location: 'Warehouse A' } 
        };
      }
      return { 
        status: 'error', 
        result: { product_name: product_name, in_stock: false, reason: 'Discontinued product line.' } 
      };
    },
  });

  // Core logic to interact with the Gemini API using the SDK
  private async generateContentWithSDK(userMessage: string): Promise<Response> {
    
    if (!this.env.GEMINI_API_KEY || this.env.GEMINI_API_KEY.trim() === '') {
      return new Response('Configuration Error: GEMINI_API_KEY is missing or empty.', { 
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    // Add user message to history
    this.history.push({ role: 'user', content: userMessage });

    const systemInstruction = 'You are a specialized Cloudflare Agent for e-commerce support. Always be concise and helpful. Use the inventorySearch tool for product availability and the google_search tool for current events or dates.';

    try {
      // The SDK handles sending the full history, tool definitions, tool execution,
      // and the multi-turn API call internally, drastically simplifying the code.
      const result = await generateContent({
        model: google('gemini-2.5-flash-preview-09-2025', { 
            apiKey: this.env.GEMINI_API_KEY 
        }),
        messages: this.history, // Pass the full history
        system: systemInstruction,
        tools: {
          inventorySearch: this.inventoryTool, // Pass the local tool implementation
          google_search: tool({
            // The SDK knows how to enable the built-in google_search tool when declared
            description: 'Performs a Google search for up-to-date information.', 
            parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
          }),
        },
      });

      const finalResponse = result.text;
      
      // Update history with the final response from the model
      this.history.push({ role: 'assistant', content: finalResponse });
      await this.state.storage.put('history', this.history);

      return new Response(finalResponse, { 
        headers: { 'Content-Type': 'text/plain' },
      });

    } catch (error) {
      console.error('SDK Agent error:', error);
      // If the SDK throws an error (e.g., API key issue), log it and return a 500.
      return new Response(`An internal error occurred while processing the request: ${error.message}`, { status: 500 });
    }
  }

  // Durable Object fetch handler
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/chat') {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }

      const requestBody = await request.json() as { message: string };
      const message = requestBody.message;
      
      if (!message) {
        return new Response('Missing message in request body', { status: 400 });
      }

      // Call the streamlined SDK generation logic
      return this.generateContentWithSDK(message);

    }

    // Optional: Add a history endpoint for debugging
    if (url.pathname === '/history') {
      return new Response(JSON.stringify(this.history, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Agent Endpoint: Use POST to /chat with a {"message": "..."} body.', { status: 200 });
  }
}

// 3. MAIN WORKER HANDLER
/**
 * Main Worker fetch handler - Routes request to a single Durable Object instance (AgentSession).
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Generate a unique ID for a single persistent DO instance (e.g., using a fixed name)
    const durableObjectId = env.AGENT_DO.idFromName('AgentSession');
    const durableObjectStub = env.AGENT_DO.get(durableObjectId);
    
    // Forward the request to the Durable Object
    return durableObjectStub.fetch(request);
  },
  // Export the Durable Object class (required by wrangler)
  AgentDurableObject,
};
