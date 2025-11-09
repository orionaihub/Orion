// src/types.ts

import type { DurableObjectState } from '@cloudflare/workers-types';

/**
 * Cloudflare Worker Environment variables and bindings.
 */
export interface Env {
  GEMINI_API_KEY: string;
  MY_DURABLE_OBJECT: DurableObjectNamespace;
  // Add other bindings here (e.g., KV, R2, external API keys)
  SEARCH_API_ENDPOINT?: string;
}

/**
 * Interface for the Sqlite Durable Object Storage binding.
 */
export interface SqlStorage {
  exec(query: string, ...params: any[]): {
    one(): any;
    toArray(): any[];
    [Symbol.iterator](): Iterator<any>;
  };
}

/**
 * Metadata for files uploaded to the Gemini File API.
 */
export interface FileMetadata {
  fileUri: string;
  mimeType: string;
  name: string;
  sizeBytes: number;
  uploadedAt: number;
  state: 'PROCESSING' | 'ACTIVE' | 'FAILED';
  expiresAt?: number;
}

/**
 * The persistent state stored in the Durable Object.
 */
export interface AgentState {
  conversationHistory: any[]; // Redundant, kept for potential future use or compatibility
  context: {
    files: FileMetadata[];
    searchResults: any[];
    urls?: string[];
  };
  sessionId: string;
  lastActivityAt: number;
}

/**
 * Message format used for DB storage and history loading.
 */
export interface Message {
  role: 'user' | 'model' | 'system';
  parts: Array<{ text: string }>;
  timestamp: number;
}

/**
 * Interface for an external tool definition (for the LLM).
 */
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

/**
 * Interface for a function call requested by the LLM.
 */
export interface ToolCall {
  name: string;
  args: Record<string, any>;
}

/**
 * Interface for the result returned after executing a tool.
 */
export interface ToolResult {
  name: string;
  success: boolean;
  result: string;
}

// These are still used in the GeminiClient
export type TaskComplexity = 'SIMPLE' | 'MEDIUM' | 'COMPLEX';
export interface ExecutionPlan {
  complexity: TaskComplexity;
  steps: string[];
}
