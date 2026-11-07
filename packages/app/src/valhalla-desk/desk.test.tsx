import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DeskApp, DeskErrorBoundary } from "./DeskApp.tsx";
import { PUBLIC_FIXTURE } from "./fixtures.ts";
import { MockCredentialVault } from "./mock-adapters.ts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
};

let mounted: Mounted | null = null;
let setItem: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  setItem = vi.spyOn(Storage.prototype, "setItem");
  vi.stubGlobal("indexedDB", {
    open() {
      throw new Error("indexedDB should stay unused");
    },
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  setItem?.mockRestore();
  setItem = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function mount(ui: ReactElement = <DeskApp />): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  mounted = {
    container,
    root,
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
  return mounted;
}

function setControl(id: string, value: string) {
  const element = document.getElementById(id);
  if (
    !(element instanceof HTMLInputElement) &&
    !(element instanceof HTMLSelectElement)
  ) {
    throw new Error(`Missing control ${id}`);
  }
  const prototype =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}

function click(id: string) {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing ${id}`);
  act(() => {
    element.click();
  });
}

function text(): string {
  return document.body.textContent ?? "";
}

function fillPublic() {
  for (const [id, value] of Object.entries(PUBLIC_FIXTURE)) {
    if (!value) continue;
    setControl(id, value);
  }
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

function runtimeSecret(): string {
  return `runtime-${Math.random().toString(16).slice(2)}pad`;
}

test("happy path saves public settings and hides secret credentials", () => {
  const vault = new MockCredentialVault();
  mount(<DeskApp vault={vault} />);
  expect(text()).toContain("First-run setup is incomplete.");
  expect(
    (document.getElementById("adminEmail") as HTMLInputElement).value,
  ).toBe("");
  expect(
    (document.getElementById("ownerOverrideEmail") as HTMLInputElement).value,
  ).toBe("");
  fillPublic();
  click("save-public");
  expect(document.getElementById("first-run-banner")).toBeNull();
  expect(document.getElementById("public-summary")?.textContent).toContain(
    "Northwind Desk",
  );
  expect(document.getElementById("public-summary")?.textContent).toContain(
    "Blank",
  );
  const databaseSecret = runtimeSecret();
  const cacheSecret = runtimeSecret();
  click("edit-public");
  expect(document.getElementById("brandName")).toBeTruthy();
  click("save-public");
  setControl("supabasePassword", databaseSecret);
  setControl("upstashToken", cacheSecret);
  click("save-db-secrets");
  expect(
    (document.getElementById("supabasePassword") as HTMLInputElement).value,
  ).toBe("");
  expect(text()).not.toContain(databaseSecret);
  expect(text()).not.toContain(cacheSecret);
  expect(text()).toContain("saved in the prototype mock (hidden)");
  expect(vault.readForTest("supabasePassword")).toBe(databaseSecret);
  expect(vault.readForTest("upstashToken")).toBe(cacheSecret);
  expect(setItem).not.toHaveBeenCalled();
  expect(window.location.href).not.toContain(databaseSecret);
});

test("invalid public input keeps the values the customer typed", () => {
  mount();
  click("save-public");
  expect(text()).toContain("Enter a brand name");
  expect(text()).toContain("There is no default");
  setControl("brandName", "Northwind Desk");
  click("save-public");
  expect((document.getElementById("brandName") as HTMLInputElement).value).toBe(
    "Northwind Desk",
  );
  expect(text()).toContain("Enter the deployment admin email");
  expect(text()).not.toContain("Enter a brand name");
  const shortSecret = "short";
  setControl("supabasePassword", shortSecret);
  click("save-db-secrets");
  expect(
    (document.getElementById("supabasePassword") as HTMLInputElement).value,
  ).toBe(shortSecret);
  expect(text()).toContain("Supabase database password");
});

test("a failed provider test stays offline and does not echo the key", async () => {
  const vault = new MockCredentialVault();
  const secret = runtimeSecret();
  mount(<DeskApp vault={vault} />);
  click("desk-icon-models");
  setControl("mockMode", "reject");
  setControl("geminiChatKey", secret);
  click("save-geminiChatKey");
  expect(text()).not.toContain(secret);
  expect(vault.readForTest("geminiChatKey")).toBe(secret);
  click("probe-gemini-chat");
  await flush();
  const route = document.getElementById("route-gemini-chat");
  expect(route?.getAttribute("data-status")).toBe("mock-rejected");
  expect(route?.textContent).toContain("No call was made");
  expect(route?.textContent).toContain("Not connected");
  expect(text()).not.toContain(secret);
  expect(setItem).not.toHaveBeenCalled();
});

test("missing provider keys, blocked Ollama, and cloud fallback are not connected", () => {
  mount();
  click("desk-icon-models");
  expect(
    document.getElementById("route-gemini-chat")?.getAttribute("data-status"),
  ).toBe("auth-missing");
  expect(
    document.getElementById("route-gemini-live")?.getAttribute("data-status"),
  ).toBe("unsupported");
  expect(
    document.getElementById("route-gemini-tts")?.getAttribute("data-status"),
  ).toBe("unsupported");
  expect(document.getElementById("probe-gemini-live")).toHaveProperty(
    "disabled",
    true,
  );
  expect(document.getElementById("probe-gemini-tts")).toHaveProperty(
    "disabled",
    true,
  );
  expect(
    document.getElementById("route-ollama-local")?.getAttribute("data-status"),
  ).toBe("unreachable");
  expect(
    document.getElementById("route-ollama-cloud")?.getAttribute("data-status"),
  ).toBe("auth-missing");
  expect(
    document
      .getElementById("route-cloud-fallback")
      ?.getAttribute("data-status"),
  ).toBe("not-connected");
  expect(
    document.getElementById("route-cloud-fallback")?.textContent,
  ).toContain("not native Ollama behavior");
  expect(text()).toContain("thinking.type");
  expect(text()).toContain("reasoning_content");
  expect(text()).toContain("Plus does not unlock");
  for (const node of document.querySelectorAll("[data-status]")) {
    expect(node.getAttribute("data-status")).not.toBe("connected");
    expect(node.getAttribute("data-status")).not.toBe("live");
  }
  expect(text()).not.toContain("automatically fall");
});

test("Telegram, X, and Drive stay disconnected without credentials", async () => {
  mount(<DeskApp autoResolveDrive={false} />);
  click("desk-icon-channels");
  expect(
    document
      .querySelector("[data-channel='telegram']")
      ?.getAttribute("data-status"),
  ).toBe("not-connected");
  expect(
    document.querySelector("[data-channel='x']")?.getAttribute("data-status"),
  ).toBe("not-connected");
  expect(text()).not.toContain("Status: connected");
  click("desk-icon-storage");
  expect(
    document.getElementById("drive-panel")?.getAttribute("data-drive-state"),
  ).toBe("not-authorized");
  expect(text()).toContain("separate from Valhalla sign-in");
  click("drive-connect");
  expect(
    document.getElementById("drive-panel")?.getAttribute("data-drive-state"),
  ).toBe("pending");
  expect(text()).toContain("pending in the prototype mock");
  click("drive-fail");
  expect(
    document.getElementById("drive-panel")?.getAttribute("data-drive-state"),
  ).toBe("error");
  expect(text()).toContain("did not finish");
  expect(text()).not.toContain("TypeError");
  mounted?.unmount();
  mount();
  click("desk-icon-storage");
  click("drive-connect");
  await flush();
  expect(
    document.getElementById("drive-panel")?.getAttribute("data-drive-state"),
  ).toBe("authorized-mock");
  expect(text()).toContain("No Google OAuth ran");
  click("drive-disconnect");
  expect(document.getElementById("desk-dialog")).toBeTruthy();
  click("desk-dialog-cancel");
  expect(
    document.getElementById("drive-panel")?.getAttribute("data-drive-state"),
  ).toBe("authorized-mock");
  click("drive-disconnect");
  click("desk-dialog-confirm");
  expect(
    document.getElementById("drive-panel")?.getAttribute("data-drive-state"),
  ).toBe("not-authorized");
});

test("install and revoke ask for confirmation", () => {
  mount();
  click("desk-icon-apps");
  expect(text()).toContain("No app is installed yet.");
  expect(text()).toContain("Preview");
  expect(text()).toContain("No canister is deployed");
  click("app-install-thalos");
  expect(text()).toContain("Install Thalos");
  click("desk-dialog-cancel");
  expect(
    document
      .querySelector("[data-app='thalos']")
      ?.getAttribute("data-installed"),
  ).toBe("no");
  click("app-install-motoko");
  click("desk-dialog-confirm");
  expect(
    document
      .querySelector("[data-app='motoko']")
      ?.getAttribute("data-installed"),
  ).toBe("yes");
  expect(text()).toContain("No canister deploy");
  click("app-revoke-motoko");
  click("desk-dialog-confirm");
  expect(
    document
      .querySelector("[data-app='motoko']")
      ?.getAttribute("data-installed"),
  ).toBe("no");
});

test("services record mock start and stop only after selection", () => {
  mount();
  click("desk-icon-services");
  expect(text()).toContain("No service is selected.");
  expect(text()).toContain("spins down after about 15 minutes");
  click("services-start");
  expect(text()).toContain("Select a service first.");
  click("service-odin");
  click("services-start");
  expect(
    document.querySelector("[data-service='odin']")?.getAttribute("data-run"),
  ).toBe("mock-start-recorded");
  expect(text()).toContain("No Render service was started");
  click("services-stop");
  expect(
    document.querySelector("[data-service='odin']")?.getAttribute("data-run"),
  ).toBe("stopped");
});

test("keyboard can leave a dialog and Escape closes it", () => {
  mount();
  click("desk-icon-apps");
  const install = document.getElementById("app-install-thalos");
  if (!(install instanceof HTMLButtonElement))
    throw new Error("missing install");
  install.focus();
  click("app-install-thalos");
  expect(document.activeElement?.id).toBe("desk-dialog-cancel");
  const dialog = document.getElementById("desk-dialog");
  const tab = new KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    dialog?.dispatchEvent(tab);
  });
  expect(tab.defaultPrevented).toBe(false);
  act(() => {
    document.getElementById("desk-icon-setup")?.focus();
  });
  expect(document.activeElement?.id).toBe("desk-icon-setup");
  expect(document.getElementById("desk-dialog")).toBeTruthy();
  act(() => {
    document.getElementById("desk-dialog-cancel")?.focus();
    document
      .getElementById("desk-dialog")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
  });
  expect(document.getElementById("desk-dialog")).toBeNull();
  expect(document.activeElement?.id).toBe("app-install-thalos");
});

test("window controls minimize, restore, and return focus on close", () => {
  mount();
  click("desk-icon-models");
  const models = document.querySelector("[data-window='models']");
  expect(models?.getAttribute("data-active")).toBe("true");
  const minimize = document.querySelector("[aria-label='Minimize Models']");
  if (!(minimize instanceof HTMLButtonElement))
    throw new Error("missing minimize");
  act(() => {
    minimize.focus();
    minimize.click();
  });
  expect(
    document.querySelector("[data-window='models']")?.hasAttribute("hidden"),
  ).toBe(true);
  click("taskbar-models");
  expect(
    document.querySelector("[data-window='models']")?.hasAttribute("hidden"),
  ).toBe(false);
  const close = document.querySelector("[aria-label='Close Models']");
  if (!(close instanceof HTMLButtonElement)) throw new Error("missing close");
  act(() => {
    close.focus();
    close.click();
  });
  expect(document.querySelector("[data-window='models']")).toBeNull();
  expect(document.activeElement?.id).toBe("desk-icon-models");
});

test("the error boundary hides technical details", () => {
  function Boom(): ReactElement {
    throw new Error("database password leaked in a stack");
  }
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mount(
    <DeskErrorBoundary>
      <Boom />
    </DeskErrorBoundary>,
  );
  expect(text()).toContain("Technical details stay hidden");
  expect(text()).not.toContain("database password leaked");
});
