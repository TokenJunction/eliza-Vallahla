'use strict';

(function () {
  var desktop = document.getElementById('desktop');
  var menu = document.getElementById('start-menu');
  var startButton = document.getElementById('start-button');
  var taskbarApps = document.getElementById('taskbar-apps');
  var clock = document.getElementById('clock');
  var announcement = document.getElementById('desktop-announcement');
  var windows = Array.prototype.slice.call(document.querySelectorAll('[data-window]'));
  var topZ = 10;
  var healthTimer = 0;
  var clockTimer = 0;
  var warm = [];
  var WARM_CAP = 2;

  function getWindow(name) {
    return windows.find(function (node) { return node.dataset.window === name; });
  }

  function announce(message) {
    if (announcement) announcement.textContent = message;
  }

  function setMenu(open) {
    menu.hidden = !open;
    startButton.setAttribute('aria-expanded', String(open));
  }

  function paintRuntime() {
    if (desktop) desktop.dataset.polling = healthTimer ? 'on' : 'off';
    if (desktop) desktop.dataset.clock = clockTimer ? 'on' : 'off';
    if (document.documentElement) document.documentElement.dataset.doze = document.hidden ? 'yes' : 'no';
  }

  function stopHealth() {
    if (healthTimer) window.clearInterval(healthTimer);
    healthTimer = 0;
    paintRuntime();
  }

  function startHealth() {
    if (healthTimer || document.hidden) return;
    var status = getWindow('status');
    if (!status || status.hidden || status.dataset.idle === 'sleeping') return;
    healthTimer = window.setInterval(function () {
      if (document.hidden || status.hidden || status.dataset.idle === 'sleeping') { stopHealth(); return; }
      checkHealth();
    }, 30000);
    paintRuntime();
  }

  function stopClock() {
    if (clockTimer) window.clearInterval(clockTimer);
    clockTimer = 0;
    paintRuntime();
  }

  function startClock() {
    if (clockTimer || document.hidden) return;
    clockTimer = window.setInterval(updateClock, 30000);
    paintRuntime();
  }

  function setIdle(node, sleeping) {
    if (!node) return;
    node.dataset.idle = sleeping ? 'sleeping' : 'active';
    var frame = node.querySelector && node.querySelector('iframe');
    if (frame && frame.dataset) {
      if (sleeping) {
        var current = frame.getAttribute ? frame.getAttribute('src') : frame.src;
        var doc = frame.srcdoc || '';
        if (current && current !== 'about:blank') frame.dataset.resume = current;
        if (doc) frame.dataset.resumeDoc = doc;
        if (current && current !== 'about:blank' && frame.setAttribute) frame.setAttribute('src', 'about:blank');
        if (doc) frame.srcdoc = '';
      } else if (frame.dataset.resume && frame.setAttribute) {
        frame.setAttribute('src', frame.dataset.resume);
        if (frame.dataset.resumeDoc) frame.srcdoc = frame.dataset.resumeDoc;
      }
    }
    if (node.dataset.window === 'status') {
      if (sleeping || document.hidden) stopHealth();
      else startHealth();
    }
    paintRuntime();
  }

  function scheduleWarm(node) {
    warm = warm.filter(function (item) { return item !== node; });
    if (!node.hidden) warm.push(node);
    var apply = function () {
      if (document.hidden) {
        windows.forEach(function (item) { setIdle(item, true); });
        stopClock();
        return;
      }
      var keep = {};
      warm.slice(-WARM_CAP).forEach(function (item) { keep[item.dataset.window] = true; });
      windows.forEach(function (item) {
        setIdle(item, item.hidden || !keep[item.dataset.window]);
      });
    };
    apply();
    if (typeof requestIdleCallback === 'function') requestIdleCallback(apply, { timeout: 50 });
  }

  function focusWindow(node) {
    topZ += 1;
    node.style.zIndex = String(topZ);
    windows.forEach(function (item) {
      var button = taskbarApps.querySelector('[data-task="' + item.dataset.window + '"]');
      if (button) button.setAttribute('aria-pressed', String(item === node && !item.hidden));
    });
    scheduleWarm(node);
  }

  function updateTaskbar() {
    taskbarApps.replaceChildren();
    windows.forEach(function (node) {
      if (node.hidden && node.dataset.minimized !== 'true') return;
      var title = node.querySelector('.title-bar h2').textContent;
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'taskbar-app';
      button.dataset.task = node.dataset.window;
      button.textContent = title;
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', function () {
        if (node.dataset.minimized === 'true') {
          node.hidden = false;
          node.dataset.minimized = 'false';
        } else if (node.style.zIndex === String(topZ)) {
          node.dataset.minimized = 'true';
          node.hidden = true;
        }
        updateTaskbar();
        if (!node.hidden) focusWindow(node);
      });
      taskbarApps.appendChild(button);
    });
  }

  function openWindow(name) {
    var node = getWindow(name);
    if (!node) return;
    node.hidden = false;
    node.dataset.minimized = 'false';
    updateTaskbar();
    focusWindow(node);
    setMenu(false);
    announce(node.querySelector('.title-bar h2').textContent + ' opened.');
    if (name === 'status') checkHealth();
  }

  function closeWindow(node) {
    node.hidden = true;
    node.dataset.minimized = 'false';
    warm = warm.filter(function (item) { return item !== node; });
    setIdle(node, true);
    updateTaskbar();
    announce(node.querySelector('.title-bar h2').textContent + ' closed.');
  }

  function minimizeWindow(node) {
    node.hidden = true;
    node.dataset.minimized = 'true';
    warm = warm.filter(function (item) { return item !== node; });
    setIdle(node, true);
    updateTaskbar();
    announce(node.querySelector('.title-bar h2').textContent + ' minimized.');
  }

  function setHealth(text, state) {
    var output = document.getElementById('backend-status');
    var light = document.querySelector('.status-light');
    output.textContent = text;
    output.dataset.state = state;
    light.style.background = state === 'ok' ? '#008000' : state === 'error' ? '#c00000' : '#f0c000';
  }

  async function checkHealth() {
    var output = document.getElementById('backend-status');
    if (output.textContent === 'Checking…') setHealth('Checking…', 'loading');
    var checkedAt = document.getElementById('checked-at');
    var controller = new AbortController();
    var timeout = window.setTimeout(function () { controller.abort(); }, 6000);
    try {
      var response = await fetch('/health', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal
      });
      var type = response.headers.get('content-type') || '';
      if (!response.ok || type.indexOf('application/json') === -1) throw new Error('closed');
      var result = await response.json();
      var status = result && typeof result.status === 'string' ? result.status.trim().toLowerCase() : '';
      if (status !== 'ok' && status !== 'healthy' && status !== 'ready') throw new Error('closed');
      setHealth('Service reports ' + status + '.', 'ok');
      checkedAt.textContent = new Date().toLocaleTimeString();
    } catch (error) {
      setHealth('Unavailable · ' + (error.name === 'AbortError' ? 'timed out' : 'no service status') + '. Not reported as live.', 'error');
      checkedAt.textContent = new Date().toLocaleTimeString();
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function startDrag(event) {
    var handle = event.target.closest('[data-drag-handle]');
    var node = handle && handle.closest('[data-window]');
    if (!handle || !node || event.target.closest('button') || event.button !== 0) return;
    event.preventDefault();
    focusWindow(node);
    var startX = event.clientX;
    var startY = event.clientY;
    var rect = node.getBoundingClientRect();
    var moved = false;
    handle.setPointerCapture(event.pointerId);
    function move(moveEvent) {
      var dx = moveEvent.clientX - startX;
      var dy = moveEvent.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      var x = Math.max(0, Math.min(window.innerWidth - Math.min(120, rect.width), rect.left + dx));
      var y = Math.max(0, Math.min(window.innerHeight - 60, rect.top + dy));
      node.style.left = x + 'px';
      node.style.top = y + 'px';
      node.style.right = 'auto';
      node.style.bottom = 'auto';
    }
    function finish() {
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      if (moved) event.stopPropagation();
    }
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  desktop.addEventListener('click', function (event) {
    var launcher = event.target.closest('[data-open]');
    if (launcher) {
      openWindow(launcher.dataset.open);
      return;
    }
    var action = event.target.closest('[data-action]');
    if (action) {
      var node = action.closest('[data-window]');
      if (action.dataset.action === 'close') closeWindow(node);
      if (action.dataset.action === 'minimize') minimizeWindow(node);
      return;
    }
    if (event.target.closest('[data-refresh]')) checkHealth();
    if (event.target.closest('[data-window]')) focusWindow(event.target.closest('[data-window]'));
  });
  desktop.addEventListener('pointerdown', startDrag);

  startButton.addEventListener('click', function () {
    setMenu(menu.hidden);
  });
  document.addEventListener('click', function (event) {
    if (!menu.hidden && !menu.contains(event.target) && event.target !== startButton && !startButton.contains(event.target)) {
      setMenu(false);
    }
  });
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (!menu.hidden) {
      setMenu(false);
      startButton.focus();
      return;
    }
    var tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    var open = windows.filter(function (node) { return !node.hidden; });
    if (!open.length) return;
    open.sort(function (a, b) { return Number(b.style.zIndex || 0) - Number(a.style.zIndex || 0); });
    closeWindow(open[0]);
  });
  document.getElementById('browser-page').addEventListener('change', function (event) {
    if (event.target.value !== '/' && event.target.value !== '/status/') return;
    var page = event.target.value === '/status/' ? '/status/' : '/';
    var iframe = document.querySelector('#window-browser iframe');
    iframe.src = page;
    if (iframe.dataset) iframe.dataset.resume = page;
    document.querySelector('#window-browser .address-row a').href = page;
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      windows.forEach(function (node) { setIdle(node, true); });
      stopClock();
      return;
    }
    startClock();
    var open = windows.filter(function (node) { return !node.hidden; }).sort(function (a, b) {
      return Number(a.style.zIndex || 0) - Number(b.style.zIndex || 0);
    });
    warm = open.slice(-WARM_CAP);
    if (warm.length) scheduleWarm(warm[warm.length - 1]);
  });

  function updateClock() {
    var now = new Date();
    clock.dateTime = now.toISOString();
    clock.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  windows.forEach(function (node) { setIdle(node, true); });
  updateClock();
  startClock();
  updateTaskbar();
  var initiallyOpen = windows.find(function (node) { return !node.hidden; });
  if (initiallyOpen) focusWindow(initiallyOpen);
  checkHealth();
  var spotlight = document.getElementById('spotlight');
  if (spotlight && spotlight.addEventListener) spotlight.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter') return;
    var query = String(spotlight.value || '').trim().toLowerCase();
    if (!query) return;
    var buttons = Array.prototype.slice.call(document.querySelectorAll('[data-open]'));
    var match = buttons.find(function (button) {
      return button.dataset.open === query || String(button.textContent || '').toLowerCase().indexOf(query) !== -1;
    });
    if (match) openWindow(match.dataset.open);
  });
  function storedRole() {
    try {
      var search = window.location && window.location.search || '';
      var requested = (new URLSearchParams(search).get('node') || '').toLowerCase();
      if (requested === 'laptop' || requested === 'full-time') {
        if (window.localStorage) window.localStorage.setItem('valhalla-node-role', requested);
        return requested;
      }
      var saved = window.localStorage ? window.localStorage.getItem('valhalla-node-role') : '';
      return saved === 'laptop' || saved === 'full-time' ? saved : '';
    } catch (error) { return ''; }
  }
  function showRole(role) {
    var label = document.getElementById('node-label');
    var header = document.getElementById('header-node');
    var text = role ? 'This window: ' + role + '. Other nodes are not connected.' : 'Node label not set. This window only.';
    if (label) label.textContent = text;
    if (header) header.textContent = role ? role.toUpperCase() : 'THIS WINDOW';
  }
  showRole(storedRole());
  document.addEventListener('click', function (event) {
    var roleButton = event.target.closest && event.target.closest('[data-node-role]');
    if (!roleButton) return;
    var role = roleButton.getAttribute('data-node-role');
    if (role !== 'laptop' && role !== 'full-time') return;
    try { if (window.localStorage) window.localStorage.setItem('valhalla-node-role', role); } catch (error) { /* label still updates */ }
    showRole(role);
  });
  var nodeCheck = document.getElementById('node-check');
  if (nodeCheck && nodeCheck.addEventListener) nodeCheck.addEventListener('click', async function () {
    var output = document.getElementById('node-reach');
    if (output) output.textContent = 'Checking this desk copy…';
    try {
      var response = await fetch('/os/', { cache: 'no-store', credentials: 'same-origin' });
      var body = response.ok ? await response.text() : '';
      var version = (body.match(/name="valhalla-desk-version" content="([^"]+)"/) || [])[1] || '';
      if (!response.ok || !version) {
        if (output) output.textContent = 'Desk copy not verified. HTTP ' + response.status + '. Not reported as live.';
        return;
      }
      if (output) output.textContent = 'This desk copy is reachable. Version ' + version + '. That is this page, not a cluster.';
      var seen = document.getElementById('node-seen');
      if (seen) seen.textContent = new Date().toLocaleString();
    } catch (error) {
      if (output) output.textContent = 'Desk copy was not reachable. Not reported as live.';
    }
  });
  window.addEventListener('pagehide', function () {
    stopHealth();
    stopClock();
  }, { once: true });
})();