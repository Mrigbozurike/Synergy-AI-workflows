/**
 * Provider-agnostic message model. Deliberately a small subset of what any one
 * vendor offers: everything the agent loop needs, nothing it doesn't. Swapping
 * providers (or adding a recorded/replay provider for evals) touches only the
 * adapter, never the agent.
 */
export type TextBlock = { type: 'text'; text: string };
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type ToolResultBlock = {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
};
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export type Message = { role: 'user' | 'assistant'; content: ContentBlock[] };

export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
};

export type CompletionRequest = {
  model: string;
  system: string;
  messages: Message[];
  tools?: ToolSpec[];
  maxTokens: number;
  temperature?: number;
};

export type Usage = { inputTokens: number; outputTokens: number };

export type CompletionResponse = {
  model: string;
  content: ContentBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  usage: Usage;
};

export interface LLMProvider {
  readonly name: string;
  complete(req: CompletionRequest, opts?: { signal?: AbortSignal }): Promise<CompletionResponse>;
}
