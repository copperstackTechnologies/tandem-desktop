'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function getSystemFolders() {
  const home = os.homedir();
  const list = [];
  const downloads = path.join(home, 'Downloads');
  if (fs.existsSync(downloads)) list.push({ id: 'sys_downloads', name: 'Downloads', path: downloads, icon: 'download' });
  const documents = path.join(home, 'Documents');
  if (fs.existsSync(documents)) list.push({ id: 'sys_documents', name: 'Documents', path: documents, icon: 'folder' });
  const pictures = path.join(home, 'Pictures');
  if (fs.existsSync(pictures)) list.push({ id: 'sys_pictures', name: 'Pictures', path: pictures, icon: 'image' });
  return list;
}

function getAllApprovedFolders(store) {
  const saveRoot = store.settings.saveRoot;
  const list = [];
  if (saveRoot && fs.existsSync(saveRoot)) {
    list.push({ id: 'tandem_root', name: 'Tandem Folder', path: saveRoot, icon: 'cloud' });
  }
  const custom = Array.isArray(store.settings.approvedFolders) ? store.settings.approvedFolders : [];
  for (const f of custom) {
    if (f && f.path && fs.existsSync(f.path)) {
      list.push({ id: f.id || crypto.randomUUID(), name: f.name || path.basename(f.path), path: f.path, icon: f.icon || 'folder' });
    }
  }
  return list;
}

function isInside(childPath, parentPath) {
  const rel = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function resolveSecurePath(store, folderId, subpath = '') {
  const folders = getAllApprovedFolders(store);
  const root = folders.find((f) => f.id === folderId || (folderId === 'phonesaves_root' && f.id === 'tandem_root'));
  if (!root) return null;

  // Normalize and clean subpath
  const cleanSub = (subpath || '').replace(/^[\\\/]+/, '');
  const target = path.resolve(root.path, cleanSub);

  // Security check: must be the root itself or inside the root
  if (target.toLowerCase() !== path.resolve(root.path).toLowerCase() && !isInside(target, root.path)) {
    return null;
  }
  return { root, absolutePath: target, relPath: cleanSub };
}

function listDir(store, folderId, subpath = '') {
  const resolved = resolveSecurePath(store, folderId, subpath);
  if (!resolved || !fs.existsSync(resolved.absolutePath)) {
    return { error: 'not_found' };
  }

  const stat = fs.statSync(resolved.absolutePath);
  if (!stat.isDirectory()) {
    return { error: 'not_a_directory' };
  }

  const entries = [];
  try {
    const raw = fs.readdirSync(resolved.absolutePath, { withFileTypes: true });
    for (const d of raw) {
      if (d.name.startsWith('.')) continue; // ignore hidden files
      const full = path.join(resolved.absolutePath, d.name);
      try {
        const s = fs.statSync(full);
        const rel = resolved.relPath ? `${resolved.relPath}/${d.name}` : d.name;
        entries.push({
          name: d.name,
          isDirectory: d.isDirectory(),
          size: d.isDirectory() ? 0 : s.size,
          mtime: s.mtime.toISOString(),
          ext: d.isDirectory() ? '' : path.extname(d.name).replace('.', '').toLowerCase(),
          relPath: rel,
        });
      } catch {
        // Skip unreadable items
      }
    }
  } catch (err) {
    return { error: 'cannot_read_directory' };
  }

  // Sort directories first, then alphabetically
  entries.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return {
    folderId,
    folderName: resolved.root.name,
    currentPath: resolved.relPath,
    entries,
  };
}

module.exports = {
  getAllApprovedFolders,
  resolveSecurePath,
  listDir,
};
