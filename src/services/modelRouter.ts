import { PerplexityAgentBridge, type PerplexityAgentOptions } from "./perplexityBridge.ts";

export interface ModelRouterConfig {
  perplexityApiKey?: string;
  geminiApiKey?: string;
  defaultModel?: string;
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
  private geminiKey: string | null = null;

  constructor(config: ModelRouterConfig = {}) {
    const env = typeof process !== "undefined" ? process.env : undefined;
    const key = config.perplexityApiKey || env?.PERPLEXITY_API_KEY;
    if (key?.trim()) this.perplexityBridge = new PerplexityAgentBridge(key);
    this.geminiKey = (config.geminiApiKey || env?.GEMINI_API_KEY)?.trim() || null;
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
    let attempted = false;
    if (this.perplexityBridge && (options.tier === "fast" || options.tier === undefined)) {
      attempted = true;
      try {
        const content = await this.perplexityBridge.queryAgent(prompt, {
          model: options.model ?? "sonar",
          temperature: options.temperature ?? 0.2,
        });
        if (typeof content === "string" && content.trim() && content !== "No content returned from Perplexity.") {
          return { content, provider: "perplexity-sonar" };
        }
      } catch {
        // Keep provider error bodies and credentials out of logs and user responses.
      }
    }
    if (this.geminiKey) {
      attempted = true;
      try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(this.geminiKey)}`;
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 1024, temperature: options.temperature ?? 0.7 },
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (response.ok) {
          const data = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
          const content = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
          if (content.trim()) return { content, provider: "gemini-2.0-flash" };
        }
      } catch {
        // Return a typed failure below, not a fabricated model answer.
      }
    }
    throw new ModelRoutingError(
      attempted ? "PROVIDER_UNAVAILABLE" : "PROVIDER_NOT_CONFIGURED",
      attempted ? "The configured providers did not return a usable answer." : "No provider is configured for this request.",
    );
  }
}
