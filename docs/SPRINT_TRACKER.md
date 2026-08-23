# Formora — Sprint Tracker & Plan

_Single source of truth for what's done, what's pending, and what we're building next. Sprints are ~1–2 weeks (solo, part-time). Update the checkboxes as work lands._

**Legend:** ✅ done · 🟡 in progress · ⬜ pending · 🔴 blocked

---

## 📊 Dashboard

| | |
|---|---|
| **Live version** | v97 (production, `main`) |
| **Current sprint** | **Sprint 1 — Real Auth in Staging** |
| **Critical path** | Auth migration → RLS security fix → Monetization → First revenue |
| **North Star** | Weekly active loggers-who-post |
| **Next revenue milestone** | M0 (chargeable) → M1 (first dollar) |

**Progress at a glance**
- Foundation & security: ✅ (v94–v97 shipped)
- Real auth (Supabase): 🟡 Phase 1/5 done
- Access-control fix (RLS): ⬜ blocked on auth
- Monetization (pay + gate): ⬜ spec'd, blocked on auth
- Growth & revenue: ⬜ planned

---

## ✅ Completed (shipped to production)

**Product polish (v82–v93)**
- ✅ Semantic version + About card, branded launch animation
- ✅ Tab slide transitions + finger-follow swipe pager
- ✅ Real Google OAuth (web + native Android/iOS clients) + scopes fix
- ✅ PWA — free install on iPhone/Android (no store fee)
- ✅ Camera fix (Android/iOS permissions) + pro SVG icons

**Security & quality (v94–v96)**
- ✅ **Stored-XSS fixed** — all 9 feed URL/style sinks escaped (+ CI guard)
- ✅ `timeAgo` hardening, food-quantity cap
- ✅ **CSP + Referrer-Policy**, security headers
- ✅ **PBKDF2** password hashing (legacy auto-upgrade)
- ✅ Removed hardcoded Pexels key; CI **secret-scan** gate
- ✅ **Data minimization** — biometrics no longer uploaded to cloud
- ✅ ISO 25010 / 27001 mapping, Performance budget + CI **perf-budget** gate

**Infrastructure**
- ✅ **CI/CD pipeline** `dev→release→beta→main` (auto-promotion PRs, branch protection, CI gates, bug template)

**Auth migration (v97)**
- ✅ **Phase 1** — `supaauth.js` revived behind `USE_SUPABASE_AUTH` flag (off; prod unchanged)

**Business & fundraising**
- ✅ Business model, monetization spec, execution plan
- ✅ **Investor pitch deck** (HTML + PDF + PPTX, 14 slides)

---

## ⬜ Backlog (prioritized)

### 🔴 Critical path (blocks revenue)
- ⬜ **Auth Phase 2** — enable Supabase Email provider; test flag-on in staging (signup/login/session/cross-device)
- ⬜ **Auth Phase 3** — apply `security.sql` RLS on a **staging** Supabase project; verify feed still works
- ⬜ **Auth Phase 4** — migrate existing members (email→`auth.users`), backfill
- ⬜ **Auth Phase 5** — production cutover (flip flag) + **RLS on prod** with rollback → **closes the critical access-control vuln (DMs/PII exposure)**
- ⬜ **P0 Monetization** — entitlements table + RLS, 3 edge functions (checkout/webhook/portal), `entitlements.js` + `paywall.js`, onboarding→paywall funnel

### 🟠 P1 (grow revenue & retention)
- ⬜ Real AI features (LLM meal/workout gen; AI progress-photo analysis) — the Pro hook
- ⬜ Referral system (invite → Pro credit)
- ⬜ Push notifications (streaks, win-backs)
- ⬜ Affiliate/store module
- ⬜ Regional / PPP pricing in paywall
- ⬜ Analytics (PostHog) + Terms/Privacy/**medical disclaimer**

### 🟡 P2 (scale & diversify)
- ⬜ Coaching marketplace (15–20% take)
- ⬜ Creator programs (rev-share storefronts)
- ⬜ App Store + Play distribution ($99 + $25) + RevenueCat
- ⬜ B2B white-label; brand-sponsored challenges; wearables (Apple Health/Google Fit)

### ⚪ Housekeeping / minor
- ⬜ **Rebuild native apps** — Android APK + iOS still on v93 (don't carry v94–v97 fixes) → `npm run sync` + gradle/xcodebuild, verify in APK
- ⬜ Publish Google consent screen (currently Testing — non-owner logins blocked)
- ⬜ Landing hero emoji chips → SVG (minor polish)

---

## 🏃 Sprint plan

> Each sprint has ONE goal (an outcome, not a task list). Ship through the pipeline. Definition of Done = merged to `main` + verified live/staging + no regressions.

### Sprint 0 — Foundation ✅ (complete)
**Goal:** _A secure, shippable product on an automated pipeline, with a funding-ready plan._
Delivered: v94–v97 security, CI/CD, business docs + deck. **Done.**

### Sprint 1 — Real Auth in Staging 🟡 (current)
**Goal:** _A user can sign up / log in with real Supabase Auth in staging, session persists across reload and devices, and the feed still loads._
- ⬜ Enable **Email provider** in Supabase (dashboard) — *needs you*
- ⬜ Flip `USE_SUPABASE_AUTH=true` in a staging config; QA signup/login/logout/reload/cross-device on `localhost:8010`
- ⬜ Fix any session/uid-continuity issues (v78 failure modes — see `AUTH_MIGRATION.md`)
**Acceptance:** flag-on staging: new signup → feed loads → reload keeps session → 2nd "device" reconnects same uid.
**Blocker:** Supabase dashboard access (enable Email provider).

### Sprint 2 — Lock Down the Database
**Goal:** _Production runs on real auth with RLS — the critical access-control vulnerability (readable DMs/PII) is closed._
- ⬜ Apply `security.sql` RLS on a staging project; verify public feed reads + private DMs are owner-only
- ⬜ Data-migrate existing members; verify posts/logs reconnect
- ⬜ Prod cutover (flip flag + apply RLS) with rollback ready; re-run the security probe → returns **nothing** for anon
**Acceptance:** with only the anon key, anon can no longer read another member's DMs / biometrics. Owner login + feed unaffected.

### Sprint 3 — Make It Chargeable (M0)
**Goal:** _A test purchase flips a user to Pro server-side; premium features gate correctly._
- ⬜ MoR account (Lemon Squeezy/Paddle) + products (Pro/Elite, trial, PPP)
- ⬜ `entitlements` table + RLS + 3 edge functions (checkout/webhook/portal)
- ⬜ `js/entitlements.js` + `js/paywall.js` + gate premium call-sites
- ⬜ Onboarding quiz → preview plan → trial paywall
- ⬜ Legal pages + PostHog analytics
**Acceptance:** staging test-card purchase → `tier=pro` in DB → gated features unlock → cancel downgrades. **First dollar collectable.**

### Sprint 4 — First Customers (M1 → M2)
**Goal:** _Real people pay; the funnel is measured._
- ⬜ Turn on trial + paywall for existing users + small beta
- ⬜ Ship 1 must-have Pro feature (real AI meal plan)
- ⬜ Founder-led onboarding of first 50 users; fix the biggest funnel drop
**Acceptance:** ≥15–25 paying subscribers; funnel instrumented; churn visible.

### Sprint 5 — Growth Engine (M3)
**Goal:** _A working, near-zero-CAC growth loop pointing at $1k MRR._
- ⬜ Daily watermarked Flex content loop; SEO calculators/guides
- ⬜ Referral program; 20 micro-creator DMs; affiliate v1; push notifications
**Acceptance:** a channel converts without ad spend (K>0 or organic signups→paid), trending to $1k MRR.

### Sprint 6+ — Scale
**Goal:** _$10k MRR path._ Native rebuilds + App/Play store, coaching marketplace, creator programs, regional pricing, first paid-UA tests once LTV:CAC > 3.

---

## 🎯 Milestones (revenue)
| | Meaning | Sprint |
|---|---|---|
| **M0** | Chargeable (can accept payment) | Sprint 3 |
| **M1** | First paying customer | Sprint 4 |
| **M2** | $100 MRR | Sprint 4 |
| **M3** | $1,000 MRR (top-17% of apps) | Sprint 5 |
| **M4** | $10,000 MRR | Sprint 6+ |

---

## 🔁 Cadence & Definition of Done
- **Weekly rhythm:** Mon review funnel/metrics → pick 1 bottleneck; Tue–Thu ship 1 fix; daily 1 content post; Fri partner DMs + update this tracker.
- **DoD:** merged to `main` via pipeline · CI green · verified live/staging · no regression · tracker updated.
- **Related docs:** `AUTH_MIGRATION.md` · `MONETIZATION_SPEC.md` · `EXECUTION_PLAN.md` · `BUSINESS_MODEL.md` · `PITCH_DECK.md`.

_Last updated: 2026-08-23 (v97)._
