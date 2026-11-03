(function (root) {
  var LOG = "valhalla-debug-log";

  function stash(code, detail) {
    var rows = [];
    try { rows = JSON.parse(sessionStorage.getItem(LOG) || "[]"); } catch (err) { rows = []; }
    rows.unshift({ at: new Date().toISOString(), code: code, detail: String(detail || "").slice(0, 400) });
    sessionStorage.setItem(LOG, JSON.stringify(rows.slice(0, 30)));
  }

  function show(el, opts) {
    var code = opts && opts.code ? opts.code : "V-1";
    var detail = opts && opts.detail ? opts.detail : "";
    console.debug("valhalla", code, detail);
    stash(code, detail);
    var site = root.VALHALLA_SITE || {};
    var base = String(site.REPAIR_URL || site.AUTH_URL || "").replace(/\/$/, "");
    if (base) {
      fetch(base + "/log", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code, detail: String(detail).slice(0, 300) })
      }).catch(function () {});
    }
    if (!el) return;
    el.textContent = "";
    var text = document.createElement("span");
    text.textContent = (opts && opts.public ? opts.public : "Something went wrong. Please try again shortly.") + " (" + code + ")";
    el.appendChild(text);
    if (opts && opts.retry) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = "Retry";
      button.addEventListener("click", opts.retry);
      el.appendChild(document.createTextNode(" "));
      el.appendChild(button);
    }
  }

  function rows() {
    try { return JSON.parse(sessionStorage.getItem(LOG) || "[]"); } catch (err) { return []; }
  }

  root.ValhallaErrors = { show: show, rows: rows };
})(typeof globalThis !== "undefined" ? globalThis : this);
