(function () {
  var mount = document.getElementById('clerk-sign-in');
  var note = document.getElementById('sign-in-status');
  if (!mount || !note) return;

  function unavailable() {
    note.hidden = false;
    note.textContent = 'Sign-in is not available yet.';
  }

  fetch('/api/entrance-config', { cache: 'no-store' }).then(function (response) {
    if (!response || !response.ok) throw new Error('unavailable');
    return response.json();
  }).then(function (config) {
    var key = window.ValhallaClerk.productionKey(config);
    if (!key) {
      unavailable();
      return;
    }
    return window.ValhallaClerk.loadClerk(key).then(function (clerk) {
      if (clerk.user) {
        window.location.replace('/os/');
        return;
      }
      note.hidden = true;
      if (typeof clerk.mountSignIn === 'function') {
        clerk.mountSignIn(mount, { afterSignInUrl: '/os/', afterSignUpUrl: '/os/' });
      } else {
        unavailable();
      }
    });
  }).catch(unavailable);
})();
