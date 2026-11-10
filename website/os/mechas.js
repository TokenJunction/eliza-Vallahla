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

  var busy = false;
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (busy) return;
    var input = document.getElementById('mecha-task');
    var task = input && input.value.trim();
    if (!task) return;
    var words = task.toLowerCase().split(/\s+/);
    var phrase = words.length >= 12 && words.length <= 24 && words.every(function (word) { return /^[a-z]+$/.test(word); });
    if (phrase || /[1-9A-HJ-NP-Za-km-z]{64,}/.test(task)) {
      say('Do not share a seed phrase or private key.');
      return;
    }
    busy = true;
    if (input) input.disabled = true;
    function unlock() {
      busy = false;
      if (input) input.disabled = false;
    }
    send({ task: task }).then(function (body) {
      if (!body) return;
      var reply = document.getElementById('mecha-reply');
      if (reply) reply.textContent = (body.mecha ? body.mecha + ': ' : '') + (body.reply || '');
      if (input) input.value = '';
    }).then(unlock, unlock);
  });
})();
