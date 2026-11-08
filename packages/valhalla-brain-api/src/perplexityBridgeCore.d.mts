export interface PerplexityAgentOptions {
  model?: string;
  searchType?: "fast" | "pro";
  temperature?: number;
  timeoutMs?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}
export interface PerplexityAgentResult {
  content: string;
  sources: unknown[];
  provider: "perplexity-agent";
  effort: string;
}
export class ProviderError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}
export class PerplexityAgentBridge {
  constructor(apiKey: string, endpoint?: string, fetchImpl?: typeof fetch);
  queryAgentResult(prompt: string, options?: PerplexityAgentOptions): Promise<PerplexityAgentResult>;
  queryAgent(prompt: string, options?: PerplexityAgentOptions): Promise<string>;
}
