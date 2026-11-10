(function () {
  var gate = document.getElementById('gate');
  var board = document.getElementById('board');
  var gateStatus = document.getElementById('gate-status');
  var installPrompt = null;

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/overseer/sw.js', { scope: '/overseer/' }).catch(function () {});
  }

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    installPrompt = event;
    var button = document.getElementById('install');
    if (button) button.hidden = false;
  });

  var install = document.getElementById('install');
  if (install) install.addEventListener('click', function () {
    if (!installPrompt) return;
    installPrompt.prompt();
    install.hidden = true;
  });

  function say(text) { if (gateStatus) gateStatus.textContent = text; }

  function showBoard() {
    if (gate) gate.hidden = true;
    if (board) board.hidden = false;
    loadStatus();
    loadProof();
    loadApprovals();
    offerAdmin();
  }

  async function token() {
    var supabase = await window.ValhallaSupabase.client();
    var session = await supabase.auth.getSession();
    return session && session.data && session.data.session && session.data.session.access_token || '';
  }

  async function loadStatus() {
    var node = document.getElementById('status-board');
    try {
      var response = await fetch('/api/overseer-status', { cache: 'no-store' });
      var body = await response.json();
      if (node) node.textContent = body.label || 'Not checked.';
      if (window.caches) {
        var cache = await caches.open('overseer-shell');
        await cache.put('/api/overseer-status', new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
      }
    } catch (error) {
      if (node) node.textContent = 'Not checked.';
    }
  }

  async function loadProof() {
    var node = document.getElementById('proof-panel');
    try {
      var response = await fetch('/api/proof', { cache: 'no-store' });
      if (!response.ok) throw new Error('missing');
      var body = await response.json();
      if (node) node.textContent = (body.label || 'Cryptographic proof') + '. Fees are not loaded.';
    } catch (error) {
      if (node) node.textContent = 'Proof not connected. Fees are not loaded.';
    }
  }

  async function loadApprovals() {
    var list = document.getElementById('approvals');
    if (!list) return;
    list.replaceChildren();
    var item = document.createElement('li');
    item.textContent = 'No approvals waiting.';
    list.appendChild(item);
  }

  async function offerAdmin() {
    var access = await token();
    if (!access) return;
    var response = await fetch('/api/overseer-admin', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + access, 'content-type': 'application/json' },
      body: '{"action":"ping"}'
    });
    var box = document.getElementById('owner-actions');
    if (box && response.ok) box.hidden = false;
  }

  async function owner(action) {
    var access = await token();
    var response = await fetch('/api/overseer-admin', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + access, 'content-type': 'application/json' },
      body: JSON.stringify({ action: action })
    });
    var body = {};
    try { body = await response.json(); } catch (error) { body = {}; }
    var node = document.getElementById('owner-status');
    if (node) node.textContent = body.error || (response.ok ? 'Waiting for the push agent.' : 'Not available.');
  }

  var ship = document.getElementById('ship');
  var undo = document.getElementById('undo');
  if (ship) ship.addEventListener('click', function () { owner('ship'); });
  if (undo) undo.addEventListener('click', function () { owner('undo'); });

  var toggle = document.getElementById('push-toggle');
  if (toggle) toggle.addEventListener('click', async function () {
    var access = await token();
    if (!access) return;
    var keys = await fetch('/api/push').then(function (response) { return response.json(); });
    if (!keys.publicKey || !navigator.serviceWorker) {
      toggle.textContent = 'Alerts are not configured.';
      return;
    }
    function keyBytes(value) {
      var padded = value + '='.repeat((4 - value.length % 4) % 4);
      var raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
      var bytes = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
      return bytes;
    }
    var registration = await navigator.serviceWorker.ready;
    var current = await registration.pushManager.getSubscription();
    if (current) {
      await fetch('/api/push', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + access, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'unsubscribe', subscription: current.toJSON() })
      });
      await current.unsubscribe();
      toggle.textContent = 'Turn on alerts';
      return;
    }
    var subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(keys.publicKey)
    });
    await fetch('/api/push', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + access, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'subscribe', subscription: subscription.toJSON() })
    });
    toggle.textContent = 'Turn off alerts';
  });

  var google = document.getElementById('google-sign-in');
  if (google) google.addEventListener('click', function () {
    if (!window.ValhallaSupabase || !window.ValhallaSupabase.config()) {
      say('Sign-in is not configured yet.');
      return;
    }
    window.ValhallaSupabase.client().then(function (supabase) {
      var here = window.location.origin + '/overseer/';
      return supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: here } });
    }).catch(function () { say('Sign-in did not start.'); });
  });

  var signOut = document.getElementById('sign-out');
  if (signOut) signOut.addEventListener('click', function () {
    window.ValhallaSupabase.client().then(function (supabase) {
      return supabase.auth.signOut();
    }).then(function () { window.location.replace('/overseer/'); });
  });

  if (!window.ValhallaSupabase || !window.ValhallaSupabase.config()) {
    say('Sign-in is not configured yet.');
    return;
  }
  window.ValhallaSupabase.client().then(function (supabase) {
    return supabase.auth.getSession();
  }).then(function (result) {
    var user = result && result.data && result.data.session && result.data.session.user;
    if (user && user.id) showBoard();
  }).catch(function () { say('Sign-in did not start.'); });
})();
