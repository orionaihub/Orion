// types.ts
export interface Env {
  GEMINI_API_KEY: string;
  AutonomousAgent: DurableObjectNamespace;
  ASSETS?: Fetcher;
}

export interface AgentState {
  conversationHistory: Message[];
  currentPlan?: ExecutionPlan;
  context: {
    files: FileContext[];
    searchResults: any[];
  };
}

export interface Message {
  role: 'user' | 'model' | 'function';
  parts: Array<TextPart | InlineDataPart | FunctionCallPart | FunctionResponsePart>;
  timestamp: number;
}

export interface ExecutionPlan {
  steps: PlanStep[];
  currentStepIndex: number;
  status: 'planning' | 'executing' | 'completed' | 'failed';
}

export interface PlanStep {
  id: string;
  description: string;
  action: 'search' | 'analyze' | 'code_execute' | 'api_call' | 'synthesize';
  status: 'pending' | 'executing' | 'completed' | 'failed';
  result?: any;
}
