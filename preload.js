'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const EVENTS = ['items-changed', 'devices-changed', 'settings-changed', 'paired', 'app:update-available', 'app:update-status'];
const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('api', {
  listItems: call('items:list'),
  openItem: call('items:open'),
  previewItem: call('items:preview'),
  revealItem: call('items:reveal'),
  copyLink: call('items:copy'),
  removeItem: (id, deleteFile) => ipcRenderer.invoke('items:remove', id, !!deleteFile),
  getSettings: call('settings:get'),
  setSettings: call('settings:set'),
  chooseFolder: call('settings:chooseFolder'),
  openFolder: call('folder:open'),
  sendFilesToPhone: call('send-to-phone:choose'),
  addApprovedFolder: call('approvedFolders:add'),
  removeApprovedFolder: call('approvedFolders:remove'),
  addLauncher: call('launchers:add'),
  removeLauncher: call('launchers:remove'),
  listInstalledApps: call('launchers:listInstalled'),
  addApprovedApp: (app) => ipcRenderer.invoke('launchers:addApp', app),
  saveMacro: call('macros:save'),
  removeMacro: call('macros:remove'),
  listDevices: call('devices:list'),
  revokeDevice: call('devices:revoke'),
  pairStart: call('pair:start'),
  pairCancel: call('pair:cancel'),
  startGuestReceive: call('guest:start'),
  appInfo: call('app:info'),
  openWindow: call('window:open'),
  checkUpdate: call('updater:check'),
  applyUpdate: call('updater:apply'),
  getUpdateStatus: call('updater:status'),
  relaunchApp: call('app:relaunch'),
  on(evt, cb) {
    if (!EVENTS.includes(evt)) return () => {};
    const h = (_e, ...a) => cb(...a);
    ipcRenderer.on(evt, h);
    return () => ipcRenderer.removeListener(evt, h);
  },
});
