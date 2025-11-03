import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';

export class AutonomousAgent extends DurableObject {
  private state: AgentState;
  private genAI: GoogleGenerativeAI;
  private model: GenerativeModel;
  private connections: Set<WebSocket>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = { conversationHistory: [], context: { files: [], searchResults: [] } };
    this.connections = new Set();
    
    // Initialize Gemini
    this.genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    this.model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      tools: [
        { googleSearch: {} }, // Search grounding
        { codeExecution: {} }, // Code execution
        // Function declarations for external APIs
        {
          functionDeclarations: [
            {
              name: 'fetch_external_api',
              description: 'Fetch data from external APIs',
              parameters: {
                type: 'object',
                properties: {
                  url: { type: 'string' },
                  method: { type: 'string' },
                  body: { type: 'string' }
                }
              }
            }
          ]
        }
      ]
    });

    // Load persisted state
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<AgentState>('state');
      if (stored) this.state = stored;
    });
  }

  async fetch(request: Request) {
    const url = new URL(request.url);

    // WebSocket upgrade for real-time agent interaction
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.ctx.acceptWebSocket(server);
      this.connections.add(server);

      return new Response(null, { status: 101, webSocket: client });
    }

    // HTTP endpoints
    if (url.pathname === '/chat' && request.method === 'POST') {
      return this.handleChatRequest(request);
    }

    if (url.pathname === '/history' && request.method === 'GET') {
      return Response.json({ history: this.state.conversationHistory });
    }

    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string) {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'user_message') {
        await this.processUserMessage(data.content, ws);
      }
    } catch (error) {
      this.sendToClient(ws, { type: 'error', error: error.message });
    }
  }

  async processUserMessage(userMessage: string, ws: WebSocket) {
    // Add user message to history
    this.state.conversationHistory.push({
      role: 'user',
      parts: [{ text: userMessage }],
      timestamp: Date.now()
    });

    // Analyze task complexity with thinking enabled
    const complexity = await this.analyzeTaskComplexity(userMessage);

    if (complexity.type === 'simple') {
      // Single-turn response with tools
      await this.handleSimpleQuery(userMessage, ws);
    } else {
      // Multi-step autonomous execution
      await this.handleComplexTask(userMessage, complexity, ws);
    }

    // Persist state
    await this.persistState();
  }

  async analyzeTaskComplexity(query: string) {
    // Use Gemini with thinking to analyze task
    const result = await this.model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [{
            text: `Analyze this user request and determine:
1. Is it a simple question (single turn) or complex task (multi-step)?
2. What tools/capabilities are needed?
3. Estimated number of steps if complex

Request: ${query}

Respond in JSON format:
{
  "type": "simple" | "complex",
  "requiredTools": ["search", "code_execution", "api_call"],
  "estimatedSteps": number,
  "reasoning": "brief explanation"
}`
          }]
        }
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        // Enable thinking for analysis
        thinkingConfig: {
          thinkingBudget: 2048,
          includeThoughts: true
        }
      }
    });

    return JSON.parse(result.response.text());
  }

  async handleSimpleQuery(query: string, ws: WebSocket) {
    this.sendToClient(ws, { type: 'status', message: 'Processing query...' });

    // Create chat session with full context
    const chat = this.model.startChat({
      history: this.state.conversationHistory,
    });

    // Stream response
    const result = await chat.sendMessageStream(query);

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        this.sendToClient(ws, { type: 'chunk', content: text });
      }
    }

    // Final response with sources if available
    const response = await result.response;
    
    // Store response in history
    this.state.conversationHistory.push({
      role: 'model',
      parts: response.candidates[0].content.parts,
      timestamp: Date.now()
    });

    // Check for grounding metadata (sources)
    const groundingMetadata = response.candidates[0].groundingMetadata;
    if (groundingMetadata) {
      this.sendToClient(ws, { 
        type: 'sources', 
        sources: groundingMetadata.webSearchQueries 
      });
    }

    this.sendToClient(ws, { type: 'done' });
  }

  async handleComplexTask(query: string, complexity: any, ws: WebSocket) {
    this.sendToClient(ws, { type: 'status', message: 'Creating execution plan...' });

    // Generate execution plan
    const plan = await this.generateExecutionPlan(query, complexity);
    this.state.currentPlan = plan;

    this.sendToClient(ws, { type: 'plan', plan });

    // Enter autonomous execution mode
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      plan.currentStepIndex = i;
      
      this.sendToClient(ws, { 
        type: 'step_start', 
        step: i + 1, 
        total: plan.steps.length,
        description: step.description 
      });

      try {
        // Execute step with full context
        const result = await this.executeStep(step);
        step.result = result;
        step.status = 'completed';

        this.sendToClient(ws, { 
          type: 'step_complete', 
          step: i + 1,
          result 
        });

        // Persist after each step
        await this.persistState();
      } catch (error) {
        step.status = 'failed';
        this.sendToClient(ws, { 
          type: 'step_error', 
          step: i + 1,
          error: error.message 
        });
        break;
      }
    }

    // Synthesize final response
    await this.synthesizeFinalResponse(ws);
  }

  async generateExecutionPlan(query: string, complexity: any): Promise<ExecutionPlan> {
    const planningPrompt = `You are an autonomous agent planner. Given this user request, create a detailed step-by-step execution plan.

User Request: ${query}

Task Complexity Analysis: ${JSON.stringify(complexity)}

Create a plan with specific, actionable steps. Each step should specify:
- Action type: search, analyze, code_execute, api_call, or synthesize
- Clear description of what to do
- Expected output

Return JSON array of steps:
[
  {
    "id": "step_1",
    "description": "Search for X",
    "action": "search"
  },
  ...
]`;

    const result = await this.model.generateContent({
      contents: [{ role: 'user', parts: [{ text: planningPrompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        thinkingConfig: {
          thinkingBudget: 4096,
          includeThoughts: true
        }
      }
    });

    const steps = JSON.parse(result.response.text());

    return {
      steps,
      currentStepIndex: 0,
      status: 'executing'
    };
  }

  async executeStep(step: PlanStep): Promise<any> {
    // Build context-aware prompt
    const contextPrompt = this.buildContextualPrompt(step);

    const chat = this.model.startChat({
      history: this.state.conversationHistory,
    });

    const result = await chat.sendMessage(contextPrompt);

    // Handle function calls if any
    const response = result.response;
    const functionCall = response.functionCalls()?.[0];

    if (functionCall) {
      // Execute function (e.g., external API call)
      const functionResult = await this.executeFunction(functionCall);
      
      // Send function result back to model
      const followUp = await chat.sendMessage([{
        functionResponse: {
          name: functionCall.name,
          response: functionResult
        }
      }]);

      return followUp.response.text();
    }

    return response.text();
  }

  buildContextualPrompt(step: PlanStep): string {
    const plan = this.state.currentPlan;
    const completedSteps = plan.steps
      .filter(s => s.status === 'completed')
      .map(s => `${s.description}: ${s.result}`)
      .join('\n');

    return `EXECUTION CONTEXT:
Plan Overview: ${plan.steps.map(s => s.description).join(' → ')}

Completed Steps:
${completedSteps}

Current Step: ${step.description}
Action Type: ${step.action}

Files Context: ${JSON.stringify(this.state.context.files)}

Execute this step and provide the result.`;
  }

  async executeFunction(functionCall: any): Promise<any> {
    // Handle external API calls
    if (functionCall.name === 'fetch_external_api') {
      const { url, method, body } = functionCall.args;
      const response = await fetch(url, {
        method,
        body: body ? JSON.stringify(body) : undefined,
        headers: { 'Content-Type': 'application/json' }
      });
      return await response.json();
    }
    
    throw new Error(`Unknown function: ${functionCall.name}`);
  }

  async synthesizeFinalResponse(ws: WebSocket) {
    this.sendToClient(ws, { type: 'status', message: 'Synthesizing final response...' });

    const plan = this.state.currentPlan;
    const synthesisPrompt = `Based on the execution of this plan, provide a comprehensive final response to the user.

Original User Request: ${this.state.conversationHistory[0].parts[0].text}

Execution Results:
${plan.steps.map((s, i) => `Step ${i+1} (${s.description}): ${s.result}`).join('\n\n')}

Synthesize a clear, complete response that addresses the user's original request.`;

    const result = await this.model.generateContent({
      contents: [{ role: 'user', parts: [{ text: synthesisPrompt }] }],
    });

    const finalResponse = result.response.text();

    // Store in history
    this.state.conversationHistory.push({
      role: 'model',
      parts: [{ text: finalResponse }],
      timestamp: Date.now()
    });

    this.sendToClient(ws, { type: 'final_response', content: finalResponse });
    this.sendToClient(ws, { type: 'done' });

    plan.status = 'completed';
    await this.persistState();
  }

  sendToClient(ws: WebSocket, data: any) {
    try {
      ws.send(JSON.stringify(data));
    } catch (e) {
      console.error('Failed to send to client:', e);
    }
  }

  async persistState() {
    await this.ctx.storage.put('state', this.state);
  }

  async handleChatRequest(request: Request) {
    const { message } = await request.json();
    
    // For HTTP requests, return immediately and process async
    this.ctx.waitUntil(this.processUserMessage(message, null));
    
    return Response.json({ status: 'processing' });
  }

  webSocketClose(ws: WebSocket) {
    this.connections.delete(ws);
    ws.close();
  }
}
