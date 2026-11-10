(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ValhallaAuth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  var DOMAIN = 'valhallaos.us.auth0.com';
  var CALLBACKS = [
    'https://valhalla-app.xyz/',
    'https://www.valhalla-app.xyz/',
    'https://valhalla-app.xyz/app/',
    'https://www.valhalla-app.xyz/app/'
  ];

  function redirectUri(href) {
    try {
      var url = new URL(href);
      var path = url.pathname === '/app' || url.pathname.indexOf('/app/') === 0 ? '/app/' : '/';
      var candidate = url.origin + path;
      return CALLBACKS.indexOf(candidate) >= 0 ? candidate : '';
    } catch (error) {
      return '';
    }
  }

  function hasCallback(search) {
    var params = new URLSearchParams(String(search || ''));
    return params.has('code') && params.has('state');
  }

  function clientOptions(config, href) {
    var redirect = redirectUri(href);
    if (!config || config.auth0 !== 'configured' || config.domain !== DOMAIN || !redirect) return null;
    if (!/^[A-Za-z0-9]{16,64}$/.test(String(config.clientId || ''))) return null;
    return {
      domain: DOMAIN,
      clientId: String(config.clientId),
      useRefreshTokens: true,
      useRefreshTokensFallback: false,
      authorizationParams: { redirect_uri: redirect }
    };
  }

  function tabCache(storage) {
    var prefix = 'valhalla-auth0.';
    return {
      set: function (key, entry) { storage.setItem(prefix + key, JSON.stringify(entry)); },
      get: function (key) {
        var raw = storage.getItem(prefix + key);
        if (!raw) return;
        try { return JSON.parse(raw); } catch (error) { return; }
      },
      remove: function (key) { storage.removeItem(prefix + key); },
      allKeys: function () {
        var keys = [];
        for (var index = 0; index < storage.length; index += 1) {
          var key = storage.key(index);
          if (key && key.indexOf(prefix) === 0) keys.push(key.slice(prefix.length));
        }
        return keys;
      }
    };
  }

  function createClient(config, href, storage) {
    var options = clientOptions(config, href);
    var sdk = root.auth0;
    var store = storage || (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
    if (!options || !sdk || typeof sdk.createAuth0Client !== 'function' || !store) {
      return Promise.reject(new Error('Sign-in is not available yet.'));
    }
    return Promise.resolve(sdk.createAuth0Client(Object.assign({}, options, { cache: tabCache(store) })));
  }

  return {
    DOMAIN: DOMAIN,
    CALLBACKS: CALLBACKS,
    logoutReturnTo: 'https://valhalla-app.xyz/',
    redirectUri: redirectUri,
    hasCallback: hasCallback,
    clientOptions: clientOptions,
    createClient: createClient
  };
});
