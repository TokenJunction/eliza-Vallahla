(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ValhallaAuth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
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
      cacheLocation: 'memory',
      useRefreshTokens: false,
      authorizationParams: { redirect_uri: redirect }
    };
  }

  function loadSdk() {
    return import('https://cdn.jsdelivr.net/npm/@auth0/auth0-spa-js@2.30.0/+esm');
  }

  function createClient(config, href) {
    var options = clientOptions(config, href);
    if (!options) return Promise.reject(new Error('Sign-in is not available yet.'));
    return loadSdk().then(function (sdk) {
      var create = sdk.createAuth0Client;
      if (typeof create !== 'function') throw new Error('Sign-in is not available yet.');
      return create(options);
    });
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
