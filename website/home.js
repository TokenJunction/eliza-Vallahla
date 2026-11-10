(function () {
  var status = document.getElementById('auth-status');
  var google = document.getElementById('google-sign-in');
  var form = document.getElementById('magic-link');
  var email = document.getElementById('magic-email');
  if (!status || !google || !form || !email || !window.ValhallaSupabase) return;

  function say(text) {
    status.textContent = text;
  }

  if (!window.ValhallaSupabase.config()) {
    say('Sign-in is not configured yet.');
    google.disabled = true;
    return;
  }

  google.addEventListener('click', function () {
    say('Opening Google…');
    window.ValhallaSupabase.client().then(function (supabase) {
      return supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.ValhallaSupabase.osReturnTo() }
      });
    }).then(function (result) {
      if (result && result.error) say(window.ValhallaSupabase.providerMessage(result.error));
    }).catch(function (error) {
      say(window.ValhallaSupabase.providerMessage(error));
    });
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var address = email.value.trim();
    if (!address) return;
    say('Sending the sign-in link…');
    window.ValhallaSupabase.client().then(function (supabase) {
      return supabase.auth.signInWithOtp({
        email: address,
        options: { emailRedirectTo: window.ValhallaSupabase.osReturnTo() }
      });
    }).then(function (result) {
      if (result && result.error) say(window.ValhallaSupabase.providerMessage(result.error));
      else say('Check your email for the sign-in link.');
    }).catch(function (error) {
      say(window.ValhallaSupabase.providerMessage(error));
    });
  });
})();
