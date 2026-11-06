import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import {
  type AuthCheck,
  defaultAuthSource,
  ValhallaWorkspace,
} from "./ValhallaWorkspace.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let mounted: { unmount: () => void } | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = "";
});

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

function mount(ui: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  mounted = {
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(id: string) {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing ${id}`);
  act(() => {
    element.click();
  });
}

function setControl(id: string, value: string) {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`Missing ${id}`);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const verified = async (): Promise<AuthCheck> => ({
  state: "verified",
  source: "GET /api/v1/session",
  displayName: "",
});

test("Ascent keeps a failed signup check visible and does not grant admin", async () => {
  mount(<ValhallaWorkspace storage={memoryStorage()} reducedMotion />);
  await flush();
  expect(document.getElementById("ascent-auth")?.textContent).toContain(
    "not signed in",
  );
  expect(document.getElementById("ascent-auth")?.textContent).toContain(
    "not an admin",
  );
  expect(document.getElementById("ascent-primary")?.textContent).toBe(
    "Retry session check",
  );
  expect(document.getElementById("workspace-heading")).toBeNull();
});

test("GET /api/v1/session failure is not a signed-in session", async () => {
  const seen: string[] = [];
  const result = await defaultAuthSource(async (input) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ available: false, reason: "session_inventory_unavailable" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  expect(seen).toEqual(["/api/v1/session"]);
  expect(result.state).toBe("unavailable");
  if (result.state === "unavailable") {
    expect(result.message).toContain("session_inventory_unavailable");
  }
});

test("verified entry, local label, Guide, and Omni stay inside real boundaries", async () => {
  const storage = memoryStorage();
  const label = "<img src=x onerror=alert(1)>";
  mount(
    <ValhallaWorkspace storage={storage} reducedMotion authSource={verified} />,
  );
  await flush();
  expect(document.getElementById("ascent-auth")?.textContent).toContain(
    "not an admin role",
  );
  click("ascent-primary");
  setControl("ascent-name", label);
  click("ascent-primary");
  await flush();
  click("ascent-primary");
  const name = document.getElementById("workspace-name");
  expect(name?.textContent).toBe(label);
  expect(document.querySelector("#workspace-hello img")).toBeNull();
  expect(document.getElementById("setup-guide")?.textContent).toContain(
    "A few things to get you started",
  );
  click("guide-models");
  expect(document.querySelector("[data-window='models']")).toBeTruthy();
  setControl("command-input", "hello");
  const form = document.getElementById("command-form");
  if (!(form instanceof HTMLFormElement)) throw new Error("missing command");
  await act(async () => {
    form.requestSubmit();
    await Promise.resolve();
  });
  expect(document.getElementById("command-log")?.textContent).toContain(
    "No model was called",
  );
  expect(document.body.textContent).not.toContain(
    "model-generated audio is playing",
  );
  const raw = storage.getItem("valhalla-workspace-preference") ?? "";
  expect(raw).toContain("bootSeen");
  expect(raw).not.toContain("admin");
});
