import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { acceptRelease } from './hive-updater.mjs';

function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function inside(base, name) {
  const target = path.resolve(base, ...name.split('/'));
  const root = path.resolve(base);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`Unsafe release path: ${name}`);
  return target;
}

export function safeReleasePath(name) {
  if (typeof name !== 'string' || !name.trim() || name.includes('\0')) throw new Error('Release file name is invalid.');
  const value = name.replace(/\\/g, '/');
      if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw new Error(`Unsafe release path: ${name}`);
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error(`Unsafe release path: ${name}`);
  if (parts[0] === '.hive') throw new Error(`Unsafe release path: ${name}`);
  return parts.join('/');
}

export async function loadNodeState(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function saveNodeState(file, node) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(node, null, 2) + '\n', 'utf8');
  await rename(temporary, file);
}

async function rollback(items) {
  for (const item of [...items].reverse()) {
    try {
      if (item.existed) await copyFile(item.backup, item.target);
      else await rm(item.target, { force: true });
    } catch {
      // The caller reports the original failure. A later update or manual repair
      // can still recover from the backup directory while it is retained.
    }
  }
}

export async function applyRelease(options) {
  const {
    release,
    publicKey,
    node,
    root,
    healthCheck = async () => {},
    launch = async () => {},
    now = Date.now()
  } = options || {};

  if (!node || typeof node !== 'object') throw new Error('Node state is required.');
  if (!root) throw new Error('Install root is required.');

  const decision = acceptRelease(node, release, publicKey, now);
  if (!decision.applied) return { ...decision, installed: false };
  if (!Array.isArray(release.files) || release.files.length === 0) {
    return { applied: false, autoAccept: false, installed: false, reason: 'release has no files', node };
  }

  const installRoot = path.resolve(root);
  const operation = `${now}-${process.pid}`;
  const staging = path.join(installRoot, '.hive', 'staging', operation);
  const backupRoot = path.join(installRoot, '.hive', 'backup', operation);
  const staged = [];
  const installed = [];

  try {
    for (const file of release.files) {
      if (!file || typeof file.text !== 'string') throw new Error('Every release file must contain text.');
      const name = safeReleasePath(file.name);
      const source = inside(staging, name);
      await mkdir(path.dirname(source), { recursive: true });
      await writeFile(source, file.text, 'utf8');
      staged.push({ name, source, target: inside(installRoot, name) });
    }

    for (const item of staged) {
      const existed = await exists(item.target);
      const backup = inside(backupRoot, item.name);
      if (existed) {
        await mkdir(path.dirname(backup), { recursive: true });
        await copyFile(item.target, backup);
      }
      await mkdir(path.dirname(item.target), { recursive: true });
      await copyFile(item.source, item.target);
      installed.push({ ...item, backup, existed });
    }

    await healthCheck(decision.node);
    await launch(decision.node);
    return { ...decision, installed: true };
  } catch (error) {
    await rollback(installed);
    return {
      applied: false,
      autoAccept: false,
      installed: false,
      reason: `install, health check, or launch failed: ${error.message}`,
      node
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(backupRoot, { recursive: true, force: true });
  }
}

function parseEventBlock(block) {
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  try {
    return JSON.parse(data.join('\n'));
  } catch {
    return null;
  }
}

export class HiveNodeUpdater {
  constructor(options) {
    const optionsValue = options || {};
    this.relayUrl = text(optionsValue.relayUrl, 'relayUrl').replace(/\/+$/, '');
    this.root = path.resolve(text(optionsValue.root, 'root'));
    this.publicKey = optionsValue.publicKey;
    this.token = optionsValue.token || '';
    this.node = optionsValue.node;
    this.statePath = optionsValue.statePath || path.join(this.root, '.hive', 'node.json');
    this.healthCheck = optionsValue.healthCheck || (async () => {});
    this.launch = optionsValue.launch || (async () => {});
    this.fetchImpl = optionsValue.fetchImpl || fetch;
    this.now = optionsValue.now || Date.now;
    this.log = optionsValue.log || (() => {});
    this.reconnectMs = optionsValue.reconnectMs || 5000;
    this.pollMs = optionsValue.pollMs || 30000;
    this.stopped = true;
    this.busy = null;
    this.queued = null;
    this.timer = null;
    this.reconnectTimer = null;
    this.stream = null;
  }

  async load() {
    const saved = await loadNodeState(this.statePath);
    if (saved) this.node = { ...this.node, ...saved };
    if (!this.node || !this.node.id || !this.node.channel || !this.node.role) {
      throw new Error('Node id, channel, and role are required.');
    }
    this.node = {
      version: '0.0.0',
      issuedAt: 0,
      knownGood: [],
      ...this.node
    };
    return this.node;
  }

  async start() {
    await this.load();
    this.stopped = false;
    await this.checkLatest();
    this.timer = setInterval(() => {
      this.checkLatest().catch(error => this.log(`latest check failed: ${error.message}`));
    }, this.pollMs);
    if (this.timer.unref) this.timer.unref();
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.timer = null;
    this.reconnectTimer = null;
    if (this.stream) this.stream.destroy();
    this.stream = null;
  }

  async checkLatest() {
    const url = new URL('/latest', this.relayUrl);
    url.searchParams.set('channel', this.node.channel);
    const response = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
    if (response.status === 204 || response.status === 404) return null;
    if (!response.ok) throw new Error(`relay returned HTTP ${response.status}`);
    const release = await response.json();
    await this.handle(release);
    return release;
  }

  handle(release) {
    if (this.busy) {
      this.queued = release;
      return this.busy;
    }
    this.busy = this.process(release)
      .catch(error => this.log(`update failed: ${error.message}`))
      .finally(() => {
        this.busy = null;
        const next = this.queued;
        this.queued = null;
        if (next) this.handle(next);
      });
    return this.busy;
  }

  async process(release) {
    const result = await applyRelease({
      release,
      publicKey: this.publicKey,
      node: this.node,
      root: this.root,
      healthCheck: this.healthCheck,
      launch: this.launch,
      now: this.now()
    });

    if (result.applied) {
      this.node = result.node;
      await saveNodeState(this.statePath, this.node);
      this.log(`installed ${this.node.version} on ${this.node.channel}; health and launch passed.`);
      await this.report(result);
      return result;
    }

    if (release && release.channel === this.node.channel && release.version === this.node.version) {
      this.log(`release ${this.node.version} is already current; ignored.`);
      return { ...result, ignored: true };
    }

    if (!/install, health check, or launch failed/.test(result.reason || '')) {
      this.log(`release rejected: ${result.reason}`);
      return { ...result, ignored: true };
    }

    this.log(`release failed: ${result.reason}`);
    await this.report(result);
    return result;
  }

  async report(result) {
    try {
      const response = await this.fetchImpl(new URL('/report', this.relayUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
        },
        body: JSON.stringify({
          nodeId: this.node.id,
          channel: this.node.channel,
          role: this.node.role,
          version: this.node.version,
          healthy: result.applied === true && result.installed === true,
          installed: result.installed === true,
          checkedAt: this.now(),
          reason: result.reason || ''
        })
      });
      if (!response.ok) this.log(`relay report returned HTTP ${response.status}`);
    } catch (error) {
      this.log(`relay report failed: ${error.message}`);
    }
  }

  connect() {
    if (this.stopped) return;
    const url = new URL('/events', this.relayUrl);
    url.searchParams.set('channel', this.node.channel);
    const client = url.protocol === 'https:' ? https : http;
    const request = client.get(url, { headers: { accept: 'text/event-stream' } }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        this.scheduleReconnect();
        return;
      }
      this.log(`listening for ${this.node.channel} releases.`);
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffer += chunk;
        let boundary = buffer.search(/\r?\n\r?\n/);
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + (buffer[boundary] === '\r' ? 4 : 2));
          const release = parseEventBlock(block);
          if (release) this.handle(release);
          boundary = buffer.search(/\r?\n\r?\n/);
        }
      });
      response.on('end', () => this.scheduleReconnect());
      response.on('error', () => this.scheduleReconnect());
    });
    request.on('error', () => this.scheduleReconnect());
    request.setTimeout(0);
    this.stream = request;
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectMs);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }
}

export function commandRunner(command, options = {}) {
  const value = text(command, 'command');
  return () => new Promise((resolve, reject) => {
    const child = spawn(value, {
      shell: true,
      detached: options.detached === true,
      stdio: options.detached ? 'ignore' : 'inherit'
    });
    if (options.detached) {
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
      return;
    }
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          child.kill();
          reject(new Error(`command timed out: ${value}`));
        }, options.timeoutMs)
      : null;
    child.once('error', reject);
    child.once('exit', code => {
      if (timeout) clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`command exited ${code}: ${value}`));
    });
  });
}

function env(name, fallback = '') {
  return process.env[name] || fallback;
}

async function main() {
  const relayUrl = env('HIVE_RELAY_URL');
  const publicKeyFile = env('HIVE_RELEASE_PUBLIC_KEY_FILE');
  const root = env('HIVE_NODE_ROOT');
  const health = env('HIVE_HEALTHCHECK');
  const launch = env('HIVE_LAUNCH');
  if (!relayUrl || !publicKeyFile || !root || !health || !launch) {
    throw new Error('HIVE_RELAY_URL, HIVE_RELEASE_PUBLIC_KEY_FILE, HIVE_NODE_ROOT, HIVE_HEALTHCHECK, and HIVE_LAUNCH are required.');
  }
  const channel = env('HIVE_NODE_CHANNEL', 'akershus');
  const role = env('HIVE_NODE_ROLE', channel === 'zeus' ? 'overseer' : 'customer');
  const statePath = env('HIVE_NODE_STATE', path.join(root, '.hive', 'node.json'));
  const node = {
    id: env('HIVE_NODE_ID', `${channel}-node`),
    channel,
    role,
    version: env('HIVE_NODE_VERSION', '0.0.0'),
    issuedAt: Number(env('HIVE_NODE_ISSUED_AT', '0')) || 0,
    knownGood: []
  };
  const updater = new HiveNodeUpdater({
    relayUrl,
    root,
    publicKey: await readFile(publicKeyFile, 'utf8'),
    token: env('HIVE_RELAY_TOKEN'),
    node,
    statePath,
    healthCheck: commandRunner(health, { timeoutMs: 120000 }),
    launch: commandRunner(launch, { detached: true }),
    log: message => console.log(`[hive-node] ${message}`)
  });
  await updater.start();
  const stop = () => {
    updater.stop();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.log(`[hive-node] ${node.id} on ${channel} is running.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[hive-node] ${error.message}`);
    process.exit(1);
  });
}
