import assert from "node:assert/strict";
import test from "node:test";
import { createTestClient, mapPaidCustomer, publicPlan, STRIPE_PIN } from "../stripe-billing.js";

test("stripe stays in test mode and does not map an email", () => {
  assert.equal(STRIPE_PIN, "23.1.0");
  assert.equal(createTestClient("sk_live_secret").reason, "testmode-only");
  const made = createTestClient("sk_test_placeholder");
  assert.equal(made.ok, true);
  assert.equal(typeof made.client.checkout.sessions.create, "function");
  assert.equal(publicPlan({}).checkout, false);
  assert.equal(publicPlan({
    STRIPE_SECRET_KEY: "sk_test_placeholder",
    STRIPE_PRICE_ID: "price_test",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
  }).priceUsd, 5);
  const links = new Map([["cus_test", "subject-1"]]);
  const mapped = mapPaidCustomer({
    data: { object: { customer: "cus_test", status: "paid", email: "person@example.invalid" } },
  }, links);
  assert.equal(mapped.subject, "subject-1");
  assert.equal(mapped.entitlement, true);
  assert.equal(JSON.stringify(mapped).includes("example.invalid"), false);
  assert.equal(mapPaidCustomer({ data: { object: { customer: "cus_other", email: "a@b.c" } } }, links).reason, "unmapped");
});
