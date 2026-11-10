(function () {
  var status = document.getElementById('mecha-status');
  var list = document.getElementById('mecha-list');
  var form = document.getElementById('mecha-form');
  if (!form) return;

  function say(text) { if (status) status.textContent = text; }

  async function send(body) {
    if (!window.ValhallaSupabase) { say('Sign-in required.'); return null; }
    var supabase = await window.ValhallaSupabase.client();
    var session = await supabase.auth.getSession();
    var token = session && session.data && session.data.session && session.data.session.access_token;
    if (!token) { say('Sign-in required.'); return null; }
    var response = await fetch('/api/mechas', {
      method: body ? 'POST' : 'GET',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    var payload = {};
    try { payload = await response.json(); } catch (error) { payload = {}; }
    if (!response.ok) { say(payload.error || 'The Mechas are offline.'); return null; }
    return payload;
  }

  function show(body) {
    if (!body || !list) return;
    list.replaceChildren();
    (body.mechas || []).forEach(function (name) {
      var item = document.createElement('li');
      item.textContent = name;
      list.appendChild(item);
    });
    say((body.health && body.health.label) || 'Overseer not connected');
  }

  document.addEventListener('click', function (event) {
    var opener = event.target.closest && event.target.closest('[data-open="mechas"]');
    if (opener) send().then(show);
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var input = document.getElementById('mecha-task');
    var task = input && input.value;
    send({ task: task }).then(function (body) {
      if (!body) return;
      var reply = document.getElementById('mecha-reply');
      if (reply) reply.textContent = (body.mecha ? body.mecha + ': ' : '') + (body.reply || '');
      if (input) input.value = '';
    });
  });
})();
