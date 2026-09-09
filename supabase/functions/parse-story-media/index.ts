import { createBinaryParser, technicalLimits, validateStoryBytes } from "../validate-story-media/index.ts";
import { createParserHandler } from "./handler.ts";
import { loadPackagedParser } from "./resource.ts";

if (import.meta.main) {
  const config = { enabled: Deno.env.get("STORY_MEDIA_PARSER_ENABLED") === "true", key: Deno.env.get("STORY_MEDIA_PARSER_KEY") || "" };
  let parser: Awaited<ReturnType<typeof createBinaryParser>> | undefined;
  let initializationError: string | undefined;
  if (config.enabled && /^[A-Za-z0-9_-]{43,128}$/.test(config.key)) {
    try { parser = await loadPackagedParser(); }
    catch (error) {
      const reason = error instanceof Error && /^parser_resource_(missing|oversized|mismatch)$/.test(error.message) ? error.message : "parser_initialization_unavailable";
      console.error("Story parser resource initialization failed: " + reason);
      initializationError = reason.startsWith("parser_resource_") ? reason.slice(7)
        : error instanceof Deno.errors.NotFound ? "filesystem_not_found"
        : error instanceof Deno.errors.PermissionDenied ? "filesystem_denied"
        : error instanceof Deno.errors.NotSupported ? "runtime_unsupported" : "initialization_failed";
    }
  }
  Deno.serve(createParserHandler({ ...config, enabled: config.enabled && !!parser, initializationError }, {
    inspect: (bytes, declaration, limits = technicalLimits) => {
      if (!parser) throw new Error("Parser not loaded");
      return validateStoryBytes(bytes, declaration, limits, parser);
    }
  }));
}