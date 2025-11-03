/**
 * Type definitions for the Autonomous Agent application
 */

// ========================================
// Environment Configuration
// ========================================

/**
 * Cloudflare Worker Environment
 * 
 * Contains bindings for Durable Objects, secrets, and assets
 */
export interface Env {
  // Gemini API Key (set via wrangler secret put GEMINI_API_KEY)
  GEMINI_API_KEY: string;

  // Durable Object binding for the autonomous agent
  AutonomousAgent: DurableObjectNamespace;

  // Assets binding for serving static files (optional for dev)
  ASSETS?: Fetcher;
}

// ========================================
// Agent State Management
// ========================================

/**
 * Complete state of an autonomous agent instance
 * 
 * This state is persisted to Durable Object storage and survives
 * across reconnections and Worker restarts.
 */
export interface AgentState {
  // Full conversation history with the user
  conversationHistory: Message[];

  // Current execution plan (if in multi-step mode)
  currentPlan?: ExecutionPlan;

  // Additional context for the agent
  context: AgentContext;

  // Session metadata
  sessionId?: string;
  createdAt?: number;
  lastActivityAt?: number;
}

/**
 * Additional context that the agent maintains
 */
export interface AgentContext {
  // Uploaded files (images, PDFs, documents)
  files: FileContext[];

  // Search results and web context
  searchResults: SearchResult[];

  // User preferences and settings
  preferences?: {
    autoMode?: boolean;
    verbosity?: 'concise' | 'detailed';
    thinkingBudget?: number;
  };
}

// ========================================
// Conversation Messages
// ========================================

/**
 * A single message in the conversation
 * 
 * Compatible with Gemini API message format
 */
export interface Message {
  role: 'user' | 'model' | 'function';
  parts: Part[];
  timestamp: number;
}

/**
 * Content part within a message
 * 
 * Supports text, images, files, function calls, and function responses
 */
export type Part =
  | TextPart
  | InlineDataPart
  | FileDataPart
  | FunctionCallPart
  | FunctionResponsePart;

export interface TextPart {
  text: string;
}

export interface InlineDataPart {
  inlineData: {
    mimeType: string;
    data: string; // Base64 encoded
  };
}

export interface FileDataPart {
  fileData: {
    mimeType: string;
    fileUri: string; // URI to Gemini Files API or data URL
  };
}

export interface FunctionCallPart {
  functionCall: {
    name: string;
    args: Record<string, any>;
  };
}

export interface FunctionResponsePart {
  functionResponse: {
    name: string;
    response: Record<string, any>;
  };
}

// ========================================
// File Management
// ========================================

/**
 * Context for an uploaded file
 */
export interface FileContext {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  uploadedAt: number;
  
  // Storage reference
  storageKey: string;
  
  // File metadata
  metadata?: {
    width?: number;
    height?: number;
    pages?: number;
    duration?: number;
  };
}

// ========================================
// Execution Planning
// ========================================

/**
 * Multi-step execution plan for complex tasks
 */
export interface ExecutionPlan {
  // List of steps to execute
  steps: PlanStep[];

  // Current step being executed
  currentStepIndex: number;

  // Overall plan status
  status: 'planning' | 'executing' | 'completed' | 'failed';

  // Plan metadata
  createdAt?: number;
  startedAt?: number;
  completedAt?: number;
}

/**
 * A single step in the execution plan
 */
export interface PlanStep {
  id: string;
  description: string;
  
  // Type of action to perform
  action: ActionType;
  
  // Step status
  status: StepStatus;
  
  // Execution result
  result?: any;
  error?: string;
  
  // Timing information
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
}

/**
 * Types of actions the agent can perform
 */
export type ActionType =
  | 'search'          // Web search via Google Search grounding
  | 'analyze'         // Analyze data or content
  | 'code_execute'    // Execute Python code
  | 'api_call'        // Call external API
  | 'synthesize'      // Synthesize final response
  | 'url_fetch'       // Fetch and analyze URL
  | 'file_process'    // Process uploaded file
  | 'think';          // Deep reasoning step

/**
 * Status of a plan step
 */
export type StepStatus = 'pending' | 'executing' | 'completed' | 'failed' | 'skipped';

// ========================================
// Search and Web Context
// ========================================

/**
 * Search result from web grounding
 */
export interface SearchResult {
  query: string;
  results: Array<{
    title: string;
    url: string;
    snippet: string;
  }>;
  timestamp: number;
}

// ========================================
// Task Analysis
// ========================================

/**
 * Result of task complexity analysis
 */
export interface TaskComplexity {
  // Simple (single-turn) or complex (multi-step)
  type: 'simple' | 'complex';

  // Required tools and capabilities
  requiredTools: ToolType[];

  // Estimated number of steps for complex tasks
  estimatedSteps?: number;

  // Agent's reasoning about the task
  reasoning: string;

  // Confidence score (0-1)
  confidence?: number;
}

/**
 * Types of tools the agent can use
 */
export type ToolType =
  | 'search'
  | 'code_execution'
  | 'url_context'
  | 'file_analysis'
  | 'api_call'
  | 'thinking'
  | 'image_generation';

// ========================================
// WebSocket Messages
// ========================================

/**
 * Messages sent from client to agent via WebSocket
 */
export type ClientMessage =
  | { type: 'user_message'; content: string }
  | { type: 'upload_file'; file: { name: string; data: string; mimeType: string } }
  | { type: 'cancel' }
  | { type: 'set_preference'; key: string; value: any };

/**
 * Messages sent from agent to client via WebSocket
 */
export type ServerMessage =
  | { type: 'status'; message: string }
  | { type: 'chunk'; content: string }
  | { type: 'plan'; plan: ExecutionPlan }
  | { type: 'step_start'; step: number; total: number; description: string }
  | { type: 'step_complete'; step: number; result: any }
  | { type: 'step_error'; step: number; error: string }
  | { type: 'final_response'; content: string }
  | { type: 'sources'; sources: string[] }
  | { type: 'thinking'; thoughts: string }
  | { type: 'done' }
  | { type: 'error'; error: string }
  | { type: 'file_uploaded'; file: FileContext }
  | { type: 'connected'; sessionId: string };

// ========================================
// API Request/Response Types
// ========================================

/**
 * Request body for /api/chat endpoint
 */
export interface ChatRequest {
  message: string;
  files?: Array<{
    name: string;
    data: string; // Base64
    mimeType: string;
  }>;
}

/**
 * Response from /api/chat endpoint
 */
export interface ChatResponse {
  status: 'processing' | 'completed' | 'error';
  message?: string;
  error?: string;
}

/**
 * Response from /api/history endpoint
 */
export interface HistoryResponse {
  history: Message[];
  sessionId: string;
  messageCount: number;
}

/**
 * Response from /api/files endpoint
 */
export interface FilesResponse {
  files: FileContext[];
}

/**
 * Response from /api/status endpoint
 */
export interface StatusResponse {
  status: 'idle' | 'processing' | 'executing_plan';
  currentPlan?: ExecutionPlan;
  messageCount: number;
  fileCount: number;
  lastActivity?: number;
}

// ========================================
// Function Calling
// ========================================

/**
 * External function that the agent can call
 */
export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
    }>;
    required?: string[];
  };
}

/**
 * Result of a function execution
 */
export interface FunctionResult {
  name: string;
  response: any;
  error?: string;
  executionTimeMs?: number;
}

// ========================================
// Error Types
// ========================================

/**
 * Custom error for agent operations
 */
export class AgentError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: any
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

// ========================================
// Configuration
// ========================================

/**
 * Agent configuration options
 */
export interface AgentConfig {
  // Gemini model to use
  model?: string;

  // Default thinking budget
  defaultThinkingBudget?: number;

  // Maximum conversation history length
  maxHistoryLength?: number;

  // Enable automatic multi-step execution
  autoModeEnabled?: boolean;

  // Temperature for generation
  temperature?: number;

  // Maximum tokens to generate
  maxOutputTokens?: number;
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: AgentConfig = {
  model: 'gemini-2.5-flash',
  defaultThinkingBudget: 4096,
  maxHistoryLength: 100,
  autoModeEnabled: true,
  temperature: 0.7,
  maxOutputTokens: 8192,
};
