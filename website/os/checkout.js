(function () {
  var panel = document.getElementById('trial-panel');
  var button = document.getElementById('start-trial');
  var status = document.getElementById('trial-status');
  if (!panel || !button) return;

  async function sync() {
    var level = document.getElementById('account-level');
    var signedIn = document.body && document.body.dataset.session === 'in';
    if (!signedIn || !window.ValhallaSupabase || !window.ValhallaSupabase.config) {
      panel.hidden = true;
      return;
    }
    var settings = window.ValhallaSupabase.config();
    if (!settings) {
      panel.hidden = !(level && level.textContent === 'Free');
      return;
    }
    try {
      var supabase = await window.ValhallaSupabase.client();
      var session = await supabase.auth.getSession();
      var access = session && session.data && session.data.session && session.data.session.access_token;
      if (!access) {
        panel.hidden = true;
        return;
      }
      var response = await fetch(settings.url + '/rest/v1/entitlements?select=plan,status', {
        headers: { authorization: 'Bearer ' + access, apikey: settings.key, accept: 'application/json' }
      });
      var rows = response.ok ? await response.json() : [];
      var row = Array.isArray(rows) ? rows[0] : null;
      button.hidden = false;
      var pro = row && row.plan === 'pro' && (row.status === 'active' || row.status === 'trialing' || row.status === 'past_due');
      if (level && pro) level.textContent = 'Pro';
      if (row && row.status === 'past_due') {
        panel.hidden = false;
        button.hidden = true;
        if (status) status.textContent = 'A payment is past due. A second subscription is not started.';
        return;
      }
      panel.hidden = !!pro;
    } catch (error) {
      panel.hidden = !(level && level.textContent === 'Free');
    }
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
