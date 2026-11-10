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
    var routes = [
      ['status', /\b(system status|status window|health probe)\b|\bopen status\b/],
      ['wallet', /\b(open|show)\b[^.]{0,40}\bwallet\b|\bwallet window\b/],
      ['memory', /\bmemory\b/],
      ['browser', /\b(web shell|browser)\b|\bopen web\b/],
      ['swarm', /\b(monitor|swarm)\b/],
      ['tools', /\b(tools menu|start menu|open tools)\b/]
    ];
    for (var i = 0; i < routes.length; i += 1) {
      if (routes[i][1].test(q)) return routes[i][0];
    }
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
      return { handled: true, open: 'tools', answer: 'Opening Tools. Choose Status, Wallet, Memory, Web, or Monitor from the menu.' };
    }
    if (destination) {
      return { handled: true, open: destination, answer: 'Opening ' + destination + '. If that panel has no feed, it stays not connected. No transaction is requested.' };
    }
    if (/\b(market|hardware|cpu|gpu)\b/.test(q)) {
      return { handled: true, answer: 'Market and hardware are not connected. No price, volume, or vital is available from this workstation.' };
    }
    if (/\bsign in\b|\baccount gate\b|\bhuman check\b/.test(q)) {
      return { handled: true, answer: 'Sign-in starts on the Citadel entrance, then the human check. This workstation does not complete sign-in. Use Account to open the gate.' };
    }
    if (/c8sm|\$5\.58|owner wallet|which wallet|wallet balance/.test(q)) {
      return { handled: true, blocked: true, answer: 'The only wallet I will acknowledge ends in …' + OWNER_LAST4 + '. The balance to use is ' + OWNER_BALANCE + '. This desk is not connected to that wallet and will not request a transaction.' };
    }
    if (/\bpaper\b/.test(q)) {
      return { handled: true, blocked: true, answer: 'Paper tools are a side desk, not the workstation. Live trading is off. No transaction or signature is requested.' };
    }
    if (/\b(buy|swap|sell|trade|broadcast|sign)\b/.test(q)) {
      return { handled: true, blocked: true, answer: 'Live trading is off. This desk will not request a transaction or signature. Stand down.' };
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
