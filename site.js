(function () {
  var cfg = window.VALHALLA_SITE || {};
  var shot = document.getElementById("phone-shot");
  document.querySelectorAll("[data-shot]").forEach(function (button) {
    button.addEventListener("click", function () {
      shot.src = button.getAttribute("data-shot");
      shot.alt = button.getAttribute("data-alt");
      document.querySelectorAll("[data-shot]").forEach(function (other) {
        other.setAttribute("aria-selected", other === button ? "true" : "false");
      });
    });
  });

  var names = ["assets/phone-pairing.jpg", "assets/phone-status.jpg", "assets/phone-chat.jpg"];
  var alts = ["Phone pairing screen", "Phone status screen", "Phone chat screen"];
  var index = 0;
  var timer = setInterval(function () {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    index = (index + 1) % names.length;
    shot.src = names[index];
    shot.alt = alts[index];
  }, 3200);
  shot.addEventListener("mouseenter", function () { clearInterval(timer); });

  function setLink(id, href, label) {
    var el = document.getElementById(id);
    if (!el) return;
    if (href) {
      el.href = href;
      el.textContent = label;
    }
  }
  setLink("x-link", cfg.x, "X");
  setLink("discord-link", cfg.discord, "Discord");
  setLink("telegram-link", cfg.telegram, "Telegram");

  document.getElementById("connect-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var email = document.getElementById("email").value.trim();
    var note = document.getElementById("note").value.trim();
    var status = document.getElementById("form-status");
    if (cfg.formspree) {
      status.textContent = "Sending…";
      fetch(cfg.formspree, {
        method: "POST",
        headers: { "Accept": "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ email: email, note: note })
      }).then(function (response) {
        status.textContent = response.ok ? "Sent. We did not ask for a wallet key." : "The form did not accept that. Use the GitHub link.";
      }).catch(function () {
        status.textContent = "The form could not be reached. Use the GitHub link.";
      });
      return;
    }
    if (cfg.googleForm) {
      window.open(cfg.googleForm, "_blank", "noopener");
      status.textContent = "Opened the form. Do not type a key or a seed phrase.";
      return;
    }
    var url = new URL("https://github.com/TokenJunction/eliza-valhalla/issues/new");
    url.searchParams.set("title", "Valhalla contact");
    url.searchParams.set("body", "Email: " + email + "\n\n" + note);
    window.open(url.toString(), "_blank", "noopener");
    status.textContent = "Opened a GitHub issue. No key was requested.";
  });

  if (cfg.adsense === true && /^ca-pub-\d{16}$/.test(cfg.adsenseClient || "")) {
    var script = document.createElement("script");
    script.async = true;
    script.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=" + cfg.adsenseClient;
    script.crossOrigin = "anonymous";
    document.head.appendChild(script);
  }
})();
