'use strict';
(() => {
  const { $, el, fmtSize, fmtTime, svg } = window.UI;
  const FILTERS = ['All', 'Images', 'Audio', 'Video', 'Files', 'Links'];
  let items = [], devices = [], filter = 'All', query = '', pending = null, hasDevices = true, sort = 'recent', selectedDeviceId = null, view = 'list';
  const typeOf = (it) => (it.kind === 'link' ? 'Links' : it.type);
  const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };
  let previewUrl = null;

  function matches(it) {
    if (filter !== 'All' && typeOf(it) !== filter) return false;
    if (selectedDeviceId) {
      const device = devices.find((d) => d.id === selectedDeviceId);
      if (!device || (it.deviceId ? it.deviceId !== selectedDeviceId : it.from !== device.name)) return false;
    }
    const q = query.trim().toLowerCase();
    return !q || `${it.name} ${it.url || ''} ${it.from}`.toLowerCase().includes(q);
  }
  function btn(label, onclick, opts = {}) {
    return el('button', { class: 'btn' + (opts.danger ? ' danger' : '') + (opts.primary ? ' primary' : ''), disabled: !!opts.disabled, onclick }, label);
  }
  function renderFilters() {
    const nav = $('#filters'); nav.replaceChildren();
    $('#sidebar-total').textContent = `${items.length} total`;
    for (const f of FILTERS) {
      const n = f === 'All' ? items.length : items.filter((i) => typeOf(i) === f).length;
      nav.append(el('button', {
        class: 'nav' + (f === filter ? ' active' : ''),
        'data-filter': f,
        'aria-pressed': String(f === filter),
        onclick: () => { filter = f; render(); }
      },
        el('div', { class: 'nav-left' },
          svg(f, 16),
          el('span', { class: 'nav-label' }, f)
        ),
        el('span', { class: 'count-badge' }, String(n))
      ));
    }
  }
  function renderDevices() {
    const host = $('#devices');
    host.replaceChildren();
    if (!devices.length) {
      host.append(el('div', { class: 'device-empty' }, 'No phones paired yet'));
      return;
    }
    for (const device of devices) {
      const icon = el('div', { class: 'device-icon' }, svg('phone', 20));
      const active = !!device.active;
      host.append(el('button', { class: `device-card${selectedDeviceId === device.id ? ' selected' : ''}`, type: 'button', onclick: () => {
        selectedDeviceId = selectedDeviceId === device.id ? null : device.id;
        renderList(); renderDevices();
      } }, icon,
        el('div', { class: 'device-info' },
          el('strong', { class: 'device-name', title: device.name }, device.name || 'Phone'),
          el('span', { class: `device-state ${active ? 'online' : 'offline'}` }, el('i', { class: 'status-dot' }), active ? 'Connected' : 'Paired · offline')
        )
      ));
    }
  }
  function updateStorage() {
    const bytes = items.reduce((sum, item) => sum + (item.kind === 'file' && !item.missing ? (Number(item.size) || 0) : 0), 0);
    $('#storage-used').textContent = fmtSize(bytes);
    const fill = $('#storage-fill');
    const percent = bytes / (64 * 1024 ** 3) * 100;
    fill.dataset.level = !bytes ? 'empty' : percent < 10 ? 'low' : percent < 35 ? 'medium' : 'high';
  }
  function row(it) {
    const isLink = it.kind === 'link';
    const meta = [fmtTime(it.at), isLink ? hostOf(it.url) : it.type];
    if (it.temporary && it.expiresAt) meta.push(`Temporary · expires ${fmtTime(it.expiresAt)}`);
    if (it.missing) meta.push('file moved or deleted');
    const copy = (e) => {
      const b = e.currentTarget;
      window.api.copyLink(it.id).then(() => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1200); });
    };
    const ext = isLink ? '' : (it.name.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
    const canPreview = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.mp3', '.m4a', '.wav', '.ogg', '.flac', '.mp4', '.webm'].includes(ext);
    const acts = isLink
      ? [btn('Open', () => window.api.openItem(it.id)), btn('Copy', copy)]
      : [
          ...(canPreview ? [btn('Preview', () => preview(it), { disabled: it.missing })] : []),
          btn('Open', () => window.api.openItem(it.id), { disabled: it.missing }),
          btn('Folder', () => window.api.revealItem(it.id), { disabled: it.missing }),
        ];
    acts.push(btn('Remove', () => askRemove(it), { danger: true }));
    const badgeType = isLink ? 'link' : it.type.toLowerCase();
    return el('div', { class: 'row saved-row' },
      el('div', { class: 'file-cell' },
        el('span', { class: `badge badge-${badgeType}` }, isLink ? 'Link' : it.type),
        el('div', { class: 'grow' },
        el('div', { class: 'name', title: isLink ? it.url : it.name }, it.name),
          el('div', { class: 'small mut' }, meta.join(' · '))
        )
      ),
      el('span', { class: 'size-cell' }, isLink ? '—' : fmtSize(it.size || 0)),
      el('span', { class: 'source-cell', title: it.from }, el('span', { class: 'source-mark' }, svg('phone', 13)), it.from || 'Phone'),
      el('div', { class: 'acts' }, acts));
  }
  async function preview(it) {
    const result = await window.api.previewItem(it.id);
    if (result?.error) { alert(result.error); return; }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(new Blob([new Uint8Array(result.data)], { type: result.mime }));
    const dialog = $('#preview-dialog');
    $('#preview-title').textContent = it.name;
    for (const id of ['preview-image', 'preview-audio', 'preview-video', 'preview-pdf']) {
      const node = $('#' + id); node.hidden = true; node.removeAttribute('src');
    }
    const target = result.mime === 'application/pdf' ? $('#preview-pdf')
      : result.mime.startsWith('image/') ? $('#preview-image')
      : result.mime.startsWith('audio/') ? $('#preview-audio') : $('#preview-video');
    target.src = previewUrl;
    target.hidden = false;
    dialog.showModal();
  }
  function renderList() {
    const list = $('#list'); list.replaceChildren();
    list.classList.toggle('grid-view', view === 'grid');
    $('.table-head').hidden = view === 'grid';
    const shown = items.filter(matches);
    if (sort === 'oldest') shown.sort((a, b) => new Date(a.at) - new Date(b.at));
    else if (sort === 'name') shown.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'size') shown.sort((a, b) => (b.size || 0) - (a.size || 0));
    else shown.sort((a, b) => new Date(b.at) - new Date(a.at));
    const selectedDevice = devices.find((d) => d.id === selectedDeviceId);
    $('#title').textContent = `${selectedDevice ? `${selectedDevice.name} · ` : ''}${filter === 'All' ? 'All saves' : filter}`;
    const countBadge = $('#total-count-badge');
    if (countBadge) countBadge.textContent = `${shown.length} ${shown.length === 1 ? 'item' : 'items'}`;
    if (!items.length) {
      list.append(el('div', { class: 'empty' },
        el('div', { class: 'empty-icon' }, svg('inbox', 42)),
        el('strong', {}, 'Nothing received yet'),
        hasDevices ? 'Share a file or link from your phone and choose Tandem.' : 'Pair a phone to start receiving files and links.'));
    } else if (!shown.length) {
      list.append(el('div', { class: 'empty' },
        el('div', { class: 'empty-icon' }, svg('search', 42)),
        el('strong', {}, 'No matches'),
        'Try a different search or filter.'));
    } else {
      for (const it of shown) list.append(row(it));
    }
    updateStorage();
  }
  function render() { renderFilters(); renderDevices(); renderList(); }

  function showUpdateBanner(info) {
    const banner = $('#update-banner');
    if (!banner || !info || !info.updateAvailable) {
      if (banner) banner.hidden = true;
      return;
    }
    banner.hidden = false;
    banner.replaceChildren();
    const msg = el('div', { class: 'update-banner-text' },
      svg('update', 16),
      el('span', {}, `Update available (${info.latestVersion || info.latestCommit || 'latest'}).`)
    );
    const updateBtn = el('button', {
      class: 'btn primary update-btn',
      onclick: async () => {
        updateBtn.disabled = true;
        updateBtn.textContent = 'Updating…';
        try {
          const res = await window.api.applyUpdate();
          if (res && res.success) {
            banner.replaceChildren(
              el('div', { class: 'update-banner-text' },
                svg('check', 16),
                el('span', {}, res.message || 'Update downloaded. Tandem is restarting to install it.')
              )
            );
          } else {
            updateBtn.textContent = 'Retry';
            updateBtn.disabled = false;
            alert('Update error: ' + (res?.error || 'Unknown error'));
          }
        } catch (err) {
          updateBtn.textContent = 'Retry';
          updateBtn.disabled = false;
          alert('Update error: ' + err.message);
        }
      }
    }, 'Update Now');
    const dismissBtn = el('button', {
      class: 'btn update-dismiss-btn',
      onclick: () => { banner.hidden = true; }
    }, svg('close', 14));
    banner.append(msg, el('div', { class: 'update-banner-acts' }, updateBtn, dismissBtn));
  }

  function askRemove(it) {
    pending = it;
    $('#confirm-text').textContent = `Remove "${it.name}" from history?`;
    $('#c-trash').hidden = it.kind !== 'file' || it.missing;
    const d = $('#confirm');
    if (typeof d.showModal === 'function') d.showModal();
    else if (window.confirm(`Remove "${it.name}" from history?`)) finishRemove(false);
  }
  async function finishRemove(deleteFile) {
    const it = pending; pending = null;
    $('#confirm').close?.();
    if (it) await window.api.removeItem(it.id, deleteFile);
  }

  async function load() {
    const [{ items: list }, { devices: pairedDevices }] = await Promise.all([window.api.listItems(), window.api.listDevices()]);
    items = list; devices = pairedDevices; hasDevices = devices.length > 0; render();
  }
  $('#q').addEventListener('input', (e) => { query = e.target.value; renderList(); });
  $('#c-cancel').addEventListener('click', () => { pending = null; $('#confirm').close?.(); });
  $('#c-hist').addEventListener('click', () => finishRemove(false));
  $('#c-trash').addEventListener('click', () => finishRemove(true));
  $('#open-folder').addEventListener('click', () => window.api.openFolder());
  $('#quick-receive').addEventListener('click', async () => {
    const button = $('#quick-receive'); button.disabled = true;
    try {
      const share = await window.api.startGuestReceive();
      if (share?.error) { alert(share.error); return; }
      $('#guest-qr').src = share.qr;
      $('#guest-url').textContent = share.url;
      $('#guest-expiry').textContent = `Expires at ${new Date(share.expires).toLocaleTimeString()}`;
      $('#guest-dialog').showModal();
    } finally { button.disabled = false; }
  });
  $('#guest-close').addEventListener('click', () => $('#guest-dialog').close());
  $('#preview-close').addEventListener('click', () => $('#preview-dialog').close());
  $('#preview-dialog').addEventListener('close', () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    for (const id of ['preview-image', 'preview-audio', 'preview-video', 'preview-pdf']) { const node = $('#' + id); node.removeAttribute('src'); node.hidden = true; }
  });
  $('#sort').addEventListener('change', (e) => { sort = e.target.value; renderList(); });
  document.querySelectorAll('.view-button').forEach((button) => button.addEventListener('click', () => {
    view = button.dataset.view;
    document.querySelectorAll('.view-button').forEach((b) => b.classList.toggle('active', b === button));
    renderList();
  }));
  $('#open-settings').addEventListener('click', () => window.api.openWindow('settings'));
  window.api.on('items-changed', load);
  window.api.on('devices-changed', load);
  window.api.on('app:update-available', showUpdateBanner);
  window.api.getUpdateStatus?.().then(showUpdateBanner).catch(() => {});
  setInterval(() => { load(); }, 15000); // refresh device presence and relative timestamps
  load();
})();
