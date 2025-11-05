// src/utils/gemini.ts
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { TaskComplexity, ExecutionPlan } from '../types';

/**
 * Gemini API wrapper with retry and timeout logic
 */
export class GeminiClient {
  private genAI: GoogleGenerativeAI;
  private maxRetries = 3;
  private baseBackoff = 1000;
  private timeout = 30000;

  constructor(apiKey: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  /**
   * Parse JSON response with fallback
   */
  private parse<T>(text: string): T | null {
    try {
      const trimmed = text.trim().replace(/^```json\s*/, '').replace(/```$/, '');
      if (!trimmed) return null;
      return JSON.parse(trimmed) as T;
    } catch (e) {
      console.error('JSON parse failed:', e, 'Raw:', text);
      return null;
    }
  }

  /**
   * Retry wrapper for API calls
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; i < this.maxRetries; i++) {
      try {
        return await fn();
      } catch (error) {
        if (i === this.maxRetries - 1) throw error;
        
        const delay = this.baseBackoff * Math.pow(2, i);
        console.log(`Retry ${i + 1}/${this.maxRetries} after ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw new Error('Max retries exceeded');
  }

  /**
   * Timeout wrapper for API calls
   */
  private async withTimeout<T>(promise: Promise<T>, errorMessage: string): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage)), this.timeout)
    );
    return Promise.race([promise, timeoutPromise]);
  }

  /**
   * Analyze task complexity
   */
  async analyzeComplexity(query: string): Promise<TaskComplexity> {
    return this.withRetry(async () => {
      const model = this.genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        generationConfig: { responseMimeType: 'application/json' },
      });

      const result = await this.withTimeout(
        model.generateContent({
          contents: [{
            role: 'user',
            parts: [{ text: `Analyze this request and return JSON only:
{
  "type": "simple" | "complex",
  "requiredTools": string[],
  "estimatedSteps": number,
  "reasoning": "brief explanation"
}

Rules:
- "simple": Single-step queries, direct questions, basic requests
- "complex": Multi-step tasks, research, analysis requiring multiple tools

Request: ${query}` }]
          }],
        }),
        'Complexity analysis timed out'
      );

      const text = (await result.response).text?.() ?? '{}';
      const parsed = this.parse<TaskComplexity>(text);
      
      return parsed || {
        type: 'simple',
        requiredTools: [],
        estimatedSteps: 1,
        reasoning: 'fallback to simple'
      };
    });
  }

  /**
   * Generate execution plan
   */
  async generatePlan(query: string, complexity: TaskComplexity): Promise<ExecutionPlan> {
    return this.withRetry(async () => {
      const model = this.genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        generationConfig: { responseMimeType: 'application/json' },
      });

      const result = await this.withTimeout(
        model.generateContent({
          contents: [{
            role: 'user',
            parts: [{ text: `Create an execution plan as a JSON array:
[
  {
    "id": "step_1",
    "description": "Clear description of what to do",
    "action": "search|analyze|code_execute|api_call|synthesize"
  }
]

Available actions:
- search: Use Google Search for information
- analyze: Analyze and reason about data
- code_execute: Execute Python code
- api_call: Call external APIs
- synthesize: Combine results into final answer

Request: ${query}
Complexity: ${JSON.stringify(complexity)}

Create a logical, step-by-step plan:` }]
          }],
        }),
        'Plan generation timed out'
      );

      const text = (await result.response).text?.() ?? '[]';
      const steps = this.parse<any[]>(text) || [];

      return {
        steps: steps.map((s, i) => ({
          id: s.id ?? `step_${i + 1}`,
          description: s.description || 'Unknown step',
          action: s.action || 'analyze',
          status: 'pending' as const,
        })),
        currentStepIndex: 0,
        status: 'executing',
        createdAt: Date.now(),
      };
    });
  }

  /**
   * Stream response (for simple queries, NO TOOLS)
   */
  async streamResponse(
    query: string,
    history: Array<{ role: string; parts: Array<{ text: string }> }>,
    onChunk: (text: string) => void
  ): Promise<string> {
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      // CRITICAL: No tools for streaming to avoid failures
    });

    const chat = model.startChat({ history });
    let fullText = '';

    try {
      const result = await this.withTimeout(
        chat.sendMessageStream(query),
        'Streaming response timed out'
      );

      for await (const chunk of result.stream) {
        const text = chunk.text?.() ?? '';
        if (text) {
          fullText += text;
          onChunk(text);
        }
      }

      return fullText;
    } catch (error) {
      console.error('Streaming failed:', error);
      throw error;
    }
  }

  /**
   * Execute step with tools (non-streaming)
   */
  async executeWithTools(
    prompt: string,
    history: Array<{ role: string; parts: Array<{ text: string }> }>,
    useTools: boolean
  ): Promise<string> {
    return this.withRetry(async () => {
      const model = this.genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        ...(useTools && {
          tools: [
            { googleSearchRetrieval: {} },
            { codeExecution: {} }
          ]
        }),
      });

      const chat = model.startChat({ history });

      const result = await this.withTimeout(
        chat.sendMessage(prompt),
        'Step execution timed out'
      );

      return (await result.response).text?.() ?? '[No result]';
    });
  }

  /**
   * Synthesize final response
   */
  async synthesize(
    originalQuery: string,
    stepResults: Array<{ description: string; result: string }>,
    history: Array<{ role: string; parts: Array<{ text: string }> }>
  ): Promise<string> {
    return this.withRetry(async () => {
      const model = this.genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
      });

      const prompt = `Original Request: ${originalQuery}

Step Results:
${stepResults.map((s, i) => `Step ${i + 1} - ${s.description}:\n${s.result}`).join('\n\n')}

Task: Synthesize these results into a clear, concise answer to the original request. Be direct and informative.`;

      const result = await this.withTimeout(
        model.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }]
        }),
        'Synthesis timed out'
      );

      return (await result.response).text?.() ?? '[No answer generated]';
    });
  }
}
