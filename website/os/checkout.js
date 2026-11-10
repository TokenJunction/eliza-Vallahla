(function () {
  var panel = document.getElementById('trial-panel');
  var button = document.getElementById('start-trial');
  var status = document.getElementById('trial-status');
  if (!panel || !button) return;

  function sync() {
    var level = document.getElementById('account-level');
    var signedIn = document.body && document.body.dataset.session === 'in';
    panel.hidden = !(signedIn && level && level.textContent === 'Free');
  }

  window.addEventListener('valhalla-signed-in', sync);
  sync();

  button.addEventListener('click', async function () {
    if (status) status.textContent = 'Opening checkout…';
    button.disabled = true;
    try {
      if (!window.ValhallaSupabase) throw new Error('Sign-in required.');
      var supabase = await window.ValhallaSupabase.client();
      var session = await supabase.auth.getSession();
      var token = session && session.data && session.data.session && session.data.session.access_token;
      if (!token) throw new Error('Sign-in required.');
      var response = await fetch('/api/checkout', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token },
        cache: 'no-store'
      });
      var body = {};
      try { body = await response.json(); } catch (error) { body = {}; }
      if (response.status === 503) {
        if (status) status.textContent = 'Checkout is not configured yet.';
        return;
      }
      if (!response.ok || !body.url) {
        if (status) status.textContent = 'Checkout could not be started.';
        return;
      }
      window.location.assign(body.url);
    } catch (error) {
      if (status) status.textContent = 'Sign-in required.';
    } finally {
      button.disabled = false;
    }
  });
})();
