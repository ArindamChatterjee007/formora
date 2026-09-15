import { loadPackagedParser } from "../supabase/functions/parse-story-media/resource.ts";
import { MediaFailure, readBounded, technicalLimits, validateStoryBytes } from "../supabase/functions/validate-story-media/index.ts";
import type { Declaration, MediaLimits } from "../supabase/functions/validate-story-media/index.ts";

let bytes: Uint8Array<ArrayBuffer> | undefined;
let parser: Awaited<ReturnType<typeof loadPackagedParser>> | undefined;
let output: Record<string, unknown>;
let phase = "permissions";
try {
  for (const name of ["read", "write", "net", "run", "ffi", "sys"] as const) {
    if ((await Deno.permissions.query({ name })).state !== "denied") throw new Error("permissions_required");
  }
  phase = "environment";
  const environment = Deno.env.toObject();
  if (Object.keys(environment).some(name => !["LANG", "NO_COLOR", "DENO_DIR", "__CF_USER_TEXT_ENCODING",
    "DENO_NODE_SHIM_ACTIVE", "PATH"].includes(name))) {
    throw new Error("unexpected_environment");
  }
  phase = "request";
  if (Deno.args.length !== 1 || Deno.args[0].length > 768) throw new Error("invalid_request");
  const request = JSON.parse(Deno.args[0]);
  if (!request || Object.keys(request).sort().join(",") !== "declaration,limits,request_id"
    || typeof request.request_id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request.request_id)) {
    throw new Error("invalid_request");
  }
  const declaration = request.declaration as Declaration, limits = request.limits as MediaLimits;
  if (!declaration || Object.keys(declaration).sort().join(",") !== "content_type,declared_bytes,kind"
    || !limits || Object.keys(limits).sort().join(",") !== Object.keys(technicalLimits).sort().join(",")
    || !Number.isSafeInteger(declaration.declared_bytes) || declaration.declared_bytes < 1
    || declaration.declared_bytes > technicalLimits.video_bytes) throw new Error("invalid_request");
  phase = "input";
  bytes = await readBounded(new Response(Deno.stdin.readable, { headers: { "Content-Length": String(declaration.declared_bytes) } }), declaration.declared_bytes,
    new AbortController().signal, declaration.declared_bytes);
  phase = "resource";
  parser = await loadPackagedParser();
  phase = "inspection";
  const result = await validateStoryBytes(bytes, declaration, limits, parser);
  output = { request_id: request.request_id, actual_bytes: result.actual_bytes, content_type: result.content_type,
    width: result.width, height: result.height, duration_ms: result.duration_ms, duration_verified: result.duration_verified,
    parser: result.parser, library: result.library, sha256: result.sha256 };
} catch (error) {
  const known = error instanceof MediaFailure && ["invalid_media", "size_mismatch"].includes(error.code);
  output = { error: known ? error.code : "parser_unavailable", phase };
  Deno.exitCode = 1;
} finally {
  bytes?.fill(0);
  parser?.close();
}
const encoded = new TextEncoder().encode(JSON.stringify(output));
if (encoded.length > 2048) throw new Error("invalid_output");
let written = 0;
while (written < encoded.length) {
  const count = await Deno.stdout.write(encoded.subarray(written));
  if (count < 1) throw new Error("output_unavailable");
  written += count;
}