const posthogEndpoints = new Set([
  "https://us.i.posthog.com/capture/",
  "https://eu.i.posthog.com/capture/",
]);
const batchSize = 10;
const requestTimeout = 4000;
const runTimeout = 25000;
const responseLimit = 16384;
type FailureCode = "timeout" | "network" | "provider_http" | "provider_rejected" | "invalid_payload";

class DeliveryFailure extends Error {
  code: FailureCode;
  retryable: boolean;
  constructor(code: FailureCode, retryable = true) {
    super(code);
    this.code = code;
    this.retryable = retryable;
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isUuid = (value: unknown): value is string => typeof value === "string"
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const hasKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));

async function authentic(header: string, secret: string): Promise<boolean> {
  if (!header.startsWith("Bearer ") || header.length > 520) return false;
  const encoder = new TextEncoder();
  const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(secret)));
  const supplied = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(header.slice(7))));
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected[index] ^ supplied[index];
  return difference === 0;
}

async function fetchJson(url: string, options: RequestInit, deadline: number): Promise<{ status: number; data: unknown }> {
  const duration = Math.min(requestTimeout, deadline - Date.now());
  if (duration <= 0) throw new DeliveryFailure("timeout");
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DeliveryFailure("timeout"));
    }, duration);
  });
  const operation = async () => {
    const response = await fetch(url, { ...options, signal: controller.signal, redirect: "error" });
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => {});
      throw new DeliveryFailure("timeout");
    }
    if (response.redirected || !response.ok) {
      void response.body?.cancel().catch(() => {});
      return { status: response.redirected ? 302 : response.status, data: null };
    }
    if (Number(response.headers.get("content-length")) > responseLimit) {
      void response.body?.cancel().catch(() => {});
      throw new DeliveryFailure("provider_rejected");
    }
    reader = response.body?.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0;
    let text = "";
    while (reader) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > responseLimit) throw new DeliveryFailure("provider_rejected");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    try {
      return { status: response.status, data: JSON.parse(text) as unknown };
    } catch {
      throw new DeliveryFailure("provider_rejected");
    }
  };
  try {
    return await Promise.race([operation(), expired]);
  } catch (error) {
    if (error instanceof DeliveryFailure) throw error;
    throw new DeliveryFailure(controller.signal.aborted ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => {});
      try { reader.releaseLock(); } catch {}
    }
  }
}

type Lease = { event_id: string; lease_token: string };
function leasesFrom(value: unknown): Lease[] {
  if (!Array.isArray(value) || value.length > batchSize) throw new DeliveryFailure("invalid_payload", false);
  const seen = new Set<string>();
  for (const lease of value) {
    if (!isObject(lease) || !hasKeys(lease, ["event_id", "lease_token"])
      || !isUuid(lease.event_id) || !isUuid(lease.lease_token) || seen.has(lease.event_id)) {
      throw new DeliveryFailure("invalid_payload", false);
    }
    seen.add(lease.event_id);
  }
  return value as Lease[];
}

function captureBody(value: unknown, lease: Lease, apiKey: string) {
  if (!isObject(value) || !hasKeys(value, ["event_id", "event_name", "occurred_at", "properties"])
    || value.event_id !== lease.event_id || typeof value.event_name !== "string"
    || !["purchase_confirmed", "refund_confirmed"].includes(value.event_name)
    || typeof value.occurred_at !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.occurred_at)
    || !Number.isFinite(Date.parse(value.occurred_at)) || Date.parse(value.occurred_at) > Date.now() + 300000
    || !isObject(value.properties)) throw new DeliveryFailure("invalid_payload", false);
  const properties = value.properties;
  if (!hasKeys(properties, ["tier", "rail", "currency", "amount_minor", "price_class", "billing_mode", "charge_kind"])
    || typeof properties.tier !== "string" || !["pro", "elite"].includes(properties.tier)
    || typeof properties.rail !== "string" || !["upi", "card", "netbanking", "wallet", "unknown"].includes(properties.rail)
    || properties.currency !== "INR" || !Number.isSafeInteger(properties.amount_minor)
    || (properties.amount_minor as number) <= 0 || properties.price_class !== "other_or_unknown"
    || properties.billing_mode !== "live" || properties.charge_kind !== "unknown") {
    throw new DeliveryFailure("invalid_payload", false);
  }
  return {
    api_key: apiKey, uuid: lease.event_id, event: value.event_name,
    timestamp: new Date(value.occurred_at).toISOString(),
    properties: {
      tier: properties.tier, rail: properties.rail, currency: properties.currency,
      amount_minor: properties.amount_minor, price_class: properties.price_class,
      billing_mode: properties.billing_mode, charge_kind: properties.charge_kind,
      distinct_id: lease.event_id, $insert_id: lease.event_id,
      $process_person_profile: false, $geoip_disable: true, $ip: null,
    },
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const dispatchSecret = Deno.env.get("ANALYTICS_DISPATCH_SECRET") || "";
  if (dispatchSecret.length < 32 || dispatchSecret.length > 512 || /\s/.test(dispatchSecret)) {
    return json({ error: "server_not_configured" }, 503);
  }
  if (!await authentic(req.headers.get("authorization") || "", dispatchSecret)) return json({ error: "unauthorized" }, 401);
  if (Deno.env.get("ANALYTICS_DELIVERY_ENABLED") !== "true") return json({ enabled: false });
  const endpoint = Deno.env.get("ANALYTICS_POSTHOG_ENDPOINT") || "";
  const apiKey = Deno.env.get("ANALYTICS_POSTHOG_KEY") || "";
  const supabase = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!posthogEndpoints.has(endpoint) || !/^phc_[A-Za-z0-9]{20,128}$/.test(apiKey)
    || !/^https:\/\/[a-z0-9-]{6,64}\.supabase\.co$/.test(supabase)
    || serviceKey.length < 16 || serviceKey.length > 4096 || /\s/.test(serviceKey) || serviceKey === dispatchSecret) {
    return json({ error: "server_not_configured" }, 503);
  }
  const deadline = Date.now() + runTimeout;
  const totals = { claimed: 0, delivered: 0, retry: 0, dead: 0, skipped: 0, uncertain: 0 };
  const rpc = async (name: string, body: Record<string, unknown>) => {
    const response = await fetchJson(supabase + "/rest/v1/rpc/" + name, {
      method: "POST", headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey,
        "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, deadline);
    if (response.status < 200 || response.status >= 300) throw new DeliveryFailure("network");
    return response.data;
  };
  try {
    const leases = leasesFrom(await rpc("claim_analytics_events", { p_limit: batchSize }));
    totals.claimed = leases.length;
    for (const lease of leases) {
      if (Date.now() >= deadline) break;
      const parameters = { p_event_id: lease.event_id, p_lease_token: lease.lease_token };
      const authorized = await rpc("authorize_analytics_delivery", parameters);
      if (authorized === null) { totals.skipped++; continue; }
      let outcome = "delivered";
      let failure: FailureCode | null = null;
      try {
        const body = captureBody(authorized, lease, apiKey);
        const response = await fetchJson(endpoint, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        }, deadline);
        if (response.status < 200 || response.status >= 300) {
          throw new DeliveryFailure("provider_http", [408, 425, 429].includes(response.status) || response.status >= 500);
        }
        if (response.data !== 1 && !(isObject(response.data) && response.data.status === 1)) {
          throw new DeliveryFailure("provider_rejected");
        }
      } catch (error) {
        const problem = error instanceof DeliveryFailure ? error : new DeliveryFailure("network");
        outcome = problem.retryable ? "retry" : "dead";
        failure = problem.code;
      }
      const finished = await rpc("finish_analytics_delivery", { ...parameters, p_outcome: outcome, p_error: failure });
      if (!isObject(finished) || finished.accepted !== true) { totals.uncertain++; continue; }
      if (finished.state === "delivered") totals.delivered++;
      else if (finished.state === "retry") totals.retry++;
      else if (finished.state === "dead") totals.dead++;
      else totals.uncertain++;
    }
    const unfinished = totals.claimed - totals.delivered - totals.retry - totals.dead - totals.skipped - totals.uncertain;
    totals.uncertain += unfinished;
    return json(totals, totals.uncertain ? 503 : 200);
  } catch {
    totals.uncertain = Math.max(1, totals.claimed - totals.delivered - totals.retry - totals.dead - totals.skipped);
    return json({ error: "analytics_unavailable", ...totals }, 503);
  }
});