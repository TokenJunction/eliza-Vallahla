export class ProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
  }
}

export class PerplexityAgentBridge {
  #key;
  #endpoint;
  #fetch;

  constructor(apiKey, endpoint = "https://api.perplexity.ai/v1/agent", fetchImpl = globalThis.fetch) {
    if (typeof apiKey !== "string" || !apiKey.trim() || /^(your[_ -]|placeholder|changeme)/i.test(apiKey.trim())) {
      throw new ProviderError("NOT_CONFIGURED", "A real server-side provider credential is required.");
    }
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new ProviderError("INVALID_ENDPOINT", "Use an HTTPS provider endpoint without URL credentials or a fragment.");
    }
    this.#key = apiKey.trim();
    this.#endpoint = url.href;
    this.#fetch = fetchImpl;
  }

  async queryAgentResult(prompt, options = {}) {
    const legacy = { sonar: "fast", "sonar-pro": "fast", "sonar-reasoning-pro": "low", "sonar-deep-research": "high" };
    const model = options.model ?? "sonar";
    if (!Object.hasOwn(legacy, model)) throw new ProviderError("INVALID_MODEL", "This compatibility adapter requires a supported Sonar model mapping.");
    if (options.searchType !== undefined && options.searchType !== "fast" && options.searchType !== "pro") {
      throw new ProviderError("INVALID_INPUT", "Unsupported search type.");
    }
    const effort = options.searchType === "pro" && legacy[model] === "fast" ? "low" : legacy[model];
    const timeoutMs = options.timeoutMs ?? 15000;
    const maxOutputTokens = options.maxOutputTokens ?? 1024;
    const temperature = options.temperature ?? 0.2;
    if (typeof prompt !== "string" || !prompt.trim() || new TextEncoder().encode(prompt).length > 65536) {
      throw new ProviderError("INVALID_INPUT", "Provide a non-empty prompt of at most 65536 UTF-8 bytes; input is never truncated.");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 4096 || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new ProviderError("INVALID_INPUT", "Invalid timeout, output-token budget, or temperature.");
    }
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    try {
      signal.throwIfAborted();
      const response = await this.#fetch(this.#endpoint, {
        method: "POST", redirect: "error", signal,
        headers: { Authorization: `Bearer ${this.#key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ effort, input: prompt, temperature, max_output_tokens: maxOutputTokens, max_tool_calls: 2, store: false }),
      });
      if (!response.ok) {
        if (response.body) await response.body.cancel();
        throw new ProviderError("HTTP_ERROR", `Provider returned HTTP ${response.status}.`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new ProviderError("INVALID_RESPONSE", "Provider response has no readable body.");
      const chunks = [];
      let bytes = 0;
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > 524288) {
          await reader.cancel();
          throw new ProviderError("RESPONSE_TOO_LARGE", "Provider response exceeds 524288 bytes.");
        }
        chunks.push(item.value);
      }
      const joined = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
      const data = JSON.parse(new TextDecoder().decode(joined));
      if (data?.status !== "completed" || data.error || data.incomplete_details) {
        throw new ProviderError("INCOMPLETE_RESPONSE", "Provider did not complete the request.");
      }
      const output = Array.isArray(data.output) ? data.output : [];
      const content = output.filter((item) => item.type === "message" && item.role === "assistant")
        .flatMap((item) => Array.isArray(item.content) ? item.content : [])
        .filter((item) => item.type === "output_text" && typeof item.text === "string")
        .map((item) => item.text).join("\n") || (typeof data.output_text === "string" ? data.output_text : "");
      if (!content.trim()) throw new ProviderError("EMPTY_RESPONSE", "Provider returned no answer text.");
      const sources = output.filter((item) => item.type === "search_results")
        .flatMap((item) => Array.isArray(item.results) ? item.results : []);
      return { content, sources, provider: "perplexity-agent", effort };
    } catch (error) {
      if (options.signal?.aborted) throw new ProviderError("CANCELLED", "Provider request was cancelled.");
      if (deadline.aborted) throw new ProviderError("TIMEOUT", "Provider request exceeded its deadline.");
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("REQUEST_FAILED", "Provider request failed; response bodies and credentials are not included in this error.");
    }
  }

  async queryAgent(prompt, options = {}) {
    const result = await this.queryAgentResult(prompt, options);
    return result.content + (result.sources.length ? `\n\nSource metadata:\n${JSON.stringify(result.sources)}` : "");
  }
}
