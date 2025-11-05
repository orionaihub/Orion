// src/tools.ts
import type { AgentState, PlanStep, FileMetadata } from './types';

/**
 * Tool interface for extensible agent capabilities
 */
export interface Tool {
  name: string;
  description: string;
  capabilities: string[];
  execute(params: ToolExecutionParams): Promise<string>;
}

export interface ToolExecutionParams {
  step: PlanStep;
  state: AgentState;
  prompt: string;
  geminiExecutor: (prompt: string, config: ExecutionConfig) => Promise<string>;
}

export interface ExecutionConfig {
  useSearch?: boolean;
  useCodeExecution?: boolean;
  files?: FileMetadata[];
  temperature?: number;
}

/**
 * Google Search Tool
 */
export class GoogleSearchTool implements Tool {
  name = 'google_search';
  description = 'Search the web using Google Search for up-to-date information';
  capabilities = ['search', 'research', 'web_data'];

  async execute({ prompt, geminiExecutor }: ToolExecutionParams): Promise<string> {
    return await geminiExecutor(prompt, { useSearch: true });
  }
}

/**
 * Code Execution Tool - Execute Python code for data analysis
 */
export class CodeExecutionTool implements Tool {
  name = 'code_execute';
  description = 'Execute Python code for calculations, data analysis, and processing';
  capabilities = ['code_execution', 'data_analysis', 'calculations'];

  async execute({ prompt, geminiExecutor, state }: ToolExecutionParams): Promise<string> {
    // Include uploaded files if available
    const files = state.uploadedFiles.filter(f => f.state === 'ACTIVE');
    
    return await geminiExecutor(prompt, { 
      useCodeExecution: true,
      files: files.length > 0 ? files : undefined
    });
  }
}

/**
 * File Analysis Tool - Analyze uploaded documents
 */
export class FileAnalysisTool implements Tool {
  name = 'file_analysis';
  description = 'Analyze and extract information from uploaded files (PDF, CSV, TXT, etc.)';
  capabilities = ['file_analysis', 'document_processing', 'data_extraction'];

  async execute({ prompt, geminiExecutor, state }: ToolExecutionParams): Promise<string> {
    const files = state.uploadedFiles.filter(f => f.state === 'ACTIVE');
    
    if (files.length === 0) {
      return 'No files available for analysis. Please upload files first.';
    }

    return await geminiExecutor(prompt, { files });
  }
}

/**
 * Vision Analysis Tool - Analyze images
 */
export class VisionAnalysisTool implements Tool {
  name = 'vision_analysis';
  description = 'Analyze images and extract visual information';
  capabilities = ['vision', 'image_analysis', 'visual_understanding'];

  async execute({ prompt, geminiExecutor, state }: ToolExecutionParams): Promise<string> {
    // Get image files from uploaded files
    const imageFiles = state.uploadedFiles.filter(f => 
      f.state === 'ACTIVE' && f.mimeType.startsWith('image/')
    );

    if (imageFiles.length === 0) {
      return 'No images available for analysis. Please upload images first.';
    }

    return await geminiExecutor(prompt, { files: imageFiles });
  }
}

/**
 * Data Analysis Tool - Comprehensive data analysis with code execution
 */
export class DataAnalysisTool implements Tool {
  name = 'data_analysis';
  description = 'Perform comprehensive data analysis on structured data (CSV, JSON, Excel)';
  capabilities = ['data_analysis', 'statistics', 'visualization'];

  async execute({ prompt, geminiExecutor, state }: ToolExecutionParams): Promise<string> {
    const dataFiles = state.uploadedFiles.filter(f => 
      f.state === 'ACTIVE' && (
        f.mimeType.includes('csv') ||
        f.mimeType.includes('json') ||
        f.mimeType.includes('spreadsheet') ||
        f.mimeType.includes('excel')
      )
    );

    if (dataFiles.length === 0) {
      return 'No data files available. Please upload CSV, JSON, or Excel files.';
    }

    // Use code execution with data files
    return await geminiExecutor(prompt, { 
      useCodeExecution: true,
      files: dataFiles
    });
  }
}

/**
 * Analysis Tool (no external tools, just reasoning)
 */
export class AnalysisTool implements Tool {
  name = 'analyze';
  description = 'Analyze and reason about information without external tools';
  capabilities = ['reasoning', 'analysis', 'thinking'];

  async execute({ prompt, geminiExecutor }: ToolExecutionParams): Promise<string> {
    return await geminiExecutor(prompt, {});
  }
}

/**
 * Synthesis Tool
 */
export class SynthesisTool implements Tool {
  name = 'synthesize';
  description = 'Synthesize information from multiple sources into coherent answers';
  capabilities = ['synthesis', 'summarization', 'integration'];

  async execute({ prompt, geminiExecutor, state }: ToolExecutionParams): Promise<string> {
    // Include context from previous steps and uploaded files
    const files = state.uploadedFiles.filter(f => f.state === 'ACTIVE');
    
    return await geminiExecutor(prompt, { 
      files: files.length > 0 ? files : undefined 
    });
  }
}

/**
 * Research Tool - Combines search with analysis
 */
export class ResearchTool implements Tool {
  name = 'research';
  description = 'Conduct comprehensive research using web search and analysis';
  capabilities = ['research', 'search', 'analysis'];

  async execute({ prompt, geminiExecutor }: ToolExecutionParams): Promise<string> {
    return await geminiExecutor(prompt, { useSearch: true });
  }
}

/**
 * Tool Registry - manages all available tools
 */
export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  constructor() {
    // Register Suna-Lite tools
    this.registerTool(new GoogleSearchTool());
    this.registerTool(new CodeExecutionTool());
    this.registerTool(new FileAnalysisTool());
    this.registerTool(new VisionAnalysisTool());
    this.registerTool(new DataAnalysisTool());
    this.registerTool(new AnalysisTool());
    this.registerTool(new SynthesisTool());
    this.registerTool(new ResearchTool());
  }

  /**
   * Register a new tool
   */
  registerTool(tool: Tool): void {
    this.tools.set(tool.name, tool);
    console.log(`Registered tool: ${tool.name} with capabilities: ${tool.capabilities.join(', ')}`);
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
   * Get tool for action
   */
  getToolForAction(action: string): Tool | undefined {
    const actionToTool: Record<string, string> = {
      'search': 'google_search',
      'google_search': 'google_search',
      'research': 'research',
      'code_execute': 'code_execute',
      'code_execution': 'code_execute',
      'file_analysis': 'file_analysis',
      'analyze_file': 'file_analysis',
      'vision': 'vision_analysis',
      'vision_analysis': 'vision_analysis',
      'analyze_image': 'vision_analysis',
      'data_analysis': 'data_analysis',
      'analyze_data': 'data_analysis',
      'analyze': 'analyze',
      'analysis': 'analyze',
      'synthesize': 'synthesize',
      'synthesis': 'synthesize',
      'api_call': 'analyze', // Fallback to analysis
    };

    const toolName = actionToTool[action.toLowerCase()] || 'analyze';
    return this.getTool(toolName);
  }

  /**
   * List all capabilities
   */
  getAllCapabilities(): string[] {
    const capabilities = new Set<string>();
    for (const tool of this.tools.values()) {
      tool.capabilities.forEach(cap => capabilities.add(cap));
    }
    return Array.from(capabilities);
  }

  /**
   * List all tool names and descriptions
   */
  listTools(): Array<{ name: string; description: string; capabilities: string[] }> {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      capabilities: tool.capabilities,
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
