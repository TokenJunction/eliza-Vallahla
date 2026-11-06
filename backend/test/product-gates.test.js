import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { FIRST_APPS, openFirstApp } from "../apps.js";
import { identityMode } from "../identity-mode.js";
import { loginWithServerMode } from "../../site/src/lib/IdentityManager.js";
import {
  acceptStripeEvent,
  activateInvite,
  cancelPlan,
  createPlanStore,
  issueInvite,
  recordPaperSim,
  setCapacity,
  viewCapacity,
} from "../plans.js";
import { cancelRoute, createRouteBroker, openRoute, registerLocal, tunnelChoice } from "../route-broker.js";

const identity = "a".repeat(64);

test("email mode stays the default and SSS is not called MPC", async () => {
  const email = identityMode({});
  assert.equal(email.mode, "email+totp");
  assert.equal(email.mpc, false);
  assert.equal(email.noncustodial, false);
  assert.equal(email.sharesProof, false);
  assert.equal(Object.hasOwn(email, "noncustodial"), true);
  const sss = identityMode({ IDENTITY_MODE: "@web3auth/single-factor-auth" });
  assert.equal(sss.mode, "wallet-unavailable");
  assert.equal(sss.mpc, false);
  assert.equal(sss.alternative, "shared-key");
  assert.equal(sss.reconstructed, false);
  const blocked = identityMode({ IDENTITY_MODE: "smart-account" });
  assert.equal(blocked.mode, "wallet-unavailable");
  assert.equal(blocked.reason, "mpc-not-eligible");
  const eligible = identityMode({
    IDENTITY_MODE: "smart-account",
    IDENTITY_MPC_ELIGIBLE: "true",
    WEB3AUTH_CLIENT_ID: "client",
  });
  assert.equal(eligible.mode, "smart-account");
  assert.equal(eligible.sdk, "@web3auth/mpc-core-kit");
  assert.equal(eligible.signing, false);
  assert.equal(eligible.noncustodial, false);
  let imported = false;
  const idle = await loginWithServerMode(email, { importSdk() { imported = true; } });
  assert.equal(idle.calledSdk, false);
  assert.equal(imported, false);
  const signed = await loginWithServerMode(eligible, {
    importSdk: async () => ({ loginWithJWT() {}, makeEthereumSigner() {} }),
  });
  assert.equal(signed.reason, "signing-disabled");
  assert.equal(signed.signing, false);
  assert.equal(signed.reconstructed, false);
});

test("the server queues one local task and does not invent a cloud reply", () => {
  const broker = createRouteBroker();
  const account = { tenantId: "tenant", subjectId: "user" };
  const waiting = openRoute(broker, account, {}, 1_000);
  assert.equal(waiting.progress, "Waiting for local PC");
  assert.equal(waiting.text, null);
  assert.equal(waiting.completed, false);
  assert.ok(waiting.taskId);
  const second = openRoute(broker, account, {}, 1_100);
  assert.equal(second.reason, "inflight");
  assert.equal(cancelRoute(broker, account, waiting.taskId).progress, "cancelled");
  registerLocal(broker, account, { model: "qwen2.5-coder:14b", ready: true }, 2_000);
  const local = openRoute(broker, account, {}, 2_100);
  assert.equal(local.progress, "Processing locally");
  assert.equal(local.chargeUsd, 0);
  assert.equal(local.text, null);
  cancelRoute(broker, account, local.taskId);
  registerLocal(broker, account, { model: "qwen2.5-coder:14b", ready: true }, 3_000);
  const asleep = openRoute(broker, account, {}, 3_000 + 31_000);
  assert.equal(asleep.progress, "Local unavailable; cloud not enabled");
  assert.equal(asleep.text, null);
  cancelRoute(broker, account, asleep.taskId);
  const cloud = openRoute(broker, { ...account, cloudPermitted: true }, {
    DEEPSEEK_API_KEY: "k",
    DEEPSEEK_MODEL: "m",
  }, 3_000 + 31_000);
  assert.equal(cloud.environment, "cloud");
  assert.equal(cloud.freeCloudPool, false);
  assert.equal(cloud.text, null);
  assert.equal(tunnelChoice({}, "ngrok").autoInstall, false);
  assert.equal(tunnelChoice({}, "ngrok").reason, "ngrok-not-configured");
  assert.equal(tunnelChoice({ NGROK_AUTHTOKEN: "t", NGROK_ENABLED: "1" }, "ngrok").active, false);
  assert.equal(registerLocal(broker, account, { model: "other", url: "http://evil" }).reason, "model");
});

test("a personal seat is licensed once and a webhook does not charge", async () => {
  const store = createPlanStore();
  assert.equal(viewCapacity(store, {}).activeCap, 0);
  assert.equal(viewCapacity(store, {}).charge, false);
  assert.equal(setCapacity(store, { owner: false }, 10).reason, "owner");
  assert.equal(setCapacity(store, { owner: true }, 1000).reason, "bounds");
  assert.equal(setCapacity(store, { owner: true }, 1).cap, 1);
  const invite = issueInvite(store, 1_000);
  const early = await activateInvite(store, {
    code: invite.code,
    identity,
    usable: { workspace: false, task: true, signin: true },
    env: { PUBLIC_CAPACITY_READY: "true" },
  }, 1_000);
  assert.equal(early.reason, "not-usable");
  assert.equal(early.license, null);
  const owner = await activateInvite(store, {
    code: issueInvite(store, 1_000).code,
    identity: "b".repeat(64),
    owner: true,
    usable: { workspace: true, task: true, signin: true },
    env: {},
  }, 1_000);
  assert.equal(owner.license, true);
  assert.equal(owner.charge, false);
  const opened = await activateInvite(store, {
    code: invite.code,
    identity,
    usable: { workspace: true, task: true, signin: true },
    env: { PUBLIC_CAPACITY_READY: "true" },
  }, 1_000);
  assert.equal(opened.license, true);
  const again = await activateInvite(store, {
    code: issueInvite(store, 1_000).code,
    identity,
    usable: { workspace: true, task: true, signin: true },
    env: { PUBLIC_CAPACITY_READY: "true" },
  }, 1_000);
  assert.equal(again.sameIdentity, true);
  assert.equal(recordPaperSim(store, identity).count, 1);
  store.state.paper.set(identity, 100);
  assert.equal(recordPaperSim(store, identity).reason, "sim-cap");
  assert.equal(recordPaperSim(store, identity).advice, false);
  const full = await activateInvite(store, {
    code: issueInvite(store, 1_000).code,
    identity: "c".repeat(64),
    usable: { workspace: true, task: true, signin: true },
    env: { PUBLIC_CAPACITY_READY: "true" },
  }, 1_000);
  assert.equal(full.reason, "capacity");
  const secret = "whsec-test";
  const raw = JSON.stringify({ id: "evt-1", account: "attacker" });
  const header = createHmac("sha256", secret).update(raw).digest("hex");
  const first = acceptStripeEvent(store, { STRIPE_WEBHOOK_SECRET: secret }, raw, header);
  const second = acceptStripeEvent(store, { STRIPE_WEBHOOK_SECRET: secret }, raw, header);
  assert.equal(first.applied, false);
  assert.equal(first.charge, false);
  assert.equal(first.role, null);
  assert.equal(second.duplicate, true);
  assert.equal(acceptStripeEvent(store, {}, raw, header).reason, "disabled");
  const cancelled = cancelPlan(store, identity, 5_000);
  assert.equal(cancelled.deleted, false);
  assert.equal(cancelled.historyKept, true);
  assert.equal(cancelled.retentionDays, 30);
  assert.equal(cancelled.exportRequired, true);
  const paper = FIRST_APPS.find((item) => item.id === "paper-trading");
  assert.equal(paper.enabled, false);
  assert.equal(paper.liveTrading, false);
  assert.equal(paper.advice, false);
  assert.equal(openFirstApp("paper-trading", { apps: [] }).reason, "entitlement");
  assert.equal(openFirstApp("paper-trading", { apps: ["paper-trading"] }).executes, false);
});
