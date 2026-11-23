'use strict';
(() => {
  const { $ } = window.UI;
  let timer = null;
  const setState = (text, cls = '') => { const s = $('#state'); s.textContent = text; s.className = 'status ' + cls; };

  async function start() {
    clearInterval(timer);
    $('#refresh').hidden = true; $('#done').hidden = true; $('#qr').hidden = true;
    $('#qr-msg').hidden = false; $('#qr-msg').textContent = 'Preparing…'; $('#expiry').textContent = '';
    const r = await window.api.pairStart();
    if (r.error) {
      $('#qr-msg').textContent = 'No network';
      setState('No network connection found. Connect this PC to Wi-Fi, then try again.', 'bad');
      $('#refresh').hidden = false; $('#refresh').textContent = 'Try again';
      return;
    }
    $('#qr').src = r.qr; $('#qr').hidden = false; $('#qr-msg').hidden = true;
    $('#where').textContent = `${r.name} · ${r.host}:${r.port}`;
    setState('Waiting for phone…');
    const tick = () => {
      const left = Math.max(0, Math.round((r.expires - Date.now()) / 1000));
      if (left === 0) {
        clearInterval(timer);
        $('#qr').hidden = true; $('#qr-msg').hidden = false; $('#qr-msg').textContent = 'Code expired';
        setState('This code expired.', 'bad'); $('#expiry').textContent = '';
        $('#refresh').hidden = false; $('#refresh').textContent = 'New code';
      } else {
        $('#expiry').textContent = `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      }
    };
    tick(); timer = setInterval(tick, 1000);
  }

  window.api.on('paired', (name) => {
    clearInterval(timer);
    $('#qr').hidden = true; $('#qr-msg').hidden = false; $('#qr-msg').textContent = 'Paired';
    setState(`Paired with ${name}`, 'ok'); $('#expiry').textContent = '';
    $('#refresh').hidden = true; $('#done').hidden = false;
  });
  $('#refresh').addEventListener('click', start);
  $('#done').addEventListener('click', () => window.close());
  start();
})();
