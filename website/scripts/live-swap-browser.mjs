import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const port = 8771;
const base = `http://127.0.0.1:${port}`;
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', 'site-build'], { stdio: 'ignore' });
const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9333', '--user-data-dir=/tmp/valos-swap-chrome', 'about:blank'], { stdio: 'ignore' });

async function ready(url) {
  for (let i = 0; i < 30; i += 1) {
    try { if ((await fetch(url)).ok) return; } catch (error) { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('not ready ' + url);
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const opened = new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
  ws.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (!data.id || !pending.has(data.id)) return;
    const { resolve, reject } = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) reject(new Error(JSON.stringify(data.error)));
    else resolve(data.result);
  });
  return { ready: opened, send(method, params = {}) { const messageId = ++id; return new Promise((resolve, reject) => { pending.set(messageId, { resolve, reject }); ws.send(JSON.stringify({ id: messageId, method, params })); }); } };
}

async function shot(page, file) {
  const image = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(image.data, 'base64'));
}

try {
  await ready(`${base}/`);
  await ready('http://127.0.0.1:9333/json/version');
  const created = await (await fetch(`http://127.0.0.1:9333/json/new?${encodeURIComponent(base + '/')}`, { method: 'PUT' })).json();
  const page = connect(created.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  async function evaluate(expression) {
    const result = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  await page.send('Page.navigate', { url: `${base}/` });
  await new Promise(resolve => setTimeout(resolve, 1200));
  const home = await evaluate(`({
    playing: !document.getElementById('hero-video').paused,
    source: document.querySelector('#hero-video source')?.src || '',
    poster: document.querySelector('.still')?.getAttribute('src') || ''
  })`);
  if (!home.playing || !home.source.endsWith('/media/hero-web.mp4') || home.poster !== '/assets/heaven-poster.jpg') {
    throw new Error('landing video ' + JSON.stringify(home));
  }
  await shot(page, '/opt/cursor/artifacts/live-landing.png');
  await page.send('Page.navigate', { url: `${base}/os/` });
  await new Promise(resolve => setTimeout(resolve, 400));
  const loader = await evaluate(`({
    visible: !document.getElementById('os-loader').hidden,
    source: document.querySelector('#os-loader-video source')?.src || ''
  })`);
  if (!loader.visible || !loader.source.endsWith('/media/heaven-loop.mp4')) throw new Error('loader ' + JSON.stringify(loader));
  await shot(page, '/opt/cursor/artifacts/live-loader.png');
  await page.send('Page.navigate', { url: `${base}/swap/` });
  await new Promise(resolve => setTimeout(resolve, 500));
  const swapPage = await evaluate(`({
    title: document.querySelector('h1')?.textContent,
    gate: document.getElementById('gate-status').textContent,
    swapDisabled: document.getElementById('swap').disabled,
    report: document.getElementById('tx-signature').textContent
  })`);
  if (swapPage.title !== 'Swap' || swapPage.swapDisabled !== true || !/not configured/i.test(swapPage.gate) || !/Nothing has been sent/.test(swapPage.report)) {
    throw new Error('swap ' + JSON.stringify(swapPage));
  }
  await shot(page, '/opt/cursor/artifacts/live-swap.png');
  const started = Date.now();
  const responses = await Promise.all(['/', '/os/', '/swap/', '/volos/'].flatMap(route => Array.from({ length: 6 }, () => fetch(base + route))));
  if (!responses.every(item => item.ok) || Date.now() - started > 5000) throw new Error('stress failed');
  console.log('live swap previews passed');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
  chrome.kill('SIGTERM');
}
