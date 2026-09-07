// ============================================================
// razorpay-create-order — India rail. Creates a Razorpay order for a tier and
// returns { order_id, amount, key_id } so the app can open Razorpay Checkout (UPI +
// cards + netbanking + wallets). The razorpay-webhook then grants the entitlement on
// payment.captured (uid + tier ride in the payment notes).
//
// Deploy: verify_jwt = false; the handler verifies the caller with Supabase Auth.
// Secrets: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET  (Settings → API Keys; test or live).
// ============================================================

const PRICE_PAISE: Record<string, number> = { pro: 100, elite: 100 };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return new Response("method", { status: 405, headers: cors });
  const json = (o: unknown, s = 200) =>
    new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

  const body = await req.json().catch(() => null);
  if (!body || !["pro", "elite"].includes(body.tier)) return json({ error: "bad_request" }, 400);
  const tier = body.tier;
  let amount = PRICE_PAISE[tier];
  let accessUntil: string | null = null;
  const authorization = req.headers.get("authorization") || "";
  if (!/^Bearer \S+$/i.test(authorization)) return json({ error: "authentication_required" }, 401);
  const SB = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const ANON = Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (!SB || !ANON) return json({ error: "not_configured" }, 503);
  let user;
  try {
    const identity = await fetch(SB + "/auth/v1/user", {
      headers: { apikey: ANON, Authorization: authorization }, signal: AbortSignal.timeout(10000),
    });
    if (!identity.ok) return json({ error: identity.status >= 500 ? "auth_unavailable" : "invalid_session" }, identity.status >= 500 ? 503 : 401);
    user = await identity.json();
  } catch (_) { return json({ error: "auth_unavailable" }, 503); }
  if (!user || typeof user.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(user.id)) return json({ error: "invalid_session" }, 401);
  const uid = user.id.toLowerCase();
  if (body.uid != null && (typeof body.uid !== "string" || body.uid.toLowerCase() !== uid)) return json({ error: "identity_mismatch" }, 403);
  const email = typeof user.email === "string" ? user.email : "";

  // Pro → Elite mid-cycle upgrade: charge ONLY the prorated difference for the days left in
  // member's current Pro period. The current tier + period end are read server-side from
  // the entitlements table. An unavailable quote must not silently raise the price.
  if (body.upgrade === true && tier === "elite") {
    const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!SR) return json({ error: "quote_unavailable" }, 503);
    {
      try {
        const er = await fetch(
          `${SB}/rest/v1/entitlements?select=tier,status,current_period_end&uid=eq.${encodeURIComponent(String(uid))}`,
          { headers: { apikey: SR, Authorization: "Bearer " + SR }, signal: AbortSignal.timeout(10000) },
        );
        if (!er.ok) return json({ error: "quote_unavailable" }, 503);
        const rows = await er.json();
        if (!Array.isArray(rows)) return json({ error: "quote_unavailable" }, 503);
        const row = rows[0];
        const periodEnd = row && row.current_period_end != null ? Date.parse(String(row.current_period_end)) : null;
        if (row && row.tier === "pro" && ["active", "trialing"].includes(row.status) && (periodEnd === null || (Number.isFinite(periodEnd) && periodEnd > Date.now()))) {
          const delta = (PRICE_PAISE.elite || 0) - (PRICE_PAISE.pro || 0);
          const daysLeft = periodEnd === null ? 30 : Math.max(0, Math.ceil((periodEnd - Date.now()) / 86400000));
          const frac = Math.min(1, daysLeft / 30);
          amount = Math.max(100, Math.round(delta * frac));
          accessUntil = periodEnd === null ? null : new Date(periodEnd).toISOString();
        }
      } catch (_) { return json({ error: "quote_unavailable" }, 503); }
    }
  }

  const KEY = Deno.env.get("RAZORPAY_KEY_ID") || "";
  const SEC = Deno.env.get("RAZORPAY_KEY_SECRET") || "";
  if (!KEY || !SEC) return json({ error: "not_configured" }, 503);

  try {
    const r = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(KEY + ":" + SEC), "Content-Type": "application/json" },
      body: JSON.stringify({ amount, currency: "INR", notes: { uid, tier, email, identity_source: "supabase_auth_v1", access_until: accessUntil || "" } }),
      signal: AbortSignal.timeout(10000),
    });
    const order = await r.json();
    if (!r.ok || !order.id || order.amount !== amount || order.currency !== "INR") return json({ error: "razorpay_error" }, 502);
    return json({ order_id: order.id, amount, currency: "INR", key_id: KEY });
  } catch (_) { return json({ error: "payment_provider_unavailable" }, 503); }
});
