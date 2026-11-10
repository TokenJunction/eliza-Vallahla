(function () {
  var note = document.getElementById('sign-in-status');
  var button = document.getElementById('sign-in');
  if (!note || !button || !window.ValhallaAuth) return;

  function unavailable(message) {
    note.hidden = false;
    note.textContent = message || 'Sign-in is not available yet.';
    button.hidden = true;
  }

  fetch('/api/entrance-config', { cache: 'no-store' }).then(function (response) {
    if (!response || !response.ok) throw new Error('unavailable');
    return response.json();
  }).then(function (config) {
    if (!config || config.auth0 !== 'configured') {
      unavailable('Sign-in is not available yet.');
      return;
    }
    var redirect = window.ValhallaAuth.redirectUri(window.location.href);
    if (!redirect) {
      unavailable('Sign-in cannot return to this address.');
      return;
    }
    return window.ValhallaAuth.createClient(config, window.location.href).then(function (client) {
      if (window.ValhallaAuth.hasCallback(window.location.search)) {
        return client.handleRedirectCallback().then(function (result) {
          var next = result && result.appState && result.appState.returnTo === '/os/' ? '/os/' : '/os/';
          window.history.replaceState({}, document.title, redirect);
          window.location.replace(next);
        });
      }
      return client.isAuthenticated().then(function (ready) {
        if (ready) {
          window.location.replace('/os/');
          return;
        }
        note.hidden = true;
        button.hidden = false;
        button.addEventListener('click', function () {
          client.loginWithRedirect({
            authorizationParams: { redirect_uri: redirect },
            appState: { returnTo: '/os/' }
          });
        });
      });
    });
  }).catch(function () { unavailable('Sign-in is not available yet.'); });
})();
