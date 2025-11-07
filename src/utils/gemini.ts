// src/utils/gemini.ts - HYBRID (Orchestrated + Unified)
import { GoogleGenAI } from '@google/genai';
import type { TaskComplexity, ExecutionPlan, FileMetadata, AutonomousMode, AgentPhase } from '../types'; // Make sure AgentPhase is in types

// --- Unified Prompt System (from gemini.ts.txt) ---
class DynamicPromptBuilder {
  private readonly BASE_AUTONOMOUS_PROMPT = `
You are an autonomous AI agent with full decision-making authority.
You operate independently to analyze, plan, execute, and complete user requests.
## Your Capabilities
- Native tools: thinking, search grounding, URL context, code execution
- External tools: via function calling (search, file analysis, vision, maps, etc.)
- Full autonomy: make decisions independently, adapt plans freely

## Workflow Phases
(Phases 1-5 from gemini.ts.txt)
... (Full prompt text) ...
`;
private readonly PHASE_MODULES = new Map<AgentPhase, string>([
    [AgentPhase.ASSESSMENT, `
## Current Phase: ASSESSMENT
... (Full module text) ...
`],
    [AgentPhase.PLANNING, `
## Current Phase: PLANNING
... (Full module text) ...
`],
    [AgentPhase.EXECUTION, `
## Current Phase: EXECUTION
... (Full module text) ...
`],
    [AgentPhase.CLARIFICATION, `
## Current Phase: CLARIFICATION
... (Full module text) ...
`],
    [AgentPhase.COMPLETION, `
## Current Phase: COMPLETION
... (Full module text) ...
`]
  ]);
private readonly CONTEXT_MODULES = new Map<string, string>([
    ['fileHandling', `
## File Processing Context
... (Full module text) ...
`],
    ['complexExecution', `
## Complex Task Execution
... (Full module text) ...
`],
    ['searchRequired', `
## Search and Research Context
... (Full module text) ...
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
    // ... (rest of buildPrompt function from gemini.ts.txt) ...

    return prompt;
  }
}
// --- End Unified Prompt System ---


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
  [span_0](start_span)// ... (CircuitBreaker implementation from file 1 or 3) ... [cite: 4-15]
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

export class GeminiClient {
  private ai: ReturnType<typeof GoogleGenAI>;
  private maxRetries = 3;
  private baseBackoff = 1000;
  private defaultTimeoutMs = 60_000;
  private circuitBreaker = new CircuitBreaker();

  // --- NEW: Unified prompt builder ---
  [cite_start]private promptBuilder = new DynamicPromptBuilder();[span_0](end_span)

  private readonly ACTION_TOOL_MAP: Record<string, ToolConfig> = {
    [span_1](start_span)// ... (ACTION_TOOL_MAP from file 1 or 3) ... [cite: 34-36]
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
    this.ai = new GoogleGenAI({ apiKey: opts?.apiKey });
  }

  [cite_start]// ... (parse, withRetry, withTimeout methods from file 1 or 3) ... [cite: 38-48]
  private parse<T>(text: string): T | null { /* ... */ }
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> { /* ... */ }
  private async withTimeout<T>(promise: Promise<T>, errorMsg = 'timeout', ms?: number): Promise<T> { /* ... */ }

  // ===== Files API =====
  [cite_start]// ... (uploadFile, getFileStatus, deleteFile methods from file 1 or 3) ... [cite: 48-55]
  async uploadFile(fileDataBase64: string, mimeType: string, displayName: string): Promise<FileMetadata> { /* ... */ }
  async getFileStatus(fileUriOrName: string): Promise<string> { /* ... */ }
  async deleteFile(fileUriOrName: string): Promise<void> { /* ... */ }

  [cite_start]// ... (mapActionToTools, buildContents, extractTextFromChunk, extractTextFromResponse, readFromStream, handleStreamedResponse methods from file 1 or 3) ... [cite: 55-89]
  private mapActionToTools(action: string | undefined, context: { hasFiles: boolean; hasUrls: boolean }): Array<Record<string, unknown>> { /* ... */ }
  private buildContents(prompt: string, history?: Array<{ role: string; parts: any[] }>, files?: FileMetadata[], urlList?: string[]): any[] { /* ... */ }
  private extractTextFromChunk(chunk: any): string { /* ... */ }
  private async extractTextFromResponse(response: any): Promise<string> { /* ... */ }
  private async readFromStream(reader: ReadableStreamDefaultReader<Uint8Array>, onChunk?: (text: string) => void): Promise<string> { /* ... */ }
  private async handleStreamedResponse(streamResp: any, onChunk?: (text: string) => void): Promise<string> { /* ... */ }


  // ===== Orchestrated Functions (from gemini.ts) =====

  async analyzeComplexity(query: string, hasFiles = false): Promise<TaskComplexity> {
    return this.withRetry(async () => {
      const prompt = `Analyze request complexity - respond with JSON only:
{ ... (full prompt from gemini.ts) ... }
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
      // ... (rest of analyzeComplexity from gemini.ts) ...
    });
  }

  async generatePlanOptimized(
    query: string,
    complexity: TaskComplexity,
    hasFiles: boolean,
    maxSteps: number = 5
  ): Promise<ExecutionPlan> {
    return this.withRetry(async () => {
      const prompt = `Create execution plan (MAX ${maxSteps} steps) - JSON only:
{ ... (full prompt from gemini.ts) ... }
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
      // ... (rest of generatePlanOptimized from gemini.ts) ...
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
    // ... (implementation from gemini.ts) ...
  }

  async executeWithConfig(
    prompt: string,
    history: Array<{ role: string; parts: any[] }>,
    config: ExecutionConfig,
    onChunk?: (text: string) => void
  ): Promise<string> {
    return this.withRetry(async () => {
      // ... (implementation from gemini.ts) ...
    });
  }

  async synthesize(
    originalQuery: string,
    stepResults: Array<{ description: string; result: string }>,
    history: Array<{ role: string; parts: any[] }>
  ): Promise<string> {
    return this.withRetry(async () => {
      // ... (implementation from gemini.ts) ...
    });
  }

  // ===== NEW: Unified Autonomous Agent Method (from gemini.ts.txt) =====

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
    // MODIFIED: 'result: any' changed to 'result: null' as client can't execute
    toolCalls?: Array<{ tool: string; params: Record<string, any>; result: null }>;
    clarificationRequests?: string[];
}> {
    return this.withRetry(async () => {
      [cite_start]const contextStr = this.buildContextString(context);[span_1](end_span)
      [span_2](start_span)const prompt = this.promptBuilder.buildPrompt({[span_2](end_span)
        userRequest: context.userRequest,
        currentPhase: context.currentPhase,
        availableTools: context.availableTools,
        context: contextStr
      });

    let tools: Array<Record<string, unknown>> = [];
      const hasFiles = (context.files ?? []).length > 0;
      const hasUrls = (context.urlList ?? []).length > 0;

      [span_3](start_span)if (context.currentPhase === AgentPhase.EXECUTION) {[span_3](end_span)
        [span_4](start_span)if (context.availableTools.includes('search')) tools.push({ googleSearch: {} });[span_4](end_span)
        [span_5](start_span)if (context.availableTools.includes('file_analysis') && hasFiles) tools.push({ fileAnalysis: {} });[span_5](end_span)
        [span_6](start_span)if (context.availableTools.includes('code_execution')) tools.push({ codeExecution: {} });[span_6](end_span)
        [span_7](start_span)if (context.availableTools.includes('vision') && hasFiles) tools.push({ vision: {} });[span_7](end_span)
        [span_8](start_span)if (context.availableTools.includes('maps')) tools.push({ googleMaps: {} });[span_8](end_span)
        [span_9](start_span)if (context.availableTools.includes('url_context') && hasUrls) tools.push({ urlContext: {} });[span_9](end_span)
      }

      [span_10](start_span)const contents = this.buildContents(prompt, context.conversationHistory, context.files, context.urlList);[span_10](end_span)
      
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

      // --- MODIFIED & FIXED: This now correctly handles text AND tool calls ---
let fullResponse = '';
const phaseChanges: AgentPhase[] = [];
      const toolCalls: Array<{ tool: string; params: Record<string, any>; result: null }> = [];
const clarificationRequests: string[] = [];

      if (response && Symbol.asyncIterator in response) {
        for await (const chunk of response) {
          
          // NEW: Handle tool calls
          if (chunk.functionCalls && chunk.functionCalls.length > 0) {
            for (const call of chunk.functionCalls) {
              console.log(`[GeminiClient] Model requesting tool: ${call.name}`);
              toolCalls.push({ tool: call.name, params: call.args, result: null });
            }
          }

          // Handle text
          [span_11](start_span)const text = this.extractTextFromChunk(chunk);[span_11](end_span)
if (text) {
            fullResponse += text;
try {
              if (onChunk) onChunk(text);
} catch (e) {
              [span_12](start_span)console.warn('[GeminiClient] onChunk error:', e);[span_12](end_span)
}
            [span_13](start_span)this.parseAutonomousResponse(text, phaseChanges, toolCalls, clarificationRequests);[span_13](end_span)
}
        }
      }
      // --- End of FIX ---

      return {
        response: fullResponse,
        [span_14](start_span)phaseChanges: phaseChanges.length ? phaseChanges : undefined,[span_14](end_span)
        [span_15](start_span)toolCalls: toolCalls.length ? toolCalls : undefined,[span_15](end_span)
        [span_16](start_span)clarificationRequests: clarificationRequests.length ? clarificationRequests : undefined,[span_16](end_span)
      };
    });
  }

  private buildContextString(context: {
    [span_17](start_span)// ... (implementation from gemini.ts.txt) ... [cite: 109-114]
  }): string { /* ... */ }

  private parseAutonomousResponse(
    text: string,
    phaseChanges: AgentPhase[],
    [cite_start]toolCalls: Array<any>, // Already handled by the new loop, but original function included it[span_17](end_span)
    clarificationRequests: string[]
  ): void {
    [span_18](start_span)[span_19](start_span)// ... (implementation from gemini.ts.txt) ... [cite: 114-118]
  }
  
  // ===================================

  getCircuitBreakerStatus() {
    return this.circuitBreaker.getStatus();
  }
}

export default GeminiClient;
