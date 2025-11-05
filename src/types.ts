// src/types.ts

/**
 * Environment bindings
 */
export interface Env {
  AGENT: DurableObjectNamespace;
  GEMINI_API_KEY: string;
}

/**
 * Agent persistent state
 */
export interface AgentState {
  conversationHistory: Message[];
  context: {
    files: any[];
    searchResults: any[];
  };
  sessionId: string;
  lastActivityAt: number;
  currentPlan?: ExecutionPlan;
}

/**
 * Conversation message
 */
export interface Message {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
  timestamp: number;
}

/**
 * Execution plan for complex tasks
 */
export interface ExecutionPlan {
  steps: PlanStep[];
  currentStepIndex: number;
  status: 'executing' | 'completed' | 'failed';
  createdAt: number;
  completedAt?: number;
}

/**
 * Individual plan step
 */
export interface PlanStep {
  id: string;
  description: string;
  action: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  result?: string;
  error?: string;
}

/**
 * Task complexity analysis result
 */
export interface TaskComplexity {
  type: 'simple' | 'complex';
  requiredTools: string[];
  estimatedSteps: number;
  reasoning: string;
}

/**
 * WebSocket message types
 */
export type WSMessageType =
  | 'connected'
  | 'status'
  | 'chunk'
  | 'plan'
  | 'step_start'
  | 'step_complete'
  | 'step_error'
  | 'final_response'
  | 'sources'
  | 'thinking'
  | 'done'
  | 'error';

/**
 * WebSocket message payload
 */
export interface WSMessage {
  type: WSMessageType;
  [key: string]: any;
}

/**
 * REST API request/response types
 */
export interface ChatRequest {
  message: string;
}

export interface ChatResponse {
  status: 'queued' | 'error';
  error?: string;
}

export interface HistoryResponse {
  history: Message[];
}

export interface StatusResponse {
  plan?: ExecutionPlan;
  lastActivity: number;
  messageCount: number;
  activeConnections: number;
  cacheSize: number;
}
