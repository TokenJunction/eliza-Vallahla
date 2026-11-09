const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const page = fs.readFileSync(path.join(root, 'website/valos/index.html'), 'utf8');
const configSource = fs.readFileSync(path.join(root, 'website/site-config.js'), 'utf8');
const script = fs.readFileSync(path.join(root, 'website/valos/valos.js'), 'utf8');
const onboarding = fs.readFileSync(path.join(root, 'website/valos/onboarding/index.html'), 'utf8');
const calendar = fs.readFileSync(path.join(root, 'website/valos/milestones.ics'), 'utf8');

function publicConfig() {
  const window = {};
  vm.runInNewContext(configSource, { window });
  return window.VALHALLA_SITE.VALOS;
}

function browser(config = publicConfig()) {
  const nodes = {};
  const created = [];
  function node(id) {
    return nodes[id] ||= {
      id, hidden: true, href: '', value: '', textContent: '', handlers: {},
      addEventListener(type, fn) { this.handlers[type] = fn; },
      replaceChildren(...children) { this.children = children; }
    };
  }
  const document = {
    getElementById: node,
    createElement(tag) {
      const element = { tag, href: '', rel: '', target: '', textContent: '' };
      created.push(element);
      return element;
    },
    querySelector(selector) {
      return selector === 'link[rel="canonical"]'
        ? { href: 'https://valhalla-app.xyz/valos/' }
        : null;
    }
  };
  vm.runInNewContext(script, {
    window: { VALHALLA_SITE: { VALOS: config } },
    document,
    URL,
    navigator: { clipboard: { writeText: async () => {} } },
    encodeURIComponent
  });
  return { node, created };
}

test('public token configuration starts planned, unset, and unapproved', () => {
  const config = publicConfig();
  assert.equal(config.STATUS, 'planned-unverified');
  for (const key of ['NETWORK', 'MINT_ADDRESS', 'EXPLORER_URL', 'PURCHASE_URL', 'X_PROFILE_URL', 'X_HANDLE']) {
    assert.equal(config[key], '');
  }
  assert.equal(config.PURCHASE_APPROVED, false);
  assert.equal(config.X_PROFILE_OWNER_CONFIRMED, false);
});

test('ValOS page has six linked-back sections and disabled purchase UI', () => {
  const sections = [...page.matchAll(/<section\b[\s\S]*?<\/section>/g)].map(match => match[0]);
  assert.equal(sections.length, 6);
  for (const section of sections) assert.match(section, /href="\/valos\/"/);
  for (const id of ['capabilities', 'purpose', 'status', 'gates', 'risks', 'official']) {
    assert.match(page, new RegExp(`<section id="${id}"`));
  }
  assert.match(page, /<button id="valos-purchase"[^>]*disabled/);
  assert.match(page, /No purchase, payment, swap, or trading function is available/);
  assert.doesNotMatch(page, /countdown|limited time|price per token/i);
  assert.doesNotMatch(script, /valos-purchase|removeAttribute\(['"]disabled|\.disabled\s*=\s*false/);
});

test('ValOS page exposes accessible landmarks and responsive reduced-motion styling', () => {
  assert.equal((page.match(/<h1\b/g) || []).length, 1);
  assert.match(page, /<a class="skip-link" href="#main">Skip to content<\/a>/);
  assert.match(page, /<main id="main">/);
  assert.match(page, /<nav class="section-nav" aria-label="ValOS page sections">/);
  assert.match(page, /<label for="x-post-draft">/);
  assert.match(page, /id="x-post-draft"[^>]*readonly/);
  assert.match(page, /id="x-copy-button" type="button">Copy draft text/);
  const styles = fs.readFileSync(path.join(root, 'website/valos/valos.css'), 'utf8');
  assert.match(styles, /@media \(max-width:/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /:focus-visible/);
});

test('X profile is hidden unless owner-confirmed; sharing is user-initiated only', () => {
  const missing = browser();
  assert.equal(missing.node('x-profile-link').hidden, true);
  assert.match(missing.node('x-profile-note').textContent, /owner confirms the exact profile/);
  assert.match(missing.node('x-share-link').href, /^https:\/\/x\.com\/intent\/post\?/);
  assert.equal(missing.node('x-share-link').hidden, false);
  assert.match(missing.node('x-post-draft').value, /not verified/);

  const unconfirmed = browser({ ...publicConfig(), X_PROFILE_URL: 'https://x.com/valos_project' });
  assert.equal(unconfirmed.node('x-profile-link').hidden, true);

  const confirmed = browser({
    ...publicConfig(),
    X_PROFILE_URL: 'https://x.com/ValOSOwner',
    X_PROFILE_OWNER_CONFIRMED: true
  });
  assert.equal(confirmed.node('x-profile-link').hidden, false);
  assert.equal(confirmed.node('x-profile-link').href, 'https://x.com/ValOSOwner');
  assert.equal(confirmed.node('x-profile-link').textContent, 'Follow the confirmed ValhallaOS profile on X');

  const labeled = browser({
    ...publicConfig(),
    X_PROFILE_URL: 'https://x.com/ValOSOwner',
    X_PROFILE_OWNER_CONFIRMED: true,
    X_HANDLE: '@ValOSOwner'
  });
  assert.equal(labeled.node('x-profile-link').textContent, 'Follow @ValOSOwner on X');

  const untrusted = browser({
    ...publicConfig(),
    X_PROFILE_URL: 'https://x.com.evil.example/fake',
    X_PROFILE_OWNER_CONFIRMED: true
  });
  assert.equal(untrusted.node('x-profile-link').hidden, true);
});

test('calendar uses stable undated VTODO identifiers linked to PR and page', () => {
  const tasks = calendar.split('BEGIN:VTODO').slice(1).map(item => item.split('END:VTODO')[0]);
  assert.equal(tasks.length, 5);
  const ids = tasks.map(task => task.match(/^UID:([^@\r\n]+)@/m)?.[1]);
  assert.deepEqual(ids, [
    'valos-identity',
    'valos-owner-purpose-review',
    'valos-confirm-x-profile',
    'valos-readonly-testnet-validation',
    'valos-release-and-rollback-review'
  ]);
  assert.equal(new Set(ids).size, ids.length);
  assert.doesNotMatch(calendar, /^DTSTART|^DUE|^DTEND|^DURATION/m);
  for (const task of tasks) {
    assert.match(task, /https:\/\/github\.com\/TokenJunction\/eliza-valhalla\/pull\/54/);
    assert.match(task, /https:\/\/valhalla-app\.xyz\/valos\//);
    assert.match(task, /^STATUS:NEEDS-ACTION/m);
  }
  assert.ok(calendar.split(/\r?\n/).every(line => Buffer.byteLength(line, 'utf8') <= 75));
});

test('onboarding package covers setup, configuration, rollback, support, and risks', () => {
  for (const phrase of [
    'Quick start', 'Code-verified capabilities', 'Unavailable or unsupported',
    'website/site-config.js', 'docs/worker-secret-names.example', 'Deployment and rollback',
    'Support contact:', 'Digital assets are volatile and may become worthless'
  ]) assert.ok(onboarding.includes(phrase), phrase);
  assert.match(onboarding, /No ValOS contract or mint/);
  assert.match(onboarding, /never requests an X password or posts automatically/);
});
