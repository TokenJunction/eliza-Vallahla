(function () {
  var HUMAN_KEY = "valhalla-human";
  var SESSION_KEY = "valhalla-session";
  var HUMAN_MS = 30 * 60 * 1000;
  var cfg = window.VALHALLA_SITE || {};
  var RPC = "https://api.mainnet-beta.solana.com";
  var TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

  function show(id) {
    ["gateHuman", "gateAccount", "gateWallet", "desk"].forEach(function (name) {
      var node = document.getElementById(name);
      if (node) node.hidden = name !== id;
    });
  }

  function fresh(raw, maxAge) {
    try {
      var data = JSON.parse(raw || "null");
      if (!data || !data.at) return null;
      if (Date.now() - Number(data.at) > maxAge) return null;
      return data;
    } catch (err) {
      return null;
    }
  }

  var ACCOUNT_KEY = "valhalla-account";

  function readAccount() {
    try { return JSON.parse(localStorage.getItem(ACCOUNT_KEY) || "null"); } catch (err) { return null; }
  }

  function writeAccount(data) {
    data.at = Date.now();
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(data));
  }

  function markHuman() {
    sessionStorage.setItem(HUMAN_KEY, JSON.stringify({ ok: true, at: Date.now() }));
    show("gateAccount");
    mountAccount();
  }

  function keyReady(value) {
    return value && value.indexOf("NOT_SET") < 0;
  }

  function mountTurnstile() {
    var note = document.getElementById("humanNote");
    var placeholder = document.getElementById("humanPlaceholder");
    if (!keyReady(cfg.TURNSTILE_SITE_KEY)) {
      if (note) note.textContent = "Turnstile site key is not set. This human check is not live. The Worker secret is not in the site files.";
      if (placeholder) {
        placeholder.hidden = false;
        placeholder.addEventListener("click", markHuman);
      }
      return;
    }
    var script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.onload = function () {
      window.turnstile.render("#turnstile", {
        sitekey: cfg.TURNSTILE_SITE_KEY,
        appearance: "interaction-only",
        callback: function (token) {
          fetch(cfg.TURNSTILE_VERIFY_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: token })
          }).then(function (res) { return res.json(); }).then(function (body) {
            if (body && body.ok) markHuman();
            else if (note) note.textContent = "The human check was not confirmed.";
          }).catch(function () {
            if (note) note.textContent = "The verify route did not answer. Deploy the Worker at /api/verify.";
          });
        }
      });
    };
    document.head.appendChild(script);
  }

  function mountAccount() {
    var google = document.getElementById("googleBtn");
    var note = document.getElementById("accountNote");
    if (!keyReady(cfg.GOOGLE_CLIENT_ID)) {
      google.onclick = function () {
        note.textContent = "Google client ID is not set. Create an OAuth web client. Authorized JavaScript origin: https://valhalla-app.xyz. Paste the client ID into GOOGLE_CLIENT_ID.";
      };
    } else {
      google.hidden = true;
      var script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.onload = function () {
        window.google.accounts.id.initialize({
          client_id: cfg.GOOGLE_CLIENT_ID,
          callback: function (resp) {
            var part = String(resp.credential || "").split(".")[1] || "";
            var pad = part.replace(/-/g, "+").replace(/_/g, "/");
            while (pad.length % 4) pad += "=";
            var json = JSON.parse(atob(pad));
            var prior = readAccount() || {};
            writeAccount({ email: json.email || "", name: json.name || "", picture: json.picture || "", wallet: prior.wallet || "", agentUrl: prior.agentUrl || "", bot: prior.bot || null, riskAccepted: prior.riskAccepted === true });
            show("gateWallet");
            mountWallet();
          }
        });
        window.google.accounts.id.renderButton(document.getElementById("googleSlot"), { theme: "filled_black", size: "large", text: "continue_with", shape: "rectangular", width: 360 });
      };
      document.head.appendChild(script);
    }
    var form = document.getElementById("magicForm");
    if (form && !form.dataset.bound) {
      form.dataset.bound = "1";
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        var email = document.getElementById("magicEmail").value.trim();
        if (!cfg.MAGIC_LINK_URL) {
          note.textContent = "Email sign-in is not live. Deploy a Worker that emails a one-time link, then set MAGIC_LINK_URL. No message was sent.";
          return;
        }
        fetch(cfg.MAGIC_LINK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email }) })
          .then(function (res) { note.textContent = res.ok ? "Check your email for the sign-in link." : "The email link was not sent."; })
          .catch(function () { note.textContent = "The email link service did not answer."; });
      });
    }
  }

  function mountWallet() {
    var host = document.getElementById("loginButtons");
    if (window.ValhallaSite) window.ValhallaSite.mountButtons(host);
    var account = readAccount() || {};
    var onFile = document.getElementById("useOnFile");
    var note = document.getElementById("walletNote");
    if (account.wallet && window.ValhallaConnect.isPubkey(account.wallet)) {
      onFile.hidden = false;
      onFile.textContent = "Use my wallet on file …" + account.wallet.slice(-4);
      onFile.onclick = function () {
        window.__valhallaExpected = account.wallet;
        note.textContent = "Sign the login message with the wallet that ends in " + account.wallet.slice(-4) + ". The address on file is public only.";
      };
    }
  }

  function saveSession(data) {
    data.at = Date.now();
    localStorage.setItem(SESSION_KEY, JSON.stringify(data));
  }

  function drawFunnel() {
    var canvas = document.getElementById("net");
    if (!canvas) return;
    var tiers = [["elite", 48, "#00ff88"], ["good", 126, "#ff9a1f"], ["watch", 198, "#7a7468"], ["paused", 78, "#ff3b4a"]];
    var w = canvas.parentElement.clientWidth || 480;
    var h = 180;
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#07080c";
    ctx.fillRect(0, 0, w, h);
    tiers.forEach(function (tier, index) {
      var cx = ((index + 0.5) / tiers.length) * w;
      var cy = h * 0.48;
      ctx.fillStyle = tier[2] + "33";
      ctx.beginPath();
      ctx.arc(cx, cy, 28, 0, Math.PI * 2);
      ctx.fill();
      for (var n = 0; n < 36; n += 1) {
        var ang = n * 2.4;
        var rad = 10 + (n % 6) * 6;
        ctx.fillStyle = tier[2];
        ctx.fillRect(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad, 2, 2);
      }
    });
    document.getElementById("legend").textContent = tiers.map(function (tier) { return tier[0] + " " + tier[1]; }).join("   ");
    document.getElementById("stages").innerHTML = [["Scout", 120], ["Filter", 86], ["Analyst", 54], ["Copier", 17], ["Risk", 41]].map(function (row) {
      return '<div class="stage"><b>' + row[0].toUpperCase() + "</b><div>" + row[1] + " kills</div></div>";
    }).join("");
    document.getElementById("skips").innerHTML = [["liquidity floor", 64], ["breaker pause after 3 losses", 9], ["24h volume floor", 41], ["already pumped >80%", 28], ["max positions", 6], ["no pair", 33]].map(function (row) {
      return '<div class="kill"><span>' + row[1] + "</span><span>" + row[0] + "</span></div>";
    }).join("");
  }

  function deviceKeys() {
    try { return JSON.parse(localStorage.getItem("valhalla-device-keys") || "{}"); } catch (err) { return {}; }
  }

  function rpcUrl() {
    var custom = String(deviceKeys().rpc || "");
    if (custom.indexOf("https://") === 0) return custom;
    return RPC;
  }

  async function rpc(method, params) {
    var response = await fetch(rpcUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params })
    });
    var body = await response.json();
    if (!response.ok || body.error) throw new Error("lookup");
    return body.result;
  }

  async function birdeyePrice(mint, key) {
    var response = await fetch("https://public-api.birdeye.so/defi/price?address=" + encodeURIComponent(mint), {
      headers: { "X-API-KEY": key, "x-chain": "solana" }
    });
    if (!response.ok) return "";
    var body = await response.json();
    var value = body && body.data && body.data.value;
    return Number.isFinite(Number(value)) ? " · $" + Number(value).toFixed(4) : "";
  }

  async function balances(address) {
    var line = document.getElementById("solLine");
    var tokens = document.getElementById("tokenLines");
    var label = document.querySelector("#desk .sub");
    if (label) label.textContent = deviceKeys().birdeye ? "YOUR BALANCE · BIRDEYE + RPC" : "YOUR BALANCE · FREE RPC";
    try {
      var lamports = await rpc("getBalance", [address]);
      var sol = Number(lamports && lamports.value) / 1e9;
      line.textContent = (Number.isFinite(sol) ? sol.toFixed(4) : "0") + " SOL";
      var owned = await rpc("getTokenAccountsByOwner", [address, { programId: TOKEN_PROGRAM }, { encoding: "jsonParsed" }]);
      var rows = ((owned && owned.value) || []).slice(0, 6);
      var key = String(deviceKeys().birdeye || "");
      var html = "";
      for (var i = 0; i < rows.length; i += 1) {
        var info = rows[i].account && rows[i].account.data && rows[i].account.data.parsed && rows[i].account.data.parsed.info;
        var mint = info && info.mint ? String(info.mint) : "";
        var amount = info && info.tokenAmount && info.tokenAmount.uiAmountString ? info.tokenAmount.uiAmountString : "0";
        var price = "";
        if (key && mint) {
          try { price = await birdeyePrice(mint, key); } catch (err) { price = ""; }
        }
        html += "<div>…" + (mint ? mint.slice(-4) : "coin") + " " + amount + price + "</div>";
      }
      tokens.innerHTML = html;
    } catch (err) {
      line.textContent = "Balance did not load";
    }
  }

  function openDesk() {
    var session = fresh(localStorage.getItem(SESSION_KEY), 12 * 60 * 60 * 1000);
    if (!session) {
      show("gateChoice");
      return;
    }
    show("desk");
    drawFunnel();
    var who = document.getElementById("footWho");
    var avatar = document.getElementById("googleAvatar");
    var paste = document.getElementById("pasteForm");
    if (session.kind === "google") {
      who.textContent = session.name || "Google";
      if (session.picture) {
        avatar.hidden = false;
        avatar.src = session.picture;
        avatar.alt = "Google profile";
      }
      paste.hidden = false;
      document.getElementById("modeBadge").textContent = "READ ONLY";
    } else if (session.pubkey) {
      who.textContent = "…" + session.pubkey.slice(-4);
      if (window.ValhallaSite) {
        var chip = document.getElementById("walletChip");
        chip.hidden = false;
      }
      balances(session.pubkey);
      paintMenu(session.pubkey);
    }
    tick();
    window.setInterval(tick, 1000);
  }

  function tick() {
    var clock = document.getElementById("clock");
    if (!clock) return;
    clock.textContent = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  }

  function paintMenu(pubkey) {
    var slot = document.getElementById("walletChip");
    slot.hidden = false;
    slot.textContent = "";
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = "…" + pubkey.slice(-4);
    var menu = document.createElement("div");
    menu.className = "menu";
    menu.hidden = true;
    [["Copy address", function () { if (navigator.clipboard) navigator.clipboard.writeText(pubkey); }], ["Balances", function () { balances(pubkey); }], ["Disconnect", function () {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem("valhalla-watch");
      show("gateChoice");
    }]].forEach(function (item) {
      var node = document.createElement("button");
      node.type = "button";
      node.textContent = item[0];
      node.addEventListener("click", item[1]);
      menu.appendChild(node);
    });
    button.addEventListener("click", function () { menu.hidden = !menu.hidden; });
    slot.appendChild(button);
    slot.appendChild(menu);
  }

  window.addEventListener("valhalla-keys", function () {
    var current = fresh(localStorage.getItem(SESSION_KEY), 12 * 60 * 60 * 1000);
    if (current && current.pubkey) balances(current.pubkey);
  });

  document.getElementById("pasteForm").addEventListener("submit", function (event) {
    event.preventDefault();
    var value = document.getElementById("pasteKey").value.trim();
    if (!window.ValhallaConnect.isPubkey(value)) return;
    var session = fresh(localStorage.getItem(SESSION_KEY), 12 * 60 * 60 * 1000) || { kind: "google" };
    session.pubkey = value;
    saveSession(session);
    balances(value);
    document.getElementById("footWho").textContent = "watching …" + value.slice(-4);
  });

  window.addEventListener("valhalla-signed", function (event) {
    var packed = event.detail || {};
    if (!packed.pubkey) return;
    var expected = window.__valhallaExpected || "";
    var note = document.getElementById("walletNote");
    if (expected && packed.pubkey !== expected) {
      if (note) note.textContent = "That signature is for a different wallet. Use the address on file, ending " + expected.slice(-4) + ".";
      return;
    }
    var account = readAccount() || {};
    account.wallet = packed.pubkey;
    writeAccount(account);
    saveSession({ kind: "wallet", pubkey: packed.pubkey, email: account.email || "" });
    sessionStorage.setItem("valhalla-wallet-ok", "1");
    if (fresh(sessionStorage.getItem(HUMAN_KEY), HUMAN_MS) && account.email) openDesk();
  });

  var human = fresh(sessionStorage.getItem(HUMAN_KEY), HUMAN_MS);
  var account = readAccount();
  var signed = sessionStorage.getItem("valhalla-wallet-ok") === "1";
  if (human && account && account.email && signed) openDesk();
  else if (human && account && account.email) {
    show("gateWallet");
    mountWallet();
  } else if (human) {
    show("gateAccount");
    mountAccount();
  } else {
    show("gateHuman");
    mountTurnstile();
  }

})();
