// Stage apply_billing_event (supabase/billing-events.sql) before this handler.
// Env: LS_WEBHOOK_SECRET, LS_STORE_ID, LS_VARIANT_PRO, LS_VARIANT_ELITE,
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. LS_TEST_MODE defaults to false;
// true is ONLY for a separate staging database, never the production ledger.
// REQUIRED webhooks: subscription_created and subscription_updated (all lifecycle
// changes, including renewals). Also accepts cancelled/expired/resumed/paused/unpaused.
// subscription_payment_* events are invoices: their data.id is NOT a subscription
// id. Ignore them, orders and refunds; never infer a tier or follow payload URLs.
// https://docs.lemonsqueezy.com/help/webhooks/event-types
// https://docs.lemonsqueezy.com/api/subscriptions/the-subscription-object
// Proofless legacy checkouts require manual ownership reconciliation (409), not
// entitlement deletion or automatic trust. Secret rotation/variant changes also
// require reconciliation of existing proofs; retain historical rows.
// Normalize at signed updated_at, never wall-clock time, so retries bind identical
// RPC inputs. Enforce supplied expiry dates without revoking legacy null-expiry access. Cancelled
// subscriptions remain entitlement-active through ends_at; the RPC revokes canceled.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isUuid = (value: unknown): value is string => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const providerId = (value: unknown): string => {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value);
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? text : "";
};
const supportedEvents = new Set([
  "subscription_created", "subscription_updated", "subscription_resumed", "subscription_cancelled",
  "subscription_expired", "subscription_paused", "subscription_unpaused",
]);

function timestamp(value: unknown): string | null {
  if (typeof value !== "string"
    || !/^[1-9]\d{3}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value)
    || !Number.isFinite(Date.parse(value))) return null;
  const day = value.slice(0, 10);
  const calendar = new Date(day + "T00:00:00Z");
  return Number.isFinite(calendar.getTime()) && calendar.toISOString().slice(0, 10) === day ? value : null;
}

async function verifyHmac(key: CryptoKey, signature: unknown, bytes: Uint8Array): Promise<boolean> {
  if (typeof signature !== "string" || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const decoded = Uint8Array.from(signature.match(/../g)!, pair => parseInt(pair, 16));
  return crypto.subtle.verify("HMAC", key, decoded, bytes);
}

async function readBody(req: Request): Promise<Uint8Array | null> {
  const limit = 262144;
  if (Number(req.headers.get("content-length")) > limit) return null;
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) { await reader.cancel(); return null; }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally { reader.releaseLock(); }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const secret = Deno.env.get("LS_WEBHOOK_SECRET") || "";
  if (!secret) return json({ error: "server_not_configured" }, 503);
  try {
    const bytes = await readBody(req);
    if (!bytes) return json({ error: "body_too_large" }, 413);
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    if (!await verifyHmac(key, req.headers.get("x-signature"), bytes)) return json({ error: "bad_signature" }, 401);

    let evt: unknown;
    try {
      evt = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    if (!isObject(evt) || !isObject(evt.meta) || typeof evt.meta.event_name !== "string"
      || !/^[a-z][a-z0-9_]{0,127}$/.test(evt.meta.event_name)) return json({ error: "invalid_event" }, 400);
    const name = evt.meta.event_name;
    if (!supportedEvents.has(name)) return json({ ignored: true, reason: "unsupported_event" });
    if (!isObject(evt.data) || evt.data.type !== "subscriptions" || !providerId(evt.data.id)
      || !isObject(evt.data.attributes)) return json({ error: "invalid_subscription" }, 400);
    const attributes = evt.data.attributes;
    const mode = Deno.env.get("LS_TEST_MODE") || "false";
    const store = providerId(Deno.env.get("LS_STORE_ID"));
    const proVariant = providerId(Deno.env.get("LS_VARIANT_PRO"));
    const eliteVariant = providerId(Deno.env.get("LS_VARIANT_ELITE"));
    if (!store || !proVariant || !eliteVariant || proVariant === eliteVariant || !["true", "false"].includes(mode)) {
      return json({ error: "server_not_configured" }, 503);
    }
    if (typeof attributes.test_mode !== "boolean"
      || (evt.meta.test_mode !== undefined && typeof evt.meta.test_mode !== "boolean")) {
      return json({ error: "invalid_event_mode" }, 400);
    }
    if (attributes.test_mode !== (mode === "true")
      || (evt.meta.test_mode !== undefined && evt.meta.test_mode !== attributes.test_mode)) {
      return json({ error: "event_mode_mismatch" }, 403);
    }
    if (providerId(attributes.store_id) !== store) return json({ error: "store_mismatch" }, 403);

    const custom = evt.meta.custom_data;
    if (!isObject(custom) || custom.identity_proof === undefined || custom.identity_proof === null || custom.identity_proof === "") {
      return json({ error: "legacy_checkout_reconciliation_required" }, 409);
    }
    const variant = providerId(attributes.variant_id);
    if (!variant || (variant !== proVariant && variant !== eliteVariant)) return json({ error: "unknown_variant" }, 400);
    if (!isUuid(custom.uid) || custom.variant !== variant) return json({ error: "identity_mismatch" }, 403);
    const uid = custom.uid.toLowerCase();
    const identity = JSON.stringify(["lemonsqueezy-checkout-v1", uid, variant]);
    if (!await verifyHmac(key, custom.identity_proof, encoder.encode(identity))) return json({ error: "invalid_identity_proof" }, 403);

    const occurredAt = timestamp(attributes.updated_at);
    const renewsAt = timestamp(attributes.renews_at);
    const endsAt = timestamp(attributes.ends_at);
    const trialEndsAt = timestamp(attributes.trial_ends_at);
    if (!occurredAt || Date.parse(occurredAt) > Date.now() + 300000 || (attributes.renews_at != null && !renewsAt)
      || (attributes.ends_at != null && !endsAt) || (attributes.trial_ends_at != null && !trialEndsAt)) {
      return json({ error: "invalid_subscription_timestamp" }, 400);
    }
    const providerStatus = attributes.status;
    if (typeof providerStatus !== "string" || !["active", "on_trial", "cancelled", "expired", "past_due", "unpaid", "paused"].includes(providerStatus)
      || (attributes.cancelled !== undefined && typeof attributes.cancelled !== "boolean")
      || (providerStatus === "cancelled" && attributes.cancelled === false)
      || (!["cancelled", "expired"].includes(providerStatus) && attributes.cancelled === true)) {
      return json({ error: "invalid_subscription_status" }, 400);
    }

    let periodEnd: string | null = endsAt || renewsAt || trialEndsAt;
    let status = "inactive";
    if (providerStatus === "active" || providerStatus === "on_trial") {
      periodEnd = providerStatus === "on_trial" ? trialEndsAt : renewsAt;
      if (!periodEnd) return json({ error: "subscription_expiry_required" }, 400);
      if (endsAt && Date.parse(endsAt) < Date.parse(periodEnd)) periodEnd = endsAt;
      if (Date.parse(periodEnd) > Date.parse(occurredAt)) status = providerStatus === "on_trial" ? "trialing" : "active";
    } else if (providerStatus === "cancelled" || providerStatus === "expired") {
      if (!endsAt) return json({ error: "subscription_expiry_required" }, 400);
      periodEnd = endsAt;
      if (providerStatus === "cancelled") status = Date.parse(endsAt) > Date.parse(occurredAt) ? "active" : "canceled";
    }
    const tier = status === "active" || status === "trialing" ? (variant === proVariant ? "pro" : "elite") : "free";

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    let supabase: URL;
    try {
      supabase = new URL(supabaseUrl);
    } catch {
      return json({ error: "server_not_configured" }, 503);
    }
    if (supabase.protocol !== "https:" || supabase.username || supabase.password || supabase.port
      || supabase.pathname !== "/" || supabase.search || supabase.hash || /[\s\\]/.test(supabaseUrl) || !serviceKey) {
      return json({ error: "server_not_configured" }, 503);
    }
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const eventId = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const response = await fetch(supabase.origin + "/rest/v1/rpc/apply_billing_event", {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        p_provider: "lemonsqueezy", p_event_id: eventId, p_uid: uid, p_event_type: name,
        p_occurred_at: occurredAt, p_reference: providerId(evt.data.id), p_tier: tier,
        p_status: status, p_period_end: periodEnd, p_raw: evt,
      }),
      signal: AbortSignal.timeout(8000), redirect: "error",
    });
    if (!response.ok) return json({ error: "billing_persistence_unavailable" }, 503);
    const result = await response.json();
    if (!isObject(result) || typeof result.applied !== "boolean" || typeof result.duplicate !== "boolean"
      || (result.applied && result.duplicate)) return json({ error: "invalid_billing_acknowledgement" }, 503);
    return json(result);
  } catch {
    return json({ error: "billing_service_unavailable" }, 503);
  }
});
