import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { createLoginApp } from "../app";
import type { createPGLiteDb } from "../db/pglite";

const origin = "https://eliza.app";
const issuer = "https://identity.example.test";
const audience = "eliza-cloud-fixture";
const defaultTenantId = "clerk-default-test";
const otherTenantId = "clerk-other-test";
const testVerifierKey = ["sk", "fixture", "only", "never-used"].join("_");
const fixtureClaims: Record<
  string,
  { iss: string; sub: string; aud: string; azp: string; exp: number }
> = {
  "verified-main": {
    iss: issuer,
    sub: "clerk_main_fixture",
    aud: audience,
    azp: origin,
    exp: Math.floor(Date.now() / 1000) + 60,
  },
  "verified-new": {
    iss: issuer,
    sub: "clerk_new_fixture",
    aud: audience,
    azp: origin,
    exp: Math.floor(Date.now() / 1000) + 60,
  },
  "verified-collision": {
    iss: issuer,
    sub: "clerk_collision_fixture",
    aud: audience,
    azp: origin,
    exp: Math.floor(Date.now() / 1000) + 60,
  },
  "verified-other-tenant": {
    iss: issuer,
    sub: "clerk_other_tenant_fixture",
    aud: audience,
    azp: origin,
    exp: Math.floor(Date.now() / 1000) + 60,
  },
  "verified-unlinked": {
    iss: issuer,
    sub: "clerk_unlinked_fixture",
    aud: audience,
    azp: origin,
    exp: Math.floor(Date.now() / 1000) + 60,
  },
  "expired-fixture": {
    iss: issuer,
    sub: "clerk_expired_fixture",
    aud: audience,
    azp: origin,
    exp: 1,
  },
  "wrong-issuer-fixture": {
    iss: "https://wrong.example.test",
    sub: "clerk_wrong_issuer_fixture",
    aud: audience,
    azp: origin,
    exp: Math.floor(Date.now() / 1000) + 60,
  },
  "wrong-audience-fixture": {
    iss: issuer,
    sub: "clerk_wrong_audience_fixture",
    aud: "another-audience",
    azp: origin,
    exp: Math.floor(Date.now() / 1000) + 60,
  },
  "wrong-origin-fixture": {
    iss: issuer,
    sub: "clerk_wrong_origin_fixture",
    aud: audience,
    azp: "https://untrusted.example.test",
    exp: Math.floor(Date.now() / 1000) + 60,
  },
};

mock.module("@clerk/backend", () => ({
  verifyToken: async (
    token: string,
    options: {
      issuer?: string;
      audience?: string | string[];
      authorizedParties?: string[];
    },
  ) => {
    const claims = fixtureClaims[token];
    if (
      !claims ||
      claims.exp <= Math.floor(Date.now() / 1000) ||
      claims.iss !== options.issuer ||
      claims.aud !== options.audience ||
      !options.authorizedParties?.includes(claims.azp)
    ) {
      throw new Error("Fixture token rejected");
    }
    return claims;
  },
}));

const environment: Record<string, string> = {
  NODE_ENV: "test",
  STEWARD_DB_MODE: "pglite",
  STEWARD_PGLITE_MEMORY: "true",
  STEWARD_MASTER_PASSWORD: randomBytes(32).toString("hex"),
  STEWARD_JWT_SECRET: randomBytes(32).toString("hex"),
  STEWARD_KDF_SALT: randomBytes(32).toString("hex"),
  STEWARD_AUDIT_HMAC_KEY: randomBytes(32).toString("hex"),
  STEWARD_DEFAULT_TENANT_ID: defaultTenantId,
  STEWARD_HUMAN_AUTH_PROVIDER: "clerk",
  CLERK_APPLICATION_ID: "app_3Lo8rOPgUxtDI69EGZQBY34ArhN",
  CLERK_SECRET_KEY: testVerifierKey,
  CLERK_ISSUER: issuer,
  CLERK_JWT_AUDIENCE: audience,
  CLERK_AUTHORIZED_PARTIES: origin,
  APP_URL: origin,
};
const previous = new Map<string, string | undefined>();
let app: ReturnType<typeof createLoginApp>;
let database: Awaited<ReturnType<typeof createPGLiteDb>>;
let mainUserId: string;
let otherUserId: string;
let collisionUserId: string;

beforeAll(async () => {
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  const { createPGLiteDb } = await import("../db/pglite");
  const { setPGLiteOverride } = await import("../db/client");
  database = await createPGLiteDb("memory://");
  setPGLiteOverride(database.db, () => database.client.close());
  const { tenants, tenantConfigs } = await import("../db/schema");
  await database.db.insert(tenants).values([
    {
      id: defaultTenantId,
      name: "Clerk default fixture",
      apiKeyHash: randomBytes(32).toString("hex"),
    },
    {
      id: otherTenantId,
      name: "Clerk other fixture",
      apiKeyHash: randomBytes(32).toString("hex"),
    },
  ]);
  await database.db.insert(tenantConfigs).values([
    { tenantId: defaultTenantId, joinMode: "closed" },
    { tenantId: otherTenantId, joinMode: "closed" },
  ]);
  const { users, userTenants, accounts } = await import("../db/schema-auth");
  const [mainUser] = await database.db
    .insert(users)
    .values({ email: "clerk-main@example.test", emailVerified: true })
    .returning();
  const [otherUser] = await database.db
    .insert(users)
    .values({ email: "clerk-other@example.test", emailVerified: true })
    .returning();
  const [collisionUser] = await database.db
    .insert(users)
    .values({ email: "clerk-collision@example.test", emailVerified: true })
    .returning();
  mainUserId = mainUser.id;
  otherUserId = otherUser.id;
  collisionUserId = collisionUser.id;
  await database.db.insert(userTenants).values([
    { userId: mainUserId, tenantId: defaultTenantId, role: "member" },
    { userId: otherUserId, tenantId: otherTenantId, role: "member" },
    { userId: collisionUserId, tenantId: defaultTenantId, role: "member" },
  ]);
  await database.db.insert(accounts).values([
    {
      userId: mainUserId,
      provider: "clerk",
      providerAccountId: identityKey("clerk_main_fixture"),
    },
    {
      userId: collisionUserId,
      provider: "clerk",
      providerAccountId: identityKey("clerk_collision_fixture"),
    },
    {
      userId: otherUserId,
      provider: "clerk",
      providerAccountId: identityKey("clerk_other_tenant_fixture"),
    },
  ]);
  const { createLoginApp } = await import("../app");
  app = createLoginApp();
}, 60_000);

afterAll(async () => {
  if (database) await database.client.close();
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function identityKey(subject: string): string {
  return createHash("sha256")
    .update(`clerk\u0000${issuer}\u0000${subject}`)
    .digest("hex");
}

function request(
  path: string,
  body?: object,
  authorization?: string,
  requestOrigin = origin,
) {
  return app.request(`https://login.example.test${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Origin: requestOrigin,
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function bearerToken(token: string): string {
  return ["Bearer", token].join(" ");
}

async function stewardSession(userId: string, mfaVerifiedAt?: number) {
  const { createSessionToken } = await import("../api/services/auth-lifecycle");
  return createSessionToken(userId, defaultTenantId, {
    userId,
    authMethod: "email",
    ...(mfaVerifiedAt === undefined ? {} : { mfaVerifiedAt }),
  });
}

test("Clerk exchange preserves internal identity and ignores tenant selection", async () => {
  const response = await request("/auth/clerk/exchange", {
    token: "verified-main",
    tenantId: otherTenantId,
  });
  expect(response.status).toBe(200);
  const data = await response.json();
  expect(data.user.id).toBe(mainUserId);
  const { verifyToken } = await import("../auth/jwt");
  const claims = await verifyToken(data.token);
  expect(claims.userId).toBe(mainUserId);
  expect(claims.tenantId).toBe(defaultTenantId);
});

test("Clerk exchange rejects expired, invalid, wrong-issuer, wrong-audience and wrong-origin tokens", async () => {
  for (const token of [
    "expired-fixture",
    "invalid-fixture",
    "wrong-issuer-fixture",
    "wrong-audience-fixture",
    "wrong-origin-fixture",
  ]) {
    const response = await request("/auth/clerk/exchange", { token });
    expect(response.status).toBe(401);
  }
  expect(
    (
      await request(
        "/auth/clerk/exchange",
        { token: "verified-main" },
        undefined,
        "https://untrusted.example.test",
      )
    ).status,
  ).toBe(403);
});

test("unlinked and cross-tenant Clerk identities cannot create a session", async () => {
  const unlinked = await request("/auth/clerk/exchange", {
    token: "verified-unlinked",
  });
  expect(unlinked.status).toBe(403);

  const otherTenant = await request("/auth/clerk/exchange", {
    token: "verified-other-tenant",
    tenantId: otherTenantId,
  });
  expect(otherTenant.status).toBe(403);
  const { users } = await import("../db/schema-auth");
  const allUsers = await database.db.select({ id: users.id }).from(users);
  expect(allUsers).toHaveLength(3);
});

test("linking requires recent Steward MFA and refuses identity collisions", async () => {
  const withoutMfa = await stewardSession(mainUserId);
  expect(
    (
      await request(
        "/auth/clerk/link",
        { token: "verified-new" },
        bearerToken(withoutMfa),
      )
    ).status,
  ).toBe(403);

  const collisionSession = await stewardSession(mainUserId, Date.now());
  expect(
    (
      await request(
        "/auth/clerk/link",
        { token: "verified-collision" },
        bearerToken(collisionSession),
      )
    ).status,
  ).toBe(409);
  const { accounts } = await import("../db/schema-auth");
  const [collision] = await database.db
    .select({ userId: accounts.userId })
    .from(accounts)
    .where(
      eq(accounts.providerAccountId, identityKey("clerk_collision_fixture")),
    );
  expect(collision.userId).toBe(collisionUserId);
});

test("explicit linking is idempotent and subsequent Clerk sign-in retains the canonical user", async () => {
  const stewardToken = await stewardSession(mainUserId, Date.now());
  const linked = await request(
    "/auth/clerk/link",
    { token: "verified-new" },
    bearerToken(stewardToken),
  );
  expect(linked.status).toBe(200);
  expect((await linked.json()).alreadyLinked).toBe(false);

  const repeated = await request(
    "/auth/clerk/link",
    { token: "verified-new" },
    bearerToken(stewardToken),
  );
  expect(repeated.status).toBe(200);
  expect((await repeated.json()).alreadyLinked).toBe(true);

  const exchanged = await request("/auth/clerk/exchange", {
    token: "verified-new",
  });
  expect(exchanged.status).toBe(200);
  expect((await exchanged.json()).user.id).toBe(mainUserId);
});

test("an exchanged Clerk session follows the existing logout revocation path", async () => {
  const exchange = await request("/auth/clerk/exchange", {
    token: "verified-main",
  });
  const session = await exchange.json();
  const logout = await request(
    "/auth/logout",
    { refreshToken: session.refreshToken },
    bearerToken(session.token),
  );
  expect(logout.status).toBe(200);
  const sessionCheck = await app.request(
    "https://login.example.test/auth/session",
    { headers: { Authorization: bearerToken(session.token) } },
  );
  expect((await sessionCheck.json()).authenticated).toBe(false);
});

test("the explicit Steward mode disables Clerk routes without a fallback", async () => {
  const previous = process.env.STEWARD_HUMAN_AUTH_PROVIDER;
  process.env.STEWARD_HUMAN_AUTH_PROVIDER = "steward";
  try {
    const status = await app.request(
      "https://login.example.test/auth/clerk/status",
    );
    expect((await status.json()).enabled).toBe(false);
    const exchange = await request("/auth/clerk/exchange", {
      token: "verified-main",
    });
    expect(exchange.status).toBe(503);
  } finally {
    if (previous === undefined) {
      delete process.env.STEWARD_HUMAN_AUTH_PROVIDER;
    } else {
      process.env.STEWARD_HUMAN_AUTH_PROVIDER = previous;
    }
  }
});
