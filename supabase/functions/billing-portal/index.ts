// ============================================================
// billing-portal — returns a Lemon Squeezy customer-portal URL so a member can
// manage or cancel their subscription. Looks up the subscription stored on the
// caller's entitlement and returns its signed customer_portal URL.
//
// Deploy:  supabase functions deploy billing-portal --no-verify-jwt
// Secrets: LEMONSQUEEZY_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
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
    const { uid } = await req.json();
    if (!uid) return json({ error: "uid required" }, 400);

    const SB = Deno.env.get("SUPABASE_URL");
    const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const er = await fetch(
      SB + "/rest/v1/entitlements?select=subscription_id&uid=eq." + encodeURIComponent(uid),
      { headers: { apikey: KEY!, Authorization: "Bearer " + KEY } }
    );
    const rows = await er.json();
    const subId = rows?.[0]?.subscription_id;
    if (!subId) return json({ error: "no active subscription" }, 404);

    const sr = await fetch("https://api.lemonsqueezy.com/v1/subscriptions/" + subId, {
      headers: {
        Authorization: "Bearer " + Deno.env.get("LEMONSQUEEZY_API_KEY"),
        Accept: "application/vnd.api+json",
      },
    });
    const sj = await sr.json();
    return json({ url: sj?.data?.attributes?.urls?.customer_portal || "" });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
