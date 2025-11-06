// src/types.ts

export interface Env {
  GEMINI_API_KEY: string;
  AUTONOMOUS_AGENT: DurableObjectNamespace;
  // Add other environment variables as needed
}

export interface FileMetadata {
  fileUri: string;
  mimeType: string;
  name: string;
  sizeBytes: number;
  uploadedAt: number;
  state: 'PROCESSING' | 'ACTIVE' | 'FAILED' | 'UNKNOWN';
  expiresAt?: number;
}

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  timestamp?: number;
}

export interface AgentContext {
  files: FileMetadata[];
  searchResults: SearchResult[];
  metadata?: Record<string, any>;
}

export interface Message {
  role: 'user' | 'model' | 'system';
  parts: Array<{ text: string } | { file_data?: any } | { url?: string }>;
  timestamp: number;
}

// Autonomous Agent Modes
export enum AutonomousMode {
  CHAT = "chat",           // Single-step native tools
  EXECUTION = "execution"  // Multi-step with external tools via function calling
}

// Autonomous Agent Phases
export enum AgentPhase {
  ASSESSMENT = "assessment",     // Initial analysis and clarification
  PLANNING = "planning",         // Plan generation and user confirmation
  EXECUTION = "execution",       // Adaptive execution with tool calling
  COMPLETION = "completion",     // Final response delivery
  CLARIFICATION = "clarification" // User engagement for better understanding
}

export interface AgentState {
  sessionId: string;
  conversationHistory: Message[];
  context: AgentContext;
  lastActivityAt: number;
  metadata?: Record<string, any>;
  // New autonomous behavior fields
  currentMode: AutonomousMode;
  currentPhase: AgentPhase;
  clarificationContext?: string;
  executionContext?: { currentTask: string; progress: string[] };
}

export interface WebSocketMessage {
  type:
    | 'user_message'
    | 'status'
    | 'chunk'
    | 'final_chunk'
    | 'phase_change'
    | 'clarification_request'
    | 'progress_update'
    | 'tool_call'
    | 'final_response'
    | 'done'
    | 'error';
  content?: string;
  message?: string;
  error?: string;
  phase?: AgentPhase;
  clarificationQuestion?: string;
  progress?: { currentTask: string; completed: string[] };
  toolCall?: { tool: string; params: Record<string, any>; result?: any };
  result?: string;
}

export interface ChatRequest {
  message: string;
  sessionId?: string;
  files?: FileMetadata[];
  metadata?: Record<string, any>;
}

export interface ChatResponse {
  status: 'queued' | 'processing' | 'completed' | 'error';
  sessionId?: string;
  message?: string;
  error?: string;
}

export interface HistoryResponse {
  messages: Message[];
  sessionId: string;
  totalMessages: number;
}

export interface StatusResponse {
  plan?: ExecutionPlan;
  lastActivity?: number;
  sessionId?: string;
  metrics?: {
    requestCount: number;
    errorCount: number;
    avgResponseTime: number;
    activeConnections: number;
  };
}

export interface MetricsResponse {
  requestCount: number;
  errorCount: number;
  avgResponseTime: number;
  activeConnections: number;
  circuitBreaker?: {
    failures: number;
    isOpen: boolean;
  };
}

// Re-export for convenience
export type { ExecutionConfig } from './utils/gemini';
