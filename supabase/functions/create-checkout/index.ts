// ============================================================
// create-checkout — returns a Lemon Squeezy hosted-checkout URL for the caller.
// The user's Formora uid is stashed in checkout custom data so the webhook can
// tie the payment back to the right account.
//
// Deploy:  supabase functions deploy create-checkout --no-verify-jwt
// Secrets: supabase secrets set LEMONSQUEEZY_API_KEY=... LS_STORE_ID=... \
//                               LS_VARIANT_PRO=... LS_VARIANT_ELITE=...
// ============================================================
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { uid, tier, email, return_url } = await req.json();
    if (!uid || !tier) return json({ error: "uid and tier are required" }, 400);

    const variant = tier === "elite" ? Deno.env.get("LS_VARIANT_ELITE") : Deno.env.get("LS_VARIANT_PRO");
    const store = Deno.env.get("LS_STORE_ID");
    if (!variant || !store) return json({ error: "server not configured (LS_STORE_ID / LS_VARIANT_*)" }, 500);

    const payload = {
      data: {
        type: "checkouts",
        attributes: {
          checkout_data: { email: email || "", custom: { uid } },
          product_options: { redirect_url: return_url || "" },
        },
        relationships: {
          store: { data: { type: "stores", id: String(store) } },
          variant: { data: { type: "variants", id: String(variant) } },
        },
      },
    };

    const r = await fetch("https://api.lemonsqueezy.com/v1/checkouts", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + Deno.env.get("LEMONSQUEEZY_API_KEY"),
        "Content-Type": "application/vnd.api+json",
        Accept: "application/vnd.api+json",
      },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok) return json({ error: j }, 400);
    return json({ url: j?.data?.attributes?.url });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
