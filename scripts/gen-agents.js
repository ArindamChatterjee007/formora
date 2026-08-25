#!/usr/bin/env node
/*
 * gen-agents.js — generates .github/agents/<key>.agent.md for every agent in
 * office/board.json → agents.roster. board.json is the SINGLE SOURCE OF TRUTH
 * for the AI office: roles (title/emoji/team/does), model tier, and grounding.
 *
 * Re-run after editing roles or the roster:   node scripts/gen-agents.js
 *
 * Each generated agent is a real, invocable VS Code custom agent with:
 *   - its own best-fit MODEL (fallback array — first available in the plan wins)
 *   - role-scoped tools (code agents can edit/execute; advisors are read+web)
 *   - grounding pointers so it decides from real data, never invents.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, '.github', 'agents');
const board = JSON.parse(fs.readFileSync(path.join(ROOT, 'office', 'board.json'), 'utf8'));

const roles = board.roles || [];
const roster = (board.agents && board.agents.roster) || [];
const roleOf = k => roles.find(r => r.key === k) || { key: k, title: k, emoji: '\u2022', team: 'Other', does: '', level: 'ic' };

// tier -> model fallback array. First model available in the user's Copilot
// Premium plan is used; the last entry is a safe, widely-available fallback.
const MODEL = {
  reasoning: ['Claude Opus 4.1 (copilot)', 'GPT-5 (copilot)', 'Claude Sonnet 4.5 (copilot)'],
  coding:    ['Claude Sonnet 4.5 (copilot)', 'GPT-5 (copilot)'],
  fast:      ['GPT-5 mini (copilot)', 'Gemini 2.5 Flash (copilot)', 'Claude Sonnet 4.5 (copilot)']
};
const TIER_WHY = {
  reasoning: 'deep judgment (strategy / finance / architecture)',
  coding:    'accurate build + test',
  fast:      'high-volume drafts + reports at low premium-request cost'
};

// role key / team -> tool aliases
function toolsFor(key, team) {
  if (key === 'eng') return ['read', 'edit', 'search', 'execute'];
  if (['qa', 'qaint', 'qaux', 'qalead', 'devops'].includes(key)) return ['read', 'search', 'execute'];
  if (team === 'Engineering' || team === 'Product') return ['read', 'search'];
  return ['read', 'search', 'web']; // executives + business/marketing: research-capable advisors
}

// grounding source -> human pointer
const GROUND_DESC = {
  board: '`office/board.json` — tasks, sprints, roadmap',
  budget: '`office/board.json` \u2192 `budget` — costs, founder pay, go/no-go',
  business: '`office/board.json` \u2192 `business` — MRR, funnel, pricing',
  growthPlan: '`office/board.json` \u2192 `growthPlan`',
  playbooks: '`office/board.json` \u2192 `playbooks` — sales scripts + content calendar',
  assets: '`office/board.json` \u2192 `assets` — ASO, lifecycle, influencer, affiliate',
  roadmap: '`office/board.json` \u2192 `roadmap`',
  activity: '`office/board.json` \u2192 `activity` feed',
  kpis: '`office/board.json` \u2192 `kpis`',
  funnel: '`office/board.json` \u2192 `business.funnel`',
  guides: 'the `guides/` content + `docs/`',
  repo: 'the live codebase — `js/`, `css/`, `index.html`',
  tests: 'the test suite, `get_errors`, and the local CI gates',
  ARCHITECTURE: '`docs/ARCHITECTURE.md` + the codebase',
  CI: 'the CI pipeline + `.github/workflows/`',
  pipeline: 'the dev\u2192release\u2192beta\u2192main promotion pipeline',
  PostHog: 'PostHog analytics — funnel, retention, events',
  'live app': 'the live app at the production URL',
  'assets.aso': '`office/board.json` \u2192 `assets.aso`',
  'assets.influencerProgram': '`office/board.json` \u2192 `assets.influencerProgram`',
  'assets.lifecycleMessaging': '`office/board.json` \u2192 `assets.lifecycleMessaging`'
};
const groundBlock = g => (g || []).map(x => '- ' + (GROUND_DESC[x] || '`' + x + '`')).join('\n');

// role key -> the one deliverable this agent returns
const OUTPUT = {
  ceo: 'A decision + the trade-offs, tied to the North Star and current sprint.',
  coo: 'A prioritized next-actions list for the office, with owners.',
  cfo: 'A financial read (runway, burn, go/no-go) grounded in the budget block.',
  finance: 'A numbers table (costs, projection, founder pay) — no fabricated figures.',
  bi: 'An insight from analytics with the metric, the delta, and the "so what".',
  analyst: 'A short funnel/retention readout with the top 3 movements.',
  vpsales: 'A pipeline plan — segments, motions, and the next 3 experiments.',
  sales: 'Ready-to-send outreach copy grounded in the playbooks.',
  bizdev: 'A partnership shortlist with the pitch angle for each.',
  cmo: 'A marketing plan mapped to the growth plan and budget.',
  growth: 'A ranked growth-experiment backlog (ICE-scored).',
  social: 'A week of platform-ready posts from the content calendar.',
  content: 'A finished draft (guide/post/ASO copy) ready to publish.',
  paid: 'A channel/budget plan with target CAC and expected payback.',
  influencer: 'An outreach list + DM copy from the influencer program.',
  lifecycle: 'A message/sequence draft from the lifecycle plan.',
  pm: 'A prioritized backlog slice with acceptance-ready framing.',
  req: '**Spec:** problem \u00b7 in/out scope \u00b7 testable acceptance criteria \u00b7 deps \u00b7 effort (S/M/L). Under ~20 lines.',
  design: 'A UX proposal (states, copy, interaction) grounded in the current UI.',
  cto: 'A technical direction + the risk/complexity call.',
  architect: 'An approach with the trade-offs and the smallest safe change.',
  eng: 'Files changed + a 2-line summary + confirmation self-checks pass.',
  qalead: 'A test plan / quality verdict with the risk areas called out.',
  qa: 'A red\u2192green verification: reproduce, fix-check, confirm. Pass/fail + evidence.',
  qaint: 'An integration/regression report across flows. Pass/fail + evidence.',
  qaux: 'A UX-QA report from the live app — friction points + severity.',
  devops: 'Version shipped + CI/promotion status + live-verification result.'
};

function body(role, tier, grounds) {
  const tools = toolsFor(role.key, role.team);
  const noCode = !tools.includes('edit');
  const isExec = role.level === 'exec' || role.level === 'lead';
  const lane = isExec
    ? 'Own the decision and the trade-offs; delegate execution to the relevant team.'
    : 'Defer cross-team calls to the relevant lead; stay focused on your deliverable.';
  let codeRule;
  if (role.key === 'eng') {
    codeRule = 'Work on `dev`/feature branches with risky changes behind a flag (`USE_*`). NEVER touch prod directly or `git add -A`. Hand deploy to DevOps.';
  } else if (role.key === 'devops') {
    codeRule = 'NEVER merge to prod on red CI. Only promote what QA passed. Stage SPECIFIC files, never `git add -A`. Confirm before force-push / branch deletion.';
  } else if (['qa', 'qaint', 'qaux', 'qalead'].includes(role.key)) {
    codeRule = 'You VERIFY and report — you do not ship. For interaction bugs use TDD: reproduce (red) \u2192 confirm fix (green) on REAL input before sign-off.';
  } else if (noCode) {
    codeRule = 'DO NOT edit code or run deploys \u2014 you advise. Hand execution to Product / Engineering / DevOps.';
  } else {
    codeRule = 'Keep changes minimal and in-scope; match existing code style.';
  }
  const teamLine = role.team && role.team !== 'Other' ? `You sit in the **${role.team}** team.` : '';
  return `You are Formora's **${role.title}** ${role.emoji}. ${teamLine}

## Grounding \u2014 decide from real data, never invent
Before you answer, read:
${groundBlock(grounds) || '- `office/board.json`'}

Ground every recommendation in the above. If a number or fact isn't in the data, say so \u2014 do not fabricate it.

## Your job
${role.does || 'Advance the office toward the North Star.'}

## Constraints
- Stay in your lane. ${lane}
- ${codeRule}
- Be brutally honest \u2014 surface real risks and trade-offs. No rubber-stamps.

## Output
${OUTPUT[role.key] || 'A concise, grounded recommendation with the reasoning.'}

---
*Model tier: **${tier}** \u2014 ${TIER_WHY[tier]}. Engine: GitHub Copilot Premium (multi-model). Autonomous work runs async as a role-scoped GitHub Issue \u2192 PR.*
`;
}

function frontmatter(role, tier) {
  const tools = toolsFor(role.key, role.team);
  const models = MODEL[tier];
  const desc = `Formora ${role.title}. Use for ${role.team} work: ${(role.does || '').replace(/"/g, "'")}. Grounded in office/board.json + the repo.`;
  const modelYaml = '[' + models.map(m => `'${m}'`).join(', ') + ']';
  return `---
description: "${desc}"
name: "${role.title}"
tools: [${tools.join(', ')}]
model: ${modelYaml}
user-invocable: true
---
`;
}

if (!fs.existsSync(AGENTS_DIR)) fs.mkdirSync(AGENTS_DIR, { recursive: true });

let written = 0;
const keptFiles = ['formora-office.agent.md']; // orchestrator is hand-maintained
const generated = new Set();
for (const a of roster) {
  const role = roleOf(a.key);
  const file = path.join(AGENTS_DIR, `${a.key}.agent.md`);
  fs.writeFileSync(file, frontmatter(role, a.tier) + '\n' + body(role, a.tier, a.grounds));
  generated.add(`${a.key}.agent.md`);
  written++;
}

// Remove stale title-named duplicates now superseded by key-named files.
const stale = ['engineer.agent.md', 'req-engineer.agent.md', 'qa-reviewer.agent.md'];
for (const s of stale) {
  const p = path.join(AGENTS_DIR, s);
  if (fs.existsSync(p)) { fs.unlinkSync(p); }
}

const counts = roster.reduce((m, a) => (m[a.tier] = (m[a.tier] || 0) + 1, m), {});
console.log(`Generated ${written} role-agents in .github/agents/`);
console.log(`Tiers: ${JSON.stringify(counts)}`);
console.log(`Kept hand-maintained: ${keptFiles.join(', ')}`);
