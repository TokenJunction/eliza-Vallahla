/* Original ValOS pretest. SPDX-License-Identifier: MIT */
'use strict';
(function (root) {
  function decidePatch(docVersion, fetchedVersion, alreadyReloaded) {
    if (!fetchedVersion) return { action: 'fail', reason: 'No version marker in the fetched desk.' };
    if (docVersion === fetchedVersion) return { action: 'stay', reason: 'This page matches the fetched desk ' + docVersion + '. No newer patch.' };
    if (alreadyReloaded) return { action: 'fail', reason: 'Newer marker ' + fetchedVersion + ' did not replace this page (' + docVersion + ').' };
    return { action: 'reload', reason: 'Fetched desk ' + fetchedVersion + ' is newer than this page ' + docVersion + '. Reloading.' };
  }

  function versionFrom(html) {
    var match = String(html || '').match(/name="valhalla-desk-version" content="([^"]+)"/);
    return match ? match[1] : '';
  }

  async function run(options) {
    options = options || {};
    var list = document.getElementById('pretest-list');
    var result = document.getElementById('pretest-result');
    var retry = document.getElementById('pretest-retry');
    var overlay = document.getElementById('os-pretest');
    if (list) list.replaceChildren();
    var failed = [];
    function row(name, ok, detail) {
      if (!list) return;
      var item = document.createElement('li');
      item.dataset.pass = ok ? 'yes' : 'no';
      item.textContent = (ok ? 'Pass' : 'Fail') + ' · ' + name + ' · ' + detail;
      list.appendChild(item);
    }
    async function hit(url) {
      var response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
      var body = response.ok ? await response.text() : '';
      return { ok: response.ok, status: response.status, text: body };
    }
    var pages = {};
    var paths = ['/', '/os/', '/volos/', '/app/'];
    for (var i = 0; i < paths.length; i += 1) {
      try {
        pages[paths[i]] = await hit(paths[i]);
        row(paths[i], pages[paths[i]].ok, 'HTTP ' + pages[paths[i]].status);
        if (!pages[paths[i]].ok) failed.push(paths[i] + ' HTTP ' + pages[paths[i]].status);
      } catch (error) {
        row(paths[i], false, 'not reachable');
        failed.push(paths[i] + ' not reachable');
      }
    }
    var assetUrl = options.missingAsset ? '/os/missing-pretest-asset' : '/assets/mark.svg';
    try {
      var asset = await fetch(assetUrl, { cache: 'no-store', credentials: 'same-origin' });
      row('required file', asset.ok, assetUrl + ' HTTP ' + asset.status);
      if (!asset.ok) failed.push(assetUrl + ' HTTP ' + asset.status);
    } catch (error) {
      row('required file', false, 'not reachable');
      failed.push('required file not reachable');
    }
    var meta = document.querySelector('meta[name="valhalla-desk-version"]');
    var docVersion = meta && meta.content ? meta.content : '';
    var fetchedHtml = pages['/os/'] && pages['/os/'].text || '';
    if (options.patchProbe) {
      try {
        var probe = await hit('/os/patch-probe.html');
        fetchedHtml = probe.text || '';
        row('patch marker', probe.ok, 'HTTP ' + probe.status);
        if (!probe.ok) failed.push('patch marker HTTP ' + probe.status);
      } catch (error) {
        row('patch marker', false, 'not reachable');
        failed.push('patch marker not reachable');
      }
    }
    var already = false;
    try { already = sessionStorage.getItem('valhalla-patch-reload') === '1'; } catch (error) { already = false; }
    var decision = decidePatch(docVersion, versionFrom(fetchedHtml), already);
    row('version', decision.action === 'stay', decision.reason);
    if (decision.action === 'reload') {
      try { sessionStorage.setItem('valhalla-patch-reload', '1'); } catch (error) { /* still reload */ }
      if (result) result.textContent = decision.reason;
      if (overlay) overlay.dataset.state = 'reload';
      window.location.replace(window.location.pathname);
      return { ok: false, reloading: true, decision: decision };
    }
    if (decision.action === 'fail') failed.push(decision.reason);
    try {
      var shell = await fetch('/valos-shell.json', { cache: 'no-store', credentials: 'same-origin' });
      if (shell.status === 404) row('Bun helper', true, 'not part of this static copy');
      else if (shell.ok) {
        var body = await shell.json();
        var present = Boolean(body && body.bun === true);
        row('Bun helper', present, present ? 'local helper answered' : 'helper did not confirm Bun');
        if (!present) failed.push('Bun helper did not confirm it is running');
      } else {
        row('Bun helper', false, 'HTTP ' + shell.status);
        failed.push('Bun helper HTTP ' + shell.status);
      }
    } catch (error) {
      row('Bun helper', false, 'not reachable');
      failed.push('Bun helper not reachable');
    }
    var gateText = pages['/app/'] && pages['/app/'].text || '';
    var gate = gateText.indexOf('HUMAN CHECK') !== -1;
    row('sign-in gate', gate, gate ? 'human check is on /app/' : 'human check was not in /app/');
    if (pages['/app/'] && pages['/app/'].ok && !gate) failed.push('sign-in gate missing human check');
    var volosText = pages['/volos/'] && pages['/volos/'].text || '';
    var unpublished = volosText.indexOf('Not published') !== -1;
    row('volOS', unpublished, unpublished ? 'unpublished' : 'pre-launch copy did not say unpublished');
    if (pages['/volos/'] && pages['/volos/'].ok && !unpublished) failed.push('volOS page did not say unpublished');
    if (failed.length) {
      if (result) result.textContent = 'Pretest failed. ' + failed[0];
      if (retry) retry.hidden = false;
      if (overlay) overlay.dataset.state = 'failed';
      return { ok: false, failed: failed, decision: decision };
    }
    try { localStorage.setItem('valhalla-desk-version', docVersion); } catch (error) { /* version still shown */ }
    if (result) result.textContent = 'Pretest passed. ' + decision.reason;
    if (overlay) {
      overlay.hidden = true;
      overlay.dataset.state = 'passed';
    }
    var desk = document.getElementById('desktop');
    if (desk) desk.removeAttribute('aria-hidden');
    return { ok: true, version: docVersion, decision: decision };
  }

  function boot() {
    var desk = document.getElementById('desktop');
    if (desk) desk.setAttribute('aria-hidden', 'true');
    var params = new URLSearchParams(window.location.search);
    var options = { missingAsset: params.get('pretest') === 'missing', patchProbe: params.get('patchcheck') === '1' };
    run(options);
    var retry = document.getElementById('pretest-retry');
    if (retry) retry.addEventListener('click', function () { run(options); });
  }

  root.ValhallaPretest = { decidePatch: decidePatch, versionFrom: versionFrom, run: run };
  if (typeof document !== 'undefined' && document.getElementById && document.getElementById('os-pretest')) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
