# Formora — Execution Plan (0 → Revenue)

_A concrete, sequenced plan to go from today (live, free, pre-revenue) to first dollar and to $1k → $10k MRR. Time-boxed in weeks. Assumes a solo founder working part-time; costs stay ≈ $0 until revenue justifies spend._

---

## Milestone ladder (what "winning" looks like)
1. **M0 — Chargeable:** a user can pay and unlock Pro. (Tech done.)
2. **M1 — First dollar:** first paying customer.
3. **M2 — $100 MRR:** ~15–25 subscribers. Proof people pay.
4. **M3 — $1,000 MRR:** top-17% of all subscription apps. Ramen signal.
5. **M4 — $10,000 MRR:** real business; justify full-time + paid UA.

---

## Phase 0 — Foundation (Weeks 1–3)  ·  cost ≈ $0

**Goal: be *able* to charge money.**

- [ ] **Finish auth migration** (Phases 2–5 in `AUTH_MIGRATION.md`): enable Supabase Email provider, test flag-on in staging, apply RLS on a staging project, data-migrate, cutover with rollback. *(P0 blocker for entitlements.)*
- [ ] **Open a Merchant-of-Record account** (Lemon Squeezy or Paddle) — no company needed to start; connect an Indian bank for payouts. *(In parallel: note Razorpay needs a proprietorship + PAN + GST for India later.)*
- [ ] **Legal minimums:** Terms of Service, Privacy Policy, **"not medical advice" disclaimer**, refund policy. (Use standard templates; link in footer + onboarding.)
- [ ] **Analytics:** add PostHog (free tier) — track signup → activation → paywall → purchase funnel.

**Exit criteria:** auth live, MoR account approved, legal pages live, analytics firing.

---

## Phase 1 — Build the money layer (Weeks 3–6)  ·  cost ≈ $0

**Goal: implement `MONETIZATION_SPEC.md`.**

- [ ] 3 edge functions: `create-checkout`, `billing-webhook`, `billing-portal`.
- [ ] `entitlements` table + RLS + `get_entitlement` RPC.
- [ ] `js/entitlements.js` + `js/paywall.js` + feature-gate the premium call-sites.
- [ ] **Onboarding quiz → preview plan → trial paywall** funnel.
- [ ] Define products/prices in the MoR: **Pro $7.99/mo · $49.99/yr**, **Elite $19.99/mo · $149/yr**, **5–9 day trial**, PPP for India (₹149/mo · ₹999/yr).
- [ ] Staging QA (test cards): free→paywall→pay→Pro unlock→cancel→downgrade.
- [ ] Ship through pipeline behind `USE_PAYMENTS=false`, then flip in prod.

**Exit criteria (M0): a test purchase flips `tier=pro` server-side in production.**

---

## Phase 2 — Soft launch & first customers (Weeks 6–8)  ·  cost ≈ $0

**Goal: M1 → M2 (first dollar → $100 MRR). Sell to people who already trust you.**

- [ ] Turn on the trial + paywall for **existing users** and a small invite beta (friends, gym network, fitness subreddits/Discords you're in).
- [ ] **Founder-led sales:** personally DM/onboard the first 50 users; ask the blunt question "would you pay ₹999/yr for the AI coach?" and watch the funnel.
- [ ] Ship 1–2 **must-have Pro features** that justify the price (real AI meal plan; AI progress-photo teaser).
- [ ] Instrument + fix the biggest funnel drop (activation or paywall).
- [ ] Add **annual plan emphasis** (cash flow) + an intro offer (H&F apps use offers 15%+).

**Exit criteria (M2): ~15–25 paying subscribers, funnel measured.**

---

## Phase 3 — Growth engine (Weeks 8–12)  ·  cost ≈ $0–100

**Goal: toward M3 ($1k MRR) via the built-in viral loops — no ad budget.**

- [ ] **Content loop (daily):** post 1 Flex/transformation/tip reel per day to TikTok/IG/Shorts, watermarked "made with Formora." This is the #1 free channel.
- [ ] **SEO lead magnets:** publish free calorie/macro/BMI/"how to get [look]" calculators + guides → email capture → onboarding.
- [ ] **Referral program:** invite 3 friends → 1 free Pro month (both sides).
- [ ] **Micro-influencer outreach:** DM a list of **20 fitness micro-creators** (10k–100k) → free Elite + a creator storefront in exchange for a post. Track conversions.
- [ ] **Affiliate v1:** add 5–10 affiliate product links (supplements/gear) → first non-subscription revenue.
- [ ] **Push notifications:** streaks + challenge reminders + win-backs (churn is ~23% involuntary/inactivity).

**Exit criteria (M3): $1,000 MRR OR a clearly working loop (K-factor > 0 or CAC-free channel converting).**

---

## Phase 4 — Scale & diversify (Quarter 2+)  ·  reinvest revenue

- [ ] **App Store + Play** ($99 + $25) — do this *after* $1k MRR proves economics; add RevenueCat for unified IAP entitlements.
- [ ] **Coaching marketplace** (15–20% take rate) — turns Elite + community into two-sided revenue.
- [ ] **Creator program** — creators sell programs (rev-share) → supply + growth.
- [ ] **Regional pricing** everywhere; **paid UA tests** (Apple Search Ads on high-intent keywords) *only* once LTV:CAC > 3.
- [ ] **Brand-sponsored challenges**; **B2B white-label** pilot with 1 local gym/trainer.

**Exit criteria (M4): $10,000 MRR → justify going full-time / raising.**

---

## The weekly operating rhythm (repeat)
- **Mon:** review funnel metrics (signup, activation, trial, paid, churn). Pick 1 bottleneck.
- **Tue–Thu:** ship 1 improvement to that bottleneck through the pipeline.
- **Daily:** 1 content post (the growth loop) + reply to community.
- **Fri:** 5 creator/partner DMs; log revenue; update this checklist.

---

## Money math (how the numbers add up)
- To hit **$1k MRR** at a blended net ARPU ≈ **$3/mo** (mix of monthly, annual, PPP), you need ≈ **330 active subscribers**.
- At a **3% free→paid** rate, that's ≈ **11,000 engaged users** — reachable via the content + referral + creator loops without ad spend.
- Affiliate + first coaching deals can add **10–30%** on top with near-zero marginal effort.

---

## Cost timeline
| Stage | Spend | Why |
|---|---|---|
| Phases 0–3 | **~$0** | Free stack (Pages, Supabase, PostHog free, MoR = % only) |
| First revenue | Domain (~$12/yr), optional | Branding |
| Phase 4 | $99 Apple + $25 Google | Store distribution |
| Post-$1k MRR | Supabase paid (~$25/mo) + small UA tests | Scale |

**Principle:** spend nothing you don't have to until a loop is proven. Reinvest revenue, not savings.

---

## Risks to the plan (and the move)
- **Auth migration slips** → everything waits. *Move:* timebox it; it's the gate.
- **People won't pay** → *Move:* founder-led sales in Phase 2 gives the answer in weeks, cheaply. If no, pivot the offer (coaching-first, or B2B) before building more.
- **Content loop doesn't spread** → *Move:* test 3 content formats × 2 weeks; double down on what gets views.
- **Solo bandwidth** → *Move:* the pipeline + reused code + this checklist keep scope tight; say no to P2 until P0/P1 pay.
