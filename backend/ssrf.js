import { isIP } from "node:net";

const BLOCKED_NAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google.com",
]);

export function ipv4FromDecimal(host) {
  if (!/^\d+$/.test(host)) return null;
  const value = Number(host);
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) return null;
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join(".");
}

export function ipv4FromDotted(host) {
  const parts = String(host || "").split(".");
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => {
    if (!/^(0x[0-9a-f]+|0[0-7]+|[0-9]+)$/i.test(part)) return null;
    const value = part.startsWith("0x") || part.startsWith("0X")
      ? Number.parseInt(part.slice(2), 16)
      : part.length > 1 && part.startsWith("0")
        ? Number.parseInt(part, 8)
        : Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255 ? value : null;
  });
  if (numbers.some((value) => value === null)) return null;
  return numbers.join(".");
}

export function isPrivateAddress(address) {
  const host = String(address || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  if (host.startsWith("::ffff:")) {
    const mapped = host.slice("::ffff:".length);
    if (mapped.includes(".")) return isPrivateAddress(mapped);
    return true;
  }
  const decimal = ipv4FromDecimal(host);
  const ip = decimal || host;
  if (isIP(ip) !== 4) return isIP(ip) === 6;
  const [a, b] = ip.split(".").map(Number);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function classifyUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
  if (url.username || url.password) return { ok: false, reason: "credentials" };
  if (url.protocol !== "https:") return { ok: false, reason: "scheme" };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || BLOCKED_NAMES.has(host) || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, reason: "blocked-name" };
  }
  const dotted = ipv4FromDotted(host);
  if (/^\d+$/.test(host) || host.startsWith("0x") || dotted || isIP(host) || host.includes(":")) {
    if (isPrivateAddress(dotted || host) || isIP(host) === 0) return { ok: false, reason: "private-address" };
  }
  const decimal = ipv4FromDecimal(host);
  if (decimal && isPrivateAddress(decimal)) return { ok: false, reason: "private-address" };
  const port = url.port;
  if (port && port !== "443") return { ok: false, reason: "port" };
  return { ok: true, url, host };
}

export async function assertPublicTarget(raw, resolveImpl) {
  const target = classifyUrl(raw);
  if (!target.ok) return target;
  const lookup = resolveImpl || (async (host) => {
    const dns = await import("node:dns/promises");
    const rows = await dns.lookup(host, { all: true, verbatim: true });
    return rows.map((row) => row.address);
  });
  let addresses = [];
  try {
    addresses = await lookup(target.host);
  } catch {
    return { ok: false, reason: "dns-failed" };
  }
  if (!Array.isArray(addresses) || addresses.length === 0) return { ok: false, reason: "dns-failed" };
  if (addresses.some((address) => isPrivateAddress(address))) return { ok: false, reason: "dns-private" };
  return { ok: true, href: target.url.href, host: target.host };
}
