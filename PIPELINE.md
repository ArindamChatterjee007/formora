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

Default build mode is **offline-preview**: production auth, backend, analytics,
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

The optional **isolated-backend** mode is restricted to the `formora-qat` site
and its separately provisioned Supabase test project. Set
`FORMORA_QAT_BACKEND_CONFIG` to a JSON file containing only `projectRef` and
the project's public `anonKey`. The shared validator in `scripts/qat-config.cjs`
rejects production references and privileged keys. The builder permits only that
backend origin in CSP; analytics, providers, payments and unaccepted feature
flags remain disabled. The manifest records the project identity, not its key.

`supabase/core-schema.sql` is a fresh-install bootstrap, not an upgrade: its
transaction refuses any existing public table or view. Apply the existing
`supabase/security.sql` afterward on the isolated project, followed by
`supabase/request-actions.sql`. The request-only migration requires the exact
core policy names, a security-invoker feed RPC and compatible canonical request
identities; it refuses legacy or already-applied baselines without rewriting
them. It restricts reads to participants, acceptance to the recipient and
updates to the status column. Participant deletion also supports disconnects;
the client decline/cancel path additionally requires pending status so stale
controls cannot remove an accepted connection. Never apply the
bootstrap to production or clone customer records into QAT. The reusable
`scripts/verify-qat-core.cjs --hosted` runner accepts QAT-only keys through
`FORMORA_QAT_ANON_KEY` and `FORMORA_QAT_SERVICE_KEY`, creates three temporary
synthetic accounts, checks actual Auth/PostgREST isolation, and records exact
fixture cleanup. Keep credentials in the secret store, not command arguments or
reports. These core checks do not accept media, provider or device workflows.
Do not rerun the broad security script after installing request actions: it
replaces the named policies. Preserve a restricted policy/grant snapshot before
an authorized upgrade; there is no destructive automatic rollback. Retain the
tighter request policies if reverting the UI, and keep QAT offline if its
request contract cannot be verified. Production rollout needs its own legacy
inventory and recovery approval.

`supabase/notification-admission.sql` follows the core security and request
actions migrations. It refuses unexpected policy names, a preclaimed server
notification namespace or legacy source identities. Save a restricted schema,
policy and grant snapshot before an authorized upgrade. It preserves historical
notification rows; it does not erase stored legacy prose or attest delivery.
The matched client dispatches through `admit_social_notification`; old direct
notification inserts are deliberately denied. Source triggers emit supported
reference-only alerts atomically with messages, comments, likes, connection
changes, reshares and new follows, even if the client loses its acknowledgement.

Technical bounds are 60 alerts/minute and 500/day per actor, plus 50/minute and
250/day per actor-recipient pair, counting only the new server namespace.
Recipients additionally admit at most 100 alerts/minute and 1000/day across all
senders. Recipient admission uses a nonblocking transaction lock: contention
returns a retryable PT429 instead of creating a cross-recipient lock wait.
Existing event retries return before capacity checks and do not consume another
slot. These limits apply to notification admission, not the recipient's reads.
Comments fan out to at most 20 distinct recipients total. Same-actor source
writes serialize before row locks. A limit error rolls back the source write
and its alerts, so clients must preserve retryable drafts. Profile insertion
and bulk updates adding more than 20 follows are treated as state restoration:
the profile is saved without replaying historical follow alerts. Ordinary
updates notify only newly added follows. Unlike/relike and unfollow/refollow reuse an event identity, while a
recreated connection request is distinguished by its source timestamp.
These are bounded implementation defaults, not approved production operations
or proof against coordinated abuse across accounts. Production requires its
own legacy inventory, recipient-safety review and recovery approval.

Run `scripts/verify-qat-core.cjs --hosted --notifications` with the same isolated
QAT keys to verify automatic source fanout, source-derived admission, duplicate
read preservation, actor/recipient isolation and denied direct inserts. Every
runner mode now removes alerts owned by its exact temporary accounts during
cleanup. Do not revert to an old connected client or rerun broad `security.sql`
after these migrations; retain the tighter policies and use the isolated offline
preview if the matched client/backend contract cannot be verified.

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
