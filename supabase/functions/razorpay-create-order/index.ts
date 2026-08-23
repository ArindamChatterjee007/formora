// ============================================================
// razorpay-create-order — India rail. Creates a Razorpay order for a tier and
// returns { order_id, amount, key_id } so the app can open Razorpay Checkout (UPI +
// cards + netbanking + wallets). The razorpay-webhook then grants the entitlement on
// payment.captured (uid + tier ride in the payment notes).
//
// Deploy:  verify_jwt = false (called from the browser with the anon apikey).
// Secrets: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET  (Settings → API Keys; test or live).
// ============================================================

const PRICE_PAISE: Record<string, number> = { pro: 69900, elite: 169900 }; // ₹699 / ₹1699

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

  const { tier, uid, email } = await req.json().catch(() => ({}));
  const amount = PRICE_PAISE[String(tier)] || 0;
  if (!amount || !uid) return json({ error: "bad_request" }, 400);

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
