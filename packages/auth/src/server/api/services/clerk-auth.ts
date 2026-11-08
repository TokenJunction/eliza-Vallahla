import { createHash } from "node:crypto";
import { verifyToken as verifyClerkToken } from "@clerk/backend";

export const SELECTED_CLERK_APPLICATION_ID = "app_3Lo8rOPgUxtDI69EGZQBY34ArhN";

export interface ClerkAuthConfiguration {
  applicationId: string;
  secretKey: string;
  issuer: string;
  audience: string;
  authorizedParties: string[];
}

interface ClerkVerifierOptions {
  secretKey: string;
  issuer: string;
  audience: string;
  authorizedParties: string[];
}

type ClerkTokenVerifier = (
  token: string,
  options: ClerkVerifierOptions,
) => Promise<{ iss?: unknown; sub?: unknown }>;

function isSecureUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function parseAuthorizedParties(value: string | undefined): string[] | null {
  if (!value) return null;
  const parties = value
    .split(",")
    .map((party) => party.trim())
    .filter(Boolean);
  if (parties.length === 0) return null;

  const origins: string[] = [];
  for (const party of parties) {
    if (party.includes("*")) return null;
    const url = isSecureUrl(party);
    if (!url || (url.pathname !== "/" && url.pathname !== "")) return null;
    const origin = url.origin;
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

export function getClerkAuthConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): ClerkAuthConfiguration | null {
  if (env.STEWARD_HUMAN_AUTH_PROVIDER?.trim() !== "clerk") return null;

  const applicationId = env.CLERK_APPLICATION_ID?.trim();
  const secretKey = env.CLERK_SECRET_KEY?.trim();
  const issuer = env.CLERK_ISSUER?.trim();
  const audience = env.CLERK_JWT_AUDIENCE?.trim();
  const authorizedParties = parseAuthorizedParties(
    env.CLERK_AUTHORIZED_PARTIES,
  );
  const issuerUrl = issuer ? isSecureUrl(issuer) : null;

  if (
    applicationId !== SELECTED_CLERK_APPLICATION_ID ||
    !secretKey?.startsWith("sk_") ||
    secretKey.length < 20 ||
    !issuerUrl ||
    (issuerUrl.pathname !== "/" && issuerUrl.pathname !== "") ||
    !audience ||
    !authorizedParties
  ) {
    return null;
  }

  return {
    applicationId,
    secretKey,
    issuer: issuerUrl.origin,
    audience,
    authorizedParties,
  };
}

export function isClerkRequestOriginAllowed(
  origin: string | undefined,
  config: ClerkAuthConfiguration,
): boolean {
  if (!origin) return false;
  const url = isSecureUrl(origin);
  return Boolean(
    url &&
      (url.pathname === "/" || url.pathname === "") &&
      config.authorizedParties.includes(url.origin),
  );
}

export async function verifyClerkSessionIdentity(
  token: string,
  config: ClerkAuthConfiguration,
  verifier: ClerkTokenVerifier = verifyClerkToken,
): Promise<{ issuer: string; subject: string } | null> {
  if (!token || token.length > 16_384) return null;
  try {
    const payload = await verifier(token, {
      secretKey: config.secretKey,
      issuer: config.issuer,
      audience: config.audience,
      authorizedParties: config.authorizedParties,
    });
    if (
      payload.iss !== config.issuer ||
      typeof payload.sub !== "string" ||
      payload.sub.length === 0 ||
      payload.sub.length > 255
    ) {
      return null;
    }
    return { issuer: config.issuer, subject: payload.sub };
  } catch {
    return null;
  }
}

export function clerkIdentityKey(issuer: string, subject: string): string {
  return createHash("sha256")
    .update(`clerk\u0000${issuer}\u0000${subject}`)
    .digest("hex");
}
