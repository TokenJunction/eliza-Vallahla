/**
 * Frontend mock adapters for the Valhalla desk prototype.
 *
 * Nothing in this file opens a network connection. The UI must say that.
 *
 * TODO(integration): Forge replaces MockCredentialVault with a Render server
 * vault. The browser may submit a secret once and must then drop it. The
 * server must not echo the secret. Do not write browser web storage, cookie
 * jars, the indexed database, or URLs.
 *
 * TODO(integration): Replace the mock probe with a server check: reachability,
 * then model discovery. Do not spend on a chat call until Wren approves.
 * Never treat a software license or Plus as provider credit or balance.
 *
 * TODO(integration): Gemini Live is a stateful WebSocket multimodal API.
 * Gemini API speech generation is a separate text-to-speech capability.
 * Neither is a browser speech API. Keep both disabled
 * until a real adapter and customer credentials exist.
 *
 * TODO(integration): DeepSeek reasoning needs its own request path. Send
 * thinking.type and reasoning_effort. Read reasoning_content separately from
 * the answer text. Do not infer connectivity from a subscription.
 *
 * TODO(integration): Local Ollama works only while that computer and the
 * Ollama process are awake. Cloud Ollama needs its own key or sign-in.
 * Odin prefer-local then explicit cloud fallback is product policy. It is
 * not native Ollama failover. Do not mark either path connected from
 * configuration alone.
 *
 * TODO(integration): Google Drive OAuth is separate from Valhalla sign-in.
 * Do not reuse sign-in or Gmail scopes.
 *
 * TODO(integration): Telegram and X need the customer's own app credentials
 * on the server. Stay not connected until those credentials exist.
 *
 * TODO(integration): Service start and app install must call the deployment
 * controller. This mock records intent only. A free Render service spins
 * down after about 15 minutes without traffic.
 *
 * TODO(integration): Database and cache settings are the customer's own
 * Supabase project and Upstash database.
 */

import type { SecretId } from "./model.ts";

export class MockCredentialVault {
  readonly #secrets = new Map<SecretId, string>();

  save(id: SecretId, value: string): void {
    this.#secrets.set(id, value);
  }

  has(id: SecretId): boolean {
    return this.#secrets.has(id);
  }

  /** Test access. The desk UI must not render this value. */
  readForTest(id: SecretId): string | null {
    return this.#secrets.get(id) ?? null;
  }
}

export type DrivePhase =
  | "not-authorized"
  | "pending"
  | "authorized-mock"
  | "error";

export function beginMockDriveConnect(): "pending" {
  return "pending";
}

export function finishMockDriveConnect(
  mode: "authorize" | "fail",
): "authorized-mock" | "error" {
  return mode === "fail" ? "error" : "authorized-mock";
}

export function mockDriveDisconnect(): "not-authorized" {
  return "not-authorized";
}

export function mockServiceStart(): "mock-start-recorded" {
  return "mock-start-recorded";
}

export function mockServiceStop(): "stopped" {
  return "stopped";
}
