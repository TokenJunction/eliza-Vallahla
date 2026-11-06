'use strict';

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const { ladderFromEnv } = require('./lib/model-ladder');

const BACKEND_DIR = path.join(__dirname, 'valhalla-elizaos');
const BUN_VERSION = '1.4.4';
const UNSAFE_SWITCHES = [
  'VALHALLA_TRADING_ENABLED',
  'VALHALLA_SOCIAL_ENABLED',
  'VALHALLA_KEY_STORAGE_ENABLED',
  'ZEUS_IDLE_ENABLED',
  'ENABLE_LIVE_EXECUTION',
  'TRADING_ENABLED',
  'SOCIAL_AUTOPOST_ENABLED',
];

function hasBinary(command, args = ['--version']) {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    console.error(`[native engine] Node >= 22 required, found ${process.versions.node}`);
    process.exit(1);
  }

  const python = ['python3', 'python'].find((name) => hasBinary(name));
  console.log(`[native engine] Node ${process.versions.node}; Python: ${python || 'not found'}`);

  // Safety switches are forced off for the child regardless of the host environment.
  const env = { ...process.env };
  for (const name of UNSAFE_SWITCHES) env[name] = 'false';
  env.VALHALLA_EXECUTION_MODE = 'paper';
  env.SERVER_PORT = env.SERVER_PORT || env.PORT || '10000';
  env.VALHALLA_MODEL_LADDER = ladderFromEnv(env).join(',');
  console.log(`[native engine] Model ladder: ${env.VALHALLA_MODEL_LADDER}`);

  const child = spawn('npx', ['--yes', `bun@${BUN_VERSION}`, 'run', 'start'], {
    cwd: BACKEND_DIR,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  const forward = (signal) => () => child.kill(signal);
  process.on('SIGTERM', forward('SIGTERM'));
  process.on('SIGINT', forward('SIGINT'));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  child.on('error', (error) => {
    console.error(`[native engine] Failed to start backend: ${error.message}`);
    process.exit(1);
  });
}

main();
