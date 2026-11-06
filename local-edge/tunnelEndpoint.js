const CLOUD_HOST = "eliza-valhalla.onrender.com";

function cleanUrl(input) {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function loopbackHost(hostname) {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

export function validateTunnelUrl(input) {
  const url = cleanUrl(input);
  if (!url) return { ok: false, reason: "url-rejected" };
  if (url.username || url.password || url.search || url.hash) return { ok: false, reason: "url-rejected" };
  if (url.pathname !== "/" && url.pathname !== "") return { ok: false, reason: "url-rejected" };
  if (url.hostname !== CLOUD_HOST) return { ok: false, reason: "host-rejected" };
  if (url.port && url.port !== "443") return { ok: false, reason: "url-rejected" };
  if (url.protocol !== "https:" && url.protocol !== "wss:") return { ok: false, reason: "wss-required" };
  return { ok: true, url: `wss://${CLOUD_HOST}`, path: "/relay", authBypass: false };
}

export function resolveTestTransport(input, env) {
  if (!env || env.NODE_ENV !== "test") return { ok: false, reason: "test-transport-rejected", authBypass: false };
  const url = cleanUrl(input);
  if (!url || url.protocol !== "http:" || !loopbackHost(url.hostname)) {
    return { ok: false, reason: "test-transport-rejected", authBypass: false };
  }
  if (url.port === "11434") return { ok: false, reason: "ollama-port-refused", authBypass: false };
  if (url.username || url.password || url.search || url.hash) {
    return { ok: false, reason: "test-transport-rejected", authBypass: false };
  }
  if (url.pathname !== "/" && url.pathname !== "") return { ok: false, reason: "test-transport-rejected", authBypass: false };
  return { ok: true, url: url.origin, path: "/relay", testTransport: true, authBypass: false };
}

export async function resolveCloudPolicy(policy, reason) {
  if (typeof policy !== "function") return { runCloud: false };
  try {
    const decision = await policy({ available: false, reason });
    if (decision && decision.authorized === true && decision.runCloud === true) return { runCloud: true };
  } catch {
    return { runCloud: false };
  }
  return { runCloud: false };
}

export function createBoundedQueue(max = 5) {
  const items = [];
  return {
    push(item) {
      if (items.length >= max) return { ok: false, reason: "queue-full" };
      items.push(item);
      return { ok: true };
    },
    shift() {
      return items.shift();
    },
    clear() {
      items.length = 0;
    },
    get size() {
      return items.length;
    },
  };
}
