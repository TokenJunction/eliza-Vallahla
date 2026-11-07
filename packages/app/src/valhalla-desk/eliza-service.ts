/**
 * ElizaOS health is not called from the browser.
 * A user-typed host would be a server-side request forgery. The server must
 * own the service registry. Localhost is not a desktop health target.
 */

export type ElizaHealth = {
  state: "not-configured";
  detail: string;
};

export function elizaServiceStatus(): ElizaHealth {
  return {
    state: "not-configured",
    detail:
      "ElizaOS health is not implemented in this desk. No browser request is sent. Not connected.",
  };
}
