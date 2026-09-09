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
   The same job first type-checks and builds the pinned Deno media parser, runs
   synthetic media against the actual package with networking denied, and checks
   package tampering controls. Its verification JSON is retained; binary packages
   and media fixtures are not uploaded. None of these checks deploys a function.
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

## Story Media Parser

The optional `parse-story-media` function is a separate service-authenticated
parser isolate. Supabase's hosted runtime does not provide the Web Worker API
used by the existing local worker path. The parser package instead uses the
pinned MediaInfo browser module and hash-checked, in-memory WASM. This service
does not perform Auth, SQL, Storage or publication calls. Its runtime still has
the project's automatically injected environment; it is not a credential-free
sandbox for untrusted parser code.

Source placeholders deliberately fail closed. Run
`node scripts/verify-story-parser-runtime.cjs` with Deno 2.9.6, FFmpeg, the
installed Chromium fixture dependency and frozen cached Deno dependencies. CI
prepares that cache with `deno cache --frozen --config
supabase/functions/parse-story-media/deno.json
supabase/functions/parse-story-media/index.ts scripts/verify-story-parser-service.ts`.
The runner builds a fresh package below `dist/story-parser/`, copies the upstream
license, checks both entrypoints, exercises supported and hostile media, and
rejects modified package code even when its recorded hash is rewritten. An
optional existing synthetic fixture directory avoids regenerating local media.
The package builder is `scripts/prepare-story-parser.cjs`; its only resource
replacement happens inside a new ignored output directory. Keep the generated
package, payload and private test evidence out of public commits and site bundles.

Both function entries in the generated `supabase/config.toml` retain
`verify_jwt = true`. Deploy only the explicitly named `parse-story-media` with
`--use-api --jobs 1 --workdir <verified-package> --project-ref <isolated-project>`.
Never deploy all functions or use `--no-verify-jwt`. Verify project identity,
source/package hashes, original functions and secret inventory before deployment.
Do not adopt or overwrite an existing function without a reviewed rollout.

Parser startup requires `STORY_MEDIA_PARSER_ENABLED=true` and a random server-only
`STORY_MEDIA_PARSER_KEY` of at least 32 random bytes encoded as base64url. Keep it
in the approved secret store, never browser configuration or reports. The
validator separately requires `STORY_MEDIA_PARSER_SERVICE_ENABLED=true` to use
the service. Setting the shared key alone does not switch its route. Without
the explicit route or a supported local Worker, validation fails before any
reservation claim. Deployment and secret changes are project-wide operations:
keep `STORY_MEDIA_VALIDATION_ENABLED`, SQL admission and customer flags off while
deploying and verifying the parser first. Only a separately accepted rollout
may enable the matched validator and Storage/publication path.

The caller enforces a whole-operation deadline of at most ten seconds and
rejects late, foreign or mismatched acknowledgements. The callee's lock is per
isolate, not a global capacity cap, and remains held until parsing settles.
Neither an aborted fetch nor this lock terminates synchronous WASM at ten
seconds. Hosted provider CPU/wall limits are different guarantees. Hard callee
termination, global admission, hosted Storage ordering and approved operating
policies remain required gates; do not enable customer media on this evidence.
Service contention returns `parser_busy` and is treated as a retryable
infrastructure failure, but the earlier reservation claim still consumes one
of its three validation attempts. Renewal does not reset that cap. Do not
silently refund attempts or retry in a loop. Load acceptance must cover
multi-validator contention before opening admission. The fixed service response
also requires the parser library version; missing provenance fails closed.

Recovery disables validator admission and `STORY_MEDIA_PARSER_SERVICE_ENABLED`
first, then disables the parser and removes only credentials/functions owned by
the authorized test window. Recheck original function identities, code, JWT
settings and secret digests. Do not delete accounts or Storage objects as part
of parser-only cleanup, retry an uncertain publication, or fall back to parsing
untrusted bytes in the validator isolate.

## QAT Registration Consent

`supabase/registration-consent.sql` is a fresh, default-off QAT experiment.
Install it only after `billing-events.sql`, `analytics-outbox.sql` and
`activation-events.sql` on the explicitly identified isolated backend. It pins
the existing activation verifier before replacing that routine in the same
transaction; never edit an already-installed baseline or relax consent clocks.
Record the source hashes, previous routine definition, Auth trigger inventory,
effective grants and an API-to-SQL project binding before installation.

For a bounded synthetic test window, the activation source must be `local_test`,
its consent version and the analytics consent version must match the QAT notice,
and billing collection and delivery must both stay off. The displayed notice's
SHA-256 must match `registration_consent_config.notice_sha256`. Only an isolated
QAT build with `FORMORA_QAT_REGISTRATION_CONSENT=1` exposes the optional checkbox;
ordinary builds keep it off. Retention and production registration approvals
remain false. No production measurement or external provider delivery is
authorized by these tests.

Receipts contain a hashed random proof and a per-attempt salted email commitment,
not the email, IP or health data. A receipt expires for redemption after fifteen
minutes and can bind once during real Auth insertion. Auth user and identity
metadata triggers remove the ephemeral proof and salt. Test actual GoTrue
signup, returned metadata, identities and withdrawal separately from SQL
fixtures. Database/Auth clock disagreement fails closed; do not backdate consent
or relabel an existing account as newly registered. The existing privacy
controller supports withdrawal without approving billing or checkout tracking.

GoTrue may echo the original signup metadata in its first response even when
database triggers removed the proof and salt. QAT proof-bearing signups therefore
use `supabase/functions/registration-signup/index.ts`, never direct GoTrue. This
adapter is default-off, pins the isolated QAT project and site origin, forwards
only the signup fields using its public anon key, discards the initial session,
and returns an allowlisted user with a newly refreshed, proof-free session.
Decoded JWT checks protect the response boundary; they are not signature-based
authorization. The intentional test-cohort claim may remain. Provider-held logs
and the discarded first token are not claimed to be erased or revoked.

Before enabling `REGISTRATION_SIGNUP_ENABLED`, verify the exact committed Auth
user and identity scrub triggers are installed and enabled on QAT. Deploy only
`registration-signup` with `--use-api --project-ref` set to the isolated project;
retain normal gateway JWT verification. The app sends the public anonymous bearer
to that gateway. Never deploy all functions, use a service key in the adapter,
point it at production, or resend a proof-bearing signup through direct GoTrue
after adapter failure. An uncertain signup asks the member to sign in first.
Plain signup remains direct and carries no reserved proof fields. Keep the
adapter disabled outside an explicitly authorized QAT test window until real
response, JWT, stored metadata, replay and withdrawal checks all pass.

Anonymous issuance has a global twenty-per-minute and three-hundred-outstanding
cap. A caller can exhaust this test capacity; registration still works without
measurement. Expiry is not a physical deletion guarantee: bounded issue-time
cleanup removes old receipts, and the test operator must remove only the exact
synthetic fixtures and verify cleanup. Do not claim a retention policy from TTL.

Recovery first disables the QAT receipt policy and activation collection and sets
`REGISTRATION_SIGNUP_ENABLED=false`, then
restores the default-off frontend. This invalidates in-flight proofs without
changing customer records. If an Auth-trigger fault requires removal, use an
explicitly reviewed transaction that drops `activation_bind_registration_consent`
and `activation_strip_registration_identity` before removing their functions or
tables. Retain the private audit/inventory and restore only the exact saved
verifier definition. Never drop dependent tables first or apply this procedure
to production without separate review.

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
