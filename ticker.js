(function () {
  function node(tag, className, text) {
    var item = document.createElement(tag);
    if (className) item.className = className;
    item.textContent = text;
    return item;
  }

  function price(value) {
    var number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return "—";
    return new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: number < 0.01 ? 8 : 2
    }).format(number);
  }

  function change(value) {
    var number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return (number > 0 ? "+" : "") + number.toFixed(1) + "%";
  }

  function appendQuote(parent, label, value, move, badge) {
    var number = Number(move);
    var quote = node("span", Number.isFinite(number) && number < 0 ? "dn" : "up", "");
    quote.appendChild(node("strong", "", label));
    quote.appendChild(document.createTextNode(" $" + price(value) + " " + change(move)));
    if (badge) quote.appendChild(node("em", "badge mode", badge));
    parent.appendChild(quote);
  }

  function paint(bar, data) {
    var items = document.createElement("div");
    var sol = data.sol || {};
    appendQuote(items, "SOL", sol.usd, sol.change24h, "");
    (data.tokens || []).slice(0, 10).forEach(function (token) {
      var symbol = String(token.symbol || "TOKEN").slice(0, 12);
      appendQuote(items, symbol, token.price, token.change24h, String(token.badge || ""));
    });
    items.appendChild(node("span", "ticker-source", "Sources: " + String(data.sources || "public prices") + " · Not financial advice"));

    var line = document.createElement("div");
    line.className = "ticker-track";
    Array.prototype.slice.call(items.childNodes).forEach(function (item, index) {
      if (index) line.appendChild(document.createTextNode(" · "));
      line.appendChild(item);
    });
    line.appendChild(document.createTextNode(" · "));
    line.appendChild(line.cloneNode(true));

    bar.textContent = "";
    bar.appendChild(line);
    bar.hidden = false;
    bar.classList.remove("ticker-unavailable");
    bar.setAttribute("aria-label", "Live public prices. Not financial advice.");
    bar.dataset.updatedAt = String(Number(data.at) || Date.now());
  }

  function unavailable(bar, text) {
    bar.textContent = "";
    bar.appendChild(node("span", "ticker-status", text));
    bar.hidden = false;
    bar.classList.add("ticker-unavailable");
    bar.setAttribute("aria-label", text);
  }

  async function pull() {
    var bars = Array.prototype.slice.call(document.querySelectorAll("[data-ticker]"));
    var url = String((window.VALHALLA_SITE || {}).TICKER_URL || "");
    if (!url) {
      bars.forEach(function (bar) {
        unavailable(bar, "PRICE FEED · UNAVAILABLE · market data service is not connected");
      });
      return;
    }

    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timeout = controller ? window.setTimeout(function () { controller.abort(); }, 8000) : 0;
    try {
      var response = await fetch(url, {
        cache: "no-store",
        signal: controller ? controller.signal : undefined
      });
      if (!response.ok) throw new Error("ticker " + response.status);
      var data = await response.json();
      if (!data || !data.sol || !Number.isFinite(Number(data.sol.usd)) || Number(data.sol.usd) <= 0) {
        throw new Error("price data unavailable");
      }
      window.ValhallaTicker.last = data;
      bars.forEach(function (bar) { paint(bar, data); });
    } catch (err) {
      console.debug("valhalla", "V-TICK", String(err && err.message || err));
      bars.forEach(function (bar) {
        if (window.ValhallaTicker.last) {
          var updated = Number(window.ValhallaTicker.last.at) || 0;
          unavailable(bar, "PRICE FEED · STALE · last successful update " +
            (updated ? Math.max(0, Math.round((Date.now() - updated) / 1000)) + "s ago" : "unknown"));
        } else {
          unavailable(bar, "PRICE FEED · UNAVAILABLE · could not reach market data service");
        }
      });
    } finally {
      if (timeout) window.clearTimeout(timeout);
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
