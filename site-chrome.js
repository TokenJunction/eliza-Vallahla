(function () {
  function boot() {
    var cfg = window.VALHALLA_SITE || {};
    var xUrl = cfg.xUrl || "https://x.com/intent/user?user_id=2092719999886475265";
    var mark = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M14.7 10.3 22 2h-2.2l-6.3 7.2L8.2 2H2l7.7 10.9L2 22h2.2l7-8 5.6 8H22l-7.3-11.7Z"/></svg>';
    var header = document.querySelector("header");
    if (!header) {
      header = document.createElement("header");
      header.className = "bar wrap";
      document.body.insertBefore(header, document.body.firstChild);
    }
    var brand = header.querySelector(".brand");
    if (!brand) {
      brand = document.createElement("a");
      brand.className = "brand";
      brand.href = "/";
      header.insertBefore(brand, header.firstChild);
    }
    if (brand.querySelector("img")) brand.querySelector("img").alt = "Valhalla™ mech logo";
    if (brand.innerHTML.indexOf("VALHALLA™") < 0) {
      if (brand.innerHTML.indexOf("VALHALLA") >= 0) brand.innerHTML = brand.innerHTML.replace("VALHALLA", "VALHALLA™");
      else brand.insertAdjacentHTML("beforeend", " VALHALLA™");
    }
    var nav = header.querySelector("nav") || header;
    if (!document.getElementById("walletButtons") && window.ValhallaSite) {
      var row = document.createElement("div");
      row.id = "walletButtons";
      row.className = "wallet-row";
      nav.appendChild(row);
      window.ValhallaSite.mountButtons(row);
    }
    if (!header.querySelector(".xlink")) {
      var link = document.createElement("a");
      link.className = "xlink";
      link.href = xUrl;
      link.innerHTML = mark + " Follow Valhalla on X";
      nav.appendChild(link);
    }
    if (!header.querySelector('a[href="/contact/"]')) {
      var contact = document.createElement("a");
      contact.href = "/contact/";
      contact.textContent = "Contact";
      nav.appendChild(contact);
    }
    if (!document.getElementById("walletChip")) {
      var chip = document.createElement("span");
      chip.id = "walletChip";
      chip.hidden = true;
      nav.appendChild(chip);
    }
    var foot = document.querySelector("footer");
    if (!foot) {
      foot = document.createElement("footer");
      var wrap = document.createElement("div");
      wrap.className = "wrap";
      foot.appendChild(wrap);
      document.body.appendChild(foot);
    }
    var host = foot.querySelector(".wrap") || foot;
    if (!foot.querySelector(".xlink")) {
      var footX = document.createElement("p");
      footX.innerHTML = '<a class="xlink" href="' + xUrl + '">' + mark + " Follow Valhalla on X</a>";
      host.appendChild(footX);
    }
    if (!foot.querySelector(".legal-tm")) {
      var legal = document.createElement("p");
      legal.className = "legal-tm";
      legal.textContent = "Valhalla™ and the Valhalla mech logo are trademarks of TokenJunction LLC.";
      host.appendChild(legal);
    }
    var meta = document.querySelector('meta[name="twitter:site"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "twitter:site");
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", cfg.handle || "@ValhallaOS");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
