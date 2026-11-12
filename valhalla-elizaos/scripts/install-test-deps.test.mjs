import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  main,
  REQUIRED_TEST_DEPENDENCIES,
  validateTestDependencies,
} from "./install-test-deps.js";

const VALIDATOR_PATH = fileURLToPath(
  new URL("./install-test-deps.js", import.meta.url),
);

function createProject(
  t,
  { declared = REQUIRED_TEST_DEPENDENCIES, restricted } = {},
) {
  const projectDir = mkdtempSync(join(tmpdir(), "elizaos-test-deps-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));

  const scriptsDir = join(projectDir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  copyFileSync(VALIDATOR_PATH, join(scriptsDir, "install-test-deps.js"));

  const devDependencies = Object.fromEntries(
    declared.map((name) => [name, "1.0.0"]),
  );
  writeFileSync(
    join(projectDir, "package.json"),
    `${JSON.stringify({ devDependencies }, null, 2)}\n`,
  );

  for (const name of declared) {
    const packageDir = join(projectDir, "node_modules", name);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      `${JSON.stringify(
        {
          name,
          version: "1.0.0",
          main: "index.js",
          ...(name === restricted ? { exports: { ".": "./index.js" } } : {}),
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(packageDir, "index.js"), "module.exports = {};\n");
  }

  return projectDir;
}

function runValidator(projectDir, cwd = tmpdir()) {
  return spawnSync(
    process.execPath,
    [join(projectDir, "scripts", "install-test-deps.js")],
    { cwd, encoding: "utf8" },
  );
}

test("accepts declared dependencies that resolve from the project", (t) => {
  const projectDir = createProject(t);
  const result = validateTestDependencies({
    projectDir,
    resolvePackage: (name) => `/resolved/${name}`,
  });

  assert.deepEqual(result, { ok: true, undeclared: [], unresolved: [] });
});

test("reports dependencies missing from both dependency groups", (t) => {
  const projectDir = createProject(t, { declared: [] });
  const result = validateTestDependencies({
    projectDir,
    resolvePackage: (name) => `/resolved/${name}`,
  });

  assert.deepEqual(result.undeclared, REQUIRED_TEST_DEPENDENCIES);
  assert.deepEqual(result.unresolved, []);
});

test("reports declared dependencies that cannot be resolved", (t) => {
  const projectDir = createProject(t);
  const unresolvedName = REQUIRED_TEST_DEPENDENCIES[0];
  const result = validateTestDependencies({
    projectDir,
    resolvePackage(name) {
      if (name === unresolvedName) throw new Error("module not found");
      return `/resolved/${name}`;
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.unresolved, [unresolvedName]);
});

test("rejects a malformed package manifest", (t) => {
  const projectDir = createProject(t);
  writeFileSync(join(projectDir, "package.json"), "{invalid json");

  assert.throws(
    () => validateTestDependencies({ projectDir }),
    /Cannot read project package\.json/,
  );
});

test("falls back to the package entry point when package exports hide package.json", (t) => {
  const projectDir = createProject(t, {
    restricted: REQUIRED_TEST_DEPENDENCIES[0],
  });
  const result = runValidator(projectDir);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Test dependencies are declared and resolvable/);
});

test("CLI resolves its project relative to the script and returns failure status", (t) => {
  const projectDir = createProject(t, { declared: [] });
  const result = runValidator(projectDir, dirname(projectDir));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing from dependencies\/devDependencies/);
  for (const name of REQUIRED_TEST_DEPENDENCIES) {
    assert.ok(result.stderr.includes(name));
  }
});

test("validator does not mutate manifests or lockfiles", (t) => {
  const projectDir = createProject(t);
  const packagePath = join(projectDir, "package.json");
  const lockPaths = ["bun.lock", "bun.lockb", "package-lock.json"].map((name) =>
    join(projectDir, name),
  );
  for (const lockPath of lockPaths) {
    writeFileSync(lockPath, "fixture lockfile\n");
  }
  const before = new Map(
    [packagePath, ...lockPaths].map((path) => [path, readFileSync(path)]),
  );
  const output = { write() {} };

  assert.equal(main({ projectDir, stdout: output, stderr: output }), 0);

  for (const [path, contents] of before) {
    assert.deepEqual(readFileSync(path), contents);
  }
  assert.equal(existsSync(join(projectDir, "package-lock.json")), true);
});
