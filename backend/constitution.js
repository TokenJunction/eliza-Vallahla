import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const READONLY = new Set(["voice", "reasoning", "paper", "view", "chat"]);
const DRAFT_TOOLS = new Set(["paper-quote", "status"]);

export const POLICIES = Object.freeze({
  nominal: Object.freeze({
    id: "nominal",
    spendUsd: 0,
    liveTrading: false,
    executionPolicy: "none",
    effects: Object.freeze({
      readonly: Object.freeze(["voice", "reasoning", "paper", "view", "chat"]),
      draft: Object.freeze(["paper-quote", "status"]),
      execute: Object.freeze([]),
    }),
  }),
});

export function policyForAccount(accountId) {
  if (!accountId) return null;
  return POLICIES.nominal;
}

export function constitutionDocument(account = {}) {
  const ceiling = Number(account.spendCeilingUsd);
  const spendCeilingUsd = Number.isFinite(ceiling) && ceiling >= 0 && ceiling <= 1000 ? ceiling : 0;
  return {
    pending: false,
    ownerRole: "owner",
    execution: {
      local: { cap: 1 },
      cloud: { cap: 1 },
    },
    spendCeilingUsd,
    liveTrading: false,
    executionPolicy: "none",
  };
}

function finiteCap(value) {
  return Number.isInteger(value) && value >= 0 && value <= 8;
}

export function evaluateConstitution(doc) {
  if (!doc || typeof doc !== "object") return { ok: false, verified: false, reason: "document" };
  if (doc.pending !== false) return { ok: false, verified: false, reason: "pending" };
  if (doc.ownerRole !== "owner") return { ok: false, verified: false, reason: "owner-role" };
  if (Object.prototype.hasOwnProperty.call(doc, "ownerEmail")) return { ok: false, verified: false, reason: "owner-email" };
  if (doc.completed === true) return { ok: false, verified: false, reason: "completion" };
  if (!finiteCap(doc.execution && doc.execution.local && doc.execution.local.cap)) {
    return { ok: false, verified: false, reason: "local-cap" };
  }
  if (!finiteCap(doc.execution && doc.execution.cloud && doc.execution.cloud.cap)) {
    return { ok: false, verified: false, reason: "cloud-cap" };
  }
  const ceiling = doc.spendCeilingUsd;
  if (typeof ceiling !== "number" || !Number.isFinite(ceiling) || ceiling < 0 || ceiling > 1000) {
    return { ok: false, verified: false, reason: "spend-ceiling" };
  }
  if (doc.liveTrading !== false || doc.executionPolicy !== "none") {
    return { ok: false, verified: false, reason: "live-trading" };
  }
  return { ok: true, verified: true, pending: false, liveTrading: false, ownerEmail: null };
}

export function constitutionSchema() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "AgentConstitution.json");
  return JSON.parse(readFileSync(root, "utf8"));
}

export function classifyAction(body) {
  const capability = String(body && body.capability || "");
  const tool = body && body.tool && body.tool !== "" ? String(body.tool) : "none";
  if (!READONLY.has(capability)) return { ok: false, reason: "capability_rejected", execute: false };
  if (tool === "none") return { ok: true, effect: "readonly", execute: false };
  if (DRAFT_TOOLS.has(tool)) return { ok: true, effect: "draft", execute: false };
  return { ok: false, reason: "effect_rejected", execute: false };
}

export function executionDecision(session, env = {}) {
  const selected = policyForAccount(session && session.userId);
  const document = constitutionDocument({
    spendCeilingUsd: Number(env.VALHALLA_BUDGET_USD || 0),
  });
  const graded = evaluateConstitution(document);
  const ceiling = graded.ok ? document.spendCeilingUsd : 0;
  const cloudKey = Boolean(env.DEEPSEEK_API_KEY || env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY);
  const cloudModel = Boolean(env.DEEPSEEK_MODEL || env.GEMINI_MODEL);
  const permitted = session && session.cloudPermitted === true && ceiling > 0;
  const local = String(env.VALHALLA_LOCAL_RELAY) === "1";
  if (!graded.ok || !selected) {
    return { environment: null, available: false, fallback: false, reason: graded.reason || "policy" };
  }
  if (local) {
    return {
      environment: "local",
      available: true,
      fallback: false,
      spendCeilingUsd: 0,
      policyId: selected.id,
      liveTrading: false,
    };
  }
  if (cloudKey && cloudModel && permitted) {
    return {
      environment: "cloud",
      available: true,
      fallback: true,
      spendCeilingUsd: ceiling,
      policyId: selected.id,
      liveTrading: false,
    };
  }
  return {
    environment: null,
    available: false,
    fallback: false,
    reason: "unavailable",
    spendCeilingUsd: 0,
    policyId: selected.id,
    liveTrading: false,
  };
}
