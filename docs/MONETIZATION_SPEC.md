# Formora — P0 Monetization Build Spec

_Concrete engineering spec to let Formora charge money. This is the first milestone **after** the Supabase Auth migration (`AUTH_MIGRATION.md`), because entitlements must be tied to a server-verified identity. Ships through the existing `dev → release → beta → main` pipeline behind a `USE_PAYMENTS` flag._

---

## 0. Dependency & non-negotiables
- **Depends on:** real accounts (Supabase Auth) so `entitlement.uid == auth.uid()` and can't be spoofed.
- **Money never depends on client state.** The client *reads* an entitlement; the *source of truth* is a DB row written only by a signed payment webhook (service role).
- **No secret keys in the browser.** All secrets live in Supabase Edge Function env vars.

---

## 1. Payment provider decision (solo founder, India → global)

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Lemon Squeezy / Paddle (Merchant of Record)** | MoR handles **global sales tax/VAT**, chargebacks, payouts to Indian bank; no need to register for tax in every country; subscriptions + trials built in | ~5% + fees (higher than Stripe) | ✅ **MVP choice** — least legal/tax overhead for a solo founder going global |
| **Razorpay** | India-native, UPI/cards, subscriptions, intl cards; low fees domestically | You are merchant of record (own GST/tax handling); intl support narrower | ✅ **Add for India volume** |
| **Stripe** | Best DX/docs, Stripe Billing + Customer Portal | Stripe India needs a registered entity; you handle tax | Later, once incorporated |
| **RevenueCat** | One entitlement source across web + App Store + Play IAP | Overkill pre-native | ✅ **Add when launching native IAP** |

**Recommendation:** launch on a **Merchant-of-Record (Lemon Squeezy or Paddle)** for web subscriptions — same webhook→entitlement architecture below, minimal legal setup. Swap/add Razorpay + RevenueCat later. The architecture is provider-agnostic (all use hosted checkout + webhooks).

---

## 2. Architecture (web-first, serverless)

```
[Static app] --JWT--> [Supabase Edge Function: create-checkout]
     |                          |  creates hosted checkout w/ uid in metadata
     |                          v
     |                   [MoR / Stripe hosted checkout]  <-- user pays
     |                          |
     |                          v (webhook, signed)
     |            [Edge Function: billing-webhook] --service role--> [entitlements table]
     v                                                                    ^
[Entitlements module reads tier] <---- get_entitlement RPC (RLS: own row) --
```

No app server needed — three Supabase **Edge Functions** (Deno) do everything.

---

## 3. Data model (Supabase / Postgres)

```sql
create table public.entitlements (
  uid                text primary key,          -- == auth.uid()::text
  tier               text not null default 'free',  -- free | pro | elite
  status             text not null default 'inactive', -- active | trialing | past_due | canceled | inactive
  provider           text,                       -- lemonsqueezy | razorpay | stripe | appstore | play
  product_id         text,
  customer_id        text,
  subscription_id    text,
  trial_end          timestamptz,
  current_period_end timestamptz,
  updated_at         timestamptz default now()
);
alter table public.entitlements enable row level security;
create policy ent_read_self on public.entitlements for select using (auth.uid()::text = uid);
-- NO insert/update policy for anon/authenticated → only the service-role webhook writes.

-- audit log (optional but recommended)
create table public.billing_events (
  id bigserial primary key, uid text, type text, raw jsonb, created_at timestamptz default now()
);
```

Entitlement read via a `SECURITY DEFINER` RPC or included in `get_state`:
```sql
create or replace function public.get_entitlement()
returns public.entitlements language sql security definer set search_path=public as $$
  select * from public.entitlements where uid = auth.uid()::text;
$$;
```

---

## 4. Edge Functions (`supabase/functions/`)

**`create-checkout/index.ts`** — verifies the caller's Supabase JWT → creates a hosted checkout session with `uid` in metadata + `current_url` return → returns `{ url }`.

**`billing-webhook/index.ts`** — verifies provider signature → maps event → upserts `entitlements` (service-role key):
- `subscription_created`/`order_created` → `status=active|trialing`, set `tier` from `product_id`, `current_period_end`.
- `subscription_updated` → sync status/period.
- `subscription_cancelled`/`expired` → `status=canceled`, on period end downgrade `tier=free`.
- Idempotent (store event id), log to `billing_events`.

**`billing-portal/index.ts`** — returns a customer-portal URL for manage/cancel.

Secrets (Edge env): `PROVIDER_API_KEY`, `PROVIDER_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`.

---

## 5. Client modules (`js/`)

**`js/entitlements.js`**
```js
const Entitlements = {
  _e: { tier: 'free', status: 'inactive' },
  async load() { /* if Cloud.active(): fetch get_entitlement via JWT; cache */ },
  tier() { return this._e.tier; },
  isPro()  { return ['pro','elite'].includes(this._e.tier) && this._active(); },
  isElite(){ return this._e.tier === 'elite' && this._active(); },
  _active(){ return ['active','trialing'].includes(this._e.status); },
  has(feature) { return TIER_OF[feature] === 'free' || (TIER_OF[feature]==='pro'&&this.isPro()) || (TIER_OF[feature]==='elite'&&this.isElite()); },
  gate(feature, onOk, onPay) { return this.has(feature) ? onOk() : (onPay||Paywall.open)(feature); },
};
```

**Feature → tier map (`TIER_OF`) — concrete gates**
| Feature | Free | Pro | Elite |
|---|---|---|---|
| Basic workout / logging / feed view | ✅ | ✅ | ✅ |
| 10 camera filters | ✅ | ✅ | ✅ |
| AI adaptive plans (unlimited) | — | ✅ | ✅ |
| Full AI meal plans + grocery list | — | ✅ | ✅ |
| Advanced analytics / all filters / no ads / unlimited Flex | — | ✅ | ✅ |
| AI progress-photo analysis | — | — | ✅ |
| Monthly human-coach credit | — | — | ✅ |

**`js/paywall.js`** — renders the tier table + trial CTA; "Upgrade" → calls `create-checkout` → `location.href = url`. "Manage" → `billing-portal`. Reused everywhere via `Entitlements.gate(...)`.

**Wiring:** on boot, after auth, `Entitlements.load()`. Gate the premium call-sites (e.g., `MealPlanner.generate` full mode, camera premium filters, analytics tab) with `Entitlements.gate('aiMeal', run, ()=>Paywall.open('aiMeal'))`.

---

## 6. Onboarding → paywall funnel (conversion)
1. Signup → **quiz** (goal look, experience, equipment).
2. Generate a **preview plan** (the "aha" — proven web-to-app pattern, Flo/Zoe).
3. **Trial paywall** (5–9 day free trial) with the tier table + social proof.
4. Soft copy ("Start your free week"), monthly + annual toggle (annual ~17% off), PPP price by geo.

---

## 7. Security checklist
- [ ] Webhook signature verified; reject unsigned.
- [ ] Entitlement writes only via service role (no client RLS write policy).
- [ ] `uid` from verified JWT, never request body.
- [ ] Idempotent webhook (dedupe by event id).
- [ ] Client tier is a *cache*; server re-checks on sensitive actions.
- [ ] CSP: add provider checkout + webhook origins to `connect-src`/`frame-src`.
- [ ] Refund/chargeback → webhook downgrades tier.

---

## 8. Testing & rollout (through the pipeline)
1. Provider **test mode** + test cards; local webhook via provider CLI.
2. Staging (`localhost:8010`) QA: free user sees paywall; simulated `active` webhook → tier flips to pro → gated features unlock; cancel → downgrade.
3. Flag `window.USE_PAYMENTS=false` until live; ship `dev→release→beta→main` with flag off (prod unchanged), then flip.
4. CI: add a "no secret keys in client" check (already have secret-scan) + entitlement-gating smoke test.

---

## 9. Effort & cost
- **Build:** ~1–2 focused weeks (3 edge functions + 2 client modules + paywall UI + funnel), reusing the existing patterns.
- **Fixed cost:** ~$0 (Supabase free tier covers edge functions; MoR takes a % only on sales).
- **Variable:** MoR ~5% + payment fees; that's the cost of zero tax/legal overhead.

---

## 10. Definition of done (P0)
- A real user can start a free trial, pay, and get `tier=pro` server-side; premium features unlock; cancel downgrades at period end; all verified in staging; live in production behind the flag, then enabled. **First dollar is collectable.**
