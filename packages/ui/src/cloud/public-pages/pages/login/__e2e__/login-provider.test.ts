import { describe, expect, it } from "vitest";
import {
  resolveClerkJwtTemplate,
  resolveHumanLoginProvider,
} from "../login-provider";

describe("resolveHumanLoginProvider", () => {
  it("keeps Steward as the default", () => {
    expect(resolveHumanLoginProvider(undefined)).toBe("steward");
    expect(resolveHumanLoginProvider("steward")).toBe("steward");
  });

  it("selects Clerk only by an explicit value", () => {
    expect(resolveHumanLoginProvider("clerk")).toBe("clerk");
  });

  it("fails closed for unsupported values", () => {
    expect(resolveHumanLoginProvider("unknown")).toBe("unavailable");
  });
});

describe("resolveClerkJwtTemplate", () => {
  it("requires a configured template name", () => {
    expect(resolveClerkJwtTemplate(undefined)).toBeNull();
    expect(resolveClerkJwtTemplate("  ")).toBeNull();
  });

  it("trims the configured template name", () => {
    expect(resolveClerkJwtTemplate(" steward-api ")).toBe("steward-api");
  });
});
