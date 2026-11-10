/* Original ValOS installer. SPDX-License-Identifier: MIT */
'use strict';
(function (root) {
  var ALLOWED = { window: true };

  function textOf(bytes) {
    return new TextDecoder().decode(bytes);
  }

  function secretPath(name) {
    var base = String(name || '').split('/').pop().toLowerCase();
    return base === '.env' || base.indexOf('.env') === 0 || base.endsWith('.pem') || base.endsWith('.key') || base.indexOf('private_key') !== -1;
  }

  function secretBytes(bytes) {
    var sample = textOf(bytes.subarray ? bytes.subarray(0, 160) : bytes.slice(0, 160));
    var head = sample.indexOf('BEGIN ');
    return head !== -1 && (sample.indexOf('PRIVATE KEY', head) !== -1);
  }

  async function inflate(bytes, format) {
    if (typeof DecompressionStream !== 'function') {
      return { ok: false, reason: 'This runtime cannot unpack compressed data. Use an uncompressed zip or tar. The pack was not installed.' };
    }
    try {
      var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
      var buffer = await new Response(stream).arrayBuffer();
      return { ok: true, bytes: new Uint8Array(buffer) };
    } catch (error) {
      return { ok: false, reason: 'Compressed data could not be read. The pack was not installed.' };
    }
  }

  function parseTar(bytes) {
    var files = {};
    var offset = 0;
    while (offset + 512 <= bytes.length) {
      var header = bytes.subarray(offset, offset + 512);
      var empty = true;
      for (var i = 0; i < 512; i += 1) if (header[i] !== 0) { empty = false; break; }
      if (empty) break;
      var nameBytes = header.subarray(0, 100);
      var name = textOf(nameBytes).replace(/\0+$/, '');
      var magic = textOf(header.subarray(257, 262));
      if (magic.indexOf('ustar') === 0) {
        var prefix = textOf(header.subarray(345, 500)).replace(/\0+$/, '');
        if (prefix) name = prefix + '/' + name;
      }
      var size = parseInt(textOf(header.subarray(124, 136)).replace(/\0.*/, '').trim() || '0', 8);
      if (!isFinite(size) || size < 0) return { ok: false, reason: 'Tar header was not readable. The pack was not installed.' };
      var typeflag = String.fromCharCode(header[156] || 48);
      offset += 512;
      var data = bytes.subarray(offset, offset + size);
      if (typeflag === '0' || typeflag === '\0') files[name.replace(/^\.\//, '')] = data;
      offset += Math.ceil(size / 512) * 512;
    }
    return { ok: true, files: files };
  }

  async function parseZip(bytes) {
    var files = {};
    var offset = 0;
    while (offset + 30 <= bytes.length) {
      if (bytes[offset] !== 0x50 || bytes[offset + 1] !== 0x4b || bytes[offset + 2] !== 0x03 || bytes[offset + 3] !== 0x04) break;
      var flags = bytes[offset + 6] | (bytes[offset + 7] << 8);
      var method = bytes[offset + 8] | (bytes[offset + 9] << 8);
      var compSize = bytes[offset + 18] | (bytes[offset + 19] << 8) | (bytes[offset + 20] << 16) | (bytes[offset + 21] << 24);
      var nameLen = bytes[offset + 26] | (bytes[offset + 27] << 8);
      var extraLen = bytes[offset + 28] | (bytes[offset + 29] << 8);
      if (flags & 0x8) return { ok: false, reason: 'Zip uses data descriptors. Re-pack as a stored zip or tar. The pack was not installed.' };
      var name = textOf(bytes.subarray(offset + 30, offset + 30 + nameLen));
      var start = offset + 30 + nameLen + extraLen;
      var payload = bytes.subarray(start, start + compSize);
      if (method === 0) files[name] = payload;
      else if (method === 8) {
        var unpacked = await inflate(payload, 'deflate-raw');
        if (!unpacked.ok) return unpacked;
        files[name] = unpacked.bytes;
      } else return { ok: false, reason: 'Zip method ' + method + ' is not supported. The pack was not installed.' };
      offset = start + compSize;
    }
    if (!Object.keys(files).length) return { ok: false, reason: 'No files were found in the zip. The pack was not installed.' };
    return { ok: true, files: files };
  }

  async function readPack(bytes, filename) {
    var name = String(filename || '').toLowerCase();
    var data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (name.endsWith('.gz') || name.endsWith('.tgz') || (data[0] === 0x1f && data[1] === 0x8b)) {
      var unpacked = await inflate(data, 'gzip');
      if (!unpacked.ok) return unpacked;
      data = unpacked.bytes;
      name = name.replace(/\.gz$|\.tgz$/, '.tar');
    }
    if (name.endsWith('.zip') || (data[0] === 0x50 && data[1] === 0x4b)) return parseZip(data);
    return parseTar(data);
  }

  async function installPack(bytes, filename) {
    var pack = await readPack(bytes, filename);
    if (!pack.ok) return pack;
    var files = pack.files;
    var paths = Object.keys(files);
    for (var i = 0; i < paths.length; i += 1) {
      if (secretPath(paths[i]) || secretBytes(files[paths[i]])) {
        return { ok: false, reason: 'Refused. The pack contains a secret file and was not installed.' };
      }
    }
    var manifestPath = '';
    var flatpakLike = false;
    for (var n = 0; n < paths.length; n += 1) {
      if (/(^|\/)valos-app\.json$/.test(paths[n])) manifestPath = paths[n];
      if (/flatpak|\.flatpakref$/i.test(paths[n]) || textOf(files[paths[n]]).indexOf('[Application]') !== -1) flatpakLike = true;
    }
    if (!manifestPath) {
      return {
        ok: false,
        reason: flatpakLike
          ? 'This archive has no ValOS app manifest. A Flatpak is not converted into a Bun app.'
          : 'No valos-app.json manifest. The pack was not installed.'
      };
    }
    var manifest;
    try { manifest = JSON.parse(textOf(files[manifestPath])); }
    catch (error) { return { ok: false, reason: 'valos-app.json is not valid JSON. The pack was not installed.' }; }
    if (!manifest || typeof manifest.name !== 'string' || typeof manifest.version !== 'string' || typeof manifest.entry !== 'string') {
      return { ok: false, reason: 'Manifest must include name, version, and entry. The pack was not installed.' };
    }
    if (manifest.entry.indexOf('..') !== -1 || manifest.entry.charAt(0) === '/') {
      return { ok: false, reason: 'Entry path is not allowed. The pack was not installed.' };
    }
    var prefix = manifestPath.slice(0, manifestPath.length - 'valos-app.json'.length);
    var entryPath = prefix + manifest.entry.replace(/^\.\//, '');
    if (!files[entryPath]) return { ok: false, reason: 'Manifest entry is missing. The pack was not installed.' };
    var permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
    for (var p = 0; p < permissions.length; p += 1) {
      if (!ALLOWED[permissions[p]]) return { ok: false, reason: 'Permission ' + permissions[p] + ' is not allowed. The pack was not installed.' };
    }
    var entryName = manifest.entry.toLowerCase();
    var bunOnly = entryName.endsWith('.js');
    if (!entryName.endsWith('.html') && !bunOnly) {
      return { ok: false, reason: 'Entry must be .html for the desk or .js for the local Bun helper. The pack was not installed.' };
    }
    return {
      ok: true,
      app: {
        name: manifest.name.slice(0, 40),
        version: String(manifest.version).slice(0, 20),
        entry: manifest.entry,
        html: bunOnly ? '' : textOf(files[entryPath]).slice(0, 50000),
        bunOnly: bunOnly
      },
      note: flatpakLike
        ? 'Installed the ValOS entry from this archive. The Flatpak itself was not converted into a Bun app.'
        : (bunOnly ? 'Recorded a Bun entry. The public desk will not run that script.' : 'Installed.')
    };
  }

  function remember(app) {
    var current = [];
    try { current = JSON.parse(localStorage.getItem('valhalla-apps-v1') || '[]'); } catch (error) { current = []; }
    if (!Array.isArray(current)) current = [];
    current = current.filter(function (item) { return item && item.name !== app.name; });
    current.push({ name: app.name, version: app.version, entry: app.entry, html: app.html, bunOnly: app.bunOnly });
    current = current.slice(-8);
    try { localStorage.setItem('valhalla-apps-v1', JSON.stringify(current)); } catch (error) { /* the desk still shows this result */ }
    return current;
  }

  function render(list) {
    var box = document.getElementById('install-list');
    if (!box) return;
    box.replaceChildren();
    (list || []).forEach(function (app) {
      var item = document.createElement('li');
      item.textContent = app.name + ' ' + app.version + (app.bunOnly ? ' · Bun entry, not run here' : ' · desk window');
      box.appendChild(item);
    });
  }

  async function installBytes(bytes, filename) {
    var status = document.getElementById('install-status');
    if (status) status.textContent = 'Checking ' + filename + '…';
    var result = await installPack(bytes, filename);
    if (!result.ok) {
      if (status) status.textContent = result.reason;
      return result;
    }
    var saved = remember(result.app);
    render(saved);
    var frame = document.getElementById('install-preview');
    if (frame) {
      if (result.app.html) {
        frame.hidden = false;
        frame.srcdoc = result.app.html;
      } else {
        frame.hidden = true;
        frame.srcdoc = '';
      }
    }
    if (status) status.textContent = result.note + ' ' + result.app.name + ' ' + result.app.version + '.';
    return result;
  }

  async function installUrl(url) {
    var response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      var status = document.getElementById('install-status');
      if (status) status.textContent = 'Pack download failed. HTTP ' + response.status + '. Nothing was installed.';
      return { ok: false, reason: 'download ' + response.status };
    }
    var bytes = new Uint8Array(await response.arrayBuffer());
    return installBytes(bytes, url.split('/').pop());
  }

  root.ValhallaInstaller = { installPack: installPack, installBytes: installBytes, installUrl: installUrl };

  function bind() {
    var file = document.getElementById('install-file');
    if (file) file.addEventListener('change', function () {
      var chosen = file.files && file.files[0];
      if (!chosen) return;
      chosen.arrayBuffer().then(function (buffer) { return installBytes(new Uint8Array(buffer), chosen.name); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-install-sample]'), function (button) {
      button.addEventListener('click', function () { installUrl(button.getAttribute('data-install-sample')); });
    });
  }
  if (typeof document !== 'undefined' && document.getElementById && document.getElementById('install-file')) bind();
})(typeof window !== 'undefined' ? window : globalThis);
