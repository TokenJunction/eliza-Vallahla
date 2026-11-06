import { createServer as createHttp, request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const { generateForRequest } = require("./provider/channel.cjs");
const { mapCustomerFromBearer } = require("../lib/customer-identity.js");
import { bearer, isRoot, normalizeEmail, resolveRoot } from "./authz.js";
import { claimAdmin, cleanDisplayName, issueBoundSession, openStore, revokeBoundSession, tenantFor, verifyBoundSession } from "./sessions.js";
import { runElizaTask } from "./eliza-route.js";
import { admit, finish, history, loadTasks, readTask, saveTasks, serverPolicy, stopTask } from "./task-invocation.js";
import { assertPublicTarget } from "./ssrf.js";
import { ADAPTER_VERSION, PROVIDER_CATALOG, blankProvider, testProvider } from "./adapters.js";
import { NOT_CONFIGURED_APPS, builtinManifests, canLaunch, editionAllows, scopeKey } from "./apps.js";
import { connectorRequest, listConnectors } from "./connectors.js";
import { deskOpenApi } from "./desk-openapi.js";
import { modelRoute } from "./model-route.js";
import { createBus, privateKeyFromPem, publicKeyFromPem } from "./agentCrossTalkBus.js";
import { acceptEvent, verifyWebhook } from "./commerce.js";
import { decodeBase58, publicKeyFromRaw, verifyBytes } from "./ed25519.js";
import { deviceId, entitlements, verifyLicense } from "./license.js";
import { publicConfig, redact, encryptSecret } from "./secretStore.js";
import { inspectPrompt } from "./sanitize.js";
import { createReflexion } from "./valhallaReflexionEngine.js";

const APPS = builtinManifests();
const MAX_BODY = 64 * 1024;
const TERMS_VERSION = "2026-11-03";
const JUPITER_QUOTE = "https://quote-api.jup.ag/v6/quote";

function allowRate(buckets, ip) {
  const now = Date.now();
  const bucket = buckets.get(ip) || { count: 0, reset: now + 60_000 };
  if (now > bucket.reset) {
    bucket.count = 0;
    bucket.reset = now + 60_000;
  }
  bucket.count += 1;
  buckets.set(ip, bucket);
  return bucket.count <= 120;
}

function json(res, status, body, origin) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
  });
  res.end(text);
}

function allowOrigin(req, env) {
  const origin = req.headers.origin || "";
  return origin && origin === env.VALHALLA_SITE_ORIGIN ? origin : "";
}

async function readJson(req) {
  if (req.parsedBody) return req.parsedBody;
  const chunks = [];
  let size = 0;
  const started = Date.now();
  for await (const chunk of req) {
    if (Date.now() - started > 5000) {
      const error = new Error("timeout");
      error.code = "timeout";
      throw error;
    }
    size += chunk.length;
    if (size > MAX_BODY) {
      const error = new Error("too_large");
      error.code = "too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const parsed = { raw, json: raw ? JSON.parse(raw) : {} };
  req.parsedBody = parsed;
  return parsed;
}

function createState(env) {
  const providers = {};
  for (const spec of PROVIDER_CATALOG) providers[spec.id] = blankProvider(spec);
  return {
    env,
    startedAt: Date.now(),
    bootstrapCode: randomBytes(16).toString("hex"),
    supabase: false,
    redis: false,
    setup: {
      complete: false,
      step: "brand",
      branding: { name: "ValhallaOS", logoUrl: "", accent: "#000080" },
      rootEmail: null,
      edition: "core",
      license: null,
      providers,
      connectors: {},
      payments: {},
      members: [],
      installed: ["trading", "ai-workspace", "thalos", "data-explorer"],
      progress: ["start"],
    },
    secrets: new Map(),
    rules: [],
    storage: new Map(),
    ledger: [],
    seenEvents: new Map(),
    devices: new Set(),
    apps: APPS,
  };
}

function actor(req) {
  return req.session ? req.session.email : null;
}

function admin(req, state) {
  const email = actor(req);
  if (!email) return { status: 401, email: null };
  if (!isRoot(email, state.env, state.setup)) return { status: 403, email };
  return { status: 200, email };
}

function cloudAllowed() {
  // A license object in process memory does not grant network or paid apps.
  return false;
}

export function createServer(options = {}) {
  const env = options.env || process.env;
  const state = options.state || createState(env);
  state.store = options.store || openStore(options.dataDir);
  state.tasks = loadTasks(state.store);
  const rateBuckets = new Map();
  const fetchImpl = options.fetchImpl || fetch;
  const bus = createBus({
    privateKey: env.VALHALLA_SIGNING_PRIVATE_KEY ? privateKeyFromPem(env.VALHALLA_SIGNING_PRIVATE_KEY) : null,
    publicKey: env.VALHALLA_SIGNING_PUBLIC_KEY ? publicKeyFromPem(env.VALHALLA_SIGNING_PUBLIC_KEY) : null,
    redis: options.redis || null,
  });
  state.redis = Boolean(options.redis);
  const rules = {
    async insertRule(rule) {
      state.rules.push(rule);
      return rule;
    },
    async setRuleActive(id, active) {
      const rule = state.rules.find((item) => item.id === id);
      if (!rule) return null;
      rule.active = active;
      return rule;
    },
  };
  const reflexion = createReflexion(rules);

  const server = createHttp(async (req, res) => {
    const origin = allowOrigin(req, env);
    if (req.method === "OPTIONS") {
      res.writeHead(204, origin ? {
        "access-control-allow-origin": origin,
        "access-control-allow-headers": "content-type, authorization",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        vary: "Origin",
      } : {});
      res.end();
      return;
    }
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "local").split(",")[0].trim();
      if (!allowRate(rateBuckets, ip)) return json(res, 429, { ok: false, code: "V-RATE" }, origin);
      const advertised = Number(req.headers["content-length"] || 0);
      if (advertised > MAX_BODY) return json(res, 413, { ok: false, code: "V-SIZE" }, origin);
      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, {
          ok: true,
          version: "35.0.0",
          uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
          port: Number(env.PORT) || 8080,
          edition: state.setup.edition,
          supabase: state.supabase,
          redis: state.redis,
          signing: Boolean(env.VALHALLA_SIGNING_PRIVATE_KEY),
          factory: String(env.VALHALLA_FACTORY) === "1",
          model: "unconfigured",
        }, origin);
        return;
      }
      if (req.method === "GET" && url.pathname === "/ready") {
        const providers = state.setup.providers || {};
        const modelUp = Object.values(providers).some((item) => item.tested === true && item.health === "up");
        return json(res, state.store.durable ? 200 : 503, {
          ready: state.store.durable === true,
          components: {
            store: state.store.durable ? "ready" : "memory",
            auth: "live-session",
            model: modelUp ? "available" : "unconfigured",
            jupiter: "quote-only",
            execution: "absent",
            liveTrading: "disabled",
          },
        }, origin);
      }
      const openApi = url.pathname === "/api/bootstrap" || url.pathname.startsWith("/api/billing/webhook/");
      if (url.pathname.startsWith("/api/") && !openApi) {
        const token = bearer(req);
        const local = verifyBoundSession(state.store, token);
        if (local) {
          req.session = local;
        } else if (env.AUTH_URL) {
          const mapped = await mapCustomerFromBearer({
            authBase: env.AUTH_URL,
            bearer: token,
            headers: req.headers,
            env,
            fetchImpl,
          });
          if (!mapped.ok || mapped.supabaseAuthUid != null || mapped.role !== "customer" || !mapped.memberId) {
            return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
          }
          req.session = { userId: mapped.memberId, email: "", owner: false, leader: mapped.leader === true };
        } else {
          return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        }
      }
      if (req.method === "POST" && url.pathname === "/api/bootstrap") {
        const { json: body } = await readJson(req);
        const email = normalizeSafe(body.email);
        if (!env.SESSION_SECRET) return json(res, 503, { ok: false, error: "unavailable", code: "V-AUTH" }, origin);
        if (!state.bootstrapCode || body.code !== state.bootstrapCode) return json(res, 403, { ok: false, error: "denied", code: "V-AUTH" }, origin);
        const configured = String(env.VALHALLA_FACTORY) === "1" ? env.MASTER_ADMIN_EMAIL : env.CUSTOMER_ADMIN_EMAIL;
        if (!configured) return json(res, 503, { ok: false, error: "admin-not-configured", code: "V-AUTH" }, origin);
        const root = resolveRoot(env, { rootEmail: email });
        if (!root || email !== root || email !== normalizeSafe(configured)) {
          return json(res, 403, { ok: false, error: "denied", code: "V-AUTH" }, origin);
        }
        const tenant = claimAdmin(state.store, root, configured);
        if (!tenant) return json(res, 403, { ok: false, error: "denied", code: "V-AUTH" }, origin);
        const device = body.deviceId ? deviceId(body.deviceId) : null;
        const rights = entitlements(null);
        if (device && state.devices.size >= rights.deviceLimit && !state.devices.has(device)) {
          return json(res, 403, { ok: false, error: "device-limit", code: "V-LIC" }, origin);
        }
        if (device) state.devices.add(device);
        state.setup.rootEmail = root;
        state.bootstrapCode = null;
        const session = issueBoundSession(state.store, { email: root, userId: tenant.userId, did: device });
        return json(res, 200, { ok: true, token: session.token, email: root, tenantId: tenant.userId }, origin);
      }

      const who = admin(req, state);
      const authed = actor(req);

      if (req.method === "GET" && url.pathname === "/api/me") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        return json(res, 200, {
          ok: true,
          email: authed,
          role: isRoot(authed, env, state.setup) ? "owner" : "member",
          tenantId: req.session.userId,
          displayName: state.store.data.preferences[req.session.userId] || null,
          root: isRoot(authed, env, state.setup),
        }, origin);
      }
      if (req.method === "PATCH" && url.pathname === "/api/me/preferences") {
        if (!req.session) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const displayName = cleanDisplayName(body.displayName);
        if (!displayName) return json(res, 400, { ok: false, error: "display-name", code: "V-AUTH" }, origin);
        state.store.data.preferences[req.session.userId] = displayName;
        state.store.flush();
        return json(res, 200, {
          ok: true,
          displayName,
          email: req.session.email,
          role: isRoot(req.session.email, env, state.setup) ? "owner" : "member",
          tenantId: req.session.userId,
        }, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/admin/metrics") {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        return json(res, 200, {
          ok: true,
          uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
          rss: process.memoryUsage().rss,
          rules: state.rules.length,
          activeRules: state.rules.filter((rule) => rule.active).length,
          adaptersEnabled: Object.values(state.setup.providers).filter((item) => item.enabled).length,
          edition: state.setup.edition,
          redis: state.redis,
          supabase: state.supabase,
          ledgerEvents: state.ledger.length,
        }, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/setup/status") {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        return json(res, 200, { ok: true, setup: publicConfig(state.setup), secrets: [...state.secrets.keys()] }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/setup/branding") {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        state.setup.branding = {
          name: String(body.name || "ValhallaOS").slice(0, 60),
          logoUrl: String(body.logoUrl || "").slice(0, 300),
          accent: /^#[0-9a-fA-F]{6}$/.test(body.accent || "") ? body.accent : "#000080",
        };
        state.setup.progress = [...new Set([...state.setup.progress, "brand"])];
        return json(res, 200, { ok: true, branding: state.setup.branding }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/setup/provider") {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const provider = state.setup.providers[body.id];
        if (!provider) return json(res, 404, { ok: false, code: "V-ADP" }, origin);
        if (body.baseUrl) provider.baseUrl = String(body.baseUrl).slice(0, 300);
        if (body.model) provider.model = String(body.model).slice(0, 80);
        provider.tested = false;
        provider.enabled = false;
        provider.health = "unknown";
        if (body.apiKey) {
          if (!env.SETUP_MASTER_KEY) return json(res, 400, { ok: false, error: "use-env", code: "V-SEC" }, origin);
          state.secrets.set(provider.id, encryptSecret(env.SETUP_MASTER_KEY, body.apiKey, req.session.userId));
          provider.secretStored = true;
          console.debug("valhalla", "V-SEC", redact(`stored ${provider.id}`));
        }
        return json(res, 200, { ok: true, provider: publicConfig(provider) }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/setup/provider/test") {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const provider = state.setup.providers[body.id];
        if (!provider) return json(res, 404, { ok: false, code: "V-ADP" }, origin);
        const allowed = provider.baseUrl ? await assertPublicTarget(provider.baseUrl, options.resolveImpl) : { ok: false };
        if (!allowed.ok) {
          provider.tested = false;
          provider.health = "down";
          return json(res, 200, { ok: false, provider: publicConfig(provider) }, origin);
        }
        const result = await testProvider(provider, fetchImpl, "");
        provider.tested = result.ok;
        provider.health = result.health;
        provider.enabled = false;
        console.debug("valhalla", "V-ADP", redact(`${provider.id} ${result.health}`));
        return json(res, 200, { ok: result.ok, provider: publicConfig(provider) }, origin);
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/adapters/") && url.pathname.endsWith("/enable")) {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        const id = url.pathname.split("/")[3];
        const provider = state.setup.providers[id];
        const { json: body } = await readJson(req);
        if (!provider) return json(res, 404, { ok: false, code: "V-ADP" }, origin);
        if (body.enabled === true && !provider.tested) return json(res, 400, { ok: false, error: "untested", code: "V-ADP" }, origin);
        if (body.enabled === true && !provider.local && !cloudAllowed(state)) return json(res, 403, { ok: false, error: "license", code: "V-LIC" }, origin);
        provider.enabled = body.enabled === true && provider.tested;
        return json(res, 200, { ok: true, provider: publicConfig(provider), version: ADAPTER_VERSION }, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/adapters") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        return json(res, 200, { ok: true, adapters: publicConfig(state.setup.providers) }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/setup/edition") {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        if (body.edition === "core") {
          state.setup.edition = "core";
          state.setup.license = null;
          return json(res, 200, { ok: true, edition: "core" }, origin);
        }
        if (body.edition !== "pro") return json(res, 400, { ok: false, error: "edition", code: "V-LIC" }, origin);
        const publicKey = options.licensePublicKey || null;
        const checked = verifyLicense(publicKey, body.license);
        if (!checked.ok || checked.license.edition !== "pro") return json(res, 403, { ok: false, error: checked.reason || "license", code: "V-LIC" }, origin);
        state.setup.license = checked.license;
        state.setup.edition = "pro";
        return json(res, 200, { ok: true, edition: "pro" }, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/setup/export") {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        return json(res, 200, { ok: true, config: publicConfig(state.setup) }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/setup/import") {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const config = publicConfig(body.config || {});
        if (config.branding) state.setup.branding = { ...state.setup.branding, ...config.branding };
        if (config.edition === "core") state.setup.edition = "core";
        state.setup.progress = [...new Set([...(state.setup.progress || []), "import"])];
        return json(res, 200, { ok: true, config: publicConfig(state.setup) }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/setup/complete") {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        state.setup.complete = true;
        state.setup.progress = [...new Set([...state.setup.progress, "complete"])];
        return json(res, 200, { ok: true }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/workspace/members") {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const email = normalizeSafe(body.email);
        const limit = entitlements(state.setup.license).deviceLimit;
        if (!email || email === resolveRoot(env, state.setup)) return json(res, 400, { ok: false, code: "V-AUTH" }, origin);
        if (state.setup.members.length >= limit) return json(res, 403, { ok: false, error: "member-limit", code: "V-LIC" }, origin);
        state.setup.members.push({ email, role: "member" });
        return json(res, 200, { ok: true, members: state.setup.members }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/ai/chat") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const inspected = inspectPrompt(body.text || "");
        const target = body.target === "cloud" ? "cloud" : "local";
        if (!inspected.ok && target === "cloud") return json(res, 400, { ok: false, error: "flagged", flags: inspected.flags, code: "V-AI" }, origin);
        if (target === "cloud" && !cloudAllowed(state)) return json(res, 403, { ok: false, error: "license", code: "V-LIC" }, origin);
        if (body.demo === true) {
          return json(res, 200, { ok: true, mode: "echo", text: `Local echo. Not a model response. ${inspected.text}` }, origin);
        }
        const generated = await generateForRequest({
          text: inspected.text,
          role: body.role,
          capability: body.capability,
        }, env, { fetchImpl });
        if (!generated.completed) {
          return json(res, 503, { ok: false, error: generated.reason, completed: false, offline: false, text: null, code: "V-AI" }, origin);
        }
        return json(res, 200, {
          ok: true,
          completed: true,
          text: generated.text,
          provider: generated.provider,
          model: generated.model,
          simulated: false,
          audioGenerated: false,
          code: "V-AI",
        }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/privarun/local") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        if (String(env.VALHALLA_LOCAL_RELAY) !== "1") return json(res, 409, { ok: false, error: "local-only", code: "V-AI" }, origin);
        const { json: body } = await readJson(req);
        const inspected = inspectPrompt(body.text || "");
        if (!inspected.ok) return json(res, 400, { ok: false, error: "flagged", flags: inspected.flags, code: "V-AI" }, origin);
        return json(res, 503, { ok: false, error: "unavailable", completed: false, text: null, code: "V-AI" }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/privarun/cloud") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const inspected = inspectPrompt(body.text || "");
        if (!inspected.ok) return json(res, 400, { ok: false, error: "flagged", code: "V-AI" }, origin);
        if (!cloudAllowed()) return json(res, 403, { ok: false, error: "license", code: "V-LIC" }, origin);
        return json(res, 503, { ok: false, error: "unavailable", completed: false, text: null, code: "V-AI" }, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/rules") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        return json(res, 200, { ok: true, rules: state.rules }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/reflexion/failure") {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const rule = await reflexion.onFailure(body);
        return json(res, 200, { ok: true, rule }, origin);
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/rules/") && url.pathname.endsWith("/activate")) {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        const id = decodeURIComponent(url.pathname.split("/")[3]);
        const { json: body } = await readJson(req);
        const result = await reflexion.activate(id, body);
        return json(res, result.ok ? 200 : result.status, result, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/apps") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        const apps = state.apps.filter((app) => canLaunch(state.setup.installed, app, options.appPublicKey || null));
        return json(res, 200, { ok: true, apps }, origin);
      }
      if (req.method === "POST" && /^\/api\/apps\/[^/]+\/revoke$/.test(url.pathname)) {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        const id = url.pathname.split("/")[3];
        state.setup.installed = state.setup.installed.filter((item) => item !== id);
        return json(res, 200, { ok: true, installed: state.setup.installed }, origin);
      }
      if (req.method === "POST" && /^\/api\/apps\/[^/]+\/install$/.test(url.pathname)) {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        const id = url.pathname.split("/")[3];
        const app = state.apps.find((item) => item.id === id);
        if (!app || !canLaunch([id], app, options.appPublicKey || null)) return json(res, 403, { ok: false, code: "V-APP" }, origin);
        if (!editionAllows(app, entitlements(state.setup.license))) return json(res, 403, { ok: false, code: "V-LIC" }, origin);
        if (!state.setup.installed.includes(id)) state.setup.installed.push(id);
        return json(res, 200, { ok: true, installed: state.setup.installed }, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/apps/trading/capabilities") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        return json(res, 200, { ok: true, liveTrading: false, paper: true, reason: "Live trading is disabled." }, origin);
      }
      if (/^\/api\/apps\/[^/]+\/storage$/.test(url.pathname)) {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        const appId = url.pathname.split("/")[3];
        if (req.method === "GET") {
          const prefix = scopeKey(state.setup.branding.name, appId, authed, "");
          const entries = [...state.storage.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value }));
          return json(res, 200, { ok: true, entries }, origin);
        }
        if (req.method === "POST") {
          const { json: body } = await readJson(req);
          state.storage.set(scopeKey(state.setup.branding.name, appId, authed, body.key || "note"), publicConfig(body.value ?? null));
          return json(res, 200, { ok: true }, origin);
        }
      }
      if (req.method === "POST" && url.pathname === "/api/a2a/verify") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const message = String(body.message || "");
        if (!message.startsWith("ValhallaOS A2A v1")) return json(res, 400, { ok: false, code: "V-A2A" }, origin);
        const exp = Date.parse((message.match(/Expires: (.+)/) || [])[1] || "");
        if (!Number.isFinite(exp) || exp < Date.now()) return json(res, 400, { ok: false, code: "V-A2A" }, origin);
        const raw = decodeBase58(String(body.pubkey || ""));
        const key = raw && publicKeyFromRaw(raw);
        const signature = Buffer.from(String(body.signature || ""), "base64");
        if (!key || signature.length !== 64 || !verifyBytes(key, Buffer.from(message), signature)) {
          return json(res, 400, { ok: false, code: "V-A2A" }, origin);
        }
        return json(res, 200, { ok: true, last4: String(body.pubkey).slice(-4) }, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/odin") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        const role = url.searchParams.get("role") || "chat";
        const route = modelRoute(state.setup.providers, { role });
        return json(res, 200, { ok: true, name: "Odin", model: false, ...route }, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/desk/openapi") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        return json(res, 200, deskOpenApi(), origin);
      }
      if (req.method === "GET" && url.pathname === "/api/connectors") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        return json(res, 200, { ok: true, connectors: listConnectors() }, origin);
      }
      if (req.method === "POST" && /^\/api\/connectors\/[^/]+$/.test(url.pathname)) {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const result = connectorRequest(url.pathname.split("/")[3], body);
        return json(res, result.status, result, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/compute") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        return json(res, 200, {
          ok: true,
          enabled: false,
          mining: false,
          payouts: "unavailable",
          reputation: "off",
          hiddenJobs: false,
        }, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/apps/catalog") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        return json(res, 200, {
          ok: true,
          mvp: state.apps.map((app) => ({ id: app.id, network: app.networkScopes.length === 0, liveTrading: false })),
          notConfigured: NOT_CONFIGURED_APPS,
        }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/apps/thalos/analysis") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const points = Array.isArray(body.points) ? body.points.filter((item) => Number.isFinite(Number(item))).map(Number) : [];
        const mean = points.length ? points.reduce((sum, item) => sum + item, 0) / points.length : null;
        return json(res, 200, { ok: true, mode: "paper", trades: false, liveTrading: false, count: points.length, mean }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/apps/data-explorer/inspect") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const rows = Array.isArray(body.rows) ? body.rows : [];
        return json(res, 200, { ok: true, remote: false, count: rows.length }, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/review") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        return json(res, 200, {
          ok: true,
          agents: ["Ledger", "Forge", "Tinker", "Droid", "Sentinel", "Gauge"].map((name) => ({
            name,
            status: "unavailable",
            note: "This review seat has no connected worker.",
          })),
        }, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/connectors/google-drive") {
        if (!authed) return json(res, 401, { ok: false, code: "V-AUTH" }, origin);
        return json(res, 200, {
          ok: true,
          configured: state.secrets.has("google-drive"),
          api: "https://www.googleapis.com/drive/v3",
          mode: "official-api",
          scraping: false,
        }, origin);
      }
      if (req.method === "POST" && (url.pathname === "/api/billing/payouts" || url.pathname === "/api/hive/rewards" || url.pathname === "/api/custody")) {
        return json(res, 503, { ok: false, error: "unavailable", code: "V-PAY" }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/billing/claim") {
        return json(res, 403, { ok: false, error: "denied", code: "V-PAY" }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/billing/checkout") {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const provider = String(body.provider || "");
        const secretName = provider === "lemonsqueezy" ? "LEMON_WEBHOOK_SECRET" : provider === "nowpayments" ? "NOWPAYMENTS_API_KEY" : provider === "coinbase" ? "COINBASE_COMMERCE_API_KEY" : "";
        if (!secretName || !env[secretName] || !env.CHECKOUT_URL) return json(res, 503, { ok: false, error: "not_configured", code: "V-PAY" }, origin);
        return json(res, 200, { ok: true, url: env.CHECKOUT_URL }, origin);
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/billing/webhook/")) {
        const provider = url.pathname.split("/").pop();
        const secret = provider === "lemonsqueezy" ? env.LEMON_WEBHOOK_SECRET : provider === "nowpayments" ? env.NOWPAYMENTS_IPN_SECRET : provider === "coinbase" ? env.COINBASE_COMMERCE_WEBHOOK_SECRET : "";
        if (!secret) return json(res, 503, { ok: false, error: "not_configured", code: "V-PAY" }, origin);
        const { raw, json: body } = await readJson(req);
        const header = req.headers["x-signature"] || req.headers["x-nowpayments-sig"] || req.headers["x-cc-webhook-signature"] || "";
        if (!verifyWebhook(provider, secret, raw, header)) return json(res, 401, { ok: false, code: "V-PAY" }, origin);
        const gate = acceptEvent(state.seenEvents, body, Date.now());
        if (!gate.ok) return json(res, 409, { ok: false, error: gate.reason, code: "V-PAY" }, origin);
        state.ledger.push({ id: body.id, provider, at: body.at, status: "recorded" });
        return json(res, 200, { ok: true }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/bus/publish") {
        if (who.status !== 200) return json(res, who.status, { ok: false, code: "V-AUTH" }, origin);
        const { json: body } = await readJson(req);
        const envelope = await bus.publish(String(body.channel || "valhalla.events"), body.payload || {});
        if (envelope.error) return json(res, 503, { ok: false, error: envelope.error, code: "V-BUS" }, origin);
        return json(res, 200, { ok: true, envelope }, origin);
      }
      if (req.method === "POST" && (url.pathname === "/api/v1/tasks" || url.pathname === "/api/tasks" || url.pathname === "/api/eliza")) {
        const { json: body } = await readJson(req);
        const session = {
          userId: req.session.userId,
          owner: isRoot(req.session.email, env, state.setup),
        };
        const policy = serverPolicy(session, env);
        policy.durable = state.store.durable === true;
        policy.production = env.NODE_ENV === "production";
        const membership = state.store.data.membership?.[session.userId] || { installed: [], role: "member" };
        const gate = admit(state.tasks, session, body, policy, membership);
        if (!gate.ok) {
          return json(res, gate.status, { ok: false, reason: gate.reason, text: null, code: "V-TASK" }, origin);
        }
        if (gate.replay) return json(res, 200, gate.response, origin);
        let generated = { completed: false, text: null, reason: "unavailable" };
        if (body.provider === "eliza" || url.pathname === "/api/eliza") {
          const result = await runElizaTask({
            serviceUrl: env.ELIZA_SERVICE_URL,
            serviceToken: env.ELIZA_SERVICE_TOKEN,
            providerToken: env.DEEPSEEK_API_KEY || env.GEMINI_API_KEY || "",
          }, { fetchImpl, resolveImpl: options.resolveImpl });
          generated = { completed: false, text: null, reason: result.reason || "unavailable" };
        } else {
          generated = await generateForRequest({
            text: String(body.text || ""),
            capability: gate.record.capability,
          }, env, { fetchImpl });
        }
        const payload = finish(state.tasks, gate.record, generated);
        saveTasks(state.store, state.tasks);
        return json(res, payload.ok ? 200 : 503, payload, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/v1/tasks") {
        const conversationId = url.searchParams.get("conversationId") || "";
        const found = history(state.tasks, { userId: req.session.userId }, conversationId);
        return json(res, found.status, found, origin);
      }
      if (req.method === "GET" && /^\/api\/v1\/tasks\/[0-9a-f]{32}$/.test(url.pathname)) {
        const found = readTask(state.tasks, { userId: req.session.userId }, url.pathname.split("/").pop());
        return json(res, found.status, found, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/v1/tasks/stop") {
        const { json: body } = await readJson(req);
        const stopped = stopTask(state.tasks, { userId: req.session.userId }, String(body.taskId || ""));
        saveTasks(state.store, state.tasks);
        return json(res, stopped.status, stopped, origin);
      }
      if (req.method === "GET" && url.pathname === "/api/jupiter/quote") {
        const inputMint = url.searchParams.get("inputMint") || "";
        const outputMint = url.searchParams.get("outputMint") || "";
        const amount = url.searchParams.get("amount") || "";
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(inputMint) || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(outputMint) || !/^[1-9]\d{0,17}$/.test(amount)) {
          return json(res, 400, { ok: false, error: "quote-params", code: "V-QUOTE" }, origin);
        }
        const target = await assertPublicTarget(`${JUPITER_QUOTE}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}`, options.resolveImpl);
        if (!target.ok || target.host !== "quote-api.jup.ag") {
          return json(res, 403, { ok: false, error: "quote-host", code: "V-QUOTE" }, origin);
        }
        const response = await fetchImpl(target.href, { method: "GET", redirect: "error", signal: AbortSignal.timeout(8000) });
        if (!response.ok) return json(res, 502, { ok: false, error: "quote-unavailable", executed: false, code: "V-QUOTE" }, origin);
        const quote = await response.json();
        return json(res, 200, { ok: true, quote, executed: false, mode: "paper", signature: null }, origin);
      }
      if (req.method === "POST" && url.pathname === "/api/jupiter/paper") {
        const { json: body } = await readJson(req);
        if (body.execute === true || body.sign === true || body.broadcast === true) {
          return json(res, 403, { ok: false, error: "executor-absent", executed: false, signature: null, code: "V-QUOTE" }, origin);
        }
        if (!body.quote || typeof body.quote !== "object") {
          return json(res, 400, { ok: false, error: "quote-required", executed: false, code: "V-QUOTE" }, origin);
        }
        return json(res, 200, {
          ok: true,
          mode: "paper",
          executed: false,
          signature: null,
          tx: null,
          outAmount: body.quote.outAmount || null,
        }, origin);
      }
      json(res, 404, { ok: false, code: "V-404" }, origin);
    } catch (err) {
      if (err && (err.code === "too_large" || err.code === "timeout")) {
        return json(res, err.code === "timeout" ? 408 : 413, { ok: false, code: "V-SIZE" }, origin);
      }
      console.debug("valhalla", "V-500", redact(err instanceof Error ? err.message : "error"));
      json(res, 500, { ok: false, code: "V-500" }, origin);
    }
  });

  server.state = state;
  server.bus = bus;
  return server;
}

function normalizeSafe(email) {
  return String(email || "").trim().toLowerCase();
}

function listen(server, port) {
  return new Promise((resolve) => {
    server.listen(port, "0.0.0.0", () => resolve(server.address()));
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT) || 8080;
  const server = createServer();
  const host = process.env.VALHALLA_LOCAL_RELAY === "1" ? "127.0.0.1" : "0.0.0.0";
  server.listen(port, host, () => {
    console.log(`ValhallaOS backend health on ${host}:${port}/health`);
  });
}

export { httpRequest };
