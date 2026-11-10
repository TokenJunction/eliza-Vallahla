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
      if (node.hasAttribute('data-plan-panel')) node.hidden = !allowed;
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

  function publishWallet(config) {
    window.VALHALLA_WALLET = config && config.wallet === 'external'
      ? { configured: true, appId: config.privyAppId }
      : { configured: false };
    window.dispatchEvent(new Event('valhalla-wallet'));
  }

  fetch('/api/entrance-config', { cache: 'no-store' }).then(function (response) {
    if (!response || !response.ok) throw new Error('unavailable');
    return response.json();
  }).then(function (config) {
    publishWallet(config);
    if (!window.ValhallaAuth.clientOptions(config, 'https://valhalla-app.xyz/')) {
      leave();
      return;
    }
    return window.ValhallaAuth.createClient(config, 'https://valhalla-app.xyz/').then(function (client) {
      var restore = client.getTokenSilently ? client.getTokenSilently().catch(function () { return null; }) : Promise.resolve(null);
      return restore.then(function () { return client.getUser(); }).then(function (user) {
        if (!user) {
          leave();
          return;
        }
        showLevel(window.ValhallaAccount.levelFromUser(user));
        var signOut = document.getElementById('sign-out');
        if (signOut) {
          signOut.addEventListener('click', function () {
            client.logout({ logoutParams: { returnTo: window.ValhallaAuth.logoutReturnTo } });
          });
        }
      });
    });
  }).catch(leave);
})();
