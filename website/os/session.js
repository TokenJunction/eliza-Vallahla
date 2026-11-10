(function () {
  var desk = document.getElementById('desktop');
  var hold = document.getElementById('session-hold');
  if (desk) desk.hidden = true;

  function leave() {
    window.location.replace('/');
  }

  function showLevel(level) {
    document.body.dataset.session = 'in';
    document.body.dataset.level = level.level;
    var note = document.getElementById('account-level');
    if (note) note.textContent = level.note;
    if (hold) hold.hidden = true;
    if (desk) desk.hidden = false;
    Array.prototype.forEach.call(document.querySelectorAll('[data-tool]'), function (node) {
      var tool = node.getAttribute('data-tool');
      var allowed = window.ValhallaAccount.toolAllowed(level.level, tool);
      if (node.tagName === 'BUTTON') node.disabled = node.disabled || !allowed;
      if (!allowed) {
        node.setAttribute('aria-disabled', 'true');
        node.title = level.configured
          ? 'This tool is not included at ' + level.level + '.'
          : 'This tool is not included at FREE. Plans are not configured.';
        node.addEventListener('click', function (event) { event.preventDefault(); });
      }
    });
  }

  fetch('/api/entrance-config', { cache: 'no-store' }).then(function (response) {
    if (!response || !response.ok) throw new Error('unavailable');
    return response.json();
  }).then(function (config) {
    var key = window.ValhallaClerk.productionKey(config);
    if (!key) {
      leave();
      return;
    }
    return window.ValhallaClerk.loadClerk(key).then(function (clerk) {
      if (!clerk.user) {
        leave();
        return;
      }
      showLevel(window.ValhallaAccount.levelFromUser(clerk.user));
      var menu = document.getElementById('account-menu');
      if (menu && typeof clerk.mountUserButton === 'function') {
        clerk.mountUserButton(menu, { afterSignOutUrl: '/' });
      }
    });
  }).catch(leave);
})();
