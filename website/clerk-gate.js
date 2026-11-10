(function (root) {
  function productionKey(config) {
    var key = config && config.clerk === 'production' ? String(config.publishableKey || '') : '';
    return key.indexOf('pk_live_') === 0 ? key : '';
  }

  function loadClerk(key) {
    return new Promise(function (resolve, reject) {
      if (!productionKey({ clerk: 'production', publishableKey: key })) {
        reject(new Error('Sign-in is not available yet.'));
        return;
      }
      if (root.Clerk && root.Clerk.loaded) {
        resolve(root.Clerk);
        return;
      }
      var script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js';
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.setAttribute('data-clerk-publishable-key', key);
      script.onload = function () {
        var clerk = root.Clerk;
        if (!clerk || typeof clerk.load !== 'function') {
          reject(new Error('Sign-in is not available yet.'));
          return;
        }
        Promise.resolve(clerk.load({ publishableKey: key })).then(function () {
          resolve(clerk);
        }, reject);
      };
      script.onerror = function () {
        reject(new Error('Sign-in is not available yet.'));
      };
      document.head.appendChild(script);
    });
  }

  root.ValhallaClerk = { productionKey: productionKey, loadClerk: loadClerk };
})(typeof globalThis !== 'undefined' ? globalThis : this);
