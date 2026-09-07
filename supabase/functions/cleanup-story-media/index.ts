import { timingSafeEqual } from "node:crypto";

export const cleanupLimits = Object.freeze({ objects: 2, requestBytes: 512, jsonBytes: 8192, ackBytes: 4096,
  stepMs: 5000, aggregateMs: 20000, requests: 10 });
export type CleanupConfig = { enabled: boolean; origin: string; serviceKey: string };
type Json = Record<string, unknown>;
type Intent = { intent_id: string; object_id: string; bucket: string; object_key: string; object_version: string;
  state: "claimed" | "object_delete_requested" | "completed" | "unknown";
  outcome: "pending" | "storage_api_deleted" | "storage_api_absent_backend_unknown" | "unknown";
  metadata_deleted: boolean; delete_requested: boolean; delete_attempts: number };
type Claim = { schema_version: number; operation_id: string; claim_id: string; reservation_id: string; owner: string;
  request_id: string; reservation_epoch: number; cleanup_epoch: number; retention_policy_ref: string; storage_policy_ref: string;
  approval_ref: string; snapshot_sha256: string; lease_token: string | null; lease_until: string | null; content_type: string;
  public_key_id: string; sha256: string | null; objects: Intent[]; physical_delete_confirmed: false; account_deleted: false };
type Options = { fetch?: typeof fetch; stepMs?: number; aggregateMs?: number };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const extensions: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm" };
const encoder = new TextEncoder();
class CleanupFailure extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
function fail(code = "invalid_upstream", status = 502): never { throw new CleanupFailure(code, status); }
const record = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const isUuid = (value: unknown): value is string => typeof value === "string" && uuid.test(value);
const boundedInteger = (value: unknown, minimum: number, maximum: number): value is number =>
  Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
const cancelBody = (source: Request | Response) => { void source.body?.cancel().catch(() => {}); };

export function cleanupConfiguration(read = (name: string) => Deno.env.get(name)): CleanupConfig {
  return { enabled: read("STORY_MEDIA_CLEANUP_ENABLED") === "true", origin: read("SUPABASE_URL") || "",
    serviceKey: read("SUPABASE_SERVICE_ROLE_KEY") || "" };
}

function parseClaim(value: unknown, operation: string, expectedId?: string, previous?: Claim): Claim {
  if (!record(value) || value.schema_version !== 1 || value.operation_id !== operation || !isUuid(value.claim_id)
    || (expectedId !== undefined && value.claim_id !== expectedId) || value.physical_delete_confirmed !== false || value.account_deleted !== false
    || !boundedInteger(value.reservation_epoch, 1, 2147483647) || !boundedInteger(value.cleanup_epoch, 1, 2147483647)
    || typeof value.snapshot_sha256 !== "string" || !digest.test(value.snapshot_sha256)
    || typeof value.content_type !== "string" || !Object.hasOwn(extensions, value.content_type)
    || (value.sha256 !== null && (typeof value.sha256 !== "string" || !digest.test(value.sha256)))) fail();
  for (const field of ["reservation_id", "owner", "request_id", "retention_policy_ref", "storage_policy_ref", "approval_ref", "public_key_id"]) {
    if (!isUuid(value[field])) fail();
  }
  if (!Array.isArray(value.objects) || value.objects.length < 1 || value.objects.length > cleanupLimits.objects) fail();
  const objects = value.objects;
  for (const object of objects) {
    if (!record(object) || !isUuid(object.intent_id) || !isUuid(object.object_id)
      || typeof object.object_version !== "string" || !/^[\x21-\x7e]{1,128}$/.test(object.object_version)
      || !["claimed", "object_delete_requested", "completed", "unknown"].includes(String(object.state))
      || !["pending", "storage_api_deleted", "storage_api_absent_backend_unknown", "unknown"].includes(String(object.outcome))
      || typeof object.metadata_deleted !== "boolean" || typeof object.delete_requested !== "boolean"
      || (object.metadata_deleted && !object.delete_requested) || !boundedInteger(object.delete_attempts, 0, 3)
      || ((object.state === "completed") !== (object.outcome === "storage_api_deleted"))
      || ((object.state === "completed" || object.outcome === "storage_api_absent_backend_unknown") && !object.metadata_deleted)) fail();
    const suffix = extensions[String(value.content_type)];
    const key = object.bucket === "story-media-quarantine-v3" ? `stories/${value.owner}/${value.reservation_id}.${suffix}`
      : object.bucket === "story-media-public-v3" && value.sha256 !== null
      ? `stories/${value.owner}/${value.public_key_id}_${value.sha256}.${suffix}` : null;
    if (!key || object.object_key !== key) fail();
  }
  for (const field of ["intent_id", "object_id", "bucket"]) if (new Set(objects.map(object => object[field])).size !== objects.length) fail();
  if (objects.some(object => object.state !== "completed")) {
    const until = typeof value.lease_until === "string" ? Date.parse(value.lease_until) : NaN;
    if (!isUuid(value.lease_token) || !Number.isFinite(until) || until <= Date.now() || until > Date.now() + 31000) fail("cleanup_lease_unavailable", 409);
  }
  if (previous) {
    for (const field of ["claim_id", "reservation_id", "owner", "request_id", "reservation_epoch", "cleanup_epoch", "retention_policy_ref",
      "storage_policy_ref", "approval_ref", "snapshot_sha256", "lease_token", "lease_until", "content_type", "public_key_id", "sha256"] as const) {
      if (value[field] !== previous[field]) fail();
    }
    if (objects.length !== previous.objects.length || objects.some(object => {
      const prior = previous.objects.find(candidate => candidate.intent_id === object.intent_id);
      return !prior || ["object_id", "bucket", "object_key", "object_version"].some(field => object[field] !== prior[field as keyof Intent]);
    })) fail();
  }
  return value as unknown as Claim;
}

function safeReceipt(claim: Claim) {
  const completed = claim.objects.filter(object => object.state === "completed").length;
  return { operation_id: claim.operation_id, claim_id: claim.claim_id, completed, pending: claim.objects.length - completed,
    result: completed === claim.objects.length ? "storage_api_deleted"
      : claim.objects.some(object => object.outcome === "storage_api_absent_backend_unknown") ? "storage_api_absent_backend_unknown" : "unknown",
    evidence_scope: "storage_api_visibility_only", physical_delete_confirmed: false, account_deleted: false };
}

function reply(body: unknown, status: number) {
  return Response.json(body, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

export function createStoryMediaCleanupHandler(input: CleanupConfig, options: Options = {}) {
  const config = Object.freeze({ ...input }), fetcher = options.fetch || globalThis.fetch;
  const stepMs = Math.min(cleanupLimits.stepMs, Math.max(1, options.stepMs || cleanupLimits.stepMs));
  const aggregateMs = Math.min(cleanupLimits.aggregateMs, Math.max(1, options.aggregateMs || cleanupLimits.aggregateMs));
  let active = false;
  return async (request: Request): Promise<Response> => {
    if (config.enabled !== true || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(config.origin)
      || !/^[A-Za-z0-9._-]{32,4096}$/.test(config.serviceKey)) return reply({ error: "cleanup_disabled" }, 503);
    if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
    const provided = request.headers.get("x-story-media-cleanup-key") || "";
    if (provided.length > 4096) return reply({ error: "service_auth_required" }, 401);
    const candidate = encoder.encode(provided), expected = encoder.encode(config.serviceKey);
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) return reply({ error: "service_auth_required" }, 401);
    const incoming = new URL(request.url);
    if (request.headers.has("origin") || incoming.search || incoming.hash || incoming.username || incoming.password
      || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
      || ![null, "identity"].includes(request.headers.get("content-encoding"))) return reply({ error: "invalid_request" }, 400);
    if (active) return reply({ error: "cleanup_busy" }, 429);
    active = true;
    const controller = new AbortController();
    const abort = () => controller.abort(new CleanupFailure("cleanup_deadline", 504));
    const aggregateTimer = setTimeout(abort, aggregateMs);
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const interrupted = new Promise<never>((_resolve, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason);
      else controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    void interrupted.catch(() => {});
    let calls = 0;
    const current = () => { if (controller.signal.aborted) throw controller.signal.reason; };
    async function step<T>(work: () => Promise<T>): Promise<T> {
      current();
      const timer = setTimeout(abort, stepMs);
      try { const result = await Promise.race([work(), interrupted]); current(); return result; }
      finally { clearTimeout(timer); }
    }
    async function json(source: Request | Response, maximum: number, status = 502): Promise<unknown> {
      const length = source.headers.get("content-length");
      if ((length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) || !source.body) {
        cancelBody(source); fail(status === 400 ? "invalid_request" : "invalid_upstream", status);
      }
      const reader = source.body.getReader(), bytes = new Uint8Array(maximum);
      let used = 0, reads = 0;
      const cancel = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        while (true) {
          current(); const chunk = await reader.read(); current();
          if (chunk.done) break;
          if (++reads > 128 || used + chunk.value.byteLength > maximum) fail(status === 400 ? "invalid_request" : "invalid_upstream", status);
          bytes.set(chunk.value, used); used += chunk.value.byteLength;
        }
        if (length !== null && Number(length) !== used) fail(status === 400 ? "invalid_request" : "invalid_upstream", status);
        try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used))); }
        catch { fail(status === 400 ? "invalid_request" : "invalid_upstream", status); }
      } finally {
        controller.signal.removeEventListener("abort", cancel); cancel();
        try { reader.releaseLock(); } catch {}
      }
    }
    async function network(route: string, method: string, body: unknown, maximum: number, absence = false) {
      current(); if (++calls > cleanupLimits.requests) fail("cleanup_budget", 429);
      const url = config.origin + route;
      return step(async () => {
        const response = await fetcher(url, { method, redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal,
          headers: { apikey: config.serviceKey, authorization: "Bearer " + config.serviceKey,
            ...(absence ? { range: "bytes=0-0", "cache-control": "no-cache" } : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (controller.signal.aborted) { cancelBody(response); current(); }
        if (response.redirected || (response.url && response.url !== url) || (response.status >= 300 && response.status < 400)) {
          cancelBody(response); fail();
        }
        if (absence || response.status !== 200) { cancelBody(response); return { status: response.status, body: null }; }
        if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") { cancelBody(response); fail(); }
        return { status: response.status, body: await json(response, maximum) };
      });
    }
    async function rpc(name: "claim_story_media_cleanup" | "request_story_media_cleanup_object" | "finish_story_media_cleanup_object", parameters: Json) {
      const result = await network("/rest/v1/rpc/" + name, "POST", parameters, cleanupLimits.jsonBytes);
      if (result.status !== 200) fail(result.status === 409 ? "cleanup_conflict" : result.status === 429 ? "cleanup_budget" : "cleanup_unavailable",
        [401, 403, 409, 429, 503].includes(result.status) ? result.status : 502);
      return result.body;
    }
    try {
      const body = await step(() => json(request, cleanupLimits.requestBytes, 400));
      if (!record(body) || !isUuid(body.operation_id) || (Object.hasOwn(body, "claim_id") && !isUuid(body.claim_id))
        || Object.keys(body).some(field => !["operation_id", "claim_id"].includes(field))) fail("invalid_request", 400);
      const operation = body.operation_id, requestedId = body.claim_id as string | undefined;
      let claim = parseClaim(await rpc("claim_story_media_cleanup", { p_operation_id: operation, p_claim_id: requestedId || null }), operation, requestedId);
      for (const original of claim.objects) {
        if (original.state === "completed") continue;
        const args = { p_operation_id: operation, p_claim_id: claim.claim_id, p_intent_id: original.intent_id, p_lease_token: claim.lease_token };
        const authorized = await rpc("request_story_media_cleanup_object", args);
        if (!record(authorized) || authorized.intent_id !== original.intent_id || typeof authorized.delete_allowed !== "boolean") fail();
        claim = parseClaim(authorized, operation, claim.claim_id, claim);
        const object = claim.objects.find(candidate => candidate.intent_id === original.intent_id)!;
        if (authorized.delete_allowed ? object.metadata_deleted || !object.delete_requested || object.state !== "object_delete_requested"
          || object.delete_attempts !== original.delete_attempts + 1 : !object.metadata_deleted || !object.delete_requested) fail();
        let deleteStatus = 0, getStatus = 0;
        try {
          let ack: Json | null = null;
          if (authorized.delete_allowed) {
            const removed = await network("/storage/v1/object/" + object.bucket, "DELETE", { prefixes: [object.object_key] }, cleanupLimits.ackBytes);
            deleteStatus = removed.status;
            if (removed.status !== 200 || !Array.isArray(removed.body) || removed.body.length > 1) fail("storage_delete_unknown", 502);
            if (removed.body.length === 1) {
              const matched: unknown = removed.body[0];
              if (!record(matched) || matched.name !== object.object_key || (Object.hasOwn(matched, "id") && matched.id !== object.object_id)
                || (Object.hasOwn(matched, "bucket_id") && matched.bucket_id !== object.bucket)) fail("storage_ack_mismatch", 502);
              ack = { name: matched.name, ...(Object.hasOwn(matched, "id") ? { id: matched.id } : {}),
                ...(Object.hasOwn(matched, "bucket_id") ? { bucket_id: matched.bucket_id } : {}) };
            }
          }
          getStatus = (await network("/storage/v1/object/authenticated/" + object.bucket + "/" + object.object_key, "GET", undefined, 0, true)).status;
          if (getStatus !== 404) fail("storage_absence_unknown", 502);
          const result = ack ? "storage_api_deleted" : "storage_api_absent_backend_unknown";
          claim = parseClaim(await rpc("finish_story_media_cleanup_object", { ...args, p_result: result, p_delete_status: deleteStatus,
            p_ack: ack, p_get_status: getStatus }), operation, claim.claim_id, claim);
          if (claim.objects.find(candidate => candidate.intent_id === object.intent_id)?.outcome !== result) fail();
        } catch (error) {
          if (!controller.signal.aborted) {
            try { await rpc("finish_story_media_cleanup_object", { ...args, p_result: "unknown", p_delete_status: deleteStatus, p_ack: null, p_get_status: getStatus }); }
            catch {}
          }
          throw error;
        }
      }
      const receipt = safeReceipt(claim);
      return reply(receipt, receipt.pending ? 202 : 200);
    } catch (error) {
      const failure = error instanceof CleanupFailure ? error : new CleanupFailure("cleanup_unavailable", 503);
      return reply({ error: failure.code, physical_delete_confirmed: false, account_deleted: false }, failure.status);
    } finally {
      clearTimeout(aggregateTimer); request.signal.removeEventListener("abort", abort); active = false;
    }
  };
}

if (import.meta.main) Deno.serve(createStoryMediaCleanupHandler(cleanupConfiguration()));