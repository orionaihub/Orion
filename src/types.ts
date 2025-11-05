export interface FileMetadata {
  fileUri: string;
  mimeType: string;
  name: string;
  sizeBytes: number;
  uploadedAt: number;
  state: 'ACTIVE' | 'PROCESSING' | 'FAILED' | string;
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

export interface ExecutionStep {
  id: string;
  description: string;
  action: 'search' | 'research' | 'code_execute' | 'file_analysis' | 'vision_analysis' | 'data_analysis' | 'analyze' | 'synthesize';
  status: 'pending' | 'executing' | 'done';
  section?: string;
}

export interface ExecutionSection {
  name: string;
  description: string;
  steps: ExecutionStep[];
  status: 'pending' | 'executing' | 'done';
}

export interface ExecutionPlan {
  steps: ExecutionStep[];
  sections: ExecutionSection[];
  currentStepIndex: number;
  status: 'pending' | 'executing' | 'done';
  createdAt: number;
}
