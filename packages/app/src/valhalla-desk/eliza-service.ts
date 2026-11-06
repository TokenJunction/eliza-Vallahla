/**
 * Optional ElizaOS HTTP boundary for the desk.
 * This module does not import the app runtime. A base URL is off until the
 * operator sets a public address. Health is a real GET. A response is not
 * treated as connected plugins or tools.
 */

export type ElizaHealth =
  | { state: "not-configured"; detail: string }
  | { state: "unreachable"; detail: string }
  | { state: "unavailable"; status: number; detail: string }
  | { state: "responding"; status: number; detail: string };

export function elizaHealthUrl(baseUrl: string): string | null {
  const trimmed = baseUrl.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !local) return null;
  if (url.username || url.password) return null;
  url.pathname = "/health";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function checkElizaHealth(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ElizaHealth> {
  const target = elizaHealthUrl(baseUrl);
  if (!target) {
    return {
      state: "not-configured",
      detail:
        "ElizaOS is optional and not configured. No service was called. Not connected.",
    };
  }
  try {
    const response = await fetchImpl(target, { method: "GET" });
    if (!response.ok) {
      return {
        state: "unavailable",
        status: response.status,
        detail: `ElizaOS health returned HTTP ${String(response.status)}. Plugins and tools were not enabled. Not connected.`,
      };
    }
    return {
      state: "responding",
      status: response.status,
      detail:
        "ElizaOS health responded. This is not permission to run plugins or tools. Not connected until a later call is allowed.",
    };
  } catch {
    return {
      state: "unreachable",
      detail: "ElizaOS health could not be reached. Not connected.",
    };
  }
}
