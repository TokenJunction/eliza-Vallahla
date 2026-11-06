import { assertPublicTarget } from "./ssrf.js";

// The checked-in runtime exposes one public status route, not a shell or plugin executor.
export const ELIZA_STATUS_PATH = "/api/valhalla/health";
export const ELIZA_PLUGIN = "valhalla-status";

export async function runElizaTask(input, deps = {}) {
  const serviceUrl = String(input.serviceUrl || "").replace(/\/+$/, "");
  const serviceToken = String(input.serviceToken || "");
  const providerToken = String(input.providerToken || "");
  if (!serviceUrl || !serviceToken) {
    return { status: "UNAVAILABLE", text: null, calls: 0, reason: "eliza-not-configured" };
  }
  if (providerToken && providerToken === serviceToken) {
    return { status: "UNAVAILABLE", text: null, calls: 0, reason: "token-not-eliza" };
  }
  if (typeof deps.fetchImpl !== "function") {
    return { status: "UNAVAILABLE", text: null, calls: 0, reason: "eliza-not-configured" };
  }
  const target = await assertPublicTarget(`${serviceUrl}${ELIZA_STATUS_PATH}`, deps.resolveImpl);
  if (!target.ok) return { status: "UNAVAILABLE", text: null, calls: 0, reason: "eliza-url-rejected" };
  const response = await deps.fetchImpl(target.href, {
    method: "GET",
    headers: { authorization: `Bearer ${serviceToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  const body = await response.json().catch(() => null);
  const capabilities = body && body.capabilities;
  const generation = capabilities && capabilities.generation === "enabled";
  if (!response.ok || !generation) {
    return {
      status: "UNAVAILABLE",
      text: null,
      calls: 1,
      reason: "eliza-generate-not-supported",
      plugin: ELIZA_PLUGIN,
      service: body && body.service ? body.service : null,
    };
  }
  return { status: "UNAVAILABLE", text: null, calls: 1, reason: "eliza-generate-not-supported", plugin: ELIZA_PLUGIN };
}
