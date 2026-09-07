import { cleanupConfiguration, cleanupLimits, createStoryMediaCleanupHandler, type CleanupConfig } from "../supabase/functions/cleanup-story-media/index.ts";

const origin = "https://cleanup-fixture.supabase.co";
const serviceKey = "synthetic-local-cleanup-service-key-000000000000";
const operation = "11111111-1111-4111-8111-111111111111";
const claimId = "22222222-2222-4222-8222-222222222222";
const owner = "33333333-3333-4333-8333-333333333333";
const reservation = "44444444-4444-4444-8444-444444444444";
const objectId = "55555555-5555-4555-8555-555555555555";
const intentId = "66666666-6666-4666-8666-666666666666";
const token = "77777777-7777-4777-8777-777777777777";
const policy = "88888888-8888-4888-8888-888888888888";
const key = `stories/${owner}/${reservation}.jpg`;
const config: CleanupConfig = { enabled: true, origin, serviceKey };
const cases: { name: string; passed: boolean; error?: string }[] = [];
type Json = Record<string, unknown>;
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function check(name: string, work: () => Promise<void> | void) {
  try { await work(); cases.push({ name, passed: true }); }
  catch (error) { cases.push({ name, passed: false, error: error instanceof Error ? error.message.slice(0, 512) : "Unexpected failure" }); }
}
type Call = { url: string; init: RequestInit };
type Hook = (call: Call, state: ReturnType<typeof claimFixture>) => Response | Promise<Response> | null;
function claimFixture() {
  return { schema_version: 1, operation_id: operation, claim_id: claimId, reservation_id: reservation, owner, request_id: operation,
    reservation_epoch: 1, cleanup_epoch: 1, retention_policy_ref: policy, storage_policy_ref: policy, approval_ref: policy,
    snapshot_sha256: "a".repeat(64), lease_token: token, lease_until: new Date(Date.now() + 30000).toISOString(), content_type: "image/jpeg",
    public_key_id: objectId, sha256: null, physical_delete_confirmed: false, account_deleted: false,
    objects: [{ intent_id: intentId, object_id: objectId, bucket: "story-media-quarantine-v3", object_key: key,
      object_version: "synthetic-version-1", state: "claimed", outcome: "pending", metadata_deleted: false, delete_requested: false, delete_attempts: 0 }] };
}
function fixture(hook?: Hook, overrides: Partial<CleanupConfig> & { stepMs?: number; aggregateMs?: number } = {}) {
  const calls: Call[] = [], state = claimFixture();
  const handler = createStoryMediaCleanupHandler({ ...config, ...overrides }, { ...overrides, fetch: async (input, init = {}) => {
    const call = { url: String(input), init }; calls.push(call);
    const custom = await hook?.(call, state); if (custom) return custom;
    const object = state.objects[0];
    if (call.url.endsWith("/claim_story_media_cleanup")) return Response.json(state);
    if (call.url.endsWith("/request_story_media_cleanup_object")) {
      Object.assign(object, { state: "object_delete_requested", delete_requested: true, delete_attempts: object.delete_attempts + 1 });
      return Response.json({ ...state, intent_id: object.intent_id, delete_allowed: true });
    }
    if (call.url === origin + "/storage/v1/object/" + object.bucket) {
      assert(init.method === "DELETE" && JSON.stringify(JSON.parse(String(init.body))) === JSON.stringify({ prefixes: [key] }), "Wrong Storage remove request");
      object.metadata_deleted = true;
      return Response.json([{ name: key, id: objectId, bucket_id: object.bucket }]);
    }
    if (call.url === origin + "/storage/v1/object/authenticated/" + object.bucket + "/" + key) return new Response(null, { status: 404 });
    if (call.url.endsWith("/finish_story_media_cleanup_object")) {
      const body = JSON.parse(String(init.body));
      Object.assign(object, { state: body.p_result === "storage_api_deleted" ? "completed" : "unknown", outcome: body.p_result });
      return Response.json(state);
    }
    throw new Error("Unexpected synthetic network route");
  } });
  const invoke = (body: unknown = { operation_id: operation, claim_id: claimId }, headers: Record<string, string> = {}) => handler(new Request(origin + "/functions/v1/cleanup-story-media",
    { method: "POST", headers: { "content-type": "application/json", "x-story-media-cleanup-key": serviceKey, ...headers }, body: JSON.stringify(body) }));
  return { handler, calls, state, invoke };
}

async function verify() {
await check("environment requires exact true and never enables itself", () => {
  for (const value of [undefined, "false", "TRUE", "1", " true "]) assert(!cleanupConfiguration(() => value).enabled, "Unsafe implicit enablement");
  assert(cleanupConfiguration(() => "true").enabled, "Exact true missing");
});
await check("default off and noncanonical configuration issue zero requests", async () => {
  for (const overrides of [{ enabled: false }, { origin: origin + "/" }, { origin: origin + "?url=elsewhere" }, { origin: "http://127.0.0.1:1" },
    { origin: "https://cleanup-fixture.supabase.co.evil.invalid" }, { origin: "https://user:password@cleanup-fixture.supabase.co" }, { serviceKey: "short" }]) {
    const local = fixture(undefined, overrides);
    assert((await local.invoke()).status === 503 && local.calls.length === 0, "Unsafe configuration made requests");
  }
});
await check("only exact server service key authenticates; bearer and forged role JWT do not", async () => {
  for (const supplied of ["", "member-token", "eyJhbGciOiJub25lIn0.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.", serviceKey + "," + serviceKey,
    serviceKey.slice(0, -1) + "1"]) {
    const local = fixture();
    assert((await local.invoke(undefined, { "x-story-media-cleanup-key": supplied, authorization: "Bearer " + serviceKey })).status === 401,
      "Non-service input authenticated");
    assert(local.calls.length === 0, "Unauthorized request did work");
  }
});
await check("operation-only input rejects arbitrary object, owner, URL, version and excess bodies", async () => {
  for (const body of [{ operation_id: operation, path: key }, { operation_id: operation, owner }, { operation_id: operation, url: "http://169.254.169.254" },
    { operation_id: operation, object_version: "new" }, { operation_id: operation, claim_id: "invalid" }, {}, [], { operation_id: "x".repeat(1000) }]) {
    const local = fixture();
    assert((await local.invoke(body)).status === 400 && local.calls.length === 0, "Caller widened cleanup scope");
  }
});
await check("actual handler issues exact remove then authenticated absence and projects only a limited receipt", async () => {
  const local = fixture(), response = await local.invoke(), body = await response.json();
  assert(response.status === 200 && body.result === "storage_api_deleted" && body.completed === 1 && body.pending === 0, "Logical deletion failed");
  assert(body.physical_delete_confirmed === false && body.account_deleted === false && body.evidence_scope === "storage_api_visibility_only", "Overclaimed erasure");
  assert(local.calls.length === 5 && local.calls.length <= cleanupLimits.requests, "Unbounded execution");
  for (const call of local.calls) {
    const headers = new Headers(call.init.headers);
    assert(call.url.startsWith(origin + "/") && !new URL(call.url).search && call.init.redirect === "error" && call.init.credentials === "omit", "Unsafe network destination");
    assert(headers.get("apikey") === serviceKey && headers.get("authorization") === "Bearer " + serviceKey, "Server credentials absent");
  }
  assert(!/lease|object_key|owner|snapshot|approval/.test(JSON.stringify(body)) && !JSON.stringify(body).includes(serviceKey), "Private data escaped");
  const writes = local.calls.filter(call => call.init.method === "DELETE");
  assert(writes.length === 1 && writes[0].url === origin + "/storage/v1/object/story-media-quarantine-v3", "Wrong delete route");
});
await check("204, malformed, duplicate, foreign and empty ACKs cannot claim successful deletion", async () => {
  for (const body of [null, {}, [], [{ name: key + "/foreign" }], [{ name: key, id: operation }], [{ name: key }, { name: key }]]) {
    const local = fixture(call => call.init.method === "DELETE" ? body === null ? new Response(null, { status: 204 }) : Response.json(body) : null);
    const response = await local.invoke(), result = await response.json();
    assert(result.result !== "storage_api_deleted" && response.status !== 200, "Invalid ACK completed intent");
  }
});
await check("abort-ignoring claim cannot continue into a late storage request", async () => {
  let complete: ((response: Response) => void) | undefined;
  const local = fixture(call => call.url.endsWith("/claim_story_media_cleanup") ? new Promise(resolve => { complete = resolve; }) : null, { stepMs: 10 });
  assert((await local.invoke()).status === 504, "Missing deadline");
  complete!(Response.json(local.state)); await Promise.resolve(); await Promise.resolve();
  assert(local.calls.length === 1, "Late claim performed a write");
});

await check("documented name-only remove ACK is matched exactly and extra service fields are never returned", async () => {
  const local = fixture((call, state) => {
    if (call.init.method !== "DELETE") return null;
    state.objects[0].metadata_deleted = true;
    return Response.json([{ name: key, private_debug: serviceKey }]);
  });
  const response = await local.invoke({ operation_id: operation }), body = await response.json();
  assert(response.status === 200 && body.result === "storage_api_deleted", "Documented exact name ACK rejected");
  assert(!JSON.stringify(body).includes(serviceKey) && !JSON.stringify(body).includes("private_debug"), "Service extras escaped");
});
await check("method, browser origin, URL query, content type and already-aborted input do no work", async () => {
  for (const variant of ["method", "origin", "query", "type", "aborted"]) {
    const local = fixture(), abort = new AbortController();
    if (variant === "aborted") abort.abort();
    const headers = { "content-type": variant === "type" ? "application/x-www-form-urlencoded" : "application/json",
      "x-story-media-cleanup-key": serviceKey, ...(variant === "origin" ? { origin: "https://member.invalid" } : {}) };
    const response = await local.handler(new Request(origin + "/functions/v1/cleanup-story-media" + (variant === "query" ? "?operation_id=" + operation : ""),
      { method: variant === "method" ? "GET" : "POST", headers, ...(variant === "method" ? {} : { body: JSON.stringify({ operation_id: operation }) }), signal: abort.signal }));
    assert(response.status === (variant === "method" ? 405 : variant === "aborted" ? 504 : 400) && local.calls.length === 0, "Invalid input executed");
  }
});
await check("upstream redirects are rejected without another destination or any delete", async () => {
  const local = fixture(call => call.url.endsWith("/claim_story_media_cleanup")
    ? new Response(null, { status: 302, headers: { location: "https://foreign.invalid/" } }) : null);
  assert((await local.invoke()).status === 502 && local.calls.length === 1, "Redirect accepted");
});
await check("malformed, missing-length oversize and header-declared oversize JSON fail closed", async () => {
  for (const variant of ["invalid", "stream", "header", "too-many-objects"]) {
    const local = fixture((call, state) => {
      if (!call.url.endsWith("/claim_story_media_cleanup")) return null;
      if (variant === "too-many-objects") return Response.json({ ...state, objects: Array(3).fill(state.objects[0]) });
      return new Response(variant === "invalid" ? "{" : " ".repeat(cleanupLimits.jsonBytes + 1),
        { headers: { "content-type": "application/json", ...(variant === "header" ? { "content-length": String(cleanupLimits.jsonBytes + 1) } : {}) } });
    });
    assert((await local.invoke()).status === 502 && local.calls.length === 1, "Bad upstream JSON executed");
  }
});
await check("all claim identity, policy and object-version fields are pinned again before DELETE", async () => {
  for (const field of ["operation_id", "claim_id", "owner", "reservation_id", "request_id", "retention_policy_ref", "storage_policy_ref",
    "approval_ref", "snapshot_sha256", "lease_token", "object_id", "object_key", "object_version", "bucket"]) {
    const local = fixture((call, state) => {
      if (!call.url.endsWith("/request_story_media_cleanup_object")) return null;
      const altered: Json = { ...state, intent_id: intentId, delete_allowed: true,
        objects: [{ ...state.objects[0], state: "object_delete_requested", delete_requested: true, delete_attempts: 1 }] };
      if (["object_id", "object_key", "object_version", "bucket"].includes(field)) (altered.objects as Json[])[0][field] = field === "object_id" ? operation : "foreign";
      else altered[field] = field === "snapshot_sha256" ? "b".repeat(64) : objectId;
      return Response.json(altered);
    });
    assert((await local.invoke()).status !== 200 && local.calls.every(call => call.init.method !== "DELETE"), "Mutated binding reached DELETE: " + field);
  }
});
await check("authenticated absence errors or a still-visible object never complete a deletion", async () => {
  for (const status of [200, 206, 401, 403, 500]) {
    const local = fixture(call => call.url.includes("/object/authenticated/") ? new Response(null, { status }) : null);
    const response = await local.invoke(), body = await response.json();
    assert(response.status !== 200 && body.result !== "storage_api_deleted" && local.state.objects[0].state === "unknown", "Non-404 became absence");
  }
});
await check("stalled request and response bodies are cancelled by hard step and aggregate deadlines", async () => {
  for (const variant of ["request", "response", "aggregate"]) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start() {}, cancel() { cancelled = true; } });
    const local = fixture(call => variant !== "request" && call.url.endsWith("/claim_story_media_cleanup")
      ? new Response(stream, { headers: { "content-type": "application/json" } }) : null,
      { stepMs: variant === "aggregate" ? 5000 : 10, aggregateMs: variant === "aggregate" ? 10 : 20000 });
    const response = variant === "request" ? await local.handler(new Request(origin + "/functions/v1/cleanup-story-media", { method: "POST",
      headers: { "content-type": "application/json", "x-story-media-cleanup-key": serviceKey }, body: stream })) : await local.invoke();
    assert(response.status === 504 && cancelled && local.calls.length === (variant === "request" ? 0 : 1), "Body deadline or cancellation failed");
  }
});
await check("one active handler rejects concurrent work and releases its slot after deadline", async () => {
  let entered: () => void = () => {}, blocked = true;
  const observed = new Promise<void>(resolve => { entered = resolve; });
  const local = fixture(call => {
    if (!blocked || !call.url.endsWith("/claim_story_media_cleanup")) return null;
    entered(); return new Promise<Response>(() => {});
  }, { stepMs: 10 });
  const first = local.invoke(); await observed;
  assert((await local.invoke()).status === 429 && local.calls.length === 1, "Concurrent worker admitted");
  assert((await first).status === 504, "Active call did not time out");
  blocked = false; assert((await local.invoke()).status === 200, "Completed handler retained its slot");
});
await check("expired lease and forged completed or backend-unknown receipts fail closed", async () => {
  for (const variant of ["lease", "completed", "unknown"]) {
    const local = fixture((call, state) => {
      if (!call.url.endsWith("/claim_story_media_cleanup")) return null;
      return Response.json(variant === "lease" ? { ...state, lease_until: new Date(Date.now() - 1000).toISOString() }
        : { ...state, objects: [{ ...state.objects[0], state: variant === "completed" ? "completed" : "unknown",
          outcome: variant === "completed" ? "storage_api_deleted" : "storage_api_absent_backend_unknown" }] });
    });
    assert((await local.invoke()).status !== 200 && local.calls.length === 1, "Unproven receipt accepted");
  }
});

console.log(JSON.stringify({ result: cases.every(entry => entry.passed) ? "passed" : "failed", runtime: Deno.version, network: "denied",
  cases, passed: cases.filter(entry => entry.passed).length, failed: cases.filter(entry => !entry.passed).length }));
if (cases.some(entry => !entry.passed)) Deno.exitCode = 1;
}

async function bridge() {
  const pending = new Map<number, { resolve: (response: Response) => void; reject: (error: Error) => void }>();
  const running = new Set<Promise<void>>();
  let sequence = 0, buffer = "", writing = Promise.resolve();
  const send = (message: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(message) + "\n");
    writing = writing.then(async () => { let offset = 0; while (offset < bytes.length) offset += await Deno.stdout.write(bytes.subarray(offset)); });
    return writing;
  };
  const handler = createStoryMediaCleanupHandler(config, { fetch: (input, init = {}) => {
    const id = ++sequence;
    return new Promise<Response>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      void send({ type: "fetch", id, url: String(input), method: init.method, headers: Object.fromEntries(new Headers(init.headers)),
        redirect: init.redirect, credentials: init.credentials, body: init.body }).catch(reject);
    });
  } });
  await send({ type: "ready", runtime: Deno.version, network: "denied" });
  for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    if (buffer.length > 65536) throw new Error("Synthetic bridge input exceeded bound");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      if (message.type === "response") {
        const waiting = pending.get(message.id); pending.delete(message.id);
        if (!waiting) throw new Error("Unexpected synthetic response");
        if (message.error) waiting.reject(new Error("Synthetic transport failure"));
        else waiting.resolve(new Response(message.body ?? null, { status: message.status, headers: { "content-type": "application/json" } }));
      } else if (message.type === "invoke") {
        const work = (async () => {
          const response = await handler(new Request(origin + "/functions/v1/cleanup-story-media", { method: "POST",
            headers: { "content-type": "application/json", "x-story-media-cleanup-key": serviceKey, ...message.headers }, body: JSON.stringify(message.body) }));
          await send({ type: "result", id: message.id, status: response.status, body: await response.json() });
        })();
        running.add(work); void work.finally(() => running.delete(work));
      } else throw new Error("Unknown synthetic bridge operation");
    }
  }
  await Promise.all(running); await writing;
  if (pending.size || buffer) throw new Error("Incomplete synthetic bridge exchange");
}

if (Deno.args.length === 0) await verify();
else if (Deno.args.length === 1 && Deno.args[0] === "--bridge") await bridge();
else throw new Error("Only local checks or --bridge are supported; no endpoints or credentials accepted");