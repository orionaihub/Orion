// src/types.ts - Complete type definitions

export interface Env {
  GEMINI_API_KEY: string;
  AGENT: DurableObjectNamespace;
  // Add other environment variables as needed
}

export interface Message {
  role: 'user' | 'model';
  parts: Array<{ text: string } | { file_data?: any } | { url?: string }>;
  timestamp: number;
}

export interface FileMetadata {
  fileUri: string;
  mimeType: string;
  name: string;
  sizeBytes: number;
  uploadedAt: number;
  state: 'ACTIVE' | 'PROCESSING' | 'FAILED';
  expiresAt?: number;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  relevance?: number;
}

export interface AgentContext {
  files: FileMetadata[];
  searchResults: SearchResult[];
  variables?: Record<string, any>;
}

export interface AgentState {
  conversationHistory: Message[];
  context: AgentContext;
  sessionId: string;
  lastActivityAt: number;
  currentPlan?: ExecutionPlan;
  metadata?: Record<string, any>;
}

// ===== Plan-based Types (for old implementation) =====

export interface TaskComplexity {
  type: 'simple' | 'complex';
  requiredTools: string[];
  estimatedSteps: number;
  reasoning: string;
  requiresFiles: boolean;
  requiresCode: boolean;
  requiresVision: boolean;
}

export interface PlanStep {
  id: string;
  description: string;
  action: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  result?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
}

export interface ExecutionPlan {
  steps: PlanStep[];
  currentStepIndex: number;
  status: 'planning' | 'executing' | 'completed' | 'failed';
  createdAt: number;
  completedAt?: number;
  error?: string;
}

// ===== Tool-based Types (for new implementation) =====

export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
}

export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  enum?: string[];
  items?: { type: string };
}

export interface ToolCall {
  name: string;
  args: Record<string, any>;
}

export interface ToolResult {
  name: string;
  result: string;
  success: boolean;
  error?: string;
}

// ===== WebSocket Message Types =====

export type WSMessageType =
  | 'user_message'
  | 'chunk'
  | 'step_chunk'
  | 'final_chunk'
  | 'status'
  | 'plan'
  | 'step_start'
  | 'step_complete'
  | 'step_error'
  | 'tool_use'
  | 'final_response'
  | 'done'
  | 'error';

export interface WSMessage {
  type: WSMessageType;
  content?: string;
  message?: string;
  plan?: ExecutionPlan;
  step?: number;
  description?: string;
  result?: string;
  tools?: string[];
  error?: string;
  turns?: number;
}

// ===== API Response Types =====

export interface ChatResponse {
  status: 'queued' | 'processing' | 'completed' | 'error';
  message?: string;
  error?: string;
}

export interface HistoryResponse {
  messages: Message[];
}

export interface StatusResponse {
  plan?: ExecutionPlan;
  lastActivity?: number;
  sessionId?: string;
  filesCount?: number;
}

export interface MetricsResponse {
  requestCount: number;
  errorCount: number;
  avgResponseTime: number;
  activeConnections: number;
  totalResponseTime: number;
  complexityDistribution?: {
    simple: number;
    complex: number;
  };
  circuitBreaker?: {
    failures: number;
    isOpen: boolean;
  };
}

// ===== Durable Object Types =====

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  idFromString(id: string): DurableObjectId;
  newUniqueId(): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface DurableObjectId {
  toString(): string;
  equals(other: DurableObjectId): boolean;
}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
  id: DurableObjectId;
}

// ===== Configuration Types =====

export interface AgentConfig {
  maxHistoryMessages?: number;
  maxMessageSize?: number;
  maxTotalHistorySize?: number;
  complexityCacheTTL?: number;
  maxTurns?: number;
  defaultModel?: string;
  thinkingBudget?: number;
}

export interface StepExecutionOptions {
  continueOnFailure?: boolean;
  maxRetries?: number;
  parallelExecution?: boolean;
  timeoutMs?: number;
}

// ===== Error Types =====

export class AgentError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
    public details?: any
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

export class ToolExecutionError extends AgentError {
  constructor(message: string, public toolName: string, details?: any) {
    super(message, 'TOOL_EXECUTION_ERROR', 500, details);
    this.name = 'ToolExecutionError';
  }
}

export class PlanningError extends AgentError {
  constructor(message: string, details?: any) {
    super(message, 'PLANNING_ERROR', 500, details);
    this.name = 'PlanningError';
  }
}

export class StateError extends AgentError {
  constructor(message: string, details?: any) {
    super(message, 'STATE_ERROR', 500, details);
    this.name = 'StateError';
  }
}
