import { PerplexityAgentBridge as SharedBridge, type PerplexityAgentOptions } from "../../packages/valhalla-brain-api/src/perplexity-bridge.ts";
export { ProviderError } from "../../packages/valhalla-brain-api/src/perplexity-bridge.ts";
export type { PerplexityAgentOptions, PerplexityAgentResult } from "../../packages/valhalla-brain-api/src/perplexity-bridge.ts";

export class PerplexityAgentBridge extends SharedBridge {
  constructor(apiKey: string, baseUrl?: string) {
    const env = typeof process !== "undefined" ? process.env : undefined;
    const base = (baseUrl || env?.PERPLEXITY_BASE_URL || "https://api.perplexity.ai").replace(/\/+$/, "");
    super(apiKey, `${base}${base.endsWith("/v1") ? "/agent" : "/v1/agent"}`);
  }

  override queryAgentResult(prompt: string, options: PerplexityAgentOptions = {}) {
    const env = typeof process !== "undefined" ? process.env : undefined;
    return super.queryAgentResult(prompt, { ...options, model: options.model ?? env?.DEFAULT_SEARCH_MODEL ?? "sonar" });
  }
}
