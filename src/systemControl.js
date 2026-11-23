'use strict';
const { exec, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// Virtual key codes for Windows keybd_event
const VK_MAP = {
  // Presentation
  next_slide: 0x27, // VK_RIGHT
  prev_slide: 0x25, // VK_LEFT
  start_presentation: 0x74, // VK_F5
  exit_presentation: 0x1B, // VK_ESCAPE

  // Media
  play_pause: 0xB3, // VK_MEDIA_PLAY_PAUSE
  next_track: 0xB0, // VK_MEDIA_NEXT_TRACK
  prev_track: 0xB1, // VK_MEDIA_PREV_TRACK
  volume_up: 0xAF,  // VK_VOLUME_UP
  volume_down: 0xAE,// VK_VOLUME_DOWN
  volume_mute: 0xAD,// VK_VOLUME_MUTE
};

let activeShutdown = null; // { targetTime: number, totalSeconds: number }
let cachedBattery = null;
let lastBatteryFetch = 0;
let currentVolume = 70;
let lastCpuSample = null;
let temperatureSample = { checkedAt: 0, value: null, pending: false };

function getSystemMetrics() {
  const cpus = os.cpus();
  let cpuPercent = null;
  const totals = cpus.map((cpu) => Object.values(cpu.times).reduce((sum, value) => sum + value, 0));
  const idle = cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0);
  const total = totals.reduce((sum, value) => sum + value, 0);
  if (lastCpuSample) {
    const elapsed = total - lastCpuSample.total;
    const active = elapsed - (idle - lastCpuSample.idle);
    if (elapsed > 0) cpuPercent = Math.max(0, Math.min(100, Math.round((active / elapsed) * 100)));
  }
  lastCpuSample = { total, idle };

  const totalMemoryBytes = os.totalmem();
  const freeMemoryBytes = os.freemem();
  requestTemperatureSample();
  return {
    cpuPercent,
    ramUsedBytes: Math.max(0, totalMemoryBytes - freeMemoryBytes),
    ramTotalBytes: totalMemoryBytes,
    temperatureC: temperatureSample.value,
  };
}

function requestTemperatureSample() {
  if (!IS_WIN || temperatureSample.pending || Date.now() - temperatureSample.checkedAt < 60000) return;
  temperatureSample.pending = true;
  execFile(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$t = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty CurrentTemperature; if ($null -ne $t) { [Console]::Write([string]$t) }',
    ],
    { timeout: 3500, windowsHide: true, maxBuffer: 1024 * 16 },
    (error, stdout) => {
      const raw = Number(String(stdout || '').trim());
      temperatureSample = {
        checkedAt: Date.now(),
        value: !error && Number.isFinite(raw) && raw > 0 ? Math.round((raw / 10 - 273.15) * 10) / 10 : null,
        pending: false,
      };
    },
  );
}

function getVolume() {
  return currentVolume;
}

function setVolume(pct) {
  const norm = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  currentVolume = norm;
  if (IS_WIN) {
    const val = (norm / 100).toFixed(2);
    const ps = `
$src = @'
using System; using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume { int f(); int g(); int h(); int j(); int SetMasterVolumeLevelScalar(float fLevel, System.Guid pguidEventContext); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref System.Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public class AudioHelper {
    public static void SetVol(float vol) {
        var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
        IMMDevice dev; enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
        var iid = typeof(IAudioEndpointVolume).GUID; IAudioEndpointVolume aev; dev.Activate(ref iid, 23, 0, out aev);
        aev.SetMasterVolumeLevelScalar(vol, System.Guid.Empty);
    }
}
'@
Add-Type -TypeDefinition $src -ErrorAction SilentlyContinue
[AudioHelper]::SetVol(${val})
`;
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], (err) => {
      if (err) console.error('[systemControl] setVolume error:', err.message);
    });
    return norm;
  }
  if (IS_MAC) {
    execFile('osascript', ['-e', `set volume output volume ${norm}`], () => {});
    return norm;
  }
  return norm;
}

function sendKey(action) {
  if (IS_WIN) {
    const vk = VK_MAP[action];
    if (!vk) throw new Error('Unknown key action: ' + action);
    const ps = `$code = '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);'; Add-Type -MemberDefinition $code -Name 'U32' -Namespace 'Win'; [Win.U32]::keybd_event(${vk}, 0, 0, 0); [Win.U32]::keybd_event(${vk}, 0, 2, 0)`;
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], (err) => {
      if (err) console.error('[systemControl] sendKey error:', err.message);
    });
    return true;
  }

  if (IS_MAC) {
    let script = '';
    switch (action) {
      case 'next_slide': script = 'tell application "System Events" to key code 124'; break; // Right arrow
      case 'prev_slide': script = 'tell application "System Events" to key code 123'; break; // Left arrow
      case 'start_presentation': script = 'tell application "System Events" to key code 96'; break; // F5
      case 'exit_presentation': script = 'tell application "System Events" to key code 53'; break; // Escape
      case 'play_pause': script = 'tell application "System Events" to key code 16 using {command down, shift down}'; break;
      case 'volume_up': script = 'set volume output volume ((output volume of (get volume settings)) + 6)'; break;
      case 'volume_down': script = 'set volume output volume ((output volume of (get volume settings)) - 6)'; break;
      case 'volume_mute': script = 'set volume output muted (not (output muted of (get volume settings)))'; break;
    }
    if (script) execFile('osascript', ['-e', script], () => {});
    return true;
  }

  return false;
}

function lockScreen() {
  if (IS_WIN) {
    exec('rundll32.exe user32.dll,LockWorkStation');
    return true;
  }
  if (IS_MAC) {
    exec('/System/Library/CoreServices/Menu\\ Extras/User.menu/Contents/Resources/CGSession -suspend');
    return true;
  }
  exec('loginctl lock-session || xdg-screensaver lock');
  return true;
}

function sleepPc() {
  if (IS_WIN) {
    exec('rundll32.exe powrprof.dll,SetSuspendState 0,1,0');
    return true;
  }
  if (IS_MAC) {
    exec('pmset sleepnow');
    return true;
  }
  exec('systemctl suspend');
  return true;
}

function scheduleShutdown(seconds = 1800) {
  const secs = Math.max(10, Math.min(86400, Math.round(Number(seconds) || 1800)));
  if (IS_WIN) {
    // Cancel any previous shutdown schedule first
    exec('shutdown.exe /a', () => {
      exec(`shutdown.exe /s /t ${secs}`, (err) => {
        if (!err) {
          activeShutdown = { targetTime: Date.now() + secs * 1000, totalSeconds: secs };
        }
      });
    });
    activeShutdown = { targetTime: Date.now() + secs * 1000, totalSeconds: secs };
    return { ok: true, scheduledSeconds: secs };
  }
  if (IS_MAC || process.platform === 'linux') {
    const mins = Math.max(1, Math.round(secs / 60));
    exec(`shutdown -h +${mins}`);
    activeShutdown = { targetTime: Date.now() + secs * 1000, totalSeconds: secs };
    return { ok: true, scheduledSeconds: secs };
  }
  return { ok: false, error: 'unsupported platform' };
}

function cancelShutdown() {
  activeShutdown = null;
  if (IS_WIN) {
    exec('shutdown.exe /a');
    return { ok: true };
  }
  if (IS_MAC || process.platform === 'linux') {
    exec('shutdown -c');
    return { ok: true };
  }
  return { ok: true };
}

function getShutdownStatus() {
  if (!activeShutdown) return { active: false, remainingSeconds: 0 };
  const remaining = Math.round((activeShutdown.targetTime - Date.now()) / 1000);
  if (remaining <= 0) {
    activeShutdown = null;
    return { active: false, remainingSeconds: 0 };
  }
  return { active: true, remainingSeconds: remaining, totalSeconds: activeShutdown.totalSeconds };
}

async function getBatteryStatus() {
  const now = Date.now();
  if (cachedBattery && now - lastBatteryFetch < 10000) {
    return cachedBattery;
  }

  if (IS_WIN) {
    return new Promise((resolve) => {
      exec('powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -Property EstimatedChargeRemaining, BatteryStatus | ConvertTo-Json"', (err, stdout) => {
        if (err || !stdout.trim()) {
          cachedBattery = { hasBattery: false };
        } else {
          try {
            const data = JSON.parse(stdout);
            const b = Array.isArray(data) ? data[0] : data;
            if (b && typeof b.EstimatedChargeRemaining === 'number') {
              const charging = [2, 6, 7, 8, 9].includes(b.BatteryStatus);
              cachedBattery = {
                hasBattery: true,
                percent: b.EstimatedChargeRemaining,
                isCharging: charging,
                status: b.BatteryStatus,
              };
            } else {
              cachedBattery = { hasBattery: false };
            }
          } catch {
            cachedBattery = { hasBattery: false };
          }
        }
        lastBatteryFetch = Date.now();
        resolve(cachedBattery);
      });
    });
  }

  cachedBattery = { hasBattery: false };
  lastBatteryFetch = now;
  return cachedBattery;
}

function getDiskStatus(savePath) {
  try {
    const rootPath = IS_WIN ? (savePath ? path.parse(savePath).root : 'C:\\') : '/';
    const s = fs.statfsSync(rootPath);
    const total = s.bsize * s.blocks;
    const free = s.bsize * s.bfree;
    return {
      root: rootPath,
      totalBytes: total,
      freeBytes: free,
      usedBytes: total - free,
      percentUsed: Math.round(((total - free) / total) * 100),
    };
  } catch {
    return { root: '', totalBytes: 0, freeBytes: 0, usedBytes: 0, percentUsed: 0 };
  }
}

function findLnkFiles(dir, maxDepth = 3, currentDepth = 0) {
  const results = [];
  if (currentDepth > maxDepth) return results;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        results.push(...findLnkFiles(full, maxDepth, currentDepth + 1));
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.lnk')) {
        results.push({ name: path.basename(ent.name, '.lnk'), path: full });
      }
    }
  } catch {}
  return results;
}

function getStartMenuShortcuts() {
  const map = new Map();
  if (!IS_WIN) return map;
  const dirs = [
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft\\Windows\\Start Menu\\Programs'),
    path.join(process.env.APPDATA || '', 'Microsoft\\Windows\\Start Menu\\Programs'),
  ];
  for (const d of dirs) {
    for (const item of findLnkFiles(d)) {
      map.set(item.name.toLowerCase(), item.path);
    }
  }
  return map;
}

function resolveKnownFolder(target) {
  if (!target || typeof target !== 'string') return target;
  const known = {
    '{6D809377-6AF0-444B-8957-A3773F02200E}': process.env.ProgramFiles || 'C:\\Program Files',
    '{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}': process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}': path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
    '{F38BF404-1D43-42F2-9305-67DE0B28FC23}': process.env.SystemRoot || 'C:\\Windows',
    '{D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27}': path.join(process.env.SystemRoot || 'C:\\Windows', 'SysWOW64'),
  };
  for (const [guid, replacement] of Object.entries(known)) {
    if (target.startsWith(guid)) {
      return path.join(replacement, target.slice(guid.length));
    }
  }
  return target;
}

function getInstalledApps() {
  return new Promise((resolve) => {
    if (!IS_WIN) return resolve([]);
    const psCmd = 'Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress';
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
      timeout: 15000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      try {
        const parsed = JSON.parse(stdout);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        const shortcutMap = getStartMenuShortcuts();
        const apps = arr
          .filter((item) => item && item.Name && item.AppID)
          .map((item) => {
            const rawId = String(item.AppID).trim();
            const name = String(item.Name).trim();
            let resolved = resolveKnownFolder(rawId);
            if (!fs.existsSync(resolved)) {
              const lnk = shortcutMap.get(name.toLowerCase());
              if (lnk) resolved = lnk;
            }
            return {
              name,
              appId: rawId,
              path: resolved,
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name));
        resolve(apps);
      } catch {
        resolve([]);
      }
    });
  });
}

function launchApp(item, shell) {
  return new Promise((resolve) => {
    if (!item) return resolve(false);
    if (IS_WIN && item.appId) {
      exec(`explorer.exe "shell:AppsFolder\\${item.appId}"`, (err) => {
        resolve(!err);
      });
      return;
    }
    if (shell && shell.openPath && item.path) {
      shell.openPath(item.path).then((err) => resolve(!err)).catch(() => resolve(false));
      return;
    }
    resolve(false);
  });
}

module.exports = {
  sendKey,
  setVolume,
  getVolume,
  lockScreen,
  sleepPc,
  scheduleShutdown,
  cancelShutdown,
  getShutdownStatus,
  getBatteryStatus,
  getDiskStatus,
  getSystemMetrics,
  getInstalledApps,
  launchApp,
};
