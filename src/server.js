'use strict';
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const Fastify = require('fastify');
const multipart = require('@fastify/multipart');
const selfsigned = require('selfsigned');
const { Bonjour } = require('bonjour-service');
const systemControl = require('./systemControl');
const browser = require('./browser');
const updater = require('./updater');

const PREFERRED_PORT = 48200;
const MAX_FILE = 200 * 1024 * 1024; // this app is for small files
const CHUNK_SIZE = 4 * 1024 * 1024;
const PAIR_TTL = 5 * 60 * 1000;

const EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac', amr: 'audio/amr',
  mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', '3gp': 'video/3gpp', avi: 'video/x-msvideo',
};

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function typeFor(mime, filename) {
  let m = (mime || '').toLowerCase();
  if (!m || m === 'application/octet-stream') m = EXT[path.extname(filename || '').slice(1).toLowerCase()] || m;
  return m.startsWith('image/') ? 'Images' : m.startsWith('audio/') ? 'Audio' : m.startsWith('video/') ? 'Video' : 'Files';
}
function safeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 120);
  return base || 'file';
}
function sanitizeRelative(value) {
  if (typeof value !== 'string' || !value) return null;
  const parts = value.replace(/\\/g, '/').split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => safeName(part));
  return parts.length ? parts.join(path.sep) : null;
}
function uniquePath(dir, name) {
  const { name: stem, ext } = path.parse(name);
  let p = path.join(dir, name), i = 1;
  while (fs.existsSync(p)) p = path.join(dir, `${stem} (${i++})${ext}`);
  return p;
}
function stageCopy(source, targetDir, destination, replace = false) {
  const staged = path.join(targetDir, `.tandem-${crypto.randomUUID()}.part`);
  fs.copyFileSync(source, staged);
  if (replace) fs.rmSync(destination, { force: true });
  fs.renameSync(staged, destination);
  fs.rmSync(source, { force: true });
}
function loadCert(dir) {
  const c = path.join(dir, 'cert.pem'), k = path.join(dir, 'key.pem');
  if (fs.existsSync(c) && fs.existsSync(k)) return { cert: fs.readFileSync(c, 'utf8'), key: fs.readFileSync(k, 'utf8') };
  const pems = selfsigned.generate([{ name: 'commonName', value: 'Tandem' }], { days: 3650, keySize: 2048 });
  fs.writeFileSync(c, pems.cert);
  fs.writeFileSync(k, pems.private, { mode: 0o600 });
  return { cert: pems.cert, key: pems.private };
}
const VIRTUAL_IFACE = /virtual|vbox|vmware|vethernet|wsl|docker|tailscale|wireguard|zerotier|tap|tun/i;
const VIRTUAL_MAC = /^(08:00:27|0a:00:27|00:05:69|00:0c:29|00:50:56|00:15:5d|02:42)/i;

function isVirtual(name, mac, ip) {
  return VIRTUAL_IFACE.test(name) ||
         VIRTUAL_MAC.test(mac || '') ||
         ip.startsWith('192.168.56.');
}

function lanIPs() {
  const ifaces = os.networkInterfaces();
  const physical = [];
  const virtual = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const item = { name, address: a.address };
      if (isVirtual(name, a.mac, a.address)) {
        virtual.push(item);
      } else {
        if (/wi-?fi|wlan|wireless/i.test(name)) {
          physical.unshift(item);
        } else {
          physical.push(item);
        }
      }
    }
  }

  const combined = physical.length > 0 ? physical : virtual;
  return combined.map((i) => i.address);
}
// Use the preferred port if free, otherwise any free port (the QR code and mDNS carry the port).
function pickPort(preferred) {
  return new Promise((resolve, reject) => {
    const probe = (port, retry) => {
      const s = net.createServer();
      s.once('error', (e) => (retry && e.code === 'EADDRINUSE' ? probe(0, false) : reject(e)));
      s.listen(port, '0.0.0.0', () => { const p = s.address().port; s.close(() => resolve(p)); });
    };
    probe(preferred, true);
  });
}

async function startServer({
  store,
  dataDir,
  deviceName = os.hostname(),
  preferredPort = PREFERRED_PORT,
  clipboard = null,
  shell = null,
}) {
  const { cert, key } = loadCert(dataDir);
  const fingerprint = new crypto.X509Certificate(cert).fingerprint256;
  let pairing = null, attempts = 0, serverPort = 0;
  const lastSeenByDevice = new Map();
  let guestShare = null;
  const guestUploadRoot = path.join(dataDir, 'guest-uploads');
  const guestPending = new Map();
  fs.mkdirSync(guestUploadRoot, { recursive: true });

  const app = Fastify({ https: { cert, key }, logger: false, bodyLimit: CHUNK_SIZE + 1024 });
  await app.register(multipart, { limits: { fileSize: MAX_FILE, files: 1 } });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: CHUNK_SIZE + 1024 }, (_req, body, done) => done(null, body));

  // Everything except POST /pair requires a valid device token.
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/guest/')) return;
    if (req.method === 'POST' && req.url === '/pair') return;
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const hash = m && sha256(m[1]);
    const dev = hash && store.devices.find((d) => d.tokenHash === hash);
    if (!dev) return reply.code(401).send({ error: 'unauthorized' });
    req.device = dev;
    lastSeenByDevice.set(dev.id, Date.now());
  });

  app.post('/pair', async (req, reply) => {
    const { secret, deviceName: dn } = req.body || {};
    if (!pairing || Date.now() > pairing.expires || ++attempts > 5) {
      pairing = null;
      return reply.code(403).send({ error: 'pairing closed' });
    }
    const a = Buffer.from(String(secret)), b = Buffer.from(pairing.secret);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return reply.code(403).send({ error: 'bad secret' });
    pairing = null; // one-time use
    const token = crypto.randomBytes(32).toString('hex');
    store.addDevice({ id: crypto.randomUUID(), name: String(dn || 'Phone').slice(0, 60), tokenHash: sha256(token), pairedAt: new Date().toISOString() });
    return { token, pcName: deviceName };
  });

  app.delete('/pair', async (req) => { store.removeDevice(req.device.id); return { ok: true }; });
  app.get('/ping', async () => ({ ok: true, name: deviceName }));
  app.get('/phone/inbox', async (req) => ({
    items: store.outgoingFor(req.device.id).map(({ path: _path, ...item }) => item),
  }));
  app.get('/phone/inbox/:id/download', async (req, reply) => {
    const item = store.outgoingFor(req.device.id).find((x) => x.id === req.params.id);
    if (!item || !fs.existsSync(item.path)) return reply.code(404).send({ error: 'File is no longer available.' });
    const size = fs.statSync(item.path).size;
    const range = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    if (!Number.isSafeInteger(start) || start < 0 || start > size) return reply.code(416).send({ error: 'Invalid byte range.' });
    const end = size - 1;
    reply.code(range ? 206 : 200);
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Length', Math.max(0, size - start));
    if (range) reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(item.name)}"`);
    return range ? fs.createReadStream(item.path, { start }) : fs.createReadStream(item.path);
  });
  app.delete('/phone/inbox/:id', async (req, reply) => {
    const removed = store.removeOutgoing(req.params.id, req.device.id);
    if (!removed) return reply.code(404).send({ error: 'File is no longer queued.' });
    if (!removed.fileStillQueued) fs.rmSync(removed.item.path, { force: true });
    return { ok: true };
  });

  function validGuestToken(token) {
    if (!guestShare || Date.now() > guestShare.expires) return false;
    const a = Buffer.from(String(token || ''));
    const b = Buffer.from(guestShare.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  app.get('/guest/:token', async (req, reply) => {
    if (!validGuestToken(req.params.token)) return reply.code(410).type('text/plain').send('This Tandem receive link has expired. Ask the PC owner for a new one.');
    reply.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    reply.header('Referrer-Policy', 'no-referrer');
    return reply.type('text/html; charset=utf-8').send(fs.readFileSync(path.join(__dirname, '../renderer/guest.html')));
  });
  app.get('/guest/:token/app.js', async (req, reply) => {
    if (!validGuestToken(req.params.token)) return reply.code(410).type('text/plain').send('Expired');
    return reply.type('application/javascript').send(fs.readFileSync(path.join(__dirname, '../renderer/guest.js')));
  });
  app.post('/guest/:token', async (req, reply) => {
    if (!validGuestToken(req.params.token)) return reply.code(410).send({ error: 'This receive link has expired.' });
    if (guestShare.uploads >= 10) return reply.code(429).send({ error: 'This receive link has reached its 10-file limit.' });
    let tempPath, filename, mime = '', duplicateAction;
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          filename = safeName(part.filename);
          mime = part.mimetype;
          tempPath = path.join(guestUploadRoot, `${crypto.randomUUID()}.part`);
          await pipeline(part.file, fs.createWriteStream(tempPath));
        } else if (part.fieldname === 'duplicateAction') {
          duplicateAction = part.value;
        }
      }
    } catch (error) {
      if (tempPath) fs.rmSync(tempPath, { force: true });
      return reply.code(400).send({ error: error.message || 'Upload failed.' });
    }
    if (!tempPath || !filename) return reply.code(400).send({ error: 'Choose a file to send.' });
    guestShare.uploads++;
    const type = typeFor(mime, filename);
    const targetDir = path.join(store.settings.saveRoot, 'Review');
    fs.mkdirSync(targetDir, { recursive: true });
    let dest = path.join(targetDir, filename);
    if (fs.existsSync(dest)) {
      if (!['rename', 'replace', 'skip'].includes(duplicateAction)) {
        const uploadId = crypto.randomUUID();
        guestPending.set(uploadId, { tempPath, filename, mime, createdAt: Date.now() });
        return reply.code(409).send({ error: 'DUPLICATE', name: filename, uploadId });
      }
      if (duplicateAction === 'skip') {
        fs.rmSync(tempPath, { force: true });
        return { ok: true, skipped: true };
      }
      if (duplicateAction === 'rename') dest = uniquePath(targetDir, filename);
      if (duplicateAction === 'replace') { /* replaced atomically after staging */ }
    }
    stageCopy(tempPath, targetDir, dest, duplicateAction === 'replace');
    const at = new Date();
    store.addItem({
      id: crypto.randomUUID(), kind: 'file', name: path.basename(dest), type,
      size: fs.statSync(dest).size, path: dest, from: 'Guest device', at: at.toISOString(),
      temporary: true,
      expiresAt: new Date(at.getTime() + Math.max(1, Number(store.settings.tempRetentionHours) || 24) * 3600000).toISOString(),
    });
    return { ok: true, name: path.basename(dest) };
  });
  app.post('/guest/:token/resolve/:uploadId', async (req, reply) => {
    if (!validGuestToken(req.params.token)) return reply.code(410).send({ error: 'This receive link has expired.' });
    const upload = guestPending.get(req.params.uploadId);
    const action = req.body?.action;
    if (!upload || !['replace', 'rename', 'skip'].includes(action)) return reply.code(404).send({ error: 'The pending upload is no longer available.' });
    guestPending.delete(req.params.uploadId);
    if (action === 'skip') {
      fs.rmSync(upload.tempPath, { force: true });
      return { ok: true, skipped: true };
    }
    const targetDir = path.join(store.settings.saveRoot, 'Review');
    fs.mkdirSync(targetDir, { recursive: true });
    let dest = path.join(targetDir, upload.filename);
    if (fs.existsSync(dest)) {
      if (action === 'rename') dest = uniquePath(targetDir, upload.filename);
      else { /* replaced atomically after staging */ }
    }
    stageCopy(upload.tempPath, targetDir, dest, action === 'replace');
    const at = new Date();
    store.addItem({
      id: crypto.randomUUID(), kind: 'file', name: path.basename(dest), type: typeFor(upload.mime, upload.filename),
      size: fs.statSync(dest).size, path: dest, from: 'Guest device', at: at.toISOString(), temporary: true,
      expiresAt: new Date(at.getTime() + Math.max(1, Number(store.settings.tempRetentionHours) || 24) * 3600000).toISOString(),
    });
    return { ok: true, name: path.basename(dest) };
  });

  app.post('/upload', async (req, reply) => {
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'no file' });
    const type = typeFor(part.mimetype, part.filename);
    const { saveRoot, sortByType } = store.settings;
    const dir = sortByType ? path.join(saveRoot, type) : saveRoot;
    fs.mkdirSync(dir, { recursive: true });
    const dest = uniquePath(dir, safeName(part.filename));
    try {
      await pipeline(part.file, fs.createWriteStream(dest));
    } catch {
      fs.rmSync(dest, { force: true });
      return reply.code(413).send({ error: 'file too large or upload failed' });
    }
    const item = { id: crypto.randomUUID(), kind: 'file', name: path.basename(dest), type, size: fs.statSync(dest).size,
      path: dest, from: req.device.name, deviceId: req.device.id, at: new Date().toISOString() };
    store.addItem(item);
    return { ok: true, id: item.id, name: item.name };
  });

  const uploadRoot = path.join(dataDir, 'resumable-uploads');
  fs.mkdirSync(uploadRoot, { recursive: true });
  const uploadPaths = (deviceId, transferId) => {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(transferId))) return null;
    const base = path.join(uploadRoot, `${sha256(deviceId).slice(0, 20)}-${transferId}`);
    return { data: `${base}.part`, meta: `${base}.json` };
  };
  app.post('/upload/init', async (req, reply) => {
    const body = req.body || {};
    const paths = uploadPaths(req.device.id, body.transferId);
    const size = Number(body.size);
    if (!paths || !Number.isSafeInteger(size) || size < 0 || size > 20 * 1024 * 1024 * 1024 || typeof body.name !== 'string') {
      return reply.code(400).send({ error: 'Invalid upload details.' });
    }
    let meta;
    try { meta = JSON.parse(fs.readFileSync(paths.meta, 'utf8')); } catch {}
    if (meta && (meta.deviceId !== req.device.id || meta.size !== size || meta.name !== body.name)) {
      return reply.code(409).send({ error: 'Transfer ID is already in use.' });
    }
    if (!meta) {
      meta = {
        deviceId: req.device.id,
        transferId: body.transferId,
        name: safeName(body.name),
        size,
        temporary: body.temporary === true,
        relativePath: sanitizeRelative(body.relativePath),
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(paths.meta, JSON.stringify(meta));
      fs.closeSync(fs.openSync(paths.data, 'a'));
    }
    const offset = fs.existsSync(paths.data) ? fs.statSync(paths.data).size : 0;
    return { ok: true, offset, chunkSize: CHUNK_SIZE };
  });
  app.put('/upload/:transferId/chunk', async (req, reply) => {
    const paths = uploadPaths(req.device.id, req.params.transferId);
    if (!paths || !fs.existsSync(paths.meta) || !Buffer.isBuffer(req.body)) return reply.code(404).send({ error: 'Upload session not found.' });
    const meta = JSON.parse(fs.readFileSync(paths.meta, 'utf8'));
    const offset = Number(req.headers['x-tandem-offset']);
    const current = fs.existsSync(paths.data) ? fs.statSync(paths.data).size : 0;
    if (meta.deviceId !== req.device.id || !Number.isSafeInteger(offset) || offset !== current || req.body.length > CHUNK_SIZE || current + req.body.length > meta.size) {
      return reply.code(409).send({ error: 'Upload offset does not match. Resume from the reported offset.', offset: current });
    }
    fs.appendFileSync(paths.data, req.body);
    return { ok: true, offset: current + req.body.length };
  });
  app.post('/upload/:transferId/complete', async (req, reply) => {
    const paths = uploadPaths(req.device.id, req.params.transferId);
    if (!paths || !fs.existsSync(paths.meta) || !fs.existsSync(paths.data)) return reply.code(404).send({ error: 'Upload session not found.' });
    const meta = JSON.parse(fs.readFileSync(paths.meta, 'utf8'));
    if (meta.deviceId !== req.device.id || fs.statSync(paths.data).size !== meta.size) return reply.code(409).send({ error: 'Upload is incomplete.' });
    const action = req.body?.duplicateAction;
    if (!['rename', 'replace', 'skip', undefined, null].includes(action)) return reply.code(400).send({ error: 'Invalid duplicate action.' });
    const type = typeFor('', meta.name);
    const { saveRoot, sortByType } = store.settings;
    const baseDir = meta.temporary
      ? path.join(saveRoot, 'Review', meta.relativePath ? path.dirname(meta.relativePath) : '')
      : path.join(saveRoot, sortByType ? type : '', meta.relativePath ? path.dirname(meta.relativePath) : '');
    fs.mkdirSync(baseDir, { recursive: true });
    const targetName = meta.relativePath ? path.basename(meta.relativePath) : meta.name;
    let dest = path.join(baseDir, safeName(targetName));
    let replaceExisting = false;
    if (fs.existsSync(dest)) {
      if (!action) return reply.code(409).send({ error: `DUPLICATE:${path.basename(dest)}` });
      if (action === 'skip') {
        fs.rmSync(paths.data, { force: true }); fs.rmSync(paths.meta, { force: true });
        return { ok: true, skipped: true };
      }
      if (action === 'rename') dest = uniquePath(baseDir, safeName(targetName));
      if (action === 'replace') replaceExisting = true;
    }
    stageCopy(paths.data, baseDir, dest, replaceExisting);
    fs.rmSync(paths.meta, { force: true });
    const at = new Date();
    const item = {
      id: crypto.randomUUID(), kind: 'file', name: path.basename(dest), type,
      size: fs.statSync(dest).size, path: dest, from: req.device.name, deviceId: req.device.id,
      at: at.toISOString(), temporary: meta.temporary,
      ...(meta.temporary ? { expiresAt: new Date(at.getTime() + Math.max(1, Number(store.settings.tempRetentionHours) || 24) * 3600000).toISOString() } : {}),
    };
    store.addItem(item);
    return { ok: true, id: item.id, name: item.name };
  });

  app.post('/link', async (req, reply) => {
    const { url, title } = req.body || {};
    let u; try { u = new URL(String(url)); } catch { return reply.code(400).send({ error: 'bad url' }); }
    if (!['http:', 'https:'].includes(u.protocol)) return reply.code(400).send({ error: 'bad url' });
    const item = { id: crypto.randomUUID(), kind: 'link', name: String(title || u.hostname).slice(0, 200), url: u.href,
      from: req.device.name, deviceId: req.device.id, at: new Date().toISOString() };
    store.addItem(item);
    return { ok: true, id: item.id };
  });

  // --- Open Link on PC Immediately ---
  app.post('/link/open', async (req, reply) => {
    const { url, title } = req.body || {};
    let u; try { u = new URL(String(url)); } catch { return reply.code(400).send({ error: 'bad url' }); }
    if (!['http:', 'https:'].includes(u.protocol)) return reply.code(400).send({ error: 'bad url' });
    if (shell && shell.openExternal) shell.openExternal(u.href);
    const item = { id: crypto.randomUUID(), kind: 'link', name: String(title || u.hostname).slice(0, 200), url: u.href,
      from: req.device.name, deviceId: req.device.id, at: new Date().toISOString(), opened: true };
    store.addItem(item);
    return { ok: true, id: item.id };
  });

  // --- Presentation Remote ---
  app.post('/control/presentation', async (req, reply) => {
    const { action } = req.body || {};
    const map = {
      next: 'next_slide',
      prev: 'prev_slide',
      start: 'start_presentation',
      exit: 'exit_presentation',
    };
    const key = map[action];
    if (!key) return reply.code(400).send({ error: 'invalid presentation action' });
    systemControl.sendKey(key);
    return { ok: true, action };
  });

  // --- Media Controls ---
  app.post('/control/media', async (req, reply) => {
    const { action, volume } = req.body || {};
    if (action === 'set_volume') {
      const vol = systemControl.setVolume(volume);
      return { ok: true, action, volume: vol };
    }
    const allowed = ['play_pause', 'next', 'prev', 'volume_up', 'volume_down', 'mute'];
    if (!allowed.includes(action)) return reply.code(400).send({ error: 'invalid media action' });
    const key = action === 'next' ? 'next_track' : action === 'prev' ? 'prev_track' : action;
    systemControl.sendKey(key);
    return { ok: true, action };
  });

  // --- Power Actions ---
  app.post('/control/power', async (req, reply) => {
    const { action, delaySeconds } = req.body || {};
    switch (action) {
      case 'lock':
        systemControl.lockScreen();
        return { ok: true, action };
      case 'sleep':
        systemControl.sleepPc();
        return { ok: true, action };
      case 'shutdown': {
        const r = systemControl.scheduleShutdown(delaySeconds || 1800);
        return { ok: r.ok, action, shutdown: systemControl.getShutdownStatus() };
      }
      case 'cancel_shutdown': {
        const r = systemControl.cancelShutdown();
        return { ok: r.ok, action, shutdown: systemControl.getShutdownStatus() };
      }
      default:
        return reply.code(400).send({ error: 'invalid power action' });
    }
  });

  // --- Two-Way Clipboard ---
  app.get('/control/clipboard', async () => {
    const text = (clipboard && clipboard.readText) ? clipboard.readText() : '';
    return { ok: true, text: text || '' };
  });

  app.post('/control/clipboard', async (req, reply) => {
    const { text } = req.body || {};
    if (typeof text !== 'string') return reply.code(400).send({ error: 'invalid text' });
    if (clipboard && clipboard.writeText) clipboard.writeText(text);
    return { ok: true };
  });

  // --- Status View ---
  app.get('/status', async () => {
    const battery = await systemControl.getBatteryStatus();
    const disk = systemControl.getDiskStatus(store.settings.saveRoot);
    const metrics = systemControl.getSystemMetrics();
    const shutdown = systemControl.getShutdownStatus();
    return {
      ok: true,
      pcName: deviceName,
      battery,
      disk,
      ...metrics,
      shutdown,
      volume: systemControl.getVolume(),
      network: { ip: lanIPs()[0] || '', allIps: lanIPs(), port: serverPort },
      itemsCount: store.items.length,
    };
  });

  // --- Approved Launchers & Macros ---
  app.get('/launcher/list', async () => {
    const launchers = Array.isArray(store.settings.launchers) ? store.settings.launchers : [];
    const macros = Array.isArray(store.settings.macros) ? store.settings.macros : [];
    return { ok: true, launchers, macros };
  });

  app.post('/launcher/run', async (req, reply) => {
    const { id } = req.body || {};
    const launchers = Array.isArray(store.settings.launchers) ? store.settings.launchers : [];
    const item = launchers.find((l) => l.id === id);
    if (!item) return reply.code(404).send({ error: 'launcher not found' });
    await systemControl.launchApp(item, shell);
    return { ok: true, id: item.id, name: item.name };
  });

  app.post('/macro/run', async (req, reply) => {
    const { id } = req.body || {};
    const macros = Array.isArray(store.settings.macros) ? store.settings.macros : [];
    const macro = macros.find((m) => m.id === id);
    if (!macro) return reply.code(404).send({ error: 'macro not found' });
    const launchers = Array.isArray(store.settings.launchers) ? store.settings.launchers : [];
    let launched = 0;
    for (const lid of macro.items || []) {
      const item = launchers.find((l) => l.id === lid);
      if (item) {
        await systemControl.launchApp(item, shell);
        launched++;
      }
    }
    return { ok: true, id: macro.id, name: macro.name, launched };
  });

  // --- File Browser & Pull to Phone ---
  app.get('/browse/folders', async () => {
    return { ok: true, folders: browser.getAllApprovedFolders(store) };
  });

  app.get('/browse/dir', async (req, reply) => {
    const { folderId, subpath } = req.query || {};
    if (!folderId) return reply.code(400).send({ error: 'missing folderId' });
    const res = browser.listDir(store, folderId, subpath);
    if (res.error) return reply.code(404).send(res);
    return { ok: true, ...res };
  });

  app.get('/browse/download', async (req, reply) => {
    const { folderId, subpath } = req.query || {};
    if (!folderId || !subpath) return reply.code(400).send({ error: 'missing parameters' });
    const resolved = browser.resolveSecurePath(store, folderId, subpath);
    if (!resolved || !fs.existsSync(resolved.absolutePath)) {
      return reply.code(404).send({ error: 'file not found' });
    }
    const stat = fs.statSync(resolved.absolutePath);
    if (stat.isDirectory()) {
      return reply.code(400).send({ error: 'cannot download directory' });
    }
    const filename = path.basename(resolved.absolutePath);
    const ext = path.extname(filename).slice(1).toLowerCase();
    const mime = EXT[ext] || 'application/octet-stream';
    reply.header('Content-Type', mime);
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    reply.header('Content-Length', stat.size);
    return fs.createReadStream(resolved.absolutePath);
  });

  // --- Updates ---
  app.get('/update/check', async () => updater.checkUpdate());
  app.post('/update/apply', async () => updater.applyUpdate());

  const port = await pickPort(preferredPort);
  serverPort = port;
  await app.listen({ port, host: '0.0.0.0' });
  let bonjour = null;
  let advertisedAddresses = '';
  const publishBonjour = () => {
    const addresses = lanIPs();
    const signature = addresses.join(',');
    if (signature === advertisedAddresses) return;

    // mDNS sockets are tied to the interface selected at creation. Recreate
    // them when the PC changes networks so discovery follows the new LAN.
    if (bonjour) {
      bonjour.unpublishAll();
      bonjour.destroy();
    }
    advertisedAddresses = signature;
    const primaryIP = addresses[0];
    bonjour = new Bonjour(primaryIP ? { interface: primaryIP } : {});
    if (!primaryIP) return;
    bonjour.publish({ name: deviceName, type: 'tandem', port, txt: { fp: fingerprint.replace(/:/g, '') } });
    bonjour.publish({ name: deviceName, type: 'phonesaves', port, txt: { fp: fingerprint.replace(/:/g, '') } });
  };
  publishBonjour();
  // Node has no network-interface change event; poll so a long-running tray
  // app can move its mDNS advertisement to a newly connected LAN.
  const networkMonitor = setInterval(publishBonjour, 3000);
  networkMonitor.unref?.();
  const cleanExpiredFiles = () => {
    const now = Date.now();
    for (const item of store.items) {
      if (!item.temporary || !item.expiresAt || Date.parse(item.expiresAt) > now) continue;
      if (item.path) fs.rmSync(item.path, { force: true });
      store.removeItem(item.id);
    }
    for (const name of fs.readdirSync(uploadRoot)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(uploadRoot, name);
      try {
        const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (now - Date.parse(meta.createdAt) > 24 * 60 * 60 * 1000) {
          fs.rmSync(file, { force: true }); fs.rmSync(file.replace(/\.json$/, '.part'), { force: true });
        }
      } catch { fs.rmSync(file, { force: true }); }
    }
    for (const [id, pending] of guestPending) {
      if (now - pending.createdAt > 10 * 60 * 1000) {
        fs.rmSync(pending.tempPath, { force: true });
        guestPending.delete(id);
      }
    }
  };
  cleanExpiredFiles();
  const cleanupMonitor = setInterval(cleanExpiredFiles, 60 * 1000);
  cleanupMonitor.unref?.();

  return {
    port, fingerprint, deviceName,
    createGuestShare() {
      const host = lanIPs()[0];
      if (!host) return null;
      const token = crypto.randomBytes(32).toString('base64url');
      guestShare = { token, expires: Date.now() + 10 * 60 * 1000, uploads: 0 };
      return { url: `https://${host}:${serverPort}/guest/${token}`, expires: guestShare.expires };
    },
    connectedDeviceIds() {
      const cutoff = Date.now() - 45_000;
      return [...lastSeenByDevice].filter(([, seenAt]) => seenAt >= cutoff).map(([id]) => id);
    },
    startPairing() {
      attempts = 0;
      pairing = { secret: crypto.randomBytes(16).toString('hex'), expires: Date.now() + PAIR_TTL };
      const host = lanIPs()[0];
      return { expires: pairing.expires, payload: host ? { v: 1, n: deviceName, h: host, p: port, s: pairing.secret, f: fingerprint } : null };
    },
    cancelPairing() { pairing = null; },
    async stop() {
      clearInterval(networkMonitor);
      clearInterval(cleanupMonitor);
      bonjour?.unpublishAll();
      bonjour?.destroy();
      await app.close();
    },
  };
}
module.exports = { startServer, lanIPs, typeFor, safeName };
