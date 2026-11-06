import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../..", import.meta.url);

function walk(relative, files) {
  const dir = new URL(relative, root);
  for (const name of readdirSync(dir)) {
    const path = join(dir.pathname, name);
    if (statSync(path).isDirectory()) walk(`${relative}${name}/`, files);
    else files.push(path);
  }
}

function files() {
  const found = [];
  walk("site/src/lib/", found);
  walk("local-edge/", found);
  for (const relative of [
    "backend/wsRelayServer.js",
    "backend/relayGrant.js",
    "backend/relayState.js",
    "backend/RELAY_HOOKS.md",
    "backend/test/ws-relay.test.js",
    "backend/test/public-surface.test.js",
  ]) {
    found.push(new URL(relative, root).pathname);
  }
  return found;
}

test("public identity and relay files do not carry a literal admin mailbox or a private key", () => {
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const assigned = /ROOT_ADMIN_EMAIL['"]?\s*[:=]\s*['"][^'"]+['"]/;
  for (const path of files()) {
    const text = readFileSync(path, "utf8");
    const privateMarker = ["BEGIN", "PRIVATE KEY"].join(" ");
    const unsafeMarker = ["_UNSAFE", "export"].join("_");
    const modalMarker = ["@web3auth", "no-modal"].join("/");
    assert.equal(email.test(text), false, path);
    assert.equal(assigned.test(text), false, path);
    assert.equal(text.includes(privateMarker), false, path);
    assert.equal(text.includes(unsafeMarker), false, path);
    assert.equal(text.includes(modalMarker), false, path);
    assert.equal(text.includes(["free", "tier"].join(" ")), false, path);
    assert.equal(text.toLowerCase().includes(["15", "seconds"].join(" ")), false, path);
  }
});

test("the relay does not broadcast and the edge client does not spawn a shell", () => {
  const relay = readFileSync(new URL("../wsRelayServer.js", import.meta.url), "utf8");
  const edgeRoot = new URL("../../local-edge/", import.meta.url);
  assert.equal(relay.includes(".broadcast"), false);
  assert.equal(relay.includes("io.emit("), false);
  for (const name of readdirSync(edgeRoot)) {
    const path = join(edgeRoot.pathname, name);
    if (!statSync(path).isFile()) continue;
    const text = readFileSync(path, "utf8");
    assert.equal(text.includes("child_process"), false, name);
    assert.equal(text.includes("execFile"), false, name);
  }
});
