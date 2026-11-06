export var ALLOWED_API_ORIGINS = [
  "https://auth.valhalla-app.xyz",
  "https://eliza-valhalla.onrender.com",
  "https://valhalla-auth.valhalla-app.workers.dev",
];

function localPage(pageHost) {
  return pageHost === "localhost" || pageHost === "127.0.0.1";
}

export function serviceOrigin(raw, pageHost) {
  var url;
  try {
    url = new URL(String(raw || "").replace(/\/$/, ""));
  } catch (error) {
    return "";
  }
  if (url.username || url.password) return "";
  if (url.protocol === "https:" && ALLOWED_API_ORIGINS.indexOf(url.origin) >= 0) return url.origin;
  if (localPage(pageHost) && url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
    return url.origin;
  }
  return "";
}
