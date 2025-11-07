// src/utils/geminiy.ts - Unified Autonomous Agent
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

  // ===== Unified Autonomous Agent Method =====

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
    toolCalls?: Array<{ tool: string; params: Record<string, any>; result: any }>;
    clarificationRequests?: string[];
  }> {
    return this.withRetry(async () => {
      // Build unified prompt using dynamic prompt builder
      const contextStr = this.buildContextString(context);
      const prompt = this.promptBuilder.buildPrompt({
        userRequest: context.userRequest,
        currentPhase: context.currentPhase,
        availableTools: context.availableTools,
        context: contextStr
      });

      // Determine tools based on phase and available resources
      let tools: Array<Record<string, unknown>> = [];
      const hasFiles = (context.files ?? []).length > 0;
      const hasUrls = (context.urlList ?? []).length > 0;

      // Configure tools based on current phase and needs
      if (context.currentPhase === AgentPhase.EXECUTION) {
        // In execution phase, enable all relevant tools
        if (context.availableTools.includes('search')) tools.push({ googleSearch: {} });
        if (context.availableTools.includes('file_analysis') && hasFiles) tools.push({ fileAnalysis: {} });
        if (context.availableTools.includes('code_execution')) tools.push({ codeExecution: {} });
        if (context.availableTools.includes('vision') && hasFiles) tools.push({ vision: {} });
        if (context.availableTools.includes('maps')) tools.push({ googleMaps: {} });
        if (context.availableTools.includes('url_context') && hasUrls) tools.push({ urlContext: {} });
      }

      // Build contents with context
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

      // Handle streaming response and extract structured information
      let fullResponse = '';
      const phaseChanges: AgentPhase[] = [];
      const toolCalls: Array<{ tool: string; params: Record<string, any>; result: any }> = [];
      const clarificationRequests: string[] = [];

      if (response && Symbol.asyncIterator in response) {
        for await (const chunk of response) {
          const text = this.extractTextFromChunk(chunk);
          if (text) {
            fullResponse += text;

            // Send chunk to callback
            try {
              if (onChunk) onChunk(text);
            } catch (e) {
              console.warn('[GeminiClient] onChunk error:', e);
            }

            // Parse for phase changes, tool calls, and clarifications
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

  private buildContextString(context: {
    conversationHistory: Array<{ role: string; parts: any[] }>;
    files?: FileMetadata[];
    urlList?: string[];
  }): string {
    const parts: string[] = [];

    if (context.files && context.files.length > 0) {
      parts.push(`${context.files.length} files available: ${context.files.map(f => f.name).join(', ')}`);
    }

    if (context.urlList && context.urlList.length > 0) {
      parts.push(`${context.urlList.length} URLs for context`);
    }

    if (context.conversationHistory && context.conversationHistory.length > 0) {
      parts.push(`Conversation history: ${context.conversationHistory.length} messages`);
    }

    return parts.join('; ') || 'No additional context';
  }

  private parseAutonomousResponse(
    text: string,
    phaseChanges: AgentPhase[],
    toolCalls: Array<{ tool: string; params: Record<string, any>; result: any }>,
    clarificationRequests: string[]
  ): void {
    // Simple parsing for phase changes
    const phaseKeywords = {
      [AgentPhase.ASSESSMENT]: ['assessing', 'analyzing', 'let me analyze'],
      [AgentPhase.PLANNING]: ['plan', 'planning', 'steps', 'approach'],
      [AgentPhase.EXECUTION]: ['executing', 'now i will', 'let me', 'searching', 'analyzing'],
      [AgentPhase.CLARIFICATION]: ['?', 'what', 'how', 'which', 'can you clarify'],
      [AgentPhase.COMPLETION]: ['complete', 'done', 'result', 'answer', 'summary']
    };

    for (const [phase, keywords] of Object.entries(phaseKeywords)) {
      if (keywords.some(keyword => text.toLowerCase().includes(keyword))) {
        if (!phaseChanges.includes(phase as AgentPhase)) {
          phaseChanges.push(phase as AgentPhase);
        }
      }
    }

    // Simple parsing for clarification questions
    if (text.includes('?') && (text.toLowerCase().includes('what') ||
        text.toLowerCase().includes('how') ||
        text.toLowerCase().includes('which') ||
        text.toLowerCase().includes('clarify'))) {
      clarificationRequests.push(text.trim());
    }
  }

  // ===== Legacy methods removed - unified approach uses executeUnifiedAutonomous =====

  getCircuitBreakerStatus() {
    return this.circuitBreaker.getStatus();
  }
}

export default GeminiClient;
