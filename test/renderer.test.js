'use strict';
// Loads each window's real HTML + JS in jsdom with a stand-in for the preload API.
const path = require('path'), assert = require('assert');
const { JSDOM } = require('jsdom');
const R = path.join(__dirname, '..', 'renderer');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function open(page, api) {
  const calls = [];
  const proxy = new Proxy(api, { get: (t, k) => (k === 'on' ? () => () => {} : (...a) => { calls.push([k, ...a]); return Promise.resolve(typeof t[k] === 'function' ? t[k](...a) : t[k]); }) });
  const dom = await JSDOM.fromFile(path.join(R, page), { runScripts: 'dangerously', resources: 'usable', beforeParse(w) { w.api = proxy; } });
  await new Promise((r) => dom.window.addEventListener('load', r));
  await tick();
  return { w: dom.window, d: dom.window.document, calls };
}

(async () => {
  // History: empty state
  let t = await open('history.html', { listItems: { items: [] }, listDevices: { devices: [] } });
  assert.ok(t.d.querySelector('#list').textContent.includes('Pair a phone to start'));
  t.w.close();

  // History: items, filter, search, hostile names rendered as text
  const now = new Date().toISOString();
  const items = [
    { id: '1', kind: 'file', type: 'Images', name: '<img src=x onerror=alert(1)>.jpg', size: 1258291, from: 'Pixel 7', at: now, missing: false },
    { id: '2', kind: 'link', name: 'Example', url: 'https://example.com/a', from: 'Pixel 7', at: now },
    { id: '3', kind: 'file', type: 'Audio', name: 'voice.m4a', size: 340000, from: 'Pixel 7', at: now, missing: true },
  ];
  t = await open('history.html', { listItems: { items }, listDevices: { devices: [{ id: 'd' }] } });
  assert.strictEqual(t.d.querySelectorAll('#list .row').length, 3);
  assert.strictEqual(t.d.querySelector('#list img'), null, 'no HTML injection from filenames');
  assert.ok(t.d.querySelector('#list').textContent.includes('1.2 MB'));
  assert.ok(t.d.querySelector('#list').textContent.includes('file moved or deleted'));
  const navs = [...t.d.querySelectorAll('.nav')];
  navs.find((b) => b.textContent.startsWith('Links')).click();
  assert.strictEqual(t.d.querySelectorAll('#list .row').length, 1);
  assert.ok(t.d.querySelector('#list .row').textContent.includes('example.com'));
  navs.find((b) => b.textContent.startsWith('All')).click();
  const q = t.d.querySelector('#q'); q.value = 'voice'; q.dispatchEvent(new t.w.Event('input'));
  assert.strictEqual(t.d.querySelectorAll('#list .row').length, 1);
  q.value = 'zzz'; q.dispatchEvent(new t.w.Event('input'));
  assert.ok(t.d.querySelector('#list').textContent.includes('No matches'));
  q.value = ''; q.dispatchEvent(new t.w.Event('input'));
  [...t.d.querySelectorAll('#list .row')][1].querySelectorAll('button')[1].click();
  await tick();
  assert.ok(t.calls.some((c) => c[0] === 'copyLink' && c[1] === '2'));
  t.w.close();

  // Pair: shows QR and address from the API
  t = await open('pair.html', { pairStart: { qr: 'data:image/png;base64,AAAA', expires: Date.now() + 300000, name: 'PC', host: '192.168.1.5', port: 48200 } });
  assert.strictEqual(t.d.querySelector('#qr').hidden, false);
  assert.ok(t.d.querySelector('#where').textContent.includes('192.168.1.5:48200'));
  assert.ok(t.d.querySelector('#expiry').textContent.startsWith('Expires in 5:0') || t.d.querySelector('#expiry').textContent.startsWith('Expires in 4:5'));
  t.w.close();
  t = await open('pair.html', { pairStart: { error: 'no-network' } });
  assert.ok(t.d.querySelector('#state').textContent.includes('No network'));
  t.w.close();

  // Settings: renders real values, toggles call the API, empty devices message, app icons, and update check
  const settings = {
    saveRoot: '/home/u/Documents/Tandem',
    notify: true,
    startOnLogin: false,
    sortByType: true,
    launchers: [{ id: 'app1', name: 'Work App', path: '/bin/app', iconDataUrl: 'data:image/svg+xml;utf8,<svg></svg>' }],
  };
  t = await open('settings.html', {
    getSettings: settings,
    listDevices: { devices: [] },
    appInfo: { version: '1.0.0', deviceName: 'PC', port: 48200, addresses: ['192.168.1.5'], fingerprint: 'AA:BB', packaged: false },
    setSettings: (p) => ({ ...settings, ...p }),
    checkUpdate: { updateAvailable: false, currentCommit: 'aa62b08', latestCommit: 'aa62b08', message: 'Tandem is up to date' },
  });
  assert.strictEqual(t.d.querySelector('#folder').textContent, settings.saveRoot);
  assert.strictEqual(t.d.querySelector('#notify').checked, true);
  assert.strictEqual(t.d.querySelector('#startOnLogin').checked, false);
  assert.ok(t.d.querySelector('#devices').textContent.includes('No phones paired yet'));
  assert.ok(t.d.querySelector('#addr').textContent.includes('192.168.1.5:48200'));
  // Verify launcher app icon exists in DOM
  const launcherIcon = t.d.querySelector('#launchers-list .app-icon');
  assert.ok(launcherIcon, 'launcher app icon rendered');
  assert.strictEqual(launcherIcon.src, 'data:image/svg+xml;utf8,<svg></svg>');

  // Verify check updates button
  const checkBtn = t.d.querySelector('#check-updates-btn');
  assert.ok(checkBtn, 'check updates button exists');
  checkBtn.click();
  await tick();
  assert.ok(t.calls.some((c) => c[0] === 'checkUpdate'));

  const cb = t.d.querySelector('#startOnLogin'); cb.checked = true; cb.dispatchEvent(new t.w.Event('change'));
  await tick();
  assert.ok(t.calls.some((c) => c[0] === 'setSettings' && c[1].startOnLogin === true));
  t.w.close();
  console.log('renderer tests OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
