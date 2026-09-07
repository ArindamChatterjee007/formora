import { createStoryMediaHandler, parseInWorker, validateStoryBytes, technicalLimits } from "../supabase/functions/validate-story-media/index.ts";

async function verify(directory: string) {
if (!directory || !/\/dist\/story-media\/fixtures-[a-zA-Z0-9]+$/.test(directory)) throw new Error("Synthetic fixture directory required");
const cases: { name: string; passed: boolean; error?: string }[] = [];
async function check(name: string, work: () => Promise<void>) {
  try { await work(); cases.push({ name, passed: true }); }
  catch (error) { cases.push({ name, passed: false, error: error instanceof Error ? error.message.slice(0, 512) : 'Non-Error failure' }); }
}
const mime: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", mp4: "video/mp4", webm: "video/webm" };
for (const filename of ["photo.jpg", "photo.png", "photo.webp", "clip.mp4", "clip.webm", "long.mp4", "fake-duration.mp4",
  "truncated-photo.jpg", "truncated-photo.png", "truncated-photo.webp", "truncated-clip.mp4", "truncated-clip.webm", "truncated-long.mp4"]) {
  const bytes = await Deno.readFile(directory + "/" + filename);
  const byteLength = bytes.byteLength;
  const contentType = mime[filename.split(".").at(-1)!], kind = contentType.startsWith("image/") ? "photo" : "video";
  const accepted = /^(photo|clip)\./.test(filename);
  await check(filename + (accepted ? ": accepted" : ": rejected"), async () => {
    let result;
    try { result = await parseInWorker(bytes, { content_type: contentType, kind, declared_bytes: byteLength }); }
    catch { if (!accepted) return; throw new Error("Valid binary rejected"); }
    if (!accepted || bytes.byteLength !== 0 || result.bytes.byteLength !== byteLength || result.width !== 16 || result.height !== 16 || result.actual_bytes !== byteLength
      || result.duration_verified !== (kind === "video") || (kind === "video" && result.duration_ms !== 1000)) throw new Error("Incorrect binary attestation");
  });
}
const photo = await Deno.readFile(directory + "/photo.jpg");
for (const [name, work] of [
  ["forged MIME", () => validateStoryBytes(photo, { kind: "photo", content_type: "image/png", declared_bytes: photo.length })],
  ["declared size mismatch", () => validateStoryBytes(photo, { kind: "photo", content_type: "image/jpeg", declared_bytes: photo.length + 1 })],
  ["pixel limit", () => validateStoryBytes(photo, { kind: "photo", content_type: "image/jpeg", declared_bytes: photo.length }, { ...technicalLimits, max_pixels: 100 })],
  ["photo byte cap", () => validateStoryBytes(new Uint8Array(8388609), { kind: "photo", content_type: "image/jpeg", declared_bytes: 8388609 })],
  ["arbitrary bytes", () => validateStoryBytes(new Uint8Array(100), { kind: "video", content_type: "video/mp4", declared_bytes: 100 })],
  ["worker hard deadline", () => parseInWorker(photo.slice(), { kind: "photo", content_type: "image/jpeg", declared_bytes: photo.length }, technicalLimits, undefined, 1)],
] as const) {
  await check(name, async () => { let rejected = false; try { await work(); } catch { rejected = true; } if (!rejected) throw new Error("Expected rejection"); });
}
const owner = "11111111-1111-4111-8111-111111111111", requestId = "22222222-2222-4222-8222-222222222222";
const reservationId = "33333333-3333-4333-8333-333333333333", origin = "https://fixture.supabase.co";
const config = { enabled: true, origin, anonKey: "fixture-public", serviceKey: "fixture-service-only", clientOrigin: "https://fixture-app.example" };
const objectKey = `stories/${owner}/${reservationId}.jpg`;
const publicKeyId = "44444444-4444-4444-8444-444444444444";
const photoHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", photo))].map(value => value.toString(16).padStart(2, "0")).join("");
type Row = Record<string, unknown>;
type Hook = (url: string, init: RequestInit, reservation: Row) => Promise<Response | null> | Response | null;
function attestedFields(sha256 = photoHash) {
  const publicKey = `stories/${owner}/${publicKeyId}_${sha256}.jpg`;
  return { sha256, actual_bytes: photo.length, width: 16, height: 16, duration_ms: null, duration_verified: false,
    public_key: publicKey, media_url: origin + "/storage/v1/object/public/story-media-public-v3/" + publicKey };
}
function handlerFixture(hook?: Hook, overrides = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const reservation: Row = { schema_version: 2, reservation_id: reservationId, request_id: requestId, owner, bucket: "story-media-quarantine-v3",
    object_key: objectKey, media_url: null, public_bucket: "story-media-public-v3", public_key_id: publicKeyId, public_key: null,
    public_object_id: null, public_object_version: null, kind: "photo",
    content_type: "image/jpeg", declared_bytes: photo.length, expires_at: new Date(Date.now() + 900000).toISOString(),
    status: "validating", epoch: 2, policy_epoch: 1, uploaded: true, lease_token: crypto.randomUUID(), object_id: crypto.randomUUID(),
    object_version: "fixture-immutable-version", limits: technicalLimits };
  const handler = createStoryMediaHandler({ ...config, ...overrides }, { stepMs: 10000, ...overrides, fetch: async (input, init = {}) => {
    const url = String(input); calls.push({ url, init });
    const injected = await hook?.(url, init, reservation); if (injected) return injected;
    if (url.endsWith("/auth/v1/user")) return new Headers(init.headers).get("authorization") === "Bearer signed-fixture-token"
      ? Response.json({ id: owner, is_anonymous: false }) : Response.json({ error: "bad_jwt" }, { status: 401 });
    if (url.endsWith("/claim_story_media_validation")) {
      if (reservation.status === "reserved") Object.assign(reservation, { status: "validating", epoch: Number(reservation.epoch) + 1, lease_token: crypto.randomUUID() });
      return Response.json(reservation);
    }
    if (url.includes("/storage/v1/object/authenticated/")) return new Response(photo, { headers: { "content-length": String(photo.length), "content-type": "image/jpeg" } });
    if (url.endsWith("/attest_story_media")) {
      const body = JSON.parse(String(init.body));
      if (body.p_owner !== owner || body.p_request_id !== requestId || body.p_lease_token !== reservation.lease_token) throw new Error("Wrong service binding");
      Object.assign(reservation, body.p_failure_code ? { status: ["storage_unavailable", "validation_timeout"].includes(body.p_failure_code) ? "reserved" : "failed" }
        : { ...attestedFields(body.p_sha256), status: "attested" });
      return Response.json(reservation);
    }
    if (url.endsWith("/claim_story_media_promotion")) {
      const writeAllowed = reservation.status === "attested";
      Object.assign(reservation, { status: "promoting", promotion_token: reservation.promotion_token || crypto.randomUUID() });
      return Response.json({ ...reservation, write_allowed: writeAllowed });
    }
    if (url.startsWith(origin + "/storage/v1/object/story-media-public-v3/")) {
      const bytes = init.body as Uint8Array<ArrayBuffer>;
      const metadata = JSON.parse(atob(new Headers(init.headers).get("x-metadata")!));
      if (init.method !== "POST" || new Headers(init.headers).get("x-upsert") !== "false" || bytes.length !== photo.length
        || !bytes.every((value, index) => value === photo[index]) || metadata.sha256 !== photoHash
        || metadata.promotion_token !== reservation.promotion_token || reservation.public_object_id !== null) throw new Error("Incorrect promoted bytes or duplicate write");
      Object.assign(reservation, { public_object_id: crypto.randomUUID(), public_object_version: "fixture-public-version" });
      return Response.json({ Id: reservation.public_object_id, Key: reservation.public_bucket + "/" + reservation.public_key });
    }
    if (url.endsWith("/finalize_story_media")) {
      const body = JSON.parse(String(init.body));
      if (body.p_sha256 !== photoHash || body.p_public_object_id !== reservation.public_object_id || body.p_public_object_version !== reservation.public_object_version) throw new Error("Incorrect final binding");
      reservation.status = "approved";
      return Response.json(reservation);
    }
    throw new Error("Unexpected fixture request");
  } });
  const invoke = (body: unknown = { request_id: requestId }, token = "signed-fixture-token", signal?: AbortSignal) => handler(new Request(origin + "/functions/v1/validate-story-media",
    { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify(body), signal }));
  return { calls, invoke, handler, reservation };
}
await check("handler: GoTrue owner -> private claim -> canonical bytes -> real worker -> service attestation", async () => {
  const fixture = handlerFixture(), response = await fixture.invoke(), body = await response.json();
  if (response.status !== 200 || body.status !== "approved" || body.actual_bytes !== photo.length || body.sha256.length !== 64) throw new Error("Handler failed");
  if (fixture.calls.length !== 8 || fixture.calls.some(call => !call.url.startsWith(origin + "/") || call.init.redirect !== "error")) throw new Error("Unexpected network target");
  if (fixture.calls.filter(call => call.url.includes("/object/authenticated/")).length !== 1 || body.public_bucket !== "story-media-public-v3") throw new Error("Normal promotion refetched bytes or leaked quarantine URL");
  if (new Headers(fixture.calls[0].init.headers).get("apikey") !== config.anonKey || JSON.stringify(body).includes(config.serviceKey)) throw new Error("Credential boundary failed");
  for (const privateField of ["epoch", "lease_token", "object_id", "object_version", "limits"]) if (Object.hasOwn(body, privateField)) throw new Error("Private field escaped");
  for (const call of fixture.calls.slice(1)) if (new Headers(call.init.headers).get("authorization") !== "Bearer " + config.serviceKey) throw new Error("Service credential missing");
});
await check("handler: private upstream extras are dropped from both fresh and duplicate receipts", async () => {
  for (const duplicate of [false, true]) {
    const fixture = handlerFixture((url, init, reservation) => {
      if (!(duplicate ? url.endsWith("/claim_story_media_validation") : url.endsWith("/finalize_story_media"))) return null;
      const payload = duplicate ? null : JSON.parse(String(init.body));
      return Response.json({ ...reservation, ...attestedFields(payload?.p_sha256), status: "approved",
        public_object_id: reservation.public_object_id || crypto.randomUUID(), public_object_version: "fixture-public-version",
        private_debug: config.serviceKey, internal_queue: { actor: "private" } });
    });
    const response = await fixture.invoke(), body = await response.json();
    if (response.status !== 200 || Object.hasOwn(body, "private_debug") || Object.hasOwn(body, "lease_token")
      || JSON.stringify(body).includes(config.serviceKey)) throw new Error("Private response leaked");
  }
});
await check("handler: off is inert and forged JWT is rejected by GoTrue, never decoded into an owner", async () => {
  const disabled = handlerFixture(undefined, { enabled: false });
  if ((await disabled.invoke()).status !== 503 || disabled.calls.length) throw new Error("Off performed work");
  const forged = handlerFixture();
  if ((await forged.invoke(undefined, "eyJhbGciOiJub25lIn0.eyJzdWIiOiJvd25lciJ9.")).status !== 401 || forged.calls.length !== 1) throw new Error("Forged token accepted");
});
await check("handler: arbitrary URL and owner input cannot initiate network requests", async () => {
  for (const extra of [{ url: "http://169.254.169.254/" }, { owner }, { bucket: "media" }]) {
    const fixture = handlerFixture();
    if ((await fixture.invoke({ request_id: requestId, ...extra })).status !== 400 || fixture.calls.length) throw new Error("Caller data widened scope");
  }
});
await check("handler: configuration rejects noncanonical origins before using service credentials", async () => {
  for (const url of ["http://127.0.0.1:8000", origin + "/", origin + ".evil.example", "https://user:pass@fixture.supabase.co", origin + "?next=elsewhere"]) {
    const fixture = handlerFixture(undefined, { origin: url });
    if ((await fixture.invoke()).status !== 503 || fixture.calls.length) throw new Error("Unsafe origin accepted");
  }
});
for (const field of ["owner", "object_key", "media_url", "bucket"]) await check("handler: forged reservation " + field, async () => {
  const fixture = handlerFixture((url, _init, reservation) => url.endsWith("/claim_story_media_validation") ? Response.json({ ...reservation, [field]: "foreign" }) : null);
  if ((await fixture.invoke()).status !== 502 || fixture.calls.length !== 2) throw new Error("Foreign reservation fetched");
});
await check("handler: missing Storage length is retryable infrastructure failure and recovers", async () => {
  let missing = true;
  const fixture = handlerFixture(url => url.includes("/storage/") && missing
    ? new Response(photo, { headers: { "content-type": "image/jpeg" } }) : null);
  const response = await fixture.invoke();
  if (response.status !== 503 || (await response.json()).error !== "storage_unavailable"
    || fixture.reservation.status !== "reserved" || JSON.parse(String(fixture.calls.at(-1)?.init.body)).p_failure_code !== "storage_unavailable") throw new Error("Missing header consumed invalid slot");
  missing = false;
  if ((await fixture.invoke()).status !== 200) throw new Error("Missing header did not recover");
});
await check("handler: forced worker load failure is nonterminal and recovers", async () => {
  const OriginalWorker = globalThis.Worker;
  const fixture = handlerFixture();
  try {
    globalThis.Worker = class extends OriginalWorker {
      constructor(_specifier: string | URL, options?: WorkerOptions) {
        super("data:application/javascript,throw new Error('synthetic worker load failure')", options);
      }
    };
    const response = await fixture.invoke();
    if (response.status !== 503 || (await response.json()).error !== "storage_unavailable"
      || fixture.reservation.status !== "reserved" || JSON.parse(String(fixture.calls.at(-1)?.init.body)).p_failure_code !== "storage_unavailable") throw new Error("Worker failure consumed invalid slot");
  } finally { globalThis.Worker = OriginalWorker; }
  if ((await fixture.invoke()).status !== 200) throw new Error("Worker did not recover");
});
await check("handler: Storage body infrastructure error never attests an invalid file", async () => {
  const fixture = handlerFixture(url => url.includes("/storage/") ? new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.error(new Error("synthetic connection reset")); }
  }), { headers: { "content-type": "image/jpeg", "content-length": String(photo.length) } }) : null);
  const response = await fixture.invoke();
  if (response.status !== 503 || (await response.json()).error !== "storage_unavailable"
    || fixture.reservation.status !== "reserved" || JSON.parse(String(fixture.calls.at(-1)?.init.body)).p_failure_code !== "storage_unavailable") throw new Error("Body failure consumed invalid slot");
});
for (const variant of ["oversize", "short", "chunk-overrun"]) await check("handler: streamed Storage length " + variant, async () => {
  const fixture = handlerFixture(url => {
    if (!url.includes("/storage/")) return null;
    const length = variant === "oversize" ? photo.length + 1 : photo.length;
    const bytes = variant === "short" ? photo.subarray(1) : variant === "chunk-overrun" ? new Uint8Array(photo.length + 1) : photo;
    return new Response(bytes, { headers: { "content-type": "image/jpeg", ...(length === undefined ? {} : { "content-length": String(length) }) } });
  });
  if ((await fixture.invoke()).status !== 422 || !fixture.calls.some(call => call.url.endsWith("/attest_story_media") && JSON.parse(String(call.init.body)).p_failure_code === "size_mismatch")) throw new Error("Storage length accepted");
});
await check("handler: malformed actual bytes become failed, never publish-ready", async () => {
  const fixture = handlerFixture(url => url.includes("/storage/") ? new Response(new Uint8Array(photo.length), { headers: { "content-type": "image/jpeg", "content-length": String(photo.length) } }) : null);
  if ((await fixture.invoke()).status !== 422 || JSON.parse(String(fixture.calls.at(-1)?.init.body)).p_failure_code !== "invalid_media") throw new Error("Malformed bytes approved");
  if (fixture.calls.some(call => call.url.includes("/object/story-media-public-v3/"))) throw new Error("Rejected bytes became public");
});
await check("handler: uncertain public ACK reconciles stored version and actual SHA without any repeat upload", async () => {
  for (const mode of ["valid", "tampered", "not-confirmed"]) {
    const fixture = handlerFixture((url, _init, reservation) => {
      if (url.endsWith("/claim_story_media_validation")) {
        Object.assign(reservation, attestedFields(), { status: "promoting", promotion_token: crypto.randomUUID(),
          public_object_id: mode === "not-confirmed" ? null : crypto.randomUUID(), public_object_version: mode === "not-confirmed" ? null : "fixture-public-version" });
        return Response.json(reservation);
      }
      if (mode === "tampered" && url.includes("/object/authenticated/")) return new Response(new Uint8Array(photo.length),
        { headers: { "content-type": "image/jpeg", "content-length": String(photo.length) } });
      return null;
    });
    const response = await fixture.invoke();
    if (response.status !== (mode === "valid" ? 200 : 503) || fixture.calls.some(call => call.url.includes("/object/story-media-public-v3/"))) throw new Error("Unsafe promotion replay");
    if (mode !== "valid" && fixture.calls.some(call => call.url.endsWith("/finalize_story_media"))) throw new Error("Unknown public bytes finalized");
  }
});
await check("handler: foreign public version or key in post-upload binding cannot finalize", async () => {
  for (const field of ["public_key", "public_object_id", "sha256"]) {
    const fixture = handlerFixture((url, _init, reservation) => url.endsWith("/claim_story_media_promotion") && reservation.public_object_id
      ? Response.json({ ...reservation, write_allowed: false, [field]: "foreign" }) : null);
    if ((await fixture.invoke()).status === 200 || fixture.calls.some(call => call.url.endsWith("/finalize_story_media"))) throw new Error("Foreign promotion finalized");
  }
});
await check("handler: an unverified video duration is never an approved replay", async () => {
  const fixture = handlerFixture((url, _init, reservation) => url.endsWith("/claim_story_media_validation") ? Response.json({ ...reservation,
    status: "approved", kind: "video", content_type: "video/mp4", object_key: objectKey.replace(/jpg$/, "mp4"),
    media_url: String(reservation.media_url).replace(/jpg$/, "mp4"), sha256: "a".repeat(64), actual_bytes: photo.length,
    duration_ms: null, duration_verified: false }) : null);
  if ((await fixture.invoke()).status !== 502 || fixture.calls.length !== 2) throw new Error("Unverified video replay accepted");
});
await check("handler: abort-ignoring auth cannot run late claim or attestation", async () => {
  let complete: ((response: Response) => void) | undefined;
  const fixture = handlerFixture(url => url.endsWith("/auth/v1/user") ? new Promise(resolve => { complete = resolve; }) : null, { stepMs: 15 });
  if ((await fixture.invoke()).status !== 504) throw new Error("No hard deadline");
  complete!(Response.json({ id: owner })); await Promise.resolve(); await Promise.resolve();
  if (fixture.calls.length !== 1) throw new Error("Late auth continued");
});
await check("handler: response-body and aggregate deadlines remain hard with no late service write", async () => {
  for (const aggregateMs of [30000, 10]) {
    let cancelled = false;
    const fixture = handlerFixture(url => url.endsWith("/auth/v1/user") ? new Response(new ReadableStream<Uint8Array>({ start() {}, cancel() { cancelled = true; } })) : null,
      { stepMs: 20, aggregateMs });
    if ((await fixture.invoke()).status !== 504 || fixture.calls.length !== 1 || !cancelled) throw new Error("Body deadline failed");
  }
});
await check("handler: one active parser queue rejects concurrent invocations", async () => {
  let started: () => void = () => {};
  const observed = new Promise<void>(resolve => { started = resolve; });
  const fixture = handlerFixture(url => {
    if (!url.endsWith("/auth/v1/user")) return null;
    started(); return new Promise<Response>(() => {});
  }, { stepMs: 20 });
  const pending = fixture.invoke(); await observed;
  if ((await fixture.invoke()).status !== 429 || (await pending).status !== 504) throw new Error("Parallel parser admission failed");
});
console.log(JSON.stringify({ result: cases.every(item => item.passed) ? "passed" : "failed", network: "denied", runtime: Deno.version,
  cases, passed: cases.filter(item => item.passed).length, failed: cases.filter(item => !item.passed).length }, null, 2));
if (cases.some(item => !item.passed)) Deno.exitCode = 1;
}

async function measureMemory(directory: string) {
  if (!directory || !/\/dist\/story-media\/fixtures-[a-zA-Z0-9]+$/.test(directory)) throw new Error("Synthetic fixture directory required");
  const bytes = await Deno.readFile(directory + "/clip-large.mp4"), inputBytes = bytes.byteLength;
  if (inputBytes !== technicalLimits.video_bytes) throw new Error("Exact 25 MiB synthetic input required");
  const started = performance.now();
  const result = await parseInWorker(bytes, { kind: "video", content_type: "video/mp4", declared_bytes: inputBytes });
  if (bytes.byteLength !== 0 || result.bytes.byteLength !== inputBytes || result.actual_bytes !== inputBytes || result.duration_ms !== 1000) throw new Error("Large binary probe failed");
  console.log(JSON.stringify({ result: "passed", inputBytes, runtime: Deno.version, durationMs: performance.now() - started,
    transferredAndReturned: true, sha256: result.sha256, parsedDurationMs: result.duration_ms }));
}

async function bridge() {
  const pending = new Map<number, (response: Response) => void>(); let sequence = 0;
  const handler = createStoryMediaHandler({ enabled: true, origin: "https://fixture.supabase.co", anonKey: "fixture-public",
    serviceKey: "fixture-service-only", clientOrigin: "https://fixture-app.example" }, { fetch: async (input, init = {}) => {
    const id = ++sequence;
    const result = new Promise<Response>(resolve => pending.set(id, resolve));
    let bodyBase64: string | undefined;
    if (init.body instanceof Uint8Array) {
      let binary = "";
      for (let offset = 0; offset < init.body.byteLength; offset += 8192) binary += String.fromCharCode(...init.body.subarray(offset, offset + 8192));
      bodyBase64 = btoa(binary);
    }
    console.log(JSON.stringify({ type: "fetch", id, url: String(input), method: init.method || "GET",
      headers: Object.fromEntries(new Headers(init.headers)), body: bodyBase64 === undefined ? init.body || null : null, bodyBase64 }));
    return await result;
  } });
  let buffer = "";
  for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    if (buffer.length > 40000000) throw new Error("Fixture IPC bound exceeded");
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      if (message.type === "response") {
        const resolve = pending.get(message.id); pending.delete(message.id);
        const bytes = Uint8Array.from(atob(message.body), character => character.charCodeAt(0));
        resolve?.(new Response(bytes, { status: message.status, headers: message.headers }));
      } else if (message.type === "validate") {
        const request = new Request("https://fixture.supabase.co/functions/v1/validate-story-media", { method: "POST",
          headers: { authorization: message.authorization, "content-type": "application/json" }, body: JSON.stringify(message.body) });
        handler(request).then(async response => console.log(JSON.stringify({ type: "result", id: message.id, status: response.status, body: await response.json() })));
      } else throw new Error("Unknown fixture IPC operation");
    }
  }
}
if (Deno.args[0] === "--bridge") await bridge();
else if (Deno.args[0] === "--memory") await measureMemory(Deno.args[1]);
else await verify(Deno.args[0]);