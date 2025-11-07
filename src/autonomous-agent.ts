// src/autonomous-agent.ts
import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import GeminiClient from './utils/gemini';
import type {
  Env,
  AgentState,
  Message,
  ExecutionPlan,
  PlanStep,
  TaskComplexity,
  FileMetadata,
  Tool,
  ToolCall,
  ToolResult,
} from './types';

interface SqlStorage {
  exec(query: string, ...params: any[]): {
    one(): any;
    toArray(): any[];
    [Symbol.iterator](): Iterator<any>;
  };
}

interface StepExecutionOptions {
  continueOnFailure?: boolean;
  maxRetries?: number;
  parallelExecution?: boolean;
}

interface Metrics {
  requestCount: number;
  errorCount: number;
  avgResponseTime: number;
  activeConnections: number;
  totalResponseTime: number;
  complexityDistribution: { simple: number; complex: number };
}

export class AutonomousAgent extends DurableObject<Env> {
  private sql: SqlStorage;
  private gemini: InstanceType<typeof GeminiClient>;
  private maxHistoryMessages = 200;
  private readonly MAX_MESSAGE_SIZE = 100_000;
  private readonly MAX_TOTAL_HISTORY_SIZE = 500_000;
  private readonly COMPLEXITY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private activeWebSockets = new Set<WebSocket>();
  private metrics: Metrics = {
    requestCount: 0,
    errorCount: 0,
    avgResponseTime: 0,
    activeConnections: 0,
    totalResponseTime: 0,
    complexityDistribution: { simple: 0, complex: 0 },
  };

  // Tool definitions cached for convenience
  private baseTools: Tool[] = [
    {
      name: 'web_search',
      description:
        'Search the web for current information, recent events, or fact-checking. Returns up to 10 relevant results.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Concise search query (2-6 words recommended)',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'code_execute',
      description:
        'Execute Python code for calculations, data analysis, or creating visualizations. Code runs in isolated sandbox.',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'Python code to execute. Can use numpy, pandas, matplotlib.',
          },
          explanation: {
            type: 'string',
            description: 'Brief explanation of what this code does',
          },
        },
        required: ['code', 'explanation'],
      },
    },
    {
      name: 'create_visualization',
      description: 'Generate charts and graphs from data. Returns image URL.',
      parameters: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            description: 'Data to visualize as JSON object',
          },
          chartType: {
            type: 'string',
            enum: ['bar', 'line', 'pie', 'scatter'],
            description: 'Type of chart to create',
          },
          title: { type: 'string', description: 'Chart title' },
        },
        required: ['data', 'chartType'],
      },
    },
    {
      name: 'analyze_file',
      description: 'Read and analyze uploaded files. Supports text, PDFs, images, spreadsheets.',
      parameters: {
        type: 'object',
        properties: {
          fileIndex: { type: 'number', description: 'Index of file to analyze (0-based)' },
          operation: {
            type: 'string',
            enum: ['summarize', 'extract_data', 'analyze_content', 'get_metadata'],
            description: 'What to do with the file',
          },
          query: { type: 'string', description: 'Optional: specific question about the file' },
        },
        required: ['fileIndex', 'operation'],
      },
    },
  ];

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql as SqlStorage;
    // instantiate the refactored Gemini client (assumes default export)
    this.gemini = new (GeminiClient as any)({ apiKey: env.GEMINI_API_KEY });

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

  // ===== Utility Methods =====

  private parse<T>(text: string): T | null {
    try {
      const trimmed = String(text || '').trim().replace(/^```json\s*/, '').replace(/```$/, '');
      if (!trimmed) return null;
      return JSON.parse(trimmed) as T;
    } catch (e) {
      console.error('JSON parse failed:', e);
      return null;
    }
  }

  private stringify(obj: unknown): string {
    return JSON.stringify(obj);
  }

  private async withErrorContext<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      error.message = `[${operation}] ${error.message}`;
      throw error;
    }
  }

  private trackRequest<T>(fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    this.metrics.requestCount++;

    return fn()
      .then((result) => {
        const duration = Date.now() - start;
        this.metrics.totalResponseTime += duration;
        this.metrics.avgResponseTime = this.metrics.totalResponseTime / this.metrics.requestCount;
        return result;
      })
      .catch((e) => {
        this.metrics.errorCount++;
        throw e;
      });
  }

  // ===== Enhanced Complexity Analysis (simple heuristics + fallback) =====

  private async analyzeComplexityEnhanced(
    query: string,
    hasFiles: boolean
  ): Promise<TaskComplexity> {
    const lowerQuery = query.toLowerCase();

    const simpleIndicators = [
      /^(hi|hello|hey|greetings)/i,
      /^what is /i,
      /^who is /i,
      /^when /i,
      /^where /i,
      /^define /i,
      /^explain /i,
      /^tell me about /i,
    ];

    const complexIndicators = [
      /\b(analyze|compare|calculate|process|generate|create|build)\b/i,
      /\b(step by step|detailed|comprehensive|in-depth)\b/i,
      /\b(multiple|several|various)\b/i,
      hasFiles,
      lowerQuery.includes(' and ') && lowerQuery.split(' and ').length > 2,
    ];

    const wordCount = query.split(/\s+/).length;

    if (simpleIndicators.some((pattern) => pattern.test(query)) && wordCount < 10 && !hasFiles) {
      this.metrics.complexityDistribution.simple++;
      return {
        type: 'simple',
        requiredTools: [],
        estimatedSteps: 1,
        reasoning: 'Quick heuristic: simple question',
        requiresFiles: false,
        requiresCode: false,
        requiresVision: false,
      } as TaskComplexity;
    }

    const complexCount = complexIndicators.filter((ind) => {
      if (typeof ind === 'boolean') return ind;
      return ind.test(query);
    }).length;

    if (complexCount >= 3 || wordCount > 50) {
      this.metrics.complexityDistribution.complex++;
      return {
        type: 'complex',
        requiredTools: hasFiles ? ['analyze_file', 'web_search'] : ['web_search'],
        estimatedSteps: Math.min(Math.ceil(wordCount / 20), 8),
        reasoning: 'Quick heuristic: multiple complexity indicators detected',
        requiresFiles: hasFiles,
        requiresCode: /\b(code|calculate|compute|run)\b/i.test(query),
        requiresVision: /\b(image|picture|photo|visual)\b/i.test(query),
      } as TaskComplexity;
    }

    // Fallback: let Gemini produce a complexity assessment via its tool if available
    try {
      const resp = await this.gemini.generateWithTools(
        [
          { role: 'system', content: 'Assess complexity of the following user request.' },
          { role: 'user', content: query },
        ],
        [],
        { model: 'gemini-2.5-flash', stream: false }
      );
      // Try to parse response.text as JSON or basic heuristics
      const parsed = this.parse<any>(resp.text || '');
      if (parsed && parsed.type) {
        this.metrics.complexityDistribution[parsed.type === 'complex' ? 'complex' : 'simple']++;
        return parsed as TaskComplexity;
      }
    } catch (e) {
      console.warn('LLM complexity assessment failed, falling back:', e);
    }

    this.metrics.complexityDistribution.simple++;
    return {
      type: 'simple',
      requiredTools: [],
      estimatedSteps: 1,
      reasoning: 'fallback default',
      requiresFiles: hasFiles,
      requiresCode: false,
      requiresVision: false,
    } as TaskComplexity;
  }

  // ===== State Management =====

  private async loadState(): Promise<AgentState> {
    let state: AgentState | null = null;
    try {
      const row = this.sql.exec(`SELECT value FROM kv WHERE key = 'state'`).one();
      if (row && typeof row.value === 'string') {
        state = this.parse<AgentState>(row.value);
      }
    } catch (e) {
      console.error('SQLite read failed:', e);
    }

    if (!state || !state.sessionId) {
      state = {
        conversationHistory: [],
        context: { files: [], searchResults: [] },
        sessionId: this.ctx?.id?.toString ? this.ctx.id.toString() : Date.now().toString(),
        lastActivityAt: Date.now(),
        currentPlan: undefined,
      } as AgentState;
    }

    await this.checkMemoryPressure();
    return state;
  }

  private async saveState(state: AgentState): Promise<void> {
    try {
      const stateStr = this.stringify(state);
      this.sql.exec(
        `INSERT INTO kv (key, value) VALUES ('state', ?) 
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        stateStr
      );
    } catch (e) {
      console.error('saveState failed:', e);
    }
  }

  private async withStateTransaction<T>(fn: (state: AgentState) => Promise<T>): Promise<T> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.loadState();
      const result = await fn(state);
      await this.saveState(state);
      return result;
    });
  }

  // ===== Memory Management =====

  private estimateHistorySize(): number {
    try {
      const result = this.sql.exec(`SELECT SUM(LENGTH(parts)) as total FROM messages`).one();
      return result?.total ?? 0;
    } catch (e) {
      console.warn('Failed to estimate history size:', e);
      return 0;
    }
  }

  private async checkMemoryPressure(): Promise<void> {
    const historySize = this.estimateHistorySize();
    if (historySize > this.MAX_TOTAL_HISTORY_SIZE) {
      console.warn(`History size ${historySize} exceeds limit, trimming`);
      await this.trimHistoryIfNeeded();
    }
  }

  private async trimHistoryIfNeeded(): Promise<void> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const count = this.sql.exec(`SELECT COUNT(1) as c FROM messages`).one()?.c ?? 0;
        if (count > this.maxHistoryMessages) {
          const toKeep = this.maxHistoryMessages;
          this.sql.exec(
            `DELETE FROM messages 
             WHERE id NOT IN (
               SELECT id FROM messages 
               ORDER BY timestamp DESC 
               LIMIT ?
             )`,
            toKeep
          );
          console.log(`Trimmed history: kept ${toKeep} messages`);
        }
      } catch (e) {
        console.error('History truncation failed:', e);
      }
    });
  }

  // ===== WebSocket Management =====

  private send(ws: WebSocket | null, data: unknown): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(this.stringify(data));
    } catch (e) {
      console.error('WebSocket send failed:', e);
    }
  }

  private createChunkBatcher(ws: WebSocket | null, type: string, flushInterval = 50) {
    let buffer = '';
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      if (buffer && ws) {
        this.send(ws, { type, content: buffer });
        buffer = '';
      }
      timer = null;
    };

    return {
      add: (chunk: string) => {
        buffer += chunk;
        if (!timer) {
          timer = setTimeout(flush, flushInterval);
        }
      },
      flush,
    };
  }

  // ===== HTTP Fetch Handler =====

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      this.activeWebSockets.add(server);
      this.metrics.activeConnections = this.activeWebSockets.size;
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/api/chat' && request.method === 'POST') return this.handleChat(request);
    if (url.pathname === '/api/history' && request.method === 'GET') return this.getHistory();
    if (url.pathname === '/api/clear' && request.method === 'POST') return this.clearHistory();
    if (url.pathname === '/api/status' && request.method === 'GET') return this.getStatus();
    if (url.pathname === '/api/metrics' && request.method === 'GET') return this.getMetrics();

    return new Response('Not found', { status: 404 });
  }

  // ===== WebSocket Handlers =====

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    if (ws.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket not open, discarding message');
      return;
    }

    let payload: any;
    try {
      payload = JSON.parse(message);
    } catch {
      this.send(ws, { type: 'error', error: 'Invalid JSON' });
      return;
    }

    if (payload.type === 'user_message' && typeof payload.content === 'string') {
      this.ctx.waitUntil(
        this.trackRequest(() => this.process(payload.content, ws)).catch((err) => {
          console.error('WebSocket process failed:', err);
          this.send(ws, { type: 'error', error: 'Processing failed' });
        })
      );
    } else {
      this.send(ws, { type: 'error', error: 'Invalid payload' });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    console.log(`WebSocket closed: ${code} - ${reason}`);
    this.activeWebSockets.delete(ws);
    this.metrics.activeConnections = this.activeWebSockets.size;
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('WebSocket error:', error);
    this.activeWebSockets.delete(ws);
    this.metrics.activeConnections = this.activeWebSockets.size;
  }

  // ===== Core Processing Logic (uses generateWithTools each iteration) =====

  private async process(userMsg: string, ws: WebSocket | null): Promise<void> {
    return this.withStateTransaction(async (state) => {
      state.lastActivityAt = Date.now();

      if (userMsg.length > this.MAX_MESSAGE_SIZE) {
        if (ws) this.send(ws, { type: 'error', error: 'Message too large' });
        throw new Error('Message exceeds maximum size');
      }

      // Save user message
      try {
        this.sql.exec(
          `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
          'user',
          this.stringify([{ text: userMsg }]),
          Date.now()
        );
      } catch (e) {
        console.error('Failed to save user message:', e);
        if (ws) this.send(ws, { type: 'error', error: 'Save failed' });
        throw e;
      }

      // Build system prompt and initial history
      const systemPrompt = this.buildSystemPrompt(state);
      const history = this.buildHistory();

      // Conversation history for Gemini format: system + history + user
      let conversationHistory: any[] = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: userMsg },
      ];

      // Determine tools currently available (include analyze_file if files present)
      const tools = this.getAvailableTools(state);

      let turn = 0;
      let accumulatedResponse = '';
      const batcher = this.createChunkBatcher(ws, 'chunk');

      // Agentic loop: call generateWithTools each iteration
      while (turn < 10) {
        turn++;
        if (ws) {
          this.send(ws, { type: 'status', message: turn === 1 ? 'Thinking...' : `Processing (step ${turn})...` });
        }

        // call generateWithTools; stream chunks into accumulatedResponse via onChunk
        const genResp = await this.gemini.generateWithTools(
          conversationHistory,
          tools,
          { model: 'gemini-2.5-flash', stream: true, thinkingConfig: { thinkingBudget: 1024 } },
          (chunk: string) => {
            accumulatedResponse += chunk;
            batcher.add(chunk);
          }
        );

        // ensure we flush any buffered chunks to client
        batcher.flush();

        // If tool calls were issued by model, execute them
        if (genResp.toolCalls && genResp.toolCalls.length > 0) {
          if (ws) {
            this.send(ws, { type: 'tool_use', tools: genResp.toolCalls.map((t: ToolCall) => t.name) });
          }

          // Run tool calls and collect results
          const toolResults = await this.executeTools(genResp.toolCalls, state);

          // Append assistant message describing tool call / intermediate result
          conversationHistory.push({
            role: 'assistant',
            content: genResp.text || accumulatedResponse || '',
            toolCalls: genResp.toolCalls,
          });

          // Add tool results back into history as a user-type message so model can consume
          conversationHistory.push({
            role: 'user',
            content:
              'Tool Results:\n' +
              toolResults
                .map(
                  (r) =>
                    `${r.name}: ${r.success ? 'Success' : 'Failed'}\n${r.result ? r.result : ''}`
                )
                .join('\n\n'),
          });

          // reset accumulatedResponse to capture next pass
          accumulatedResponse = '';
          // Continue loop for next reasoning iteration
          continue;
        }

        // No tool calls -> model produced a final answer (or a chunked answer)
        // If model returned `text` directly, use it. Otherwise use accumulatedResponse.
        const finalText = genResp.text || accumulatedResponse;

        if (finalText && finalText.length > 0) {
          // Save final response
          try {
            this.sql.exec(
              `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
              'model',
              this.stringify([{ text: finalText }]),
              Date.now()
            );
          } catch (e) {
            console.error('Failed to save model response:', e);
          }

          if (ws) {
            this.send(ws, { type: 'final_response', content: finalText });
            this.send(ws, { type: 'done', turns: turn });
          }
        } else {
          if (ws) {
            this.send(ws, { type: 'done', turns: turn });
          }
        }

        break; // exit agentic loop on no tool calls
      }
    });
  }

  // ===== Tool execution bridge (maps toolCalls -> concrete tool behaviors) =====

  private async executeTools(toolCalls: ToolCall[], state: AgentState): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const call of toolCalls) {
      try {
        let result: any;
        switch (call.name) {
          case 'web_search':
            result = await this.toolWebSearch(call.args?.query);
            break;
          case 'code_execute':
            result = await this.toolCodeExecute(call.args?.code, call.args?.explanation);
            break;
          case 'analyze_file':
            result = await this.toolAnalyzeFile(call.args?.fileIndex, call.args?.operation, call.args?.query, state);
            break;
          case 'create_visualization':
            result = await this.toolCreateVisualization(call.args?.data, call.args?.chartType, call.args?.title);
            break;
          default:
            result = { error: `Unknown tool: ${call.name}` };
        }

        results.push({
          name: call.name,
          result: typeof result === 'string' ? result : this.stringify(result),
          success: !result?.error,
        });
      } catch (e) {
        results.push({
          name: call.name,
          result: this.stringify({ error: String(e) }),
          success: false,
        });
      }
    }
    return results;
  }

  // ===== Mock / placeholder tool implementations (replace with real integrations) =====

  private async toolWebSearch(query: string): Promise<any> {
    // Minimal placeholder - replace with real search (Bing/Google/Custom)
    return {
      results: [
        {
          title: 'Mock Search Result for: ' + query,
          url: 'https://example.com/search?q=' + encodeURIComponent(query),
          snippet: 'This is a mock snippet. Swap with a real search provider.',
        },
      ],
      query,
      timestamp: Date.now(),
    };
  }

  private async toolCodeExecute(code: string, explanation?: string): Promise<any> {
    // Placeholder - you should route to a sandboxed Python runner or Gemini's code execution if available
    return {
      output: 'Executed code (mock). Replace with real sandbox.',
      stdout: '',
      stderr: '',
      explanation: explanation ?? '',
      executionTimeMs: 12,
    };
  }

  private async toolAnalyzeFile(
    fileIndex: number,
    operation: string,
    query: string | undefined,
    state: AgentState
  ): Promise<any> {
    const files = state.context?.files ?? [];
    if (typeof fileIndex !== 'number' || fileIndex >= files.length) {
      return { error: 'File index out of range' };
    }
    const file = files[fileIndex];
    // Basic placeholder behavior
    return {
      fileName: file.name,
      operation,
      query,
      result: `Mock analysis of ${file.name} (operation=${operation}). Replace with real file analysis.`,
      metadata: file,
    };
  }

  private async toolCreateVisualization(data: any, chartType: string, title?: string): Promise<any> {
    // Placeholder - generate or call a graphing service and return URL
    return {
      chartUrl: `https://example.com/chart.png?type=${encodeURIComponent(chartType)}&t=${encodeURIComponent(
        title ?? ''
      )}`,
      chartType,
      title,
      dataPoints: data ? Object.keys(data).length : 0,
    };
  }

  // ===== Prompt & Tools helpers =====

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
${tools.map((t) => `- ${t.name}: ${t.description}`).join('\n')}

${hasFiles ? `\n# Uploaded Files\nThe user has uploaded ${state.context.files.length} file(s). You can analyze them using the analyze_file tool.\n` : ''}

# Decision Process
1. Assess whether you can answer directly or require tools.
2. If tools are needed, call one tool at a time and wait for results.
3. Reflect after each tool call and continue until you can respond.
4. Provide a concise final answer.

Begin by assessing the user's request and deciding your approach.`;
  }

  private getAvailableTools(state: AgentState): Tool[] {
    const hasFiles = (state.context?.files ?? []).length > 0;
    const tools = [...this.baseTools];

    // If no files exist, filter out analyze_file
    if (!hasFiles) {
      return tools.filter((t) => t.name !== 'analyze_file');
    }
    return tools;
  }

  // ===== History helpers =====

  private buildHistory(): Array<{ role: string; parts: Array<{ text: string }> }> {
    return this.ctx.blockConcurrencyWhile(() => {
      const rows = this.sql
        .exec(`SELECT role, parts FROM messages ORDER BY timestamp DESC LIMIT ?`, Math.min(this.maxHistoryMessages, 50))
        .toArray();

      const hist: Array<{ role: string; parts: Array<{ text: string }> }> = [];

      for (const r of rows.reverse()) {
        const parts = this.parse<any[]>(r.parts as string);
        if (parts) {
          hist.push({
            role: r.role === 'model' ? 'model' : 'user',
            parts,
          });
        }
      }

      // Remove consecutive duplicate user messages
      let i = hist.length - 1;
      while (i > 0) {
        if (hist[i].role === 'user' && hist[i - 1].role === 'user') {
          hist.splice(i, 1);
        }
        i--;
      }

      return hist;
    });
  }

  // ===== HTTP Handlers / Utilities =====

  private async handleChat(req: Request): Promise<Response> {
    let message: string;
    try {
      const body = (await req.json()) as { message: string };
      message = body.message;
      if (!message) throw new Error('Missing message');
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid request' }), { status: 400 });
    }

    this.ctx.waitUntil(
      this.trackRequest(() => this.process(message, null)).catch((err) => {
        console.error('Background process failed:', err);
      })
    );

    return new Response(JSON.stringify({ status: 'queued' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private getHistory(): Response {
    const rows = this.sql.exec(`SELECT role, parts, timestamp FROM messages ORDER BY timestamp ASC`);
    const msgs: Message[] = [];
    for (const r of rows) {
      const parts = this.parse<any[]>(r.parts as string);
      if (parts) {
        msgs.push({
          role: r.role as any,
          parts,
          timestamp: r.timestamp as number,
        });
      }
    }
    return new Response(this.stringify({ messages: msgs }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async clearHistory(): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        this.sql.exec('DELETE FROM messages');
        this.sql.exec('DELETE FROM kv');
        this.sql.exec('DELETE FROM sqlite_sequence WHERE name IN ("messages")');
      } catch (e) {
        console.error('Clear failed:', e);
      }
      return new Response(this.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }

  private getStatus(): Response {
    let state: AgentState | null = null;
    try {
      const row = this.sql.exec(`SELECT value FROM kv WHERE key='state'`).one();
      state = row ? this.parse<AgentState>(row.value as string) : null;
    } catch (e) {
      console.error('getStatus read failed:', e);
    }

    return new Response(
      this.stringify({
        plan: state?.currentPlan,
        lastActivity: state?.lastActivityAt,
        sessionId: state?.sessionId,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  private getMetrics(): Response {
    // If gemini provides circuit-breaker status, include it if available
    let cbStatus = null;
    try {
      // safe-call in case method doesn't exist
      // @ts-ignore
      if (typeof this.gemini.getCircuitBreakerStatus === 'function') {
        // @ts-ignore
        cbStatus = this.gemini.getCircuitBreakerStatus();
      }
    } catch {
      cbStatus = null;
    }
    return new Response(this.stringify({
      ...this.metrics,
      circuitBreaker: cbStatus,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ===== fetch routing helper (exposes the HTTP endpoints) =====

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      this.activeWebSockets.add(server);
      this.metrics.activeConnections = this.activeWebSockets.size;
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/api/chat' && request.method === 'POST') return this.handleChat(request);
    if (url.pathname === '/api/history' && request.method === 'GET') return this.getHistory();
    if (url.pathname === '/api/clear' && request.method === 'POST') return this.clearHistory();
    if (url.pathname === '/api/status' && request.method === 'GET') return this.getStatus();
    if (url.pathname === '/api/metrics' && request.method === 'GET') return this.getMetrics();

    return new Response('Not found', { status: 404 });
  }
}

export default AutonomousAgent;
