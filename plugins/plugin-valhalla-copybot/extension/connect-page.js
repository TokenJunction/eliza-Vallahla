(() => {
  const params = new URLSearchParams(location.search);
  const requested = params.get("wallet");
  const which = ["solflare", "backpack", "other"].includes(requested)
    ? requested
    : "phantom";
  const label = {
    solflare: "Solflare",
    backpack: "Backpack",
    other: "your wallet",
    phantom: "Phantom",
  }[which];
  const downloadHref =
    which === "solflare"
      ? "https://solflare.com/download"
      : which === "backpack"
        ? "https://backpack.app/download"
        : "https://phantom.app/download";
  const status = document.getElementById("status");
  const go = document.getElementById("go");
  const missing = document.getElementById("missing");
  const download = document.getElementById("download");
  const wallets = [];

  function say(text) {
    if (status) status.textContent = text;
  }

  function registerWallet(wallet) {
    if (wallet && !wallets.includes(wallet)) wallets.push(wallet);
  }
  window.addEventListener("wallet-standard:register-wallet", (event) => {
    const detail = event && event.detail;
    if (typeof detail === "function") { try { detail(registerWallet); } catch {} return; }
    if (detail && (detail.features || detail.name)) registerWallet(detail);
  });
  try {
    window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: { register: registerWallet } }));
  } catch {}
  window.dispatchEvent(new Event("wallet-standard:app-ready"));

  function injected() {
    if (which === "solflare") return window.solflare || null;
    if (which === "backpack")
      return (window.backpack && (window.backpack.solana || window.backpack)) || null;
    if (which === "other") return null;
    const phantom = window.phantom && window.phantom.solana;
    return phantom || null;
  }

  function found() {
    return ValhallaConnect.pickNamed(wallets, which) || injected();
  }

  if (download) download.href = downloadHref;
  if (go) go.textContent = `Continue with ${label}`;
  say(
    `Looking for ${label}. This page only asks you to connect and to sign in. It does not send a transaction.`
  );

  window.setTimeout(() => {
    if (found()) return;
    if (missing) missing.hidden = false;
    if (download) download.hidden = which === "other";
    if (go) go.hidden = true;
    say(
      which === "other"
        ? "No compatible Solana wallet was detected. Install a wallet that supports Wallet Standard sign-in, then reload."
        : `${label} was not detected. Install it, then reload this page.`
    );
  }, 1500);

  window.setInterval(() => {
    if (!found() || !go) return;
    go.hidden = false;
    if (missing) missing.hidden = true;
  }, 300);

  async function brainAgrees(proof, signatureB64) {
    const cfg = window.VALHALLA_SITE || {};
    const brain = String(cfg.BRAIN_URL || "").trim();
    if (!brain) return true;
    const response = await fetch(`${brain.replace(/\/$/, "")}/v1/siws/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pubkey: proof.address,
        message: proof.message,
        signature: signatureB64,
      }),
    });
    return response.ok;
  }

  function toB64(bytes) {
    let raw = "";
    for (const byte of bytes) raw += String.fromCharCode(byte);
    return btoa(raw);
  }

  async function handOff(proof) {
    const signature = toB64(proof.signature);
    const payload = {
      type: "siws",
      address: proof.address,
      message: proof.message,
      signature,
      nonce: proof.nonce,
    };
    const ext = params.get("ext");
    if (ext && window.chrome && chrome.runtime && chrome.runtime.sendMessage) {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage(ext, payload, () => resolve());
      });
    } else if (window.chrome && chrome.runtime && chrome.runtime.id) {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage(payload, () => resolve());
      });
    }
    if (window.opener) window.opener.postMessage(payload, "https://valhalla-app.xyz");
    say(
      `Signed in. Address ends in ${proof.address.slice(-4)}. Return to the Valhalla popup. Nothing was sent.`
    );
  }

  go?.addEventListener("click", async () => {
    go.disabled = true;
    try {
      const standard = ValhallaConnect.pickNamed(wallets, which);
      const adapter = standard
        ? await ValhallaConnect.adapterFromStandard(standard)
        : await ValhallaConnect.adapterFromInjected(injected(), label);
      if (!adapter) {
        say(`${label} is not available yet.`);
        go.disabled = false;
        return;
      }
      const now = Date.now();
      const proof = await ValhallaConnect.signInWithAdapter(adapter, nacl, {
        domain: location.host,
        nonce: crypto.randomUUID(),
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 5 * 60 * 1000).toISOString(),
      });
      const agreed = await brainAgrees(proof, toB64(proof.signature));
      if (!agreed) {
        say("The sign-in was not accepted.");
        go.disabled = false;
        return;
      }
      await handOff(proof);
    } catch (err) {
      say(err instanceof Error ? err.message : "The sign-in was not accepted.");
      go.disabled = false;
    }
  });
})();
