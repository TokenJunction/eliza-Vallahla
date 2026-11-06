// Advisory record only. A wallet link and a root session do not enable execution.
// No signing key is stored or derived from a login, a wallet signature, or a seed.

export function createFlywheelGrant(account) {
  return {
    tenant: account.tenantId,
    subject: account.subject,
    strategyId: String(account.strategyId || "none"),
    agentId: "flywheel",
    supervisor: "zeus",
    status: "disabled",
    advisory: true,
    execution: false,
    walletScope: "bound-specific",
    allowedMints: [],
    allowedPairs: [],
    programAllowlist: [],
    maxAtomicInput: 0,
    dailySpend: { reserved: 0, actual: 0 },
    lifetimeSpend: { reserved: 0, actual: 0 },
    slippageCapBps: 0,
    routeLength: 0,
    expiresAt: null,
    minIntervalMs: 0,
    maxConcurrentTasks: 0,
    revocationVersion: 1,
    seedAccess: false,
    delegatedExecution: "unavailable",
  };
}

export function enableFlywheel(grant, actor) {
  return {
    ok: false,
    execution: false,
    status: grant.status,
    reason: actor && actor.owner === true ? "owner-cannot-enable" : "separately-approved-required",
  };
}

export function haltFlywheel(grant, reason) {
  grant.status = "disabled";
  grant.execution = false;
  grant.delegatedExecution = "unavailable";
  grant.revocationVersion += 1;
  grant.pending = false;
  grant.halt = reason;
  return { ok: true, execution: false, status: "disabled", revocationVersion: grant.revocationVersion };
}

export function reviewSubmission(grant, tx) {
  if (!grant || grant.status !== "active" || grant.execution !== true) {
    return { ok: false, executed: false, reserved: 0, reason: "delegated-execution-unavailable" };
  }
  const instructions = Array.isArray(tx && tx.instructions) ? tx.instructions : null;
  if (!instructions) return { ok: false, executed: false, reserved: 0, reason: "tx" };
  const allowed = new Set(grant.programAllowlist || []);
  for (const item of instructions) {
    if (!allowed.has(item.programId)) return { ok: false, executed: false, reserved: 0, reason: "program" };
  }
  return { ok: false, executed: false, reserved: 0, reason: "architecture-unreviewed" };
}
