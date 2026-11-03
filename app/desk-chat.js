(function () {
  var DAY = "valhalla-chat-day";
  var MEMORY = "valhalla-chat-memory";

  function cfg() { return window.VALHALLA_SITE || {}; }

  function secretLike(text) {
    var words = String(text || "").trim().toLowerCase().split(/\s+/);
    if (words.length >= 12 && words.length <= 24 && words.every(function (word) { return /^[a-z]+$/.test(word); })) return true;
    return /[1-9A-HJ-NP-Za-km-z]{64,}/.test(text || "");
  }

  function safeName(text) {
    return String(text || "").replace(/[^\w .$-]/g, "").slice(0, 32) || "token";
  }

  function limit() {
    var plan = "free";
    try { plan = JSON.parse(localStorage.getItem("valhalla-account") || "{}").plan || "free"; } catch (err) { plan = "free"; }
    if (document.getElementById("leaderBadge") && !document.getElementById("leaderBadge").hidden) return 100000;
    if (plan === "pro") return 200;
    return 20;
  }

  function used() {
    try { return JSON.parse(localStorage.getItem(DAY) || "{}"); } catch (err) { return {}; }
  }

  function say(text) {
    var log = document.getElementById("chatLog");
    if (!log) return;
    var row = document.createElement("div");
    row.textContent = text;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    if (localStorage.getItem("valhalla-chat-speak") === "1" && window.speechSynthesis) {
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(text.slice(0, 240)));
    }
  }

  function remember(text) {
    var list = [];
    try { list = JSON.parse(localStorage.getItem(MEMORY) || "[]"); } catch (err) { list = []; }
    list.push(String(text).slice(0, 160));
    localStorage.setItem(MEMORY, JSON.stringify(list.slice(-20)));
  }

  function card(before, after, apply) {
    var log = document.getElementById("chatLog");
    var box = document.createElement("div");
    box.className = "approve";
    box.textContent = "Proposed change. Approve to apply it on this desk. " + before + " → " + after;
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = "Approve";
    button.addEventListener("click", function () {
      apply();
      button.disabled = true;
      say("Approved. The paper settings changed. No order was sent.");
    });
    box.appendChild(button);
    log.appendChild(box);
  }

  async function safety(mint) {
    var clean = String(mint || "").trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(clean)) return "That is not a mint address.";
    var response = await fetch("https://api.mainnet-beta.solana.com", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [clean, { encoding: "jsonParsed" }] })
    });
    var body = await response.json();
    var info = body && body.result && body.result.value && body.result.value.data && body.result.value.data.parsed && body.result.value.data.parsed.info;
    if (!info) return "No mint account was found. This is a check, not advice.";
    var mintAuth = info.mintAuthority ? "set" : "none";
    var freeze = info.freezeAuthority ? "set" : "none";
    var holders = await fetch("https://api.mainnet-beta.solana.com", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenLargestAccounts", params: [clean] })
    }).then(function (res) { return res.json(); }).catch(function () { return {}; });
    var top = ((holders.result && holders.result.value) || []).slice(0, 3).map(function (row) {
      return String(row.address || "").slice(-4) + " " + (row.uiAmountString || "");
    }).join(", ");
    return "Safety check for …" + clean.slice(-4) + ". Mint authority " + mintAuth + ". Freeze authority " + freeze + ". Largest accounts: " + (top || "none listed") + ". LP was not checked. Not advice. Token name text is ignored.";
  }

  async function localTool(text) {
    var lower = text.toLowerCase();
    var paper = window.ValhallaPaper;
    if (/start/.test(lower) && paper) { paper.start(); return "Paper run started. SIMULATED. Live-money trading is off."; }
    if (/stop/.test(lower) && paper) { paper.stop("Stopped from chat."); return "Paper run stopped. No order was sent."; }
    if (/pause/.test(lower)) {
      var pause = document.getElementById("botPause");
      if (pause) pause.click();
      return "Pause requested. SIMULATED.";
    }
    if (/paper test/.test(lower) && paper) { paper.start(); return "One paper test is running on the live SOL price. SIMULATED. No order was sent."; }
    if (/balance/.test(lower)) {
      return "Your wallet line: " + (document.getElementById("solLine").textContent || "—") + ". Agent wallet: " + (document.getElementById("agentEmpty").textContent || "linked") + ". Read-only.";
    }
    if (/why|skip|explain/.test(lower)) return "The paper log skips when the move is inside the stop band. SIMULATED. It is not a promise.";
    if (/lab|feed/.test(lower)) return "The lab feed is SIMULATED. Open the Lab panel. No real orders are there.";
    if (/risk|size|filter/.test(lower) && paper) {
      var now = paper.fields();
      card("max " + now.maxSol + " SOL", "max 0.05 SOL", function () {
        document.getElementById("botSize").value = "0.05";
      });
      return "A change card is waiting for Approve.";
    }
    var mint = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
    if (mint) return safety(mint[0]);
    return "";
  }

  async function remote(text) {
    var base = String(cfg().CHAT_URL || cfg().AGENT_API_URL || "");
    if (!base) return "";
    var response = await fetch(base.replace(/\/$/, "") + "/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: text.slice(0, 500), plan: "free" })
    });
    if (!response.ok || !response.body) return "Assistant offline";
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var all = "";
    say("");
    var node = document.getElementById("chatLog").lastChild;
    while (true) {
      var step = await reader.read();
      if (step.done) break;
      all += decoder.decode(step.value, { stream: true });
      node.textContent = all + " SIMULATED where a result is shown. Not financial advice.";
    }
    return all;
  }

  async function send(text) {
    if (secretLike(text)) {
      say("Do not paste a seed phrase or a private key. That text was not sent.");
      return;
    }
    var today = new Date().toISOString().slice(0, 10);
    var count = used();
    if (count.day !== today) count = { day: today, n: 0 };
    if (count.n >= limit()) {
      say("The free message limit for today is full. Pro raises the limit. No profit is promised.");
      return;
    }
    count.n += 1;
    localStorage.setItem(DAY, JSON.stringify(count));
    remember(safeName(text));
    say("You: " + text.slice(0, 500));
    var tool = await localTool(text);
    if (tool) {
      say(tool);
      return;
    }
    var answer = await remote(text).catch(function () { return "Assistant offline"; });
    if (!answer) say("The language model is offline until the chat Worker is deployed. Tools above still run on this desk. SIMULATED. Not financial advice.");
  }

  function boot() {
    var dock = document.getElementById("deskChat");
    var desk = document.getElementById("desk");
    if (!dock || !desk) return;
    dock.hidden = desk.hidden;
    document.getElementById("chatForm").addEventListener("submit", function (event) {
      event.preventDefault();
      var input = document.getElementById("chatText");
      var text = input.value.trim();
      input.value = "";
      if (text) send(text);
    });
    document.getElementById("chatSpeak").addEventListener("click", function () {
      var on = localStorage.getItem("valhalla-chat-speak") === "1";
      localStorage.setItem("valhalla-chat-speak", on ? "0" : "1");
      this.textContent = on ? "Voice replies off" : "Voice replies on";
    });
    document.getElementById("chatMic").addEventListener("click", function () {
      var Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!Rec) {
        say("This browser has no speech input.");
        return;
      }
      var rec = new Rec();
      rec.onresult = function (event) {
        document.getElementById("chatText").value = event.results[0][0].transcript;
      };
      rec.start();
    });
    var safety = document.getElementById("safetyForm");
    if (safety) safety.addEventListener("submit", function (event) {
      event.preventDefault();
      var mint = document.getElementById("safetyMint").value;
      safetyCheck(mint);
    });
    window.addEventListener("valhalla-desk", function () { dock.hidden = false; });
  }

  function safetyCheck(mint) {
    safety(mint).then(function (text) {
      var out = document.getElementById("safetyOut");
      if (out) out.textContent = text;
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
