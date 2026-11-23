'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// Small JSON-file store. Writes are synchronous and atomic (temp file + rename).
// Events: 'items', 'devices', 'settings', 'item-added', 'paired'.
class Store extends EventEmitter {
  constructor(dir, defaults) {
    super();
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'db.json');
    let data = {};
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    this.data = {
      devices: Array.isArray(data.devices) ? data.devices : [],
      outgoing: Array.isArray(data.outgoing) ? data.outgoing : [],
      items: Array.isArray(data.items) ? data.items : [],
      settings: { ...defaults, ...(data.settings || {}) },
    };
  }
  get settings() { return this.data.settings; }
  get devices() { return this.data.devices; }
  get outgoing() { return this.data.outgoing; }
  get items() { return this.data.items; }

  flush() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
  addItem(item) { this.data.items.unshift(item); this.flush(); this.emit('items'); this.emit('item-added', item); }
  removeItem(id) {
    const i = this.data.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.data.items.splice(i, 1); this.flush(); this.emit('items');
    return true;
  }
  addDevice(dev) { this.data.devices.push(dev); this.flush(); this.emit('devices'); this.emit('paired', dev); }
  removeDevice(id) {
    const n = this.data.devices.length;
    this.data.devices = this.data.devices.filter((d) => d.id !== id);
    if (this.data.devices.length === n) return false;
    this.flush(); this.emit('devices');
    return true;
  }
  queueOutgoing(file, deviceIds) {
    for (const deviceId of deviceIds) {
      this.data.outgoing.push({ id: require('crypto').randomUUID(), deviceId, ...file, queuedAt: new Date().toISOString() });
    }
    this.flush(); this.emit('outgoing');
  }
  outgoingFor(deviceId) { return this.data.outgoing.filter((item) => item.deviceId === deviceId); }
  removeOutgoing(id, deviceId) {
    const removed = this.data.outgoing.find((item) => item.id === id && item.deviceId === deviceId);
    if (!removed) return null;
    this.data.outgoing = this.data.outgoing.filter((item) => !(item.id === id && item.deviceId === deviceId));
    this.flush(); this.emit('outgoing');
    return { item: removed, fileStillQueued: this.data.outgoing.some((item) => item.path === removed.path) };
  }
  setSettings(patch) { Object.assign(this.data.settings, patch); this.flush(); this.emit('settings'); }
}
module.exports = { Store };
