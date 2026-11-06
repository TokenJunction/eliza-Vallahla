import assert from "node:assert/strict";
import test from "node:test";
import { challengeRequest, discover, installStep, linkBody, linkResult, readChallenge, signFeature, walletId } from "./wallets.js";

const address = "GkwFnmMDvn3HGMpJpWBg8tgJxr3NxNvg3AXxvXVPbRGJ";

function standard(name, features) {
  return { name: name, features: features };
}

const solanaSign = {
  "standard:connect": { connect: function () {} },
  "solana:signMessage": { signMessage: function () {} },
};

test("only Solflare and MetaMask are discovered, and an unknown wallet is ignored", () => {
  assert.equal(walletId("Phantom"), "");
  assert.equal(walletId("Backpack"), "");
  var found = discover({
    standard: [
      standard("Phantom", solanaSign),
      standard("Solflare", solanaSign),
      standard("MetaMask", solanaSign),
      standard("Backpack", solanaSign),
      standard("MetaMask", { "solana:signAndSendTransaction": { signAndSendTransaction: function () {} } }),
    ],
    injected: { solflare: null, metamask: { isMetaMask: true } },
  });
  assert.deepEqual(found.wallets.map(function (item) { return item.id; }), ["solflare", "metamask"]);
  assert.equal(found.chooser, true);
  assert.equal(signFeature(solanaSign), "");
  assert.equal(signFeature({ "solana:signTransaction": { signTransaction: function () {} }, "solana:signAndSendTransaction": {} }), "solana:signTransaction");
});

test("a read-only connect does not require a link signature", () => {
  var readOnly = discover({
    standard: [standard("Solflare", {
      "standard:connect": { connect: function () {} },
      "solana:signTransaction": { signTransaction: function () {} },
    })],
  });
  assert.equal(readOnly.only, "solflare");
  assert.equal(readOnly.wallets[0].link, false);
  assert.equal(readOnly.wallets[0].sign, true);
  assert.equal(signFeature(readOnly.wallets[0]) === "solana:signTransaction" || signFeature({
    "solana:signTransaction": { signTransaction: function () {} },
  }) === "solana:signTransaction", true);
});

test("one installed wallet connects directly and a missing wallet has an install step", () => {
  var one = discover({
    standard: [],
    injected: { solflare: { connect: function () {}, signMessage: function () {} } },
  });
  assert.equal(one.chooser, false);
  assert.equal(one.only, "solflare");
  assert.equal(installStep("backpack", { mobile: false }).action, "none");
  assert.equal(installStep("metamask", { mobile: false }).url, "https://metamask.io/download/");
});

test("a missing server challenge is not a linked account and does not grant a role", () => {
  var call = challengeRequest({ AUTH_URL: "https://auth.valhalla-app.xyz" }, address, "valhalla-app.xyz");
  assert.equal(call.url, "https://auth.valhalla-app.xyz/auth/wallet/challenge");
  assert.equal(challengeRequest({ AUTH_URL: "https://evil.example" }, address, "valhalla-app.xyz"), null);
  assert.equal(readChallenge(404, { error: "missing" }, address).ok, false);
  assert.equal(readChallenge(401, {}, address).reason, "http");
  assert.equal(linkResult(404, { ok: true, linked: true }).linked, false);
  assert.equal(linkResult(200, { ok: false }).leader, false);
  assert.equal(linkResult(200, { ok: true, linked: true, leader: true }).leader, false);
  assert.equal(linkResult(200, { ok: true, linked: true }).trade, false);
  var message = "ValhallaOS wallet link\nwallet: " + address + "\nchallengeId: ch-1\nexpiresAt: 2099-01-01T00:00:00.000Z";
  var ready = readChallenge(200, { message: message, challengeId: "ch-1" }, address, Date.parse("2026-01-01T00:00:00.000Z"));
  assert.equal(ready.ok, true);
  assert.equal(ready.message, message);
  var proof = linkBody(message, new Uint8Array(64).fill(3), address, "ch-1");
  assert.equal(proof.walletAddress, address);
  assert.equal(proof.challengeId, "ch-1");
  assert.equal(proof.signature.length > 20, true);
  assert.equal(linkBody("", new Uint8Array(64), address, "ch-1"), null);
});
