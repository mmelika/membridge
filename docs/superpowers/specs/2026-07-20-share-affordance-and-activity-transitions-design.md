# Share Affordance & Activity Transitions

**Date:** 2026-07-20
**Status:** Approved design
**Builds on:** the per-session prompt sharing control ([2026-07-20-multi-provider-advisor-and-per-session-sharing-design.md](2026-07-20-multi-provider-advisor-and-per-session-sharing-design.md), Feature 2) and the runs/threads Activity feed. All changes live in the dashboard renderer [lib/dashboard.js](../../lib/dashboard.js).

Two small, self-contained UI/interaction fixes, shipped together because both target how the Activity surface *feels*: one makes the per-session share control read as a control instead of a status label, the other stops the Activity/project views from flashing and re-animating when you navigate on and off them.

> **Source-of-truth note:** Edit `lib/dashboard.js` only. `app/lib/dashboard.js` is a gitignored build artifact regenerated from `lib/` by `scripts/prepare-app.js` (a plain recursive copy, run via `npm run app`). Never hand-edit `app/lib/`.

---

## Feature 1 — Share control affordance

### Problem

The per-session share control is rendered by `shareToggleHtml(newest)` ([lib/dashboard.js:2436](../../lib/dashboard.js)). Today it is:

- a **lock emoji** (`&#128274;` closed / `&#128275;` open) plus the words "Hidden from team" / "Visible to team",
- styled as a muted grey pill (`color: var(--text3)`, `1px solid var(--border)`) that is **visually identical to the passive `Claude Code` tool badge** sitting immediately beside it in the card meta row.

Two concrete complaints from the user:

1. The emoji looks clunky.
2. It is not clear the control does anything — it reads as a status label, not something you can click.

`shareToggleHtml` is the single source used by both the Activity feed cards (`threadHtml`, `unitHtml`) and the project-page threads, so one rewrite fixes every place it appears.

### Design — Option C: action button, line icon + text

Rewrite `shareToggleHtml` to emit a button-shaped control with a clear affordance and no emoji. Two states:

- **Private (not shared):** bordered, button-shaped — an **eye-off** line icon + "Share with team", text `var(--text2)`, border `var(--border2)`. On hover (via the existing `style-hover` attribute mechanism): border → `var(--accent-brd)`, text → `var(--text)`. Reads as a call-to-action.
- **Shared:** quiet green — soft `var(--green)` tint background, an **eye** line icon + "Shared", text `var(--green)`, border a translucent green. Calm and clearly "on".

Implementation constraints:

- **Icon = inline SVG**, not a font. The app does not load an icon font; use two tiny inline `<svg>` glyphs (eye / eye-off, ~13px, `stroke="currentColor"`, `fill="none"`) so the icon inherits the control's text color and adds no dependency. No emoji.
- **Preserve behavior exactly.** The wrapper keeps `data-share-toggle`, `data-share-session`, `data-share-project`, and `data-share-on` unchanged, so the existing click handler ([lib/dashboard.js:2692](../../lib/dashboard.js), and the project-page twin at [:3568](../../lib/dashboard.js)) and its POST to `/api/share-session` work without modification.
- **Tooltip** reworded from "Toggle whether teammates see this session's prompts" to state the action: "Share this session's prompts with your team" (private) / "Stop sharing this session" (shared).
- Guard clause (`if (!newest || !newest.self || !newest.session || !newest.projectPath) return ''`) is retained — the control still only renders on your own sessions.

### Acceptance

- No emoji anywhere in the control.
- In the private state the control visibly reads as a button (border + hover state distinct from the neighboring `Claude Code` badge).
- Clicking still toggles sharing exactly as before; the badge reflects the new state after the feed refresh.
- Both Activity cards and the project page show the new control (single source confirmed).

---

## Feature 2 — Activity/project transitions: no flash on navigation

### Problem

Every view renders its content inside `<main style="…animation:mbFade .4s cubic-bezier(.16,1,.3,1)">`, where `mbFade` is `from{opacity:0;transform:translateY(10px)} to{opacity:1}` ([lib/dashboard.js:509](../../lib/dashboard.js)). Separately, the view start functions force a fingerprint reset on entry:

- `startFeed()` → `feedFp = ''` ([lib/dashboard.js:2159](../../lib/dashboard.js))
- `startProject()` → `pjFp = ''` **and** `pjEntries = []` **and** `pjRoot.innerHTML = 'Loading…'` ([lib/dashboard.js:3491](../../lib/dashboard.js))

Because the fingerprint is wiped on every entry, `loadFeed`/`loadProject` always re-render identical content — re-running the 0.4s fade with its 10px vertical jump — even when nothing changed. Views are hidden with `display:none` (not destroyed), so the rendered DOM is still there and *could* be shown instantly. The result the user sees: leaving a project and returning to Activity (and re-opening a project) flashes and re-animates every time. This is the "clunky … flash on reload."

The fp-dedup guard already exists — `if (fp === feedFp && host.firstChild && !spinnerPaintedOver) { refreshAgo(...); return; }` ([lib/dashboard.js:2215](../../lib/dashboard.js)) — but the forced reset defeats it on entry.

### Design

**A — No re-render on unchanged re-entry.**

- `startFeed`: stop forcing `feedFp = ''`. On re-entry the fp-dedup compares the fresh `/api/feed` result against the retained fingerprint; unchanged → `refreshAgo` only, the existing feed DOM shows instantly with no fade. First load (`host.firstChild` null) and genuine data changes render exactly as before. The 5s poll continues to reconcile in place.
- `startProject`: only blank + reset when the target project actually changed. Track the last-loaded project path (hash value). If re-entering the **same** `#project=<path>`, skip the `pjEntries = []` / `pjRoot.innerHTML = 'Loading…'` / `pjFp = ''` wipe so it shows instantly; when the path **differs**, keep the current blank-and-load (different project = genuinely different content, the "Loading…" placeholder is correct there). The 5s `pjTimer` restart is unchanged.

**B — Gentler single transition.** Since `mbFade` now fires only on an actual render, soften it for the feed and project mains from `.4s` + `translateY(10px)` to a quick opacity-only (~`.18s`, no transform). Entering a fresh view fades once cleanly; returning to a cached view is instant; the vertical jump that read as a flash is gone. (Scope the softer timing to the feed/project mains; other surfaces that use `mbFade` — menus, the catch-up band — are left as-is.)

**C — Never blank live content with a spinner.** `loadFeed`/`loadProject` arm the shared 3s slow-load spinner ([armSpinner, lib/dashboard.js:878](../../lib/dashboard.js)) unconditionally. Pass a `skipPaint` veto (the same third-argument pattern the Projects index already uses) that returns true when the host already holds rendered content and the fingerprint has not been invalidated — so a slow poll on a populated view can never replace good content with the spinner. The spinner still paints for genuine first/empty loads.

### Non-goals / constraints

- No API, endpoint, or data-shape changes. `/api/feed`, `/api/share-session`, and the poll cadence are untouched.
- The behavior on genuine data change is unchanged — new sessions still appear (and may fade in once). Only redundant re-renders of identical content are eliminated.
- Do not alter `startHome`/`startSession` in this change unless the same forced-reset flash is observed there; keep the diff focused on the Activity and project surfaces the user flagged.

### Acceptance

- Navigating Activity → a project → back to Activity shows the prior feed **instantly**, with no fade and no spinner, when nothing changed while away.
- Re-opening the same project does not blank to "Loading…"; opening a different project still shows the loading placeholder.
- When new activity has genuinely arrived while away, the view updates (a single, quick opacity fade is acceptable).
- A slow (>3s) poll on an already-rendered feed/project never replaces it with the spinner.

---

## Testing

Both features are DOM/interaction changes in the renderer. Verify against the running dashboard (dev: `npm run app`, or the local server on `http://127.0.0.1:7437`) using the browser preview tools:

1. **Share control** — on an Activity card of your own session, confirm: no emoji; private state reads as a button with a hover state distinct from the `Claude Code` badge; clicking toggles to the green "Shared" state and persists after the feed refresh; the same control appears on the project page.
2. **Transitions** — open a project from Activity, go back: assert the feed does not re-fade (no `mbFade` restart) and no spinner appears when data is unchanged; re-open the same project and confirm no "Loading…" blank; confirm a different project still shows "Loading…".
