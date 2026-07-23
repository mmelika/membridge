'use strict';
// Private-key storage, per platform (E2E build-sequence step 1; multi-device
// section 2). Zero extra dependencies on purpose — no native modules to build
// or ship. The private key is the one secret that lets THIS device open the
// sealed team key: it must never be uploaded, and it must not sit in a plaintext
// file that a stray backup, a synced folder, or a stolen laptop would hand over.
//
//   macOS   — the login Keychain via the built-in `security` CLI.
//   Windows — DPAPI (CurrentUser scope) via the built-in `powershell`, storing
//             the protected blob under homeDir()/secrets. DPAPI binds decryption
//             to the Windows user account, so a copied file alone can't open it —
//             the same "file theft is not enough" property the Keychain gives.
//   other   — no vault (CI/Linux): available() is false and every op no-ops so
//             callers fail CLOSED (sync keeps working in plaintext, never crashes).
//
// Secrets never ride argv: argv is world-readable via `ps`/Task Manager, so both
// backends feed the secret to their tool on STDIN. The command text itself
// (which carries no secret) is all that reaches argv.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('./util');

// One service/namespace for every MemBridge item, so accounts namespace within it.
const SERVICE = 'membridge';

// Double-quote a value for a shell/interactive command parser. Values here are
// accounts (dotted names) and base64 keys (+ / =) — no newlines by construction,
// but escape quote/backslash so nothing can break out.
const quote = s => '"' + String(s).replace(/[\\"]/g, '\\$&') + '"';

// ---------------------------------------------------------------------------
// macOS backend — `security` CLI
// ---------------------------------------------------------------------------
// Runner seam: tests swap the spawn to assert command construction (no secret in
// argv) without touching a real keychain. Returns the previous runner.
let runner = (args, input) => spawnSync('security', args, { encoding: 'utf8', input });
function _setRunner(fn) { const prev = runner; runner = fn; return prev; }
function run(args, input) { return runner(args, input); }

// darwin + a working `security` binary. Probed, not assumed.
function macAvailable() {
  if (process.platform !== 'darwin') return false;
  const r = run(['help']);
  return !r.error;
}

// Store or replace a secret. -U updates an existing item instead of failing on a
// duplicate, so re-running is idempotent. The command travels on stdin (`-i`
// interactive mode) so the secret never appears in argv. Never log the secret.
function macStore(account, secret) {
  const cmd = `add-generic-password -U -a ${quote(account)} -s ${quote(SERVICE)} -w ${quote(String(secret))}\n`;
  const r = run(['-i'], cmd);
  return r.status === 0;
}

function macLoad(account) {
  const r = run(['find-generic-password', '-a', account, '-s', SERVICE, '-w']);
  if (r.status !== 0) return null;
  const out = (r.stdout || '').trim();
  return out || null;
}

function macRemove(account) {
  const r = run(['delete-generic-password', '-a', account, '-s', SERVICE]);
  return r.status === 0;
}

// ---------------------------------------------------------------------------
// Windows backend — DPAPI via `powershell`
// ---------------------------------------------------------------------------
// Separate runner seam so the win32 path is testable off-Windows (command
// construction) the same way `_setRunner` covers macOS.
let winRunner = (args, input) => spawnSync('powershell', args, { encoding: 'utf8', input });
function _setWinRunner(fn) { const prev = winRunner; winRunner = fn; return prev; }
function winRun(script, input) {
  return winRunner(['-NoProfile', '-NonInteractive', '-Command', script], input);
}

const secretsDir = () => path.join(util.homeDir(), 'secrets');
// Account names are dotted identifiers by construction (membridge.box.*), so
// they are safe as a filename; guard anyway against path separators.
const secretFile = account => path.join(secretsDir(), String(account).replace(/[\\/]/g, '_') + '.dpapi');

// Protect: read the secret from stdin, DPAPI-encrypt under CurrentUser, emit
// base64. Unprotect: the inverse. The scripts carry no secret; the secret and
// the protected blob only ever cross on stdin.
const PROTECT =
  "Add-Type -AssemblyName System.Security;" +
  "$s=[Console]::In.ReadToEnd();" +
  "$b=[Text.Encoding]::UTF8.GetBytes($s);" +
  "$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);" +
  "[Console]::Out.Write([Convert]::ToBase64String($p));";
const UNPROTECT =
  "Add-Type -AssemblyName System.Security;" +
  "$s=[Console]::In.ReadToEnd();" +
  "$p=[Convert]::FromBase64String($s);" +
  "$b=[Security.Cryptography.ProtectedData]::Unprotect($p,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);" +
  "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b));";

// win32 + a working `powershell`. Probed with a no-op so a missing/blocked shell
// fails closed instead of throwing later.
function winAvailable() {
  if (process.platform !== 'win32') return false;
  const r = winRun('$null');
  return !r.error && r.status === 0;
}

function winStore(account, secret) {
  const r = winRun(PROTECT, String(secret));
  if (r.status !== 0 || !r.stdout) return false;
  const blob = r.stdout.trim();
  if (!blob) return false;
  try {
    fs.mkdirSync(secretsDir(), { recursive: true });
    const tmp = secretFile(account) + '.tmp';
    fs.writeFileSync(tmp, blob, { mode: 0o600 });
    fs.renameSync(tmp, secretFile(account));
    return true;
  } catch (e) {
    return false;
  }
}

function winLoad(account) {
  let blob;
  try { blob = fs.readFileSync(secretFile(account), 'utf8').trim(); } catch (e) { return null; }
  if (!blob) return null;
  const r = winRun(UNPROTECT, blob);
  if (r.status !== 0) return null;
  const out = (r.stdout || '').trim();
  return out || null;
}

function winRemove(account) {
  try { fs.unlinkSync(secretFile(account)); return true; } catch (e) { return false; }
}

// ---------------------------------------------------------------------------
// Platform dispatch. Linux/other: no vault, fail closed (false/null).
// ---------------------------------------------------------------------------
function available() {
  if (process.platform === 'darwin') return macAvailable();
  if (process.platform === 'win32') return winAvailable();
  return false;
}

function store(account, secret) {
  if (!available()) return false;
  if (process.platform === 'darwin') return macStore(account, secret);
  if (process.platform === 'win32') return winStore(account, secret);
  return false;
}

function load(account) {
  if (!available()) return null;
  if (process.platform === 'darwin') return macLoad(account);
  if (process.platform === 'win32') return winLoad(account);
  return null;
}

function remove(account) {
  if (!available()) return false;
  if (process.platform === 'darwin') return macRemove(account);
  if (process.platform === 'win32') return winRemove(account);
  return false;
}

module.exports = {
  available, store, load, remove, SERVICE, secretFile,
  _setRunner, _setWinRunner,
  // Test seams: the public store/load/remove gate on process.platform, so the
  // win32 backend is only reachable through these off-Windows (command
  // construction), while the real DPAPI round-trip is exercised on win32.
  _winStore: winStore, _winLoad: winLoad, _winRemove: winRemove,
};
