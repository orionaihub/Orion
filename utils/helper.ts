// src/utils/helpers.ts

/**
 * Parse JSON safely with fallback
 */
export function parseJSON<T>(text: string, fallback: T): T {
  try {
    const trimmed = text.trim().replace(/^```json\s*/, '').replace(/```$/, '');
    if (!trimmed) return fallback;
    return JSON.parse(trimmed) as T;
  } catch (e) {
    console.error('JSON parse failed:', e);
    return fallback;
  }
}

/**
 * Stringify with error handling
 */
export function stringifyJSON(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch (e) {
    console.error('JSON stringify failed:', e);
    return '{}';
  }
}

/**
 * Custom error class for agent operations
 */
export class AgentError extends Error {
  constructor(
    message: string,
    public code: string,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

/**
 * Build prompt for step execution
 */
export function buildStepPrompt(
  step: { description: string; action: string },
  completedSteps: Array<{ description: string; result?: string }>,
  allSteps: Array<{ description: string }>
): string {
  const planOverview = allSteps.map(s => s.description).join(' → ');
  const completedContext = completedSteps
    .map(s => `${s.description}: ${s.result ?? '(no result)'}`)
    .join('\n');

  return `EXECUTION PLAN: ${planOverview}

COMPLETED STEPS:
${completedContext || 'None yet'}

CURRENT STEP: ${step.description}
ACTION TYPE: ${step.action}

Instructions: Execute this step and provide only the result. Be concise and factual.`;
}

/**
 * Response cache for common queries
 */
export class ResponseCache {
  private cache: Map<string, { response: string; timestamp: number }> = new Map();
  private ttl: number;
  private maxSize: number;

  constructor(ttl = 5 * 60 * 1000, maxSize = 100) {
    this.ttl = ttl;
    this.maxSize = maxSize;
  }

  get(key: string): string | null {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.ttl) {
      return cached.response;
    }
    this.cache.delete(key);
    return null;
  }

  set(key: string, response: string): void {
    // Enforce size limit
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, { response, timestamp: Date.now() });
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

/**
 * Sanitize user input
 */
export function sanitizeInput(input: string): string {
  return input.trim().slice(0, 10000); // Max 10k chars
}

/**
 * Format duration in human readable form
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * Truncate text to max length
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}
