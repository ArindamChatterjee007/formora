// ============================================================
// razorpay-webhook — Razorpay (India rail) → writes the entitlement row (service role).
// Verifies the X-Razorpay-Signature HMAC, then upserts { uid, tier, status } from the
// payment/subscription notes so the app can trust it. Same entitlements table as the
// Lemon Squeezy rail — the app is provider-agnostic.
//
// Deploy:  verify_jwt = false (Razorpay calls it with no Supabase JWT).
// Secret:  RAZORPAY_WEBHOOK_SECRET  (the signing secret you set on the Razorpay webhook).
//          SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are auto-provided by Supabase.
// uid + tier ride along in the payment/subscription `notes` (set at checkout).
// ============================================================

// HMAC-SHA256 hex via Web Crypto — no imports, boots clean on Edge Runtime.
async function hmacHex(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const buf = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const raw = await req.text();
  const sig = req.headers.get("x-razorpay-signature") || "";
  const secret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET") || "";
  const digest = secret ? await hmacHex(secret, raw) : "";
  if (!secret || digest !== sig) return new Response("bad signature", { status: 401 });

  const evt = JSON.parse(raw);
  const event: string = evt?.event || "";
  const pay = evt?.payload?.payment?.entity || {};
  const sub = evt?.payload?.subscription?.entity || {};
  const notes = pay.notes || sub.notes || {};
  const uid: string = notes.uid || "";
  let tier: string = String(notes.tier || "pro").toLowerCase();
  if (!uid) return new Response("no uid", { status: 200 });

  let status = "inactive";
  if (["payment.captured", "order.paid", "subscription.charged", "subscription.activated", "subscription.authenticated", "subscription.resumed"].includes(event)) {
    status = "active";
  } else if (["subscription.cancelled", "subscription.completed", "subscription.halted", "subscription.paused", "refund.created"].includes(event)) {
    status = "canceled";
    tier = "free"; // drop entitlement on cancel / refund / expiry
  } else {
    return new Response("ignored", { status: 200 });
  }

  const SB = Deno.env.get("SUPABASE_URL");
  const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const hdr = { apikey: KEY!, Authorization: "Bearer " + KEY, "Content-Type": "application/json" };

  await fetch(SB + "/rest/v1/entitlements", {
    method: "POST",
    headers: { ...hdr, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      uid, tier, status, provider: "razorpay",
      subscription_id: String(sub.id || pay.order_id || pay.id || ""),
      current_period_end: sub.current_end ? new Date(sub.current_end * 1000).toISOString() : null,
      updated_at: new Date().toISOString(),
    }),
  });
  await fetch(SB + "/rest/v1/billing_events", {
    method: "POST",
    headers: { ...hdr, Prefer: "return=minimal" },
    body: JSON.stringify({ uid, type: event, raw: evt }),
  });

  return new Response("ok", { status: 200 });
});
