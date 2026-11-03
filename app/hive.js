(function () {
  var KEY = "valhalla-hive";
  var worker = null;

  function cfg() {
    return window.VALHALLA_SITE || {};
  }

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (err) { return {}; }
  }

  function write(data) {
    localStorage.setItem(KEY, JSON.stringify(data));
  }

  function enabled() {
    return cfg().HIVE_ENABLED === true && String(cfg().HIVE_URL || "").indexOf("https://") === 0;
  }

  function say(id, text) {
    var node = document.getElementById(id);
    if (node) node.textContent = text;
  }

  function paint() {
    var state = read();
    ["hiveOpt", "hiveOptSettings"].forEach(function (id) {
      var box = document.getElementById(id);
      if (box) box.checked = state.optIn === true;
    });
    var slider = document.getElementById("hiveThrottle");
    if (slider) {
      slider.disabled = state.optIn !== true;
      if (state.cap) slider.value = String(state.cap);
    }
    say("hiveFlag", state.optIn ? "This tab is a Hive node while it stays open." : "Hive is off. This tab does no extra work until you opt in.");
    say("hiveFlagSettings", state.optIn ? "Opted in for this tab. Closing the tab stops the work." : "Hive is off until you opt in. It stops when you close the tab.");
    say("hiveMeter", "Impact: " + (state.optIn ? (state.paused ? "paused" : "on") : "off")
      + ". Jobs " + Number(state.jobs || 0)
      + ". Verified " + Number(state.verified || 0)
      + ". Engine " + (state.engine || "—")
      + ". CPU cap " + (state.cap || 25) + "%."
      + " Unverified results are not used.");
    say("hivePoints", "Contribution points: " + Number(state.points || 0) + ". Not transferable. No cash value.");
    var payout = document.getElementById("payoutLink");
    if (payout) payout.disabled = cfg().REWARDS_PAYOUT_ENABLED !== true;
  }

  function stop(reason) {
    if (worker) {
      worker.terminate();
      worker = null;
    }
    var state = read();
    state.active = false;
    write(state);
    paint();
    if (reason) say("hiveFlag", reason);
  }

  function pausedByDevice() {
    if (document.hidden) return "This tab is hidden. The Hive is paused.";
    var net = navigator.connection;
    if (net && (net.saveData || net.type === "cellular")) return "This connection is metered. The Hive is paused.";
    return "";
  }

  async function batteryPause() {
    if (!navigator.getBattery) return "";
    try {
      var battery = await navigator.getBattery();
      if (battery.charging === false) return "This device is on battery. The Hive is paused.";
    } catch (err) {
      return "";
    }
    return "";
  }

  function accountId() {
    var state = read();
    if (!state.accountId) {
      state.accountId = Math.random().toString(36).slice(2) + Date.now().toString(36);
      write(state);
    }
    return state.accountId;
  }

  async function finish(job, result) {
    var base = String(cfg().HIVE_URL || "").replace(/\/$/, "");
    var response = await fetch(base + "/hive/result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nodeId: read().nodeId,
        accountId: accountId(),
        jobId: job.id,
        cash: result.cash,
        n: result.n,
        simulated: true
      })
    });
    if (!response.ok) return;
    var body = await response.json();
    var state = read();
    if (Number.isFinite(Number(body.points))) state.points = Number(body.points);
    write(state);
    paint();
  }

  async function engineName() {
    if (!navigator.gpu) return "cpu";
    try {
      var adapter = await navigator.gpu.requestAdapter();
      return adapter ? "gpu" : "cpu";
    } catch (err) {
      return "cpu";
    }
  }

  function localJob() {
    var kinds = ["backtest", "paper", "sweep", "score"];
    var state = read();
    var kind = kinds[Number(state.jobs || 0) % kinds.length];
    return {
      id: "public-" + kind + "-" + Date.now(),
      kind: kind,
      simulated: true,
      series: [100, 101, 100.4, 99.2, 100.1, 100.8, 99.6],
      params: { stopPct: 15, takePct: 30, size: 0.05 }
    };
  }

  async function runJob() {
    var why = pausedByDevice() || await batteryPause();
    if (why) {
      stop(why);
      return;
    }
    var job = localJob();
    var engine = await engineName();
    worker = new Worker("hive-worker.js");
    worker.onmessage = async function (event) {
      var result = event.data || {};
      var state = read();
      state.jobs = Number(state.jobs || 0) + 1;
      state.engine = result.engine || engine;
      state.pending = result.jobId;
      write(state);
      if (enabled() && state.nodeId) {
        try { await finish(job, result); state = read(); state.verified = Number(state.verified || 0) + 1; write(state); }
        catch (err) { state.verified = state.verified || 0; }
      }
      paint();
      worker.terminate();
      worker = null;
      if (read().optIn) setTimeout(runJob, 1000);
    };
    worker.postMessage({ job: job, cap: Number(read().cap) || 25, engine: engine });
  }

  async function join() {
    if (!enabled()) {
      paint();
      return;
    }
    var token = "";
    var input = document.querySelector("[name='cf-turnstile-response']");
    if (input) token = input.value;
    if (!token) {
      say("hiveFlag", "A human check is required before you join.");
      return;
    }
    var slider = document.getElementById("hiveThrottle");
    var cap = slider ? Number(slider.value) : 25;
    var response = await fetch(String(cfg().HIVE_URL).replace(/\/$/, "") + "/hive/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: token, accountId: accountId() })
    });
    if (!response.ok) {
      say("hiveFlag", "The Hive did not accept this browser.");
      return;
    }
    var body = await response.json();
    var state = read();
    state.active = true;
    state.nodeId = body.nodeId;
    state.cap = Math.min(50, Math.max(25, cap));
    write(state);
    paint();
    runJob();
  }

  function setOpt(on) {
    var state = read();
    state.optIn = on === true;
    state.active = state.optIn;
    if (!state.optIn) {
      write(state);
      stop("Hive stopped.");
      return;
    }
    var slider = document.getElementById("hiveThrottle");
    state.cap = slider ? Math.min(50, Math.max(25, Number(slider.value) || 25)) : 25;
    state.jobs = state.jobs || 0;
    state.verified = state.verified || 0;
    write(state);
    paint();
    runJob();
  }

  function boot() {
    var state = read();
    state.optIn = false;
    state.active = false;
    write(state);
    paint();
    ["hiveOpt", "hiveOptSettings"].forEach(function (id) {
      var box = document.getElementById(id);
      if (!box) return;
      box.checked = false;
      box.addEventListener("change", function () { setOpt(box.checked); });
    });
    var slider = document.getElementById("hiveThrottle");
    if (slider) slider.addEventListener("input", function () {
      var next = read();
      next.cap = Math.min(50, Math.max(25, Number(slider.value) || 25));
      write(next);
      paint();
    });
    document.addEventListener("visibilitychange", function () {
      if (!read().optIn) return;
      if (document.hidden) {
        if (worker) worker.terminate();
        worker = null;
        var state = read();
        state.paused = true;
        write(state);
        say("hiveFlag", "This tab is hidden. The Hive is paused.");
        paint();
        return;
      }
      var state = read();
      state.paused = false;
      write(state);
      runJob();
    });
    window.addEventListener("pagehide", function () { stop(); });
    if (navigator.getBattery) {
      navigator.getBattery().then(function (battery) {
        battery.addEventListener("chargingchange", function () {
          if (!battery.charging && read().optIn) stop("This device is on battery. The Hive is paused.");
        });
      }).catch(function () {});
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
