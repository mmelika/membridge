'use strict';
// Copies lib/ into app/lib so the Electron app dir is self-contained
// (electron-builder two-package layout packages only what's inside app/).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dest = path.join(root, 'app', 'lib');
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(path.join(root, 'lib'), dest, { recursive: true });
console.log('app/lib refreshed from lib/');

// The app version must always track the root package.json — a stale
// app/package.json version labels a fresh build as an old release.
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const appPkgPath = path.join(root, 'app', 'package.json');
const appPkg = JSON.parse(fs.readFileSync(appPkgPath, 'utf8'));
if (appPkg.version !== rootPkg.version) {
  appPkg.version = rootPkg.version;
  fs.writeFileSync(appPkgPath, JSON.stringify(appPkg, null, 2) + '\n');
  console.log(`app version synced to ${rootPkg.version}`);
}
