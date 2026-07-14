# MemBridge — Product Plan v2 (July 2026)

_Edit anything. Items marked **TWEAK:** are decisions Andrew owns — change them inline and send the file back. Everything else is implementation detail Claude will handle._

## 0. North star

MemBridge is the **local-first shared memory layer for AI coding tools**, aimed at people a week–month into Claude Code. Free core: passive sync between tools (works today). **BYOK upgrade**: drop an Anthropic API key into Settings and each project gains an intelligence layer — a roadmap generator that breaks your next steps into tasks and says which model should do what, so you stop burning expensive tokens on cheap work.

**UX laws (apply to everything below):**
1. Never more than two levels deep: Home → Project page. Always an obvious ✕ back.
2. Plain English everywhere. "Everyday work", not "claude-haiku-4-5".
3. Any button that spends money shows the cost estimate BEFORE the click and the actual cost after.
4. Anything that sends data off the machine says so, in one sentence, right where it happens.

## 1. Build order

| # | What | Size | Depends on |
|---|------|------|-----------|
| M0 | Housekeeping: EADDRINUSE retry on port bind (found in testing); "Copy for AI" button per project | S | — |
| M1 | Project pages (click card → project dashboard, ✕ to exit) | M | — |
| M2 | Settings tab + BYOK key storage | S | — |
| M3 | **Plan tab**: goal box → roadmap with model routing (the upgrade feature) | L | M1, M2 |
| M4 | Neural map v2: default 2D, simpler visuals (3D kept behind a toggle) | M | — |
| M5 | Universal capture: import ChatGPT/claude.ai data exports; `membridge mcp` server; (investigate) Cursor chat adapter | M–L | — |

Suggested order: M0 → M1 → M2 → M3 (the headline), then M4, then M5.
**TWEAK:** reorder freely — M4 (2D map) can jump ahead of M3 if the friend feedback stings more than the missing roadmap.

## 2. M1 — Project pages

- Home (Overview) becomes a clean **projects grid**: name, last activity, tool badges, paused state. Global stats row stays. Add project / Sync now stay in the header.
- Click a card → **Project page** (same window, no reload, ✕ top-right and browser-back both exit):
  - **Activity**: the prompt history + files touched that today lives on the card, given room to breathe.
  - **Memory**: what's being injected (targets with ✓), link to open `.membridge/memory.md`, Pause/Resume, Delete.
  - **Copy for AI** button: copies a trimmed `memory.md` digest to the clipboard with a "paste this into ChatGPT/any AI" hint. This is the manual bridge to web AIs until M5.
  - **Plan** tab: locked with a friendly "Add your Anthropic key in Settings to unlock roadmaps" state until M2/M3 exist.
- Electron app picks this up automatically (it just loads the dashboard).

## 3. M2 — Settings + BYOK

- New **Settings** tab (gear icon, right side of header). Contents, in order:
  1. **Anthropic API key** — password-style input, Test button (calls a 1-token count_tokens request), green/red result. Helper copy: "Your key stays in `~/.membridge/config.json` on this machine. It is never written into any project folder and never synced."
  2. **Planner model** — radio, plain English: "Fast & cheap (~1¢ per roadmap) — recommended" (claude-haiku-4-5) / "Smarter (~4¢)" (claude-sonnet-5) / "Deepest (~6¢)" (claude-opus-4-8).
  3. Existing knobs (interval, targets) move here from footer text.
- Storage: `advisor: { apiKey, model }` in `~/.membridge/config.json`; file chmod 600 once a key is present. Also honors `ANTHROPIC_API_KEY` env as fallback.
- **TWEAK:** OpenAI key field for future Codex-side features? Recommend NO for v1 — every provider doubles surface area; Codex appears in roadmaps as a recommendation only.

## 4. M3 — Plan tab (the upgrade)

### What the user sees
1. **Goal box**: "What do you want to build next?" — plain textarea, one Example placeholder.
2. **Generate roadmap** button with live estimate: "≈ $0.01 with your key". Disabled with helper text if no key.
3. Output (rendered, not raw JSON):
   - One-paragraph "Where this project stands".
   - **Phases → tasks**, each task: what • why • a **model chip** ("Everyday — Haiku", "Standard — Sonnet", "Hard problem — Opus", "Frontier — Fable", "Cross-check — Codex") • one-line reason • size (S/M/L).
   - "Decisions this plan needs from you" (the model's open questions).
   - Footer: generated when, with which model, actual cost from usage; **Regenerate** (edit goal first if you like); staleness banner when new AI activity postdates the plan.
4. Roadmap summary is also written into the shared memory block (one line: "Current roadmap: <goal> — N tasks · .membridge/plan.json") — so Claude Code/Codex *see the plan too*. The roadmap becomes cross-tool memory. This is the killer detail.

### Explicitly NOT a chat (pushback, agreed rationale)
Open-ended chat = unbounded token spend + duplicate chatbot + intimidating for novices. The flow is goal → plan → regenerate. If real demand for follow-up Q&A emerges, a "Ask one question about this plan" affordance can be added later with the same one-click-one-cost pattern.
**TWEAK:** veto this and I'll spec the chat instead — but flag: it roughly triples M3.

### Technical spec
- New `lib/advisor.js`. **Zero-dependency constraint decision — TWEAK:** use Node 18+ global `fetch` against `POST https://api.anthropic.com/v1/messages` directly (my recommendation: keeps the README's zero-dependency promise; we need exactly one endpoint) — OR adopt `@anthropic-ai/sdk` as MemBridge's first runtime dependency (better types/retries, breaks the promise). Plan assumes raw fetch; ~120 lines incl. retry-once on 429/5xx, AbortController timeout 60s.
- Request: planner model from config, `max_tokens: 4000`, **structured outputs** (`output_config.format` json_schema, `additionalProperties: false`) so the response is guaranteed-parseable JSON — no brittle text parsing. Schema: `{ summary, phases: [{ title, tasks: [{ task, why, model: enum, model_reason, size: enum }] }], risks[], questions[] }`.
- Model routing enum + guidance baked into the system prompt: haiku = mechanical/small edits & boilerplate; sonnet = standard features/tests/docs; opus = debugging, architecture, big refactors; fable = ambiguous frontier work / long-horizon; codex-check = independent second opinion. Prompt also encodes the escalation philosophy: "when unsure, recommend starting cheap and escalating on failure — never the reverse."
- **What leaves the machine** (and is listed verbatim in the UI): project name, your goal text, recent asks (already-redacted), file *paths* touched, top-level folder names. Never file contents, never other projects. All strings pass the existing redaction regexes first.
- Cost estimate before send: `count_tokens` endpoint (cheap, exact) or local heuristic; actual cost computed from response `usage` × pricing table.
- Persistence: `.membridge/plan.json` (goal, generatedAt, model, costUsd, plan). Deterministic re-render like memory.json.
- Failure modes: no key → locked state; 401 → "key looks invalid — check Settings"; 429/5xx → one retry then friendly error; offline → cached plan + "generated 3 days ago" banner.
- Tests: suite stays offline — advisor honors `MEMBRIDGE_API_BASE` override; tests spin a local mock server returning canned JSON; assert redaction (planted secret never appears in captured request), schema render, plan.json write, memory-block roadmap line.
- Per-roadmap cost table (≈5K in / 1.5K out): haiku-4-5 ≈ $0.013 · sonnet-5 ≈ $0.025 (intro pricing) · opus-4-8 ≈ $0.063. Shown rounded in UI.

## 5. M4 — Map v2: default 2D

Friend feedback: 3D reads as intimidating. Fix:
- Same graph data + API, drop the z-axis: flat force layout, pan + zoom + drag, no rotation, no depth fading. Calmer visuals: fewer glows, bigger labels, cluster hulls (soft blob behind each project's chats).
- Click/search/side-panel/legend unchanged. "3D" becomes a small toggle (code already exists); choice remembered.
- Sizing: M — the sim and renderer already exist; this is removing a dimension and re-tuning, not a rebuild.

## 6. M5 — All chats, not just CLI tools (feasibility scope)

| Source | Route | Feasibility |
|---|---|---|
| ChatGPT (web) | **Importer** for official data export (`conversations.json` in the export zip) — drag onto dashboard or `membridge import <zip>` | High. Zero-dep JSON. Delayed-sync (manual export), but real. |
| claude.ai (web) | Same — official export exists | High, same importer |
| Cursor chats | Local SQLite (`state.vscdb`). Node 22+ ships built-in `node:sqlite` → still zero-dep, gated on Node version | Medium. Worth a spike |
| Gemini CLI | Writes local logs — likely already works via custom adapter | Verify, likely trivial |
| Browser extension (live capture of web chats) | New codebase, store review, privacy story | Low priority — revisit only if importer friction is real |
| `membridge mcp` | stdio MCP server exposing `list_projects` / `get_project_memory` / `get_plan` — MCP-capable clients (claude.ai, ChatGPT connectors, Claude Desktop) query memory live | Medium. ~200 lines, zero-dep JSON-RPC. The clean long-term bridge OUT to web AIs |

## 7. Reference — how syncing works today (unchanged)

Adapters tail each tool's local session logs → events merge into per-project history → digest injected between markers into `CLAUDE.md` / `AGENTS.md` (+ configurable targets) which those tools read automatically at startup → full log at `.membridge/memory.md` + structured `.membridge/memory.json`. Web chatbots can't see your disk; they join via Copy-for-AI (M0), importers/MCP (M5).

## 8. Decision list (the TWEAKs, in one place)

1. Build order? decision: as listed (M3 then m4)
2. Chat in Plan tab — my strong rec: goal box, no chat. Decision: no
3. Zero-dep raw fetch vs official SDK for the API call — rec: raw fetch. decision: approved rec
4. OpenAI key field in v1 — rec: no. decsision: accepted 
5. Planner default — rec: Haiku (~1¢), user-switchable. accepted 
6. Anything to add/cut from M5 table? accepted 
