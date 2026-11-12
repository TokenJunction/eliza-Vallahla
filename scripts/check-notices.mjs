#!/usr/bin/env node
// Copyright (c) 2026 TokenJunction LLC
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];

function read(relativePath) {
  try {
    return readFileSync(join(root, relativePath), "utf8");
  } catch {
    failures.push(`${relativePath}: missing`);
    return "";
  }
}

function requireText(relativePath, text, ...needles) {
  for (const needle of needles) {
    if (!text.includes(needle)) {
      failures.push(`${relativePath}: missing ${JSON.stringify(needle)}`);
    }
  }
}

const license = read("LICENSE");
requireText(
  "LICENSE",
  license,
  "MIT License",
  "Shaw Walters and elizaOS Contributors",
  "Copyright (c) 2026 TokenJunction LLC",
  "Permission is hereby granted",
  'THE SOFTWARE IS PROVIDED "AS IS"',
);

const notice = read("NOTICE");
requireText(
  "NOTICE",
  notice,
  "elizaOS/eliza",
  "Shaw Walters and elizaOS Contributors",
  "MIT License",
  "TokenJunction",
);

let pkg;
try {
  pkg = JSON.parse(read("package.json"));
} catch {
  failures.push("package.json: invalid JSON");
}
if (pkg) {
  if (pkg.license !== "MIT") failures.push('package.json: license must be "MIT"');
  if (pkg.private !== true) failures.push("package.json: package must remain private");
}

if (failures.length > 0) {
  process.stderr.write("Licence and notice check failed:\n");
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    "Licence and notice check passed: MIT licence and upstream elizaOS NOTICE are intact.\n",
  );
}
