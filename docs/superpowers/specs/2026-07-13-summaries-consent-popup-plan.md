# Implementation Plan: Summaries Consent Popup

_Date: 2026-07-13 · Branch: brown · Spec: [design](./2026-07-13-summaries-consent-popup-design.md)_

## Step 1: Add `consent` field to default config

**File:** `lib/util.js`

- Add `consent: null` to `DEFAULT_CONFIG.distill` (line ~52)

## Step 2: Create `lib/consent.js`

New file with two functions:

- `needsConsentPrompt(config)` → returns `true` when `config.distill.consent == null && config.distill.enabled !== false`
- `applyConsent(decision)` → `decision` is `'granted'` or `'declined'`:
  - Loads user config via `util.loadUserConfig()`
  - Sets `raw.distill.consent = decision`
  - Saves via `util.saveUserConfig(raw)`
  - If `'granted'`, calls `hooks.setupHooks()`
  - Returns a summary string

## Step 3: Gate the summary line in digest

**File:** `lib/digest.js`, line 279

Change condition from:

```js
target === 'AGENTS.md' && (!config || !config.distill || config.distill.enabled !== false)
```

To:

```js
target === 'AGENTS.md' && (!config || !config.distill || config.distill.enabled !== false) && config && config.distill && config.distill.consent === 'granted'
```

## Step 4: Wire `setup-hooks` CLI to record consent

**File:** `bin/membridge.js`, line 528

After calling `hooks.setupHooks()`, also write `consent: 'granted'` to user config (so CLI users who already ran it never see the app popup).

## Step 5: Add the Electron popup

**File:** `app/main.js`, inside `app.whenReady().then(...)`, after `util.ensureConfig()` and before `tick()`

- Import `consent` from `lib/consent`
- Import `{ dialog }` from electron (already importing from electron on line 7)
- If `consent.needsConsentPrompt(config)`:
  - Show `dialog.showMessageBox` with:
    - Title: "Enable session summaries?"
    - Message: "MemBridge can ask your AI tools to leave a short note about what they worked on, so your other tools stay in the loop. This adds one line to each project's AGENTS.md and installs a Claude Code hook."
    - Buttons: `['Enable', 'Not now']`
  - Route result through `consent.applyConsent('granted' | 'declined')`
- Then proceed to `tick()` and `setInterval`

## Step 6: Tests

**File:** `test/run-tests.js` — append new checks:

1. `needsConsentPrompt` returns true for fresh config (default has `consent: null`)
2. `needsConsentPrompt` returns false after granted
3. `needsConsentPrompt` returns false after declined
4. `needsConsentPrompt` returns false when distill disabled (`enabled: false`)
5. Digest omits summary line when consent is null — run `syncOnce`, read AGENTS.md, assert the "append a line" instruction is absent
6. Digest includes summary line after consent granted — call `applyConsent('granted')`, run `syncOnce`, assert the instruction is present
7. Digest omits summary line after consent declined — call `applyConsent('declined')`, run `syncOnce`, assert absent
8. `applyConsent('granted')` installs the Stop hook — check mock claude settings file has the membridge hook entry
9. `applyConsent('declined')` does NOT install the hook — check mock settings file has no hook
10. Idempotency: granting twice doesn't duplicate the hook — call twice, assert only one hook entry

## File summary

| File | Action |
|------|--------|
| `lib/util.js` | Add `consent: null` to defaults |
| `lib/consent.js` | **New** — `needsConsentPrompt`, `applyConsent` |
| `lib/digest.js` | Gate summary line on `consent === 'granted'` |
| `bin/membridge.js` | Record consent on `setup-hooks` |
| `app/main.js` | Electron dialog before first tick |
| `test/run-tests.js` | 10 new checks |
