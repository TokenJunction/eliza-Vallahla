(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ValhallaAccount = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var RANK = { FREE: 1, PRO: 2, UNLIMITED: 3 };
  var TOOL_RANK = {
    status: 1,
    assistant: 1,
    wallet: 1,
    memory: 2,
    web: 2,
    paper: 2,
    monitor: 3
  };

  function namedLevel(value) {
    var text = String(value || '').trim().toUpperCase();
    return RANK[text] ? text : '';
  }

  function metadata(user) {
    if (!user || typeof user !== 'object') return {};
    if (user.app_metadata && typeof user.app_metadata === 'object') return user.app_metadata;
    if (user.appMetadata && typeof user.appMetadata === 'object') return user.appMetadata;
    var claim = user['https://valhalla-app.xyz/app_metadata'];
    return claim && typeof claim === 'object' ? claim : {};
  }

  function levelFromUser(user) {
    var meta = metadata(user);
    var features = Array.isArray(meta.features) ? meta.features : [];
    var named = namedLevel(meta.plan || meta.level || meta.accountLevel);
    var fromFeature = '';
    features.forEach(function (feature) {
      var level = namedLevel(feature);
      if (level && (!fromFeature || RANK[level] > RANK[fromFeature])) fromFeature = level;
    });
    var level = named && fromFeature ? (RANK[named] > RANK[fromFeature] ? named : fromFeature) : (named || fromFeature);
    if (!level) {
      return { level: 'FREE', configured: false, note: 'Account level: FREE. Plans are not configured.' };
    }
    return { level: level, configured: true, note: 'Account level: ' + level + '.' };
  }

  function toolAllowed(level, tool) {
    var rank = RANK[namedLevel(level)] || 0;
    var need = TOOL_RANK[tool];
    if (!need) return false;
    return rank >= need;
  }

  return { levelFromUser: levelFromUser, toolAllowed: toolAllowed };
});
