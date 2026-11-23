'use strict';
(() => {
  const { $, el } = window.UI;
  const $$ = (s) => document.querySelectorAll(s);
  const TOGGLES = ['sortByType', 'notify', 'startOnLogin'];

  $('#back-history')?.addEventListener('click', () => window.api.openWindow('history'));

  let cachedInstalledApps = [];
  let currentLaunchers = [];

  // Tab switching
  $$('.settings-nav').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      $$('.settings-nav').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      $$('.tab-pane').forEach((p) => { p.hidden = true; });
      const targetPane = $(`#pane-${tab}`);
      if (targetPane) targetPane.hidden = false;
    });
  });

  function renderApprovedFolders(folders) {
    const box = $('#folders-list'); if (!box) return; box.replaceChildren();
    const list = Array.isArray(folders) ? folders : [];
    if (!list.length) { box.append(el('p', { class: 'mut small pt6' }, 'No custom folders added. Only the Tandem folder is accessible.')); return; }
    for (const f of list) {
      box.append(el('div', { class: 'dev mt6' },
        el('div', {}, el('div', { class: 'bold small' }, f.name), el('div', { class: 'small mut path' }, f.path)),
        el('button', { class: 'btn danger', onclick: async () => {
          renderApprovedFolders(await window.api.removeApprovedFolder(f.id));
        } }, 'Remove')));
    }
  }

  function renderLaunchers(launchers) {
    const box = $('#launchers-list'); if (!box) return; box.replaceChildren();
    const list = Array.isArray(launchers) ? launchers : [];
    currentLaunchers = list;
    if (!list.length) { box.append(el('p', { class: 'mut small pt6' }, 'No approved apps or shortcuts added yet.')); return; }
    for (const l of list) {
      const iconImg = el('img', {
        class: 'app-icon',
        src: l.iconDataUrl || '',
        alt: '',
      });
      box.append(el('div', { class: 'dev mt6' },
        el('div', { class: 'hrow' },
          iconImg,
          el('div', {}, el('div', { class: 'bold small' }, l.name), el('div', { class: 'small mut path' }, l.path || l.appId))
        ),
        el('button', { class: 'btn danger', onclick: async () => {
          renderLaunchers(await window.api.removeLauncher(l.id));
        } }, 'Remove')));
    }
  }

  function renderInstalledAppsPicker(query = '') {
    const box = $('#apps-list-box'); if (!box) return;
    box.replaceChildren();
    const q = query.toLowerCase().trim();
    const filtered = cachedInstalledApps.filter((a) => !q || a.name.toLowerCase().includes(q) || (a.appId && a.appId.toLowerCase().includes(q)));
    if (!filtered.length) {
      box.append(el('p', { class: 'mut small empty-picker' }, 'No matching applications found.'));
      return;
    }
    for (const app of filtered) {
      const isAdded = currentLaunchers.some((l) => (l.appId || l.path || '').toLowerCase() === (app.appId || app.path || '').toLowerCase());
      const addBtn = el('button', {
        class: 'btn primary',
        disabled: isAdded,
        onclick: async () => {
          addBtn.disabled = true;
          addBtn.textContent = 'Adding…';
          const updated = await window.api.addApprovedApp(app);
          renderLaunchers(updated);
          $('#apps-dialog')?.close();
        }
      }, isAdded ? 'Added' : '+ Add');

      const iconImg = el('img', {
        class: 'app-icon',
        src: app.iconDataUrl || '',
        alt: '',
      });

      const row = el('div', { class: 'app-item-row' },
        el('div', { class: 'hrow grow' },
          iconImg,
          el('div', { class: 'app-item-info' },
            el('div', { class: 'bold small' }, app.name),
            el('div', { class: 'small mut path' }, app.appId)
          )
        ),
        addBtn
      );
      box.append(row);
    }
  }

  async function openInstalledAppsDialog() {
    const dlg = $('#apps-dialog');
    if (!dlg) return;
    dlg.showModal();
    const loading = $('#apps-loading');
    const listBox = $('#apps-list-box');
    const searchInput = $('#apps-search');
    if (searchInput) searchInput.value = '';

    if (cachedInstalledApps.length) {
      if (loading) loading.hidden = true;
      if (listBox) listBox.hidden = false;
      renderInstalledAppsPicker();
      return;
    }

    if (loading) loading.hidden = false;
    if (listBox) listBox.hidden = true;
    try {
      cachedInstalledApps = await window.api.listInstalledApps();
      if (loading) loading.hidden = true;
      if (listBox) listBox.hidden = false;
      renderInstalledAppsPicker();
    } catch {
      if (loading) loading.textContent = 'Could not load applications. Use "Browse File" instead.';
    }
  }

  function showSettings(s) {
    $('#folder').textContent = s.saveRoot;
    for (const k of TOGGLES) $('#' + k).checked = !!s[k];
    $('#tempRetentionHours').value = String(s.tempRetentionHours || 24);
    renderApprovedFolders(s.approvedFolders);
    renderLaunchers(s.launchers);
  }

  async function loadDevices() {
    const { devices } = await window.api.listDevices();
    const box = $('#devices'); box.replaceChildren();
    if (!devices.length) { box.append(el('p', { class: 'mut pt8' }, 'No phones paired yet.')); return; }
    for (const d of devices) {
      box.append(el('div', { class: 'dev' },
        el('div', {}, el('div', { class: 'bold' }, d.name), el('div', { class: 'small mut' }, `Paired ${new Date(d.pairedAt).toLocaleDateString()}`)),
        el('button', { class: 'btn danger', onclick: async () => {
          if (window.confirm(`Revoke "${d.name}"? It will no longer be able to send files here.`)) await window.api.revokeDevice(d.id);
        } }, 'Revoke')));
    }
  }

  async function load() {
    showSettings(await window.api.getSettings());
    await loadDevices();
    const i = await window.api.appInfo();
    $('#addr').textContent = i.addresses.length ? i.addresses.map((a) => `${a}:${i.port}`).join('   ') : 'No network connection';
    $('#fp').textContent = i.fingerprint;
    $('#ver').textContent = `${i.deviceName} · Tandem ${i.version}`;
    const aboutVer = $('#about-ver');
    if (aboutVer) aboutVer.textContent = `Version ${i.version}`;
    $('#login-note').hidden = i.packaged;
  }

  const checkUpdatesBtn = $('#check-updates-btn');
  checkUpdatesBtn?.addEventListener('click', async () => {
    checkUpdatesBtn.disabled = true;
    checkUpdatesBtn.textContent = 'Checking…';
    const statusTitle = $('#update-status-title');
    const statusDesc = $('#update-status-desc');
    try {
      const res = await window.api.checkUpdate();
      if (res && res.updateAvailable) {
        if (statusTitle) statusTitle.textContent = `Update available: ${res.latestVersion || res.latestCommit}`;
        if (statusDesc) statusDesc.textContent = 'A newer desktop release is ready to download.';
        checkUpdatesBtn.textContent = res.downloaded ? 'Installing…' : 'Download & Install';
        checkUpdatesBtn.disabled = false;
        checkUpdatesBtn.onclick = async () => {
          checkUpdatesBtn.disabled = true;
          checkUpdatesBtn.textContent = 'Downloading…';
          const applyRes = await window.api.applyUpdate();
          if (applyRes && applyRes.success) {
            if (statusTitle) statusTitle.textContent = 'Update downloaded';
            if (statusDesc) statusDesc.textContent = applyRes.message || 'Tandem is restarting to install the update.';
            checkUpdatesBtn.textContent = 'Restarting…';
            checkUpdatesBtn.disabled = true;
          } else {
            checkUpdatesBtn.textContent = 'Retry';
            checkUpdatesBtn.disabled = false;
            alert('Update error: ' + (applyRes?.error || 'Unknown error'));
          }
        };
      } else if (res?.checkFailed) {
        if (statusTitle) statusTitle.textContent = 'Could not check for updates';
        if (statusDesc) statusDesc.textContent = res.message || 'Check your network connection and try again.';
        checkUpdatesBtn.textContent = 'Check Again';
        checkUpdatesBtn.disabled = false;
      } else {
        if (statusTitle) statusTitle.textContent = 'Tandem is up to date';
        if (statusDesc) statusDesc.textContent = `Current version: ${res?.currentVersion || res?.currentCommit || 'latest'}`;
        checkUpdatesBtn.textContent = 'Check Again';
        checkUpdatesBtn.disabled = false;
      }
    } catch (err) {
      checkUpdatesBtn.textContent = 'Check Again';
      checkUpdatesBtn.disabled = false;
      alert('Error checking for updates: ' + err.message);
    }
  });

  for (const k of TOGGLES) $('#' + k).addEventListener('change', async (e) => showSettings(await window.api.setSettings({ [k]: e.target.checked })));
  $('#tempRetentionHours')?.addEventListener('change', async (e) => showSettings(await window.api.setSettings({ tempRetentionHours: Number(e.target.value) })));
  $('#change').addEventListener('click', async () => showSettings(await window.api.chooseFolder()));
  $('#open').addEventListener('click', () => window.api.openFolder());
  $('#add-folder')?.addEventListener('click', async () => renderApprovedFolders(await window.api.addApprovedFolder()));
  $('#add-launcher')?.addEventListener('click', async () => renderLaunchers(await window.api.addLauncher()));
  $('#choose-app-btn')?.addEventListener('click', openInstalledAppsDialog);
  $('#close-apps-dialog')?.addEventListener('click', () => $('#apps-dialog')?.close());
  $('#cancel-apps-dialog')?.addEventListener('click', () => $('#apps-dialog')?.close());
  $('#apps-search')?.addEventListener('input', (e) => renderInstalledAppsPicker(e.target.value));
  $('#pair').addEventListener('click', () => window.api.openWindow('pair'));
  $('#send-phone')?.addEventListener('click', () => window.api.sendFilesToPhone());

  window.api.on('devices-changed', loadDevices);
  window.api.on('settings-changed', async () => showSettings(await window.api.getSettings()));
  load();
})();
