'use strict';
// Stable per-device identity (multi-device E2E, section 1).
//
// Why a device id at all: the crypto model seals the team key once per DEVICE,
// not once per user, so two machines under one account each get their own
// sealed copy instead of overwriting a single per-user slot (the bug this
// fixes). Every device therefore needs a stable id that outlives process
// restarts but is unique per machine.
//
// The id lives in device.json in the MemBridge home (MEMBRIDGE_HOME-aware via
// util.homeDir()), one file per OS user. It is created lazily on first read and
// never rotated: a changed id would look like a brand-new device and re-seal
// needlessly. MEMBRIDGE_DEVICE_ID overrides it for tests (mirrors the
// MEMBRIDGE_HOME test-isolation pattern), so suites can simulate N devices
// without N machines.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const util = require('./util');

const devicePath = () => path.join(util.homeDir(), 'device.json');

// Read the persisted record, or null on any missing/corrupt/parse failure —
// never throws, so a bad file just triggers a fresh mint (same self-healing
// stance as teampins.load).
function read() {
  try {
    const rec = JSON.parse(fs.readFileSync(devicePath(), 'utf8'));
    return rec && typeof rec === 'object' && typeof rec.deviceId === 'string' && rec.deviceId
      ? rec
      : null;
  } catch (e) {
    return null;
  }
}

// Atomic write (tmp + rename) so a crash mid-save can't leave a half-written
// id that would read as a new device on the next boot.
function write(rec) {
  const file = devicePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, file);
}

// Create-and-persist a fresh record. Split out so both deviceId() and
// deviceLabel() converge on one lazily-created file.
function ensure() {
  const existing = read();
  if (existing) return existing;
  const rec = { deviceId: crypto.randomUUID(), label: os.hostname() || 'device' };
  write(rec);
  return rec;
}

// The stable id for this device. Env override wins (test isolation) and is NOT
// persisted — it is authoritative for the life of the process only.
function deviceId() {
  if (process.env.MEMBRIDGE_DEVICE_ID) return process.env.MEMBRIDGE_DEVICE_ID;
  return ensure().deviceId;
}

// Human label for CLI surfaces (fingerprint/status). Falls back to the hostname
// on a record that predates the label field.
function deviceLabel() {
  const rec = ensure();
  return rec.label || os.hostname() || 'device';
}

module.exports = { deviceId, deviceLabel, devicePath };
