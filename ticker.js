(function () {
  function paint(bar, data) {
    var sol = data.sol || {};
    var change = Number(sol.change24h);
    var solClass = change < 0 ? "dn" : "up";
    var parts = ["<span class=\"" + solClass + "\">SOL $" + Number(sol.usd).toFixed(2) + " " + (change < 0 ? "" : "+") + change.toFixed(1) + "%</span>"];
    (data.tokens || []).slice(0, 8).forEach(function (token) {
      var move = Number(token.change24h);
      var klass = move < 0 ? "dn" : "up";
      parts.push("<span class=\"" + klass + "\">" + token.symbol + " $" + Number(token.price).toFixed(4) + " " + (move < 0 ? "" : "+") + move.toFixed(1) + "% <i class=\"badge mode\">" + token.badge + "</i></span>");
    });
    parts.push("<span>Sources: " + (data.sources || "public prices") + " · Not financial advice</span>");
    var line = parts.join(" · ");
    bar.innerHTML = "<div class=\"ticker-track\">" + line + " · " + line + "</div>";
    bar.hidden = false;
  }

  function hide() {
    document.querySelectorAll("[data-ticker]").forEach(function (bar) { bar.hidden = true; });
  }

  async function pull() {
    var url = String((window.VALHALLA_SITE || {}).TICKER_URL || "");
    if (!url) {
      hide();
      return;
    }
    try {
      var response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error("down");
      var data = await response.json();
      if (!data || !data.sol || !Number(data.sol.usd)) throw new Error("empty");
      window.ValhallaTicker.last = data;
      document.querySelectorAll("[data-ticker]").forEach(function (bar) { paint(bar, data); });
    } catch (err) {
      console.debug("valhalla", "V-TICK", String(err && err.message || err));
      hide();
    }
  }

  window.ValhallaTicker = { last: null };
  function boot() {
    pull();
    window.setInterval(pull, 20000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
