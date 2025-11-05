// src/utils/gemini.ts
import { GoogleGenAI } from '@google/genai';
import type { TaskComplexity, ExecutionPlan, FileMetadata } from '../types';
import type { ExecutionConfig } from '../tools';

/**
 * GeminiClient - wrapper around @google/genai (GenAI) client exposing:
 * - thinking budgets
 * - files upload / get / delete
 * - grounding (google search, maps)
 * - code execution
 * - url context
 * - computer-use style functionality
 *
 * This implementation follows the JS examples in the official Gemini docs.
 * See: Gemini thinking, Files API, Grounding with Google Search, Code execution, URL context.
 */
export class GeminiClient {
  private ai: ReturnType<typeof GoogleGenAI>;
  private maxRetries = 3;
  private baseBackoff = 1000;
  // default per-call timeout ms (can be adjusted)
  private timeout = 60_000;

  constructor(opts?: { apiKey?: string; defaultModel?: string }) {
    // Create client - pass options if required by your runtime env (API key via env usually)
    this.ai = new GoogleGenAI(opts || {});
  }

  /** Utility: parse JSON returned in model text safely */
  private parse<T>(text: string): T | null {
    try {
      const trimmed = text?.trim?.();
      if (!trimmed) return null;
      // remove ```json fences if present
      const cleaned = trimmed.replace(/^```json\s*/, '').replace(/```$/, '');
      return JSON.parse(cleaned) as T;
    } catch (e) {
      console.warn('[GeminiClient] JSON parse failed', e);
      return null;
    }
  }

  /** Retry wrapper */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: any = null;
    for (let i = 0; i < this.maxRetries; i++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (i === this.maxRetries - 1) break;
        const delay = this.baseBackoff * Math.pow(2, i);
        await new Promise((res) => setTimeout(res, delay));
      }
    }
    throw lastError;
  }

  /** Timeout wrapper */
  private async withTimeout<T>(promise: Promise<T>, errorMessage = 'timed out', ms?: number): Promise<T> {
    const t = ms ?? this.timeout;
    return Promise.race([
      promise,
      new Promise<T>((_, rej) => setTimeout(() => rej(new Error(errorMessage)), t)),
    ]) as Promise<T>;
  }

  // ------------------------
  // Files (Files API) - upload, get status, delete
  // (uses ai.files.upload / ai.files.get / ai.files.delete as in the docs)
  // ------------------------

  /**
   * Upload base64 file data and return metadata
   * - fileData: base64-encoded file bytes
   * - mimeType: "application/pdf" | "image/png" | ...
   * - displayName: file name to use
   */
  async uploadFile(fileDataBase64: string, mimeType: string, displayName: string): Promise<FileMetadata> {
    return this.withRetry(async () => {
      // Convert to a temporary buffer or a file path depending on env.
      // GenAI JS client accepts a local path string or a Blob/Buffer depending on runtime.
      // Here we create a Buffer and pass as `file` (Node.js).
      const buffer = Buffer.from(fileDataBase64, 'base64');

      // NOTE: The GenAI client expects a "file" param. The docs show using:
      // ai.files.upload({ file: "path/to/file", config: { mimeType } })
      // In Node we can pass a Buffer; some runtimes want a path or stream.
      // If your runtime doesn't accept Buffer directly, write to a temp file and pass the path.
      const uploadResult = await this.withTimeout(
        this.ai.files.upload({
          file: buffer as any,
          config: { mimeType, displayName },
        }),
        'File upload timed out'
      );

      // fetch metadata
      const name = uploadResult.name;
      const fetched = await this.ai.files.get({ name });

      return {
        fileUri: fetched.uri,
        mimeType: fetched.mimeType,
        name: fetched.displayName ?? displayName,
        sizeBytes: fetched.sizeBytes ?? buffer.length,
        uploadedAt: Date.now(),
        state: fetched.state as any,
        expiresAt: fetched.expirationTime ? new Date(fetched.expirationTime).getTime() : undefined,
      } as FileMetadata;
    });
  }

  /**
   * Get file status (state) by fileUri or name
   */
  async getFileStatus(fileUriOrName: string): Promise<string> {
    try {
      // API expects name (the file name returned by upload). If given a full uri, extract last segment.
      const name = fileUriOrName.split('/').pop() ?? fileUriOrName;
      const res = await this.ai.files.get({ name });
      return res.state ?? 'UNKNOWN';
    } catch (e) {
      console.warn('[GeminiClient] getFileStatus failed', e);
      return 'FAILED';
    }
  }

  /**
   * Delete uploaded file (no throw)
   */
  async deleteFile(fileUriOrName: string): Promise<void> {
    try {
      const name = fileUriOrName.split('/').pop() ?? fileUriOrName;
      await this.ai.files.delete({ name });
    } catch (e) {
      console.warn('[GeminiClient] deleteFile failed', e);
    }
  }

  // ------------------------
  // Complexity analysis (uses thinking-enabled model and structured JSON)
  // ------------------------
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
- Set requiresFiles=true if user mentions files, documents, data, or analysis
- Set requiresCode=true if task needs calculations, data processing, or programming
- Set requiresVision=true if task involves images or visual content

Context: User ${hasFiles ? 'HAS uploaded files' : 'has NOT uploaded files'}

Request: ${query}`;

      const res = await this.withTimeout(
        this.ai.models.generateContent({
          model: 'gemini-2.5-flash', // use 2.5 capable model for thinking ideally "gemini-2.5-flash" or "gemini-2.5-flash-lite"
          contents: prompt,
          // small thinking budget example - you may customize or expose as param
          config: {
            thinkingConfig: { thinkingBudget: 1024 },
          },
        }),
        'Complexity analysis timed out'
      );

      const text = res?.text ?? '';
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

  // ------------------------
  // Plan generation (structured sections)
  // ------------------------
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

      const res = await this.withTimeout(
        this.ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
          config: { thinkingConfig: { thinkingBudget: 2048 } },
        }),
        'Plan generation timed out'
      );

      const text = res?.text ?? '';
      const parsed = this.parse<{ sections: any[] }>(text);
      if (!parsed || !parsed.sections) {
        // fallback simple plan
        return {
          steps: [
            { id: 'step_1', description: 'Answer the query directly', action: 'analyze', status: 'pending' },
          ],
          sections: [
            { name: 'Execution', description: 'Direct response', steps: [], status: 'pending' },
          ],
          currentStepIndex: 0,
          status: 'executing',
          createdAt: Date.now(),
        } as ExecutionPlan;
      }

      // flatten steps
      const allSteps: any[] = [];
      const sections = parsed.sections.map((sec, sidx) => {
        const steps = (sec.steps || []).map((s: any) => {
          const step = {
            id: s.id ?? `step_${allSteps.length + 1}`,
            description: s.description ?? 'Step',
            action: s.action ?? 'analyze',
            status: 'pending' as const,
            section: sec.name,
          };
          allSteps.push(step);
          return step;
        });
        return { name: sec.name, description: sec.description ?? '', steps, status: 'pending' as const };
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

  // ------------------------
  // Streaming simple responses (chat / stream)
  // Uses chats.create + chat.sendMessage (docs show chat flows)
  // ------------------------
  async streamResponse(
    query: string,
    history: Array<{ role: string; parts: any[] }>,
    onChunk: (text: string) => void
  ): Promise<string> {
    // The docs show using ai.chats.create and chat.sendMessage. There's also streaming
    // support in some client versions; here we'll perform a standard generateContent and
    // deliver text in one go while calling onChunk once per chunk split (if streaming not supported).
    // If your SDK supports streaming, replace with the SDK streaming API.
    const model = 'gemini-2.5-flash';
    try {
      // chats.create sample (chat history)
      const chat = this.ai.chats.create({
        model,
        history: history ?? [],
      });

      const response = await this.withTimeout(chat.sendMessage(query), 'Streaming response timed out');

      const text = response?.text ?? '';
      // If the SDK provided chunked stream, you should iterate and call onChunk for each chunk.
      // Here we call it once with the full text (safe fallback).
      if (text) {
        onChunk(text);
      }
      return text;
    } catch (e) {
      console.error('[GeminiClient] streamResponse failed', e);
      throw e;
    }
  }

  // ------------------------
  // executeWithConfig - enable tools (search, code execution, files, maps, url context)
  // - ExecutionConfig should include booleans and file list (with ai file metadata)
  // ------------------------
  async executeWithConfig(
    prompt: string,
    history: Array<{ role: string; parts: any[] }>,
    config: ExecutionConfig
  ): Promise<string> {
    return this.withRetry(async () => {
      // Build tools array per docs (googleSearch, codeExecution, maps, urlContext, computerUse)
      const tools: any[] = [];

      if (config.useSearch) tools.push({ googleSearch: {} });
      if (config.useCodeExecution) tools.push({ codeExecution: {} });
      if (config.useMapsGrounding) tools.push({ googleMaps: {} });
      if (config.useUrlContext && config.urlList?.length) {
        // URL context expects url parts included in contents or a tool enablement (docs show enabling tool + including parts created from urls)
        tools.push({ urlContext: {} });
      }
      if (config.allowComputerUse) {
        tools.push({ computerUse: {} });
      }

      // Build contents array: include files as file parts using helper createPartFromUri
      const contents: any[] = [];
      // If files provided, include them as file parts
      if (config.files && config.files.length > 0) {
        // create user content: file parts + text
        // The GenAI client docs show createUserContent/createPartFromUri helpers; if you don't have them,
        // push objects with file_data { mime_type, file_uri } as parts.
        const fileParts = config.files
          .filter((f) => f.state === 'ACTIVE' && f.fileUri)
          .map((f) => ({ file_data: { mime_type: f.mimeType, file_uri: f.fileUri } }));

        // request: first file parts then the prompt text
        contents.push({
          parts: [...fileParts, { text: prompt }],
        });
      } else {
        contents.push({ parts: [{ text: prompt }] });
      }

      // If URL context is used, add provided URLs as parts per docs: as "url" parts
      if (config.useUrlContext && config.urlList?.length) {
        // append a separate content entry that contains the URL parts (the docs show createPartFromUri)
        const urlParts = config.urlList.map((u) => ({ url: u }));
        contents.push({ parts: urlParts });
      }

      const call = this.ai.models.generateContent({
        model: config.model ?? 'gemini-2.5-flash',
        contents,
        config: {
          // enable thinking if requested
          thinkingConfig: config.thinkingConfig ?? undefined,
          tools: tools.length ? tools : undefined,
        },
        // If a chat-history flow is preferred, you could use ai.chats.create and chat.sendMessage with same config
      });

      const res = await this.withTimeout(call, 'Execution timed out', config.timeoutMs ?? this.timeout);
      return res?.text ?? '[No result]';
    });
  }

  // ------------------------
  // Synthesizer - combine step results into a final answer
  // ------------------------
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

      const res = await this.withTimeout(
        this.ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
          config: { thinkingConfig: { thinkingBudget: 2048 } },
        }),
        'Synthesis timed out'
      );

      return res?.text ?? '[No answer generated]';
    });
  }
}

export default GeminiClient;
