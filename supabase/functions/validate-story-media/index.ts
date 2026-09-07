import { fileTypeFromBuffer } from "file-type";
import mediaInfoFactory from "mediainfo.js";

export type MediaLimits = { photo_bytes: number; video_bytes: number; video_ms: number; max_pixels: number };
export const technicalLimits: Readonly<MediaLimits> = Object.freeze({ photo_bytes: 8388608, video_bytes: 26214400, video_ms: 30000, max_pixels: 16777216 });
export type Declaration = { kind: string; content_type: string; declared_bytes: number };
type Fields = Record<string, unknown>;
const formats: Record<string, { kind: string; extension: string; container: string }> = {
  "image/jpeg": { kind: "photo", extension: "jpg", container: "JPEG" },
  "image/png": { kind: "photo", extension: "png", container: "PNG" },
  "image/webp": { kind: "photo", extension: "webp", container: "WebP" },
  "video/mp4": { kind: "video", extension: "mp4", container: "MPEG-4" },
  "video/webm": { kind: "video", extension: "webm", container: "WebM" },
};
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const integer = (value: unknown, maximum: number): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum;
export class MediaFailure extends Error {
  constructor(public code: string, public status = 422) { super(code); }
}
function fail(code = "invalid_media", status = 422): never { throw new MediaFailure(code, status); }
function checkedLimits(value: Fields = technicalLimits): MediaLimits {
  for (const key of Object.keys(technicalLimits) as (keyof MediaLimits)[]) {
    if (!integer(value[key], technicalLimits[key])) fail("invalid_configuration", 503);
  }
  return value as MediaLimits;
}
function checkDeclaration(value: Declaration, limits: MediaLimits) {
  const format = formats[value.content_type];
  if (!format || format.kind !== value.kind || !integer(value.declared_bytes, value.kind === "photo" ? limits.photo_bytes : limits.video_bytes)) fail();
  return format;
}
export async function parseStoryBytes(bytes: Uint8Array) {
  if (!integer(bytes.byteLength, technicalLimits.video_bytes)) fail("size_mismatch");
  const detected = await fileTypeFromBuffer(bytes);
  if (!detected || !formats[detected.mime]) fail();
  const parser = await mediaInfoFactory({ format: "object", chunkSize: 65536 });
  let readBytes = 0, reads = 0;
  try {
    const metadata = await parser.analyzeData(bytes.byteLength, (size, offset) => {
      if (!integer(size, 1048576) || !Number.isSafeInteger(offset) || offset < 0 || offset > bytes.byteLength || ++reads > 2048) fail();
      const chunk = bytes.subarray(offset, offset + size);
      readBytes += chunk.byteLength;
      if (readBytes > bytes.byteLength * 3 + 1048576) fail();
      return chunk;
    });
    return { detected, metadata };
  } finally {
    parser.close();
  }
}

async function inspectStoryBytes(bytes: Uint8Array, declaration: Declaration, limits = technicalLimits) {
  const format = checkDeclaration(declaration, checkedLimits(limits));
  if (bytes.byteLength !== declaration.declared_bytes) fail("size_mismatch");
  const { detected, metadata } = await parseStoryBytes(bytes);
  if (detected.mime !== declaration.content_type || detected.ext !== format.extension) fail();
  const tracks = (metadata.media?.track || []) as unknown as Fields[];
  const general = tracks.filter(track => track["@type"] === "General");
  const visual = tracks.filter(track => track["@type"] === (declaration.kind === "photo" ? "Image" : "Video"));
  const audio = tracks.filter(track => track["@type"] === "Audio");
  const diagnostics = JSON.stringify(tracks);
  if (general.length !== 1 || visual.length !== 1 || general[0].Format !== format.container
    || Number(general[0].FileSize) !== bytes.byteLength || /"(?:IsTruncated|ConformanceErrors|Error|Errors)"\s*:/.test(diagnostics)
    || tracks.some(track => !["General", declaration.kind === "photo" ? "Image" : "Video", ...(declaration.kind === "video" ? ["Audio"] : [])].includes(String(track["@type"])))
    || audio.length > 1 || diagnostics.length > 131072) fail();
  const width = Number(visual[0].Width), height = Number(visual[0].Height);
  if (!integer(width, 8192) || !integer(height, 8192) || width * height > limits.max_pixels) fail();
  let duration: number | null = null;
  if (declaration.kind === "photo") {
    if (Number(general[0].ImageCount) !== 1 || !visual[0].Format) fail();
    if (detected.mime === "image/jpeg" && (bytes.at(-2) !== 255 || bytes.at(-1) !== 217)) fail();
    if (detected.mime === "image/png" && ![0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130].every((value, index) => bytes[bytes.length - 12 + index] === value)) fail();
  } else {
    const seconds = Number(visual[0].Duration), containerSeconds = Number(general[0].Duration);
    const frameCount = Number(visual[0].FrameCount), frameRate = Number(visual[0].FrameRate);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > limits.video_ms
      || !Number.isFinite(containerSeconds) || containerSeconds <= 0 || containerSeconds * 1000 > limits.video_ms
      || Math.abs(containerSeconds - seconds) > 0.25 || !integer(frameCount, 3600)
      || !Number.isFinite(frameRate) || frameRate <= 0 || frameRate > 120
      || Math.abs(frameCount / frameRate - seconds) > 0.25
      || !["AVC", "HEVC", "VP8", "VP9", "AV1"].includes(String(visual[0].Format))) fail();
    for (const track of audio) {
      const audioSeconds = Number(track.Duration);
      if (!Number.isFinite(audioSeconds) || audioSeconds <= 0 || audioSeconds * 1000 > limits.video_ms
        || !["AAC", "Opus", "Vorbis", "MPEG Audio"].includes(String(track.Format))) fail();
    }
    duration = Math.ceil(Math.max(seconds, containerSeconds, ...audio.map(track => Number(track.Duration))) * 1000);
  }
  return { actual_bytes: bytes.byteLength, content_type: detected.mime, width, height, duration_ms: duration,
    duration_verified: declaration.kind === "video", parser: "file-type@22.0.2+mediainfo.js@0.3.7", library: metadata.creatingLibrary?.version };
}

async function sha256Bytes(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}
export async function validateStoryBytes(bytes: Uint8Array<ArrayBuffer>, declaration: Declaration, limits = technicalLimits) {
  const [result, sha256] = await Promise.all([inspectStoryBytes(bytes, declaration, limits), sha256Bytes(bytes)]);
  return { ...result, sha256 };
}

export async function parseInWorker(bytes: Uint8Array<ArrayBuffer>, declaration: Declaration, limits = technicalLimits, signal?: AbortSignal, timeoutMs = 10000) {
  if (signal?.aborted) fail("validation_timeout", 504);
  if (bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength) fail("storage_unavailable", 503);
  let worker: Worker;
  try { worker = new Worker(new URL(import.meta.url + "?parser-worker=1").href, { type: "module", name: "story-media-binary-parser" }); }
  catch { fail("storage_unavailable", 503); }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    const byteLength = bytes.byteLength, digest = sha256Bytes(bytes);
    const parsed = new Promise<{ result: Awaited<ReturnType<typeof inspectStoryBytes>>; bytes: Uint8Array<ArrayBuffer> }>((resolve, reject) => {
      abort = () => reject(new MediaFailure("validation_timeout", 504));
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(abort, Math.min(10000, Math.max(1, timeoutMs)));
      worker.onmessage = event => event.data?.result && event.data.bytes instanceof Uint8Array && event.data.bytes.byteLength === byteLength
        ? resolve(event.data)
        : reject(["invalid_media", "size_mismatch"].includes(event.data?.error)
          ? new MediaFailure(event.data.error) : new MediaFailure("storage_unavailable", 503));
      worker.onerror = event => { event.preventDefault(); reject(new MediaFailure("storage_unavailable", 503)); };
      worker.postMessage({ bytes, declaration, limits }, [bytes.buffer]);
    });
    const [inspection, sha256] = await Promise.all([parsed, digest]);
    return { ...inspection.result, sha256, bytes: inspection.bytes };
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", abort); worker.terminate();
  }
}

async function bounded<Result>(work: (signal: AbortSignal) => Promise<Result>, milliseconds: number, parent?: AbortSignal): Promise<Result> {
  if (parent?.aborted) fail("validation_timeout", 504);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    return await Promise.race([new Promise<never>((_, reject) => {
      abort = () => { controller.abort(); reject(new MediaFailure("validation_timeout", 504)); };
      parent?.addEventListener("abort", abort, { once: true }); timer = setTimeout(abort, milliseconds);
    }), work(controller.signal)]);
  } finally { clearTimeout(timer); parent?.removeEventListener("abort", abort); }
}
async function readBounded(response: Response | Request, maximum: number, signal: AbortSignal, exact?: number) {
  const header = response.headers.get("content-length");
  if (header !== null && (!/^\d+$/.test(header) || Number(header) > maximum || (exact !== undefined && Number(header) !== exact))) {
    response.body?.cancel().catch(() => {}); fail("size_mismatch");
  }
  if (exact !== undefined && header === null) { response.body?.cancel().catch(() => {}); fail("storage_unavailable", 503); }
  if (!response.body) fail(exact === undefined ? "invalid_response" : "storage_unavailable", exact === undefined ? 502 : 503);
  const reader = response.body.getReader(), bytes = new Uint8Array(exact ?? maximum);
  const abort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) fail("validation_timeout", 504);
      const { done, value } = await reader.read();
      if (signal.aborted) fail("validation_timeout", 504);
      if (done) break;
      if (total + value.byteLength > bytes.byteLength) fail("size_mismatch");
      bytes.set(value, total); total += value.byteLength;
    }
  } finally { signal.removeEventListener("abort", abort); reader.cancel().catch(() => {}); }
  if (exact !== undefined && total !== exact) fail("size_mismatch");
  return total === bytes.byteLength ? bytes : bytes.subarray(0, total);
}

type HandlerConfiguration = { enabled: boolean; origin: string; anonKey: string; serviceKey: string; clientOrigin?: string };
type HandlerOptions = { fetch?: typeof fetch; stepMs?: number; aggregateMs?: number };
export function createStoryMediaHandler(config: HandlerConfiguration, options: HandlerOptions = {}) {
  let active = false;
  const network = options.fetch || fetch;
  const stepMs = Math.min(10000, Math.max(1, options.stepMs || 10000));
  const aggregateMs = Math.min(30000, Math.max(1, options.aggregateMs || 30000));
  return async function handle(request: Request): Promise<Response> {
    const cors: Record<string, string> = { "Content-Type": "application/json", "Cache-Control": "no-store", "Vary": "Origin" };
    const response = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: cors });
    if (!config.enabled) return response(503, { error: "story_media_disabled" });
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(config.origin) || !config.anonKey || !config.serviceKey
      || config.anonKey === config.serviceKey || /\s/.test(config.anonKey + config.serviceKey)
      || config.anonKey.length > 8192 || config.serviceKey.length > 16384) return response(503, { error: "invalid_configuration" });
    const callerOrigin = request.headers.get("origin");
    if (callerOrigin) {
      if (!config.clientOrigin || callerOrigin !== config.clientOrigin) return response(403, { error: "origin_not_allowed" });
      cors["Access-Control-Allow-Origin"] = callerOrigin;
    }
    if (request.method === "OPTIONS") {
      cors["Access-Control-Allow-Methods"] = "POST"; cors["Access-Control-Allow-Headers"] = "authorization,apikey,content-type";
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "POST" || request.headers.get("content-type")?.split(";")[0] !== "application/json") return response(400, { error: "invalid_request" });
    const authorization = request.headers.get("authorization") || "";
    if (!/^Bearer [^\s]{1,16384}$/.test(authorization)) return response(401, { error: "sign_in_required" });
    if (active) return response(429, { error: "validator_busy" });
    active = true;
    try {
      return await bounded(async signal => {
        const check = () => { if (signal.aborted) fail("validation_timeout", 504); };
        const json = async (url: string, init: RequestInit, maximum = 65536) => {
          check();
          const result = await bounded(async stepSignal => {
            const remote = await network(url, { ...init, signal: stepSignal, redirect: "error", credentials: "omit", cache: "no-store" });
            if (stepSignal.aborted) fail("validation_timeout", 504);
            const bytes = await readBounded(remote, maximum, stepSignal);
            let body: Fields;
            try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail("invalid_response", 502); }
            if (!remote.ok) fail("upstream_rejected", [401, 403, 404, 409, 429].includes(remote.status) ? remote.status : 503);
            return body;
          }, stepMs, signal);
          check(); return result;
        };
        let body: Fields;
        try { body = JSON.parse(new TextDecoder().decode(await bounded(stepSignal => readBounded(request, 512, stepSignal), stepMs, signal))); }
        catch (error) { if (error instanceof MediaFailure) throw error; fail("invalid_request", 400); }
        if (!body || Array.isArray(body) || Object.keys(body).join() !== "request_id" || !uuid(body.request_id)) fail("invalid_request", 400);
        const user = await json(config.origin + "/auth/v1/user", { headers: { apikey: config.anonKey, Authorization: authorization } });
        if (!uuid(user.id) || user.is_anonymous === true || user.deleted_at || (user.banned_until && Date.parse(String(user.banned_until)) > Date.now())) fail("sign_in_required", 401);
        const serviceHeaders = { apikey: config.serviceKey, Authorization: "Bearer " + config.serviceKey, "Content-Type": "application/json" };
        const rpc = (name: string, payload: Fields) => json(config.origin + "/rest/v1/rpc/" + name,
          { method: "POST", headers: serviceHeaders, body: JSON.stringify(payload) });
        const reservation = await rpc("claim_story_media_validation", { p_owner: user.id, p_request_id: body.request_id });
        const declaration = reservation as unknown as Declaration;
        const format = checkDeclaration(declaration, technicalLimits);
        const objectKey = "stories/" + user.id + "/" + reservation.reservation_id + "." + format.extension;
        if (reservation.schema_version !== 2 || reservation.owner !== user.id || reservation.request_id !== body.request_id
          || !uuid(reservation.reservation_id) || reservation.bucket !== "story-media-quarantine-v3" || reservation.object_key !== objectKey
          || reservation.public_bucket !== "story-media-public-v3" || !uuid(reservation.public_key_id) || reservation.public_key_id === reservation.reservation_id
          || !integer(reservation.policy_epoch, 2147483647) || typeof reservation.expires_at !== "string"
          || !Number.isFinite(Date.parse(reservation.expires_at)) || typeof reservation.uploaded !== "boolean"
          || (reservation.status === "validating" && ["media_url", "public_key", "public_object_id", "public_object_version"].some(key => reservation[key] !== null))) fail("invalid_response", 502);
        const same = ["schema_version", "owner", "request_id", "reservation_id", "bucket", "object_key", "public_bucket", "public_key_id", "kind",
          "content_type", "declared_bytes", "policy_epoch", "expires_at"];
        const evidenceFields = ["sha256", "actual_bytes", "width", "height", "duration_ms", "duration_verified", "public_key", "media_url"];
        const checkedEvidence = (value: Fields, statuses: string[], stored: boolean) => {
          const publicKey = "stories/" + user.id + "/" + reservation.public_key_id + "_" + value.sha256 + "." + format.extension;
          if (same.some(key => value[key] !== reservation[key]) || !statuses.includes(String(value.status))
            || value.uploaded !== true || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)
            || value.actual_bytes !== reservation.declared_bytes || !integer(value.width, 8192) || !integer(value.height, 8192)
            || value.width * value.height > technicalLimits.max_pixels
            || value.public_key !== publicKey || value.media_url !== config.origin + "/storage/v1/object/public/story-media-public-v3/" + publicKey
            || (stored && (!uuid(value.public_object_id) || typeof value.public_object_version !== "string" || value.public_object_version.length < 1 || value.public_object_version.length > 128))
            || (value.status !== "published" && Date.parse(String(value.expires_at)) <= Date.now())
            || (value.kind === "video" ? value.duration_verified !== true || !integer(value.duration_ms, technicalLimits.video_ms)
              : value.duration_verified !== false || value.duration_ms !== null)) fail("invalid_response", 502);
          return value;
        };
        const publicReceipt = (value: Fields) => {
          checkedEvidence(value, ["approved", "published"], true);
          return Object.fromEntries([...same, ...evidenceFields, "public_object_id", "public_object_version", "status", "uploaded"]
            .map(key => [key, value[key]]));
        };
        if (["approved", "published"].includes(String(reservation.status))) {
          return response(200, publicReceipt(reservation));
        }
        if (!["validating", "attested", "promoting"].includes(String(reservation.status)) || !uuid(reservation.lease_token) || !uuid(reservation.object_id)
          || !integer(reservation.epoch, 2147483647) || Date.parse(String(reservation.expires_at)) <= Date.now()) fail("invalid_response", 502);
        const limits = checkedLimits(reservation.limits as Fields);
        const lease = { p_owner: user.id, p_request_id: body.request_id, p_epoch: reservation.epoch, p_lease_token: reservation.lease_token };
        const readMedia = (bucket: string, key: string) => bounded(async stepSignal => {
            const remote = await network(config.origin + "/storage/v1/object/authenticated/" + bucket + "/" + key,
              { headers: { apikey: config.serviceKey, Authorization: "Bearer " + config.serviceKey }, signal: stepSignal,
                redirect: "error", credentials: "omit", cache: "no-store" });
            if (!remote.ok || remote.status !== 200 || remote.headers.get("content-encoding") && remote.headers.get("content-encoding") !== "identity") fail("storage_unavailable", 503);
            if (remote.headers.get("content-type")?.split(";")[0] !== declaration.content_type) fail("storage_unavailable", 503);
            return readBounded(remote, declaration.kind === "photo" ? limits.photo_bytes : limits.video_bytes, stepSignal, declaration.declared_bytes);
          }, stepMs, signal);
        let attested = reservation, validatedBytes: Uint8Array<ArrayBuffer> | undefined;
        if (reservation.status !== "promoting") {
          try {
            const result = await parseInWorker(await readMedia(String(reservation.bucket), objectKey), declaration, limits, signal, stepMs);
            check();
            validatedBytes = result.bytes;
            if (reservation.status === "validating") attested = await rpc("attest_story_media", { ...lease, p_sha256: result.sha256,
              p_actual_bytes: result.actual_bytes, p_content_type: result.content_type, p_width: result.width,
              p_height: result.height, p_duration_ms: result.duration_ms, p_failure_code: null });
            checkedEvidence(attested, ["attested"], false);
            if (["sha256", "actual_bytes", "content_type", "width", "height", "duration_ms", "duration_verified"].some(key => attested[key] !== result[key as keyof typeof result])) fail("invalid_response", 502);
          } catch (error) {
            const failure = error instanceof MediaFailure ? error : new MediaFailure("storage_unavailable", 503);
            if (reservation.status === "validating" && ["invalid_media", "size_mismatch", "storage_unavailable", "validation_timeout"].includes(failure.code)) {
              check();
              await rpc("attest_story_media", { ...lease, p_sha256: null, p_actual_bytes: null, p_content_type: null,
                p_width: null, p_height: null, p_duration_ms: null, p_failure_code: failure.code });
            }
            throw failure;
          }
        } else checkedEvidence(attested, ["promoting"], false);
        let promotion = await rpc("claim_story_media_promotion", lease);
        checkedEvidence(promotion, ["promoting"], false);
        if (evidenceFields.some(key => promotion[key] !== attested[key]) || promotion.epoch !== reservation.epoch
          || promotion.lease_token !== reservation.lease_token || !uuid(promotion.promotion_token) || typeof promotion.write_allowed !== "boolean") fail("invalid_response", 502);
        if (promotion.write_allowed) {
          if (!validatedBytes || reservation.status === "promoting" || promotion.public_object_id !== null) fail("invalid_response", 502);
          const metadata = { reservation_id: reservation.reservation_id, owner: user.id, sha256: attested.sha256,
            epoch: reservation.epoch, lease_token: reservation.lease_token, promotion_token: promotion.promotion_token };
          const acknowledgement = await json(config.origin + "/storage/v1/object/story-media-public-v3/" + promotion.public_key,
            { method: "POST", headers: { ...serviceHeaders, "Content-Type": declaration.content_type, "x-upsert": "false",
              "x-metadata": btoa(JSON.stringify(metadata)) }, body: validatedBytes });
          if (!uuid(acknowledgement.Id) || acknowledgement.Key !== promotion.public_bucket + "/" + promotion.public_key) fail("storage_unavailable", 503);
          promotion = await rpc("claim_story_media_promotion", lease);
          if (promotion.write_allowed !== false || promotion.public_object_id !== acknowledgement.Id) fail("storage_unavailable", 503);
        } else {
          if (!uuid(promotion.public_object_id) || typeof promotion.public_object_version !== "string") fail("storage_unavailable", 503);
          const storedHash = await sha256Bytes(await readMedia(String(promotion.public_bucket), String(promotion.public_key)));
          check();
          if (storedHash !== attested.sha256) fail("storage_unavailable", 503);
        }
        checkedEvidence(promotion, ["promoting"], true);
        if (evidenceFields.some(key => promotion[key] !== attested[key])) fail("invalid_response", 502);
        const receipt = await rpc("finalize_story_media", { ...lease, p_sha256: attested.sha256,
          p_public_object_id: promotion.public_object_id, p_public_object_version: promotion.public_object_version });
        if ([...evidenceFields, "public_object_id", "public_object_version"].some(key => receipt[key] !== promotion[key])) fail("invalid_response", 502);
        return response(200, publicReceipt(receipt));
      }, aggregateMs, request.signal);
    } catch (error) {
      return response(error instanceof MediaFailure ? error.status : 502, { error: error instanceof MediaFailure ? error.code : "validation_unavailable" });
    } finally { active = false; }
  };
}

if (new URL(import.meta.url).searchParams.has("parser-worker")) {
  const workerSelf = globalThis as unknown as { onmessage: (event: MessageEvent) => void; postMessage: (value: unknown, transfer?: Transferable[]) => void };
  workerSelf.onmessage = async event => {
    try {
      const result = await inspectStoryBytes(event.data.bytes, event.data.declaration, event.data.limits);
      workerSelf.postMessage({ result, bytes: event.data.bytes }, [event.data.bytes.buffer]);
    }
    catch (error) { workerSelf.postMessage({ error: error instanceof MediaFailure ? error.code : "storage_unavailable" }); }
  };
} else if (import.meta.main) {
  Deno.serve(createStoryMediaHandler({ enabled: Deno.env.get("STORY_MEDIA_VALIDATION_ENABLED") === "true",
    origin: Deno.env.get("SUPABASE_URL") || "", anonKey: Deno.env.get("SUPABASE_ANON_KEY") || "",
    serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "", clientOrigin: Deno.env.get("STORY_MEDIA_CLIENT_ORIGIN") || "" }));
}