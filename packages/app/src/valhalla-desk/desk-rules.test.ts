import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { sameOriginTabUrl } from "./browser-nav.ts";
import { elizaServiceStatus } from "./eliza-service.ts";
import { MockCredentialVault } from "./mock-adapters.ts";
import {
  cloudFallbackCopy,
  EMPTY_PUBLIC,
  probeRoute,
  validatePublic,
  validateSecret,
} from "./model.ts";
import { THEME_IDS, themeIsReadable } from "./theme.ts";
import { classifyPublicEndpoint } from "./web4.ts";
import { createWindowManager, reduceWindows } from "./window-manager.ts";

const ownerAddress = ["keene.jos", "gmail.com"].join("@");

describe("public setup validation", () => {
  test("rejects an empty customer form and keeps no default admin", () => {
    const result = validatePublic(EMPTY_PUBLIC);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.adminEmail).toContain("no default");
    expect(result.errors.deploymentTarget).toContain("your own");
    expect(JSON.stringify(EMPTY_PUBLIC)).not.toContain(ownerAddress);
  });

  test("accepts the customer's own public values", () => {
    const result = validatePublic({
      ...EMPTY_PUBLIC,
      brandName: "Northwind Desk",
      adminEmail: "admin@example.invalid",
      deploymentTarget: "https://northwind.example.invalid",
      supabaseHost: "db.example.invalid",
      supabasePort: "6543",
      supabaseDatabase: "desk",
      supabaseUser: "desk_admin",
      upstashRestUrl: "https://cache.example.invalid",
    });
    expect(result.ok).toBe(true);
  });

  test("rejects a short secret and does not invent one", () => {
    expect(validateSecret("geminiChatKey", "short")).toContain("Gemini");
    expect(validateSecret("upstashToken", "long-enough")).toBe("");
  });
});

describe("model routes", () => {
  test("missing keys, blocked local Ollama, and explicit cloud fallback stay offline", () => {
    const local = probeRoute({
      id: "ollama-local",
      keySaved: false,
      mockMode: "accept",
      localMockReachable: false,
      localBaseUrl: "http://127.0.0.1:11434",
      openAiBaseUrl: "",
      openAiModel: "",
      deepseekModel: "",
    });
    expect(local.status).toBe("unreachable");
    expect(local.message).toContain("does not fail over");
    expect(local.message).toContain("Not connected");

    const cloud = probeRoute({
      id: "ollama-cloud",
      keySaved: false,
      mockMode: "accept",
      localMockReachable: false,
      localBaseUrl: "",
      openAiBaseUrl: "",
      openAiModel: "",
      deepseekModel: "",
    });
    expect(cloud.status).toBe("auth-missing");

    const fallback = cloudFallbackCopy({
      localMockReachable: false,
      cloudKeySaved: false,
    });
    expect(fallback).toContain("not native Ollama behavior");
    expect(fallback).toContain("credential is missing");
    expect(fallback).toContain("Not connected");
  });

  test("a mock rejection is not a live provider failure response", () => {
    const result = probeRoute({
      id: "gemini-chat",
      keySaved: true,
      mockMode: "reject",
      localMockReachable: false,
      localBaseUrl: "",
      openAiBaseUrl: "",
      openAiModel: "",
      deepseekModel: "",
    });
    expect(result.status).toBe("mock-rejected");
    expect(result.message).toContain("No call was made");
  });

  test("DeepSeek stays separate and does not treat a subscription as balance", () => {
    const result = probeRoute({
      id: "deepseek",
      keySaved: true,
      mockMode: "accept",
      localMockReachable: false,
      localBaseUrl: "",
      openAiBaseUrl: "",
      openAiModel: "",
      deepseekModel: "deepseek-flash",
    });
    expect(result.message).toContain("reasoning_content was not received");
    expect(result.message).toContain("subscription");
    expect(result.status).not.toBe("auth-missing");
    expect(result.message).toContain("Not connected");
  });
});

describe("mock credential vault", () => {
  test("keeps a secret in memory only", () => {
    const writes: string[] = [];
    const storage = globalThis.localStorage;
    const original = storage.setItem.bind(storage);
    storage.setItem = (key: string, value: string) => {
      writes.push(`${key}=${value}`);
      original(key, value);
    };
    const vault = new MockCredentialVault();
    const secret = "runtime-memory-only-value";
    vault.save("geminiChatKey", secret);
    expect(vault.readForTest("geminiChatKey")).toBe(secret);
    expect(vault.has("geminiChatKey")).toBe(true);
    expect(writes).toEqual([]);
    storage.setItem = original;
  });
});

test("light and colorblind themes stay readable without color-only status", () => {
  for (const id of THEME_IDS) {
    expect(themeIsReadable(id)).toBe(true);
  }
});

test("ElizaOS health is not requested from the browser", () => {
  const health = elizaServiceStatus();
  expect(health.state).toBe("not-configured");
  expect(health.detail).toContain("No browser request");
  expect(health.detail).toContain("Not connected");
  expect(classifyPublicEndpoint("http://example.invalid").kind).toBe(
    "rejected",
  );
  expect(classifyPublicEndpoint("https://example.invalid/read").kind).toBe(
    "https-read",
  );
});

test("a new browser tab stays on this origin", () => {
  expect(
    sameOriginTabUrl("https://example.invalid/", "http://127.0.0.1:5176").ok,
  ).toBe(false);
  const local = sameOriginTabUrl(
    "http://127.0.0.1:5176/desk.html",
    "http://127.0.0.1:5176",
  );
  expect(local.ok).toBe(true);
});

describe("window manager", () => {
  test("opens, focuses, minimizes, restores, and closes", () => {
    const opened = reduceWindows(createWindowManager(), {
      type: "open",
      id: "models",
    });
    expect(opened.activeId).toBe("models");
    const minimized = reduceWindows(opened, { type: "minimize", id: "models" });
    expect(
      minimized.frames.find((frame) => frame.id === "models")?.minimized,
    ).toBe(true);
    expect(minimized.activeId).not.toBe("models");
    const restored = reduceWindows(minimized, {
      type: "taskbar",
      id: "models",
    });
    expect(restored.activeId).toBe("models");
    expect(
      restored.frames.find((frame) => frame.id === "models")?.minimized,
    ).toBe(false);
    const closed = reduceWindows(restored, { type: "close", id: "models" });
    expect(closed.frames.find((frame) => frame.id === "models")?.open).toBe(
      false,
    );
  });
});

describe("prototype source", () => {
  test("does not prefill the owner address or touch browser secret stores", () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name !== "desk-rules.test.ts" &&
          entry.name !== "desk.test.tsx",
      )
      .map((entry) => join(root, entry.name));
    const setupRoot = join(root, "../../../os/setup");
    files.push(
      join(setupRoot, "src/valhalla-desk/main.tsx"),
      join(setupRoot, "desk.html"),
      join(setupRoot, "vite.desk.config.ts"),
    );
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(source).not.toContain(ownerAddress);
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("indexedDB");
    expect(source).not.toContain("document.cookie");
    expect(source).not.toContain("process.env");
  });
});
