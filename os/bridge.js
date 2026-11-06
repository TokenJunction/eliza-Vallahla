'use strict';

(function () {
  var status = document.getElementById('wallet-status');
  var overview = document.getElementById('overview-wallet');
  var detail = document.getElementById('overview-wallet-detail');
  var disconnect = document.getElementById('wallet-disconnect');
  var walletButtons = Array.prototype.slice.call(document.querySelectorAll('[data-wallet]'));
  var active = null;
  var listeners = [];
  var busy = false;

  function removeListeners() {
    listeners.forEach(function (item) {
      if (typeof item.provider.removeListener === 'function') {
        item.provider.removeListener(item.event, item.handler);
      }
    });
    listeners = [];
  }

  function clearWallet(message) {
    removeListeners();
    active = null;
    overview.textContent = 'Not connected';
    detail.textContent = 'Connect a wallet to view its public address.';
    status.textContent = message || 'No wallet connected.';
    disconnect.hidden = true;
  }

  function showWallet(name, address) {
    overview.textContent = name + ' connected';
    detail.textContent = address;
    status.textContent = name + ' connected: ' + address;
    disconnect.hidden = false;
  }

  function listen(provider, event, handler) {
    if (typeof provider.on !== 'function') return;
    provider.on(event, handler);
    listeners.push({ provider: provider, event: event, handler: handler });
  }

  function ethereumProvider() {
    var ethereum = window.ethereum;
    if (!ethereum) return null;
    if (Array.isArray(ethereum.providers)) {
      return ethereum.providers.find(function (provider) { return provider.isMetaMask === true; }) || null;
    }
    return ethereum.isMetaMask === true ? ethereum : null;
  }

  async function connect(name) {
    if (busy) return;
    var provider = name === 'solflare' ? window.solflare : ethereumProvider();
    if (!provider) {
      status.textContent = (name === 'solflare' ? 'Solflare' : 'MetaMask') + ' was not detected. Install or enable its browser extension, then try again.';
      return;
    }
    busy = true;
    walletButtons.forEach(function (button) { button.disabled = true; });
    status.textContent = 'Approve the connection in your wallet. No transaction or signature is requested.';
    try {
      var address;
      if (name === 'solflare') {
        var result = await provider.connect();
        address = String(result && result.publicKey || provider.publicKey || '');
      } else {
        var accounts = await provider.request({ method: 'eth_requestAccounts' });
        address = Array.isArray(accounts) ? String(accounts[0] || '') : '';
      }
      if (!address) throw new Error('The wallet returned no account.');
      removeListeners();
      active = { name: name, provider: provider };
      var displayName = name === 'solflare' ? 'Solflare' : 'MetaMask';
      showWallet(displayName, address);
      listen(provider, 'disconnect', function () { clearWallet('Wallet disconnected.'); });
      listen(provider, name === 'solflare' ? 'accountChanged' : 'accountsChanged', function (accounts) {
        var next = name === 'solflare' ? String(accounts || '') : String(Array.isArray(accounts) && accounts[0] || '');
        if (next) showWallet(displayName, next);
        else clearWallet('Wallet account is no longer available.');
      });
    } catch (error) {
      status.textContent = 'Connection was not completed. ' + (error && error.code === 4001 ? 'The wallet request was declined.' : 'Check your wallet and try again.');
    } finally {
      busy = false;
      walletButtons.forEach(function (button) { button.disabled = false; });
    }
  }

  walletButtons.forEach(function (button) {
    button.addEventListener('click', function () { void connect(button.dataset.wallet); });
  });
  disconnect.addEventListener('click', async function () {
    var previous = active;
    if (!previous) return;
    if (previous.name === 'solflare' && typeof previous.provider.disconnect === 'function') {
      try {
        await previous.provider.disconnect();
      } catch {
        status.textContent = 'Could not disconnect Solflare. Try disconnecting in your wallet.';
        return;
      }
      clearWallet('Solflare disconnected.');
      return;
    }
    clearWallet('Removed from this desk. To revoke access, disconnect this site in MetaMask.');
  });

  var form = document.getElementById('chat-form');
  var input = document.getElementById('chat-input');
  var log = document.getElementById('chat-log');
  var chatStatus = document.getElementById('chat-status');
  var voiceButton = document.getElementById('chat-voice');
  var history = [];
  var submitting = false;
  var voiceEnabled = false;
  var taskId = "";
  var listening = false;
  var recognition = null;

  if (!window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== 'function') {
    voiceButton.disabled = true;
    voiceButton.textContent = 'Voice replies unavailable';
  }
  voiceButton.addEventListener('click', function () {
    voiceEnabled = !voiceEnabled;
    voiceButton.setAttribute('aria-pressed', String(voiceEnabled));
    voiceButton.textContent = voiceEnabled ? 'Voice replies on' : 'Voice replies off';
    if (!voiceEnabled) window.speechSynthesis.cancel();
  });

  function secretLike(text) {
    var words = text.trim().toLowerCase().split(/\s+/);
    return (words.length >= 12 && words.length <= 24 && words.every(function (word) {
      return /^[a-z]+$/.test(word);
    })) || /[1-9A-HJ-NP-Za-km-z]{64,}/.test(text);
  }

  function message(label, text) {
    var row = document.createElement('p');
    var author = document.createElement('strong');
    author.textContent = label;
    row.appendChild(author);
    row.appendChild(document.createElement('br'));
    row.appendChild(document.createTextNode(text));
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (submitting) return;
    var text = input.value.trim();
    if (!text) return;
    if (secretLike(text)) {
      chatStatus.textContent = 'Do not share a seed phrase or private key. Your message was not sent.';
      return;
    }
    submitting = true;
    form.querySelector('button').disabled = true;
    chatStatus.textContent = 'Waiting for the command service…';
    var controller = new AbortController();
    var timeout = window.setTimeout(function () { controller.abort(); }, 145000);
    try {
      var access = await import('/valhalla/access.js');
      var response = await fetch('/api/v1/tasks', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(access.commandPayload(text)),
        signal: controller.signal
      });
      var body = await response.json();
      var reply = access.replyText(body);
      if (!reply) {
        chatStatus.textContent = 'Command unavailable. No reply was returned.';
        return;
      }
      taskId = typeof body.taskId === 'string' ? body.taskId : '';
      message('YOU', text);
      message('COMMAND', reply);
      input.value = '';
      var speechFailed = false;
      if (voiceEnabled) {
        try {
          window.speechSynthesis.cancel();
          window.speechSynthesis.speak(new window.SpeechSynthesisUtterance(reply));
        } catch (error) {
          speechFailed = true;
          voiceEnabled = false;
          voiceButton.setAttribute('aria-pressed', 'false');
          voiceButton.textContent = 'Voice replies off';
          chatStatus.textContent = 'Reply received, but browser speech failed. Try voice again.';
        }
      }
      history.push({ role: 'user', content: text }, { role: 'assistant', content: reply.slice(0, 500) });
      history = history.slice(-8);
      if (!speechFailed) chatStatus.textContent = 'Never share a seed phrase or private key. Not financial advice.';
    } catch (error) {
      chatStatus.textContent = error.name === 'AbortError' ? 'Chat timed out. Please try again.' : 'Chat unavailable: ' + (error.message || 'Please try again.');
    } finally {
      window.clearTimeout(timeout);
      submitting = false;
      form.querySelector('button').disabled = false;
      input.disabled = false;
      input.focus();
    }
  });

  document.getElementById('chat-stop').addEventListener('click', async function () {
    if (!taskId) {
      chatStatus.textContent = 'No task to stop.';
      return;
    }
    if (!window.confirm('Stop this command?')) return;
    chatStatus.textContent = 'Stop requested';
    try {
      var response = await fetch('/api/v1/tasks/stop', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: taskId })
      });
      var body = await response.json();
      chatStatus.textContent = response.ok && body && body.ok === true
        ? 'Stop completed.'
        : 'Stop was not confirmed.';
    } catch {
      chatStatus.textContent = 'Stop was not confirmed.';
    }
  });

  document.addEventListener('keydown', function (event) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      if (document.getElementById('desktop').hidden) return;
      event.preventDefault();
      input.focus();
    }
  });

  var transcript = document.getElementById('chat-transcript');
  var listenButton = document.getElementById('chat-listen');
  var listenStatus = document.getElementById('listen-status');
  var SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    listenButton.disabled = true;
    listenStatus.textContent = 'Speech recognition is not supported.';
  } else {
    recognition = new SpeechRec();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = function (event) {
      var said = event.results && event.results[0] && event.results[0][0]
        ? event.results[0][0].transcript
        : '';
      transcript.value = said;
      listenStatus.textContent = 'Transcript ready. Edit it, then use it. Nothing was sent.';
    };
    recognition.onerror = function () {
      listening = false;
      listenButton.textContent = 'Start listening';
      listenStatus.textContent = 'Speech recognition failed. Nothing was sent.';
    };
    recognition.onend = function () {
      listening = false;
      listenButton.textContent = 'Start listening';
    };
    listenButton.addEventListener('click', function () {
      if (listening) {
        recognition.stop();
        return;
      }
      listening = true;
      listenButton.textContent = 'Stop listening';
      listenStatus.textContent = 'Listening. This does not send the form.';
      recognition.start();
    });
  }
  document.getElementById('use-transcript').addEventListener('click', function () {
    input.value = transcript.value;
    input.focus();
  });
})();
