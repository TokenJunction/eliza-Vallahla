export type HumanLoginProvider = "steward" | "clerk" | "unavailable";

export function resolveHumanLoginProvider(
  value: string | undefined,
): HumanLoginProvider {
  const provider = value?.trim();
  if (!provider || provider === "steward") return "steward";
  if (provider === "clerk") return "clerk";
  return "unavailable";
}

export function resolveClerkJwtTemplate(
  value: string | undefined,
): string | null {
  const template = value?.trim();
  return template || null;
}
