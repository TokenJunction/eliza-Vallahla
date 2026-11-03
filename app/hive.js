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
    var on = enabled();
    say("hiveFlag", on ? "The Hive is on. Join only if you want this tab to run paper tests." : "The Hive is off until a leader turns it on.");
    say("hiveFlagSettings", "The Hive is off until a leader turns it on. Joining is a separate choice from these terms.");
    ["hiveJoin", "hiveThrottle"].forEach(function (id) {
      var node = document.getElementById(id);
      if (node) node.disabled = !on || state.active === true;
    });
    var box = document.getElementById("hiveState");
    if (box) box.hidden = state.active !== true;
    var slider = document.getElementById("hiveThrottle");
    if (slider && state.cap) slider.value = String(state.cap);
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

  async function runJob() {
    var why = pausedByDevice() || await batteryPause();
    if (why) {
      stop(why);
      return;
    }
    var base = String(cfg().HIVE_URL || "").replace(/\/$/, "");
    var response = await fetch(base + "/hive/next", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: read().nodeId })
    });
    if (!response.ok) {
      stop("The Hive coordinator did not offer a job.");
      return;
    }
    var job = await response.json();
    if (!job || !job.id || !Array.isArray(job.series)) {
      stop("No public paper job is waiting.");
      return;
    }
    worker = new Worker("hive-worker.js");
    worker.onmessage = function (event) {
      finish(job, event.data || {});
      worker.terminate();
      worker = null;
      if (read().active) setTimeout(runJob, 1000);
    };
    worker.postMessage({ job: job, cap: Number(read().cap) || 25 });
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

  function boot() {
    paint();
    var joinBtn = document.getElementById("hiveJoin");
    if (joinBtn) joinBtn.addEventListener("click", join);
    var stopBtn = document.getElementById("hiveStop");
    if (stopBtn) stopBtn.addEventListener("click", function () { stop("Hive stopped."); });
    document.addEventListener("visibilitychange", function () {
      if (document.hidden && read().active) stop("This tab is hidden. The Hive is paused.");
    });
    window.addEventListener("pagehide", function () { stop(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
