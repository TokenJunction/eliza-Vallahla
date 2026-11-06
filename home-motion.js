(function () {
  var scene = document.getElementById("hero-scene");
  var video = document.getElementById("hero-video");
  var toggle = document.getElementById("hero-motion");
  if (!scene || !video || !toggle) return;

  var reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  var sourcesReady = false;

  function saveDataOn() {
    var connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    return !!(connection && connection.saveData);
  }

  function autoplayAllowed() {
    return !reduceQuery.matches && !saveDataOn();
  }

  function attachSources() {
    if (sourcesReady) return;
    sourcesReady = true;
    var mp4 = document.createElement("source");
    mp4.src = "/assets/hero-ascent.mp4";
    mp4.type = "video/mp4";
    video.appendChild(mp4);
    video.preload = "metadata";
    video.load();
  }

  function setPlaying(playing) {
    scene.classList.toggle("is-playing", playing);
    toggle.hidden = false;
    toggle.setAttribute("aria-pressed", playing ? "true" : "false");
    toggle.textContent = playing ? "Pause motion" : "Play motion";
  }

  function hideControl() {
    toggle.hidden = true;
    video.pause();
    scene.classList.remove("is-playing");
  }

  function startMotion() {
    attachSources();
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    var pending = video.play();
    if (pending && typeof pending.then === "function") {
      pending.then(function () { setPlaying(true); }).catch(function () { hideControl(); });
    } else if (video.paused) {
      hideControl();
    } else {
      setPlaying(true);
    }
  }

  function stopMotion() {
    video.pause();
    setPlaying(false);
  }

  toggle.addEventListener("click", function () {
    if (scene.classList.contains("is-playing")) stopMotion();
    else startMotion();
  });

  video.addEventListener("pause", function () { setPlaying(false); });
  video.addEventListener("playing", function () { setPlaying(true); });

  if (reduceQuery.matches) hideControl();
  else if (autoplayAllowed()) startMotion();
  else setPlaying(false);

  if (typeof reduceQuery.addEventListener === "function") {
    reduceQuery.addEventListener("change", function () {
      if (reduceQuery.matches) hideControl();
    });
  }
})();
