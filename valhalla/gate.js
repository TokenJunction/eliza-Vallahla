import { accessRequest, healthReady, normalizeAccess } from "./access.js";
import { serviceOrigin } from "./origins.js";

var desktop = document.getElementById("desktop");
var gate = document.getElementById("session-gate");
var ascent = document.getElementById("ascent");
var status = document.getElementById("session-gate-status");
var ready = document.getElementById("ascent-ready");
var nameInput = document.getElementById("ascent-name");
var preview = document.getElementById("preview-banner");
var ascentBanner = document.getElementById("ascent-banner");

function localPreview() {
  var host = location.hostname;
  if (host !== "localhost" && host !== "127.0.0.1") return false;
  return new URLSearchParams(location.search).get("fixture") === "preview";
}

function showAscent() {
  if (gate) gate.hidden = true;
  if (desktop) desktop.hidden = true;
  if (ascent) ascent.hidden = false;
  if (ready) ready.textContent = "Checking configured services.";
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduced && ascent) {
    ascent.classList.add("ascent-motion");
    window.setTimeout(function () {
      ascent.classList.remove("ascent-motion");
    }, 2400);
  }
  if (localPreview()) {
    if (ready) ready.textContent = "Not configured. No service was called.";
    return;
  }
  var site = window.VALHALLA_SITE || {};
  var base = serviceOrigin(site.AGENT_API_URL, location.hostname);
  if (!base) {
    if (ready) ready.textContent = "Not configured. No service was called.";
    return;
  }
  fetch(base + "/ready", {
    method: "GET",
    credentials: "omit",
    headers: { Accept: "application/json" },
  })
    .then(function (response) {
      return response.json().then(function (body) {
        return { httpOk: response.ok, body: body };
      });
    })
    .then(function (result) {
      if (ready) {
        ready.textContent = result.httpOk && healthReady(result.body)
          ? "Service reports ready."
          : "Service is not operational.";
      }
    })
    .catch(function () {
      if (ready) ready.textContent = "The service check could not be reached.";
    });
}

function enterDesk() {
  var label = nameInput ? nameInput.value : "";
  try {
    localStorage.setItem("valhalla-os-display-name", label);
  } catch (error) {
    label = nameInput ? nameInput.value : "";
  }
  var shown = document.getElementById("display-name");
  if (!shown) {
    shown = document.createElement("p");
    shown.id = "display-name";
    var heading = document.querySelector(".desktop-heading");
    if (heading) heading.appendChild(shown);
  }
  shown.textContent = label;
  if (ascent) ascent.hidden = true;
  if (desktop) desktop.hidden = false;
  var trading = document.querySelector('[data-open="trading"]');
  if (trading) trading.click();
}

var skip = document.getElementById("ascent-skip");
if (skip) skip.addEventListener("click", enterDesk);

if (desktop) desktop.hidden = true;

if (localPreview()) {
  if (ascentBanner) {
    ascentBanner.hidden = false;
    ascentBanner.textContent = "Preview fixture, no provider";
  }
  if (preview) {
    preview.hidden = false;
    preview.textContent = "Preview fixture, no provider";
  }
  if (status) status.textContent = "Preview fixture, no provider";
  showAscent();
} else {
  var token = "";
  try {
    token = sessionStorage.getItem("valhalla-auth-token") || "";
  } catch (error) {
    token = "";
  }
  var request = accessRequest(window.VALHALLA_SITE || {}, token, location.hostname);
  if (!request) {
    if (status) {
      status.textContent =
        "Sign in on the existing Valhalla site. This desk does not treat a cookie as a session.";
    }
  } else {
    fetch(request.url, {
      method: "GET",
      credentials: request.credentials,
      headers: request.headers,
    })
      .then(function (response) {
        return response.json().then(function (body) {
          return { httpOk: response.ok, body: body };
        });
      })
      .then(function (result) {
        var access = result.httpOk ? normalizeAccess(result.body) : { ok: false };
        if (!access.ok) {
          if (status) {
            status.textContent =
              "Sign-in was not accepted. Use the existing Valhalla sign-in. This desk stays closed.";
          }
          return;
        }
        var note = document.getElementById("session-note");
        if (note) {
          note.textContent = access.leader
            ? "Server reports leader. This page does not grant that role."
            : "Signed in. This page does not grant admin.";
        }
        showAscent();
      })
      .catch(function () {
        if (status) {
          status.textContent =
            "The sign-in check could not be reached. This desk stays closed.";
        }
      });
  }
}
