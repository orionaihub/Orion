// src/agent.ts - Autonomous Agent Core (Export Corrected & Modularized)
import type { DurableObjectState } from '@cloudflare/workers-types';
import GeminiClient from './gemini';
import type { GenerateOptions } from './gemini';
// Import all necessary types and persistence functions
import type { Env, AgentState, Message, Tool, ToolCall, ToolResult, SqlStorage } from './types';
import * as Persistence from './persistence';

export class AutonomousAgent {
  private state: DurableObjectState;
  private env: Env;
  private sql: SqlStorage;
  private gemini: GeminiClient;
  private maxHistoryMessages = 200;
  private readonly MAX_MESSAGE_SIZE = 100_000;
  private readonly MAX_TURNS = 8;
  private activeWebSockets = new Set<WebSocket>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    // Use type assertion for the SQL storage property
    this.sql = (state.storage as unknown as { sql?: SqlStorage }).sql as SqlStorage;
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });

    // Initialize the DB using the new persistence module
    if (this.sql) {
      Persistence.createTables(this.sql);
    }
  }

  // ===== System Prompt =====

  private buildSystemPrompt(state: AgentState): string {
    const hasFiles = (state.context?.files?.length ?? 0) > 0;
    
    return `You are an autonomous AI assistant with tool-use capabilities. Your goal is to help users by breaking down complex tasks and using available tools when needed.

# Response Strategy
1. For simple questions: Answer directly without using tools
2. For complex tasks: Use available tools iteratively to gather information and complete the task
3. When you have enough information: Provide a comprehensive final answer

# Available Tools
You have access to tools for web search, code execution, file analysis, and more. Use them when they would help answer the user's question.

# Tool Usage Guidelines
- Use tools when you need current information, need to perform calculations, or analyze data
- After receiving tool results, decide if you need more information or can provide a final answer
- Don't use tools unnecessarily for questions you can answer directly
- You can use multiple tools across multiple steps to accomplish complex tasks

# Important
- Always explain your reasoning briefly
- When using tools, tell the user what you're doing
- Provide clear, actionable final answers
${hasFiles ? '- User has uploaded files available for analysis' : ''}

Your knowledge cutoff is January 2025. Use tools to access current information when needed.`;
  }

  // ===== Tool Definitions (External Only) =====

  private getAvailableTools(state: AgentState): Tool[] {
    const tools: Tool[] = [
      // Only include *truly* external tools here, e.g.:
      /*
      {
        name: 'post_to_slack',
        description: 'Posts a message to a Slack channel',
        parameters: { ... }
      }
      */
    ];
    return tools;
  }

  // ===== Tool Execution (External Only) =====

  private async executeTools(toolCalls: ToolCall[], state: AgentState): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const call of toolCalls) {
      try {
        switch (call.name) {
