import { normalizeAccess } from "./access.js";

var desktop = document.getElementById("desktop");
var gate = document.getElementById("session-gate");
var status = document.getElementById("session-gate-status");

if (desktop) desktop.hidden = true;

fetch("/auth/access", { method: "GET", credentials: "include" })
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
          "Sign-in is required. Use the existing Valhalla sign-in. This desk stays closed.";
      }
      return;
    }
    if (desktop) desktop.hidden = false;
    if (gate) gate.hidden = true;
    var note = document.getElementById("session-note");
    if (note) {
      note.textContent = access.leader
        ? "Server reports leader. This page does not grant that role."
        : "Signed in. This page does not grant admin.";
    }
  })
  .catch(function () {
    if (status) {
      status.textContent =
        "The sign-in check could not be reached. This desk stays closed.";
    }
  });
