import { publicWebUrl } from "./access.js";

var input = document.getElementById("browser-address");
var open = document.getElementById("browser-open");
var note = document.getElementById("browser-note");
var history = document.getElementById("browser-history");
var frame = document.getElementById("browser-frame");

if (frame) frame.src = "about:blank";

function remember(display) {
  if (!history) return;
  var item = document.createElement("li");
  item.textContent = display;
  history.appendChild(item);
}

if (open && input) {
  open.addEventListener("click", function () {
    var result = publicWebUrl(input.value);
    if (result.http) {
      note.textContent = result.message;
      if (!window.confirm("Open this HTTP address in a new tab? It is not embedded.")) return;
      window.open(result.url, "_blank", "noopener,noreferrer");
      note.textContent = "Opened in a new tab after confirmation.";
      remember(result.display);
      return;
    }
    if (!result.ok) {
      note.textContent = result.message;
      return;
    }
    window.open(result.url, "_blank", "noopener,noreferrer");
    note.textContent = "Opened in a new tab. This desk does not embed that site.";
    remember(result.display);
  });
}
