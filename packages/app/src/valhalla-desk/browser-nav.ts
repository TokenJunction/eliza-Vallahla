export type BrowserTab = {
  id: string;
  history: string[];
  index: number;
};

const BOOKMARK_KEY = "valhalla-desk-bookmarks";

export function validatePublicUrl(
  input: string,
): { ok: true; url: string } | { ok: false; message: string } {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return { ok: false, message: "Enter a full http or https address." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      message:
        "Only http and https addresses can be opened. Script and browser-internal addresses are blocked.",
    };
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      message: "Addresses with a username or password are blocked.",
    };
  }
  if (!parsed.hostname) {
    return { ok: false, message: "The address needs a host." };
  }
  return { ok: true, url: parsed.toString() };
}

export function embedPolicy(
  url: string,
  pageOrigin: string,
): { allowed: boolean; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      allowed: false,
      reason: "The address is not valid, so it is not embedded.",
    };
  }
  if (parsed.origin === pageOrigin && pageOrigin !== "null") {
    return { allowed: true, reason: "A same-origin page can be embedded." };
  }
  return {
    allowed: false,
    reason:
      "This site is not embedded. It may block frames with X-Frame-Options or CSP. Open it outside this desk. This desk does not proxy the site.",
  };
}

export function sameOriginTabUrl(
  input: string,
  pageOrigin: string,
): { ok: true; url: string } | { ok: false; message: string } {
  const parsed = validatePublicUrl(input);
  if (!parsed.ok) return parsed;
  if (new URL(parsed.url).origin !== pageOrigin) {
    return {
      ok: false,
      message:
        "New tabs stay on this origin. Open other sites with Open outside.",
    };
  }
  return parsed;
}

export function createTab(id: string, url: string): BrowserTab {
  return { id, history: [url], index: 0 };
}

export function navigateTab(tab: BrowserTab, url: string): BrowserTab {
  const history = tab.history.slice(0, tab.index + 1);
  history.push(url);
  return { ...tab, history, index: history.length - 1 };
}

export function goBack(tab: BrowserTab): BrowserTab {
  if (tab.index <= 0) return tab;
  return { ...tab, index: tab.index - 1 };
}

export function goForward(tab: BrowserTab): BrowserTab {
  if (tab.index >= tab.history.length - 1) return tab;
  return { ...tab, index: tab.index + 1 };
}

export function currentUrl(tab: BrowserTab): string {
  return tab.history[tab.index] ?? "";
}

export function loadBookmarkPreference(storage: Storage): string[] {
  const raw = storage.getItem(BOOKMARK_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is string =>
        typeof item === "string" && validatePublicUrl(item).ok,
    );
  } catch {
    return [];
  }
}

export function saveBookmarkPreference(
  urls: readonly string[],
  storage: Storage,
): void {
  const safe = urls.filter((url) => validatePublicUrl(url).ok);
  storage.setItem(BOOKMARK_KEY, JSON.stringify(safe));
}
