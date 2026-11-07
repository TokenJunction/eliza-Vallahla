import type { AuthCheck } from "./ValhallaWorkspace.tsx";

export const DEMO_BANNER =
  "SYNTHETIC DEMO FIXTURE. This is not a signed-in session and it is not for production.";

export function demoSessionFixture(): Promise<AuthCheck> {
  return Promise.resolve({
    state: "verified",
    source: "synthetic demo fixture",
    displayName: "",
  });
}
