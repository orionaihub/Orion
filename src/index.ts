import { DurableObject, Request, ExecutionContext } from '@cloudflare/workers-types';

// 1. ENVIRONMENT SETUP
// Define the expected environment variables and bindings
interface Env {
  AGENT_DO: DurableObjectNamespace;
  GEMINI_API_KEY: string;
}

// 2. TYPES
// Standard structure for a message in the Gemini API
type Message = {
  role: 'user' | 'model' | 'tool';
  parts: Part[];
};

type Part = {
  text?: string;
  functionCall?: { name: string, args: Record<string, any> };
  functionResponse?: { name: string, response: Record<string, any> };
};

// 3. DURABLE OBJECT (STATE & LOGIC)
/**
 * AgentDurableObject maintains conversation history and coordinates calls
 * to the Gemini API, including tool use.
 */
export class AgentDurableObject implements DurableObject<Env> {
  private history: Message[] = [];
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

  // Mock function for the agent to call (e.g., fetching product inventory)
  private async inventorySearch(query: { product_name: string }): Promise<Record<string, any>> {
    console.log(`Executing Tool: inventorySearch for product ${query.product_name}`);
    
    // In a real app, this would query a database or external API.
    if (query.product_name.toLowerCase().includes('laptop')) {
      return { 
        status: 'success', 
        result: { product_name: query.product_name, in_stock: true, price: 1200, location: 'Warehouse A' } 
      };
    }
    return { 
      status: 'error', 
      result: { product_name: query.product_name, in_stock: false, reason: 'Discontinued product line.' } 
    };
  }

  // Core logic to interact with the Gemini API
  private async generateContent(messages: Message[], tools: any[]): Promise<Response> {
    
    if (!this.env.GEMINI_API_KEY || this.env.GEMINI_API_KEY.trim() === '') {
      return new Response('Configuration Error: GEMINI_API_KEY is missing or empty in the Worker environment.', { 
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
    
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${this.env.GEMINI_API_KEY}`;
    
    // System Instruction for "Thinking" and Role definition (Flattened to avoid whitespace issues)
    const systemInstructionText = 'You are a specialized Cloudflare Agent for e-commerce support. Always think step-by-step before answering using the \'thought\' field. Use the provided tools only if necessary. For current information (e.g., "today\'s date," "current events"), use the \'google_search\' tool. For product availability, use the \'inventorySearch\' tool. Keep responses concise and helpful.';

    // Corrected API payload structure: tools moved to be a top-level field.
    const payload = {
        contents: messages,
        systemInstruction: systemInstructionText, 
        tools: [ // <-- FIX: tools is a top-level field, not nested in generationConfig
            { google_search: {} }, 
            ...tools
        ],
    };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    // Check for API errors
    if (!response.ok) {
        // Log the error body for Cloudflare Worker logs
        const errorBody = await response.text();
        console.error('Gemini API detailed error:', errorBody);
        
        // Returning the detailed error body to the client
        return new Response(`Gemini API Error: ${response.statusText}.\nDetailed Body: ${errorBody}`, { 
            status: response.status,
            headers: { 'Content-Type': 'text/plain' }
        });
    }

    const result = await response.json();
    const candidate = result.candidates?.[0];

    if (!candidate || !candidate.content) {
        return new Response('Error: Invalid response structure from Gemini API.', { status: 500 });
    }

    // Extract the AI's response content
    const responseMessage: Message = candidate.content;
    const parts = responseMessage.parts;

    // Check for Function Call (Tool Use)
    if (parts.length > 0 && parts[0].functionCall) {
        const functionCall = parts[0].functionCall;
        
        // Add the model's function call to history
        this.history.push(responseMessage);
        
        // Execute the function
        const toolName = functionCall.name;
        const args = functionCall.args;
        let toolResult: Record<string, any>;

        if (toolName === 'inventorySearch') {
            toolResult = await this.inventorySearch(args as { product_name: string });
        } else {
            // Handle calls to unknown tools
            toolResult = { error: 'Unknown tool called', name: toolName };
        }

        // 2nd turn: Send the tool result back to the model
        const toolMessage: Message = {
            role: 'tool',
            parts: [{ functionResponse: { name: toolName, response: toolResult } }],
        };
        this.history.push(toolMessage);

        // Corrected API payload structure for the second turn
        const secondTurnPayload = {
            contents: this.history, // Send full history including tool result
            systemInstruction: systemInstructionText, // Top level
            tools: [ // <-- FIX: tools is a top-level field
                { google_search: {} }, 
                ...tools
            ],
        };
        
        const secondTurnResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(secondTurnPayload),
        });
        
        const secondTurnResult = await secondTurnResponse.json();
        const secondTurnCandidate = secondTurnResult.candidates?.[0];
        
        if (!secondTurnCandidate || !secondTurnCandidate.content) {
            return new Response('Error: Invalid second-turn response structure from Gemini API.', { status: 500 });
        }
        
        // Return the final text response
        const finalResponse = secondTurnCandidate.content.parts[0].text;
        
        // Update history with the final text response
        this.history.push(secondTurnCandidate.content);
        await this.state.storage.put('history', this.history);

        return new Response(finalResponse, { 
            headers: { 'Content-Type': 'text/plain' },
        });

    } else {
        // Standard text response (Thinking is handled in the system prompt)
        const text = parts[0].text;
        
        // Update history with the standard text response
        this.history.push(responseMessage);
        await this.state.storage.put('history', this.history);

        return new Response(text, { 
            headers: { 'Content-Type': 'text/plain' },
        });
    }
  }

  // Durable Object fetch handler
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/chat') {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }

      const { message } = await request.json() as { message: string };
      if (!message) {
        return new Response('Missing message in request body', { status: 400 });
      }

      // Add user message to history
      const userMessage: Message = { role: 'user', parts: [{ text: message }] };
      this.history.push(userMessage);

      // 4. TOOL DEFINITIONS
      const availableTools = [
        {
          functionDeclarations: [
            {
              name: 'inventorySearch',
              description: 'Searches the internal product inventory for availability and pricing.',
              parameters: {
                type: 'OBJECT',
                properties: {
                  product_name: { type: 'STRING', description: 'The name of the product to search for, e.g., "Gaming Laptop"' },
                },
                required: ['product_name'],
              },
            },
          ],
        },
      ];

      // Call the core generation logic
      try {
        const response = await this.generateContent(this.history, availableTools);
        return response;
      } catch (error) {
        console.error('Agent error:', error);
        return new Response('An internal error occurred while processing the request.', { status: 500 });
      }
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

// 5. MAIN WORKER HANDLER
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
