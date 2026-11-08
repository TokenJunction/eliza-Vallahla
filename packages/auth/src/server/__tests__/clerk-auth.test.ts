import { describe, expect, test } from "bun:test";
import {
  clerkIdentityKey,
  getClerkAuthConfiguration,
  isClerkRequestOriginAllowed,
  SELECTED_CLERK_APPLICATION_ID,
  verifyClerkSessionIdentity,
} from "../api/services/clerk-auth";

const configEnv = {
  STEWARD_HUMAN_AUTH_PROVIDER: "clerk",
  CLERK_APPLICATION_ID: SELECTED_CLERK_APPLICATION_ID,
  CLERK_SECRET_KEY: ["sk", "fixture", "only", "not-real"].join("_"),
  CLERK_ISSUER: "https://identity.example.test",
  CLERK_JWT_AUDIENCE: "eliza-cloud",
  CLERK_AUTHORIZED_PARTIES:
    "https://app.example.test, https://staging.example.test",
};

describe("staged Clerk identity boundary", () => {
  test("requires explicit opt-in and the selected application", () => {
    expect(
      getClerkAuthConfiguration({
        ...configEnv,
        STEWARD_HUMAN_AUTH_PROVIDER: "steward",
      }),
    ).toBeNull();
    expect(
      getClerkAuthConfiguration({
        ...configEnv,
        CLERK_APPLICATION_ID: "another-application",
      }),
    ).toBeNull();
  });

  test("fails closed when issuer, audience, key, or authorized origins are invalid", () => {
    for (const change of [
      { CLERK_ISSUER: "http://identity.example.test" },
      { CLERK_JWT_AUDIENCE: "" },
      { CLERK_SECRET_KEY: "" },
      { CLERK_AUTHORIZED_PARTIES: "https://*.example.test" },
    ]) {
      expect(getClerkAuthConfiguration({ ...configEnv, ...change })).toBeNull();
    }
  });

  test("accepts only configured HTTPS browser origins", () => {
    const config = getClerkAuthConfiguration(configEnv);
    expect(config).not.toBeNull();
    if (!config) throw new Error("Safe Clerk fixture configuration rejected");
    expect(
      isClerkRequestOriginAllowed("https://app.example.test", config),
    ).toBe(true);
    expect(
      isClerkRequestOriginAllowed("https://untrusted.example.test", config),
    ).toBe(false);
    expect(
      isClerkRequestOriginAllowed("https://app.example.test/path", config),
    ).toBe(false);
    expect(isClerkRequestOriginAllowed(undefined, config)).toBe(false);
  });

  test("passes issuer, audience and authorized parties to Clerk verification", async () => {
    const config = getClerkAuthConfiguration(configEnv);
    expect(config).not.toBeNull();
    if (!config) throw new Error("Safe Clerk fixture configuration rejected");
    const verifier = async (
      token: string,
      options: {
        secretKey?: string;
        issuer?: string;
        audience?: string | string[];
        authorizedParties?: string[];
      },
    ) => {
      expect(options.issuer).toBe(config.issuer);
      expect(options.audience).toBe(config.audience);
      expect(options.authorizedParties).toEqual(config.authorizedParties);
      if (token !== "verified-fixture")
        throw new Error("Invalid fixture token");
      return {
        iss: config.issuer,
        sub: "user_fixture",
        aud: config.audience,
        azp: config.authorizedParties[0],
        exp: Math.floor(Date.now() / 1000) + 60,
      };
    };

    await expect(
      verifyClerkSessionIdentity("verified-fixture", config, verifier),
    ).resolves.toEqual({
      issuer: config.issuer,
      subject: "user_fixture",
    });
    await expect(
      verifyClerkSessionIdentity("invalid-fixture", config, verifier),
    ).resolves.toBeNull();
    await expect(
      verifyClerkSessionIdentity("verified-fixture", config, async () => ({
        iss: "https://wrong-issuer.example.test",
        sub: "user_fixture",
      })),
    ).resolves.toBeNull();
    await expect(
      verifyClerkSessionIdentity("verified-fixture", config, async () => ({
        iss: config.issuer,
        sub: "",
      })),
    ).resolves.toBeNull();
  });

  test("hashes the verified issuer and subject into a stable account key", () => {
    expect(
      clerkIdentityKey("https://identity.example.test", "user_fixture"),
    ).toBe(clerkIdentityKey("https://identity.example.test", "user_fixture"));
    expect(
      clerkIdentityKey("https://identity.example.test", "user_fixture"),
    ).not.toBe(clerkIdentityKey("https://other.example.test", "user_fixture"));
  });
});
