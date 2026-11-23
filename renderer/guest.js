'use strict';
(() => {
  const token = location.pathname.split('/')[2];
  const form = document.querySelector('#upload-form');
  const fileInput = document.querySelector('#file');
  const send = document.querySelector('#send');
  const choices = document.querySelector('#choices');
  const status = document.querySelector('#status');
  let pendingUploadId = null;

  async function upload() {
    const file = fileInput.files[0];
    if (!file) return;
    send.disabled = true;
    status.textContent = 'Sending…';
    choices.hidden = true;
    const body = new FormData();
    body.append('file', file, file.name);
    try {
      const response = await fetch(location.pathname, { method: 'POST', body });
      const result = await response.json();
      if (result.error === 'DUPLICATE') {
        pendingUploadId = result.uploadId;
        document.querySelector('#duplicate-name').textContent = `“${result.name}” already exists. Choose what to do:`;
        choices.hidden = false;
        status.textContent = '';
      } else if (result.ok) {
        status.textContent = result.skipped ? 'Skipped. No file was changed.' : 'File sent to the PC’s temporary Review folder.';
        fileInput.value = '';
      } else {
        status.textContent = result.error || 'Could not send the file.';
      }
    } catch (_) {
      status.textContent = 'Could not reach the PC. Check that both devices are on the same Wi-Fi.';
    } finally {
      send.disabled = false;
    }
  }

  form.addEventListener('submit', (event) => { event.preventDefault(); upload(); });
  choices.addEventListener('click', async (event) => {
    const action = event.target.dataset.action;
    if (!action || !pendingUploadId) return;
    choices.hidden = true;
    status.textContent = action === 'skip' ? 'Skipping…' : 'Applying choice…';
    try {
      const response = await fetch(`${location.pathname}/resolve/${pendingUploadId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
      });
      const result = await response.json();
      status.textContent = result.ok ? (result.skipped ? 'Skipped. No file was changed.' : 'File received.') : (result.error || 'Could not finish the upload.');
      if (result.ok) { pendingUploadId = null; fileInput.value = ''; }
    } catch (_) { status.textContent = 'Could not reach the PC. Your choice can be retried while this page remains open.'; }
  });
})();
