(function () {
  var root = document.getElementById('os-loader');
  var video = document.getElementById('os-loader-video');
  var still = document.getElementById('os-loader-still');
  var button = document.getElementById('os-loader-continue');
  if (!root || !video) return;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function finish() {
    root.hidden = true;
    video.pause();
  }

  if (reduce) {
    video.hidden = true;
    if (still) still.hidden = false;
    if (button) {
      button.hidden = false;
      button.addEventListener('click', finish);
    }
    return;
  }

  var source = document.createElement('source');
  source.src = '/media/heaven-loop.mp4';
  source.type = 'video/mp4';
  video.appendChild(source);
  video.muted = true;
  video.playsInline = true;
  var started = Date.now();
  function closeWhenReady() {
    if (Date.now() - started > 1600) finish();
    else window.setTimeout(closeWhenReady, 200);
  }
  var pending = video.play();
  if (pending && typeof pending.then === 'function') {
    pending.then(closeWhenReady).catch(function () {
      video.hidden = true;
      if (still) still.hidden = false;
      if (button) {
        button.hidden = false;
        button.addEventListener('click', finish);
      }
    });
  } else closeWhenReady();
})();
