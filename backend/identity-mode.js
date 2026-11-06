// Email plus a one-time code stays the default.
// @web3auth/no-modal and @web3auth/single-factor-auth reconstruct a key with SSS.
// That is not MPC. @web3auth/mpc-core-kit is a separate enterprise kit.
// This module never reconstructs a key and never signs.

export const MPC_SDK = "@web3auth/mpc-core-kit";
export const MPC_PIN = "3.6.0";
export const TSS_LIB = "@toruslabs/tss-dkls-lib";
export const TSS_PIN = "4.1.0";
const SSS_KITS = new Set(["@web3auth/no-modal", "@web3auth/single-factor-auth", "shared-key"]);

function present(mode, extra) {
  return {
    mode,
    mpc: false,
    eligible: false,
    enterprise: false,
    billedTier: false,
    reconstructed: false,
    signing: false,
    mainnet: false,
    recharge: false,
    noncustodial: false,
    sharesProof: false,
    sdk: null,
    pin: null,
    alternative: null,
    ...extra,
  };
}

export function identityMode(env = {}) {
  const requested = String(env.IDENTITY_MODE || "email+totp");
  if (requested === "smart-account" || requested === "mpc" || requested === MPC_SDK) {
    const eligible = env.IDENTITY_MPC_ELIGIBLE === "true" && Boolean(env.WEB3AUTH_CLIENT_ID);
    if (!eligible) {
      return present("wallet-unavailable", { alternative: "shared-key", reason: "mpc-not-eligible" });
    }
    return present("smart-account", {
      mpc: true,
      eligible: true,
      enterprise: true,
      sdk: MPC_SDK,
      pin: MPC_PIN,
      tssLib: TSS_LIB,
      tssPin: TSS_PIN,
      alternative: null,
    });
  }
  if (SSS_KITS.has(requested)) {
    return present("wallet-unavailable", { alternative: "shared-key", reason: "not-mpc" });
  }
  return present("email+totp");
}
