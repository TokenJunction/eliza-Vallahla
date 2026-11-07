const PREFERENCE_KEY = "valhalla-workspace-preference";

export type WorkspacePreference = {
  displayName: string;
  bootSeen: boolean;
};

export function sanitizeDisplayName(input: string): string {
  let cleaned = "";
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 31 && code !== 127) cleaned += char;
  }
  return cleaned.trim().slice(0, 40);
}

export function readWorkspacePreference(storage: Storage): WorkspacePreference {
  const raw = storage.getItem(PREFERENCE_KEY);
  if (!raw) return { displayName: "", bootSeen: false };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { displayName: "", bootSeen: false };
    }
    const record = parsed as Record<string, unknown>;
    return {
      displayName:
        typeof record.displayName === "string"
          ? sanitizeDisplayName(record.displayName)
          : "",
      bootSeen: record.bootSeen === true,
    };
  } catch {
    return { displayName: "", bootSeen: false };
  }
}

export function writeWorkspacePreference(
  storage: Storage,
  preference: WorkspacePreference,
): void {
  const stored: WorkspacePreference = {
    displayName: sanitizeDisplayName(preference.displayName),
    bootSeen: preference.bootSeen,
  };
  storage.setItem(PREFERENCE_KEY, JSON.stringify(stored));
}
