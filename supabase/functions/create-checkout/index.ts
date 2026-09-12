// POST {tier: "pro" | "elite"} with a Supabase access-token bearer and anon apikey.
// Optional legacy uid must match the authenticated UUID; body email is ignored.
// Server env: SUPABASE_URL, SUPABASE_ANON_KEY, LEMONSQUEEZY_API_KEY,
// LS_STORE_ID, LS_VARIANT_PRO, LS_VARIANT_ELITE, LS_WEBHOOK_SECRET, LS_RETURN_URL.
// LS_TEST_MODE=true is ONLY for an isolated staging database; default is live.
// Identity proof: HMAC-SHA256(secret, JSON.stringify(["lemonsqueezy-checkout-v1",
// lower-case UUID, decimal variant string])). Keep in sync with billing-webhook.
// https://docs.lemonsqueezy.com/api/checkouts/create-checkout documents
// product_options.enabled_variants; an empty array would enable ALL variants.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isUuid = (value: unknown): value is string => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const providerId = (value: unknown): string => {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value);
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? text : "";
};

function httpsUrl(value: unknown): URL | null {
  if (typeof value !== "string" || !value || /[\s\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port ? url : null;
  } catch {
    return null;
  }
}

async function identityProof(secret: string, uid: string, variant: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const message = JSON.stringify(["lemonsqueezy-checkout-v1", uid, variant]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const authorization = req.headers.get("authorization") || "";
  if (!/^Bearer [^\s]+$/i.test(authorization)) return json({ error: "authentication_required" }, 401);

  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > 4096) return json({ error: "body_too_large" }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!isObject(body) || (body.tier !== "pro" && body.tier !== "elite")
    || Object.keys(body).some(key => !["tier", "uid", "email"].includes(key))) {
    return json({ error: "invalid_checkout_request" }, 400);
  }

  const supabase = httpsUrl(Deno.env.get("SUPABASE_URL"));
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const apiKey = Deno.env.get("LEMONSQUEEZY_API_KEY");
  const secret = Deno.env.get("LS_WEBHOOK_SECRET");
  const store = providerId(Deno.env.get("LS_STORE_ID"));
  const proVariant = providerId(Deno.env.get("LS_VARIANT_PRO"));
  const eliteVariant = providerId(Deno.env.get("LS_VARIANT_ELITE"));
  const returnUrl = httpsUrl(Deno.env.get("LS_RETURN_URL"));
  const mode = Deno.env.get("LS_TEST_MODE") || "false";
  if (!supabase || supabase.pathname !== "/" || supabase.search || supabase.hash
    || !anonKey || !apiKey || !secret || !store || !proVariant || !eliteVariant
    || proVariant === eliteVariant || !returnUrl || !["true", "false"].includes(mode)) {
    return json({ error: "server_not_configured" }, 503);
  }

  try {
    const authResponse = await fetch(supabase.origin + "/auth/v1/user", {
      headers: { apikey: anonKey, Authorization: authorization },
      signal: AbortSignal.timeout(8000), redirect: "error", cache: "no-store",
    });
    if (authResponse.status === 401 || authResponse.status === 403) return json({ error: "invalid_session" }, 401);
    if (!authResponse.ok) return json({ error: "authentication_unavailable" }, 503);
    const user = await authResponse.json();
    if (!isObject(user) || !isUuid(user.id) || typeof user.email !== "string"
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) {
      return json({ error: "invalid_session" }, 401);
    }
    const uid = user.id.toLowerCase();
    if (body.uid !== undefined && (!isUuid(body.uid) || body.uid.toLowerCase() !== uid)) {
      return json({ error: "uid_mismatch" }, 403);
    }
    const variant = body.tier === "elite" ? eliteVariant : proVariant;
    const proof = await identityProof(secret, uid, variant);
    const payload = {
      data: {
        type: "checkouts",
        attributes: {
          checkout_data: { email: user.email, custom: { uid, variant, identity_proof: proof } },
          product_options: { redirect_url: returnUrl.href, enabled_variants: [Number(variant)] },
          test_mode: mode === "true",
        },
        relationships: {
          store: { data: { type: "stores", id: store } },
          variant: { data: { type: "variants", id: variant } },
        },
      },
    };

    const response = await fetch("https://api.lemonsqueezy.com/v1/checkouts", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/vnd.api+json",
        Accept: "application/vnd.api+json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000), redirect: "error",
    });
    if (!response.ok) return json({ error: "checkout_unavailable" }, 503);
    const checkout = await response.json();
    const data = checkout?.data;
    const attributes = data?.attributes;
    const url = httpsUrl(attributes?.url);
    if (data?.type !== "checkouts" || !isUuid(data?.id) || !url
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.lemonsqueezy\.com$/.test(url.hostname)
      || url.pathname !== "/checkout/custom/" + data.id || url.hash
      || providerId(attributes?.store_id) !== store || providerId(attributes?.variant_id) !== variant
      || attributes?.test_mode !== (mode === "true")) {
      return json({ error: "invalid_checkout_response" }, 503);
    }
    return json({ url: url.href });
  } catch {
    return json({ error: "checkout_service_unavailable" }, 503);
  }
});
