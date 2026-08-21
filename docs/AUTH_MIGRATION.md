# Formora — Supabase Auth Migration Plan (fixing access control)

**Goal:** close OWASP A01 for real — bind every row to an authenticated identity so
members can only read/write their own private data (profiles' biometrics, DMs,
notifications), while the public feed still works. This is the only complete fix
for the exposure found in the v95 audit.

## Why the last attempt (v78) was reverted — and how we avoid it

The prior migration (commits `0639783` v77, `0ca1e6c` v81, reverted in `8a83285`)
broke cross-device login: users were logged out on refresh and posts stopped
showing. Root causes and mitigations this time:

| v78 failure | Mitigation |
| ----------- | ---------- |
| Session dropped on transient 5xx/network | Only drop the session on 400/401 (v81 already did this — keep it) |
| New-device login lost the user's data | Keep `uid = uidFor(email)` as stable identity; on login, adopt the existing uid so posts/logs reconnect (v81 "login-or-create") |
| Posts vanished under RLS | SELECT policy must allow reading **public** posts/profiles by anyone; only writes and private tables (messages, notifications) are owner-scoped |
| Big-bang cutover on prod | Ship behind `USE_SUPABASE_AUTH` flag (OFF = today's behavior), test flag-ON in staging, apply RLS on a **staging Supabase project first** |

## Staged rollout (through the `dev → release → beta → main` pipeline)

**Phase 0 — done (v95/v96):** output escaping, CSP, PBKDF2, and **data minimization**
(biometrics no longer uploaded). Shrinks the blast radius before touching auth.

**Phase 1 — revive behind the flag (feature branch off `dev`):**
- Restore `js/supaauth.js` from history (`git show 0ca1e6c:js/supaauth.js`) — the
  GoTrue wrapper (session persist + JWT refresh, drops session only on 400/401).
- Add `window.USE_SUPABASE_AUTH = false` to `config.js`.
- In `cloud.js`, when the flag is on, send the **user's JWT** (not the anon key) on
  writes/reads; keep `uid = uidFor(email)` and store it as auth user metadata so
  RLS can compare `auth.jwt()->>'uid'` (or map `auth.uid()`).
- Flag OFF ⇒ byte-for-byte today's behavior (CI + QA proves no diff).

**Phase 2 — staging test (flag ON, staging Supabase project):**
- New signup, login, logout, **reload keeps session**, cross-device login
  reconnects the same uid and shows the feed. DMs/notifications only show mine.

**Phase 3 — RLS on staging:** apply [supabase/security.sql](../supabase/security.sql)
(policies keyed to the authenticated uid). Re-run Phase 2; confirm the public feed
still loads while private tables are locked.

**Phase 4 — data migration:** create `auth.users` for existing members (email →
same `uid`), backfill; verify old posts/logs reconnect.

**Phase 5 — production cutover (monitored, reversible):**
1. Deploy code with the flag still OFF → no change.
2. Apply RLS to prod during a low-traffic window.
3. Flip `USE_SUPABASE_AUTH = true` via a one-line deploy through the pipeline.
4. **Rollback** if anything breaks: flag OFF + `alter table … disable row level
   security` (rollback block is in `supabase/security.sql`).

## Acceptance criteria (must all pass before Phase 5)
- Reading another member's raw `weight/BMI/height/gender` or **DMs** via the anon
  key returns **nothing** (today it returns everything).
- Login persists across reloads and devices; the feed shows all public posts.
- Every existing member's posts/logs still reconnect after migration.
