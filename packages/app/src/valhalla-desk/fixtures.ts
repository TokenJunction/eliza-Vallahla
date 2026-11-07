import type { PublicSettings } from "./model.ts";

/** Public sample only. No passwords, tokens, or API keys. */
export const PUBLIC_FIXTURE: PublicSettings = {
  brandName: "Northwind Desk",
  adminEmail: "admin@example.invalid",
  ownerOverrideEmail: "",
  deploymentTarget: "https://northwind.example.invalid",
  supabaseHost: "db.northwind.example.invalid",
  supabasePort: "6543",
  supabaseDatabase: "desk",
  supabaseUser: "desk_admin",
  upstashRestUrl: "https://cache.northwind.example.invalid",
};
