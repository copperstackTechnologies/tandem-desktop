'use strict';
// Runs the real server against a temp dir: pairing, auth, uploads, links, persistence.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const { Store } = require('../src/store');
const { startServer, typeFor, safeName } = require('../src/server');

const post = (url, headers, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const upload = (base, auth, name, type, content) => {
  const fd = new FormData(); fd.append('file', new Blob([content], { type }), name);
  return fetch(base + '/upload', { method: 'POST', headers: auth, body: fd });
};

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-'));
  const dataDir = path.join(tmp, 'data'), saveRoot = path.join(tmp, 'saves');
  const defaults = { saveRoot, notify: true, startOnLogin: true, sortByType: true };
  let store = new Store(dataDir, defaults);
  const added = []; store.on('item-added', (i) => added.push(i));
  let clipboardText = '';
  const mockClipboard = { readText: () => clipboardText, writeText: (t) => { clipboardText = t; } };
  const openedUrls = [];
  const openedPaths = [];
  const mockShell = { openExternal: (u) => openedUrls.push(u), openPath: async (p) => { openedPaths.push(p); return ''; } };
  const srv = await startServer({ store, dataDir, deviceName: 'TestPC', clipboard: mockClipboard, shell: mockShell });
  const base = 'https://127.0.0.1:' + srv.port;

  // helpers
  assert.strictEqual(typeFor('application/octet-stream', 'a.HEIC'), 'Images');
  assert.strictEqual(typeFor('', 'note.m4a'), 'Audio');
  assert.strictEqual(typeFor('application/pdf', 'x.pdf'), 'Files');
  assert.strictEqual(safeName('../../etc/passwd'), 'passwd');
  assert.strictEqual(safeName('..hidden'), 'hidden');

  // pairing
  assert.strictEqual((await post(base + '/pair', {}, { secret: 'x' })).status, 403, 'no pairing open');
  const p = srv.startPairing();
  assert.ok(p.expires > Date.now());
  const wrong = await post(base + '/pair', {}, { secret: 'nope' });
  assert.strictEqual(wrong.status, 403);
  const { token, pcName } = await (await post(base + '/pair', {}, { secret: p.payload ? p.payload.s : '', deviceName: 'Pixel 7' })).json().catch(() => ({}));
  const hasLan = !!p.payload;
  if (!hasLan) console.log('note: no LAN address in this sandbox; pairing secret not exposed, skipping paired-flow checks');
  if (hasLan) {
    assert.ok(token && pcName === 'TestPC');
    assert.strictEqual((await post(base + '/pair', {}, { secret: p.payload.s })).status, 403, 'secret is one-time');
    const auth = { authorization: 'Bearer ' + token };
    assert.strictEqual((await fetch(base + '/ping')).status, 401);
    assert.strictEqual((await fetch(base + '/ping', { headers: { authorization: 'Bearer bad' } })).status, 401);
    assert.strictEqual((await (await fetch(base + '/ping', { headers: auth })).json()).name, 'TestPC');
    assert.strictEqual(store.devices[0].name, 'Pixel 7');
    assert.ok(!JSON.stringify(store.devices).includes(token), 'token is stored hashed only');

    // uploads
    assert.strictEqual((await upload(base, auth, '../../evil/pic.jpg', 'image/jpeg', 'abc')).status, 200);
    assert.ok(fs.existsSync(path.join(saveRoot, 'Images', 'pic.jpg')));
    await upload(base, auth, 'pic.jpg', 'image/jpeg', 'second');
    assert.ok(fs.existsSync(path.join(saveRoot, 'Images', 'pic (1).jpg')), 'duplicate renamed');
    await upload(base, auth, 'voice.m4a', 'application/octet-stream', 'x');
    assert.ok(fs.existsSync(path.join(saveRoot, 'Audio', 'voice.m4a')), 'type guessed from extension');
    await upload(base, auth, 'report.pdf', 'application/pdf', 'x');
    assert.ok(fs.existsSync(path.join(saveRoot, 'Files', 'report.pdf')));
    store.setSettings({ sortByType: false });
    await upload(base, auth, 'flat.png', 'image/png', 'x');
    assert.ok(fs.existsSync(path.join(saveRoot, 'flat.png')), 'sorting can be switched off');
    store.setSettings({ sortByType: true });

    // links
    assert.strictEqual((await post(base + '/link', auth, { url: 'https://example.com/a', title: 'Example' })).status, 200);
    assert.strictEqual((await post(base + '/link', auth, { url: 'javascript:alert(1)' })).status, 400);
    assert.strictEqual((await post(base + '/link', auth, { url: 'nonsense' })).status, 400);
    assert.strictEqual(added.length, 6);
    assert.strictEqual(store.items[0].kind, 'link');

    // remote controls: presentation & media
    assert.strictEqual((await post(base + '/control/presentation', auth, { action: 'next' })).status, 200);
    assert.strictEqual((await post(base + '/control/presentation', auth, { action: 'bad' })).status, 400);
    assert.strictEqual((await post(base + '/control/media', auth, { action: 'play_pause' })).status, 200);
    assert.strictEqual((await post(base + '/control/media', auth, { action: 'bad' })).status, 400);

    // power
    assert.strictEqual((await post(base + '/control/power', auth, { action: 'cancel_shutdown' })).status, 200);

    // two-way clipboard
    assert.strictEqual((await post(base + '/control/clipboard', auth, { text: 'Hello from Phone' })).status, 200);
    assert.strictEqual(clipboardText, 'Hello from Phone');
    const clipRes = await (await fetch(base + '/control/clipboard', { headers: auth })).json();
    assert.strictEqual(clipRes.text, 'Hello from Phone');

    // open link immediately
    assert.strictEqual((await post(base + '/link/open', auth, { url: 'https://example.com/live', title: 'Live' })).status, 200);
    assert.ok(openedUrls.includes('https://example.com/live'));

    // status view
    const statusRes = await (await fetch(base + '/status', { headers: auth })).json();
    assert.strictEqual(statusRes.ok, true);
    assert.strictEqual(statusRes.pcName, 'TestPC');
    assert.ok('battery' in statusRes);
    assert.ok('disk' in statusRes);

    // launchers & macros
    store.setSettings({
      launchers: [{ id: 'app1', name: 'Work App', path: path.join(saveRoot, 'flat.png') }],
      macros: [{ id: 'm1', name: 'Start Work', items: ['app1'] }],
    });
    const launchList = await (await fetch(base + '/launcher/list', { headers: auth })).json();
    assert.strictEqual(launchList.launchers.length, 1);
    assert.strictEqual(launchList.macros.length, 1);
    assert.strictEqual((await post(base + '/launcher/run', auth, { id: 'app1' })).status, 200);
    assert.ok(openedPaths.includes(path.join(saveRoot, 'flat.png')));
    assert.strictEqual((await post(base + '/macro/run', auth, { id: 'm1' })).status, 200);

    // file browser & download
    const foldersRes = await (await fetch(base + '/browse/folders', { headers: auth })).json();
    assert.ok(foldersRes.folders.length >= 1);
    const rootFolderId = foldersRes.folders.find((f) => f.path === saveRoot)?.id || 'phonesaves_root';
    const dirRes = await (await fetch(base + `/browse/dir?folderId=${rootFolderId}`, { headers: auth })).json();
    assert.strictEqual(dirRes.ok, true);
    assert.ok(dirRes.entries.some((e) => e.name === 'flat.png'));

    const dlRes = await fetch(base + `/browse/download?folderId=${rootFolderId}&subpath=flat.png`, { headers: auth });
    assert.strictEqual(dlRes.status, 200);
    assert.strictEqual(await dlRes.text(), 'x');

    // traversal protection
    assert.strictEqual((await fetch(base + `/browse/download?folderId=${rootFolderId}&subpath=../../etc/passwd`, { headers: auth })).status, 404);

    // persistence
    const reloaded = new Store(dataDir, defaults);
    assert.strictEqual(reloaded.items.length, 7);
    assert.strictEqual(reloaded.devices.length, 1);

    // revoke
    assert.ok(store.removeDevice(store.devices[0].id));
    assert.strictEqual((await fetch(base + '/ping', { headers: auth })).status, 401, 'revoked token rejected');
    assert.ok(store.removeItem(store.items[0].id));
    assert.strictEqual(store.items.length, 6);
  }

  // pairing can be cancelled / expires
  srv.startPairing(); srv.cancelPairing();
  assert.strictEqual((await post(base + '/pair', {}, { secret: 'x' })).status, 403);

  // port fallback when the preferred port is taken
  const srv2dir = path.join(tmp, 'data2');
  const store2 = new Store(srv2dir, defaults);
  const srv2 = await startServer({ store: store2, dataDir: srv2dir, deviceName: 'Second', preferredPort: srv.port });
  assert.notStrictEqual(srv2.port, srv.port);
  await srv2.stop(); await srv.stop();
  console.log('server tests OK' + (hasLan ? '' : ' (reduced: no LAN)'));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
