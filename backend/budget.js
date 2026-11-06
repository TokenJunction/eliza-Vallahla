// Single-process budget helper. distributed and atomic stay false.
// This queue stops two overlapping reserves in one process. It is not a
// distributed transaction.

export function createBudgetLedger() {
  let chain = Promise.resolve();
  const jobs = new Map();
  const balances = new Map();

  function select(input) {
    const tenantId = input && input.tenantId;
    const jobId = input && input.jobId;
    const capUsd = Number(input && input.capUsd);
    const amount = Number(input && input.amount);
    if (!tenantId || !jobId) return { ok: false, reason: "job", reserved: 0 };
    if (!Number.isFinite(capUsd) || capUsd < 0 || capUsd > 1000) return { ok: false, reason: "ceiling", reserved: 0 };
    const existing = jobs.get(jobId);
    if (existing) {
      if (existing.tenantId !== tenantId) return { ok: false, reason: "tenant", reserved: 0 };
      return { ok: true, same: true, reserved: existing.reserved, jobId };
    }
    if (!Number.isFinite(amount) || amount < 0) return { ok: false, reason: "amount", reserved: 0 };
    const bal = balances.get(tenantId) || { capUsd, reserved: 0, spent: 0 };
    bal.capUsd = capUsd;
    const held = bal.reserved + bal.spent;
    if (amount > 0 && held + amount > capUsd) return { ok: false, reason: "quota", reserved: 0 };
    bal.reserved += amount;
    balances.set(tenantId, bal);
    jobs.set(jobId, { jobId, tenantId, reserved: amount, settled: false, spentUsd: null });
    return { ok: true, same: false, reserved: amount, jobId };
  }

  function settle(jobId, actualUsd) {
    const job = jobs.get(jobId);
    if (!job) return { ok: false, reason: "missing" };
    if (job.settled) return { ok: false, reason: "settled", spentUsd: job.spentUsd, atomic: false, distributed: false };
    if (!Number.isFinite(actualUsd) || actualUsd < 0 || actualUsd > job.reserved) return { ok: false, reason: "actual" };
    const bal = balances.get(job.tenantId);
    bal.reserved = Math.max(0, bal.reserved - job.reserved);
    bal.spent += actualUsd;
    job.settled = true;
    job.spentUsd = actualUsd;
    return { ok: true, spentUsd: actualUsd, atomic: false, distributed: false };
  }

  return {
    distributed: false,
    atomic: false,
    select,
    settle,
    selectQueued(input) {
      const run = chain.then(() => select(input));
      chain = run.then(() => undefined, () => undefined);
      return run;
    },
    balance(tenantId) {
      const bal = balances.get(tenantId) || { capUsd: 0, reserved: 0, spent: 0 };
      return { ...bal };
    },
  };
}
