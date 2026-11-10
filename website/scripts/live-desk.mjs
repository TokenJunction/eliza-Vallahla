import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const port = 8766;
const base = `http://127.0.0.1:${port}`;
const server = spawn('bun', ['website/scripts/serve-site.ts'], {
  env: { ...process.env, PORT: String(port), PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}` },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.on('data', chunk => process.stdout.write(chunk));
server.stderr.on('data', chunk => process.stderr.write(chunk));

async function waitForServer() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch (error) { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Bun desk server did not answer /health');
}

const chrome = spawn('google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu',
  '--remote-debugging-port=9223', '--user-data-dir=/tmp/valhalla-chrome-os', 'about:blank'
], { stdio: 'ignore' });

async function waitForChrome() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch('http://127.0.0.1:9223/json/version');
      if (response.ok) return;
    } catch (error) { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Chrome did not open a debugging port');
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const opened = new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
  ws.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(JSON.stringify(data.error)));
      else resolve(data.result);
    }
  });
  return {
    ws,
    ready: opened,
    send(method, params = {}) {
      const messageId = ++id;
      return new Promise((resolve, reject) => {
        pending.set(messageId, { resolve, reject });
        ws.send(JSON.stringify({ id: messageId, method, params }));
      });
    }
  };
}

async function evaluate(page, expression) {
  const result = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function openPage(url) {
  const created = await (await fetch(`http://127.0.0.1:9223/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const page = connect(created.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await page.send('Page.navigate', { url });
  return page;
}

const report = { checks: [], stress: {} };
function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  if (!ok) console.error('FAIL', name, detail);
  else console.log('PASS', name);
}

try {
  await waitForServer();
  await waitForChrome();
  const home = await openPage(`${base}/`);
  await new Promise(resolve => setTimeout(resolve, 400));
  const entrance = await evaluate(home, `({
    title: document.querySelector('#discover-title')?.textContent || '',
    signIn: !!document.querySelector('[href="/app/"]'),
    tradingOff: document.body.innerText.includes('Live trading is off')
  })`);
  check('entrance', entrance.title.includes('ValhallaOS Citadel') && entrance.signIn && entrance.tradingOff, JSON.stringify(entrance));

  const desk = await openPage(`${base}/os/`);
  await new Promise(resolve => setTimeout(resolve, 1200));
  const passed = await evaluate(desk, `({
    state: document.getElementById('os-pretest')?.dataset.state || '',
    result: document.getElementById('pretest-result')?.textContent || '',
    hidden: document.getElementById('desktop')?.getAttribute('aria-hidden'),
    version: document.querySelector('meta[name="valhalla-desk-version"]').content
  })`);
  check('pretest pass', passed.state === 'passed' && passed.hidden === null && /No newer patch/.test(passed.result), JSON.stringify(passed));

  await evaluate(desk, `['status','wallet','memory'].forEach(name => document.querySelector('.dock [data-open="'+name+'"]').click())`);
  await new Promise(resolve => setTimeout(resolve, 250));
  const idle = await evaluate(desk, `({
    status: document.getElementById('window-status').dataset.idle,
    wallet: document.getElementById('window-wallet').dataset.idle,
    memory: document.getElementById('window-memory').dataset.idle,
    polling: document.getElementById('desktop').dataset.polling,
    statusPulse: getComputedStyle(document.querySelector('#window-status .pulse-dot')).animationPlayState,
    memoryPulse: getComputedStyle(document.querySelector('#window-memory .pulse-dot')).animationPlayState
  })`);
  check('warm cap', idle.status === 'sleeping' && idle.memory === 'active' && idle.polling === 'off' && idle.statusPulse === 'paused' && idle.memoryPulse === 'running', JSON.stringify(idle));
  await evaluate(desk, `document.querySelector('.dock [data-open="status"]').click()`);
  await new Promise(resolve => setTimeout(resolve, 200));
  const woke = await evaluate(desk, `document.getElementById('window-status').dataset.idle`);
  check('focus wakes status', woke === 'active', woke);
  const doze = await evaluate(desk, `(() => {
    const proto = Document.prototype;
    const hidden = Object.getOwnPropertyDescriptor(proto, 'hidden');
    const state = Object.getOwnPropertyDescriptor(proto, 'visibilityState');
    let mode = 'native';
    if (!document.hidden) {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      mode = 'visibility event';
    }
    document.dispatchEvent(new Event('visibilitychange'));
    const snap = {
      mode,
      doze: document.documentElement.dataset.doze,
      memory: document.getElementById('window-memory').dataset.idle,
      clock: document.getElementById('desktop').dataset.clock
    };
    if (hidden) Object.defineProperty(document, 'hidden', hidden);
    if (state) Object.defineProperty(document, 'visibilityState', state);
    document.dispatchEvent(new Event('visibilitychange'));
    snap.woke = document.getElementById('window-memory').dataset.idle;
    return snap;
  })()`);
  check('tab hidden freeze', typeof doze === 'object' && doze.doze === 'yes' && doze.memory === 'sleeping' && doze.clock === 'off', JSON.stringify(doze));

  const missing = await openPage(`${base}/os/?pretest=missing`);
  await new Promise(resolve => setTimeout(resolve, 900));
  const failed = await evaluate(missing, `({
    state: document.getElementById('os-pretest')?.dataset.state || '',
    result: document.getElementById('pretest-result')?.textContent || '',
    hidden: document.getElementById('desktop')?.getAttribute('aria-hidden')
  })`);
  check('pretest failure', failed.state === 'failed' && failed.hidden === 'true' && /404/.test(failed.result), JSON.stringify(failed));
  const failShot = await missing.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('/opt/cursor/artifacts/pretest-failed.png', Buffer.from(failShot.data, 'base64'));

  const patch = await openPage(`${base}/os/?patchcheck=1`);
  await new Promise(resolve => setTimeout(resolve, 1600));
  const patched = await evaluate(patch, `({
    href: location.href,
    reloaded: sessionStorage.getItem('valhalla-patch-reload'),
    state: document.getElementById('os-pretest')?.dataset.state || '',
    result: document.getElementById('pretest-result')?.textContent || ''
  })`);
  check('patch reload', !patched.href.includes('patchcheck') && patched.state === 'passed' && /No newer patch/.test(patched.result), JSON.stringify(patched));
  await desk.send('Page.bringToFront');

  const tools = ['status', 'wallet', 'memory', 'browser', 'swarm', 'volos', 'installer', 'settings'];
  const opened = await evaluate(desk, `(() => {
    const menu = document.getElementById('start-button');
    menu.click();
    const names = ${JSON.stringify(tools)};
    return names.map(name => {
      document.querySelector('#start-menu [data-open="'+name+'"]').click();
      const node = document.getElementById('window-' + name);
      return name + ':' + node.hidden;
    });
  })()`);
  check('tools open windows', opened.every(item => item.endsWith(':false')), opened.join(','));

  await evaluate(desk, `document.getElementById('chat-input').value = 'Open the wallet window'; document.getElementById('chat-form').requestSubmit();`);
  await new Promise(resolve => setTimeout(resolve, 300));
  const copilot = await evaluate(desk, `({
    wallet: document.getElementById('window-wallet').hidden,
    log: document.getElementById('chat-log').innerText,
    status: document.getElementById('chat-status').textContent,
    critic: document.getElementById('quality-readout').textContent
  })`);
  check('copilot opens wallet', copilot.wallet === false && /not connected/i.test(copilot.log) && /No transaction was requested/.test(copilot.status) && copilot.critic.includes('Critic +1'), JSON.stringify(copilot));

  await evaluate(desk, `document.querySelector('[data-install-sample="/os/samples/hello-valos.zip"]').click()`);
  await new Promise(resolve => setTimeout(resolve, 400));
  const sample = await evaluate(desk, `document.getElementById('install-status').textContent`);
  check('sample install', /Installed/.test(sample) && /Hello ValOS/.test(sample), sample);
  await evaluate(desk, `document.querySelector('[data-install-sample="/os/samples/rejected-pack.zip"]').click()`);
  await new Promise(resolve => setTimeout(resolve, 400));
  const rejected = await evaluate(desk, `document.getElementById('install-status').textContent`);
  check('rejected pack', /not converted into a Bun app/.test(rejected), rejected);

  await evaluate(desk, `document.getElementById('chat-input').value = 'hello from the desk'; document.getElementById('chat-form').requestSubmit();`);
  await new Promise(resolve => setTimeout(resolve, 8000));
  const chat = await evaluate(desk, `document.getElementById('chat-status').textContent`);
  check('chat fail closed', /no reply|did not return a reply|No model reply/i.test(chat), chat);

  const volos = await evaluate(desk, `document.getElementById('window-volos').innerText`);
  check('volOS window', /Not published/.test(volos) && /unavailable/i.test(volos), volos.slice(0, 180));
  const settings = await evaluate(desk, `document.getElementById('window-settings').innerText`);
  check('api-less settings', /without a vendor API key/.test(settings) && /No local Gemini/.test(settings), 'settings copy present');

  const started = Date.now();
  const stressDom = await evaluate(desk, `(() => {
    const t0 = performance.now();
    for (let i = 0; i < 20; i += 1) {
      document.querySelector('.dock [data-open="wallet"]').click();
      document.querySelector('#window-wallet [data-action="close"]').click();
    }
    const input = document.getElementById('chat-input');
    for (let i = 0; i < 8; i += 1) {
      input.value = 'Open system status';
      document.getElementById('chat-form').requestSubmit();
    }
    return Math.round(performance.now() - t0);
  })()`);
  const fetches = await Promise.all([base + '/', base + '/os/', base + '/volos/'].flatMap(url => Array.from({ length: 8 }, () => fetch(url))));
  const fetchMs = Date.now() - started;
  report.stress = { domMs: stressDom, fetchCount: fetches.length, fetchMs, fetchOk: fetches.every(item => item.ok) };
  check('stress', stressDom < 3000 && report.stress.fetchOk, JSON.stringify(report.stress));

  const shot = await desk.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('/opt/cursor/artifacts/valos-workstation.png', Buffer.from(shot.data, 'base64'));
  writeFileSync('/opt/cursor/artifacts/valos-live-report.json', JSON.stringify(report, null, 2));
  if (report.checks.some(item => !item.ok)) process.exitCode = 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
  chrome.kill('SIGTERM');
}
