// src/tools.ts
import type { AgentState, PlanStep } from './types';

/**
 * Tool interface for extensible agent capabilities
 */
export interface Tool {
  name: string;
  description: string;
  execute(params: ToolExecutionParams): Promise<string>;
}

export interface ToolExecutionParams {
  step: PlanStep;
  state: AgentState;
  prompt: string;
  geminiExecutor: (prompt: string, useTools: boolean) => Promise<string>;
}

/**
 * Google Search Tool
 */
export class GoogleSearchTool implements Tool {
  name = 'google_search';
  description = 'Search the web using Google Search';

  async execute({ prompt, geminiExecutor }: ToolExecutionParams): Promise<string> {
    // Uses Gemini with Google Search Retrieval
    return await geminiExecutor(prompt, true);
  }
}

/**
 * Code Execution Tool
 */
export class CodeExecutionTool implements Tool {
  name = 'code_execute';
  description = 'Execute Python code';

  async execute({ prompt, geminiExecutor }: ToolExecutionParams): Promise<string> {
    // Uses Gemini with Code Execution
    return await geminiExecutor(prompt, true);
  }
}

/**
 * Analysis Tool (no external tools, just reasoning)
 */
export class AnalysisTool implements Tool {
  name = 'analyze';
  description = 'Analyze and reason about information';

  async execute({ prompt, geminiExecutor }: ToolExecutionParams): Promise<string> {
    // Uses Gemini without external tools
    return await geminiExecutor(prompt, false);
  }
}

/**
 * Synthesis Tool
 */
export class SynthesisTool implements Tool {
  name = 'synthesize';
  description = 'Synthesize information from multiple sources';

  async execute({ prompt, geminiExecutor }: ToolExecutionParams): Promise<string> {
    // Uses Gemini without external tools for synthesis
    return await geminiExecutor(prompt, false);
  }
}

/**
 * API Call Tool (placeholder for future extension)
 */
export class APICallTool implements Tool {
  name = 'api_call';
  description = 'Make API calls to external services';

  async execute({ step, prompt, geminiExecutor }: ToolExecutionParams): Promise<string> {
    // For now, use Gemini to generate API call logic
    // In the future, this could make actual HTTP requests
    return await geminiExecutor(
      `${prompt}\n\nNote: Generate the API call strategy for: ${step.description}`,
      false
    );
  }
}

/**
 * Tool Registry - manages all available tools
 */
export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  constructor() {
    // Register default tools
    this.registerTool(new GoogleSearchTool());
    this.registerTool(new CodeExecutionTool());
    this.registerTool(new AnalysisTool());
    this.registerTool(new SynthesisTool());
    this.registerTool(new APICallTool());
  }

  /**
   * Register a new tool
   */
  registerTool(tool: Tool): void {
    this.tools.set(tool.name, tool);
    console.log(`Registered tool: ${tool.name}`);
  }

  /**
   * Get a tool by name
   */
  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all available tools
   */
  getAllTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tool names for a given action
   */
  getToolForAction(action: string): Tool | undefined {
    // Map action names to tool names
    const actionToTool: Record<string, string> = {
      'search': 'google_search',
      'google_search': 'google_search',
      'code_execute': 'code_execute',
      'code_execution': 'code_execute',
      'analyze': 'analyze',
      'analysis': 'analyze',
      'synthesize': 'synthesize',
      'synthesis': 'synthesize',
      'api_call': 'api_call',
    };

    const toolName = actionToTool[action.toLowerCase()] || 'analyze';
    return this.getTool(toolName);
  }

  /**
   * List all tool names and descriptions
   */
  listTools(): Array<{ name: string; description: string }> {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
    }));
  }
}

/**
 * Tool execution helper
 */
export async function executeTool(
  toolName: string,
  params: ToolExecutionParams,
  registry: ToolRegistry
): Promise<string> {
  const tool = registry.getTool(toolName) || registry.getTool('analyze');
  
  if (!tool) {
    throw new Error(`Tool not found: ${toolName}`);
  }

  try {
    return await tool.execute(params);
  } catch (error) {
    console.error(`Tool execution failed: ${toolName}`, error);
    throw error;
  }
}
