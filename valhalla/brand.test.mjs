import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

var files = [
  "index.html",
  "os/index.html",
  "app/index.html",
  "site-chrome.js",
  "app/ask.js",
  "faq/index.html",
  "shop/index.html",
];

test("public pages use ValhallaOS and do not name an owner email", () => {
  files.forEach(function (file) {
    var text = readFileSync(file, "utf8");
    assert.equal(text.includes("ValhallaOS") || text.includes("Valhalla Guide"), true, file);
    assert.equal(/@gmail\.com/i.test(text), false, file);
    assert.equal(text.includes("mech logo"), false, file);
    assert.equal(text.includes("MECHA LEADER"), false, file);
    assert.equal(text.includes("COMMAND DESK"), false, file);
    assert.equal(text.includes("Valhalla™"), false, file);
    if (file !== "site-chrome.js") assert.equal(text.includes("mech.jpg"), false, file);
  });
});

test("chat uses the published chat address only", () => {
  var ask = readFileSync("app/ask.js", "utf8");
  var desk = readFileSync("app/desk-chat.js", "utf8");
  assert.equal(ask.includes("AGENT_API_URL"), false);
  assert.equal(desk.includes('cfg().CHAT_URL || cfg().AGENT_API_URL'), false);
  assert.equal(ask.includes('base.indexOf("https://")'), true);
});
