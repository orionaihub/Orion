// src/types.ts
export interface Env {
  AGENT: DurableObjectNamespace;
  GEMINI_API_KEY: string;
}

export interface AgentState {
  conversationHistory: Message[];
  context: { files: any[]; searchResults: any[] };
  sessionId: string;
  lastActivityAt: number;
  currentPlan?: ExecutionPlan;
}

export interface Message {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
  timestamp: number;
}

export interface ExecutionPlan {
  steps: PlanStep[];
  currentStepIndex: number;
  status: 'executing' | 'completed';
  createdAt: number;
  completedAt?: number;
}

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

export interface TaskComplexity {
  type: 'simple' | 'complex';
  requiredTools: string[];
  estimatedSteps: number;
  reasoning: string;
}
