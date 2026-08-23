// ============================================================
// billing-webhook — Lemon Squeezy → writes the entitlement row (service role).
// This is the ONLY writer of public.entitlements. Verifies the LS HMAC
// signature, then upserts { uid, tier, status } so the app can trust it.
//
// Deploy:  supabase functions deploy billing-webhook --no-verify-jwt
// Secrets: supabase secrets set LS_WEBHOOK_SECRET=... LS_VARIANT_ELITE=... \
//            SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...
// Point the Lemon Squeezy webhook at this function's URL.
// ============================================================
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createHmac } from "node:crypto";

serve(async (req) => {
  const raw = await req.text();
  const sig = req.headers.get("x-signature") || "";
  const secret = Deno.env.get("LS_WEBHOOK_SECRET") || "";
  const digest = createHmac("sha256", secret).update(raw).digest("hex");
  if (!secret || digest !== sig) return new Response("bad signature", { status: 401 });

  const evt = JSON.parse(raw);
  const name: string = evt?.meta?.event_name || "";
  const uid: string = evt?.meta?.custom_data?.uid || "";
  const attr = evt?.data?.attributes || {};
  if (!uid) return new Response("no uid", { status: 200 });

  const isElite = String(attr.variant_id || "") === Deno.env.get("LS_VARIANT_ELITE");
  let tier = isElite ? "elite" : "pro";
  let status = "inactive";
  if (["subscription_created", "subscription_updated", "subscription_resumed", "subscription_payment_success"].includes(name)) {
    status = attr.status === "on_trial" ? "trialing" : "active";
  } else if (["subscription_cancelled", "subscription_expired", "subscription_paused"].includes(name)) {
    status = "canceled";
    tier = "free"; // drop entitlement on cancel/expiry
  }

  const SB = Deno.env.get("SUPABASE_URL");
  const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const hdr = { apikey: KEY!, Authorization: "Bearer " + KEY, "Content-Type": "application/json" };

  await fetch(SB + "/rest/v1/entitlements", {
    method: "POST",
    headers: { ...hdr, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      uid, tier, status, provider: "lemonsqueezy",
      subscription_id: String(evt?.data?.id || ""),
      current_period_end: attr.renews_at || attr.ends_at || null,
      updated_at: new Date().toISOString(),
    }),
  });
  await fetch(SB + "/rest/v1/billing_events", {
    method: "POST",
    headers: { ...hdr, Prefer: "return=minimal" },
    body: JSON.stringify({ uid, type: name, raw: evt }),
  });

  return new Response("ok", { status: 200 });
});
