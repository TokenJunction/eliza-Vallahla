#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const REQUIRED_TEST_DEPENDENCIES = Object.freeze([
  '@cypress/react',
  '@cypress/vite-dev-server',
  '@testing-library/cypress',
  'cypress',
]);

function defaultResolvePackage(requireFromProject, name) {
  // Some packages expose package.json; others restrict it with exports.
  try {
    return requireFromProject.resolve(`${name}/package.json`);
  } catch {
    return requireFromProject.resolve(name);
  }
}

export function validateTestDependencies({
  projectDir = PROJECT_DIR,
  resolvePackage,
} = {}) {
  const packagePath = join(projectDir, 'package.json');
  let manifest;

  try {
    manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Cannot read project package.json at ${packagePath}: ${error.message}`,
    );
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`Invalid project package.json at ${packagePath}.`);
  }

  const requireFromProject = createRequire(pathToFileURL(packagePath));
  const resolver =
    resolvePackage ??
    ((name) => defaultResolvePackage(requireFromProject, name));
  const dependencyGroups = [manifest.dependencies, manifest.devDependencies];
  const undeclared = [];
  const unresolved = [];

  for (const name of REQUIRED_TEST_DEPENDENCIES) {
    const declared = dependencyGroups.some(
      (group) =>
        group &&
        typeof group === 'object' &&
        !Array.isArray(group) &&
        Object.hasOwn(group, name) &&
        typeof group[name] === 'string' &&
        group[name].trim() !== '',
    );

    if (!declared) {
      undeclared.push(name);
      continue;
    }

    try {
      if (!resolver(name)) {
        throw new Error('Package resolution returned no result.');
      }
    } catch {
      unresolved.push(name);
    }
  }

  return {
    ok: undeclared.length === 0 && unresolved.length === 0,
    undeclared,
    unresolved,
  };
}

export function main({
  projectDir = PROJECT_DIR,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let result;

  try {
    result = validateTestDependencies({ projectDir });
  } catch (error) {
    stderr.write(`Test dependency validation failed:\n${error.message}\n`);
    return 1;
  }

  if (result.ok) {
    stdout.write(
      'Test dependencies are declared and resolvable.\n' +
        'No packages were installed and no dependency files were changed.\n',
    );
    return 0;
  }

  stderr.write('Test dependency validation failed.\n');

  if (result.undeclared.length > 0) {
    stderr.write(
      '\nMissing from dependencies/devDependencies:\n' +
        result.undeclared.map((name) => `  - ${name}`).join('\n') +
        '\n\nAdd reviewed compatible versions to devDependencies and ' +
        'regenerate the applicable Bun lockfile outside CI using the ' +
        'project-pinned Bun version. Commit both changes together.\n',
    );
  }

  if (result.unresolved.length > 0) {
    stderr.write(
      '\nDeclared but not resolvable from this project:\n' +
        result.unresolved.map((name) => `  - ${name}`).join('\n') +
        '\n\nRun bun install --frozen-lockfile with development dependencies ' +
        'enabled from the appropriate project/workspace root, then retry.\n',
    );
  }

  stderr.write(
    '\nThis validator does not install packages or modify package.json ' +
      'or lockfiles.\n',
  );
  return 1;
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  process.exitCode = main();
}
