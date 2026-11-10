(function () {
  if (!window.ValhallaAuth || !window.ValhallaAuth.hasCallback(window.location.search)) return;
  fetch('/api/entrance-config', { cache: 'no-store' }).then(function (response) {
    if (!response || !response.ok) throw new Error('unavailable');
    return response.json();
  }).then(function (config) {
    return window.ValhallaAuth.createClient(config, window.location.href);
  }).then(function (client) {
    return client.handleRedirectCallback();
  }).then(function (result) {
    var next = result && result.appState && result.appState.returnTo === '/os/' ? '/os/' : '/os/';
    window.location.replace(next);
  }).catch(function () {
    var note = document.getElementById('sign-in-status');
    if (note) note.textContent = 'Sign-in is not available yet.';
  });
})();
