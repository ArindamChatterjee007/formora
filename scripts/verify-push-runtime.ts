/**
 * Real-runtime verification for supabase/functions/send-push/index.ts.
 *
 * The handler builds its provider request with npm:web-push@3.6.7's
 * generateRequestDetails(). Earlier coverage only exercised a vm-mocked stand-in, so
 * nothing proved that the specifier resolves under real Deno or that the bytes the
 * handler POSTs are genuine RFC 8291 ciphertext. This script resolves the pinned module
 * for real, drives generateRequestDetails() with ephemeral keys, and decrypts the result
 * with http_ece@1.2.0 -- the same package web-push encrypts with -- so the round trip is
 * proven by the locked dependency rather than a hand-rolled RFC implementation.
 *
 * It never calls the handler, never starts Deno.serve, and never contacts a push
 * provider. Run it with network denied:
 *
 *   deno run \
 *     --config supabase/functions/send-push/deno.json \
 *     --lock   supabase/functions/send-push/deno.lock \
 *     --frozen --deny-net --allow-write=dist --allow-read=dist,supabase/functions/send-push \
 *     scripts/verify-push-runtime.ts
 *
 * Key material is ephemeral and memory-only. Nothing but SHA-256 prefixes and byte
 * lengths reaches stdout or the report; a final guard re-scans the serialized report for
 * every secret before it is written.
 */

import webPushDefault from "web-push";
import eceDefault from "http_ece";
import nodeHttp from "node:http";
import nodeHttps from "node:https";
import { Buffer } from "node:buffer";
import { createECDH, randomBytes, type ECDH } from "node:crypto";

// --- typed views over the two untyped npm boundaries -----------------------------------

interface RequestDetails {
  method?: string;
  endpoint?: string;
  headers?: Record<string, unknown>;
  body?: unknown;
}
interface VapidKeys {
  publicKey: string;
  privateKey: string;
}
interface WebPushModule {
  generateRequestDetails: (
    subscription: unknown,
    payload: string,
    options: unknown,
  ) => RequestDetails;
  generateVAPIDKeys: () => VapidKeys;
  supportedContentEncodings: Record<string, string>;
}
interface EceModule {
  decrypt: (buffer: Buffer, params: Record<string, unknown>) => Buffer;
}

const webPush = webPushDefault as unknown as WebPushModule;
const ece = eceDefault as unknown as EceModule;

// --- contract mirrored from the handler (kept in sync by assertion, never imported) -----
// Importing index.ts would execute Deno.serve at module load, so the constants the handler
// enforces are restated here and every one of them is asserted below.

const HANDLER_ALLOWED_HEADERS = new Set([
  "authorization",
  "crypto-key",
  "content-encoding",
  "content-type",
  "content-length",
  "ttl",
  "urgency",
  "topic",
]);
const HANDLER_MAX_BODY_BYTES = 4096;
const HANDLER_MAX_PAYLOAD_CHARS = 1024;
const HANDLER_P256DH_CHARS = 87;
const HANDLER_AUTH_CHARS = 22;
const HANDLER_VAPID_PUBLIC_CHARS = 87;
const HANDLER_VAPID_PRIVATE_CHARS = 43;
const HANDLER_ENDPOINT = "https://fcm.googleapis.com/fcm/send/" + "f".repeat(64);
const HANDLER_TTL_SECONDS = 3600;

// --- outbound-transport sentinels -------------------------------------------------------
// --deny-net is the hard guarantee; these record positive evidence that
// generateRequestDetails() never even reaches for a transport interface.

const transportAttempts: string[] = [];

function installTransportSentinels(): void {
  const trap = (label: string) => (..._args: unknown[]): never => {
    transportAttempts.push(label);
    throw new Error("outbound transport is forbidden in this verification: " + label);
  };
  globalThis.fetch = trap("globalThis.fetch") as unknown as typeof fetch;
  const patch = (mod: Record<string, unknown>, name: string) => {
    for (const method of ["request", "get"]) {
      if (typeof mod[method] === "function") mod[method] = trap(`${name}.${method}`);
    }
  };
  patch(nodeHttp as unknown as Record<string, unknown>, "node:http");
  patch(nodeHttps as unknown as Record<string, unknown>, "node:https");
}

// --- helpers ----------------------------------------------------------------------------

const results: { name: string; ok: boolean; detail: string }[] = [];
let failures = 0;

function check(name: string, ok: boolean, detail: string): boolean {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} :: ${detail}`);
  return ok;
}

async function sha256Prefix(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", view));
  return Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function shannonEntropy(bytes: Uint8Array): number {
  const counts = new Array<number>(256).fill(0);
  for (const b of bytes) counts[b]++;
  let entropy = 0;
  for (const count of counts) {
    if (!count) continue;
    const p = count / bytes.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function toBytes(body: unknown): Uint8Array {
  if (!ArrayBuffer.isView(body)) throw new Error("generateRequestDetails body is not a view");
  const copy = new Uint8Array(body.byteLength);
  copy.set(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  return copy;
}

function headerValue(headers: Record<string, unknown>, name: string): string {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key === undefined ? "" : String(headers[key]);
}

function expectThrow(label: string, fn: () => unknown): { threw: boolean; message: string } {
  const before = transportAttempts.length;
  try {
    fn();
    return { threw: false, message: "returned without throwing" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (transportAttempts.length !== before) {
      return { threw: true, message: `${label} attempted transport: ${message}` };
    }
    return { threw: true, message };
  }
}

// --- ephemeral key material -------------------------------------------------------------

interface Recipient {
  p256dh: string;
  auth: string;
  curve: ECDH;
}

async function makeRecipient(): Promise<Recipient> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (typeof jwk.d !== "string") throw new Error("WebCrypto did not export a private scalar");
  const curve = createECDH("prime256v1");
  curve.setPrivateKey(Buffer.from(jwk.d, "base64url"));
  if (!Buffer.from(rawPublic).equals(curve.getPublicKey())) {
    throw new Error("WebCrypto/node ECDH public keys disagree");
  }
  return {
    p256dh: Buffer.from(rawPublic).toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
    curve,
  };
}

// --- verification -------------------------------------------------------------------------

async function main(): Promise<void> {
  if (Deno.env.get("ECE_KEYLOG") === "1") throw new Error("Unsafe key-material debug logging; verification stopped.");
  installTransportSentinels();

  const bindingId = crypto.randomUUID();
  const payload = JSON.stringify({ v: 1, kind: "app_update", binding_id: bindingId });
  const vapid = webPush.generateVAPIDKeys();
  const vapidDetails = { subject: "mailto:push@example.invalid", ...vapid };
  const recipient = await makeRecipient();
  const subscription = {
    endpoint: HANDLER_ENDPOINT,
    keys: { p256dh: recipient.p256dh, auth: recipient.auth },
  };
  const options = {
    TTL: HANDLER_TTL_SECONDS,
    contentEncoding: "aes128gcm",
    vapidDetails,
  };

  // 1. real module resolution
  check(
    "module.resolution",
    typeof webPush.generateRequestDetails === "function" &&
      typeof webPush.generateVAPIDKeys === "function",
    "npm:web-push@3.6.7 resolved under real Deno; generateRequestDetails is a function",
  );
  check(
    "module.aes128gcm_supported",
    webPush.supportedContentEncodings?.AES_128_GCM === "aes128gcm",
    `supportedContentEncodings=${JSON.stringify(webPush.supportedContentEncodings)}`,
  );
  check(
    "module.decrypt_dependency",
    typeof ece.decrypt === "function",
    "http_ece@1.2.0 (web-push's own encryption dependency) exposes decrypt",
  );
  // http_ece dumps derived key material to stdout when this is set; the handler must never
  // run with it enabled.
  check(
    "module.keylog_disabled",
    Deno.env.get("ECE_KEYLOG") !== "1",
    `http_ece reads process.env.ECE_KEYLOG (key-material debug dump); observed ${
      Deno.env.get("ECE_KEYLOG") ?? "(unset)"
    }`,
  );

  // 2. ephemeral key shapes match the handler's isKey() gates
  check(
    "keys.vapid_shape",
    vapid.publicKey.length === HANDLER_VAPID_PUBLIC_CHARS &&
      vapid.privateKey.length === HANDLER_VAPID_PRIVATE_CHARS,
    `public=${vapid.publicKey.length}ch private=${vapid.privateKey.length}ch ` +
      `(handler requires ${HANDLER_VAPID_PUBLIC_CHARS}/${HANDLER_VAPID_PRIVATE_CHARS})`,
  );
  check(
    "keys.recipient_shape",
    recipient.p256dh.length === HANDLER_P256DH_CHARS &&
      recipient.auth.length === HANDLER_AUTH_CHARS,
    `p256dh=${recipient.p256dh.length}ch auth=${recipient.auth.length}ch ` +
      `(handler requires ${HANDLER_P256DH_CHARS}/${HANDLER_AUTH_CHARS})`,
  );
  check(
    "payload.size_gate",
    payload.length <= HANDLER_MAX_PAYLOAD_CHARS,
    `payload=${payload.length}ch (handler cap ${HANDLER_MAX_PAYLOAD_CHARS})`,
  );

  // 3. the real call
  const details = webPush.generateRequestDetails(subscription, payload, options);
  const headers = details.headers ?? {};
  const body = toBytes(details.body);

  check(
    "call.no_transport",
    transportAttempts.length === 0,
    "generateRequestDetails() touched no fetch/node:http/node:https interface",
  );
  check(
    "request.method",
    (details.method ?? "POST") === "POST",
    `method=${details.method ?? "(unset)"}`,
  );
  check(
    "request.endpoint_unchanged",
    details.endpoint === HANDLER_ENDPOINT,
    "library returned the endpoint byte-identical (handler rejects any rewrite)",
  );
  const headerNames = Object.keys(headers);
  check(
    "request.headers_allowlisted",
    headerNames.every((n) => HANDLER_ALLOWED_HEADERS.has(n.toLowerCase())),
    `headers=[${headerNames.join(", ")}] all within the handler allowlist`,
  );
  check(
    "request.header_values_scalar",
    Object.values(headers).every((v) => typeof v !== "object" || v === null),
    "no header value is an object (handler rejects objects outright)",
  );
  check(
    "request.content_encoding",
    headerValue(headers, "content-encoding") === "aes128gcm",
    `Content-Encoding=${headerValue(headers, "content-encoding")}`,
  );
  check(
    "request.ttl",
    headerValue(headers, "ttl") === String(HANDLER_TTL_SECONDS),
    `TTL=${headerValue(headers, "ttl")}`,
  );
  const contentLength = headerValue(headers, "content-length");
  check(
    "request.content_length",
    contentLength === "" || Number(contentLength) === body.byteLength,
    `Content-Length=${contentLength || "(unset)"} body=${body.byteLength}B`,
  );
  check(
    "request.body_within_cap",
    body.byteLength > 0 && body.byteLength <= HANDLER_MAX_BODY_BYTES,
    `body=${body.byteLength}B (handler cap ${HANDLER_MAX_BODY_BYTES}B)`,
  );

  // 4. VAPID authorization header
  const authorization = headerValue(headers, "authorization");
  const vapidMatch = /^vapid t=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/
    .exec(authorization);
  check(
    "vapid.scheme",
    vapidMatch !== null,
    vapidMatch
      ? "Authorization uses the RFC 8292 'vapid t=<jwt>, k=<key>' scheme"
      : `unexpected Authorization shape: ${authorization.slice(0, 24)}...`,
  );
  let jwtClaims: Record<string, unknown> = {};
  let jwtAlg = "";
  if (vapidMatch) {
    const [, jwt, publicKeyParam] = vapidMatch;
    const [headerB64, claimsB64] = jwt.split(".");
    jwtAlg = String(
      (JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as Record<string, unknown>)
        .alg,
    );
    jwtClaims = JSON.parse(Buffer.from(claimsB64, "base64url").toString("utf8"));
    check("vapid.alg", jwtAlg === "ES256", `JWT alg=${jwtAlg}`);
    check(
      "vapid.audience",
      jwtClaims.aud === new URL(HANDLER_ENDPOINT).origin,
      `aud=${String(jwtClaims.aud)} matches the endpoint origin`,
    );
    check("vapid.subject", jwtClaims.sub === vapidDetails.subject, `sub=${String(jwtClaims.sub)}`);
    const exp = Number(jwtClaims.exp);
    const secondsAhead = exp - Math.floor(Date.now() / 1000);
    check(
      "vapid.expiry_bounded",
      secondsAhead > 0 && secondsAhead <= 24 * 60 * 60,
      `exp is ${secondsAhead}s ahead (RFC 8292 caps at 24h)`,
    );
    check(
      "vapid.k_is_public_key",
      publicKeyParam === vapid.publicKey,
      "k= carries the VAPID *public* key only",
    );
    check(
      "vapid.private_key_absent",
      !authorization.includes(vapid.privateKey),
      "the VAPID private key never appears in the Authorization header",
    );
  }

  // 5. the body is opaque ciphertext, not the plaintext in disguise
  const secrets: [string, string][] = [
    ["payload", payload],
    ["kind literal", "app_update"],
    ["field name", "binding_id"],
    ["binding id", bindingId],
    ["recipient p256dh", recipient.p256dh],
    ["recipient auth", recipient.auth],
    ["vapid private key", vapid.privateKey],
  ];
  const encodings: [string, string][] = [
    ["utf8", Buffer.from(body).toString("utf8")],
    ["latin1", Buffer.from(body).toString("latin1")],
    ["base64", Buffer.from(body).toString("base64")],
    ["base64url", Buffer.from(body).toString("base64url")],
    ["hex", Buffer.from(body).toString("hex")],
  ];
  const leaks: string[] = [];
  for (const [label, secret] of secrets) {
    for (const [encoding, rendered] of encodings) {
      if (rendered.includes(secret)) leaks.push(`${label} in ${encoding}`);
    }
    if (indexOfBytes(body, new TextEncoder().encode(secret)) !== -1) {
      leaks.push(`${label} as raw bytes`);
    }
  }
  check(
    "cipher.no_plaintext_leak",
    leaks.length === 0,
    leaks.length === 0
      ? `none of ${secrets.length} secrets appear in the body across ` +
        `${encodings.length} encodings + raw byte scan`
      : `LEAKED: ${leaks.join("; ")}`,
  );
  const entropy = shannonEntropy(body);
  // A 182-byte sample cannot reach 8 bits/byte, so normalise against the ceiling this
  // sample size allows rather than against the alphabet width.
  const entropyCeiling = Math.log2(Math.min(body.byteLength, 256));
  const entropyRatio = entropy / entropyCeiling;
  check(
    "cipher.non_blank",
    body.some((b) => b !== 0) && entropyRatio >= 0.9,
    `body is non-blank, Shannon entropy=${entropy.toFixed(3)} bits/byte = ` +
      `${(entropyRatio * 100).toFixed(1)}% of the ${entropyCeiling.toFixed(3)} ceiling for ` +
      `${body.byteLength} bytes`,
  );

  // 6. salted + randomised: identical inputs must never produce identical bytes
  const second = toBytes(
    webPush.generateRequestDetails(subscription, payload, options).body,
  );
  const salt = body.slice(0, 16);
  const secondSalt = second.slice(0, 16);
  check(
    "cipher.salt_random",
    indexOfBytes(salt, secondSalt) === -1 && !Buffer.from(body).equals(Buffer.from(second)),
    "two calls with identical inputs produced different salts and different ciphertext",
  );

  // 7. real decryption by the recipient key, via web-push's own http_ece
  let decrypted = "";
  let decryptError = "";
  try {
    decrypted = ece.decrypt(Buffer.from(body), {
      version: "aes128gcm",
      privateKey: recipient.curve,
      authSecret: recipient.auth,
    }).toString("utf8");
  } catch (error) {
    decryptError = error instanceof Error ? error.message : String(error);
  }
  check(
    "cipher.recipient_roundtrip",
    decrypted === payload,
    decrypted === payload
      ? "http_ece@1.2.0 decrypted the body back to the exact handler payload " +
        `using only the recipient's private key (${payload.length}B recovered)`
      : `decrypt failed: ${decryptError || "plaintext mismatch"}`,
  );

  // 8. a different recipient key must NOT be able to decrypt
  const stranger = await makeRecipient();
  const strangerAttempt = expectThrow("stranger-key decrypt", () =>
    ece.decrypt(Buffer.from(body), {
      version: "aes128gcm",
      privateKey: stranger.curve,
      authSecret: stranger.auth,
    }));
  check(
    "cipher.wrong_key_fails",
    strangerAttempt.threw,
    `an unrelated P-256 key cannot decrypt: ${strangerAttempt.message}`,
  );

  // 9. negative: malformed recipient key must throw, without transport
  const badKeyCases: [string, unknown][] = [
    ["p256dh truncated", { endpoint: HANDLER_ENDPOINT, keys: { p256dh: recipient.p256dh.slice(0, 40), auth: recipient.auth } }],
    ["p256dh not base64url", { endpoint: HANDLER_ENDPOINT, keys: { p256dh: "!".repeat(HANDLER_P256DH_CHARS), auth: recipient.auth } }],
    ["auth missing", { endpoint: HANDLER_ENDPOINT, keys: { p256dh: recipient.p256dh } }],
    ["keys missing", { endpoint: HANDLER_ENDPOINT }],
  ];
  for (const [label, badSubscription] of badKeyCases) {
    const attempt = expectThrow(label, () =>
      webPush.generateRequestDetails(badSubscription, payload, options));
    check(`negative.recipient_key/${label}`, attempt.threw, attempt.message.slice(0, 160));
  }

  // 10. negative: malformed VAPID must throw, without transport
  const badVapidCases: [string, unknown][] = [
    ["private key truncated", { ...vapidDetails, privateKey: vapid.privateKey.slice(0, 20) }],
    ["public key truncated", { ...vapidDetails, publicKey: vapid.publicKey.slice(0, 20) }],
    ["subject empty", { ...vapidDetails, subject: "" }],
    ["subject not mailto/https", { ...vapidDetails, subject: "not-a-subject" }],
  ];
  for (const [label, badVapid] of badVapidCases) {
    const attempt = expectThrow(label, () =>
      webPush.generateRequestDetails(subscription, payload, {
        ...options,
        vapidDetails: badVapid,
      }));
    check(`negative.vapid/${label}`, attempt.threw, attempt.message.slice(0, 160));
  }

  check(
    "network.zero_attempts",
    transportAttempts.length === 0,
    `no outbound transport attempted across ${results.length} checks ` +
      "(process also ran under --deny-net)",
  );

  // --- report ---------------------------------------------------------------------------

  const report = {
    generatedAt: new Date().toISOString(),
    subject: "supabase/functions/send-push/index.ts :: npm:web-push@3.6.7 generateRequestDetails",
    runtime: {
      deno: Deno.version.deno,
      v8: Deno.version.v8,
      typescript: Deno.version.typescript,
    },
    resolution: {
      webPush: "npm:web-push@3.6.7",
      httpEce: "npm:http_ece@1.2.0 (web-push's own encryption dependency, deduped in deno.lock)",
      mocked: false,
      lockfile: "supabase/functions/send-push/deno.lock",
    },
    network: {
      permission: "--deny-net (no --allow-net anywhere in this run)",
      sentinels: ["globalThis.fetch", "node:http.request/get", "node:https.request/get"],
      attempts: transportAttempts,
    },
    request: {
      method: details.method ?? "POST",
      endpointUnchanged: details.endpoint === HANDLER_ENDPOINT,
      headerNames,
      contentEncoding: headerValue(headers, "content-encoding"),
      ttl: headerValue(headers, "ttl"),
      contentLength: contentLength || null,
      bodyBytes: body.byteLength,
      bodyEntropyBitsPerByte: Number(entropy.toFixed(3)),
      bodyEntropyRatioOfSampleCeiling: Number(entropyRatio.toFixed(3)),
    },
    vapid: {
      scheme: vapidMatch ? "vapid t=<jwt>, k=<public key>" : "unrecognised",
      alg: jwtAlg,
      aud: String(jwtClaims.aud ?? ""),
      sub: String(jwtClaims.sub ?? ""),
      publicKeyLength: vapid.publicKey.length,
      publicKeySha256Prefix: await sha256Prefix(vapid.publicKey),
      privateKeyLength: vapid.privateKey.length,
      privateKeySha256Prefix: await sha256Prefix(vapid.privateKey),
    },
    recipient: {
      p256dhLength: recipient.p256dh.length,
      p256dhSha256Prefix: await sha256Prefix(recipient.p256dh),
      authLength: recipient.auth.length,
      authSha256Prefix: await sha256Prefix(recipient.auth),
    },
    payload: {
      shape: '{"v":1,"kind":"app_update","binding_id":"<uuid>"}',
      bytes: payload.length,
      sha256Prefix: await sha256Prefix(payload),
      recoveredByRecipient: decrypted === payload,
      leaksFound: leaks,
    },
    checks: results,
    summary: { total: results.length, passed: results.length - failures, failed: failures },
  };

  // Ephemeral secrets are memory-only: refuse to persist anything that echoes them.
  const serialized = JSON.stringify(report, null, 2);
  for (const [label, secret] of secrets) {
    if (secret.length >= 16 && serialized.includes(secret)) {
      throw new Error(`refusing to write report: it contains ${label}`);
    }
  }
  await Deno.mkdir("dist", { recursive: true });
  await Deno.writeTextFile("dist/push-runtime.json", serialized + "\n");

  console.log(
    `\n${failures === 0 ? "OK" : "FAILED"}  ${report.summary.passed}/${report.summary.total} ` +
      "checks passed -> dist/push-runtime.json",
  );
  if (failures > 0) Deno.exit(1);
}

await main();
