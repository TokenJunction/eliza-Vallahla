import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { verifyRelease } from './hive-updater.mjs';

const MAX_BODY = 2 * 1024 * 1024;
const CHANNELS = new Set(['akershus', 'zeus']);

function json(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text)
  });
  response.end(text);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('JSON object required');
        resolve(body);
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function channelOf(value) {
  if (typeof value !== 'string' || !CHANNELS.has(value)) return null;
  return value;
}

function event(release) {
  return `event: release\ndata: ${JSON.stringify(release)}\n\n`;
}

export function createWrenRelay(options = {}) {
  const publicKey = options.publicKey;
  const token = typeof options.token === 'string' ? options.token : '';
  const now = options.now || Date.now;
  const latest = new Map();
  const nodes = new Map();
  const clients = new Set();

  if (!publicKey) throw new Error('A release public key is required.');

  const authorized = request => {
    if (!token) return true;
    return request.headers.authorization === `Bearer ${token}`;
  };

  const broadcast = (channel, release) => {
    const frame = event(release);
    for (const client of clients) {
      if (client.channel !== channel) continue;
      try {
        client.response.write(frame);
      } catch {
        clients.delete(client);
      }
    }
  };

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://wren.invalid');
      const path = url.pathname;

      if (request.method === 'GET' && (path === '/health' || path === '/updates/health.json')) {
        json(response, 200, {
          updater: 'running',
          live: true,
          checkedAt: now(),
          channels: [...CHANNELS],
          nodes: [...nodes.values()]
        });
        return;
      }

      if (request.method === 'GET' && path === '/latest') {
        const channel = channelOf(url.searchParams.get('channel'));
        if (!channel) {
          json(response, 400, { error: 'channel must be akershus or zeus' });
          return;
        }
        const release = latest.get(channel);
        if (!release) {
          response.writeHead(204, { 'cache-control': 'no-store' });
          response.end();
          return;
        }
        json(response, 200, release);
        return;
      }

      if (request.method === 'GET' && path === '/events') {
        const channel = channelOf(url.searchParams.get('channel'));
        if (!channel) {
          json(response, 400, { error: 'channel must be akershus or zeus' });
          return;
        }
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive'
        });
        response.write(': connected\n\n');
        const release = latest.get(channel);
        if (release) response.write(event(release));
        const client = { channel, response };
        clients.add(client);
        request.on('close', () => clients.delete(client));
        return;
      }

      if (request.method === 'POST' && path === '/publish') {
        if (!authorized(request)) {
          json(response, 401, { error: 'publisher token required' });
          return;
        }
        const release = await readBody(request);
        if (!verifyRelease(release, publicKey)) {
          json(response, 400, { error: 'release signature is invalid' });
          return;
        }
        const channel = channelOf(release.channel);
        if (!channel) {
          json(response, 400, { error: 'channel must be akershus or zeus' });
          return;
        }
        if (!Number.isSafeInteger(release.issuedAt) || release.issuedAt <= 0) {
          json(response, 400, { error: 'issuedAt must be a positive integer' });
          return;
        }
        const previous = latest.get(channel);
        if (previous && release.issuedAt <= previous.issuedAt) {
          json(response, 409, { error: 'release is not newer than the current channel release' });
          return;
        }
        latest.set(channel, release);
        broadcast(channel, release);
        json(response, 200, {
          ok: true,
          channel,
          version: release.version,
          issuedAt: release.issuedAt,
          nodes: clients.size
        });
        return;
      }

      if (request.method === 'POST' && path === '/report') {
        if (!authorized(request)) {
          json(response, 401, { error: 'publisher token required' });
          return;
        }
        const report = await readBody(request);
        const channel = channelOf(report.channel);
        if (!channel || typeof report.nodeId !== 'string' || !report.nodeId) {
          json(response, 400, { error: 'nodeId and channel are required' });
          return;
        }
        nodes.set(report.nodeId, {
          nodeId: report.nodeId,
          channel,
          role: typeof report.role === 'string' ? report.role : '',
          version: typeof report.version === 'string' ? report.version : '',
          healthy: report.healthy === true,
          installed: report.installed === true,
          checkedAt: Number.isSafeInteger(report.checkedAt) ? report.checkedAt : now(),
          reason: typeof report.reason === 'string' ? report.reason : ''
        });
        json(response, 200, { ok: true });
        return;
      }

      json(response, 404, { error: 'not found' });
    } catch (error) {
      if (!response.headersSent) json(response, 400, { error: error.message });
      else response.end();
    }
  });

  const keepalive = setInterval(() => {
    for (const client of clients) {
      try {
        client.response.write(': keepalive\n\n');
      } catch {
        clients.delete(client);
      }
    }
  }, 15000);
  if (keepalive.unref) keepalive.unref();

  const close = () => new Promise(resolve => {
    clearInterval(keepalive);
    for (const client of clients) {
      try {
        client.response.end();
      } catch {
        // The connection was already closed.
      }
    }
    clients.clear();
    if (server.closeAllConnections) server.closeAllConnections();
    server.close(() => resolve());
  });

  return { server, latest, nodes, close };
}

export async function startWrenRelay(options = {}) {
  const relay = createWrenRelay(options);
  const port = Number.isInteger(options.port) ? options.port : 8787;
  const host = typeof options.host === 'string' ? options.host : '127.0.0.1';
  await new Promise((resolve, reject) => {
    relay.server.once('error', reject);
    relay.server.listen(port, host, () => {
      relay.server.off('error', reject);
      resolve();
    });
  });
  const address = relay.server.address();
  return {
    ...relay,
    port: typeof address === 'object' && address ? address.port : port,
    url: `http://${host}:${typeof address === 'object' && address ? address.port : port}`
  };
}

async function main() {
  const keyFile = process.env.HIVE_RELAY_PUBLIC_KEY_FILE;
  if (!keyFile) throw new Error('HIVE_RELAY_PUBLIC_KEY_FILE is required.');
  const relay = await startWrenRelay({
    publicKey: await readFile(keyFile, 'utf8'),
    token: process.env.HIVE_RELAY_TOKEN || '',
    host: process.env.HIVE_RELAY_HOST || '127.0.0.1',
    port: Number(process.env.HIVE_RELAY_PORT || '8787')
  });
  const stop = () => relay.close().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.log(`[wren-relay] listening on ${relay.url}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[wren-relay] ${error.message}`);
    process.exit(1);
  });
}
