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

  function focusWindow(node) {
    topZ += 1;
    node.style.zIndex = String(topZ);
    windows.forEach(function (item) {
      var button = taskbarApps.querySelector('[data-task="' + item.dataset.window + '"]');
      if (button) button.setAttribute('aria-pressed', String(item === node && !item.hidden));
    });
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

  function openWindow(name, opener) {
    var node = getWindow(name);
    if (!node) return;
    node.hidden = false;
    node.dataset.minimized = 'false';
    if (opener) node._returnFocus = opener;
    updateTaskbar();
    focusWindow(node);
    setMenu(false);
    var title = node.querySelector('.title-bar h2');
    if (title) {
      title.tabIndex = -1;
      title.focus();
    }
    announce(node.querySelector('.title-bar h2').textContent + ' opened.');
    if (name === 'status') checkHealth();
  }

  function closeWindow(node) {
    node.hidden = true;
    node.dataset.minimized = 'false';
    updateTaskbar();
    announce(node.querySelector('.title-bar h2').textContent + ' closed.');
    if (node._returnFocus && document.contains(node._returnFocus)) node._returnFocus.focus();
  }

  function maximizeWindow(node) {
    if (node.dataset.maximized === 'true') {
      node.style.left = node.dataset.restoreLeft || '';
      node.style.top = node.dataset.restoreTop || '';
      node.style.width = node.dataset.restoreWidth || '';
      node.style.height = node.dataset.restoreHeight || '';
      node.dataset.maximized = 'false';
      announce(node.querySelector('.title-bar h2').textContent + ' restored.');
      return;
    }
    node.dataset.restoreLeft = node.style.left;
    node.dataset.restoreTop = node.style.top;
    node.dataset.restoreWidth = node.style.width;
    node.dataset.restoreHeight = node.style.height;
    node.dataset.maximized = 'true';
    node.style.left = '8px';
    node.style.top = '8px';
    node.style.width = 'calc(100vw - 16px)';
    node.style.height = 'calc(100vh - 148px)';
    focusWindow(node);
    announce(node.querySelector('.title-bar h2').textContent + ' maximized.');
  }

  function minimizeWindow(node) {
    node.hidden = true;
    node.dataset.minimized = 'true';
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
    var checkedAt = document.getElementById('checked-at');
    var site = window.VALHALLA_SITE || {};
    var base = String(site.AGENT_API_URL || '').replace(/\/$/, '');
    if (base.indexOf('https://') !== 0) {
      setHealth('Not configured. No service was called.', 'idle');
      checkedAt.textContent = 'Not checked';
      return;
    }
    setHealth('Checking…', 'loading');
    var controller = new AbortController();
    var timeout = window.setTimeout(function () { controller.abort(); }, 6000);
    try {
      var response = await fetch(base + '/ready', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal
      });
      var result = await response.json();
      var access = await import('/valhalla/access.js');
      if (response.ok && access.healthReady(result)) {
        setHealth('Operational.', 'ok');
      } else {
        setHealth('Not operational.', 'error');
      }
      checkedAt.textContent = new Date().toLocaleTimeString();
    } catch (error) {
      setHealth(error.name === 'AbortError' ? 'Not operational. Timed out.' : 'Not operational. The check failed.', 'error');
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
      openWindow(launcher.dataset.open, launcher);
      return;
    }
    var action = event.target.closest('[data-action]');
    if (action) {
      var node = action.closest('[data-window]');
      if (action.dataset.action === 'close') closeWindow(node);
      if (action.dataset.action === 'minimize') minimizeWindow(node);
      if (action.dataset.action === 'maximize') maximizeWindow(node);
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
    if (event.key !== 'Escape' || desktop.hidden) return;
    if (!menu.hidden) {
      setMenu(false);
      startButton.focus();
      return;
    }
    var active = document.activeElement;
    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') && !active.closest('[data-window]')) return;
    var front = windows.filter(function (node) { return !node.hidden; }).sort(function (a, b) {
      return Number(b.style.zIndex || 0) - Number(a.style.zIndex || 0);
    })[0];
    if (!front) return;
    event.preventDefault();
    closeWindow(front);
  });

  function updateClock() {
    var now = new Date();
    clock.dateTime = now.toISOString();
    clock.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  updateClock();
  window.setInterval(updateClock, 30_000);
  updateTaskbar();
  var initiallyOpen = windows.find(function (node) { return !node.hidden; });
  if (initiallyOpen) focusWindow(initiallyOpen);
  checkHealth();
  healthTimer = window.setInterval(function () {
    if (!getWindow('status').hidden) checkHealth();
  }, 30_000);
  window.addEventListener('pagehide', function () {
    window.clearInterval(healthTimer);
  }, { once: true });
})();