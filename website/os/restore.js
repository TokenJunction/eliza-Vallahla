(function () {
  var button = document.getElementById('backup-restore');
  var status = document.getElementById('restore-status');
  if (!button) return;
  button.addEventListener('click', function () {
    if (!window.ValhallaSupabase) return;
    window.ValhallaSupabase.client().then(function (supabase) {
      return supabase.auth.getSession();
    }).then(function (result) {
      var token = result && result.data && result.data.session && result.data.session.access_token;
      if (!token) { if (status) status.textContent = 'Sign-in required.'; return null; }
      return fetch('/api/snapshot', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: '{"action":"restore"}'
      });
    }).then(function (response) {
      if (!response) return null;
      return response.json().then(function (body) {
        if (status) status.textContent = response.ok && body.restored ? 'Restored ' + (body.restored.at || '') : (body.error || 'That backup could not be read.');
      });
    }, function () {
      if (status) status.textContent = 'That backup could not be read.';
    });
  });
})();