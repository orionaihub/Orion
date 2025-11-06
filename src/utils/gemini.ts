// src/utils/gemini.ts - Unified Autonomous Agent
import { GoogleGenAI } from '@google/genai';
import type { FileMetadata, AutonomousMode, AgentPhase } from '../types';

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

  private onSuccess(): void {
    this.failures = 0;
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
  }

  private reset(): void {
    this.failures = 0;
  }

  getStatus(): { failures: number; isOpen: boolean } {
    return {
      failures: this.failures,
      isOpen: this.isOpen(),
    };
  }
}

// Dynamic Prompt Builder for Modular Assembly
class DynamicPromptBuilder {
  private readonly BASE_AUTONOMOUS_PROMPT = `
You are an autonomous AI agent with full decision-making authority. You operate independently to analyze, plan, execute, and complete user requests.

## Your Capabilities
- Native tools: thinking, search grounding, URL context, code execution
- External tools: via function calling (search, file analysis, vision, maps, etc.)
- Full autonomy: make decisions independently, adapt plans freely

## Workflow Phases

### 1. ASSESSMENT PHASE
- Analyze user request thoroughly
- Determine if clarification needed (proactively engage when beneficial)
- Decide between CHAT mode (single-step native tools) vs EXECUTION mode (multi-step with external tools)
- Set clear objectives, constraints, and expected outcomes

### 2. PLANNING PHASE (EXECUTION mode only)
- Create explicit step-by-step plan and display to user
- Explain your reasoning and approach
- Be ready to adapt plan based on user feedback or execution discoveries

### 3. EXECUTION PHASE
- Execute plan steps using appropriate tools (native + function calling)
- Adapt freely based on results and insights
- Provide natural language explanations of progress
- Use function calls for external tools, native tools for direct capabilities

### 4. CLARIFICATION PHASE (as needed)
- Engage user proactively when clarification would be beneficial
- Ask specific, targeted questions
- Continue until clear understanding achieved

### 5. COMPLETION PHASE
- Deliver comprehensive final response
- Summarize execution process and results
- Provide value-added insights when appropriate

## Response Format
- Natural language explanations of what you're doing
- Progress tracking updates
- Function calls for external tools (when needed)
- Never use structured JSON - respond conversationally
- Use thinking tool for complex reasoning

## Decision-Making Guidelines
- Prioritize user value and successful outcomes
- Adapt plans when better approaches emerge
- Be proactive about clarifications when user might not know what's needed
- Use minimal steps for simple tasks, thorough approach for complex ones
- Always explain your reasoning clearly
`;

  private readonly PHASE_MODULES = new Map<AgentPhase, string>([
    [AgentPhase.ASSESSMENT, `
## Current Phase: ASSESSMENT
- Analyze the user's request: {{USER_REQUEST}}
- Consider context: {{CONTEXT}}
- Determine complexity and appropriate mode (CHAT vs EXECUTION)
- Identify any ambiguities or missing information
- Decide if clarification is needed proactively
- If request is simple and can be handled in one turn with native tools, stay in CHAT mode
- If request is complex or requires external tools, transition to PLANNING phase in EXECUTION mode
`],
    [AgentPhase.PLANNING, `
## Current Phase: PLANNING
- Create a clear, explicit step-by-step plan for EXECUTION mode
- Display the plan to the user with explanations
- Consider all available tools and resources
- Estimate what can be accomplished in each step
- Be ready to adapt based on user feedback
`],
    [AgentPhase.EXECUTION, `
## Current Phase: EXECUTION
- Execute the plan step by step
- Use appropriate tools (native + function calling)
- Provide natural language progress updates
- Adapt freely based on results and new insights
- Modify plan if better approaches emerge
- Use function calls for external tools when needed
`],
    [AgentPhase.CLARIFICATION, `
## Current Phase: CLARIFICATION
- Ask targeted questions to understand the user's needs better
- Be specific about what information would help
- Guide user toward providing necessary details
- Continue clarification until clear understanding achieved
`],
    [AgentPhase.COMPLETION, `
## Current Phase: COMPLETION
- Provide comprehensive final response
- Summarize what was accomplished
- Share key insights and findings
- Deliver the value the user was seeking
`]
  ]);

  private readonly CONTEXT_MODULES = new Map<string, string>([
    ['fileHandling', `
## File Processing Context
- You have access to uploaded files that may contain important data
- Use file analysis tools to extract and understand file contents
- Consider file types (documents, images, data files) when planning approach
`],
    ['complexExecution', `
## Complex Task Execution
- This request requires multiple steps and careful planning
- Break down the task into manageable components
- Use external tools via function calling when needed
- Provide clear progress updates throughout execution
`],
    ['searchRequired', `
## Search and Research Context
- This request requires current information from external sources
- Use search tools to gather relevant and up-to-date information
- Synthesize findings into coherent insights
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

    // Add phase-specific instructions
    const phaseModule = this.PHASE_MODULES.get(context.currentPhase);
    if (phaseModule) {
      prompt += phaseModule.replace('{{USER_REQUEST}}', context.userRequest)
                        .replace('{{CONTEXT}}', context.context);
    }

    // Add context-specific guidance based on available resources
    if (context.context.includes('files') && context.context.includes('file data')) {
      prompt += this.CONTEXT_MODULES.get('fileHandling') || '';
    }

    if (context.availableTools.includes('search') || context.availableTools.includes('googleSearch')) {
      prompt += this.CONTEXT_MODULES.get('searchRequired') || '';
    }

    if (context.currentPhase === AgentPhase.EXECUTION && context.availableTools.length > 2) {
      prompt += this.CONTEXT_MODULES.get('complexExecution') || '';
    }

    // Add current state information
    prompt += `\n\n## Current State
User Request: ${context.userRequest}
Current Phase: ${context.currentPhase}
Available Tools: ${context.availableTools.join(', ') || 'native tools only'}
Context: ${context.context}

Begin your autonomous process.\n`;

    return prompt;
  }
}

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
    file_analysis: {
      tools: [{ fileAnalysis: {} }],
      requiresFiles: true,
    },
    file: {
      tools: [{ fileAnalysis: {} }],
      requiresFiles: true,
    },
    vision_analysis: { tools: [{ vision: {} }] },
    vision: { tools: [{ vision: {} }] },
    maps: { tools: [{ googleMaps: {} }] },
    url_context: {
      tools: [{ urlContext: {} }],
      requiresUrls: true,
    },
    url_analysis: {
      tools: [{ urlContext: {} }],
      requiresUrls: true,
    },
    computer: { tools: [{ computerUse: {} }] },
    data_analysis: { tools: [{ codeExecution: {} }] },
    synthesize: { tools: [] },
    analyze: { tools: [] },
  };

  constructor(opts?: { apiKey?: string }) {
    this.ai = new GoogleGenAI({ apiKey: opts?.apiKey });
  }

  private parse<T>(text: string): T | null {
    try {
      if (!text) return null;
      const trimmed = text.trim().replace(/^```json\s*/, '').replace(/```$/, '');
      if (!trimmed) return null;
      return JSON.parse(trimmed) as T;
    } catch (e) {
      console.warn('[GeminiClient] JSON parse failed', e);
      return null;
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: any;
    for (let i = 0; i < this.maxRetries; i++) {
      try {
        return await this.circuitBreaker.execute(fn);
      } catch (err) {
        lastErr = err;
        if (i < this.maxRetries - 1) {
          const delay = this.baseBackoff * 2 ** i;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastErr;
  }

  private async withTimeout<T>(promise: Promise<T>, errorMsg = 'timeout', ms?: number): Promise<T> {
    const tm = ms ?? this.defaultTimeoutMs;
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(errorMsg)), tm)),
    ]);
  }

  // ===== Files API =====

  async uploadFile(fileDataBase64: string, mimeType: string, displayName: string): Promise<FileMetadata> {
    return this.withRetry(async () => {
      const buffer = Buffer.from(fileDataBase64, 'base64');
      const uploadResp = await this.withTimeout(
        this.ai.files.upload({ file: buffer as any, config: { mimeType, displayName } }),
        'uploadFile timed out'
      );
      const name = uploadResp.name;
      const meta = await this.ai.files.get({ name });
      return {
        fileUri: meta.uri,
        mimeType: meta.mimeType,
        name: meta.displayName ?? displayName,
        sizeBytes: meta.sizeBytes ?? buffer.length,
        uploadedAt: Date.now(),
        state: (meta.state as any) ?? 'ACTIVE',
        expiresAt: meta.expirationTime ? new Date(meta.expirationTime).getTime() : undefined,
      } as FileMetadata;
    });
  }

  async getFileStatus(fileUriOrName: string): Promise<string> {
    try {
      const name = fileUriOrName.split('/').pop() ?? fileUriOrName;
      const meta = await this.ai.files.get({ name });
      return meta.state ?? 'UNKNOWN';
    } catch (e) {
      console.warn('[GeminiClient] getFileStatus failed', e);
      return 'FAILED';
    }
  }

  async deleteFile(fileUriOrName: string): Promise<void> {
    try {
      const name = fileUriOrName.split('/').pop() ?? fileUriOrName;
      await this.ai.files.delete({ name });
    } catch (e) {
      console.warn('[GeminiClient] deleteFile failed', e);
    }
  }

  private mapActionToTools(
    action: string | undefined,
    context: { hasFiles: boolean; hasUrls: boolean }
  ): Array<Record<string, unknown>> {
    if (!action) return [];

    const key = action.toLowerCase().trim();
    const config = this.ACTION_TOOL_MAP[key];

    if (!config) {
      console.warn(`[GeminiClient] Unknown action: ${action}`);
      return [];
    }

    if (config.requiresFiles && !context.hasFiles) {
      console.warn(`[GeminiClient] Action ${action} requires files but none available`);
      return [];
    }

    if (config.requiresUrls && !context.hasUrls) {
      console.warn(`[GeminiClient] Action ${action} requires URLs but none available`);
      return [];
    }

    return config.tools;
  }

  private buildContents(
    prompt: string,
    history?: Array<{ role: string; parts: any[] }>,
    files?: FileMetadata[],
    urlList?: string[]
  ): any[] {
    const contents: any[] = [];

    if (history && history.length) {
      for (const msg of history) {
        contents.push({ role: msg.role, parts: msg.parts });
      }
    }

    if (files && files.length) {
      const fileParts = files
        .filter((f) => f && f.state === 'ACTIVE' && f.fileUri)
        .map((f) => ({
          file_data: { mime_type: f.mimeType, file_uri: f.fileUri },
        }));
      if (fileParts.length) {
        contents.push({ parts: fileParts });
      }
    }

    if (urlList && urlList.length) {
      const urlParts = urlList.map((u) => ({ url: u }));
      contents.push({ parts: urlParts });
    }

    contents.push({ parts: [{ text: prompt }] });

    return contents;
  }

  private extractTextFromChunk(chunk: any): string {
    return chunk?.text ?? chunk?.delta ?? chunk?.content?.text ?? '';
  }

  private async extractTextFromResponse(response: any): Promise<string> {
    if (typeof response?.text === 'string') return response.text;
    if (typeof response?.text === 'function') return await response.text();
    if (response?.response?.text) {
      return typeof response.response.text === 'function'
        ? await response.response.text()
        : response.response.text;
    }
    return '';
  }

  private async readFromStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    onChunk?: (text: string) => void
  ): Promise<string> {
    let full = '';
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      if (text) {
        full += text;
        try {
          if (onChunk) onChunk(text);
        } catch (e) {
          console.warn('[GeminiClient] onChunk error:', e);
        }
      }
    }

    return full;
  }

  private async handleStreamedResponse(streamResp: any, onChunk?: (text: string) => void): Promise<string> {
    let full = '';

    try {
      if (streamResp && Symbol.asyncIterator in streamResp) {
        for await (const chunk of streamResp) {
          const text = this.extractTextFromChunk(chunk);
          if (text) {
            full += text;
            try {
              if (onChunk) onChunk(text);
            } catch (e) {
              console.warn('[GeminiClient] onChunk error:', e);
            }
          }
        }
        return full;
      }

      if (streamResp?.reader) {
        return await this.readFromStream(streamResp.reader, onChunk);
      }

      const result = await Promise.resolve(streamResp);
      const text = await this.extractTextFromResponse(result);
      if (text) {
        full = text;
        try {
          if (onChunk) onChunk(text);
        } catch (e) {
          console.warn('[GeminiClient] onChunk error:', e);
        }
      }

      return full;
    } catch (e) {
      console.error('[GeminiClient] Stream handling failed:', e);
      throw e;
    }
  }

  async analyzeComplexity(query: string, hasFiles = false): Promise<TaskComplexity> {
    return this.withRetry(async () => {
      const prompt = `Analyze request complexity - respond with JSON only:
{
  "type": "simple" | "complex",
  "requiredTools": string[],
  "estimatedSteps": number,
  "reasoning": "brief",
  "requiresFiles": boolean,
  "requiresCode": boolean,
  "requiresVision": boolean
}

Rules:
- simple: greetings, basic questions, single-step tasks
- complex: research, multi-step analysis, file processing

Files: ${hasFiles ? 'YES' : 'NO'}
Query: ${query}`;

      const resp = await this.withTimeout(
        this.ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
          config: { thinkingConfig: { thinkingBudget: 512 } }, // Reduced budget
        }),
        'analyzeComplexity timed out',
        30_000 // 30s timeout
      );

      const text = (resp?.text ?? '') as string;
      const parsed = this.parse<TaskComplexity>(text);
      if (parsed) return parsed;

      return {
        type: 'simple',
        requiredTools: [],
        estimatedSteps: 1,
        reasoning: 'fallback',
        requiresFiles: hasFiles,
        requiresCode: false,
        requiresVision: false,
      } as TaskComplexity;
    });
  }

  // NEW: Optimized plan generation with step limit
  async generatePlanOptimized(
    query: string,
    complexity: TaskComplexity,
    hasFiles: boolean,
    maxSteps: number = 5
  ): Promise<ExecutionPlan> {
    return this.withRetry(async () => {
      const prompt = `Create execution plan (MAX ${maxSteps} steps) - JSON only:
{
  "steps": [
    {
      "id": "s1",
      "description": "concise action",
      "action": "search|code_execute|file_analysis|analyze|synthesize"
    }
  ]
}

Rules:
- Keep steps minimal and focused
- Combine related actions
- Use "search" for research, "analyze" for thinking, "synthesize" for final answer
- MAX ${maxSteps} steps total

Context: ${hasFiles ? 'Has files' : 'No files'}
Tools needed: ${complexity.requiredTools.join(', ') || 'none'}

Query: ${query}`;

      const resp = await this.withTimeout(
        this.ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
          config: { thinkingConfig: { thinkingBudget: 1024 } }, // Reduced budget
        }),
        'generatePlan timed out',
        30_000 // 30s timeout
      );

      const text = (resp?.text ?? '') as string;
      const parsed = this.parse<{ steps: any[] }>(text);

      if (!parsed || !parsed.steps) {
        return {
          steps: [
            {
              id: 's1',
              description: 'Provide direct answer',
              action: 'synthesize',
              status: 'pending',
            },
          ],
          currentStepIndex: 0,
          status: 'executing',
          createdAt: Date.now(),
        } as ExecutionPlan;
      }

      // Limit steps to maxSteps
      const limitedSteps = parsed.steps.slice(0, maxSteps).map((s: any, i: number) => ({
        id: s.id ?? `s${i + 1}`,
        description: s.description ?? 'Step',
        action: s.action ?? 'analyze',
        status: 'pending' as const,
      }));

      return {
        steps: limitedSteps,
        currentStepIndex: 0,
        status: 'executing',
        createdAt: Date.now(),
      } as ExecutionPlan;
    });
  }

  // Keep original for backward compatibility
  async generatePlan(query: string, complexity: TaskComplexity, hasFiles: boolean): Promise<ExecutionPlan> {
    return this.generatePlanOptimized(query, complexity, hasFiles, 8); // Default 8 steps
  }

  async streamResponse(
    query: string,
    history: Array<{ role: string; parts: any[] }>,
    onChunk?: (text: string) => void,
    opts?: { model?: string; thinkingConfig?: any; timeoutMs?: number }
  ): Promise<string> {
    const modelName = opts?.model ?? 'gemini-2.5-flash';
    const contents = this.buildContents(query, history);

    const streamCall = this.ai.models.generateContent({
      model: modelName,
      contents,
      config: {
        thinkingConfig: opts?.thinkingConfig ?? { thinkingBudget: 512 }, // Reduced default
        stream: true,
      },
    } as any);

    return await this.handleStreamedResponse(streamCall, onChunk);
  }

  async executeWithConfig(
    prompt: string,
    history: Array<{ role: string; parts: any[] }>,
    config: ExecutionConfig,
    onChunk?: (text: string) => void
  ): Promise<string> {
    return this.withRetry(async () => {
      let tools: Array<Record<string, unknown>> = [];

      const hasFiles = (config.files ?? []).length > 0;
      const hasUrls = (config.urlList ?? []).length > 0;

      if (config.stepAction) {
        tools = this.mapActionToTools(config.stepAction, { hasFiles, hasUrls });
      } else {
        if (config.useSearch) tools.push({ googleSearch: {} });
        if (config.useCodeExecution) tools.push({ codeExecution: {} });
        if (config.useMapsGrounding) tools.push({ googleMaps: {} });
        if (config.useUrlContext && hasUrls) tools.push({ urlContext: {} });
        if (config.allowComputerUse) tools.push({ computerUse: {} });
        if (hasFiles) tools.push({ fileAnalysis: {} });
        if (config.useVision) tools.push({ vision: {} });
      }

      const contents = this.buildContents(prompt, history, config.files ?? [], config.urlList ?? []);

      const call = this.ai.models.generateContent({
        model: config.model ?? 'gemini-2.5-flash',
        contents,
        config: {
          thinkingConfig: config.thinkingConfig ?? { thinkingBudget: 512 }, // Reduced default
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
      const prompt = `Request: ${originalQuery}

Results:
${stepResults.map((s, i) => `${i + 1}. ${s.description}: ${s.result.substring(0, 300)}`).join('\n')}

Provide comprehensive answer:`;

      const resp = await this.withTimeout(
        this.ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
          config: { thinkingConfig: { thinkingBudget: 1024 } },
        }),
        'synthesize timed out',
        45_000 // 45s timeout
      );

      const text = (resp?.text ?? '') as string;
      return text || '[no-answer]';
    });
  }

  getCircuitBreakerStatus() {
    return this.circuitBreaker.getStatus();
  }
}

export default GeminiClient;
