(function (root) {
  var KNOWN = [
    { id: "phantom", name: "Phantom", install: "https://phantom.app/download", color: "#ab9ff2" },
    { id: "solflare", name: "Solflare", install: "https://solflare.com/download", color: "#ffb347" },
    { id: "backpack", name: "Backpack", install: "https://backpack.app/download", color: "#e33e3f" }
  ];
  var standard = [];

  window.addEventListener("wallet-standard:register-wallet", function (event) {
    if (event.detail && standard.indexOf(event.detail) < 0) standard.push(event.detail);
  });

  function injected(id) {
    if (id === "phantom") return window.phantom && window.phantom.solana;
    if (id === "solflare") return window.solflare || null;
    if (id === "backpack") return window.backpack || null;
    return null;
  }

  function rows() {
    var list = [];
    KNOWN.forEach(function (item) {
      var named = root.ValhallaConnect.pickNamed(standard, item.id);
      var provider = injected(item.id);
      if (named || provider) list.push({ item: item, named: named, provider: provider });
    });
    standard.forEach(function (wallet) {
      var name = String(wallet.name || "Wallet");
      var known = KNOWN.some(function (item) { return item.name.toLowerCase() === name.toLowerCase(); });
      if (!known) list.push({ item: { id: "other", name: name, install: "", color: "#7a7468" }, named: wallet, provider: null });
    });
    return list;
  }

  function icon(color) {
    return '<svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="14" fill="' + color + '"/></svg>';
  }

  function toB64(bytes) {
    var raw = "";
    for (var i = 0; i < bytes.length; i += 1) raw += String.fromCharCode(bytes[i]);
    return btoa(raw);
  }

  function tellExtension(payload) {
    var ext = new URLSearchParams(location.search).get("ext");
    window.postMessage(payload, location.origin);
    if (ext && window.chrome && chrome.runtime && chrome.runtime.sendMessage) chrome.runtime.sendMessage(ext, payload, function () {});
  }

  function paintChip(pubkey) {
    var slot = document.getElementById("walletChip");
    if (!slot) return;
    slot.hidden = false;
    slot.textContent = "";
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = "…" + String(pubkey).slice(-4);
    var menu = document.createElement("div");
    menu.hidden = true;
    var copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy address";
    copy.addEventListener("click", function () { if (navigator.clipboard) navigator.clipboard.writeText(pubkey); });
    var view = document.createElement("a");
    view.href = "/app/";
    view.textContent = "View balances";
    var bye = document.createElement("button");
    bye.type = "button";
    bye.textContent = "Disconnect";
    bye.addEventListener("click", function () {
      localStorage.removeItem("valhalla-watch");
      sessionStorage.removeItem("valhalla-siws");
      slot.hidden = true;
      var connect = document.getElementById("connectBtn");
      if (connect) connect.hidden = false;
    });
    menu.appendChild(copy);
    menu.appendChild(view);
    menu.appendChild(bye);
    button.addEventListener("click", function () { menu.hidden = !menu.hidden; });
    slot.appendChild(button);
    slot.appendChild(menu);
    var connectBtn = document.getElementById("connectBtn");
    if (connectBtn) connectBtn.hidden = true;
    var tail = document.getElementById("ownTail");
    if (tail) tail.textContent = "…" + String(pubkey).slice(-4);
  }

  function openModal() {
    var modal = document.getElementById("walletModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "walletModal";
      modal.className = "modal";
      modal.innerHTML = '<div class="sheet" role="dialog" aria-labelledby="walletTitle"><h2 id="walletTitle">Connect a wallet</h2><p class="note">Your own wallet opens next. It asks you to approve the connection, then to sign in to Valhalla™. Nothing is paid on this step. Valhalla™ never asks for a seed phrase.</p><div id="detected"></div><div id="missing"></div><button type="button" id="closeModal">Close</button></div>';
      document.body.appendChild(modal);
      modal.addEventListener("click", function (event) { if (event.target === modal) modal.hidden = true; });
      modal.querySelector("#closeModal").addEventListener("click", function () { modal.hidden = true; });
    }
    var detected = modal.querySelector("#detected");
    var absent = modal.querySelector("#missing");
    detected.innerHTML = "";
    absent.innerHTML = "";
    var seen = {};
    rows().forEach(function (row) {
      seen[row.item.id] = true;
      var button = document.createElement("button");
      button.type = "button";
      button.className = "wallet";
      button.innerHTML = icon(row.item.color) + "<span>" + row.item.name + '</span><span class="tag">Detected</span>';
      button.addEventListener("click", function () {
        signIn(row).catch(function (err) {
          var note = document.createElement("p");
          note.className = "note";
          note.textContent = err && err.message ? err.message : "The sign-in was not accepted.";
          detected.appendChild(note);
        });
      });
      detected.appendChild(button);
    });
    KNOWN.forEach(function (item) {
      if (seen[item.id]) return;
      var link = document.createElement("a");
      link.className = "wallet";
      link.href = item.install;
      link.innerHTML = icon(item.color) + "<span>Install " + item.name + "</span>";
      absent.appendChild(link);
    });
    var form = document.createElement("form");
    form.innerHTML = '<label class="note">Paste a Solana address <input id="pasteKey" autocomplete="off" spellcheck="false"></label> <button type="submit">Save address</button><p id="pasteErr" class="note"></p>';
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var value = form.querySelector("#pasteKey").value.trim();
      if (!root.ValhallaConnect.isPubkey(value)) {
        form.querySelector("#pasteErr").textContent = "That is not a Solana address.";
        return;
      }
      localStorage.setItem("valhalla-watch", value);
      tellExtension({ source: "valhalla-connect", type: "watch", pubkey: value, signature: "", message: "" });
      location.href = "/app/";
    });
    absent.appendChild(form);
    modal.hidden = false;
  }

  function signIn(row) {
    var adapterPromise = row.named
      ? root.ValhallaConnect.adapterFromStandard(row.named)
      : root.ValhallaConnect.adapterFromInjected(row.provider, row.item.name);
    return adapterPromise.then(function (adapter) {
      if (!adapter) throw new Error(row.item.name + " is not available in this tab.");
      var now = Date.now();
      return root.ValhallaConnect.signInWithAdapter(adapter, root.nacl, {
        domain: location.host,
        nonce: crypto.randomUUID(),
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 5 * 60 * 1000).toISOString()
      });
    }).then(function (proof) {
      var packed = root.ValhallaConnect.handoff(proof, toB64(proof.signature));
      sessionStorage.setItem("valhalla-siws", JSON.stringify({ pubkey: packed.pubkey, message: packed.message, signature: packed.signature }));
      localStorage.setItem("valhalla-watch", packed.pubkey);
      tellExtension(packed);
      var modal = document.getElementById("walletModal");
      if (modal) modal.hidden = true;
      paintChip(packed.pubkey);
      return packed;
    });
  }

  function eager() {
    var watch = localStorage.getItem("valhalla-watch");
    if (watch && root.ValhallaConnect.isPubkey(watch)) paintChip(watch);
    rows().forEach(function (row) {
      try {
        if (row.provider && row.provider.connect) row.provider.connect({ onlyIfTrusted: true }).catch(function () {});
        else if (row.named && row.named.features["standard:connect"]) row.named.features["standard:connect"].connect({ silent: true }).catch(function () {});
      } catch (err) {
        /* The wallet is not already approved. */
      }
    });
  }

  root.ValhallaSite = { openModal: openModal, signIn: signIn };

  function boot() {
    window.dispatchEvent(new Event("wallet-standard:app-ready"));
    if (/\/connect\/?$/.test(location.pathname)) openModal();
    eager();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(typeof globalThis !== "undefined" ? globalThis : this);
