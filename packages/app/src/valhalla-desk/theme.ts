export const THEME_IDS = ["navy", "light", "colorblind"] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export type ThemeTokens = {
  label: string;
  desk: string;
  panel: string;
  ink: string;
  accent: string;
};

export const THEMES: Record<ThemeId, ThemeTokens> = {
  navy: {
    label: "Navy",
    desk: "#0c1421",
    panel: "#172333",
    ink: "#f2f3f6",
    accent: "#e3c27c",
  },
  light: {
    label: "Light",
    desk: "#f4f1ea",
    panel: "#fffdf8",
    ink: "#101722",
    accent: "#6b4e16",
  },
  colorblind: {
    label: "Colorblind",
    desk: "#0c1421",
    panel: "#172333",
    ink: "#f2f3f6",
    accent: "#e3c27c",
  },
};

const THEME_KEY = "valhalla-desk-theme";

export function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  const darker = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  return (lighter + 0.05) / (darker + 0.05);
}

export function themeIsReadable(id: ThemeId): boolean {
  const theme = THEMES[id];
  return (
    contrastRatio(theme.ink, theme.panel) >= 4.5 &&
    contrastRatio(theme.ink, theme.desk) >= 4.5
  );
}

export function readThemePreference(storage: Storage): ThemeId {
  const value = storage.getItem(THEME_KEY);
  if (value === "navy" || value === "classic") return "navy";
  if (value === "light" || value === "paper") return "light";
  if (value === "colorblind" || value === "contrast") return "colorblind";
  return "navy";
}

export function writeThemePreference(storage: Storage, id: ThemeId): void {
  storage.setItem(THEME_KEY, id);
}

function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((start) => {
    const byte = Number.parseInt(value.slice(start, start + 2), 16) / 255;
    return byte <= 0.03928 ? byte / 12.92 : ((byte + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * (channels[0] ?? 0) +
    0.7152 * (channels[1] ?? 0) +
    0.0722 * (channels[2] ?? 0)
  );
}
