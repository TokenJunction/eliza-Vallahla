import { PerplexityAgentBridge, type PerplexityAgentOptions } from "./perplexityBridge.ts";

export interface ModelRouterConfig {
  perplexityApiKey?: string;
  geminiApiKey?: string;
  defaultModel?: string;
  geminiModel?: string;
}

export interface RoutePromptOptions extends PerplexityAgentOptions {
  tier?: "fast" | "deep" | "local";
}

export class ModelRoutingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ModelRoutingError";
    this.code = code;
  }
}

export class ModelStackRouter {
  private perplexityBridge: PerplexityAgentBridge | null = null;
  private geminiKey: string | null;
  private geminiModel: string | null;
  private searchModel: string;

  constructor(config: ModelRouterConfig = {}) {
    const env = typeof process !== "undefined" ? process.env : undefined;
    const key = config.perplexityApiKey || env?.PERPLEXITY_API_KEY;
    if (key?.trim()) this.perplexityBridge = new PerplexityAgentBridge(key);
    this.geminiKey = (config.geminiApiKey || env?.GEMINI_API_KEY)?.trim() || null;
    this.geminiModel = (config.geminiModel || env?.GEMINI_MODEL)?.trim() || null;
    this.searchModel = config.defaultModel ?? env?.DEFAULT_SEARCH_MODEL ?? "sonar";
  }

  async routePrompt(prompt: string, options: RoutePromptOptions = {}): Promise<{ content: string; provider: string }> {
    if (options.tier === "local") {
      throw new ModelRoutingError("LOCAL_PROVIDER_NOT_CONFIGURED", "This router has no local adapter. No cloud request was sent.");
    }
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new ModelRoutingError("INVALID_PROMPT", "A non-empty prompt is required.");
    }
    if (options.tier !== undefined && options.tier !== "fast" && options.tier !== "deep") {
      throw new ModelRoutingError("INVALID_TIER", "The requested routing tier is not supported.");
    }
    if (options.tier === "fast" && !this.perplexityBridge) {
      throw new ModelRoutingError("PROVIDER_NOT_CONFIGURED", "The grounded research provider is not configured.");
    }
    if (this.perplexityBridge && (options.tier === "fast" || options.tier === undefined)) {
      const content = await this.perplexityBridge.queryAgent(prompt, {
        ...options, model: options.model ?? this.searchModel,
      });
      return { content, provider: "perplexity-agent" };
    }
    if (!this.geminiKey || !this.geminiModel) {
      throw new ModelRoutingError("PROVIDER_NOT_CONFIGURED", "Configure a provider key and an explicit model for this request.");
    }
    const model = this.geminiModel.replace(/^models\//, "");
    const timeoutMs = options.timeoutMs ?? 15000;
    const maxOutputTokens = options.maxOutputTokens ?? 1024;
    const temperature = options.temperature ?? 0.7;
    if (!/^[A-Za-z0-9._-]+$/.test(model) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 4096 || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new ModelRoutingError("INVALID_CONFIGURATION", "Invalid model, timeout, output-token budget, or temperature.");
    }
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    try {
      signal.throwIfAborted();
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(this.geminiKey)}`;
      const response = await fetch(endpoint, {
        method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens, temperature },
        }),
      });
      if (!response.ok) throw new ModelRoutingError("PROVIDER_UNAVAILABLE", `Provider returned HTTP ${response.status}.`);
      const data = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const content = data.candidates?.[0]?.content?.parts?.map((part) => typeof part.text === "string" ? part.text : "").join("") ?? "";
      if (!content.trim()) throw new ModelRoutingError("EMPTY_RESPONSE", "Provider returned no answer text.");
      return { content, provider: `gemini:${model}` };
    } catch (error) {
      if (options.signal?.aborted) throw new ModelRoutingError("CANCELLED", "Provider request was cancelled.");
      if (deadline.aborted) throw new ModelRoutingError("TIMEOUT", "Provider request exceeded its deadline.");
      if (error instanceof ModelRoutingError) throw error;
      throw new ModelRoutingError("PROVIDER_UNAVAILABLE", "Provider request failed without a usable answer.");
    }
  }
}
