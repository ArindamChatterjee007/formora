// ============================================================
// razorpay-create-order — India rail. Creates a Razorpay order for a tier and
// returns { order_id, amount, key_id } so the app can open Razorpay Checkout (UPI +
// cards + netbanking + wallets). The razorpay-webhook then grants the entitlement on
// payment.captured (uid + tier ride in the payment notes).
//
// Deploy:  verify_jwt = false (called from the browser with the anon apikey).
// Secrets: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET  (Settings → API Keys; test or live).
// ============================================================

const PRICE_PAISE: Record<string, number> = { pro: 100, elite: 100 }; // TEST: ₹1 each (real-payment test). Restore { pro: 69900, elite: 169900 } (₹699/₹1699) after the test.

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

  const { tier, uid, email, upgrade } = await req.json().catch(() => ({}));
  let amount = PRICE_PAISE[String(tier)] || 0;
  if (!amount || !uid) return json({ error: "bad_request" }, 400);

  // Pro → Elite mid-cycle upgrade: charge ONLY the prorated difference for the days left in
  // the member's current Pro period. The current tier + period end are read server-side from
  // the entitlements table (service role) so the price can't be forged by the client. If it
  // can't be verified, we safely fall back to the full Elite price (never undercharge).
  if (upgrade && String(tier) === "elite") {
    const SB = Deno.env.get("SUPABASE_URL") || "";
    const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (SB && SR) {
      try {
        const er = await fetch(
          `${SB}/rest/v1/entitlements?select=tier,status,current_period_end&uid=eq.${encodeURIComponent(String(uid))}`,
          { headers: { apikey: SR, Authorization: "Bearer " + SR } },
        );
        const rows = await er.json().catch(() => []);
        const row = Array.isArray(rows) ? (rows.find((x: Record<string, unknown>) => x.status === "active") || rows[0]) : null;
        if (row && row.tier === "pro") {
          const delta = (PRICE_PAISE.elite || 0) - (PRICE_PAISE.pro || 0);
          const periodEnd = row.current_period_end ? Date.parse(String(row.current_period_end)) : 0;
          const daysLeft = periodEnd ? Math.max(0, Math.ceil((periodEnd - Date.now()) / 86400000)) : 30;
          const frac = Math.min(1, daysLeft / 30);
          amount = Math.max(100, Math.round(delta * frac)); // min ₹1 so Razorpay always accepts the order
        }
      } catch (_e) { /* fall back to full Elite price */ }
    }
  }

  const KEY = Deno.env.get("RAZORPAY_KEY_ID") || "";
  const SEC = Deno.env.get("RAZORPAY_KEY_SECRET") || "";
  if (!KEY || !SEC) return json({ error: "not_configured" }, 503);

  const r = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(KEY + ":" + SEC), "Content-Type": "application/json" },
    body: JSON.stringify({ amount, currency: "INR", notes: { uid, tier, email: email || "" } }),
  });
  const order = await r.json();
  if (!r.ok || !order.id) return json({ error: "razorpay_error", detail: order }, 502);

  return json({ order_id: order.id, amount, currency: "INR", key_id: KEY });
});
