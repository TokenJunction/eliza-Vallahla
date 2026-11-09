(function () {
  "use strict";

  var config = (window.VALHALLA_SITE || {}).VALOS || {};
  var status = config.STATUS === "verified" ? "Verified identity configured" : "Planned · unverified";

  function text(id, value, fallback) {
    var node = document.getElementById(id);
    if (node) node.textContent = value || fallback;
  }

  function profileUrl(value) {
    if (typeof value !== "string" || !value) return "";
    try {
      var url = new URL(value);
      var reserved = ["intent", "home", "i", "messages", "search", "explore", "settings"];
      var handle = url.pathname.replace(/^\/|\/$/g, "");
      if (url.protocol !== "https:" || !["x.com", "www.x.com"].includes(url.hostname) ||
          url.search || url.hash || !/^[A-Za-z0-9_]{1,15}$/.test(handle) ||
          reserved.includes(handle.toLowerCase())) return "";
      return url.href;
    } catch (error) {
      return "";
    }
  }

  text("token-status", status, "Planned · unverified");
  text("token-status-detail", status, "Planned · unverified");
  text("token-network", config.NETWORK, "Not provided");
  text("token-address", config.MINT_ADDRESS, "Not provided");

  var explorer = document.getElementById("token-explorer");
  if (explorer && config.STATUS === "verified" && config.NETWORK && config.MINT_ADDRESS &&
      typeof config.EXPLORER_URL === "string" && /^https:\/\/[^/]+/i.test(config.EXPLORER_URL)) {
    var link = document.createElement("a");
    link.href = config.EXPLORER_URL;
    link.rel = "noopener noreferrer";
    link.target = "_blank";
    link.textContent = "Open configured explorer";
    explorer.replaceChildren(link);
  }

  var profile = config.X_PROFILE_OWNER_CONFIRMED === true ? profileUrl(config.X_PROFILE_URL) : "";
  var profileLink = document.getElementById("x-profile-link");
  if (profile && profileLink) {
    profileLink.href = profile;
    var handle = typeof config.X_HANDLE === "string" && /^@?[A-Za-z0-9_]{1,15}$/.test(config.X_HANDLE)
      ? config.X_HANDLE
      : "";
    profileLink.textContent = handle ? "Follow " + handle + " on X" : "Follow the confirmed ValhallaOS profile on X";
    profileLink.hidden = false;
  }
  text("x-profile-note", profile
    ? "Owner confirmation is configured; review the exact profile URL before publication."
    : "", profile ? "" : "X profile link is unavailable until the owner confirms the exact profile and configures it.");

  var shareLink = document.getElementById("x-share-link");
  var draft = document.getElementById("x-post-draft");
  var canonical = document.querySelector('link[rel="canonical"]');
  var shareText = typeof config.X_SHARE_TEXT === "string" && config.X_SHARE_TEXT
    ? config.X_SHARE_TEXT
    : "ValOS token identity and utility are unverified. No purchase is available.";
  if (draft) draft.value = shareText;
  if (shareLink && canonical && canonical.href) {
    shareLink.href = "https://x.com/intent/post?text=" + encodeURIComponent(shareText + " " + canonical.href);
    shareLink.hidden = false;
  }

  var copy = document.getElementById("x-copy-button");
  var copyNote = document.getElementById("x-copy-note");
  if (copy && draft) {
    copy.addEventListener("click", function () {
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        if (copyNote) copyNote.textContent = "Clipboard unavailable. Select and copy the draft manually; nothing was posted.";
        return;
      }
      navigator.clipboard.writeText(draft.value).then(function () {
        if (copyNote) copyNote.textContent = "Draft copied. It has not been posted or pinned.";
      }, function () {
        if (copyNote) copyNote.textContent = "Copy failed. Select and copy the draft manually; nothing was posted.";
      });
    });
  }
})();
