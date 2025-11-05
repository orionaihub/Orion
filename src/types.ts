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
  context: AgentContext;
  sessionId: string;
  lastActivityAt: number;
  currentPlan?: ExecutionPlan;
  uploadedFiles: FileMetadata[];
  memory: AgentMemory;
}

/**
 * Agent context for rich state management
 */
export interface AgentContext {
  files: FileMetadata[];
  searchResults: SearchResult[];
  codeExecutions: CodeExecution[];
  images: ImageMetadata[];
}

/**
 * Agent memory for learning and preferences
 */
export interface AgentMemory {
  userPreferences: Record<string, any>;
  recentTopics: string[];
  successfulPatterns: string[];
}

/**
 * File metadata for uploads
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
 * Image metadata
 */
export interface ImageMetadata {
  url: string;
  description?: string;
  generatedAt: number;
  prompt?: string;
  type: 'uploaded' | 'generated' | 'analyzed';
}

/**
 * Code execution record
 */
export interface CodeExecution {
  code: string;
  language: string;
  result?: string;
  error?: string;
  executedAt: number;
  durationMs?: number;
}

/**
 * Search result
 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  timestamp: number;
}

/**
 * Conversation message
 */
export interface Message {
  role: 'user' | 'model';
  parts: MessagePart[];
  timestamp: number;
}

/**
 * Message part (text, image, file)
 */
export type MessagePart = 
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { mimeType: string; fileUri: string } };

/**
 * Execution plan for complex tasks
 */
export interface ExecutionPlan {
  steps: PlanStep[];
  currentStepIndex: number;
  status: 'executing' | 'completed' | 'failed';
  createdAt: number;
  completedAt?: number;
  sections: PlanSection[];
}

/**
 * Plan section for organized tasks
 */
export interface PlanSection {
  name: string;
  description: string;
  steps: PlanStep[];
  status: 'pending' | 'active' | 'completed';
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
  section?: string;
}

/**
 * Task complexity analysis result
 */
export interface TaskComplexity {
  type: 'simple' | 'complex';
  requiredTools: string[];
  estimatedSteps: number;
  reasoning: string;
  requiresFiles?: boolean;
  requiresCode?: boolean;
  requiresVision?: boolean;
}

/**
 * Tool capabilities
 */
export type ToolCapability = 
  | 'search'
  | 'code_execution'
  | 'file_analysis'
  | 'vision'
  | 'data_analysis'
  | 'image_generation';

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
  | 'code_executing'
  | 'code_result'
  | 'file_uploaded'
  | 'file_analyzed'
  | 'image_generated'
  | 'visualization'
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
  files?: Array<{ data: string; mimeType: string; name: string }>;
}

export interface ChatResponse {
  status: 'queued' | 'error';
  error?: string;
}

export interface HistoryResponse {
  history: Message[];
  files: FileMetadata[];
}

export interface StatusResponse {
  plan?: ExecutionPlan;
  lastActivity: number;
  messageCount: number;
  activeConnections: number;
  cacheSize: number;
  uploadedFiles: number;
  capabilities: ToolCapability[];
}

/**
 * File upload request
 */
export interface FileUploadRequest {
  data: string; // base64
  mimeType: string;
  name: string;
}

/**
 * Rich response with attachments
 */
export interface RichResponse {
  text: string;
  attachments?: ResponseAttachment[];
}

/**
 * Response attachment
 */
export interface ResponseAttachment {
  type: 'image' | 'code' | 'data' | 'file';
  content: string;
  metadata?: Record<string, any>;
}
