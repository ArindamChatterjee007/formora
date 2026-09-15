// POST {} with a Supabase access-token bearer and anon apikey; optional legacy
// uid must match the authenticated UUID. Never accept a body subscription id.
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
// LEMONSQUEEZY_API_KEY, LS_STORE_ID, LS_TEST_MODE (default false).
// Portal links are customer-wide: billing email must still match the verified
// account email. Legacy mappings/email changes need ownership reconciliation.
// https://docs.lemonsqueezy.com/api/subscriptions/the-subscription-object

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
  if (!isObject(body) || Object.keys(body).some(key => key !== "uid")) return json({ error: "invalid_portal_request" }, 400);

  const supabase = httpsUrl(Deno.env.get("SUPABASE_URL"));
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const apiKey = Deno.env.get("LEMONSQUEEZY_API_KEY");
  const store = providerId(Deno.env.get("LS_STORE_ID"));
  const mode = Deno.env.get("LS_TEST_MODE") || "false";
  if (!supabase || supabase.pathname !== "/" || supabase.search || supabase.hash
    || !anonKey || !serviceKey || !apiKey || !store || !["true", "false"].includes(mode)) {
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
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) return json({ error: "invalid_session" }, 401);
    const uid = user.id.toLowerCase();
    if (body.uid !== undefined && (!isUuid(body.uid) || body.uid.toLowerCase() !== uid)) {
      return json({ error: "uid_mismatch" }, 403);
    }
    const query = new URLSearchParams({ select: "uid,provider,subscription_id", uid: "eq." + uid, provider: "eq.lemonsqueezy", limit: "2" });
    const entitlementResponse = await fetch(supabase.origin + "/rest/v1/entitlements?" + query, {
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey },
      signal: AbortSignal.timeout(8000), redirect: "error", cache: "no-store",
    });
    if (!entitlementResponse.ok) return json({ error: "entitlement_service_unavailable" }, 503);
    const rows = await entitlementResponse.json();
    if (!Array.isArray(rows)) return json({ error: "invalid_entitlement_response" }, 503);
    if (!rows.length) return json({ error: "no_subscription" }, 404);
    if (rows.length !== 1 || !isObject(rows[0])) return json({ error: "invalid_entitlement_response" }, 503);
    const entitlement = rows[0];
    if (entitlement.uid !== uid || entitlement.provider !== "lemonsqueezy") return json({ error: "subscription_ownership_mismatch" }, 403);
    const subscriptionId = providerId(entitlement.subscription_id);
    if (!subscriptionId) return json({ error: "subscription_reconciliation_required" }, 409);

    const subscriptionResponse = await fetch("https://api.lemonsqueezy.com/v1/subscriptions/" + subscriptionId, {
      headers: {
        Authorization: "Bearer " + apiKey,
        Accept: "application/vnd.api+json",
      },
      signal: AbortSignal.timeout(8000), redirect: "error", cache: "no-store",
    });
    if (subscriptionResponse.status === 404) return json({ error: "subscription_reconciliation_required" }, 409);
    if (!subscriptionResponse.ok) return json({ error: "portal_service_unavailable" }, 503);
    const subscription = await subscriptionResponse.json();
    if (!isObject(subscription?.data) || subscription.data.type !== "subscriptions"
      || !isObject(subscription.data.attributes)) return json({ error: "invalid_subscription_response" }, 503);
    const attributes = subscription.data.attributes;
    if (providerId(subscription.data.id) !== subscriptionId || providerId(attributes.store_id) !== store
      || attributes.test_mode !== (mode === "true") || typeof attributes.user_email !== "string"
      || attributes.user_email.toLowerCase() !== user.email.toLowerCase()) {
      return json({ error: "subscription_ownership_mismatch" }, 403);
    }
    const url = httpsUrl(isObject(attributes.urls) ? attributes.urls.customer_portal : null);
    if (!url || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.lemonsqueezy\.com$/.test(url.hostname)
      || !/^\/billing\/?$/.test(url.pathname) || url.hash) return json({ error: "invalid_portal_url" }, 503);
    return json({ url: url.href });
  } catch {
    return json({ error: "portal_service_unavailable" }, 503);
  }
});
