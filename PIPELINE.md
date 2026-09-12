# Formora Release Pipeline

```text
Development      Independent QAT       Beta acceptance       Production
dev          ->  release           ->  beta              ->  main
cloud fixtures   isolated test site    isolated beta site    existing Pages site
```

Production is last, never the environment used to discover QAT failures.
Production: https://formora-app.pages.dev/
Legacy fallback: https://arindamchatterjee007.github.io/formora/
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

### Local Supervised Prototype

`scripts/story-parser-supervisor.cjs` and `scripts/story-parser-process.ts`
provide a local-only process boundary. They are not connected to the deployed
validator or a public endpoint. Use GNU coreutils `timeout` (Homebrew `gtimeout`
on macOS) and the existing pinned, cached Deno/parser dependencies:

```sh
node --test --test-concurrency=1 tests/story-parser-supervisor.test.cjs
node scripts/verify-story-parser-supervisor.cjs --photo <existing-synthetic-fixture-directory>
node scripts/verify-story-parser-supervisor.cjs --formats <existing-synthetic-fixture-directory>
node scripts/verify-story-parser-supervisor.cjs --controls
```

`STORY_MEDIA_TIMEOUT` and `STORY_MEDIA_DENO` can specify trusted absolute
executable paths; `STORY_MEDIA_DENO_DIR` selects the existing dependency cache.
No downloads, hosted calls or browser fixture generation occur in these checks.
The format runner rehashes an existing synthetic manifest and creates a fresh
parser package and private evidence below `dist/story-parser-supervisor/`.
The Linux CI job reuses the fixture directory returned by the existing package
verifier, then runs both formats and process controls with resolved absolute
runtime/watchdog paths. Only the verification JSON reports are uploaded; media,
generated parser packages and private office records are not artifacts. The
ordinary public unit phase also runs the process-boundary regression tests.

The caller supplies a monotonic deadline before startup and input transfer.
Ten percent of its remaining budget is explicitly reserved for termination and
cleanup, never added after the deadline. An independent GNU watchdog and a parent
timer send `SIGKILL` to the owned process group. An ACK is returned only after
exit, stream closure and bounded process-group readback, within the original
deadline. Cancellation/deadline rejection can precede cleanup: callers must await
the separate `cleanup` promise. Unconfirmed cleanup leaves that supervisor busy;
it has no automatic retry or unsafe reset. Group-only readback records zombies
as stopped, not reaped, and does not prove an escaped process was contained.

Input is capped at 25 MiB, stdout at 2 KiB, stderr at 1 KiB and concurrency at
one job per supervisor instance. The Deno worker denies file reads/writes,
network, subprocesses, FFI, system-information APIs and remote imports. Its
pinned debug dependency requires environment enumeration, so only an explicitly
clean launch environment is supplied; the worker rejects unexpected names and
allows the observed Deno/macOS shim variables. No backend credentials are passed.
The 128 MiB V8 old-space setting is not a native/WASM/RSS memory limit.

The controls exercise actual permission-denied operations and non-yielding WASM,
without allowing ordinary I/O failures to stand for denied permissions. Local
measured termination is not a real-time or hosted guarantee. OS memory/process
containment, Linux target tests, global capacity, remote deadline admission and
hosted acceptance remain required before adopting this route. Existing customer
flags and production are unchanged by this prototype.

## Sharing Posts To Stories

`supabase/story-post-sharing.sql` is a separate, one-time migration after
`story-interactions.sql` and the canonical posts schema. It can be installed
before or after `story-media.sql`; it neither enables Story policy nor bypasses
the media validation/Storage triggers. Save the existing Story function
definitions, constraints and permissions before an authorized deployment.
Do not reapply the fresh Story or media schemas to an installed environment.

The share sheet offers Add to story only when Stories are enabled. It requests
the current public post preview, shows its author and photo/caption, and waits
for explicit confirmation. `publish_post_story` stores only the post ID,
original author UUID and original creation timestamp, not copied caption or
media. Those three values are bound to the same retry receipt. Removed or
replaced sources, non-public source profiles and source-author/sharer blocks
make the reference unavailable to every viewer; viewer-specific blocks also
apply. A source caption edit is reflected on the next checked read. The Story
expires after 24 hours; no physical erasure claim is introduced.

`get_shareable_story_post` returns a minimized current preview, not a general
post dump. Inline JPEG/PNG/WebP previews are capped at 2 MiB including the data
URL; same-project public Storage URLs are separately validated. Unsupported or
larger images return an explicit unavailable-photo state. Only this endpoint
has a 2 MiB + 32 KiB response bound; ordinary Story responses remain 256 KiB.
Carousels preview the first photo; video references show a Video post label and
open the original post. A view costs two actor reads (Story and current post);
opening the original repeats these checks. Fresh sharing also consumes the
source author's existing recipient limit, bounding cross-account share traffic.
It sends no notification or copied private content.

The existing photo upload must decode resized JPEG data locally, never use
`fetch(dataUrl)`: production `connect-src` does not allow `data:`. Storage uploads
refresh the authenticated bearer and use the canonical owner path. A saved
upload is reused when Story publication needs retry, and the composer clears
only after the exact owned publication receipt. Do not loosen CSP or use an
anonymous bearer to work around an expired session.

Run the focused `story-post-sharing.test.cjs` and Story cases in
`social-publishing.test.cjs` / `social-publishing.e2e.cjs`. The latter uses real
app controls with isolated services and SQL; it is not a production or provider
test. Default flags remain off until the matching hosted policies, actual
workflow checks and normal stage approvals are satisfied.

## Story Media Admission

The fresh `supabase/story-media.sql` schema requires explicit `global_pending`,
`global_requests_per_day` and `global_bytes_per_day` values before media can be
enabled. They start unset; supplying a number is not budget or retention approval.
Existing per-owner limits and all policy approvals still apply. Do not rerun this
fresh-install migration on existing buckets or tables or invent approved limits
from a synthetic test configuration.

New reservations take a nonblocking transaction-scoped global advisory lock.
Contention returns PT429 with `details=media_admission_busy` without inserting a
reservation; an exhausted global quota uses `details=media_admission_global_limit`.
The same lock guards
renewals that can reopen a pending slot. Count and byte budgets cover first
admissions across every owner for the current UTC day; cancellation, validation
failure and expiry do not refund that day's charge. Exact active-request replay
does not consume another admission, and renewal retains the original charge,
identity and three-attempt limit. Changing any global quota advances the policy
epoch and fences old work. Owner quota checks run before the global lock. The
schema provides date and active-expiry indexes; actual query plans remain a
hosted acceptance check.
Only one global admission transaction can hold the lock at once. Other owners
receive a bounded refusal, not an unbounded wait. The current client preserves
the draft and request ID for manual retry and reports media as busy or limited;
it does not automatically repeat a reservation, upload or publication. An exact
retry after capacity is available still uploads at most once. This is not a
claim of high-throughput or automatic-backoff acceptance.
Nonrenewable stale work can cancel without taking the global admission lock.
An otherwise eligible renewal denied by global pending capacity returns PT429
without cancellation, so the same identity can be retried when a slot is free.
Stale-policy reservations still occupy their pending slots until cancelled or
expired; an epoch change does not manufacture new capacity. Lowering a daily
limit below consumed usage prevents fresh admission, not an otherwise eligible
uncharged renewal of the same identity.

Admission requires `READ COMMITTED` transactions. Snapshot isolation is refused
with PT503 before policy rows are read, because an earlier snapshot can hide a competing committed reservation
even after acquiring an advisory lock. Confirm the actual PostgREST transaction
isolation during hosted acceptance; even PostgreSQL's `READ UNCOMMITTED` alias
is conservatively refused. The local multi-session check separately
observes lock ownership, nonblocking denial and quota readback; removing the lock
is a failing control, not an accepted alternate configuration.

These limits are not global parser concurrency, retained-byte accounting,
Storage/egress billing, backend upload-abuse prevention or physical cleanup.
Yesterday's unchanged reservation can renew today without a new charge; it still
needs an available global pending slot. Keep cumulative retention and unknown
object reconciliation as separate gates, and keep media disabled until the
execution, Storage, policy and operating limits are independently accepted.

## Storage Upload Phases

Hosted Storage performs a permission-probe INSERT with version `1`, MIME and
declared `contentLength`, then rolls back that transaction before writing bytes.
The durable INSERT uses a distinct version, measured `size` and the preserved
owner fields, but runs as `service_role` with no `auth.uid()`. Treat these as
observed provider behavior, not a stable upstream API guarantee.

The guard validates declared length and authenticated ownership during the
permission phase. A deferred constraint trigger refuses to commit that temporary
row, then binds only a measured, exact-owner durable object to its reservation.
Public promotion additionally requires the existing exact lease and promotion
metadata. A zero-row binding aborts the transaction; Storage uniqueness is not
the only duplicate-write barrier. UPDATE, overwrite and unauthorized DELETE stay
denied. `_story_media_guards_present()` requires the commit trigger to remain
deferrable and initially deferred.

An immediate-constraint transaction or a provider change that commits the probe
fails closed. Probe and durable phases cannot share one transaction. Repeat
bounded, isolated compatibility checks after a provider change before reopening
admission; do not remove measured-size or commit checks to restore availability.
DDL rehearsal is not an actual guarded upload, immutable-version or physical
cleanup pass. Keep customer media off until those separate gates pass.

Cleanup accepts authenticated HTTP404 absence or HTTP400 with the exact JSON
error code `NoSuchKey` from the same fixed object URL. The HTTP400 error body is
bounded to 1024 bytes. Generic 400, `NoSuchBucket`, authorization, malformed and
oversized errors remain unknown. SQL records the raw `absence_http_status` and
`absence_error_code`, without rewriting a 400 observation to 404. The optional
last `p_get_code` argument of `finish_story_media_cleanup_object` defaults to
NULL for existing 404 callers; HTTP400 requires `NoSuchKey`. Deploy the matched
SQL and worker together. This is a fresh migration, not an upgrade over installed
cleanup tables or an authorization to rewrite existing receipts.

Completion still requires the original approved object, matching delete ACK,
exact worker lease and catalog-delete audit. Neither absence form proves backend,
backup or CDN erasure. The focused offline verifier
`node scripts/verify-story-media-cleanup-runtime.cjs --absence` runs the actual
Deno handler unit cases plus one SQL integration case; its other SQL cases are
explicitly unrun. CI retains that scoped verification record. `--local` runs
the full cleanup runtime suite separately when required.

Cleanup invocation additionally requires `STORY_MEDIA_CLEANUP_KEY`, a separate
random server-only credential of at least 32 bytes encoded as base64url, sent in
`x-story-media-cleanup-key`. Keep normal gateway JWT verification enabled. There
is no fallback to a member bearer or the backend service key; missing, short or
reused keys leave cleanup disabled. The injected backend key is used only for
the fixed same-project RPC/Storage requests. Verify both authentication and
backend access before authorizing a synthetic upload window, and remove temporary
invocation keys after tests. Never put either key in client settings or reports.

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
