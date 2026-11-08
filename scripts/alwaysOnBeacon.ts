import { freemem, totalmem, uptime } from "node:os";

// Host observations only. This process does not trade, call models, or broadcast to an unauthenticated bridge.
const intervalMs = Number(process.env.BEACON_INTERVAL_MS ?? "60000");
if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3600000) {
  throw new Error("BEACON_INTERVAL_MS must be an integer from 1000 to 3600000.");
}

function pulse() {
  process.stdout.write(`${JSON.stringify({
    source: "VALHALLA_HOST_BEACON",
    status: "OBSERVED",
    timestamp: new Date().toISOString(),
    processUptimeSeconds: Math.floor(process.uptime()),
    hostUptimeSeconds: Math.floor(uptime()),
    memory: { freeBytes: freemem(), totalBytes: totalmem(), processRssBytes: process.memoryUsage().rss },
    modelHealth: "NOT_CHECKED",
    relayHealth: "NOT_CHECKED",
  })}\n`);
}

pulse();
const timer = setInterval(pulse, intervalMs);
process.once("SIGTERM", () => clearInterval(timer));
process.once("SIGINT", () => clearInterval(timer));
