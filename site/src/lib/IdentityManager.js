import {
  MPC_PACKAGE,
  MPC_VERSION,
  assessIdentityConfig,
  assessRootAdmin,
  ownershipKey,
  publicIdentityStatus,
  readOidcPayload,
  secureMetadataStorage,
  unavailable,
} from "./identityConfig.js";

export {
  assessIdentityConfig,
  assessRootAdmin,
  ownershipKey,
  publicIdentityStatus,
  readOidcPayload,
  secureMetadataStorage,
};

export const INTEGRATION_HOOKS = [
  "Do not edit valhallaMasterEngineV35.js in this change.",
  "Load ROOT_ADMIN_EMAIL from the operator environment on the server. The default is none.",
  "Verify the OIDC token on the server before assessRootAdmin.",
  "Call assessRootAdmin({ claims, env }) with the verified claims.",
  "A smart account address or a wallet address is not a root admin.",
  "Call createIdentityManager(config) in the browser and await it.",
  "That call constructs Web3AuthMPCCoreKit and awaits init().",
  "Call manager.login(idToken). It calls loginWithJWT({ verifier, verifierId, idToken, subVerifier }).",
  "verifierId is the stable OIDC sub. The issuer must be in trustedIssuers.",
  "If status needs a factor, call manager.inputFactorKey(factorKey) for REQUIRED_SHARE.",
  "manualSync true calls commitChanges after a logged-in change.",
  "enableMfa and createFactor forward to the SDK and do not keep the factor.",
  "If available is false, show the reason. Do not start SSS.",
  "mapErc4337Owner never sets root and returns no address unless viem is configured.",
].join("\n");

async function loadModule(deps, name) {
  if (deps && typeof deps.loadModule === "function") return deps.loadModule(name);
  return import(name);
}

function kitSnapshot(kit, selected) {
  const status = kit && kit.status;
  return publicIdentityStatus({
    available: true,
    live: status === "LOGGED_IN",
    needsFactor: status === "REQUIRED_SHARE",
    curve: selected.curve,
    chain: selected.chain,
  });
}

export async function createIdentityManager(options = {}, deps = {}) {
  const assessed = assessIdentityConfig(options);
  if (assessed.configured !== true) return assessed;
  const selected = {
    curve: assessed.curve,
    chain: assessed.chain,
    packageName: assessed.tssPackage,
    exportName: assessed.tssExport,
  };
  let mpcModule;
  let tssModule;
  try {
    mpcModule = await loadModule(deps, MPC_PACKAGE);
    tssModule = await loadModule(deps, selected.packageName);
  } catch (error) {
    const missing = error && (error.code === "ERR_MODULE_NOT_FOUND" || /Cannot find package/.test(String(error.message)));
    if (missing) return unavailable(`${MPC_PACKAGE}@${MPC_VERSION} required`);
    return unavailable("mpc-nodes-unavailable");
  }
  const Kit = mpcModule && mpcModule.Web3AuthMPCCoreKit;
  const tssLib = tssModule && tssModule[selected.exportName];
  if (typeof Kit !== "function" || !tssLib || tssLib.keyType !== selected.curve) {
    return unavailable(`${selected.packageName} ${selected.curve} required`);
  }
  if (mpcModule.version && mpcModule.version !== MPC_VERSION) {
    return unavailable(`${MPC_PACKAGE}@${MPC_VERSION} required`);
  }
  const storage = secureMetadataStorage(options.storage);
  let kit;
  try {
    kit = new Kit({
      web3AuthClientId: options.web3AuthClientId,
      web3AuthNetwork: options.web3AuthNetwork,
      manualSync: options.manualSync,
      storage,
      tssLib,
      uxMode: options.uxMode,
      enableLogging: false,
      disableSessionManager: true,
    });
    await kit.init();
  } catch {
    return unavailable("mpc-nodes-unavailable");
  }
  if (!kit || kit.status === "NOT_INITIALIZED" || kit.status == null) {
    return unavailable("mpc-nodes-unavailable");
  }
  const ownerKey = ownershipKey(options.owner);
  const state = {
    available: true,
    kit,
    selected,
    ownerKey,
    manualSync: options.manualSync === true,
  };

  function requireOwner(idToken) {
    const parsed = readOidcPayload(idToken);
    if (!parsed.ok) return parsed;
    if (parsed.ownership !== ownerKey) return { ok: false, reason: "ownership-mismatch" };
    if (!options.trustedIssuers.includes(parsed.iss)) return { ok: false, reason: "issuer-rejected" };
    return parsed;
  }

  async function commitIfNeeded() {
    if (state.manualSync && state.kit.status === "LOGGED_IN" && typeof state.kit.commitChanges === "function") {
      await state.kit.commitChanges();
    }
  }

  return {
    available: true,
    mode: "mpc",
    async login(idToken) {
      const parsed = requireOwner(idToken);
      if (!parsed.ok) return parsed;
      const params = {
        verifier: options.verifier,
        verifierId: parsed.sub,
        idToken,
      };
      if (typeof options.subVerifier === "string") params.subVerifier = options.subVerifier;
      await state.kit.loginWithJWT(params);
      await commitIfNeeded();
      return { ok: true, status: kitSnapshot(state.kit, selected) };
    },
    async commitChanges() {
      if (typeof state.kit.commitChanges !== "function") return { ok: false, reason: "commitChanges required" };
      await state.kit.commitChanges();
      return { ok: true, status: kitSnapshot(state.kit, selected) };
    },
    async enableMfa(params) {
      if (!params || Object.prototype.hasOwnProperty.call(params, "manualSecurityFactor")) {
        return { ok: false, reason: "unsupported-factor-api" };
      }
      if (typeof state.kit.enableMFA !== "function") return { ok: false, reason: "enableMFA required" };
      await state.kit.enableMFA(params);
      await commitIfNeeded();
      return { ok: true, status: kitSnapshot(state.kit, selected) };
    },
    async createFactor(params) {
      if (!params || Object.prototype.hasOwnProperty.call(params, "manualSecurityFactor")) {
        return { ok: false, reason: "unsupported-factor-api" };
      }
      if (typeof state.kit.createFactor !== "function") return { ok: false, reason: "createFactor required" };
      await state.kit.createFactor(params);
      await commitIfNeeded();
      return { ok: true, created: true, status: kitSnapshot(state.kit, selected) };
    },
    async inputFactorKey(factorKey) {
      if (state.kit.status !== "REQUIRED_SHARE") return { ok: false, reason: "factor-not-required" };
      if (factorKey == null) return { ok: false, reason: "factor required" };
      await state.kit.inputFactorKey(factorKey);
      await commitIfNeeded();
      return { ok: true, status: kitSnapshot(state.kit, selected) };
    },
    status() {
      return kitSnapshot(state.kit, selected);
    },
  };
}

export async function mapErc4337Owner(options = {}, deps = {}) {
  const configured = options.configured === true && options.chainId != null && options.ownerAuth && ownershipKey(options.ownerAuth);
  if (!configured) {
    return { available: false, mode: "erc4337", root: false, reason: "viem ERC-4337 owner mapping required" };
  }
  const viem = deps && deps.viem;
  if (!viem || typeof viem.createPublicClient !== "function" || typeof deps.resolveOwnerAddress !== "function") {
    return { available: false, mode: "erc4337", root: false, reason: "viem required" };
  }
  const address = await deps.resolveOwnerAddress(viem, options);
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return { available: false, mode: "erc4337", root: false, reason: "viem account implementation required" };
  }
  return { available: true, mode: "erc4337", root: false, address };
}
