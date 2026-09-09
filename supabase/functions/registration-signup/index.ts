type SignupConfig = { enabled: boolean; origin: string; anonKey: string };
type Json = Record<string, unknown>;
type Options = { fetch?: typeof fetch; deadlineMs?: number };
const backend = "https://wospznckvryiihfzwwtn.supabase.co";
const site = "https://formora-qat.pages.dev";
const proofKeys = ["registration_consent_proof", "registration_consent_binding"];
const object = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function signupConfiguration(read = (name: string) => Deno.env.get(name)): SignupConfig {
  return { enabled: read("REGISTRATION_SIGNUP_ENABLED") === "true", origin: read("SUPABASE_URL") || "",
    anonKey: read("SUPABASE_ANON_KEY") || "" };
}

async function readJson(source: Request | Response, maximum: number, signal: AbortSignal): Promise<unknown> {
  if (!source.body) throw new Error("missing_body");
  const reader = source.body.getReader(), chunks: Uint8Array[] = [];
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  let length = 0;
  try {
    for (let reads = 0; ; reads++) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (reads >= 128 || length > maximum) throw new Error("oversized_body");
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { signal.removeEventListener("abort", cancel); cancel(); }
}

function tokenClaims(token: unknown): Json | null {
  if (typeof token !== "string" || token.length > 16384) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return null;
  try {
    const decoded = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(decoded, character => character.charCodeAt(0))));
    return object(value) ? value : null;
  } catch { return null; }
}

function safeUser(user: Json): Json {
  const result: Json = { id: user.id, email: user.email };
  for (const key of ["email_confirmed_at", "confirmed_at", "confirmation_sent_at"]) {
    if (typeof user[key] === "string" && Number.isFinite(Date.parse(user[key] as string))) result[key] = user[key];
  }
  if (object(user.user_metadata) && typeof user.user_metadata.name === "string") {
    result.user_metadata = { name: user.user_metadata.name };
  }
  return result;
}

function containsProof(value: unknown, submitted: Json): boolean {
  const text = JSON.stringify(value);
  return proofKeys.some(key => text.includes('"' + key + '"')
    || typeof submitted[key] === "string" && (submitted[key] as string).length > 0 && text.includes(submitted[key] as string));
}

export function createRegistrationSignupHandler(input: SignupConfig, options: Options = {}) {
  const config = Object.freeze({ ...input }), fetcher = options.fetch || globalThis.fetch;
  return async (request: Request): Promise<Response> => {
    const headers: Record<string, string> = { "cache-control": "no-store", "x-content-type-options": "nosniff", vary: "Origin" };
    const allowed = request.headers.get("origin") === site;
    if (allowed) Object.assign(headers, { "access-control-allow-origin": site,
      "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "apikey, authorization, content-type" });
    const reply = (body: unknown, status: number) => Response.json(body, { status, headers });
    if (!config.enabled || config.origin !== backend || !config.anonKey) return reply({ error: "signup_adapter_disabled" }, 503);
    if (!allowed) return reply({ error: "signup_origin_denied" }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST" || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
      || new URL(request.url).search || ![null, "identity"].includes(request.headers.get("content-encoding"))) {
      return reply({ error: "invalid_signup_request" }, 400);
    }
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), Math.min(15000, Math.max(1, options.deadlineMs || 15000)));
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const interrupted = new Promise<never>((_resolve, reject) => {
      if (controller.signal.aborted) reject(new Error("signup_cancelled"));
      else controller.signal.addEventListener("abort", () => reject(new Error("signup_cancelled")), { once: true });
    });
    void interrupted.catch(() => {});
    const current = () => { if (controller.signal.aborted) throw new Error("signup_cancelled"); };
    const bounded = <Value>(work: () => Promise<Value>) => Promise.race([work(), interrupted]);
    let submitted = false;
    async function auth(route: string, body: Json) {
      current();
      submitted = true;
      const response = await bounded(() => fetcher(backend + "/auth/v1" + route, { method: "POST", redirect: "error",
        signal: controller.signal, headers: { apikey: config.anonKey, "content-type": "application/json" }, body: JSON.stringify(body) }));
      current();
      if (response.redirected || response.status >= 300 && response.status < 400) throw new Error("auth_redirect");
      const data = await bounded(() => readJson(response, 131072, controller.signal));
      current();
      return { status: response.status, ok: response.ok, data };
    }
    try {
      const body = await bounded(() => readJson(request, 16384, controller.signal));
      current();
      if (!object(body) || Object.keys(body).some(key => !["email", "password", "data"].includes(key))
        || typeof body.email !== "string" || body.email.length > 320 || !body.email.trim()
        || typeof body.password !== "string" || !body.password || body.password.length > 1024
        || !object(body.data) || Object.keys(body.data).some(key => !["name", ...proofKeys].includes(key))
        || typeof body.data.name !== "string" || body.data.name.length > 120) return reply({ error: "invalid_signup_request" }, 400);
      const email = body.email.trim(), data = body.data, metadata: Json = { name: data.name };
      if (proofKeys.every(key => typeof data[key] === "string" && /^[a-f0-9]{64}$/.test(data[key] as string))) {
        for (const key of proofKeys) metadata[key] = data[key];
      }
      const created = await auth("/signup", { email, password: body.password, data: metadata });
      if (!created.ok) return reply({ error: "Sign-up could not be completed. Try signing in or resetting your password." },
        [400, 401, 422, 429].includes(created.status) ? created.status : 503);
      const signup = created.data, user = object(signup) && (object(signup.user) ? signup.user : signup);
      if (!object(signup) || !object(user) || !uuid.test(String(user.id)) || String(user.email).toLowerCase() !== email.toLowerCase()) {
        throw new Error("invalid_signup_identity");
      }
      if (!signup.access_token && !signup.refresh_token && !signup.session && !user.email_confirmed_at && !user.confirmed_at
        && typeof user.confirmation_sent_at === "string" && Number.isFinite(Date.parse(user.confirmation_sent_at))) {
        const projected = safeUser(user);
        if (containsProof(projected, metadata)) throw new Error("unsafe_confirmation");
        return reply(projected, 200);
      }
      if (typeof signup.refresh_token !== "string" || !signup.refresh_token || signup.refresh_token.length > 4096) throw new Error("missing_session");
      const refreshed = await auth("/token?grant_type=refresh_token", { refresh_token: signup.refresh_token });
      const session = refreshed.data;
      if (!refreshed.ok || !object(session) || !object(session.user) || session.user.id !== user.id
        || String(session.user.email).toLowerCase() !== email.toLowerCase()
        || typeof session.refresh_token !== "string" || !session.refresh_token || session.refresh_token.length > 4096
        || typeof session.expires_in !== "number" || !Number.isFinite(session.expires_in) || session.expires_in <= 0) throw new Error("invalid_refreshed_session");
      const claims = tokenClaims(session.access_token);
      if (!claims || claims.sub !== user.id || claims.aud !== "authenticated" || typeof claims.exp !== "number"
        || claims.exp <= Date.now() / 1000 || containsProof(claims, metadata) || containsProof(session.user, metadata)) throw new Error("unsafe_session");
      const result = { access_token: session.access_token, refresh_token: session.refresh_token, expires_in: session.expires_in,
        token_type: "bearer", user: safeUser(session.user) };
      if (containsProof(result, metadata)) throw new Error("unsafe_response");
      return reply(result, 200);
    } catch {
      if (!submitted && !controller.signal.aborted) return reply({ error: "invalid_signup_request" }, 400);
      return reply({ error: "Sign-up could not be confirmed. Try signing in before registering again." }, 503);
    } finally {
      clearTimeout(deadline);
      request.signal.removeEventListener("abort", abort);
    }
  };
}

if (import.meta.main) Deno.serve(createRegistrationSignupHandler(signupConfiguration()));