'use strict';
(function (root) {
  var OWNER_LAST4 = 'C8sm';
  var OWNER_BALANCE = '$5.58';

  function maskAddress(address) {
    var text = String(address || '').trim();
    if (text.length < 4) return '…';
    return '…' + text.slice(-4);
  }

  function rulesForModel() {
    return [
      'You are the ValhallaOS workstation copilot. Help with windows, status, and tools. Be clear and calm.',
      'Live trading is off. Do not request a transaction or signature.',
      'volOS is unpublished. Do not invent a mint, a pump.fun URL, or a price.',
      'The only wallet to acknowledge ends in …' + OWNER_LAST4 + ' and the balance to use is ' + OWNER_BALANCE + '.',
      'Show addresses by the last four characters only.',
      'If a feed is missing, say not connected or no reply.'
    ].join(' ');
  }

  function screenReply(text) {
    var value = String(text || '');
    var bannedFigure = /14\.85|2,?884(?:\.61)?/.test(value);
    var invented = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/.test(value) || /pump\.fun\/[A-Za-z0-9]+/i.test(value);
    var liveClaim = /live trading is on|will pump|trading is live/i.test(value);
    if (!bannedFigure && !invented && !liveClaim) return { ok: true, text: value };
    return {
      ok: false,
      inventedContract: invented,
      claimedLive: liveClaim || bannedFigure,
      text: 'That reply is not verified. volOS is unpublished, live trading is off, and I will stand down instead of repeating an unverified balance, contract, or live claim.'
    };
  }

  function navigation(q) {
    function named(noun) {
      return new RegExp('\\b(open|show|launch)\\b[^.]{0,48}\\b' + noun + '\\b|\\b' + noun + ' window\\b').test(q);
    }
    if (named('status') || /\b(system status|status window|health probe)\b/.test(q)) return 'status';
    if (named('wallet') || /\bwallet window\b/.test(q)) return 'wallet';
    if (named('memory') || /\bmemory window\b/.test(q)) return 'memory';
    if ((named('browser') || named('web') || /\bweb shell\b/.test(q)) && /\b(open|show|launch)\b/.test(q)) return 'browser';
    if (named('monitor') || named('swarm') || /\bmonitor window\b/.test(q)) return 'swarm';
    if (named('installer') || named('install')) return 'installer';
    if (named('settings') || named('node') || /\bnode window\b/.test(q)) return 'settings';
    if (named('tools') || /\b(tools menu|start menu)\b/.test(q)) return 'tools';
    if (named('volos') || named('coin') || (/\bcoin station\b/.test(q) && /\b(open|show|launch)\b/.test(q))) return 'volos';
    return '';
  }

  function prepare(text) {
    var raw = String(text || '').trim();
    var q = raw.toLowerCase();
    if (!raw) return { handled: false };
    if (/\b(seed phrase|mnemonic|private key|secret key)\b/i.test(raw)) {
      return { handled: true, blocked: true, answer: 'That message was not sent. Stand down. This desk does not accept wallet recovery material.' };
    }
    if (/14\.85|2,?884/.test(raw)) {
      return { handled: true, blocked: true, answer: 'That figure is not one I will acknowledge. The only wallet to use ends in …' + OWNER_LAST4 + ', and the balance to use is ' + OWNER_BALANCE + '. Stand down on any other balance.' };
    }
    if (/volos|\bvalos\b|\$valos/.test(q) && /contract|mint|address|pump|price|pool/.test(q)) {
      return { handled: true, blocked: true, answer: 'volOS is unpublished. No contract is verified yet, so I will stand down on a mint address.' };
    }
    var destination = navigation(q);
    if (destination === 'tools') {
      return { handled: true, open: 'tools', evidence: ['Tools menu'], answer: 'Opening Tools. Choose Status, Wallet, Memory, Web, Monitor, Installer, or Settings. Feeds that are missing stay not connected.' };
    }
    if (destination) {
      var label = { swarm: 'Monitor', browser: 'Web', settings: 'Settings', installer: 'Installer', volos: 'volOS' }[destination] || destination;
      return { handled: true, open: destination, evidence: ['dock ' + destination], answer: 'Opening ' + label + '. If that panel has no feed, it stays not connected. No transaction is requested.' };
    }
    if (/\b(market|hardware|cpu|gpu|cluster|tok\/s)\b/.test(q)) {
      return { handled: true, evidence: ['no hardware feed on this page'], answer: 'Market and hardware are not connected. No price, volume, cluster vital, or token rate is available from this workstation.' };
    }
    if (/\bsign[\s-]?in\b|\baccount gate\b|\bhuman check\b/.test(q)) {
      return { handled: true, evidence: ['Account control links to /app/'], answer: 'Sign-in starts on the Citadel entrance, then the human check at /app/. This workstation does not complete sign-in. Use Account to open the gate.' };
    }
    if (/\b(laptop|full-time|node label|desk version)\b/.test(q)) {
      return { handled: true, open: 'settings', evidence: ['local node label only'], answer: 'The node label is local to this window: laptop or full-time. Other nodes are not connected. Settings checks whether this desk copy is reachable. A failed check is not reported as live. No vendor model is running on this page.' };
    }
    if (/c8sm|\$5\.58|owner wallet|which wallet|wallet balance/.test(q)) {
      return { handled: true, blocked: true, evidence: ['owner note, not a connected wallet'], answer: 'The only wallet I will acknowledge ends in …' + OWNER_LAST4 + '. The balance to use is ' + OWNER_BALANCE + '. This desk is not connected to that wallet and will not request a transaction.' };
    }
    if (/\bpaper\b/.test(q)) {
      return { handled: true, blocked: true, evidence: ['LIVE_TRADING is false'], answer: 'Paper tools are a side desk, not the workstation. Live trading is off. No transaction or signature is requested.' };
    }
    var tradeOff = /\btrade-offs?\b/.test(q);
    var signIn = /\bsign[\s-]?in\b/.test(q);
    if (!tradeOff && !signIn && (/\b(buy|swap|sell|broadcast)\b/.test(q) || /\btrades?\b/.test(q) || /\bsign\b/.test(q))) {
      return { handled: true, blocked: true, evidence: ['live trading flag is off'], answer: 'Live trading is off. This desk will not request a transaction or signature. Stand down.' };
    }
    return { handled: false, rules: rulesForModel() };
  }

  function review(log) {
    var scorer = root.ValhallaQuality && root.ValhallaQuality.scoreQualityMatrix;
    if (typeof scorer !== 'function') {
      return { reward: -1, patch: 'Quality critic is not connected. Stand down and do not apply any change.', axes: {} };
    }
    return scorer(log || {});
  }

  root.ValhallaOverseer = {
    maskAddress: maskAddress,
    rulesForModel: rulesForModel,
    prepare: prepare,
    screenReply: screenReply,
    review: review,
    ownerLast4: OWNER_LAST4,
    ownerBalance: OWNER_BALANCE
  };
})(typeof window !== 'undefined' ? window : globalThis);
