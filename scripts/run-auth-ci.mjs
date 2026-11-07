import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const checks = [
  ["entry-syntax", "node --check workers/auth-entry.js"],
  ["boundary-syntax", "node --check workers/auth-boundary.js"],
  ["worker-syntax", "node --check workers/auth.js"],
  ["login-syntax", "node --check app/gate.js"],
  ["boundary-tests", "node --test workers/auth-boundary.test.mjs"],
  ["regression-tests", "node --test workers/*.test.mjs app/performance.test.cjs lib/*.test.cjs valhallaQueueEngine.test.cjs scripts/validateEnv.test.cjs"]
];
const results = [];
for (const [name, command] of checks) {
  const child = spawnSync("bash", ["-o", "pipefail", "-c", command], { encoding: "utf8", timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  const output = `${child.stdout || ""}\n${child.stderr || ""}\n${child.error?.message || ""}`;
  const lines = output.split(/\r?\n/);
  const errorLine = lines.find(line => /SyntaxError:|Error:|Cannot find|not ok|ENOENT|ERR_|AssertionError/.test(line));
  results.push({ name, command, passed: child.status === 0 && !child.error, exitCode: child.status, diagnostic: (errorLine || `Exit ${child.status}`).slice(0, 140), output: output.slice(-12000) });
  console.log(`::group::${name}`);
  console.log(output);
  console.log("::endgroup::");
}
writeFileSync("auth-ci-results.json", JSON.stringify(results, null, 2) + "\n");
process.exitCode = results.every(result => result.passed) ? 0 : 1;
