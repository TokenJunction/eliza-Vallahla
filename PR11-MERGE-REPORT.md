# PR 11 three-way merge report

Head: `7dff67a75b36f57be70cc893301a024a0a4830cb`

Develop revision: `81f3956c3addbc60aa3cd143003db9ed7a719913`

Status: unresolved; no side was discarded.

Conflicting files:
```text
plugins/plugin-valhalla-copybot/extension/connect-page.js
plugins/plugin-valhalla-copybot/scripts/check-extension.mjs
```

Actual merge output:
```text
Auto-merging plugins/plugin-valhalla-copybot/extension/connect-core.js
Auto-merging plugins/plugin-valhalla-copybot/extension/connect-page.js
CONFLICT (content): Merge conflict in plugins/plugin-valhalla-copybot/extension/connect-page.js
Auto-merging plugins/plugin-valhalla-copybot/extension/popup.js
Auto-merging plugins/plugin-valhalla-copybot/public/controls.js
Auto-merging plugins/plugin-valhalla-copybot/public/index.html
Auto-merging plugins/plugin-valhalla-copybot/scripts/check-extension.mjs
CONFLICT (content): Merge conflict in plugins/plugin-valhalla-copybot/scripts/check-extension.mjs
Automatic merge failed; fix conflicts and then commit the result.

```

Actual conflict diff (first 18000 characters):
```diff
diff --cc plugins/plugin-valhalla-copybot/extension/connect-page.js
index ba91c9579a,7f49ed0823..0000000000
--- a/plugins/plugin-valhalla-copybot/extension/connect-page.js
+++ b/plugins/plugin-valhalla-copybot/extension/connect-page.js
@@@ -1,21 -1,9 +1,28 @@@
  (() => {
    const params = new URLSearchParams(location.search);
++<<<<<<< HEAD
 +  const requested = params.get("wallet");
 +  const which = ["solflare", "backpack", "other"].includes(requested)
 +    ? requested
 +    : "phantom";
 +  const label = {
 +    solflare: "Solflare",
 +    backpack: "Backpack",
 +    other: "your wallet",
 +    phantom: "Phantom",
 +  }[which];
 +  const downloadHref =
 +    which === "solflare"
 +      ? "https://solflare.com/download"
 +      : which === "backpack"
 +        ? "https://backpack.app/download"
 +        : "https://phantom.app/download";
++=======
+   const which = params.get("wallet") === "solflare" ? "solflare" : "phantom";
+   const label = which === "solflare" ? "Solflare" : "Phantom";
+   const downloadHref =
+     which === "solflare" ? "https://solflare.com/download" : "https://phantom.app/download";
++>>>>>>> 81f3956c3addbc60aa3cd143003db9ed7a719913
    const status = document.getElementById("status");
    const go = document.getElementById("go");
    const missing = document.getElementById("missing");
diff --cc plugins/plugin-valhalla-copybot/scripts/check-extension.mjs
index e2d0d6cca5,cddab9ec97..0000000000
--- a/plugins/plugin-valhalla-copybot/scripts/check-extension.mjs
+++ b/plugins/plugin-valhalla-copybot/scripts/check-extension.mjs
@@@ -21,27 -25,32 +25,50 @@@ execFileSync
      packed,
      "manifest.json",
      "popup.html",
++<<<<<<< HEAD
 +    "valhalla-command.css",
      "popup.js",
      "background.js",
 +    "connect.html",
 +    "connect-page.js",
 +    "connect-core.js",
 +    "trust.js",
 +    "vendor",
      "house-ads.json",
 +    "monetization.json",
 +    "offers.json",
++=======
++    "popup.js",
++    "background.js",
++    "house-ads.json",
++>>>>>>> 81f3956c3addbc60aa3cd143003db9ed7a719913
      "icons",
      "house",
    ],
    { cwd: extensionDir }
  );
  const listing = execFileSync("unzip", ["-Z1", packed], { encoding: "utf8" });
- const names = listing.split("\n").map((line) => line.trim()).filter(Boolean);
+ const names = listing
+   .split("\n")
+   .map((line) => line.trim())
+   .filter(Boolean);
  if (!names.includes("manifest.json")) fail("manifest.json is not at the zip root");
  if (names.some((name) => name.startsWith("extension/"))) fail("zip nests the extension folder");
++<<<<<<< HEAD
 +for (const required of ["popup.html", "popup.js", "background.js", "connect.html", "connect-page.js", "connect-core.js", "house-ads.json", "house/go-pro.png", "icons/icon-16.png", "icons/icon-32.png", "icons/icon-48.png", "icons/icon-128.png"]) {
++=======
+ for (const required of [
+   "popup.html",
+   "popup.js",
+   "background.js",
+   "house-ads.json",
+   "house/go-pro.png",
+   "icons/icon-16.png",
+   "icons/icon-32.png",
+   "icons/icon-48.png",
+   "icons/icon-128.png",
+ ]) {
++>>>>>>> 81f3956c3addbc60aa3cd143003db9ed7a719913
    if (!names.includes(required)) fail(`zip is missing ${required}`);
  }
  execFileSync("unzip", ["-q", packed, "-d", unpacked]);
@@@ -49,17 -58,14 +76,24 @@@
  const manifest = JSON.parse(await readFile(path.join(unpacked, "manifest.json"), "utf8"));
  if (manifest.manifest_version !== 3) fail("manifest is not MV3");
  const permissions = manifest.permissions || [];
- if (permissions.length !== 1 || permissions[0] !== "storage") fail("permissions must be storage only");
+ if (permissions.length !== 1 || permissions[0] !== "storage")
+   fail("permissions must be storage only");
  if (manifest.host_permissions?.length) fail("required host_permissions are set");
 -if (manifest.content_scripts?.length) fail("content scripts are set");
 +const scripts = manifest.content_scripts || [];
 +if (scripts.length) fail("content scripts are not needed; wallet handoff uses the extension service worker");
  const optional = manifest.optional_host_permissions || [];
++<<<<<<< HEAD
 +const allowedOptional = new Set([
 +  "http://127.0.0.1/*",
 +  "http://localhost/*",
 +  "https://api.mainnet-beta.solana.com/*",
 +]);
 +if (optional.some((host) => !allowedOptional.has(host))) fail("optional host is not the local desk or the public RPC");
++=======
+ const allowedOptional = new Set(["http://127.0.0.1/*", "http://localhost/*"]);
+ if (optional.some((host) => !allowedOptional.has(host)))
+   fail("optional host is not the local desk");
++>>>>>>> 81f3956c3addbc60aa3cd143003db9ed7a719913
  const broad = /<all_urls>|\/\/\*\/\*|https:\/\/\*|http:\/\/\*/;
  if (broad.test(JSON.stringify(manifest))) fail("a broad host pattern is set");
  if (manifest.optional_host_permissions && !optional.length) fail("optional host list is empty");

```
