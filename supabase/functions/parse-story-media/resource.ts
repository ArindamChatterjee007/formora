import encoded from "./resource-data.ts";
import factory from "./parser-module.js";
import identity from "./identity.json" with { type: "json" };
import type { createBinaryParser } from "../validate-story-media/index.ts";

export const wasmIdentity = Object.freeze(identity.wasm);

export async function unpackWasm(value: string) {
  if (!value || value.length > 1500000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("parser_resource_missing");
  const compressed = Uint8Array.from(atob(value), character => character.charCodeAt(0));
  if (compressed.length > 1048576) throw new Error("parser_resource_oversized");
  const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const bytes = new Uint8Array(wasmIdentity.bytes);
  let total = 0, chunks = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (++chunks > 512 || total + chunk.value.length > bytes.length) throw new Error("parser_resource_oversized");
      bytes.set(chunk.value, total); total += chunk.value.length;
    }
  } finally { await reader.cancel(); }
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
  if (total !== bytes.length || hash !== wasmIdentity.sha256) throw new Error("parser_resource_mismatch");
  return bytes;
}

export async function loadPackagedParser() {
  const bytes = await unpackWasm(encoded);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/wasm" }));
  try {
    const load = factory as unknown as (options: { format: "object"; chunkSize: number; locateFile: () => string }) => ReturnType<typeof createBinaryParser>;
    return await load({ format: "object", chunkSize: 65536, locateFile: () => url });
  } finally { URL.revokeObjectURL(url); }
}