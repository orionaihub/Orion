import type { FileMetadata, ExecutionPlan } from './types';

export interface ExecutionConfig {
  model?: string;
  thinkingConfig?: {
    thinkingBudget?: number;
  };
  files?: FileMetadata[];
  useSearch?: boolean;
  useCodeExecution?: boolean;
  useMapsGrounding?: boolean;
  useUrlContext?: boolean;
  urlList?: string[];
  allowComputerUse?: boolean;
  timeoutMs?: number;
}

// Optional: utility function to create file parts from metadata
export function createFileParts(files: FileMetadata[]) {
  return files
    .filter(f => f.state === 'ACTIVE' && f.fileUri)
    .map(f => ({
      file_data: { mime_type: f.mimeType, file_uri: f.fileUri },
    }));
}

// Optional: utility to flatten ExecutionPlan steps
export function flattenPlanSteps(plan: ExecutionPlan) {
  return plan.sections.flatMap(sec => sec.steps);
}
