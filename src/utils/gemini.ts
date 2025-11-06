// src/utils/gemini.ts
import { GoogleGenAI } from '@google/genai';
import type { TaskComplexity, ExecutionPlan, FileMetadata } from '../types';
import type { ExecutionConfig } from '../tools';

/**
 * GeminiClient - GenAI wrapper (genai@0.28.0) with:
 * - files upload/get/delete
 * - streaming support (async iterator / reader / fallback)
 * - dynamic tools mapping per action
 * - thinkingConfig budgets
 * - executeWithConfig supports streaming via onChunk callback
 */
export class GeminiClient {
  private ai: ReturnType<typeof GoogleGenAI>;
  private maxRetries = 3;
  private baseBackoff = 1000;
  private defaultTimeoutMs = 60_000;

  constructor(opts?: { apiKey?: string }) {
    this.ai = new GoogleGenAI({ apiKey: opts?.apiKey });
  }

  // ----- Utilities -----
  private parse<T>(text: string): T | null {
    try {
      if (!text) return null;
      const trimmed = (text as string).trim().replace(/^```json\s*/, '').replace(/```$/, '');
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
        return await fn();
      } catch (err) {
        lastErr = err;
        if (i < this.maxRetries - 1) {
          const delay = this.baseBackoff * (2 ** i);
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
    ]) as Promise<T>;
  }

  // ----- Files API -----
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
        state: meta.state as any,
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

  // ----- Action -> Tools mapping -----
  // Map a plan step action to the tools that should be enabled for that step.
  private mapActionToTools(action: string | undefined): Array<Record<string, unknown>> {
    // default mappings - extend as needed
    const mapping: Record<string, Array<Record<string, unknown>>> = {
      search: [{ googleSearch: {} }],
      code_execute: [{ codeExecution: {} }],
      code: [{ codeExecution: {} }],
      file_analysis: [{ fileAnalysis: {} }],
      file: [{ fileAnalysis: {} }],
      vision_analysis: [{ vision: {} }],
      vision: [{ vision: {} }],
      maps: [{ googleMaps: {} }],
      url_context: [{ urlContext: {} }],
      computer: [{ computerUse: {} }],
      synthesize: [], // no tools required
      analyze: [], // pure reasoning
    };

    if (!action) return [];
    const key = action.toLowerCase().trim();
    return mapping[key] ?? [];
  }

  // ----- Build contents (history, files, urls, prompt) -----
  private buildContents(
    prompt: string,
    history?: Array<{ role: string; parts: any[] }>,
    files?: FileMetadata[],
    urlList?: string[]
  ) {
    const contents: any[] = [];

    // include history messages as content entries (if provided)
    if (history && history.length) {
      for (const msg of history) {
        contents.push({ role: msg.role, parts: msg.parts });
      }
    }

    // include file parts (if present)
    if (files && files.length) {
      const fileParts = files
        .filter((f) => f && f.state === 'ACTIVE' && f.fileUri)
        .map((f) => ({ file_data: { mime_type: f.mimeType, file_uri: f.fileUri } }));
      if (fileParts.length) contents.push({ parts: fileParts });
    }

    // include URL context parts
    if (urlList && urlList.length) {
      const urlParts = urlList.map((u) => ({ url: u }));
      contents.push({ parts: urlParts });
    }

    // finally add the user prompt text
    contents.push({ parts: [{ text: prompt }] });

    return contents;
  }

  // ----- Streaming helper -----
  /**
   * Handles streaming responses from genai models:
   * - async iterator (chunked object stream)
   * - .reader() ReadableStream (Cloudflare Worker style)
   * - fallback to single response
   *
   * Calls onChunk for each text chunk and returns the concatenated text.
   */
  private async handleStreamedResponse(
    streamResp: any,
    onChunk?: (text: string) => void
  ): Promise<string> {
    let full = '';

    // If the SDK returned an async iterable (generator)
    if (streamResp && typeof streamResp[Symbol.asyncIterator] === 'function') {
      for await (const evt of streamResp as AsyncIterable<any>) {
        // many SDK chunks include .text or .delta or .candidates
        const txt = (evt?.text ?? evt?.delta ?? '') as string;
        if (txt) {
          full += txt;
          try { if (onChunk) onChunk(txt); } catch (e) { /* swallow onChunk errors */ }
        }
      }
      return full;
    }

    // If the SDK returned an object with a reader (ReadableStream from Worker)
    if (streamResp && typeof streamResp.reader === 'object') {
      const reader = streamResp.reader;
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const txt = dec.decode(value, { stream: true });
        if (txt) {
          full += txt;
          try { if (onChunk) onChunk(txt); } catch (e) { /* swallow */ }
        }
      }
      return full;
    }

    // If the SDK returned a promise-like response (non-stream)
    try {
      const res = await streamResp;
      // response objects sometimes expose .text or .response.text()
      const text = (res?.text ?? (res?.response && typeof res.response.text === 'function' ? await res.response.text() : undefined)) as string | undefined;
      const txt = text ?? '';
      if (txt) {
        full += txt;
        try { if (onChunk) onChunk(txt); } catch (e) { /* swallow */ }
      }
      return full;
    } catch (e) {
      // Last resort: try to read .response candidates
      try {
        const maybeText = (streamResp?.response?.text && await streamResp.response.text()) ?? '';
        if (maybeText) {
          full += maybeText;
          if (onChunk) onChunk(maybeText);
        }
      } catch (_) { /* noop */ }
    }

    return full;
  }

  // ----- Complexity analysis -----
  async analyzeComplexity(query: string, hasFiles = false): Promise<TaskComplexity> {
    return this.withRetry(async () => {
      const prompt = `Analyze this request and return JSON only:
{
  "type": "simple" | "complex",
  "requiredTools": string[],
  "estimatedSteps": number,
  "reasoning": "brief explanation",
  "requiresFiles": boolean,
  "requiresCode": boolean,
  "requiresVision": boolean
}

Available tools: search, code_execution, file_analysis, vision, data_analysis

Rules:
- "simple": Single-step queries, direct questions, basic requests without files
- "complex": Multi-step tasks, research, analysis, file processing, code execution

Context: User ${hasFiles ? 'HAS uploaded files' : 'has NOT uploaded files'}

Request: ${query}`;

      const resp = await this.withTimeout(
        this.ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
          config: { thinkingConfig: { thinkingBudget: 1024 } }, // moderate budget
        }),
        'analyzeComplexity timed out'
      );

      // attempt to extract text
      const text = (resp?.text ?? '') as string;
      const parsed = this.parse<TaskComplexity>(text);
      if (parsed) return parsed;

      // fallback
      return {
        type: 'simple',
        requiredTools: [],
        estimatedSteps: 1,
        reasoning: 'fallback - could not parse model JSON',
        requiresFiles: hasFiles,
        requiresCode: false,
        requiresVision: false,
      } as TaskComplexity;
    });
  }

  // ----- Plan generation -----
  async generatePlan(query: string, complexity: TaskComplexity, hasFiles: boolean): Promise<ExecutionPlan> {
    return this.withRetry(async () => {
      const prompt = `Create a detailed execution plan with sections as JSON:
{
  "sections": [
    {
      "name": "Research & Setup" | "Planning" | "Implementation" | "Analysis" | "Verification",
      "description": "Brief description",
      "steps": [
        {
          "id": "step_1",
          "description": "Specific action to take",
          "action": "search|research|code_execute|file_analysis|vision_analysis|data_analysis|analyze|synthesize"
        }
      ]
    }
  ]
}

Context:
- User ${hasFiles ? 'HAS uploaded files' : 'has NOT uploaded files'}
- Complexity: ${JSON.stringify(complexity)}

Create sections in logical order: Research → Planning → Implementation → Analysis → Verification

Request: ${query}`;

      const resp = await this.withTimeout(
        this.ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
          config: { thinkingConfig: { thinkingBudget: 2048 } }, // larger budget for planning
        }),
        'generatePlan timed out'
      );

      const text = (resp?.text ?? '') as string;
      const parsed = this.parse<{ sections: any[] }>(text);
      if (!parsed || !parsed.sections) {
        return {
          steps: [{ id: 'step_1', description: 'Answer the query directly', action: 'synthesize', status: 'pending' }],
          sections: [{ name: 'Execution', description: 'Direct response', steps: [], status: 'pending' }],
          currentStepIndex: 0,
          status: 'executing',
          createdAt: Date.now(),
        } as ExecutionPlan;
      }

      // flatten steps across sections
      const allSteps: any[] = [];
      const sections = parsed.sections.map((section: any) => {
        const ssteps = (section.steps || []).map((s: any) => {
          const step = {
            id: s.id ?? `step_${allSteps.length + 1}`,
            description: s.description ?? 'Step',
            action: s.action ?? 'analyze',
            status: 'pending' as const,
            section: section.name,
          };
          allSteps.push(step);
          return step;
        });
        return { name: section.name, description: section.description ?? '', steps: ssteps, status: 'pending' as const };
      });

      return {
        steps: allSteps,
        sections,
        currentStepIndex: 0,
        status: 'executing',
        createdAt: Date.now(),
      } as ExecutionPlan;
    });
  }

  // ----- Streamed response (simple chat or streaming-enabled calls) -----
  /**
   * streamResponse: convenience wrapper to stream a plain query + history
   * Calls onChunk for each text fragment and returns concatenated text.
   */
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
        thinkingConfig: opts?.thinkingConfig ?? { thinkingBudget: 1024 },
        stream: true,
      },
    } as any);

    // The SDK can return an async iterable or a stream object - handle both
    const full = await this.handleStreamedResponse(streamCall, onChunk);
    return full;
  }

  // ----- executeWithConfig (dynamic tools, supports streaming via onChunk) -----
  /**
   * executeWithConfig:
   * - prompt: the prompt text
   * - history: prior messages
   * - config: ExecutionConfig - expected fields:
   *     files?: FileMetadata[]
   *     urlList?: string[]
   *     useSearch?: boolean
   *     useCodeExecution?: boolean
   *     useMapsGrounding?: boolean
   *     useUrlContext?: boolean
   *     allowComputerUse?: boolean
   *     thinkingConfig?: object
   *     model?: string
   *     stream?: boolean
   *     timeoutMs?: number
   * - onChunk?: callback invoked per streamed chunk
   *
   * Returns concatenated text result.
   */
  async executeWithConfig(
    prompt: string,
    history: Array<{ role: string; parts: any[] }>,
    config: ExecutionConfig,
    onChunk?: (text: string) => void
  ): Promise<string> {
    return this.withRetry(async () => {
      // Build tools list:
      let tools: Array<Record<string, unknown>> = [];

      // Prefer dynamic mapping per planned action: if config.stepAction specified, map accordingly.
      // Otherwise, fall back to booleans.
      if ((config as any).stepAction) {
        tools = this.mapActionToTools((config as any).stepAction);
      } else {
        if (config.useSearch) tools.push({ googleSearch: {} });
        if (config.useCodeExecution) tools.push({ codeExecution: {} });
        if (config.useMapsGrounding) tools.push({ googleMaps: {} });
        if (config.useUrlContext && config.urlList && config.urlList.length) tools.push({ urlContext: {} });
        if (config.allowComputerUse) tools.push({ computerUse: {} });
        if (config.files && config.files.length) tools.push({ fileAnalysis: {} }); // allow file analysis if files supplied
        // vision not automatically added - only enable if stepAction or caller sets it in config
        if ((config as any).useVision) tools.push({ vision: {} });
      }

      const contents = this.buildContents(prompt, history, config.files ?? [], config.urlList ?? []);

      const call = this.ai.models.generateContent({
        model: config.model ?? 'gemini-2.5-flash',
        contents,
        config: {
          thinkingConfig: config.thinkingConfig ?? { thinkingBudget: 1024 },
          tools: tools.length ? tools : undefined,
          stream: config.stream === true,
        },
      } as any);

      // If streaming requested, use streaming handler
      if (config.stream === true) {
        const streamed = await this.handleStreamedResponse(call, onChunk);
        return streamed;
      }

      // Non-streaming: await final response
      const resp = await this.withTimeout(call, 'executeWithConfig timed out', config.timeoutMs);
      const text = (resp?.text ?? '') as string;
      return text ?? '[no-result]';
    });
  }

  // ----- Synthesis -----
  async synthesize(
    originalQuery: string,
    stepResults: Array<{ description: string; result: string }>,
    history: Array<{ role: string; parts: any[] }>
  ): Promise<string> {
    return this.withRetry(async () => {
      const prompt = `Original Request: ${originalQuery}

Step Results:
${stepResults.map((s, i) => `Step ${i + 1} - ${s.description}:\n${s.result}`).join('\n\n')}

Task: Synthesize these results into a comprehensive, well-structured answer. Be clear, detailed, and directly address the original request.`;

      const resp = await this.withTimeout(
        this.ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
          config: { thinkingConfig: { thinkingBudget: 2048 } },
        }),
        'synthesize timed out'
      );

      const text = (resp?.text ?? '') as string;
      return text ?? '[no-answer]';
    });
  }
}

export default GeminiClient;
