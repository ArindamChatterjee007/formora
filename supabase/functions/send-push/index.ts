// Service-authenticated Web Push sender for approved generic transactional notifications.
// Encryption and VAPID signing come from the proven web-push library; this function only
// claims leased work, revalidates consent/binding, and performs a bounded allowlisted POST.
const providerPaths = new Map<string, RegExp>([
  ["fcm.googleapis.com", /^\/(?:fcm\/send|wp)\/[A-Za-z0-9_:-]{16,1800}$/],
  ["updates.push.services.mozilla.com", /^\/wpush\/v2\/[A-Za-z0-9_-]{16,1800}$/],
  ["web.push.apple.com", /^\/[A-Za-z0-9_-]{16,1800}$/],
]);
const allowedRequestHeaders = new Set(["authorization", "crypto-key", "content-encoding",
  "content-type", "content-length", "ttl", "urgency", "topic"]);
const batchSize = 10;
const requestTimeout = 6000;
const runTimeout = 25000;
const maxBodyBytes = 4096;
const responseLimit = 65536;
const base64url = /^[A-Za-z0-9_-]+$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

type Outcome = "sent" | "retry" | "failed" | "gone";
type WebPushLibrary = {
  generateRequestDetails: (subscription: unknown, payload: string, options: unknown) => {
    method?: string; endpoint?: string; headers?: Record<string, unknown>; body?: unknown;
  };
};

class SendFailure extends Error {
  outcome: Outcome;
  reason: string;
  constructor(outcome: Outcome, reason: string) {
    super(reason);
    this.outcome = outcome;
    this.reason = reason;
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isKey = (value: unknown, length: number): value is string =>
  typeof value === "string" && value.length === length && base64url.test(value);

async function authentic(header: string, secret: string): Promise<boolean> {
  if (!header.startsWith("Bearer ") || header.length > 520) return false;
  const encoder = new TextEncoder();
  const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(secret)));
  const supplied = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(header.slice(7))));
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected[index] ^ supplied[index];
  return difference === 0;
}

function allowedEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new SendFailure("failed", "endpoint_rejected");
  let url: URL;
  try { url = new URL(value); } catch { throw new SendFailure("failed", "endpoint_rejected"); }
  const path = providerPaths.get(url.hostname);
  if (url.protocol !== "https:" || !path || url.host !== url.hostname || url.port
    || url.username || url.password || url.search || url.hash
    || !path.test(url.pathname) || url.href !== value) {
    throw new SendFailure("failed", "endpoint_rejected");
  }
  return value;
}

function providerRequest(library: WebPushLibrary, authorized: Record<string, unknown>,
  vapid: { subject: string; publicKey: string; privateKey: string }) {
  const endpoint = allowedEndpoint(authorized.endpoint);
  if (!uuid.test(String(authorized.binding_id)) || !isKey(authorized.p256dh, 87)
    || !isKey(authorized.auth, 22) || authorized.vapid_public_key !== vapid.publicKey
    || !Number.isInteger(authorized.ttl_seconds) || (authorized.ttl_seconds as number) < 0
    || (authorized.ttl_seconds as number) > 86400) {
    throw new SendFailure("failed", "authorization_rejected");
  }
  const payload = JSON.stringify({ v: 1, kind: "app_update", binding_id: authorized.binding_id });
  if (payload.length > 1024) throw new SendFailure("failed", "payload_rejected");
  const details = library.generateRequestDetails(
    { endpoint, keys: { p256dh: authorized.p256dh, auth: authorized.auth } }, payload,
    { TTL: authorized.ttl_seconds, contentEncoding: "aes128gcm", vapidDetails: vapid });
  const body = details.body;
  if (details.endpoint !== endpoint || (details.method && details.method !== "POST")
    || !isObject(details.headers) || !ArrayBuffer.isView(body) || body.byteLength > maxBodyBytes) {
    throw new SendFailure("failed", "library_rejected");
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(details.headers)) {
    if (!allowedRequestHeaders.has(name.toLowerCase()) || typeof value === "object") {
      throw new SendFailure("failed", "library_rejected");
    }
    headers.set(name, String(value));
  }
  const bytes = new Uint8Array(body.byteLength);
  bytes.set(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  return { endpoint, headers, body: bytes };
}

async function deliver(request: ReturnType<typeof providerRequest>, deadline: number) {
  const duration = Math.min(requestTimeout, deadline - Date.now());
  if (duration <= 0) throw new SendFailure("retry", "timeout");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), duration);
  let status = 0;
  try {
    const response = await fetch(request.endpoint, {
      method: "POST", headers: request.headers, body: request.body, signal: controller.signal,
      redirect: "error", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
    });
    status = response.redirected ? 0 : response.status;
    void response.body?.cancel().catch(() => {});
  } catch {
    throw new SendFailure("retry", controller.signal.aborted ? "timeout" : "network");
  } finally { clearTimeout(timer); }
  if (status >= 200 && status < 300) return;
  if (status === 404 || status === 410) throw new SendFailure("gone", "provider_gone");
  if (status === 408 || status === 429 || status >= 500) throw new SendFailure("retry", "provider_busy");
  throw new SendFailure("failed", "provider_rejected");
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const dispatchSecret = Deno.env.get("PUSH_DISPATCH_SECRET") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const supabase = Deno.env.get("SUPABASE_URL") || "";
  const publicKey = Deno.env.get("PUSH_VAPID_PUBLIC_KEY") || "";
  const privateKey = Deno.env.get("PUSH_VAPID_PRIVATE_KEY") || "";
  const subject = Deno.env.get("PUSH_VAPID_SUBJECT") || "";
  if (dispatchSecret.length < 24 || dispatchSecret.length > 512 || /\s/.test(dispatchSecret)
    || dispatchSecret === serviceKey) return json({ error: "server_not_configured" }, 503);
  if (!await authentic(request.headers.get("Authorization") || "", dispatchSecret)) {
    return json({ error: "unauthorized" }, 401);
  }
  if (Deno.env.get("ECE_KEYLOG") === "1") return json({ error: "unsafe_debug_configuration" }, 503);
  if (Deno.env.get("PUSH_DELIVERY_ENABLED") !== "true") return json({ error: "delivery_disabled" }, 503);
  if (!/^https:\/\/[a-z0-9-]{6,64}\.supabase\.co$/.test(supabase)
    || serviceKey.length < 16 || serviceKey.length > 4096 || /\s/.test(serviceKey)
    || !isKey(publicKey, 87) || !isKey(privateKey, 43)
    || !/^(?:mailto:[^\s@]{1,64}@[a-z0-9.-]{3,64}|https:\/\/[a-z0-9.-]{3,64})$/.test(subject)) {
    return json({ error: "server_not_configured" }, 503);
  }
  const vapid = { subject, publicKey, privateKey };
  const deadline = Date.now() + runTimeout;
  const totals = { claimed: 0, sent: 0, retry: 0, failed: 0, gone: 0, skipped: 0, uncertain: 0 };
  const rpc = async (name: string, body: Record<string, unknown>): Promise<unknown> => {
    const duration = Math.min(requestTimeout, deadline - Date.now());
    if (duration <= 0) throw new SendFailure("retry", "timeout");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), duration);
    try {
      const response = await fetch(supabase + "/rest/v1/rpc/" + name, {
        method: "POST", signal: controller.signal, redirect: "error", cache: "no-store",
        headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok || response.redirected
        || Number(response.headers.get("content-length")) > responseLimit) {
        void response.body?.cancel().catch(() => {});
        throw new SendFailure("retry", "control_plane");
      }
      return await response.json() as unknown;
    } finally { clearTimeout(timer); }
  };
  try {
    const claimed = await rpc("claim_push_dispatches", { p_limit: batchSize });
    if (!Array.isArray(claimed)) throw new SendFailure("retry", "control_plane");
    const leases = claimed.filter(lease => isObject(lease)
      && uuid.test(String(lease.dispatch_id)) && uuid.test(String(lease.lease_token)));
    totals.claimed = leases.length;
    if (leases.length !== claimed.length) throw new SendFailure("retry", "control_plane");
    const library = await import("npm:web-push@3.6.7") as { default?: WebPushLibrary } & WebPushLibrary;
    const webPush = typeof library.generateRequestDetails === "function" ? library : library.default;
    if (!webPush || typeof webPush.generateRequestDetails !== "function") throw new SendFailure("retry", "library_unavailable");
    for (const lease of leases as { dispatch_id: string; lease_token: string }[]) {
      if (Date.now() >= deadline) break;
      const parameters = { p_dispatch_id: lease.dispatch_id, p_lease_token: lease.lease_token };
      const authorized = await rpc("authorize_push_dispatch", parameters);
      if (authorized === null) { totals.skipped++; continue; }
      if (!isObject(authorized) || authorized.dispatch_id !== lease.dispatch_id) throw new SendFailure("retry", "control_plane");
      let outcome: Outcome = "sent";
      let reason: string | null = null;
      try {
        await deliver(providerRequest(webPush, authorized, vapid), deadline);
      } catch (error) {
        const failure = error instanceof SendFailure ? error : new SendFailure("retry", "network");
        outcome = failure.outcome;
        reason = failure.reason;
      }
      const finished = await rpc("finish_push_dispatch", { ...parameters, p_outcome: outcome, p_error: reason });
      if (!isObject(finished) || finished.accepted !== true) { totals.uncertain++; continue; }
      if (outcome === "sent" && finished.state === "sent") totals.sent++;
      else if (outcome === "gone") totals.gone++;
      else if (finished.state === "pending") totals.retry++;
      else if (finished.state === "failed") totals.failed++;
      else totals.uncertain++;
    }
    const unfinished = totals.claimed - totals.sent - totals.retry - totals.failed - totals.gone
      - totals.skipped - totals.uncertain;
    totals.uncertain += Math.max(0, unfinished);
    return json(totals, totals.uncertain ? 503 : 200);
  } catch {
    totals.uncertain = Math.max(1, totals.claimed - totals.sent - totals.retry - totals.failed
      - totals.gone - totals.skipped);
    return json({ error: "push_dispatch_unavailable", ...totals }, 503);
  }
});
