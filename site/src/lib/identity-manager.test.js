import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  assessIdentityConfig,
  assessRootAdmin,
  createIdentityManager,
  INTEGRATION_HOOKS,
  mapErc4337Owner,
  secureMetadataStorage,
} from "./IdentityManager.js";

function memoryStorage() {
  const data = new Map();
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
    dump() {
      return [...data.values()].join("\n");
    },
  };
}

function token(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function config(overrides = {}) {
  return {
    enterprise: true,
    web3AuthClientId: "client-id-test-value",
    web3AuthNetwork: "mainnet",
    verifier: "oidc-verifier",
    chain: "solana",
    curve: "ed25519",
    manualSync: true,
    uxMode: "popup",
    trustedIssuers: ["https://issuer.example"],
    owner: { sub: "subject-a", iss: "https://issuer.example" },
    storage: memoryStorage(),
    ...overrides,
  };
}

function fakeModules(behavior = {}) {
  const kits = [];
  const loaded = [];
  class FakeKit {
    constructor(options) {
      this.options = options;
      this.status = "NOT_INITIALIZED";
      this.calls = [];
      kits.push(this);
    }
    async init() {
      if (behavior.failInit) throw new Error("node details unavailable");
      this.status = "INITIALIZED";
    }
    async loginWithJWT(params) {
      this.calls.push(["loginWithJWT", params]);
      this.status = behavior.afterLogin || "LOGGED_IN";
    }
    async commitChanges() {
      this.calls.push(["commitChanges"]);
    }
    async enableMFA(params) {
      this.calls.push(["enableMFA", params]);
      return "should-not-leak";
    }
    async createFactor(params) {
      this.calls.push(["createFactor", params]);
      return "should-not-leak";
    }
    async inputFactorKey() {
      this.calls.push(["inputFactorKey"]);
      this.status = "LOGGED_IN";
    }
    async exportSigningKey() {
      this.calls.push(["export"]);
      return "secret-key";
    }
  }
  return {
    kits,
    loaded,
    async loadModule(name) {
      loaded.push(name);
      if (behavior.missing) {
        const error = new Error("Cannot find package");
        error.code = "ERR_MODULE_NOT_FOUND";
        throw error;
      }
      if (name === "@web3auth/mpc-core-kit") {
        return { Web3AuthMPCCoreKit: FakeKit, version: behavior.version || "3.6.0" };
      }
      if (name === "@toruslabs/tss-frost-lib") return { tssLib: { keyType: behavior.frost || "ed25519" } };
      if (name === "@toruslabs/tss-dkls-lib") return { tssLib: { keyType: behavior.dkls || "secp256k1" } };
      throw new Error("unexpected package");
    },
  };
}

test("an unconfigured MPC manager stays unavailable", () => {
  const status = assessIdentityConfig({});
  assert.equal(status.available, false);
  assert.equal(status.mode, "mpc");
  assert.equal(status.live, false);
  assert.equal(status.did, null);
  assert.equal(status.root, false);
  assert.match(status.reason, /enterprise/);
  assert.match(status.reason, /required/);
  assert.equal(Object.hasOwn(status, "address"), false);
});

test("solana and ethereum select only the matching TSS package", () => {
  const solana = assessIdentityConfig(config());
  assert.equal(solana.configured, true);
  assert.equal(solana.tssPackage, "@toruslabs/tss-frost-lib");
  assert.equal(solana.curve, "ed25519");
  const evm = assessIdentityConfig(config({ chain: "ethereum", curve: "secp256k1" }));
  assert.equal(evm.tssPackage, "@toruslabs/tss-dkls-lib");
  const mixed = assessIdentityConfig(config({ chain: "solana", curve: "secp256k1" }));
  assert.equal(mixed.available, false);
  assert.match(mixed.reason, /curve/);
  assert.match(mixed.reason, /required/);
});

test("missing packages do not create an available MPC session", async () => {
  const status = await createIdentityManager(config());
  assert.equal(status.available, false);
  assert.equal(status.mode, "mpc");
  assert.equal(status.live, false);
  assert.equal(status.did, null);
  assert.match(status.reason, /@web3auth\/mpc-core-kit@3\.6\.0/);
  assert.match(status.reason, /required/);
});

test("unavailable MPC nodes do not become a live DID", async () => {
  const modules = fakeModules({ failInit: true });
  const status = await createIdentityManager(config(), modules);
  assert.equal(status.available, false);
  assert.equal(status.live, false);
  assert.equal(status.did, null);
  assert.equal(status.reason, "mpc-nodes-unavailable");
  assert.equal(modules.kits[0].calls.some((call) => call[0] === "export"), false);
});

test("login uses the stable subject and does not keep factor material", async () => {
  const storage = memoryStorage();
  const modules = fakeModules();
  const manager = await createIdentityManager(config({ storage, subVerifier: "aggregate-verifier" }), modules);
  assert.equal(manager.available, true);
  const kit = modules.kits[0];
  assert.equal(kit.options.manualSync, true);
  assert.equal(kit.options.enableLogging, false);
  assert.equal(kit.options.disableSessionManager, true);
  assert.equal(kit.options.tssLib.keyType, "ed25519");
  assert.deepEqual(modules.loaded, ["@web3auth/mpc-core-kit", "@toruslabs/tss-frost-lib"]);
  const first = token({ sub: "subject-a", iss: "https://issuer.example", email_verified: true });
  const logged = await manager.login(first);
  assert.equal(logged.ok, true);
  assert.equal(logged.status.live, true);
  assert.equal(logged.status.did, null);
  assert.equal(logged.status.root, false);
  assert.equal(logged.status.custody, "mpc");
  assert.deepEqual(kit.calls[0][1], {
    verifier: "oidc-verifier",
    verifierId: "subject-a",
    idToken: first,
    subVerifier: "aggregate-verifier",
  });
  assert.equal(kit.calls[1][0], "commitChanges");
  const other = token({ sub: "subject-b", iss: "https://issuer.example" });
  const rejected = await manager.login(other);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "ownership-mismatch");
  assert.equal(kit.calls.filter((call) => call[0] === "loginWithJWT").length, 1);
  const enabled = await manager.enableMfa({ shareDescription: "DeviceShare" });
  assert.equal(enabled.ok, true);
  assert.equal(JSON.stringify(enabled).includes("should-not-leak"), false);
  const created = await manager.createFactor({ shareType: "recovery" });
  assert.equal(created.created, true);
  assert.equal(JSON.stringify(created).includes("should-not-leak"), false);
  assert.equal(storage.dump().includes(first), false);
  assert.equal(kit.calls.some((call) => call[0] === "export"), false);
  const denied = await manager.enableMfa({ manualSecurityFactor: true });
  assert.equal(denied.reason, "unsupported-factor-api");
});

test("REQUIRED_SHARE waits for inputFactorKey before commit", async () => {
  const modules = fakeModules({ afterLogin: "REQUIRED_SHARE" });
  const manager = await createIdentityManager(config(), modules);
  const logged = await manager.login(token({ sub: "subject-a", iss: "https://issuer.example" }));
  assert.equal(logged.status.needsFactor, true);
  assert.equal(logged.status.live, false);
  assert.equal(modules.kits[0].calls.some((call) => call[0] === "commitChanges"), false);
  const early = await manager.inputFactorKey(null);
  assert.equal(early.reason, "factor required");
  const entered = await manager.inputFactorKey({ heldByCaller: true });
  assert.equal(entered.ok, true);
  assert.equal(entered.status.live, true);
  assert.equal(JSON.stringify(entered).includes("heldByCaller"), false);
  assert.equal(modules.kits[0].calls.some((call) => call[0] === "inputFactorKey"), true);
});

test("the browser module does not read global storage", async () => {
  let reads = 0;
  globalThis.localStorage = {
    getItem() {
      reads += 1;
      return null;
    },
    setItem() {
      reads += 1;
    },
    removeItem() {
      reads += 1;
    },
  };
  try {
    const status = await createIdentityManager({});
    assert.equal(status.available, false);
    assert.equal(reads, 0);
  } finally {
    delete globalThis.localStorage;
  }
});

test("root admin comes only from a verified OIDC subject and the server env", () => {
  const email = ["root", "operator.invalid"].join("@");
  const env = { ROOT_ADMIN_EMAIL: email };
  const claims = {
    verified: true,
    email_verified: true,
    email,
    sub: "subject-a",
    iss: "https://issuer.example",
    smartAccount: "0xabc",
    address: "0xdef",
  };
  const root = assessRootAdmin({ claims, env });
  assert.equal(root.root, true);
  assert.equal(root.subject, "subject-a");
  assert.equal(Object.hasOwn(root, "email"), false);
  assert.equal(JSON.stringify(root).includes(email), false);
  assert.equal(assessRootAdmin({ claims, env: {} }).root, false);
  assert.equal(assessRootAdmin({ claims: { ...claims, verified: false }, env }).root, false);
  assert.equal(assessRootAdmin({ claims: { ...claims, email_verified: false }, env }).root, false);
  assert.equal(assessRootAdmin({
    claims: { verified: true, email_verified: true, email, address: "0xabc", smartAccount: "0xabc" },
    env,
  }).reason, "stable-subject-required");
  assert.equal(assessRootAdmin({
    claims: { ...claims, email: ["other", "operator.invalid"].join("@") },
    env,
  }).root, false);
});

test("ERC-4337 mapping returns no address until viem is configured and never grants root", async () => {
  const missing = await mapErc4337Owner({});
  assert.equal(missing.available, false);
  assert.equal(missing.root, false);
  assert.equal(Object.hasOwn(missing, "address"), false);
  assert.match(missing.reason, /required/);
  const address = `0x${"ab".repeat(20)}`;
  const mapped = await mapErc4337Owner({
    configured: true,
    chainId: 1,
    ownerAuth: { sub: "subject-a", iss: "https://issuer.example" },
  }, {
    viem: { createPublicClient() { return {}; } },
    resolveOwnerAddress: async () => address,
  });
  assert.equal(mapped.available, true);
  assert.equal(mapped.address, address);
  assert.equal(mapped.root, false);
});

test("secure metadata storage refuses a raw factor", () => {
  const storage = memoryStorage();
  const wrapped = secureMetadataStorage(storage);
  wrapped.setItem("meta", JSON.stringify({ browser: "test" }));
  assert.throws(() => wrapped.setItem("meta", "a".repeat(64)), /secret persistence refused/);
  assert.equal(storage.dump().includes("a".repeat(64)), false);
});

test("the package pin and the hook text name the MPC SDK", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.dependencies["@web3auth/mpc-core-kit"], "3.6.0");
  assert.equal(manifest.dependencies["@toruslabs/tss-dkls-lib"], "4.1.0");
  assert.equal(manifest.dependencies["@toruslabs/tss-frost-lib"], "1.0.0");
  assert.match(INTEGRATION_HOOKS, /loginWithJWT/);
  assert.match(INTEGRATION_HOOKS, /Do not start SSS/);
  assert.equal(INTEGRATION_HOOKS.includes("no-modal"), false);
});
