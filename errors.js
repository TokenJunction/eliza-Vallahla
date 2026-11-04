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
(function () {
  if (!/^\/app\/(?:index\.html)?$/.test(location.pathname)) return;
  function mount() {
    var frame = document.createElement('iframe');
    frame.title = 'Valhalla read-only preview';
    frame.src = '/preview/';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483646;background:#0b0e13';
    var back = document.createElement('button');
    back.type = 'button';
    back.textContent = 'Return to preview';
    back.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;padding:14px;background:#e9b768;color:#111;border:0;border-radius:8px';
    back.hidden = true;
    var saved = [];
    function open() {
      saved = Array.prototype.map.call(document.body.children, function (node) { return {node:node,inert:node.inert}; });
      saved.forEach(function (entry) { if (entry.node !== frame && entry.node !== back) entry.node.inert = true; });
      frame.hidden = false;
      back.hidden = true;
      frame.focus();
    }
    window.addEventListener('message', function (event) {
      if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data !== 'valhalla-preview-signin') return;
      saved.forEach(function (entry) { entry.node.inert = entry.inert; });
      frame.hidden = true;
      back.hidden = false;
      back.focus();
    });
    back.addEventListener('click', open);
    document.body.appendChild(frame);
    document.body.appendChild(back);
    open();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
