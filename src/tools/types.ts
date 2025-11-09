// src/tools/types.ts - Tool Type Definitions
import type { AgentState } from '../types';

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, any>;
  execute: (args: Record<string, any>, state: AgentState) => Promise<ToolResult>;
}

export interface ToolCall {
  name: string;
  args: Record<string, any>;
}

export interface ToolResult {
  name: string;
  success: boolean;
  result: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
}
