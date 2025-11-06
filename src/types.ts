// Add these to your types.ts file if they're missing

export enum AutonomousMode {
  CHAT = 'chat',
  AUTONOMOUS = 'autonomous',
  PLANNING = 'planning',
}

export enum AgentPhase {
  ASSESSMENT = 'assessment',
  PLANNING = 'planning',
  RESEARCH = 'research',
  ANALYSIS = 'analysis',
  EXECUTION = 'execution',
  CLARIFICATION = 'clarification',
  COMPLETION = 'completion',
}

export interface WebSocketMessage {
  type: 'user_message' | 'chunk' | 'error' | 'done' | 'phase_change' | 'clarification_request' | 'tool_call' | 'final_response';
  content?: string;
  error?: string;
  details?: string;
  phase?: AgentPhase;
  message?: string;
  clarificationQuestion?: string;
  toolCall?: {
    tool: string;
    params: any;
  };
}

export interface AgentState {
  conversationHistory: Message[];
  context?: {
    files?: FileMetadata[];
    searchResults?: Array<{ url: string; title?: string }>;
  };
  sessionId: string;
  lastActivityAt: number;
  currentMode: AutonomousMode;
  currentPhase: AgentPhase;
  clarificationContext?: any;
  executionContext?: any;
}

export interface Message {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
  timestamp: number;
}

export interface FileMetadata {
  fileUri: string;
  mimeType: string;
  name: string;
  sizeBytes: number;
  uploadedAt: number;
  state: string;
  expiresAt?: number;
}

export interface TaskComplexity {
  type: 'simple' | 'complex';
  requiredTools: string[];
  estimatedSteps: number;
  reasoning: string;
  requiresFiles: boolean;
  requiresCode: boolean;
  requiresVision: boolean;
}

export interface ExecutionPlan {
  steps: Array<{
    id: string;
    description: string;
    action: string;
    status: 'pending' | 'executing' | 'completed' | 'failed';
    result?: string;
  }>;
  currentStepIndex: number;
  status: 'executing' | 'completed' | 'failed';
  createdAt: number;
}

export interface Env {
  GEMINI_API_KEY: string;
  // Add other environment variables here
}
