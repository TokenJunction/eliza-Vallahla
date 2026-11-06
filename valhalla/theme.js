var key = "valhalla-os-theme";
var allowed = ["dark", "light", "colorblind"];

function apply(id) {
  var desktop = document.getElementById("desktop");
  if (!desktop) return;
  if (allowed.indexOf(id) < 0) id = "dark";
  desktop.dataset.theme = id;
  var radios = document.querySelectorAll('input[name="desk-theme"]');
  Array.prototype.forEach.call(radios, function (input) {
    input.checked = input.value === id;
  });
}

var saved = "dark";
try {
  saved = localStorage.getItem(key) || "dark";
} catch (error) {
  saved = "dark";
}
apply(saved);

var radios = document.querySelectorAll('input[name="desk-theme"]');
Array.prototype.forEach.call(radios, function (input) {
  input.addEventListener("change", function () {
    if (!input.checked) return;
    apply(input.value);
    try {
      localStorage.setItem(key, input.value);
    } catch (error) {
      apply(input.value);
    }
  });
});
