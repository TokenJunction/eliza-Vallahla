(function () {
  var ACCOUNT_KEY = "valhalla-account";

  function readAccount() {
    try { return JSON.parse(localStorage.getItem(ACCOUNT_KEY) || "{}"); } catch (err) { return {}; }
  }

  function writeAccount(data) {
    data.at = Date.now();
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(data));
  }

  function log(line) {
    var box = document.getElementById("botLog");
    if (!box) return;
    var row = document.createElement("div");
    row.textContent = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false }) + " " + line;
    box.prepend(row);
  }

  function light(state) {
    var node = document.getElementById("botLight");
    if (!node) return;
    node.className = "light " + state;
    node.textContent = state === "running" ? "Running" : state === "error" ? "Error" : "Stopped";
  }

  function fields() {
    return {
      risk: document.getElementById("botRisk").value,
      maxSol: document.getElementById("botSize").value,
      slots: document.getElementById("botSlots").value,
      takeProfit: document.getElementById("botTp").value,
      stopLoss: document.getElementById("botSl").value,
      minLiquidity: document.getElementById("botLiq").value,
      minAgeHours: document.getElementById("botAge").value,
      copies: document.getElementById("botCopies").value.trim(),
      dailyLoss: document.getElementById("botLoss").value
    };
  }

  function apply(bot) {
    if (!bot) return;
    document.getElementById("botRisk").value = bot.risk || "medium";
    document.getElementById("botSize").value = bot.maxSol || "0.1";
    document.getElementById("botSlots").value = bot.slots || "3";
    document.getElementById("botTp").value = bot.takeProfit || "25";
    document.getElementById("botSl").value = bot.stopLoss || "15";
    document.getElementById("botLiq").value = bot.minLiquidity || "10000";
    document.getElementById("botAge").value = bot.minAgeHours || "1";
    document.getElementById("botCopies").value = bot.copies || "";
    document.getElementById("botLoss").value = bot.dailyLoss || "0.5";
  }

  function paintStart() {
    var account = readAccount();
    var start = document.getElementById("botStart");
    var note = document.getElementById("botLinkNote");
    var linked = String(account.agentUrl || "").indexOf("http") === 0;
    var accepted = account.riskAccepted === true || document.getElementById("botRiskAck").checked;
    start.disabled = !linked || !accepted;
    note.hidden = linked;
    if (account.agentUrl) document.getElementById("botAgent").value = account.agentUrl;
    if (account.riskAccepted) document.getElementById("botRiskAck").checked = true;
  }

  async function callAgent(path) {
    var account = readAccount();
    var base = String(account.agentUrl || "").replace(/\/$/, "");
    if (!base) throw new Error("No agent is linked.");
    var response = await fetch(base + path, { method: path === "/api/state" ? "GET" : "POST", headers: { "content-type": "application/json" }, body: path === "/api/state" ? undefined : "{}" });
    if (!response.ok) throw new Error("The agent did not accept " + path);
    return response.json();
  }

  document.getElementById("botReview").addEventListener("click", function () {
    var bot = fields();
    var account = readAccount();
    account.bot = bot;
    writeAccount(account);
    var box = document.getElementById("botSummary");
    box.hidden = false;
    box.textContent = "Review: risk " + bot.risk + ", max " + bot.maxSol + " SOL, " + bot.slots + " open, take-profit " + bot.takeProfit + "%, stop " + bot.stopLoss + "%, min liquidity $" + bot.minLiquidity + ", min age " + bot.minAgeHours + "h, daily loss " + bot.dailyLoss + " SOL. Copy list: " + (bot.copies || "none") + ". This is not a promise of profit.";
    log("Settings saved on this account for review.");
  });

  document.getElementById("botRiskAck").addEventListener("change", function (event) {
    var account = readAccount();
    account.riskAccepted = event.target.checked;
    writeAccount(account);
    paintStart();
  });

  document.getElementById("botSaveAgent").addEventListener("click", function () {
    var account = readAccount();
    account.agentUrl = document.getElementById("botAgent").value.trim();
    writeAccount(account);
    paintStart();
    log(account.agentUrl ? "Agent link saved on this device." : "Agent link cleared.");
  });

  document.getElementById("botStart").addEventListener("click", function () {
    var account = readAccount();
    if (!account.riskAccepted && !document.getElementById("botRiskAck").checked) {
      log("Tick the risk notice before the first start.");
      return;
    }
    account.bot = fields();
    account.riskAccepted = true;
    writeAccount(account);
    callAgent("/api/start").then(function () {
      light("running");
      log("Start sent to your agent. The key stayed on that computer.");
    }).catch(function () {
      light("error");
      log("Start failed. Your agent did not answer.");
    });
  });

  document.getElementById("botStop").addEventListener("click", function () {
    callAgent("/api/stop").then(function () {
      light("stopped");
      log("Stop sent to your agent.");
    }).catch(function () {
      light("error");
      log("Stop failed. Your agent did not answer.");
    });
  });

  var saved = readAccount();
  apply(saved.bot);
  paintStart();
  light("stopped");
  window.setInterval(function () {
    var account = readAccount();
    if (!account.agentUrl) return;
    callAgent("/api/state").then(function (body) {
      light(body && body.running ? "running" : "stopped");
    }).catch(function () {
      light("error");
    });
  }, 15000);
})();
