// Add this method to your GeminiClient class in gemini.ts

async executeUnifiedAutonomous(
  params: {
    userRequest: string;
    currentPhase: string;
    conversationHistory: Array<{ role: string; parts: any[] }>;
    availableTools: string[];
    files?: FileMetadata[];
    urlList?: string[];
  },
  onChunk?: (text: string) => void
): Promise<{
  response: string;
  phaseChanges?: string[];
  clarificationRequests?: string[];
  toolCalls?: Array<{ tool: string; params: any }>;
}> {
  return this.withRetry(async () => {
    // Build unified prompt
    const prompt = `You are an autonomous agent. Current phase: ${params.currentPhase}

Available tools: ${params.availableTools.join(', ')}

User request: ${params.userRequest}

Respond with your analysis and answer. If you need clarification, ask questions.
If you use tools, explain what you're doing.`;

    // Determine which tools to enable based on availableTools
    const tools: Array<Record<string, unknown>> = [];
    const hasFiles = (params.files ?? []).length > 0;
    const hasUrls = (params.urlList ?? []).length > 0;

    if (params.availableTools.includes('search_grounding')) {
      tools.push({ googleSearch: {} });
    }
    if (params.availableTools.includes('code_execution')) {
      tools.push({ codeExecution: {} });
    }
    if (params.availableTools.includes('file_analysis') && hasFiles) {
      tools.push({ fileAnalysis: {} });
    }
    if (params.availableTools.includes('url_context') && hasUrls) {
      tools.push({ urlContext: {} });
    }
    if (params.availableTools.includes('vision') && hasFiles) {
      tools.push({ vision: {} });
    }

    // Build contents
    const contents = this.buildContents(
      prompt,
      params.conversationHistory,
      params.files,
      params.urlList
    );

    // Execute with streaming
    const streamCall = this.ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents,
      config: {
        thinkingConfig: { thinkingBudget: 2048 },
        tools: tools.length ? tools : undefined,
        stream: true,
      },
    } as any);

    const responseText = await this.handleStreamedResponse(streamCall, onChunk);

    // Parse response for phase changes, clarifications, etc.
    // For now, return simple response
    return {
      response: responseText || 'I apologize, but I encountered an issue processing your request.',
      phaseChanges: [],
      clarificationRequests: [],
      toolCalls: [],
    };
  });
}
