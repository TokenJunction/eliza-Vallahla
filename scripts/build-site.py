from pathlib import Path
import shutil

out = Path('site-build')
shutil.copytree('.', out, ignore=shutil.ignore_patterns('.git', '.github', 'site-build'))

def patch(path, old, new):
    file = out / path
    text = file.read_text()
    if text.count(old) != 1:
        raise RuntimeError(f'Unexpected source in {path}; refusing deployment')
    file.write_text(text.replace(old, new, 1))

gate = out / 'app/gate.js'
text = gate.read_text()
a = '  function mountTurnstile() {'
b = '  function termsOk() {'
assert text.count(a) == text.count(b) == 1
start, end = text.index(a), text.index(b)
assert end > start and 'turnstile.render' in text[start:end]
gate.write_text(text[:start] + '  function mountTurnstile() { markHuman(); }\n\n' + text[end:])
errors = out / 'errors.js'
text = errors.read_text()
needle = "frame.title = 'Valhalla read-only preview';"
if needle in text:
    start = text.rfind('\n(function () {', 0, text.index(needle))
    assert start > 0
    text = text[:start] + '\n'
assert 'root.ValhallaErrors = ' in text
errors.write_text(text)

patch('connect-core.js', 'const result = await connect();', 'const result = await connect.call(wallet.features["standard:connect"]);')
patch('connect-core.js', 'const account = accounts[0];', 'const account = accounts.find((item) => isPubkey(item.address) && (!item.chains || item.chains.some((chain) => chain.startsWith("solana:"))) && (!item.features || item.features.includes("solana:signMessage")));')
patch('connect-core.js', 'const signed = await sign([{ account, message: bytes }]);', 'const signed = await sign.call(wallet.features["solana:signMessage"], { account, message: bytes });')
patch('connect-core.js', 'const pattern = which === "solflare" ? /solflare/i : /phantom/i;', 'const pattern = ({ solflare: /solflare/i, phantom: /phantom/i, backpack: /backpack/i })[which];\n    if (!pattern) return null;')

path = out / 'site-wallet.js'
text = path.read_text()
start = text.index('  window.addEventListener("wallet-standard:register-wallet",')
end = text.index('\n  function injected(', start)
text = text[:start] + '''  function register() {
    var wallets = Array.prototype.slice.call(arguments);
    wallets.forEach(function (wallet) {
      if (wallet && wallet.features && standard.indexOf(wallet) < 0) standard.push(wallet);
    });
    return function () {
      wallets.forEach(function (wallet) { var i = standard.indexOf(wallet); if (i >= 0) standard.splice(i, 1); });
    };
  }
  var walletApp = Object.freeze({ register: register });
  window.addEventListener("wallet-standard:register-wallet", function (event) {
    if (typeof event.detail === "function") event.detail(walletApp);
  });
''' + text[end:]
path.write_text(text)
patch('site-wallet.js', 'window.dispatchEvent(new Event("wallet-standard:app-ready"));', 'window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: walletApp }));')
patch('site-wallet.js', 'var pending = named\n      ? root.ValhallaConnect.adapterFromStandard(named)\n      : root.ValhallaConnect.adapterFromInjected(provider, id);', 'var pending = provider && typeof provider.connect === "function" && typeof provider.signMessage === "function"\n      ? root.ValhallaConnect.adapterFromInjected(provider, id)\n      : root.ValhallaConnect.adapterFromStandard(named);')
patch('site-wallet.js', '''      button.addEventListener("click", function () {
        continueWith(choice.id).catch(function (err) {
          var note = document.getElementById("loginNote");
          if (note) note.textContent = err && err.message ? err.message : "The sign-in was not accepted.";
        });
      });''', '''      button.className = "valhalla-wallet-button";
      button.dataset.wallet = choice.id;
      button.style.cssText = "display:flex;align-items:center;justify-content:flex-start;gap:12px;width:100%;min-height:48px;padding:12px 16px;margin:8px 0;border:1px solid #a67c3e;border-radius:10px;background:#171b22;color:#f4ead8;font:600 16px system-ui;cursor:pointer";
      button.addEventListener("click", function () {
        if (host.dataset.busy === "1") return;
        host.dataset.busy = "1";
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        var label = button.querySelector("span");
        label.textContent = "Opening " + (choice.id === "other" ? "wallet" : choice.id) + "...";
        var note = document.getElementById("walletNote") || document.getElementById("loginNote");
        if (note) { note.setAttribute("role", "status"); note.textContent = "Approve the connection and sign-in message in your wallet. No transaction is requested."; }
        var pending;
        try { pending = continueWith(choice.id); } catch (err) { pending = Promise.reject(err); }
        Promise.resolve(pending).then(function (proof) {
          if (note) note.textContent = proof && proof.pubkey ? "Wallet connected: ..." + proof.pubkey.slice(-4) : "Wallet app or download page opened. Return here to continue.";
        }).catch(function (err) {
          if (note) note.textContent = err && err.message ? err.message : "Connection was not completed. You can try again.";
        }).finally(function () {
          host.dataset.busy = "0";
          button.disabled = false;
          button.removeAttribute("aria-busy");
          label.textContent = choice.label;
        });
      });''')
assert (out / 'assets/mark.svg').is_file()
assert (out / 'assets/mech.jpg').is_file()
assert (out / 'app/index.html').read_bytes() == Path('app/index.html').read_bytes()
