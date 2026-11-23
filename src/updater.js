'use strict';

const { autoUpdater } = require('electron-updater');

let initialized = false;
let packaged = false;
let currentVersion = 'unknown';
let onStatus = () => {};
let checkInFlight = null;
let installScheduled = false;

let lastCheckResult = {
  updateAvailable: false,
  checkFailed: false,
  downloaded: false,
  downloading: false,
  currentVersion,
  latestVersion: currentVersion,
  // Kept for older phone builds that display commit-style fields.
  currentCommit: currentVersion,
  latestCommit: currentVersion,
  message: 'Update check not yet run',
  checkedAt: 0,
};

function status(patch) {
  lastCheckResult = { ...lastCheckResult, ...patch };
  try { onStatus(lastCheckResult); } catch {}
  return lastCheckResult;
}

function init({ isPackaged, version, onStatusChange } = {}) {
  if (initialized) return;
  initialized = true;
  packaged = !!isPackaged;
  currentVersion = version || 'unknown';
  onStatus = onStatusChange || (() => {});
  lastCheckResult = {
    ...lastCheckResult,
    currentVersion,
    latestVersion: currentVersion,
    currentCommit: currentVersion,
    latestCommit: currentVersion,
  };

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('update-available', (info) => status({
    updateAvailable: true,
    checkFailed: false,
    latestVersion: info.version,
    latestCommit: info.version,
    downloaded: false,
    downloading: false,
    message: `Update ${info.version} is available.`,
    checkedAt: Date.now(),
  }));

  autoUpdater.on('update-not-available', (info) => status({
    updateAvailable: false,
    checkFailed: false,
    latestVersion: info.version || currentVersion,
    latestCommit: info.version || currentVersion,
    downloaded: false,
    downloading: false,
    message: 'Tandem is up to date.',
    checkedAt: Date.now(),
  }));

  autoUpdater.on('download-progress', (progress) => status({
    downloading: true,
    downloadPercent: Math.round(progress.percent || 0),
    message: `Downloading update (${Math.round(progress.percent || 0)}%).`,
  }));

  autoUpdater.on('update-downloaded', (info) => status({
    updateAvailable: true,
    checkFailed: false,
    downloaded: true,
    downloading: false,
    latestVersion: info.version,
    latestCommit: info.version,
    message: `Update ${info.version} downloaded. Tandem will restart to install it.`,
  }));

  autoUpdater.on('error', (err) => status({
    checkFailed: true,
    downloading: false,
    message: err?.message || 'Could not check for updates.',
    checkedAt: Date.now(),
  }));
}

async function checkUpdate() {
  if (!packaged) {
    return status({
      updateAvailable: false,
      checkFailed: true,
      message: 'Updates are available from the installed desktop app.',
      checkedAt: Date.now(),
    });
  }
  if (process.platform !== 'win32') {
    return status({
      updateAvailable: false,
      checkFailed: true,
      message: 'Automatic updates are currently available for Windows builds.',
      checkedAt: Date.now(),
    });
  }
  if (checkInFlight) return checkInFlight;

  checkInFlight = (async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result) throw new Error('The updater could not read its release configuration. Reinstall Tandem from a release installer.');
      const latestVersion = result.updateInfo?.version || currentVersion;
      return status({
        updateAvailable: !!result.isUpdateAvailable,
        checkFailed: false,
        downloaded: lastCheckResult.downloaded && latestVersion === lastCheckResult.latestVersion,
        downloading: lastCheckResult.downloading,
        latestVersion,
        latestCommit: latestVersion,
        message: result.isUpdateAvailable ? `Update ${latestVersion} is available.` : 'Tandem is up to date.',
        checkedAt: Date.now(),
      });
    } catch (err) {
      return status({
        updateAvailable: false,
        checkFailed: true,
        message: err?.message || 'Could not check for updates.',
        checkedAt: Date.now(),
      });
    } finally {
      checkInFlight = null;
    }
  })();
  return checkInFlight;
}

async function applyUpdate() {
  if (!packaged || process.platform !== 'win32') {
    return { success: false, error: 'Automatic updates are available from installed Windows builds.' };
  }
  if (installScheduled) return { success: true, message: 'Tandem is restarting to install the update.' };

  let current = lastCheckResult;
  if (!current.updateAvailable) current = await checkUpdate();
  if (current.checkFailed) return { success: false, error: current.message };
  if (!current.updateAvailable) return { success: false, error: 'No update is available.' };

  try {
    status({ downloading: true, checkFailed: false, message: `Downloading update ${current.latestVersion}…` });
    await autoUpdater.downloadUpdate();
    status({ downloaded: true, downloading: false, message: `Update ${current.latestVersion} downloaded. Tandem will restart to install it.` });
    installScheduled = true;
    setTimeout(() => autoUpdater.quitAndInstall(false, true), 1800).unref?.();
    return { success: true, message: `Update ${current.latestVersion} downloaded. Tandem is restarting to install it.` };
  } catch (err) {
    installScheduled = false;
    status({ downloaded: false, downloading: false, checkFailed: true, message: err?.message || 'Update download failed.' });
    return { success: false, error: err?.message || 'Update download failed.' };
  }
}

function getLastStatus() {
  return lastCheckResult;
}

module.exports = { init, checkUpdate, applyUpdate, getLastStatus };
