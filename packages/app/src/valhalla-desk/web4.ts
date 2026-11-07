/**
 * Public network notes for the desk.
 * A public HTTPS address can be read. Messaging and funds are separate and
 * are not performed here. No network name is invented from a failed call.
 */

export type PublicEndpoint =
  | { kind: "https-read"; url: string }
  | { kind: "rejected"; message: string };

export function classifyPublicEndpoint(input: string): PublicEndpoint {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { kind: "rejected", message: "Enter a public https address." };
  }
  if (url.protocol !== "https:") {
    return {
      kind: "rejected",
      message: "Public reads use https only. No funds move from this desk.",
    };
  }
  if (url.username || url.password) {
    return { kind: "rejected", message: "Addresses with secrets are blocked." };
  }
  return { kind: "https-read", url: url.toString() };
}

