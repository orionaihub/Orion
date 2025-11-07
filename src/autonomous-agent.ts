// src/autonomous-agent-v2.ts - Prompt-Driven Architecture
import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import GeminiClient from './utils/gemini';
import type { Env, AgentState, Tool, ToolCall, ToolResult } from './types';

interface SqlStorage {
  exec(query: string, ...params: any[]): {
    one(): any;
    toArray(): any[];
    [Symbol.iterator](): Iterator<any>;
  };
}

export class AutonomousAgent extends DurableObject<Env> {
  private sql: SqlStorage;
  private gemini: GeminiClient;
  private readonly MAX_TURNS = 10;
  private readonly MAX_MESSAGE_SIZE = 100_000;
  private activeWebSockets = new Set<WebSocket>();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql as SqlStorage;
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });

    this.initDatabase();
  }

  private initDatabase(): void {
    try {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role TEXT NOT NULL,
          parts TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS kv (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_msg_ts ON messages(timestamp);
      `);
    } catch (e) {
      console.error('SQLite init failed:', e);
    }
  }

  // ===== System Prompt =====

  private buildSystemPrompt(state: AgentState): string {
    const hasFiles = (state.context?.files ?? []).length > 0;
    const tools = this.getAvailableTools(state);
    
    return `You are an autonomous AI agent helping users accomplish tasks efficiently.

# Core Principles
- Respond directly for simple questions - don't overthink
- Use tools progressively as needed, not all at once
- Adapt your approach based on what you learn
- Provide brief narrative updates as you work
- Self-reflect after each tool use

# Available Tools
${tools.map(t => `- ${t.name}: ${t.description}`).join('\n')}

${hasFiles ? `\n# Uploaded Files\nThe user has uploaded ${state.context.files.length} file(s). You can analyze them using the read_file tool.\n` : ''}

# Decision Process
1. **Assess**: Is this a simple query I can answer directly, or does it need tools?
2. **Act**: For simple queries, respond immediately. For complex tasks:
   - Use ONE tool at a time
   - Wait for results before deciding next step
   - Provide progress updates
3. **Reflect**: After each tool use:
   - Do I have enough information now?
   - What's the next logical step?
   - Can I provide the final answer?
4. **Respond**: Give a comprehensive, well-structured answer

# Style Guidelines
- Be conversational and helpful
- Explain your reasoning briefly
- If using tools, say what you're doing: "Let me search for recent data about X..."
- Structure long responses with clear sections
- Cite sources when using web search

# Important Rules
- NEVER pre-plan all steps upfront
- Use minimum necessary tools
- Don't hallucinate - admit if you don't know something
- Ask for clarification if request is ambiguous
- Stop and respond once you have sufficient information

Begin by assessing the user's request and deciding your approach.`;
  }

  // ===== Tool Definitions =====

  private getAvailableTools(state: AgentState): Tool[] {
    const hasFiles = (state.context?.files ?? []).length > 0;
    
    const tools: Tool[] = [
      {
        name: 'web_search',
        description: 'Search the web for current information, recent events, or fact-checking. Returns up to 10 relevant results.',
        parameters: {
          type: 'object',
          properties: {
            query: { 
              type: 'string', 
              description: 'Concise search query (2-6 words recommended)' 
            }
          },
          required: ['query']
        }
      },
      {
        name: 'code_execute',
        description: 'Execute Python code for calculations, data analysis, or creating visualizations. Code runs in isolated sandbox.',
        parameters: {
          type: 'object',
          properties: {
            code: { 
              type: 'string', 
              description: 'Python code to execute. Can use numpy, pandas, matplotlib.' 
            },
            explanation: { 
              type: 'string', 
              description: 'Brief explanation of what this code does' 
            }
          },
          required: ['code', 'explanation']
        }
      },
      {
        name: 'create_visualization',
        description: 'Generate charts and graphs from data. Returns image URL.',
        parameters: {
          type: 'object',
          properties: {
            data: { 
              type: 'object', 
              description: 'Data to visualize as JSON object' 
            },
            chartType: { 
              type: 'string', 
              enum: ['bar', 'line', 'pie', 'scatter'],
              description: 'Type of chart to create' 
            },
            title: { 
              type: 'string', 
              description: 'Chart title' 
            }
          },
          required: ['data', 'chartType']
        }
      }
    ];
    
    if (hasFiles) {
      tools.push({
        name: 'analyze_file',
        description: 'Read and analyze uploaded files. Supports text, PDFs, images, spreadsheets.',
        parameters: {
          type: 'object',
          properties: {
            fileIndex: { 
              type: 'number', 
              description: 'Index of file to analyze (0-based)' 
            },
            operation: { 
              type: 'string', 
              enum: ['summarize', 'extract_data', 'analyze_content', 'get_metadata'],
              description: 'What to do with the file'
            },
            query: {
              type: 'string',
              description: 'Optional: specific question about the file'
            }
          },
          required: ['fileIndex', 'operation']
        }
      });
    }
    
    return tools;
  }

  // ===== Tool Execution =====

  private async executeTools(toolCalls: ToolCall[], state: AgentState): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    
    for (const call of toolCalls) {
      try {
        let result: any;
        
        switch (call.name) {
          case 'web_search':
            result = await this.toolWebSearch(call.args.query);
            break;
            
          case 'code_execute':
            result = await this.toolCodeExecute(call.args.code);
            break;
            
          case 'analyze_file':
            result = await this.toolAnalyzeFile(
              call.args.fileIndex, 
              call.args.operation,
              call.args.query,
              state
            );
            break;
            
          case 'create_visualization':
            result = await this.toolCreateVisualization(
              call.args.data,
              call.args.chartType,
              call.args.title
            );
            break;
            
          default:
            result = { error: `Unknown tool: ${call.name}` };
        }
        
        results.push({
          name: call.name,
          result: JSON.stringify(result),
          success: !result.error
        });
      } catch (e) {
        results.push({
          name: call.name,
          result: JSON.stringify({ error: String(e) }),
          success: false
        });
      }
    }
    
    return results;
  }

  private async toolWebSearch(query: string): Promise<any> {
    // Mock implementation - replace with actual search API
    return {
      results: [
        {
          title: 'Example Result',
          url: 'https://example.com',
          snippet: 'This is a mock search result. Implement actual search here.'
        }
      ],
      query,
      timestamp: Date.now()
    };
  }

  private async toolCodeExecute(code: string): Promise<any> {
    // Mock implementation - replace with actual code execution
    // In production, use Gemini's code execution tool or a sandboxed Python environment
    return {
      output: 'Code execution result would appear here',
      stdout: '',
      stderr: '',
      executionTime: 0.1
    };
  }

  private async toolAnalyzeFile(
    fileIndex: number, 
    operation: string,
    query: string | undefined,
    state: AgentState
  ): Promise<any> {
    const files = state.context?.files ?? [];
    if (fileIndex >= files.length) {
      return { error: 'File index out of range' };
    }
    
    const file = files[fileIndex];
    // Use Gemini's file analysis capabilities
    return {
      fileName: file.name,
      operation,
      result: 'File analysis result would appear here',
      metadata: file
    };
  }

  private async toolCreateVisualization(
    data: any,
    chartType: string,
    title: string
  ): Promise<any> {
    // Mock implementation - in production, generate actual chart
    return {
      chartUrl: 'https://example.com/chart.png',
      chartType,
      title,
      dataPoints: Object.keys(data).length
    };
  }

  // ===== Main Processing Loop =====

  private async process(userMsg: string, ws: WebSocket | null): Promise<void> {
    return this.withStateTransaction(async (state) => {
      state.lastActivityAt = Date.now();

      if (userMsg.length > this.MAX_MESSAGE_SIZE) {
        if (ws) this.send(ws, { type: 'error', error: 'Message too large' });
        throw new Error('Message exceeds maximum size');
      }

      // Save user message
      this.sql.exec(
        `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
        'user',
        JSON.stringify([{ text: userMsg }]),
        Date.now()
      );

      // Build conversation history with system prompt
      const systemPrompt = this.buildSystemPrompt(state);
      const history = this.buildHistory();
      
      let conversationHistory: any[] = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: userMsg }
      ];
      
      let turn = 0;
      let accumulatedResponse = '';
      const batcher = this.createChunkBatcher(ws, 'chunk');
      
      // Agentic loop - let model decide when to stop
      while (turn < this.MAX_TURNS) {
        turn++;
        
        if (ws) {
          this.send(ws, { 
            type: 'status', 
            message: turn === 1 ? 'Thinking...' : `Processing (step ${turn})...` 
          });
        }
        
        // Generate response with tool use capability
        const response = await this.gemini.generateWithTools(
          conversationHistory,
          this.getAvailableTools(state),
          {
            model: 'gemini-2.5-flash',
            thinkingConfig: { thinkingBudget: 1024 },
            stream: false
          },
          (chunk: string) => {
            accumulatedResponse += chunk;
            batcher.add(chunk);
          }
        );
        
        // ensure buffered chunks are sent
        batcher.flush();
        
        // Check if model used tools
        if (response.toolCalls && response.toolCalls.length > 0) {
          // Execute tools
          if (ws) {
            this.send(ws, { 
              type: 'tool_use', 
              tools: response.toolCalls.map((t: any) => t.name) 
            });
          }
          
          const toolResults = await this.executeTools(response.toolCalls, state);
          
          // Add model's response with tool calls to history
          conversationHistory.push({
            role: 'assistant',
            content: response.text ?? '',
            toolCalls: response.toolCalls
          });
          
          // Add tool results to history
          conversationHistory.push({
            role: 'user',
            content: `Tool Results:\n${toolResults.map(r => 
              `${r.name}: ${r.success ? 'Success' : 'Failed'}\n${r.result}`
            ).join('\n\n')}`
          });
          
          // Continue to next turn - model will process results
          accumulatedResponse = '';
          continue;
        }
        
        // No tool calls - model has provided final answer
        break;
      }
      
      // Save final response
      if (accumulatedResponse) {
        this.sql.exec(
          `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
          'model',
          JSON.stringify([{ text: accumulatedResponse }]),
          Date.now()
        );
      }
      
      if (ws) {
        // Provide the final response payload and done indicator
        this.send(ws, { type: 'final_response', content: accumulatedResponse || '' });
        this.send(ws, { type: 'done', turns: turn });
      }
    });
  }

  // ===== State Management =====

  private async withStateTransaction<T>(fn: (state: AgentState) => Promise<T>): Promise<T> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.loadState();
      const result = await fn(state);
      await this.saveState(state);
      return result;
    });
  }

  private async loadState(): Promise<AgentState> {
    try {
      const row = this.sql.exec(`SELECT value FROM kv WHERE key = 'state'`).one();
      if (row?.value) {
        return JSON.parse(row.value as string);
      }
    } catch (e) {
      console.error('Failed to load state:', e);
    }

    return {
      conversationHistory: [],
      context: { files: [], searchResults: [] },
      sessionId: this.ctx.id.toString(),
      lastActivityAt: Date.now()
    } as AgentState;
  }

  private async saveState(state: AgentState): Promise<void> {
    try {
      this.sql.exec(
        `INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`,
        'state',
        JSON.stringify(state)
      );
    } catch (e) {
      console.error('Failed to save state:', e);
    }
  }

  // ===== Helpers: history, batching, send =====

  private buildHistory(limit = 50): any[] {
    try {
      const rows = Array.from(this.sql.exec(`SELECT role, parts, timestamp FROM messages ORDER BY timestamp DESC LIMIT ?`, limit).toArray()).reverse();
      return rows.map((r: any) => {
        let parts;
        try { parts = JSON.parse(r.parts); } catch { parts = [{ text: String(r.parts) }]; }
        return { role: r.role === 'model' ? 'assistant' : r.role, content: parts.map((p: any) => p.text || String(p)) };
      });
    } catch (e) {
      console.warn('buildHistory failed:', e);
      return [];
    }
  }

  private createChunkBatcher(ws: WebSocket | null, type = 'chunk', interval = 80) {
    let buffer = '';
    let timer: any = null;
    const flush = () => {
      if (buffer && ws) {
        this.send(ws, { type, content: buffer });
        buffer = '';
      }
      if (timer) { clearTimeout(timer); timer = null; }
    };
    return {
      add: (chunk: string) => {
        buffer += chunk;
        if (!timer) timer = setTimeout(flush, interval);
      },
      flush,
    };
  }

  private send(ws: WebSocket | null, payload: unknown): void {
    if (!ws) return;
    try {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
    } catch (e) {
      console.warn('WebSocket send failed:', e);
    }
  }

  // ===== WebSocket + HTTP handlers =====

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade endpoint
    if (url.pathname === '/api/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // Accept on DO's side
      this.ctx.acceptWebSocket(server);
      // track
      this.activeWebSockets.add(server);
      // attach event handlers on server side via global gateway (Cloudflare will call webSocketMessage etc.)
      return new Response(null, { status: 101, webSocket: client });
    }

    // REST: send message (fallback)
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const msg = body.message;
      // process in background
      this.ctx.waitUntil(this.process(msg, null));
      return new Response(JSON.stringify({ status: 'queued' }), { headers: { 'Content-Type': 'application/json' } });
    }

    // REST: history
    if (url.pathname === '/api/history' && request.method === 'GET') {
      try {
        const rows = this.sql.exec(`SELECT role, parts, timestamp FROM messages ORDER BY timestamp ASC`);
        const messages = [];
        for (const r of rows) {
          const parts = (() => {
            try { return JSON.parse(r.parts); } catch { return [{ text: r.parts }]; }
          })();
          messages.push({ role: r.role, parts, timestamp: r.timestamp });
        }
        return new Response(JSON.stringify({ messages }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'failed to read history' }), { status: 500 });
      }
    }

    return new Response('Not found', { status: 404 });
  }

  // Cloudflare will call these lifecycle handlers on the server WebSocket endpoint
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    let payload: any;
    try { payload = JSON.parse(message); } catch { return; }

    if (payload?.type === 'user_message' && typeof payload.content === 'string') {
      // run processing in background so CF doesn't timeout the handshake
      this.ctx.waitUntil(
        this.process(payload.content, ws).catch((err) => {
          console.error('process failed:', err);
          this.send(ws, { type: 'error', error: 'Processing failed' });
        })
      );
    } else {
      // ignore / optionally handle other control messages
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    console.log(`WebSocket closed: ${code} - ${reason}`);
    this.activeWebSockets.delete(ws);
  }

  async webSocketError(ws: WebSocket, err: unknown): Promise<void> {
    console.error('WebSocket error:', err);
    this.activeWebSockets.delete(ws);
  }
}

export default AutonomousAgent;
