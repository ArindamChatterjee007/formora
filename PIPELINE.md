# Formora Release Pipeline

```text
Development      Independent QAT       Beta acceptance       Production
dev          ->  release           ->  beta              ->  main
cloud fixtures   isolated test site    isolated beta site    existing Pages site
```

Production is last, never the environment used to discover QAT failures.
Production: https://arindamchatterjee007.github.io/formora/
CI: https://github.com/ArindamChatterjee007/formora/actions/workflows/ci.yml

## Candidate Handoff

1. Development reviews and commits an explicit public-app file list to `dev`.
   Private office records, internal screenshots, developer instructions, local
   reports, credentials and unrelated changes must not enter this public repository.
2. Cloud CI runs `validate`, `functional-fixtures` and `promotion-gate` against
   the commit. A developer's passing local checks are not this gate's result.
3. An authorized release owner promotes the tested candidate to `release` by
   PR. QAT uses the resulting exact commit in an isolated checkout and test site.
4. After independent QAT evidence and authorized sign-off, record acceptance
   against that full SHA in `formora-qat-accepted`, then promote `release` to
   `beta`. Beta tests the new branch commit and its actual deployed asset hashes.
5. Only an accepted beta candidate with `formora-beta-accepted` evidence can
   pass the PR gate into `main`. A release owner still authorizes the merge.
   Complete post-deploy smoke checks, verify the published SHA, and keep a
   tested rollback and monitoring plan. Beta passing is not permission to ship.

Development may continue while QAT tests a pinned candidate. Do not change
branches or product files in the QA chat's shared developer worktree. Fixes
return through `dev`, produce a new candidate, and require affected retests.
Do not launch duplicate local suites; the cloud workflow serializes each run.

## Check Scope

- `validate`: syntax, cache version, URL sinks, conflict/secret checks and the
  existing 430 KiB top-level JS / 100 KiB CSS budgets. These budgets do not claim
  to measure every module or compressed network byte.
- `functional-fixtures`: `FORMORA_QA_SCOPE=public-product npm test`, serial Node
  and Chromium fixtures. The explicit private-contract exclusion catalog is
  reported as unverified, even if those files are absent. This is not a full
  candidate, private-contract, hosted RLS, provider, native or real-device pass.
  Only verification JSON and JUnit are retained in public Actions artifacts.
- `promotion-gate`: same-repository `dev -> release -> beta -> main`; beta/main
  require the newest exact-SHA acceptance deployment to be successful. A later
  pending/failed acceptance cannot fall back to an older success.

Recorded acceptance requires protected environments and authorized reviewers.
The code checks provenance, not reviewer competence or actual human approval.
Required branch checks must be enabled remotely before claiming enforcement.
Do not bypass them using `--admin` or automatically merge production.

## Separate Test Origins

The prepared builder supports three distinct Cloudflare Pages projects with
separate browser storage origins. Paths under the production `github.io` origin
are not isolated test environments. Proposed project names are `formora-dev`,
`formora-qat` and `formora-beta`; these are configuration examples, not live URLs.

Current build mode is **offline-preview**: production auth, backend, analytics,
email, push and payment globals are locked off before app config, and CSP blocks
external service requests. Camera permissions still require a user gesture.
The title and `/__formora/candidate.json` identify the stage and full commit.
No office, backups, SQL or developer files are in the allowlisted site bundle.
Generated security controls and app files have recorded SHA-256 identities.

An offline preview cannot pass integration QAT or beta. Real hosted acceptance
requires a separately authorized test backend, synthetic accounts, storage,
provider sandboxes and allowed auth redirect origins. Never point these sites at
production to unblock a check. External fonts, music and exercise-CDN loading are
also blocked in offline mode; those failures are not production-parity evidence.

## Activation Prerequisites

Prepared configuration is not deployed configuration. The initial read-only
check on 2026-09-07 found only production hosted, Cloudflare CLI unauthenticated,
no Actions variables/secrets, and only `validate` required on `release` with
admin bypass enabled. No environment, protection or live-site change is implied.

An authorized operator must:

1. Authenticate Cloudflare directly using `npx --yes wrangler@4.129.0 login`.
   Never paste API tokens or passwords into a chat. Confirm account, free quotas
   and no paid service activation before creating the three separate projects.
   Set each project's production branch to its mapped `dev`, `release` or `beta`
   branch so the root project URL and CI branch agree.
2. Configure GitHub environments `formora-dev`, `formora-qat`, `formora-beta`,
   each with `CLOUDFLARE_PAGES_PROJECT`, `CLOUDFLARE_ACCOUNT_ID` and a scoped
   `CLOUDFLARE_API_TOKEN` secret. Set `FORMORA_STAGE_PREVIEWS_ENABLED=true` only
   after validating the projects and protection. CI publishes after all checks.
3. Configure separately protected `formora-qat-accepted` and
   `formora-beta-accepted` environments with named authorized reviewers and an
   approval process that records the exact candidate and private QA evidence.
   Merely creating an environment or a successful API status is not sign-off.
4. After approval to change repository protection, run
   `bash scripts/setup-pipeline.sh`. It requires all three checks with strict
   up-to-date branches and no admin bypass. It does not create reviewers,
   acceptances, test projects or credentials. Verify actual API settings after it.
5. Verify each published manifest, headers, denied private routes and browser
   isolation. Retest QAT/beta on the actual authorized test backend when ready.

`promote.yml` is a `workflow_run` workflow, so its hardened PR-creation guard
only becomes active when the workflow and helper reach the default branch through
an authorized promotion. A `dev`-only push does not update `main` or production.

## Version Changes

Keep `version.txt`, every cache-bust `?v=` and `var V` in `index.html` aligned.
Native assets must be rebuilt from the accepted candidate; historical APK/iOS
checks cannot certify later source. Promotion and approval records stay tied to
their original SHA rather than silently becoming evidence for the next edit.
