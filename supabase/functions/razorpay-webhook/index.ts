// ============================================================
// razorpay-webhook — Razorpay (India rail) → writes the entitlement row (service role).
// Verifies the signature and server-created provider order, then applies an atomic
// billing event. Apply supabase/billing-events.sql before deploying this handler.
//
// Deploy:  verify_jwt = false (Razorpay calls it with no Supabase JWT).
// Secret:  RAZORPAY_WEBHOOK_SECRET  (the signing secret you set on the Razorpay webhook).
//          SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are auto-provided by Supabase.
// Legacy orders without verified identity metadata require manual reconciliation.
// ============================================================

// HMAC-SHA256 hex via Web Crypto — no imports, boots clean on Edge Runtime.
async function hmacHex(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const buf = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readBody(req: Request): Promise<string | null> {
  const limit = 262144;
  if (Number(req.headers.get("content-length")) > limit) return null;
  const reader = req.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0, text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return null; }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  const sig = req.headers.get("x-razorpay-signature") || "";
  const secret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET") || "";
  if (!secret || !/^[a-f0-9]{64}$/i.test(sig)) return new Response("bad signature", { status: 401 });
  let raw;
  try { raw = await readBody(req); } catch (_) { return new Response("bad body", { status: 400 }); }
  if (raw === null) return new Response("body too large", { status: 413 });
  const digest = await hmacHex(secret, raw);
  let difference = 0;
  for (let index = 0; index < digest.length; index++) difference |= digest.charCodeAt(index) ^ sig.toLowerCase().charCodeAt(index);
  if (difference !== 0) return new Response("bad signature", { status: 401 });

  let evt;
  try { evt = JSON.parse(raw); } catch (_) { return new Response("bad request", { status: 400 }); }
  if (!evt || typeof evt !== "object" || Array.isArray(evt)) return new Response("bad request", { status: 400 });
  const event: string = evt?.event || "";
  const activation = ["payment.captured", "order.paid", "subscription.charged", "subscription.activated", "subscription.resumed"].includes(event);
  const cancellation = ["subscription.cancelled", "subscription.completed", "subscription.halted", "subscription.paused"].includes(event);
  const refundEvent = ["refund.created", "refund.processed"].includes(event);
  if (!activation && !cancellation && !refundEvent) return new Response("ignored", { status: 200 });
  if (!Number.isFinite(evt.created_at) || evt.created_at <= 0 || evt.created_at > Date.now() / 1000 + 300) return new Response("bad event timestamp", { status: 400 });
  const occurred = new Date(evt.created_at * 1000);
  if (!Number.isFinite(occurred.getTime())) return new Response("bad event timestamp", { status: 400 });
  const eventPayment = evt?.payload?.payment?.entity || {};
  const sub = evt?.payload?.subscription?.entity || {};
  const SB = Deno.env.get("SUPABASE_URL");
  const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const providerKey = Deno.env.get("RAZORPAY_KEY_ID");
  const providerSecret = Deno.env.get("RAZORPAY_KEY_SECRET");
  if (!SB || !KEY || !providerKey || !providerSecret) return new Response("not configured", { status: 503 });
  const providerGet = async (resource: string, id: unknown) => {
    if (typeof id !== "string" || !/^(pay|order|sub|rfnd)_[a-zA-Z0-9]+$/.test(id)) throw new Error("bad reference");
    const result = await fetch(`https://api.razorpay.com/v1/${resource}/${encodeURIComponent(id)}`, {
      headers: { Authorization: "Basic " + btoa(providerKey + ":" + providerSecret) }, signal: AbortSignal.timeout(10000),
    });
    if (!result.ok) throw new Error("provider unavailable");
    const entity = await result.json();
    if (entity?.id !== id) throw new Error("reference mismatch");
    return entity;
  };

  try {
    let notes, reference, periodEnd: string | null = null;
    const status = cancellation || refundEvent ? "canceled" : "active";
    if (event.startsWith("subscription.")) {
      const verified = await providerGet("subscriptions", sub.id);
      notes = verified.notes || {};
      reference = verified.id;
      if (activation && (sub.status !== "active" || verified.status !== "active")) return new Response("not active", { status: 200 });
      if (sub.current_end != null) {
        if (typeof sub.current_end !== "number" || sub.current_end <= 0) return new Response("bad period", { status: 400 });
        const end = new Date(Number(sub.current_end) * 1000);
        if (!Number.isFinite(end.getTime())) return new Response("bad period", { status: 400 });
        if (activation && verified.current_end !== sub.current_end) return new Response("subscription period requires reconciliation", { status: 409 });
        periodEnd = end.toISOString();
      } else if (activation) return new Response("missing subscription period", { status: 400 });
    } else {
      let paymentId = eventPayment.id;
      if (refundEvent) {
        const refund = await providerGet("refunds", evt?.payload?.refund?.entity?.id);
        if (refund.status !== "processed") return new Response("refund not processed", { status: 200 });
        paymentId = refund.payment_id;
      }
      const pay = await providerGet("payments", paymentId);
      const order = await providerGet("orders", pay.order_id);
      if (!Number.isSafeInteger(pay.amount) || pay.amount < 100 || pay.amount !== order.amount || pay.currency !== "INR" || order.currency !== "INR") return new Response("payment mismatch", { status: 400 });
      if (refundEvent && !(pay.amount_refunded >= pay.amount)) return new Response("partial refund; access unchanged", { status: 200 });
      if (activation && (pay.status !== "captured" || pay.amount_refunded >= pay.amount || order.status !== "paid")) return new Response("not captured", { status: 200 });
      if (!refundEvent && (eventPayment.order_id !== order.id || eventPayment.amount !== pay.amount || eventPayment.currency !== pay.currency)) return new Response("payment mismatch", { status: 400 });
      notes = order.notes || {};
      reference = order.id;
      if (notes.access_until != null && notes.access_until !== "") {
        const end = typeof notes.access_until === "string" ? Date.parse(notes.access_until) : NaN;
        if (!Number.isFinite(end)) return new Response("invalid order access period", { status: 409 });
        periodEnd = new Date(end).toISOString();
      }
    }
    if (notes.identity_source !== "supabase_auth_v1" || typeof notes.uid !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(notes.uid) || !["pro", "elite"].includes(notes.tier)) {
      return new Response("order identity requires reconciliation", { status: 409 });
    }
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    const eventId = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const persisted = await fetch(SB + "/rest/v1/rpc/apply_billing_event", {
      method: "POST",
      headers: { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        p_provider: "razorpay", p_event_id: eventId, p_uid: notes.uid.toLowerCase(), p_event_type: event,
        p_occurred_at: occurred.toISOString(), p_reference: reference,
        p_tier: status === "active" ? notes.tier : "free", p_status: status, p_period_end: periodEnd, p_raw: evt,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!persisted.ok) return new Response("billing persistence failed", { status: 503 });
    const result = await persisted.json();
    if (typeof result?.applied !== "boolean" || typeof result?.duplicate !== "boolean") return new Response("billing acknowledgement invalid", { status: 503 });
    return new Response("ok", { status: 200 });
  } catch (_) { return new Response("billing verification unavailable", { status: 503 }); }
});
