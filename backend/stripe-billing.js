import Stripe from "stripe";

export const STRIPE_PIN = "23.1.0";

export function createTestClient(secret) {
  const key = String(secret || "");
  if (!key.startsWith("sk_test_")) return { ok: false, reason: "testmode-only", client: null };
  return { ok: true, client: new Stripe(key, { telemetry: false }) };
}

export function publicPlan(env = {}) {
  const testKey = String(env.STRIPE_SECRET_KEY || "").startsWith("sk_test_");
  const configured = testKey && Boolean(env.STRIPE_PRICE_ID) && Boolean(env.STRIPE_WEBHOOK_SECRET);
  return {
    id: "valhallaos-personal",
    priceUsd: 5,
    interval: "month",
    checkout: configured,
    charge: false,
  };
}

export function mapPaidCustomer(event, links) {
  const object = event && event.data && event.data.object;
  const customer = object && object.customer;
  const subject = customer ? links.get(String(customer)) : null;
  if (!subject) return { ok: false, reason: "unmapped", entitlement: false };
  return { ok: true, subject, customer: String(customer), entitlement: object.status === "paid", email: undefined };
}
