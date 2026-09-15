import { bounded, MediaFailure, readBounded, technicalLimits, validateStoryBytes } from "../validate-story-media/index.ts";
import type { Declaration, MediaLimits } from "../validate-story-media/index.ts";

type Inspection = Awaited<ReturnType<typeof validateStoryBytes>>;
type Configuration = { enabled: boolean; key: string; initializationError?: string };
type Dependencies = { inspect: (bytes: Uint8Array<ArrayBuffer>, declaration: Declaration, limits: MediaLimits) => Promise<Inspection>; now?: () => number };

export function createParserHandler(config: Configuration, dependencies: Dependencies) {
  const now = dependencies.now || (() => performance.now());
  let active = false;
  const response = (status: number, value: unknown) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  return async (request: Request) => {
    const reject = (status: number, error: string) => { request.body?.cancel().catch(() => {}); return response(status, { error }); };
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(config.key)) return reject(503, "parser_disabled");
    const supplied = request.headers.get("x-story-parser-key") || "";
    let difference = supplied.length ^ config.key.length;
    for (let index = 0; index < config.key.length; index++) difference |= (supplied.charCodeAt(index) || 0) ^ config.key.charCodeAt(index);
    if (difference || request.headers.has("origin")) return reject(403, "parser_denied");
    if (!config.enabled) {
      request.body?.cancel().catch(() => {});
      const reason = ["resource_missing", "resource_oversized", "resource_mismatch", "filesystem_not_found", "filesystem_denied", "runtime_unsupported", "initialization_failed"].includes(config.initializationError || "") ? config.initializationError : undefined;
      return response(503, { error: "parser_disabled", ...(reason ? { reason } : {}) });
    }
    if (request.method !== "POST") return reject(405, "post_required");
    const requestId = request.headers.get("x-story-parser-request") || "";
    const durationText = request.headers.get("x-story-parser-timeout-ms") || "";
    const duration = Number(durationText), started = now(), deadline = started + duration;
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId)
      || !/^[1-9][0-9]{0,4}$/.test(durationText)) return reject(400, "invalid_parser_request");
    if (duration > 10000) return reject(400, "invalid_parser_request");
    const contentType = request.headers.get("content-type") || "";
    const formats: Record<string, string> = { "image/jpeg": "photo", "image/png": "photo", "image/webp": "photo", "video/mp4": "video", "video/webm": "video" };
    const kind = formats[contentType], lengthText = request.headers.get("content-length") || "";
    const length = Number(lengthText);
    if (!kind || !/^[1-9][0-9]{0,7}$/.test(lengthText) || length > (kind === "photo" ? technicalLimits.photo_bytes : technicalLimits.video_bytes)
      || request.headers.has("content-encoding")) return reject(413, "invalid_parser_body");
    let limits: MediaLimits;
    try {
      const header = request.headers.get("x-story-parser-limits") || "";
      if (header.length > 256) throw new Error("limits");
      limits = JSON.parse(header);
      const keys = Object.keys(technicalLimits) as (keyof MediaLimits)[];
      if (!limits || Array.isArray(limits) || Object.keys(limits).length !== keys.length
        || keys.some(key => !Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > technicalLimits[key])) throw new Error("limits");
      if (length > (kind === "photo" ? limits.photo_bytes : limits.video_bytes)) throw new Error("limits");
    } catch { return reject(400, "invalid_parser_limits"); }
    if (active) return reject(429, "parser_busy");
    active = true;
    let inspection: Promise<Inspection> | undefined;
    try {
      return await bounded(async signal => {
        const bytes = await readBounded(request, length, signal, length);
        if (signal.aborted || now() >= deadline) throw new MediaFailure("validation_timeout", 504);
        inspection = dependencies.inspect(bytes, { kind, content_type: contentType, declared_bytes: length }, limits);
        const result = await inspection;
        if (signal.aborted || now() >= deadline) throw new MediaFailure("validation_timeout", 504);
        if (JSON.stringify(result).length > 1536) throw new MediaFailure("storage_unavailable", 503);
        return response(200, { request_id: requestId, actual_bytes: result.actual_bytes, content_type: result.content_type,
          width: result.width, height: result.height, duration_ms: result.duration_ms, duration_verified: result.duration_verified,
          parser: result.parser, library: result.library, sha256: result.sha256 });
      }, Math.max(1, deadline - now()), request.signal);
    } catch (error) {
      const known = error instanceof MediaFailure && ["invalid_media", "size_mismatch", "validation_timeout"].includes(error.code);
      return response(known ? error.status : 503, { error: known ? error.code : "storage_unavailable" });
    } finally {
      if (inspection) inspection.then(() => { active = false; }, () => { active = false; });
      else active = false;
    }
  };
}