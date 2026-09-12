import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inputs, identity } from "./prepare-story-parser.cjs";

const [packageDirectory, fixtureDirectory] = Deno.args;
const root = fileURLToPath(new URL("../", import.meta.url));
assert.ok(packageDirectory?.startsWith(root + "dist/"));
assert.equal(await Deno.realPath(packageDirectory), packageDirectory);
assert.ok(fixtureDirectory?.startsWith(root + "dist/story-media/fixtures-"));
assert.match(fixtureDirectory, /\/fixtures-[A-Za-z0-9]+$/);
assert.equal(await Deno.realPath(fixtureDirectory), fixtureDirectory);
assert.equal((await Deno.permissions.query({ name: "net" })).state, "denied", "Network must be explicitly denied");
const packageEvidence = JSON.parse(await Deno.readTextFile(packageDirectory + "/package-evidence.json"));
assert.equal(packageEvidence.result, "prepared_not_deployed");
assert.equal(packageEvidence.sourceUnchanged, true);
assert.equal(packageEvidence.flagsEnabled, false);
assert.equal(packageEvidence.providerWrites, 0);
assert.deepEqual(Object.keys(packageEvidence.sourceHashes).sort(), [...inputs].sort());
assert.deepEqual(Object.keys(packageEvidence.packageHashes).sort(), [...inputs, "supabase/config.toml", "supabase/functions/parse-story-media/MediaInfo.LICENSE.txt"].sort());
const digest = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
for (const file of inputs) assert.equal(await digest(await Deno.readFile(root + file)), packageEvidence.sourceHashes[file], "Source changed: " + file);
for (const [file, hash] of Object.entries(packageEvidence.packageHashes)) {
  const absolute = packageDirectory + "/" + file;
  assert.equal(await Deno.realPath(absolute), absolute, "Package symlinks are not allowed");
  assert.equal(await digest(await Deno.readFile(absolute)), hash, "Package changed: " + file);
  if (file in packageEvidence.sourceHashes && !file.endsWith("/resource-data.ts") && !file.endsWith("/parser-module.js")) {
    assert.equal(hash, packageEvidence.sourceHashes[file], "Package differs from source: " + file);
  }
}
const parserPrefix = "supabase/functions/parse-story-media/";
assert.equal(packageEvidence.wasm.bytes, identity.wasm.bytes);
assert.equal(packageEvidence.wasm.sha256, identity.wasm.sha256);
assert.equal(packageEvidence.parserModuleSha256, identity.module.sha256);
assert.equal(packageEvidence.packageHashes[parserPrefix + "parser-module.js"], identity.module.sha256);
assert.equal(packageEvidence.packageHashes[parserPrefix + "MediaInfo.LICENSE.txt"], identity.license.sha256);
assert.equal(packageEvidence.packageHashes[parserPrefix + "resource-data.ts"], packageEvidence.payloadSha256);
assert.equal((await Deno.stat(packageDirectory + "/package-evidence.json")).mode! & 0o777, 0o600);
assert.match(await Deno.readTextFile(packageDirectory + "/supabase/functions/parse-story-media/MediaInfo.LICENSE.txt"), /Redistribution and use/);
assert.match(await Deno.readTextFile(packageDirectory + "/supabase/config.toml"), /\[functions\.parse-story-media\]\nverify_jwt = true/);
const packageUrl = pathToFileURL(packageDirectory + "/");
const { loadPackagedParser, unpackWasm, wasmIdentity } = await import(new URL(parserPrefix + "resource.ts", packageUrl).href);
const { createParserHandler } = await import(new URL(parserPrefix + "handler.ts", packageUrl).href);
const { parseInService, technicalLimits, validateStoryBytes } = await import(new URL("supabase/functions/validate-story-media/index.ts", packageUrl).href);
assert.deepEqual(wasmIdentity, identity.wasm);
const cases: { name: string; passed: boolean; errorType?: string }[] = [];
async function check(name: string, work: () => Promise<void>) {
  try { await work(); cases.push({ name, passed: true }); }
  catch (error) { cases.push({ name, passed: false, errorType: error instanceof Error ? error.name : "Unknown" }); }
}
const parser = await loadPackagedParser();
const key = "k".repeat(43);
const handler = createParserHandler({ enabled: true, key }, { inspect: (bytes: Uint8Array<ArrayBuffer>, declaration: Record<string, unknown>, limits: Record<string, number>) => validateStoryBytes(bytes, declaration, limits, parser) });
const network = ((url: string | URL | Request, options?: RequestInit) => handler(new Request(url, options))) as typeof fetch;
const config = { origin: "https://fixture.supabase.co", anonKey: "fixture-public", parserKey: key };
const mime: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", mp4: "video/mp4", webm: "video/webm" };
for (const filename of ["photo.jpg", "photo.png", "photo.webp", "clip.mp4", "clip.webm", "long.mp4", "fake-duration.mp4",
  "truncated-photo.jpg", "truncated-photo.png", "truncated-photo.webp", "truncated-clip.mp4", "truncated-clip.webm", "truncated-long.mp4", "clip-large.mp4"]) {
  const bytes = await Deno.readFile(fixtureDirectory + "/" + filename);
  const contentType = mime[filename.split(".").at(-1)!], kind = contentType.startsWith("image/") ? "photo" : "video";
  const valid = /^(photo|clip)\./.test(filename) || filename === "clip-large.mp4";
  await check(filename + (valid ? ": accepted" : ": rejected"), async () => {
    const inspect = () => parseInService(bytes, { kind, content_type: contentType, declared_bytes: bytes.length }, technicalLimits, config, undefined, 10000, network);
    if (!valid) { await assert.rejects(inspect, { code: "invalid_media", status: 422 }); return; }
    const parsed = await inspect();
    assert.equal(parsed.actual_bytes, bytes.length);
    assert.equal(parsed.width, 16); assert.equal(parsed.height, 16);
    assert.equal(parsed.duration_verified, kind === "video");
    assert.equal(parsed.duration_ms, kind === "video" ? 1000 : null);
    assert.equal(parsed.bytes, bytes);
  });
}
await check("Missing and corrupt packaged WASM fail closed", async () => {
  await assert.rejects(() => unpackWasm(""), /parser_resource_missing/);
  await assert.rejects(() => unpackWasm("eA=="));
});
const photo = await Deno.readFile(fixtureDirectory + "/photo.jpg");
await check("Caller-provided narrower pixel limits remain authoritative", async () => {
  await assert.rejects(() => parseInService(photo, { kind: "photo", content_type: "image/jpeg", declared_bytes: photo.length },
    { ...technicalLimits, max_pixels: 100 }, config, undefined, 10000, network), /invalid_media/);
});
await check("A following valid file succeeds after all rejected inputs", async () => {
  const result = await parseInService(photo, { kind: "photo", content_type: "image/jpeg", declared_bytes: photo.length }, technicalLimits, config, undefined, 10000, network);
  assert.equal(result.width, 16); assert.equal(result.height, 16);
});
parser.close();
for (const file of inputs) assert.equal(await digest(await Deno.readFile(root + file)), packageEvidence.sourceHashes[file], "Source changed during verification: " + file);
for (const [file, hash] of Object.entries(packageEvidence.packageHashes)) assert.equal(await digest(await Deno.readFile(packageDirectory + "/" + file)), hash, "Package changed during verification: " + file);
const failed = cases.filter(item => !item.passed).length;
console.log(JSON.stringify({ result: failed ? "failed" : "passed", cases, passed: cases.length - failed, failed,
  runtime: Deno.version, network: "denied", sourceUnchanged: true, packageUnchanged: true, packageHashes: packageEvidence.packageHashes,
  scope: "Actual local packaged parser, packaged service handler and packaged transport; not hosted CPU or wall-termination acceptance" }));
if (failed) Deno.exitCode = 1;