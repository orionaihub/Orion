// src/tools/registry.ts - External Tool Registry
import type { Tool, ToolResult, ToolDefinition } from './types';
import type { AgentState } from '../types';

/**
 * Registry for external tools
 * Manages registration, retrieval, and execution of external tools
 */
export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  /**
   * Register a new external tool
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      console.warn(`[ToolRegistry] Tool "${tool.name}" already registered, overwriting`);
    }
    this.tools.set(tool.name, tool);
    console.log(`[ToolRegistry] Registered tool: ${tool.name}`);
  }

  /**
   * Unregister an external tool
   */
  unregister(name: string): boolean {
    const existed = this.tools.delete(name);
    if (existed) {
      console.log(`[ToolRegistry] Unregistered tool: ${name}`);
    }
    return existed;
  }

  /**
   * Get a specific tool by name
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tools
   */
  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tool definitions for LLM (without execute function)
   */
  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  /**
   * Check if a tool is registered
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Execute a tool by name
   */
  async execute(
    name: string,
    args: Record<string, any>,
    state: AgentState
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);

    if (!tool) {
      return {
        name,
        success: false,
        result: `Tool "${name}" not found in registry`,
      };
    }

    try {
      console.log(`[ToolRegistry] Executing tool: ${name}`);
      const result = await tool.execute(args, state);
      console.log(`[ToolRegistry] Tool ${name} completed: ${result.success ? 'success' : 'failed'}`);
      return result;
    } catch (e) {
      console.error(`[ToolRegistry] Tool ${name} threw error:`, e);
      return {
        name,
        success: false,
        result: `Tool execution error: ${String(e)}`,
      };
    }
  }

  /**
   * Get count of registered tools
   */
  count(): number {
    return this.tools.size;
  }

  /**
   * Clear all registered tools
   */
  clear(): void {
    this.tools.clear();
    console.log('[ToolRegistry] Cleared all tools');
  }

  /**
   * Get list of registered tool names
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }
}
