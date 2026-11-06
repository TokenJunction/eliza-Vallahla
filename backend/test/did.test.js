import assert from "node:assert/strict";
import test from "node:test";
import { generateEd25519 } from "../ed25519.js";
import {
  didDocument,
  didKeyFromRaw,
  emailBridge,
  issueDidChallenge,
  parseDidKey,
  signDidProof,
  verifyDidProof,
} from "../did.js";

function rawPublic(key) {
  const der = key.export({ type: "spki", format: "der" });
  return der.subarray(der.length - 32);
}

test("email identity does not invent a did or a noncustodial wallet", () => {
  const bridge = emailBridge();
  assert.equal(bridge.authMode, "email");
  assert.equal(bridge.identityProvider, "email");
  assert.equal(bridge.did, null);
  assert.equal(bridge.custodial, false);
  assert.equal(bridge.decentralizedIdentity, "unavailable");
  assert.equal(Object.hasOwn(bridge, "noncustodial"), false);
  assert.equal(Object.hasOwn(bridge, "mpc"), false);
});

test("a did:key proof checks the document and rejects a private uri", () => {
  const pair = generateEd25519();
  const did = didKeyFromRaw(rawPublic(pair.publicKey));
  assert.equal(parseDidKey(`${did}suffix`), null);
  assert.equal(parseDidKey("did:web:valhalla-app.xyz"), null);
  assert.equal(parseDidKey("did:key:not-a-key"), null);
  const document = didDocument(did);
  assert.equal(document.authentication[0], document.verificationMethod[0].id);
  assert.equal(document.verificationMethod[0].publicKeyMultibase, did.slice("did:key:".length));
  const challenge = issueDidChallenge({ domain: "valhalla-app.xyz", uri: "https://valhalla-app.xyz/did", now: 5_000 });
  assert.equal(challenge.ok, true);
  assert.equal(issueDidChallenge({ domain: "valhalla-app.xyz", uri: "https://127.0.0.1/did" }).ok, false);
  assert.equal(issueDidChallenge({ domain: "localhost", uri: "https://localhost/did" }).ok, false);
  const proof = signDidProof(pair.privateKey, challenge, did);
  const verified = verifyDidProof({ challenge, did, document, proof, now: 5_000, balance: 50 });
  assert.equal(verified.ok, true);
  assert.equal(verified.did, null);
  assert.equal(verified.verifiedDid, did);
  assert.equal(verified.linked, false);
  assert.equal(verified.decentralizedIdentity, "unavailable");
  assert.equal(Object.hasOwn(verified, "balance"), false);
  assert.equal(Object.hasOwn(verified, "noncustodial"), false);
  const wrong = { ...document, verificationMethod: [{ ...document.verificationMethod[0], id: `${did}#other` }] };
  assert.equal(verifyDidProof({ challenge, did, document: wrong, proof, now: 5_000 }).reason, "document");
  const remote = { ...document, service: [{ serviceEndpoint: "https://127.0.0.1/keys" }] };
  assert.equal(verifyDidProof({ challenge, did, document: remote, proof, now: 5_000 }).reason, "document");
  assert.equal(verifyDidProof({ challenge, did, document, proof: proof.slice(0, 8), now: 5_000 }).reason, "proof");
});
