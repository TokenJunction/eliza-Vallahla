(function (root) {
  var NAMES = ["VALHALLA CORE", "MECHA BRAIN", "ASK VALHALLA", "ODIN FEED", "FORGE LAB", "HEIMDALL GATE", "SENTINEL WATCH"];

  function light(state) {
    if (state === "LIVE") return "#00ff88";
    if (state === "DEGRADED") return "#ffb347";
    return "#ff3b4a";
  }

  function age(ms) {
    var seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
    return "last checked " + seconds + "s ago";
  }

  function unavailable(host) {
    host.innerHTML = "<button type=\"button\" class=\"status-toggle\">Status unavailable</button><div class=\"status-panel\" hidden><p>Status unavailable</p></div>";
    host.querySelector(".status-toggle").onclick = function () {
      var panel = host.querySelector(".status-panel");
      panel.hidden = !panel.hidden;
    };
  }

  function draw(host, data) {
    if (!data || !data.checkedAt || !Array.isArray(data.lines)) {
      unavailable(host);
      return;
    }
    var names = data.lines.map(function (line) { return line.name; });
    if (names.join("|") !== NAMES.join("|")) {
      unavailable(host);
      return;
    }
    var rows = data.lines.map(function (line) {
      var state = line.state === "LIVE" || line.state === "DEGRADED" || line.state === "OFFLINE" ? line.state : "OFFLINE";
      var extra = line.name === "FORGE LAB" ? " · simulated" : "";
      return "<div><i style=\"background:" + light(state) + "\"></i> " + line.name + extra + " " + state + " · " + age(data.checkedAt) + "</div>";
    }).join("");
    var hive = "";
    if (data.hive && typeof data.hive.nodes === "number") {
      hive = data.hive.enabled === true
        ? "<div>THE HIVE: " + data.hive.nodes + " nodes live</div>"
        : "<div>THE HIVE: off</div>";
    }
    host.innerHTML = "<button type=\"button\" class=\"status-toggle\">" + data.overall + " · " + data.uptime7d + "% 7-day</button><div class=\"status-panel\" hidden>" + rows + hive + "</div>";
    host.querySelector(".status-toggle").onclick = function () {
      var panel = host.querySelector(".status-panel");
      panel.hidden = !panel.hidden;
    };
  }

  function mount(target) {
    if (!target || target.querySelector(".system-status")) return;
    var host = document.createElement("div");
    host.className = "system-status";
    host.style.cssText = "font:11px/1.4 ui-monospace,monospace;color:#7a7468";
    target.prepend(host);
    unavailable(host);
    async function pull() {
      var url = (window.VALHALLA_SITE || {}).STATUS_URL || "";
      if (!url) {
        unavailable(host);
        return;
      }
      try {
        var response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error("down");
        draw(host, await response.json());
      } catch (err) {
        unavailable(host);
      }
    }
    pull();
    window.setInterval(pull, 60000);
  }

  function boot() {
    document.querySelectorAll("footer").forEach(function (foot) { mount(foot); });
    if (document.body && document.body.dataset.page === "app") {
      var desk = document.getElementById("desk") || document.body;
      mount(desk);
    }
    var board = document.getElementById("statusBoard");
    if (board) mount(board);
    document.querySelectorAll("[data-status-slot]").forEach(function (slot) { mount(slot); });
  }

  root.ValhallaStatus = { mount: mount };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(typeof globalThis !== "undefined" ? globalThis : this);
