// src/utils/gemini.ts - HYBRID (Orchestrated + Unified)
import { GoogleGenAI } from '@google/genai';
import type { TaskComplexity, ExecutionPlan, FileMetadata, AgentPhase } from '../types';

export interface ExecutionConfig {
  model?: string;
  stream?: boolean;
  timeoutMs?: number;
  thinkingConfig?: { thinkingBudget: number };
  files?: FileMetadata[];
  urlList?: string[];
  useSearch?: boolean;
  useCodeExecution?: boolean;
  useMapsGrounding?: boolean;
  useUrlContext?: boolean;
  allowComputerUse?: boolean;
  useVision?: boolean;
  stepAction?: string;
}

interface ToolConfig {
  tools: Array<Record<string, unknown>>;
  requiresFiles?: boolean;
  requiresUrls?: boolean;
}

class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private readonly threshold = 5;
  private readonly resetTimeout = 60000;

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isOpen()) {
      throw new Error('Circuit breaker open - too many recent failures');
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (e) {
      this.onFailure();
      throw e;
    }
  }
  private isOpen(): boolean {
    if (this.failures >= this.threshold) {
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.reset();
        return false;
      }
      return true;
    }
    return false;
  }
  private onSuccess(): void { this.failures = 0; }
  private onFailure(): void { this.failures++; this.lastFailureTime = Date.now(); }
  private reset(): void { this.failures = 0; }
  getStatus(): { failures: number; isOpen: boolean } {
    return { failures: this.failures, isOpen: this.isOpen() };
  }
}

// --- Unified Prompt System (from gemini.ts.txt) ---
class DynamicPromptBuilder {
  private readonly BASE_AUTONOMOUS_PROMPT = `
You are an autonomous AI agent with full decision-making authority. You operate independently to analyze, plan, execute, and complete user requests.
## Your Capabilities
- Native tools: thinking, search grounding, URL context, code execution
- External tools: via function calling (search, file analysis, vision, maps, etc.)
- Full autonomy: make decisions independently, adapt plans freely

## Workflow Phases
When responding, start with a tag indicating the current phase: e.g., <PHASE:ASSESSMENT>
1. ASSESSMENT: Analyze the user's request. Output a plan or a direct answer.
2. PLANNING: Detail the steps for a complex request. Output in a markdown list.
3. EXECUTION: Carry out a step, including tool calls (search, code, etc.).
4. CLARIFICATION: Request missing information from the user.
5. COMPLETION: Provide the final, synthesized answer.
`;
  private readonly PHASE_MODULES = new Map<AgentPhase, string>([
    [AgentPhase.ASSESSMENT, `
## Current Phase: ASSESSMENT
Analyze the user request: {{USER_REQUEST}}. Decide if it's simple or complex. If simple, answer directly in this phase. If complex, transition to the PLANNING phase.
Context: {{CONTEXT}}
`],
    [AgentPhase.PLANNING, `
## Current Phase: PLANNING
Generate a detailed execution plan for the request: {{USER_REQUEST}}. The plan must be a numbered list of steps. Once the plan is complete, transition to the EXECUTION phase.
Context: {{CONTEXT}}
`],
    [AgentPhase.EXECUTION, `
## Current Phase: EXECUTION
Execute the current step in the plan. Use available tools (search, file_analysis, code_execution, etc.) as needed by providing a tool call block. If external tool results are available, use them to continue the plan. If the plan is complete, transition to the COMPLETION phase.
Context: {{CONTEXT}}
`],
    [AgentPhase.CLARIFICATION, `
## Current Phase: CLARIFICATION
You require more information to proceed with the request: {{USER_REQUEST}}. Formulate a clear, concise question to the user. Do not proceed until a response is received.
Context: {{CONTEXT}}
`],
    [AgentPhase.COMPLETION, `
## Current Phase: COMPLETION
The task is complete. Synthesize all findings and results into a comprehensive, final answer for the user request: {{USER_REQUEST}}.
Context: {{CONTEXT}}
`]
  ]);

  private readonly CONTEXT_MODULES = new Map<string, string>([
    ['fileHandling', `
## File Processing Context
Files are available for analysis. Use the fileAnalysis tool to process them.
`],
    ['complexExecution', `
## Complex Task Execution
Task requires multiple steps. Follow the plan.
`],
    ['searchRequired', `
## Search and Research Context
External search or research is needed. Use the googleSearch tool.
`]
  ]);

  buildPrompt(
    context: {
      userRequest: string;
      currentPhase: AgentPhase;
      availableTools: string[];
      context: string;
    }
  ): string {
    let prompt = this.BASE_AUTONOMOUS_PROMPT;
    const phaseModule = this.PHASE_MODULES.get(context.currentPhase);
    if (phaseModule) {
      prompt += phaseModule.replace('{{USER_REQUEST}}', context.userRequest)
                        .replace('{{CONTEXT}}', context.context);
    }
    
    // Append context modules based on available tools (simplified logic)
    if (context.availableTools.includes('file_analysis')) {
        prompt += this.CONTEXT_MODULES.get('fileHandling');
    }
    if (context.availableTools.includes('search')) {
        prompt += this.CONTEXT_MODULES.get('searchRequired');
    }
    if (context.currentPhase === AgentPhase.EXECUTION) {
        prompt += this.CONTEXT_MODULES.get('complexExecution');
    }

    return prompt.trim();
  }
}
// --- End Unified Prompt System ---


export class GeminiClient {
  private ai: ReturnType<typeof GoogleGenAI>;
  private maxRetries = 3;
  private baseBackoff = 1000;
  private defaultTimeoutMs = 60_000;
  private circuitBreaker = new CircuitBreaker();
  private promptBuilder = new DynamicPromptBuilder();

  private readonly ACTION_TOOL_MAP: Record<string, ToolConfig> = {
    search: { tools: [{ googleSearch: {} }] },
    research: { tools: [{ googleSearch: {} }] },
    code_execute: { tools: [{ codeExecution: {} }] },
    code: { tools: [{ codeExecution: {} }] },
    file_analysis: { tools: [{ fileAnalysis: {} }], requiresFiles: true },
    file: { tools: [{ fileAnalysis: {} }], requiresFiles: true },
    vision_analysis: { tools: [{ vision: {} }] },
    vision: { tools: [{ vision: {} }] },
    maps: { tools: [{ googleMaps: {} }] },
    url_context: { tools: [{ urlContext: {} }], requiresUrls: true },
    url_analysis: { tools: [{ urlContext: {} }], requiresUrls: true },
    computer: { tools: [{ computerUse: {} }] },
    data_analysis: { tools: [{ codeExecution: {} }] },
    synthesize: { tools: [] },
    analyze: { tools: [] },
  };

  constructor(opts?: { apiKey?: string }) {
    // @ts-ignore - Constructor for GoogleGenAI is expected
    this.ai = new GoogleGenAI({ apiKey: opts?.apiKey });
  }

  // ===== Utility Methods (Reconstructed) =====
  private parse<T>(text: string): T | null {
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]) as T;
      }
      return null;
    } catch (e) {
      console.error('JSON parsing failed:', e);
      return null;
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; i < this.maxRetries; i++) {
      try {
        return await this.circuitBreaker.execute(fn);
      } catch (error: any) {
        if (i === this.maxRetries - 1) throw error;
        const delay = this.baseBackoff * Math.pow(2, i);
        console.warn(`Attempt ${i + 1} failed. Retrying in ${delay}ms. Error: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw new Error('Exhausted all retries.');
  }

  private async withTimeout<T>(promise: Promise<T>, errorMsg = 'timeout', ms?: number): Promise<T> {
    const timeoutMs = ms ?? this.defaultTimeoutMs;
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(errorMsg)), timeoutMs)
      ),
    ]);
  }

  // Files API (Placeholders)
  async uploadFile(fileDataBase64: string, mimeType: string, displayName: string): Promise<FileMetadata> {
    return {
      fileUri: `placeholder://${displayName}`,
      mimeType,
      name: displayName,
      sizeBytes: Math.round(fileDataBase64.length * 0.75),
      uploadedAt: Date.now(),
      state: 'ACTIVE',
    };
  }
  async getFileStatus(fileUriOrName: string): Promise<string> { return 'ACTIVE'; }
  async deleteFile(fileUriOrName: string): Promise<void> { /* no-op */ }
  
  // Content Building Helpers (Reconstructed)
  private mapActionToTools(action: string | undefined, context: { hasFiles: boolean; hasUrls: boolean }): Array<Record<string, unknown>> {
    const actionKey = (action ?? '').toLowerCase().split(':')[0];
    const config = this.ACTION_TOOL_MAP[actionKey];
    if (!config) return [];
    
    if (config.requiresFiles && !context.hasFiles) return [];
    if (config.requiresUrls && !context.hasUrls) return [];

    return config.tools;
  }
  
  private buildContents(prompt: string, history?: Array<{ role: string; parts: any[] }>, files?: FileMetadata[], urlList?: string[]): any[] {
    const contents: any[] = [];
    
    // Add history (reversed for correct chat format, if needed)
    (history ?? []).forEach(msg => {
      contents.push({ role: msg.role, parts: msg.parts });
    });

    // Add files/urls/context to the last message if not already present (simplified)
    const contextParts: any[] = [];
    (files ?? []).forEach(file => contextParts.push({ file_data: { mime_type: file.mimeType, file_uri: file.fileUri } }));
    (urlList ?? []).forEach(url => contextParts.push({ url }));

    // Add the final prompt
    contents.push({ role: 'user', parts: [...contextParts, { text: prompt }] });
    
    return contents;
  }
  
  private extractTextFromChunk(chunk: any): string {
    return chunk?.text ?? '';
  }

  private async handleStreamedResponse(streamResp: any, onChunk?: (text: string) => void): Promise<string> {
    let fullResponse = '';
    
    if (streamResp && Symbol.asyncIterator in streamResp) {
      for await (const chunk of streamResp) {
        const text = this.extractTextFromChunk(chunk);
        if (text) {
          fullResponse += text;
          if (onChunk) onChunk(text);
        }
      }
    }
    return fullResponse;
  }

  // ===== Orchestrated Functions (from gemini.ts) =====

  async analyzeComplexity(query: string, hasFiles = false): Promise<TaskComplexity> {
    return this.withRetry(async () => {
      const prompt = `Analyze request complexity. Respond with JSON only:
{
  "type": "simple" | "complex",
  "requiredTools": ["search" | "code_execution" | "file_analysis" | "vision"],
  "estimatedSteps": number,
  "reasoning": "string",
  "requiresFiles": boolean,
  "requiresCode": boolean,
  "requiresVision": boolean
}
Files: ${hasFiles ? 'YES' : 'NO'}
Query: ${query}`;

      const resp = await this.withTimeout(
        this.ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
          config: { thinkingConfig: { thinkingBudget: 512 } },
        }),
        'analyzeComplexity timed out',
        30_000
      );
      return this.parse<TaskComplexity>(resp?.text ?? '') ?? { type: 'simple', requiredTools: [], estimatedSteps: 1, reasoning: 'Failed to parse complexity', requiresFiles: false, requiresCode: false, requiresVision: false };
    });
  }

  async generatePlanOptimized(
    query: string,
    complexity: TaskComplexity,
    hasFiles: boolean,
    maxSteps: number = 5
  ): Promise<ExecutionPlan> {
    return this.withRetry(async () => {
      const prompt = `Create execution plan (MAX ${maxSteps} steps). Respond with JSON only:
{
  "steps": [
    {
      "id": "step-1",
      "description": "...",
      "action": "search" | "code_execute" | "file_analysis" | "synthesize"
    }
  ],
  "currentStepIndex": 0,
  "status": "planning",
  "createdAt": ${Date.now()}
}
Complexity: ${complexity.type}
Query: ${query}`;

      const resp = await this.withTimeout(
        this.ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
          config: { thinkingConfig: { thinkingBudget: 1024 } },
        }),
        'generatePlan timed out',
        30_000
      );
      const plan = this.parse<ExecutionPlan>(resp?.text ?? '');
      if (!plan || !plan.steps) throw new Error('Failed to parse execution plan');
      return plan;
    });
  }
  
  async generatePlan(query: string, complexity: TaskComplexity, hasFiles: boolean): Promise<ExecutionPlan> {
    return this.generatePlanOptimized(query, complexity, hasFiles, 8);
  }

  async streamResponse(
    query: string,
    history: Array<{ role: string; parts: any[] }>,
    onChunk?: (text: string) => void,
    opts?: { model?: string; thinkingConfig?: any; timeoutMs?: number }
  ): Promise<string> {
    return this.withRetry(async () => {
        const contents = this.buildContents(query, history);
        const streamResp = await this.ai.models.generateContent({
          model: opts?.model ?? 'gemini-2.5-flash',
          contents,
          config: {
            thinkingConfig: opts?.thinkingConfig ?? { thinkingBudget: 256 },
            stream: true,
          }
        });
        return this.handleStreamedResponse(streamResp, onChunk);
    });
  }

  async executeWithConfig(
    prompt: string,
    history: Array<{ role: string; parts: any[] }>,
    config: ExecutionConfig,
    onChunk?: (text: string) => void
  ): Promise<string> {
    return this.withRetry(async () => {
      const hasFiles = (config.files ?? []).length > 0;
      const hasUrls = (config.urlList ?? []).length > 0;
      const tools = this.mapActionToTools(config.stepAction, { hasFiles, hasUrls });

      const contents = this.buildContents(prompt, history, config.files, config.urlList);

      const call = this.ai.models.generateContent({
        model: config.model ?? 'gemini-2.5-flash',
        contents,
        config: {
          thinkingConfig: config.thinkingConfig ?? { thinkingBudget: 512 },
          tools: tools.length ? tools : undefined,
          stream: config.stream === true,
        },
      } as any);

      if (config.stream === true) {
        return await this.handleStreamedResponse(call, onChunk);
      }

      const resp = await this.withTimeout(call, 'executeWithConfig timed out', config.timeoutMs);
      const text = (resp?.text ?? '') as string;
      return text || '[no-result]';
    });
  }

  async synthesize(
    originalQuery: string,
    stepResults: Array<{ description: string; result: string }>,
    history: Array<{ role: string; parts: any[] }>
  ): Promise<string> {
    return this.withRetry(async () => {
      const prompt = `Request: ${originalQuery}\n\nResults:\n${stepResults.map((s, i) => `${i + 1}. ${s.description}: ${s.result.substring(0, 300)}`).join('\n')}\n\nProvide comprehensive answer:`;

      const resp = await this.withTimeout(
        this.ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
          config: { thinkingConfig: { thinkingBudget: 1024 } },
        }),
        'synthesize timed out',
        45_000
      );
      return resp?.text ?? 'Synthesis failed.';
    });
  }

  // ===== Unified Autonomous Agent Method (NEW/FIXED) =====

  async executeUnifiedAutonomous(
    context: {
      userRequest: string;
      currentPhase: AgentPhase;
      conversationHistory: Array<{ role: string; parts: any[] }>;
      availableTools: string[];
      files?: FileMetadata[];
      urlList?: string[];
    },
    onChunk?: (text: string) => void,
    opts?: { model?: string; thinkingConfig?: any; timeoutMs?: number }
  ): Promise<{
    response: string;
    phaseChanges?: AgentPhase[];
    toolCalls?: Array<{ tool: string; params: Record<string, any>; result: null }>;
    clarificationRequests?: string[];
  }> {
    return this.withRetry(async () => {
      const contextStr = this.buildContextString(context);
      const prompt = this.promptBuilder.buildPrompt({
        userRequest: context.userRequest,
        currentPhase: context.currentPhase,
        availableTools: context.availableTools,
        context: contextStr
      });

      let tools: Array<Record<string, unknown>> = [];
      const hasFiles = (context.files ?? []).length > 0;
      const hasUrls = (context.urlList ?? []).length > 0;

      // Only enable tools during EXECUTION phase
      if (context.currentPhase === AgentPhase.EXECUTION) {
        if (context.availableTools.includes('search')) tools.push({ googleSearch: {} });
        if (context.availableTools.includes('file_analysis') && hasFiles) tools.push({ fileAnalysis: {} });
        if (context.availableTools.includes('code_execution')) tools.push({ codeExecution: {} });
        if (context.availableTools.includes('vision') && hasFiles) tools.push({ vision: {} });
        if (context.availableTools.includes('maps')) tools.push({ googleMaps: {} });
        if (context.availableTools.includes('url_context') && hasUrls) tools.push({ urlContext: {} });
      }

      const contents = this.buildContents(prompt, context.conversationHistory, context.files, context.urlList);
      
      const response = await this.withTimeout(
        this.ai.models.generateContent({
          model: opts?.model ?? 'gemini-2.5-flash',
          contents,
          config: {
            thinkingConfig: opts?.thinkingConfig ?? { thinkingBudget: 1024 },
            tools: tools.length ? tools : undefined,
            stream: true,
          },
        } as any),
        'executeUnifiedAutonomous timed out',
        opts?.timeoutMs ?? 120_000
      );

      let fullResponse = '';
      const phaseChanges: AgentPhase[] = [];
      const toolCalls: Array<{ tool: string; params: Record<string, any>; result: null }> = [];
      const clarificationRequests: string[] = [];

      if (response && Symbol.asyncIterator in response) {
        for await (const chunk of response) {
          
          // Handle tool calls from the model
          if (chunk.functionCalls && chunk.functionCalls.length > 0) {
            for (const call of chunk.functionCalls) {
              console.log(`[GeminiClient] Model requesting tool: ${call.name}`);
              toolCalls.push({ tool: call.name, params: call.args, result: null });
            }
          }

          // Handle text
          const text = this.extractTextFromChunk(chunk);
          if (text) {
            fullResponse += text;
            try {
              if (onChunk) onChunk(text);
            } catch (e) {
              console.warn('[GeminiClient] onChunk error:', e);
            }
            // Parse text output for phase changes and clarifications
            this.parseAutonomousResponse(text, phaseChanges, toolCalls, clarificationRequests);
          }
        }
      }

      return {
        response: fullResponse,
        phaseChanges: phaseChanges.length ? phaseChanges : undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        clarificationRequests: clarificationRequests.length ? clarificationRequests : undefined,
      };
    });
  }

  // Helpers for Unified Agent (Reconstructed)
  private buildContextString(context: {
    userRequest: string;
    currentPhase: AgentPhase;
    conversationHistory: Array<{ role: string; parts: any[] }>;
    availableTools: string[];
    files?: FileMetadata[];
    urlList?: string[];
  }): string {
    let ctx = `Current Phase: ${context.currentPhase}\n`;
    if (context.files?.length) {
      ctx += `Files available: ${context.files.length} (e.g., ${context.files[0].name}).\n`;
    }
    if (context.urlList?.length) {
      ctx += `URLs available: ${context.urlList.length} (e.g., ${context.urlList[0]}).\n`;
    }
    return ctx;
  }

  private parseAutonomousResponse(
    text: string,
    phaseChanges: AgentPhase[],
    toolCalls: Array<any>,
    clarificationRequests: string[]
  ): void {
    // Look for <PHASE:X> tags
    const phaseMatch = text.match(/<PHASE:(\w+)>/i);
    if (phaseMatch) {
      const phase = phaseMatch[1].toUpperCase() as AgentPhase;
      if (Object.values(AgentPhase).includes(phase) && !phaseChanges.includes(phase)) {
        phaseChanges.push(phase);
      }
    }
    
    // Simple parsing for clarification questions (look for specific keywords after a question mark)
    if (text.includes('?') && text.toLowerCase().includes('clarify')) {
      if (!clarificationRequests.length) {
        clarificationRequests.push(text.trim());
      }
    }
  }
  
  // ===================================

  getCircuitBreakerStatus() {
    return this.circuitBreaker.getStatus();
  }
}

export default GeminiClient;
