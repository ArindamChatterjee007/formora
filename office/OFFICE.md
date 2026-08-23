# Formora — AI Agent Office

Your one-person company runs as a full team of AI roles, **operated entirely from Copilot chat**. You give short instructions; the office does the work, reviews it, ships it, and reports back.

## How to use it (the whole interface)
Open Copilot chat, pick the **“Formora Office”** agent (agent picker), and type:

| You type | The office does |
|---|---|
| **`do today's work`** | Reads the board, executes the top of the active sprint (Req Eng → Engineer → QA → DevOps), ships it, updates the board, and reports **done / blocked**. |
| `standup` | Yesterday(done) / today(actionable) / blockers — no code changes. |
| `plan sprint 2` | PM refines that sprint's tasks. |
| `as QA, review X` | Adopts one role for a scoped task. |
| `hire growth` | Adds a role to the board (and optionally a sub-agent). |
| `groom` | Re-prioritizes the backlog. |

When done you get: **✅ done · 🟡 in review · ⛔ blocked (with the ONE thing you must do) · 📋 next up.** You are only pinged for real blockers, each with a concrete ask.

## The team (all powered by Copilot — no other AI)
🧭 PM · 📋 Requirements Engineer · 💻 Engineer · 🔍 QA/Reviewer · 🚀 DevOps · 🎨 Designer · 📈 Growth · 📊 Analyst · 👥 HR/Chief-of-Staff.
The technical roles are real VS Code sub-agents in `.github/agents/` (`req-engineer`, `engineer`, `qa-reviewer`, `devops`); the orchestrator is `formora-office`.

## Where everything lives (GitHub-backed — nothing heavy on your machine)
- **State / board:** [`office/board.json`](board.json) — committed to GitHub, the single source of truth. No local database, no browser localStorage.
- **Dashboard:** [`office/dashboard.html`](dashboard.html) — a live visual board that fetches `board.json` over the network (works on GitHub Pages, and even from `file://` because GitHub raw allows it). Once on `main` it's at `…github.io/formora/office/dashboard.html`.
- **Human tracker:** GitHub Issues + Milestones (mirrors the sprints) at the repo's Issues tab.
- **Plans/specs:** `docs/SPRINT_TRACKER.md`, `docs/MONETIZATION_SPEC.md`, `docs/AUTH_MIGRATION.md`, `docs/EXECUTION_PLAN.md`, `docs/BUSINESS_MODEL.md`, `docs/PITCH_DECK.md`.

## Operating principles
1. **GitHub, not local.** State + artifacts live in the repo / Issues / Pages. Minimize local CPU — no long-running local servers.
2. **Copilot is the brain.** All reasoning/AI is this chat. No Ollama / external LLM.
3. **Ship through the pipeline.** `dev → release → beta → main`; risky work behind a flag; never break prod.
4. **The board is always true.** Every task ends with a `board.json` update + commit, so the dashboard = reality.
5. **Cheap founder time.** You approve direction and clear blockers; the office does the rest.

## The critical path (what the office is driving toward)
`Auth migration → RLS security fix → Monetization (M0) → First revenue`. The current blocker is enabling the **Supabase Email provider** (Sprint 1) — a dashboard action only you can do.
