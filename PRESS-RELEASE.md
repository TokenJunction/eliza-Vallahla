# FOR IMMEDIATE RELEASE

## TokenJunction introduces Thales, Valhalla's market-aware assistant in development

**November 4, 2026** — TokenJunction is developing **Thales**, a conversational assistant for the Valhalla browser desk, with a focus on clear answers, streamed conversation, and market data that is identified rather than guessed.

The current Valhalla source configures Thales to use DeepSeek's `deepseek-chat` API through a server-side Worker. For questions about Solana trends, the Worker can retrieve current public token-boost and pair information from DexScreener, then pass that snapshot to the model. The interface streams text as it arrives and can read completed replies aloud when voice replies are enabled.

### Built around evidence, not hype

Thales is designed to explain what the available data says, name its source, and state when current data cannot be verified. DexScreener's boosted-token rankings can reflect promotional activity; they are not proof of organic popularity, token safety, or investment merit. A trend snapshot is not a trading signal.

The assistant is intended as an informational tool for users discussing goals and risk with their own qualified advisers. It is not a licensed financial adviser, does not promise returns, and does not execute trades. Valhalla's live-money trading remains disabled.

### Current status

The chat Worker and automated tests are in the Valhalla website repository. Its production deployment status could not be verified from this environment, which has no authenticated Cloudflare session. Deployment requires an authenticated Cloudflare account and a DeepSeek API key stored as a server-side secret. API usage may incur provider charges; free or unlimited access is not guaranteed.

The ElizaOS runtime connection is **not yet verified or configured**. The previously supplied `TokenJunction/Paradev` repository is a desktop workspace for running CLI coding agents; it is not an ElizaOS runtime. TokenJunction will not describe Thales as an ElizaOS-connected agent until the correct runtime, API endpoint, credentials, tool integration, and end-to-end tests are in place.

The chat path applies input checks and a configured per-IP rate limit. It does not provide identity-level abuse prevention. The desk keeps up to eight recent turns in browser memory for conversation context, not local storage. Users should not submit seed phrases, private keys, account credentials, or confidential client information. The website chat request does not include the user's sign-in email or display name; Cloudflare still processes network metadata for rate limiting and security, and DeepSeek processes submitted chat text and recent context to generate replies.

This repository update contains source and documentation only. It does not announce or provide Android or Windows downloads, model-weight downloads, or a trained/fine-tuned model.

**About Valhalla:** Valhalla is a TokenJunction LLC project focused on a browser-based read-only desk and simulated paper trading tools. Sample results are simulated and are not a promise of future performance.
