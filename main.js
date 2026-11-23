'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, Tray, Menu, BrowserWindow, Notification, shell, clipboard, nativeImage, dialog, ipcMain } = require('electron');
const QRCode = require('qrcode');
const { Store } = require('./src/store');
const { startServer, lanIPs } = require('./src/server');
const systemControl = require('./src/systemControl');
const updater = require('./src/updater');

if (!app.requestSingleInstanceLock()) { app.quit(); return; }

const DEFAULT_APP_ICON = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 24 24' fill='none' stroke='%230F6E6E' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='2' y='3' width='20' height='14' rx='2'/><line x1='8' y1='21' x2='16' y2='21'/><line x1='12' y1='17' x2='12' y2='21'/></svg>";

async function getFileIconDataUrl(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      const img = await app.getFileIcon(filePath, { size: 'normal' });
      return img.toDataURL();
    }
  } catch {}
  return null;
}

const WINDOWS = {
  history: { w: 980, h: 640, minW: 700, minH: 420, title: 'Tandem' },
  pair: { w: 780, h: 500, minW: 700, minH: 460, title: 'Pair with Tandem' },
};
const SETTING_TYPES = { notify: 'boolean', startOnLogin: 'boolean', sortByType: 'boolean', tempRetentionHours: 'number' };
const wins = {};
let store, server, tray;

app.on('second-instance', (_event, commandLine) => {
  const files = sendToPaths(commandLine);
  if (files.length) void queueFilesToPhones(files);
  else openWindow('history');
});
app.on('window-all-closed', () => { /* keep running in the tray */ });
app.on('before-quit', () => { server?.cancelPairing(); });

function openWindow(name) {
  const requestedView = name;
  if (name === 'settings' || name === 'history') {
    const w = wins.history;
    if (w && !w.isDestroyed()) {
      w.show(); w.focus();
      w.loadFile(path.join(__dirname, 'renderer', name === 'settings' ? 'settings.html' : 'history.html'));
      return;
    }
    name = 'history';
  }
  const cfg = WINDOWS[name];
  if (!cfg) return;
  if (wins[name] && !wins[name].isDestroyed()) { wins[name].show(); wins[name].focus(); return; }
  const w = new BrowserWindow({
    width: cfg.w, height: cfg.h, minWidth: cfg.minW, minHeight: cfg.minH, title: cfg.title,
    icon: path.join(__dirname, 'assets', 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  w.removeMenu();
  w.loadFile(path.join(__dirname, 'renderer', `${name === 'history' && requestedView === 'settings' ? 'settings' : name}.html`));
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  if (process.env.TANDEM_LOG || process.env.PHONESAVES_LOG) {
    w.webContents.on('console-message', (_e, level, msg, line, src) => console.error(`[${name}] ${msg} (${src}:${line})`));
    w.webContents.on('did-fail-load', (_e, code, desc) => console.error(`[${name}] load failed ${code} ${desc}`));
  }
  w.on('closed', () => { delete wins[name]; if (name === 'pair') server?.cancelPairing(); });
  wins[name] = w;
}
const broadcast = (ch, ...a) => { for (const w of Object.values(wins)) if (!w.isDestroyed()) w.webContents.send(ch, ...a); };

function trayLabel(it) {
  const t = it.kind === 'link' ? `Copy link: ${it.name}` : it.name;
  return t.length > 44 ? t.slice(0, 41) + '…' : t;
}
function refreshTray() {
  if (!tray) return;
  const addr = lanIPs()[0];
  const recent = store.items.slice(0, 5).map((it) => ({
    label: trayLabel(it),
    click: () => (it.kind === 'link' ? clipboard.writeText(it.url) : shell.showItemInFolder(it.path)),
  }));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: addr ? `Tandem · Listening on ${addr}:${server.port}` : 'Tandem · No network connection', enabled: false },
    { type: 'separator' },
    ...(recent.length ? recent : [{ label: 'Nothing received yet', enabled: false }]),
    { type: 'separator' },
    { label: 'Open Tandem folder', click: () => shell.openPath(store.settings.saveRoot) },
    { label: 'Show history', click: () => openWindow('history') },
    { label: 'Pair new phone', click: () => openWindow('pair') },
    { label: 'Settings', click: () => openWindow('settings') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}
function createTray() {
  const mac = process.platform === 'darwin';
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', mac ? 'trayTemplate.png' : 'tray.png'));
  if (mac) img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('Tandem');
  tray.on('click', () => openWindow('history'));
  refreshTray();
}
function applyLoginItem() {
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!store.settings.startOnLogin });
}
function ensureSaveRoot() {
  const dir = store.settings.saveRoot;
  try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); }
  catch {
    const defaultDir = path.join(app.getPath('documents'), 'Tandem');
    const legacyDir = path.join(app.getPath('documents'), 'PhoneSaves');
    const fallback = fs.existsSync(legacyDir) && !fs.existsSync(defaultDir) ? legacyDir : defaultDir;
    fs.mkdirSync(fallback, { recursive: true });
    store.setSettings({ saveRoot: fallback });
  }
}
function sendToPaths(args) {
  const flag = args.indexOf('--send-to-phone');
  if (flag < 0) return [];
  return args.slice(flag + 1).filter((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });
}
function ensureSendToShortcut() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try {
    const dir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'SendTo');
    fs.mkdirSync(dir, { recursive: true });
    shell.writeShortcutLink(path.join(dir, 'Tandem to Phone.lnk'), 'create', {
      target: process.execPath,
      args: ['--send-to-phone'],
      cwd: app.getPath('userData'),
      description: 'Send selected files to a paired Tandem phone',
      icon: path.join(__dirname, 'assets', 'icon.png'),
      iconIndex: 0,
    });
  } catch (error) { console.error('Could not create Tandem Send To shortcut:', error.message); }
}
async function queueFilesToPhones(filePaths) {
  if (!store) return;
  const devices = store.devices;
  if (!devices.length) { openWindow('pair'); return; }
  const buttons = ['All paired phones', ...devices.map((d) => d.name), 'Cancel'];
  const answer = await dialog.showMessageBox(wins.history || undefined, {
    type: 'question', title: 'Send to Tandem phone', message: 'Choose which paired phone should receive these files.',
    buttons, cancelId: buttons.length - 1, defaultId: 0,
  });
  if (answer.response === buttons.length - 1) return;
  const deviceIds = answer.response === 0 ? devices.map((d) => d.id) : [devices[answer.response - 1].id];
  const outbox = path.join(app.getPath('userData'), 'phone-outgoing');
  fs.mkdirSync(outbox, { recursive: true });
  let queued = 0;
  for (const source of filePaths) {
    try {
      const id = crypto.randomUUID();
      const name = path.basename(source);
      const dest = path.join(outbox, `${id}-${name}`);
      fs.copyFileSync(source, dest);
      store.queueOutgoing({ path: dest, name, size: fs.statSync(dest).size }, deviceIds);
      queued++;
    } catch (error) { console.error('Could not queue a Send To file:', error.message); }
  }
  if (queued) {
    new Notification({ title: 'Files queued for Tandem', body: `${queued} file${queued === 1 ? '' : 's'} will appear on the selected phone when it connects.` }).show();
  }
}
const itemById = (id) => store.items.find((i) => i.id === id);

function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, (_e, ...a) => fn(...a));

  h('items:list', () => ({
    items: store.items.map(({ path: p, ...rest }) => ({ ...rest, missing: rest.kind === 'file' && !fs.existsSync(p) })),
  }));
  h('items:open', async (id) => {
    const it = itemById(id); if (!it) return 'Item not found';
    if (it.kind === 'link') { if (!/^https?:\/\//i.test(it.url)) return 'Unsupported link'; await shell.openExternal(it.url); return null; }
    return (await shell.openPath(it.path)) || null;
  });
  h('items:reveal', (id) => { const it = itemById(id); if (it?.kind === 'file') shell.showItemInFolder(it.path); });
  h('items:preview', (id) => {
    const it = itemById(id);
    if (!it || it.kind !== 'file' || !fs.existsSync(it.path)) return { error: 'File is not available.' };
    const stat = fs.statSync(it.path);
    if (stat.size > 150 * 1024 * 1024) return { error: 'Preview is limited to files under 150 MB.' };
    const mime = ({ '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.mp4': 'video/mp4', '.webm': 'video/webm' })[path.extname(it.path).toLowerCase()];
    if (!mime) return { error: 'This file type cannot be previewed.' };
    return { mime, data: Uint8Array.from(fs.readFileSync(it.path)) };
  });
  h('items:copy', (id) => { const it = itemById(id); if (it?.kind === 'link') clipboard.writeText(it.url); });
  h('items:remove', async (id, deleteFile) => {
    const it = itemById(id); if (!it) return false;
    if (deleteFile && it.kind === 'file' && fs.existsSync(it.path)) await shell.trashItem(it.path);
    return store.removeItem(id);
  });

  h('settings:get', async () => {
    const s = { ...store.settings };
    if (Array.isArray(s.launchers)) {
      s.launchers = await Promise.all(s.launchers.map(async (l) => {
        if (!l.iconDataUrl) {
          const icon = l.path ? await getFileIconDataUrl(l.path) : null;
          return { ...l, iconDataUrl: icon || DEFAULT_APP_ICON };
        }
        return l;
      }));
    }
    return s;
  });
  h('settings:set', (patch) => {
    const clean = {};
    for (const [k, t] of Object.entries(SETTING_TYPES)) if (patch && typeof patch[k] === t) clean[k] = patch[k];
    if (clean.tempRetentionHours != null) clean.tempRetentionHours = Math.max(1, Math.min(720, Math.round(clean.tempRetentionHours)));
    store.setSettings(clean);
    applyLoginItem();
    return { ...store.settings };
  });
  h('settings:chooseFolder', async () => {
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || undefined, {
      title: 'Choose where to save files', defaultPath: store.settings.saveRoot, properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return { ...store.settings };
    try { fs.accessSync(r.filePaths[0], fs.constants.W_OK); }
    catch { await dialog.showMessageBox({ type: 'error', message: 'That folder is not writable.' }); return { ...store.settings }; }
    store.setSettings({ saveRoot: r.filePaths[0] });
    return { ...store.settings };
  });
  h('folder:open', () => shell.openPath(store.settings.saveRoot));
  h('send-to-phone:choose', async () => {
    const result = await dialog.showOpenDialog(wins.history || undefined, { title: 'Choose files to send to a paired phone', properties: ['openFile', 'multiSelections'] });
    if (!result.canceled && result.filePaths.length) await queueFilesToPhones(result.filePaths);
    return { queued: !result.canceled && result.filePaths.length > 0 };
  });

  h('approvedFolders:add', async () => {
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || undefined, {
      title: 'Choose a folder to share with your phone', properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return store.settings.approvedFolders || [];
    const p = r.filePaths[0];
    const list = Array.isArray(store.settings.approvedFolders) ? [...store.settings.approvedFolders] : [];
    if (!list.some((f) => f.path.toLowerCase() === p.toLowerCase())) {
      list.push({ id: crypto.randomUUID(), name: path.basename(p), path: p, icon: 'folder' });
      store.setSettings({ approvedFolders: list });
    }
    return store.settings.approvedFolders;
  });

  h('approvedFolders:remove', (id) => {
    const list = (store.settings.approvedFolders || []).filter((f) => f.id !== id);
    store.setSettings({ approvedFolders: list });
    return list;
  });

  h('launchers:add', async () => {
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || undefined, {
      title: 'Select an application, file, or shortcut to approve', properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return store.settings.launchers || [];
    const p = r.filePaths[0];
    const list = Array.isArray(store.settings.launchers) ? [...store.settings.launchers] : [];
    if (!list.some((l) => l.path.toLowerCase() === p.toLowerCase())) {
      const ext = path.extname(p).toLowerCase();
      const name = path.basename(p, ext);
      const iconDataUrl = await getFileIconDataUrl(p);
      list.push({
        id: crypto.randomUUID(),
        name,
        path: p,
        type: ext === '.exe' || ext === '.lnk' ? 'app' : 'file',
        icon: 'app',
        iconDataUrl: iconDataUrl || DEFAULT_APP_ICON,
      });
      store.setSettings({ launchers: list });
    }
    return store.settings.launchers;
  });

  h('launchers:remove', (id) => {
    const list = (store.settings.launchers || []).filter((l) => l.id !== id);
    store.setSettings({ launchers: list });
    return list;
  });

  h('launchers:listInstalled', async () => {
    const apps = await systemControl.getInstalledApps();
    return Promise.all(apps.map(async (a) => {
      let icon = null;
      if (a.path && fs.existsSync(a.path)) {
        icon = await getFileIconDataUrl(a.path);
      }
      return {
        ...a,
        iconDataUrl: icon || DEFAULT_APP_ICON,
      };
    }));
  });

  h('launchers:addApp', async (appData) => {
    if (!appData || !appData.name) return store.settings.launchers || [];
    const list = Array.isArray(store.settings.launchers) ? [...store.settings.launchers] : [];
    const target = (appData.appId || appData.path || '').toLowerCase();
    if (!list.some((l) => (l.appId || l.path || '').toLowerCase() === target)) {
      let iconDataUrl = appData.iconDataUrl;
      if (!iconDataUrl && appData.path && fs.existsSync(appData.path)) {
        iconDataUrl = await getFileIconDataUrl(appData.path);
      }
      list.push({
        id: crypto.randomUUID(),
        name: appData.name,
        path: appData.path || appData.appId || '',
        appId: appData.appId || '',
        type: 'app',
        icon: 'app',
        iconDataUrl: iconDataUrl || DEFAULT_APP_ICON,
      });
      store.setSettings({ launchers: list });
    }
    return store.settings.launchers;
  });

  h('macros:save', (macro) => {
    if (!macro || !macro.name) return store.settings.macros || [];
    const list = Array.isArray(store.settings.macros) ? [...store.settings.macros] : [];
    const idx = list.findIndex((m) => m.id === macro.id);
    const item = { id: macro.id || crypto.randomUUID(), name: macro.name, items: Array.isArray(macro.items) ? macro.items : [] };
    if (idx >= 0) list[idx] = item;
    else list.push(item);
    store.setSettings({ macros: list });
    return list;
  });

  h('macros:remove', (id) => {
    const list = (store.settings.macros || []).filter((m) => m.id !== id);
    store.setSettings({ macros: list });
    return list;
  });

  h('devices:list', () => {
    const active = new Set(server?.connectedDeviceIds() || []);
    return { devices: store.devices.map(({ tokenHash, ...d }) => ({ ...d, active: active.has(d.id) })) };
  });
  h('devices:revoke', (id) => store.removeDevice(id));

  h('pair:start', async () => {
    const p = server.startPairing();
    if (!p.payload) return { error: 'no-network' };
    const qr = await QRCode.toDataURL(JSON.stringify(p.payload), { width: 280, margin: 1, errorCorrectionLevel: 'M' });
    return { qr, expires: p.expires, name: p.payload.n, host: p.payload.h, port: p.payload.p };
  });
  h('pair:cancel', () => server.cancelPairing());
  h('guest:start', async () => {
    const share = server.createGuestShare();
    if (!share) return { error: 'No network connection found.' };
    return { ...share, qr: await QRCode.toDataURL(share.url, { width: 240, margin: 1, errorCorrectionLevel: 'M' }) };
  });

  h('app:info', () => ({
    version: app.getVersion(), deviceName: server.deviceName, port: server.port, addresses: lanIPs(),
    fingerprint: server.fingerprint, packaged: app.isPackaged,
  }));
  h('window:open', (name) => openWindow(name));
  h('updater:check', () => updater.checkUpdate());
  h('updater:apply', () => updater.applyUpdate());
  h('updater:status', () => updater.getLastStatus());
  h('app:relaunch', () => { app.relaunch(); app.exit(0); });
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide();
  updater.init({
    isPackaged: app.isPackaged,
    version: app.getVersion(),
    onStatusChange: (status) => {
      broadcast('app:update-status', status);
      if (status.updateAvailable && !status.downloaded && !status.downloading) {
        broadcast('app:update-available', status);
      }
    },
  });
  const defaultDir = path.join(app.getPath('documents'), 'Tandem');
  const legacyDir = path.join(app.getPath('documents'), 'PhoneSaves');
  const initialRoot = fs.existsSync(legacyDir) && !fs.existsSync(defaultDir) ? legacyDir : defaultDir;
  store = new Store(app.getPath('userData'), {
    saveRoot: initialRoot, notify: true, startOnLogin: true, sortByType: true, tempRetentionHours: 24,
    approvedFolders: [], launchers: [], macros: [],
  });
  ensureSaveRoot();
  server = await startServer({ store, dataDir: app.getPath('userData'), clipboard, shell });

  store.on('items', () => { broadcast('items-changed'); refreshTray(); });
  store.on('devices', () => broadcast('devices-changed'));
  store.on('settings', () => { broadcast('settings-changed'); refreshTray(); });
  store.on('paired', (dev) => {
    broadcast('paired', dev.name);
    if (store.settings.notify && Notification.isSupported()) new Notification({ title: 'Phone paired', body: dev.name }).show();
  });
  store.on('item-added', (it) => {
    if (store.settings.notify && Notification.isSupported()) {
      new Notification({ title: it.kind === 'link' ? 'Link received' : 'File received', body: it.name }).show();
    }
  });

  registerIpc();
  createTray();
  ensureSendToShortcut();
  const startupFiles = sendToPaths(process.argv);
  if (startupFiles.length) void queueFilesToPhones(startupFiles);
  applyLoginItem();
  if (!store.devices.length) openWindow('pair'); // first run: go straight to pairing

  setTimeout(async () => {
    try {
      const st = await updater.checkUpdate();
      if (st && st.updateAvailable) {
        broadcast('app:update-available', st);
      }
    } catch {}
  }, 3000);
});
