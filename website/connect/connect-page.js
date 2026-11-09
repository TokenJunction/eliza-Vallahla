(function () {
  const params = new URLSearchParams(location.search);
  const which = params.get("wallet") === "solflare" ? "solflare" : "phantom";
  const label = which === "solflare" ? "Solflare" : "Phantom";
  const downloadHref = which === "solflare" ? "https://solflare.com/download" : "https://phantom.app/download";
  const status = document.getElementById("status");
  const go = document.getElementById("go");
  const missing = document.getElementById("missing");
  const download = document.getElementById("download");
  const wallets = [];

  function say(text) {
    if (status) status.textContent = text;
  }

  window.addEventListener("wallet-standard:register-wallet", (event) => {
    const wallet = event.detail;
    if (wallet && !wallets.includes(wallet)) wallets.push(wallet);
  });
  window.dispatchEvent(new Event("wallet-standard:app-ready"));

  function injected() {
    if (which === "solflare") return window.solflare || null;
    const phantom = window.phantom && window.phantom.solana;
    return phantom || null;
  }

  function found() {
    return ValhallaConnect.pickNamed(wallets, which) || injected();
  }

  if (download) download.href = downloadHref;
  if (go) go.textContent = `Continue with ${label}`;
  if (go) go.disabled = true;
  say("Wallet sign-in verification is not configured. No wallet session can be accepted here.");

  window.setTimeout(() => {
    if (found()) return;
    if (missing) missing.hidden = false;
    if (download) download.hidden = false;
    if (go) go.hidden = true;
    say(`${label} was not detected. Install it, then reload this page.`);
  }, 1500);

  window.setInterval(() => {
    if (!found() || !go) return;
    go.hidden = false;
    if (missing) missing.hidden = true;
  }, 300);

  go?.addEventListener("click", () => {
    say("Wallet sign-in verification is not configured. No wallet signature was requested.");
  });
})();
