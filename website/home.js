(function () {
  var status = document.getElementById('auth-status');
  var google = document.getElementById('google-sign-in');
  var form = document.getElementById('magic-link');
  var email = document.getElementById('magic-email');
  if (!status || !google || !form || !email || !window.ValhallaSupabase) return;

  var busy = false;

  function say(text) {
    status.textContent = text;
  }

  function unlock() {
    busy = false;
    google.disabled = false;
  }

  if (!window.ValhallaSupabase.config()) {
    say('Sign-in is not configured yet.');
    google.disabled = true;
    return;
  }

  window.ValhallaSupabase.client().then(function (supabase) {
    return supabase.auth.getSession().then(function (result) {
      var user = result && result.data && result.data.session && result.data.session.user;
      if (user) {
        window.location.replace('/os/');
        return;
      }
      google.addEventListener('click', function () {
        if (busy) return;
        busy = true;
        google.disabled = true;
        say('Opening Google…');
        supabase.auth.signInWithOAuth({
          provider: 'google',
          options: { redirectTo: window.ValhallaSupabase.osReturnTo() }
        }).then(function (result) {
          if (result && result.error) {
            say(window.ValhallaSupabase.providerMessage(result.error));
            unlock();
          }
        }).catch(function (error) {
          say(window.ValhallaSupabase.providerMessage(error));
          unlock();
        });
      });
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        if (busy) return;
        var address = email.value.trim();
        if (!address) return;
        busy = true;
        google.disabled = true;
        say('Sending the sign-in link…');
        supabase.auth.signInWithOtp({
          email: address,
          options: { emailRedirectTo: window.ValhallaSupabase.osReturnTo() }
        }).then(function (result) {
          if (result && result.error) say(window.ValhallaSupabase.providerMessage(result.error));
          else say('Check your email for the sign-in link.');
          unlock();
        }).catch(function (error) {
          say(window.ValhallaSupabase.providerMessage(error));
          unlock();
        });
      });
    });
  }).catch(function (error) {
    say(window.ValhallaSupabase.providerMessage(error));
    google.disabled = true;
  });
})();
