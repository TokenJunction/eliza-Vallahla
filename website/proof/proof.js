(function () {
  var more = document.getElementById('proof-more');
  var numbers = document.getElementById('proof-numbers');
  function text(id, value) {
    var node = document.getElementById(id);
    if (node) node.textContent = value;
  }
  function line(value) {
    var item = document.createElement('li');
    item.textContent = value;
    return item;
  }
  if (more && numbers) {
    more.addEventListener('click', function () {
      var open = numbers.hidden;
      numbers.hidden = !open;
      more.textContent = open ? 'Hide the numbers' : 'Show the numbers';
      more.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }
  fetch('/api/proof', { cache: 'no-store' }).then(function (response) {
    if (!response.ok) throw new Error('unavailable');
    return response.json();
  }).then(function (body) {
    var delivery = body.delivery || {};
    var tamper = body.tamper || {};
    text('proof-status', body.online ? 'Checked. The time is below.' : 'One or more pages did not answer.');
    text('proof-online', body.online ? 'Online' : 'Not fully online');
    text('proof-speed', body.online ? body.speed : '—');
    text('proof-intact', delivery.intact + '/' + delivery.total);
    text('proof-tamper', tamper.caught && tamper.verified === false ? 'Yes' : 'No');
    text('proof-time', body.checkedAt || '—');
    if (!numbers) return;
    numbers.replaceChildren();
    (body.checks || []).forEach(function (row) {
      numbers.appendChild(line(row.name + ': ' + row.status + ' in ' + row.ms + ' ms'));
    });
    numbers.appendChild(line('Signed packages: median ' + Math.round(delivery.medianUs) + ' µs, p95 ' + Math.round(delivery.p95Us) + ' µs, lost ' + delivery.lost));
    if (body.region) numbers.appendChild(line('Region: ' + body.region));
  }).catch(function () {
    text('proof-status', 'Not checked.');
    text('proof-online', 'Not checked');
  });
})();
