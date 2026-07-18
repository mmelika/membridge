'use strict';
// Private-key storage in the macOS Keychain, via the built-in `security` CLI
// (E2E spec build-sequence step 1). Zero extra dependencies on purpose — no
// native modules to build or ship.
//
// Why the keychain at all: the private key is the one secret that lets this
// machine open the sealed team key. It must never be uploaded, and it must not
// sit in a plaintext file that a stray backup, a synced folder, or a stolen
// laptop would hand over. The OS vault is the right home for it.
//
// Off macOS (CI/Linux), `security` doesn't exist: available() is false and every
// op no-ops (false/null) so callers fail CLOSED — sync keeps working in
// plaintext rather than crashing. Cross-platform key storage is a later problem.
//
// REVIEW ITEM (for the cryptographer pass): the secret is passed to `security`
// via the -w argv, so it is briefly visible to `ps` on the local machine. That's
// a local-only, short-lived exposure, but flag it — stdin-feeding or a
// passphrase-wrapped key file are the alternatives to weigh.
const { spawnSync } = require('child_process');

// One service name for every MemBridge item, so accounts namespace within it.
const SERVICE = 'membridge';

function run(args) {
  return spawnSync('security', args, { encoding: 'utf8' });
}

// darwin + a working `security` binary. Probed, not assumed.
function available() {
  if (process.platform !== 'darwin') return false;
  const r = run(['help']);
  return !r.error;
}

// Store or replace a secret. -U updates an existing item instead of failing on
// a duplicate, so re-running is idempotent. Never log the secret.
function store(account, secret) {
  if (!available()) return false;
  const r = run(['add-generic-password', '-U', '-a', account, '-s', SERVICE, '-w', String(secret)]);
  return r.status === 0;
}

// The stored secret, or null when absent (or unreadable — a locked keychain and
// a missing item are both "we don't have it", and callers treat them the same).
function load(account) {
  if (!available()) return null;
  const r = run(['find-generic-password', '-a', account, '-s', SERVICE, '-w']);
  if (r.status !== 0) return null;
  const out = (r.stdout || '').trim();
  return out || null;
}

function remove(account) {
  if (!available()) return false;
  const r = run(['delete-generic-password', '-a', account, '-s', SERVICE]);
  return r.status === 0;
}

module.exports = { available, store, load, remove, SERVICE };
