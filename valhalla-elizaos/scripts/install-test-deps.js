#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'node:child_process';

const testDependencies = {
  '@cypress/react': '^9.0.1',
  '@cypress/vite-dev-server': '^6.0.3',
  '@testing-library/cypress': '^10.0.3',
  cypress: '^14.4.1',
};

function isInstalled(packageName) {
  try {
    const packageJsonPath = join(process.cwd(), 'package.json');
    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      return packageName in deps;
    }
  } catch (error) {
    // Silent fail, will install if error
  }
  return false;
}

function installTestDependencies() {
  const missingDeps = Object.entries(testDependencies)
    .filter(([name]) => !isInstalled(name))
    .map(([name, version]) => `${name}@${version}`);

  if (missingDeps.length === 0) {
    console.log('✓ Test dependencies already installed');
    return;
  }

  console.log('Installing test dependencies...');
  try {
    const proc = spawnSync('bun', ['add', '-d', ...missingDeps], {
      stdio: 'inherit',
      cwd: process.cwd(),
    });

    if (proc.error) {
      throw proc.error;
    }
    if (proc.status !== 0) {
      throw new Error(
        proc.signal
          ? `bun add terminated by signal ${proc.signal}`
          : `bun add command failed with exit code ${proc.status}`,
      );
    }
    console.log('✓ Test dependencies installed successfully');
  } catch (error) {
    console.error('Failed to install test dependencies:', error.message);
    process.exit(1);
  }
}

installTestDependencies();
