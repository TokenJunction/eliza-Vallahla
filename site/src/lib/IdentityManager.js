import { MPC_PIN, MPC_SDK } from "../../../backend/identity-mode.js";

// The browser keeps the existing email and one-time-code gate.
// It loads the MPC kit only after the server says that kit is eligible.
// It does not reconstruct an SSS key and it does not sign.

export async function loginWithServerMode(mode, deps = {}) {
  const current = mode || { mode: "email+totp", mpc: false, eligible: false };
  if (current.mode !== "smart-account" || current.mpc !== true || current.eligible !== true || current.sdk !== MPC_SDK) {
    return {
      ok: true,
      mode: current.mode || "email+totp",
      alternative: current.alternative || null,
      calledSdk: false,
      signing: false,
      mpc: false,
      reconstructed: false,
      noncustodial: false,
      sharesProof: false,
    };
  }
  if (typeof deps.importSdk !== "function") {
    return { ok: false, reason: "unconfigured", calledSdk: false, signing: false, mpc: true };
  }
  const sdk = await deps.importSdk(MPC_SDK, MPC_PIN);
  if (!sdk || typeof sdk.loginWithJWT !== "function" || typeof sdk.makeEthereumSigner !== "function") {
    return { ok: false, reason: "sdk", calledSdk: true, signing: false, reconstructed: false };
  }
  return {
    ok: false,
    reason: "signing-disabled",
    calledSdk: true,
    signing: false,
    reconstructed: false,
    noncustodial: false,
    sharesProof: false,
    mpc: true,
  };
}
