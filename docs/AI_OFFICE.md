# The Formora AI Office — how 27 role-agents actually run

One founder. A full company of AI specialists. This is the operating manual.

## The idea

Instead of one AI role-playing everyone, every seat in the company is a **separate, invocable agent** with its own **best-fit model**, its own **tools**, and its own **grounding** (the real data it must read before it speaks). You monitor them all from the dashboard.

- **Registry (source of truth):** `office/board.json` → `agents` (engine, tiers, 27-agent roster) + `roles` (title, team, what each does).
- **The agents:** `.github/agents/<key>.agent.md` — one file per role, generated from the registry.
- **Monitor:** `office/dashboard.html` → the **🤖 AI Agents** section (roster grouped by team, model-tier badge, live status).
- **Orchestrator:** `.github/agents/formora-office.agent.md` routes a request to the right specialist(s).

## The backend — what model each agent uses

The engine is **GitHub Copilot Premium (multi-model)**. It is *not* one model — it's a gateway, and each agent is pinned (with fallback) to the tier that fits its job:

| Tier | Model (fallback order) | Who uses it | Why |
|------|------------------------|-------------|-----|
| 🧠 **reasoning** | Claude Opus 4.1 → GPT-5 → Sonnet 4.5 | ceo, coo, cfo, finance, bi, vpsales, cmo, pm, cto, architect, qalead (11) | Deep judgment — strategy, finance, architecture. Highest premium-request cost, used sparingly. |
| 💻 **coding** | Claude Sonnet 4.5 → GPT-5 | req, design, eng, qa, qaint, qaux, devops (7) | Accurate build + test. |
| ⚡ **fast** | GPT-5 mini → Gemini 2.5 Flash → Sonnet 4.5 | analyst, sales, bizdev, growth, social, content, paid, influencer, lifecycle (9) | High-volume drafts and reports at low premium-request cost. |

Model is set per agent in each `.agent.md` frontmatter as a **fallback array** — the first model available in your plan wins, so the setup survives plan/model changes. Change a tier's models in one place (`scripts/gen-agents.js` → `MODEL`) and regenerate.

> **Quota note:** reasoning agents burn premium requests fastest. The tiering is deliberate — most day-to-day volume (marketing drafts, reports, funnel reads) runs on the fast tier so the reasoning budget is reserved for real decisions.

## Two ways the office does work

### 1. Interactive (you're at the keyboard)
Open Copilot Chat → the **agent picker** → choose a role (e.g. **CFO — Finance Director**, **Growth Engineer**, **Engineer**). It loads that agent's model + grounding and does the one job. Or just talk to **Formora Office** (the orchestrator) and say what you want — it delegates to the right specialist(s) via the `agent` tool. Typical delivery chain:

```
req (spec) → design → eng (build) → qa / qaint / qaux (verify) → devops (ship)
```

### 2. Autonomous (overnight, you're asleep)
A board task becomes real work without you:

```
board.json task  →  role-scoped GitHub Issue  →  GitHub Copilot coding agent (async)  →  Pull Request  →  dashboard + your review
```

- The Issue is written by the matching role-agent (its persona + grounding go in the Issue body).
- The **GitHub Copilot coding agent** picks it up server-side, works on a branch, and opens a **PR** — no local CPU, nothing running on your Mac.
- You wake up to PRs to review, and the dashboard reflects status.

This is why office state lives on **GitHub, not localhost**: the work continues whether or not your laptop is awake.

## Regenerating the agents

The 27 agent files are generated — never hand-edit them one by one. Edit the registry, then:

```bash
node scripts/gen-agents.js
```

This rewrites every `.github/agents/<key>.agent.md` from `office/board.json` (roles + roster), keeping the orchestrator (`formora-office.agent.md`) untouched. To change a role's job, edit its `roles[].does`; to change its model tier, edit its `agents.roster[].tier`.

## Roadmap — true 24/7 (optional, later)

Copilot Premium is for **you-in-the-loop** work and async PRs — it is **not** a raw API to run 27 bots in an infinite loop (that violates the Copilot ToS and risks the account). For genuinely unattended 24/7 loops, swap the engine per-agent to a metered API:

- **GitHub Models** — a low-cost pilot for 3–4 non-code agents (finance, BI, growth) to prove the loop.
- **Anthropic / OpenAI API** — production always-on, billed per token, with real rate limits and no ToS risk.

The agent definitions don't change — only the execution engine behind them does.

---
*Generated agents: 27 · Orchestrator: 1 · Registry: `office/board.json` → `agents` · Monitor: `office/dashboard.html`.*
