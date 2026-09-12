(function (root) {
  "use strict";
  const LIMITS = Object.freeze({ requestBytes: 2048, responseBytes: 131072, archiveBytes: 8388608, chunkBytes: 32768, pageSize: 25, operationMs: 30000 });
  const SCOPES = Object.freeze({ export: "account_profile_logs_v1", erasure: "account_erasure_review_v1" });
  const EXPORT_SCOPES = Object.freeze({
    account_profile_logs_v1: Object.freeze({ requestVersion: 1, archiveVersion: 1, label: "Saved profile and logs (v1)" }),
    account_server_personal_v2: Object.freeze({ requestVersion: 2, archiveVersion: 2, label: "Known server personal records (v2)" })
  });
  const STATUS = Object.freeze({ received: "Request received", under_review: "Under review", authorized: "Preparation authorized, not deletion",
    held: "On hold", cancelled: "Cancelled", superseded: "Replaced by another request", export_ready: "Export ready", export_released: "Cached export removed" });
  const TERMINAL = ["cancelled", "superseded", "export_released"];
  const ACTIONS = ["received", "cancelled", "export_ready", "release_export", "review", "authorize", "hold", "release_hold", "supersede"];
  const RECEIPT_KEYS = ["id", "request_id", "requester", "kind", "scope", "status", "version", "created_at", "updated_at", "cancel_allowed", "account_deleted", "execution_allowed",
    "snapshot_status", "release_allowed", "hold_status", "hold_version"];
  const EXPORT_KEYS = ["schema_version", "request_ref", "requester", "generated_at", "total_bytes", "sha256", "max_chunk_bytes", "operation_id", "operation_status", "receipt"];
  const RPCS = new Set(["submit_account_rights_request", "my_account_rights_request", "my_account_rights_requests", "cancel_account_rights_request",
    "my_account_rights_history", "prepare_account_rights_export", "read_account_rights_export", "release_my_account_rights_export"]);
  const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  const date = value => typeof value === "string" && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
  function failure(code, message, status) { const error = new Error(message); error.code = code; error.accountRightsFailure = true; if (status) error.status = status; return error; }
  function unexpected() { return failure("invalid_response", "The server response could not be verified. Retry or contact support."); }
  function receipt(value, owner) {
    if (!exactKeys(value, RECEIPT_KEYS) || !uuid(value.id) || !uuid(value.request_id) || value.requester !== owner
      || !Object.hasOwn(SCOPES, value.kind) || (value.kind === "export" ? !Object.hasOwn(EXPORT_SCOPES, value.scope) : value.scope !== SCOPES.erasure)
      || !Object.hasOwn(STATUS, value.status)
      || !Number.isSafeInteger(value.version) || value.version < 1 || !date(value.created_at) || !date(value.updated_at)
      || Date.parse(value.updated_at) < Date.parse(value.created_at)
      || !["clear", "held", "unknown"].includes(value.hold_status) || !Number.isSafeInteger(value.hold_version) || value.hold_version < 0
      || !["not_prepared", "available", "released"].includes(value.snapshot_status)
      || (value.kind === "erasure" && value.snapshot_status !== "not_prepared")
      || (value.status === "authorized" && value.kind !== "erasure")
      || (value.status === "held" && value.hold_status !== "held")
      || (value.status === "export_ready" && (value.kind !== "export" || value.snapshot_status !== "available"))
      || (value.status === "export_released" && (value.kind !== "export" || value.snapshot_status !== "released"))
      || (value.snapshot_status === "available" && !["export_ready", "held", "cancelled", "superseded"].includes(value.status))
      || (value.snapshot_status === "released" && !TERMINAL.includes(value.status))
      || value.cancel_allowed !== (!TERMINAL.includes(value.status) && value.hold_status === "clear")
      || value.release_allowed !== (value.kind === "export" && value.snapshot_status === "available" && value.hold_status === "clear")
      || value.account_deleted !== false || value.execution_allowed !== false) throw unexpected();
    return value;
  }

  function actionFields(value) {
    return ACTIONS.includes(value.action) && Number.isSafeInteger(value.version) && value.version > 0 && date(value.created_at)
      && Object.hasOwn(STATUS, value.to_status) && (value.from_status === null || Object.hasOwn(STATUS, value.from_status))
      && (value.action === "received" ? value.version === 1 && value.from_status === null && value.to_status === "received"
        : value.version > 1 && value.from_status !== null);
  }

  const fields = (type, names) => Object.fromEntries(names.split(" ").map(name => [name, type]));
  const nullable = shape => ({ $nullable: shape });
  const PROFILE_V2 = {
    ...fields("string", "name email phone gender dob goal physique diet bio username privacy unit experience tier referredBy"),
    ...fields("number", "age heightCm startWeightKg weightKg targetWeightKg activityFactor bodyFat bmi score streak workouts seen"),
    ...fields("boolean", "physiqueChosen verified onboarded"), ...fields("url", "avatar cover coverUrl"),
    following: ["string"], autoFollowed: ["string"], socials: fields("string", "instagram linkedin facebook")
  };
  const EXERCISE_V2 = { ...fields("string", "id name muscle equip"), photo: "url", images: ["url"] };
  const STATE_V2 = { profile: PROFILE_V2, updatedAt: "number", weightLog: [{ date: "string", kg: "number" }],
    workoutLog: [{ date: "string", split: "string", volume: "number", finalizationRequestId: "string",
      exercises: [{ ...EXERCISE_V2, sets: [{ reps: "number", weight: "number" }] }] }],
    foodLog: [{ date: "string", items: [{ ...fields("string", "id text unit"), ...fields("number", "kcal protein carbs fat qty") }] }],
    restDays: ["string"], draftSession: nullable({ date: "string", session: { split: "string", editing: "boolean", origDate: "string",
      items: [{ selected: "string", options: ["string"], ex: nullable(EXERCISE_V2), sets: [{ reps: "draft_number", weight: "draft_number" }] }] } }) };
  const sourceSchema = (source, ownerField, keys, shape) => ({ source, ownerField, keys: keys.split(" "), shape });
  const SOURCES_V2 = {
    identity: sourceSchema("auth.users", "id", "id", { id: "uuid", email: "string", created_at: "timestamp" }),
    account: sourceSchema("public.accounts", "uid", "uid", { uid: "uuid", source_updated_at: "timestamp", state: STATE_V2 }),
    profile: sourceSchema("public.profiles", "uid", "uid", { uid: "uuid", data: PROFILE_V2 }),
    rights_requests: sourceSchema("public.account_rights_requests", "requester", "id", {
      ...fields("uuid", "id request_id requester"), ...fields("string", "kind scope status snapshot_status hold_status"),
      ...fields("integer", "version hold_version"), ...fields("timestamp", "created_at updated_at"),
      ...fields("boolean", "cancel_allowed account_deleted execution_allowed release_allowed") }),
    rights_actions: sourceSchema("public.account_rights_actions", null, "request_ref version", { request_ref: "uuid", version: "integer",
      ...fields("string", "action from_status to_status"), created_at: "timestamp" }),
    posts: sourceSchema("public.posts", "author", "id", { id: "string", author: "uuid", ts: "timestamp", liked_by_requester: "boolean",
      data: { ...fields("string", "text body tag reshareOf resharedFrom"), ...fields("url", "photo video"), photos: nullable(["url"]), gradient: nullable(["string"]),
        music: nullable({ ...fields("string", "id title artist genre source"), ...fields("url", "src cover") }) } }),
    comments: sourceSchema("public.comments", "author", "id", { ...fields("string", "id post_id body parent_id"), author: "uuid", ts: "timestamp" }),
    messages: sourceSchema("public.messages", null, "id", { ...fields("string", "id from_uid to_uid body"), ts: "timestamp" }),
    connections: sourceSchema("public.requests", null, "id", { ...fields("string", "id from_uid to_uid status"), ts: "timestamp" }),
    notifications: sourceSchema("public.notifications", "uid", "id", { ...fields("string", "id type post_id"), uid: "uuid", read: "boolean", ts: "timestamp" }),
    legacy_stories: sourceSchema("public.stories", "author", "id", { id: "string", author: "uuid", photo: "url", kind: "string", ts: "timestamp" }),
    stories: sourceSchema("public.stories_v2", "owner", "id", { ...fields("uuid", "id owner"), ...fields("string", "kind audience"), ...fields("timestamp", "created_at expires_at deleted_at") }),
    story_content: sourceSchema("public.story_content", "owner", "story_id", { ...fields("uuid", "story_id owner"), media_url: "url" }),
    story_interactions: sourceSchema("public.story_interactions", "viewer", "story_id", { ...fields("uuid", "story_id viewer"), qualified_at: "timestamp", liked: "boolean" }),
    story_blocks: sourceSchema("public.story_blocks", "blocker", "blocked", fields("uuid", "blocker blocked")),
    story_preferences: sourceSchema("public.story_notification_preferences", "uid", "uid", { uid: "uuid", ...fields("boolean", "likes replies sound"), reply_permission: "string", version: "integer" }),
    story_notifications: sourceSchema("public.story_notifications", "recipient", "id", { ...fields("uuid", "id recipient story_id"), ...fields("string", "kind message_id"), ...fields("timestamp", "created_at read_at") }),
    story_reports: sourceSchema("public.story_reports", "reporter", "id", { ...fields("uuid", "id reporter story_id"), ...fields("string", "message_id reason status"), created_at: "timestamp" }),
    support_cases: sourceSchema("public.support_cases", "owner", "id", { ...fields("uuid", "id owner request_id"), ...fields("string", "subject status"), version: "integer", ...fields("timestamp", "created_at updated_at") }),
    support_messages: sourceSchema("public.support_messages", "owner", "id", { ...fields("uuid", "id case_id owner"), ...fields("string", "author_role visibility body"), evidence: ["string"], created_at: "timestamp" }),
    legacy_support: sourceSchema("public.support_tickets", "uid", "id", { ...fields("string", "id email subject message tier status"), uid: "uuid", created_at: "timestamp" }),
    reports: sourceSchema("public.report_cases", "reporter", "id", { ...fields("uuid", "id reporter request_id"), ...fields("string", "kind target_id reason status"), version: "integer", ...fields("timestamp", "created_at updated_at") }),
    consent: sourceSchema("public.billing_analytics_consent", "uid", "uid", { ...fields("uuid", "uid revision"), granted: "boolean", version: "string", captured_at: "timestamp" }),
    activation: sourceSchema("public.activation_members", "uid", "uid", { ...fields("uuid", "uid consent_revision"), ...fields("string", "consent_version pending_workout_date history_state incomplete_reason"), ...fields("timestamp", "consent_captured_at registered_at first_workout_at") }),
    workout_finalizations: sourceSchema("public.activation_finalization_receipts", "uid", "request_id", { ...fields("uuid", "uid request_id"), workout_date: "string", recorded_at: "timestamp" }),
    entitlements: sourceSchema("public.entitlements", "uid", "uid", { uid: "uuid", ...fields("string", "tier status provider subscription_id"), ...fields("timestamp", "current_period_end updated_at") }),
    billing_receipts: sourceSchema("public.billing_event_receipts", "uid", "provider event_id", { uid: "uuid", ...fields("string", "provider event_id reference status reason"), ...fields("timestamp", "occurred_at paid_cursor_at received_at"), applied: "boolean" }),
    billing_history: sourceSchema("public.billing_events", "uid", "id", { ...fields("string", "id type"), uid: "uuid", created_at: "timestamp" }),
    analytics_events: sourceSchema("public.analytics_outbox", "uid", "event_id", { ...fields("uuid", "event_id uid"), ...fields("string", "event_name tier rail currency consent_version state"), amount_minor: "integer", ...fields("timestamp", "occurred_at consent_captured_at provider_acknowledged_at delivered_at") }),
    auth_contact: sourceSchema("auth.users", "id", "id", { id: "uuid", phone: "string", ...fields("timestamp", "email_confirmed_at phone_confirmed_at updated_at last_sign_in_at") }),
    post_reactions: sourceSchema("public.posts", "viewer", "post_id", { post_id: "string", viewer: "uuid", liked: "boolean" }),
    story_actions: sourceSchema("public.story_action_receipts", "actor", "request_id", { ...fields("uuid", "actor request_id"), action: "string", created_at: "timestamp" })
  };
  function sameShape(value, expected) {
    if (value === expected) return true;
    if (Array.isArray(expected)) return Array.isArray(value) && value.length === expected.length && expected.every((item, index) => sameShape(value[index], item));
    return object(expected) && exactKeys(value, Object.keys(expected)) && Object.keys(expected).every(key => sameShape(value[key], expected[key]));
  }
  function projected(value, shape, required = false) {
    if (typeof shape === "string") {
      if (value === null) return true;
      if (shape === "uuid") return uuid(value);
      if (shape === "timestamp") return date(value);
      if (shape === "url") return typeof value === "string" && /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[^?#\s]*)?$/.test(value);
      if (shape === "integer") return Number.isSafeInteger(value);
      if (shape === "number") return typeof value === "number" && Number.isFinite(value);
      if (shape === "draft_number") return (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string"
        && /^(?:|[0-9]+(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?|\.[0-9]+(?:[eE][+-]?[0-9]+)?)$/.test(value) && Number.isFinite(Number(value)));
      return typeof value === shape;
    }
    if (Array.isArray(shape)) return Array.isArray(value) && value.length <= 10000 && value.every(item => projected(item, shape[0]));
    if (Object.hasOwn(shape, "$nullable")) return value === null || projected(value, shape.$nullable);
    return object(value) && (!required || exactKeys(value, Object.keys(shape)))
      && Object.keys(value).every(key => Object.hasOwn(shape, key) && projected(value[key], shape[key]));
  }
  function archiveV2(content, header, owner) {
    const names = Object.keys(SOURCES_V2);
    if (!exactKeys(content, ["schema", "schema_version", "scope", "request_ref", "requester", "generated_at", "coverage", "provenance", "projection", "source_inventory", "exclusions", "data"])
      || content.schema !== "formora.account-rights" || content.schema_version !== 2 || content.scope !== "account_server_personal_v2"
      || content.scope !== header.receipt.scope || content.request_ref !== header.request_ref || content.requester !== owner || content.generated_at !== header.generated_at
      || !exactKeys(content.coverage, ["all_personal_data", "known_source_schemas_available", "legacy_aliases", "ownership", "snapshot", "media"])
      || content.coverage.all_personal_data !== false || typeof content.coverage.known_source_schemas_available !== "boolean"
      || content.coverage.legacy_aliases !== "not_verified" || content.coverage.ownership !== "canonical_auth_uid_only"
      || content.coverage.snapshot !== "single_sql_statement_before_preparation" || content.coverage.media !== "public_url_references_only_no_bytes"
      || !exactKeys(content.provenance, ["ownership", "snapshot", "availability"]) || !Object.values(content.provenance).every(value => typeof value === "string" && value.length <= 500)
      || !Array.isArray(content.exclusions) || content.exclusions.length < 1 || content.exclusions.length > 20 || !content.exclusions.every(value => typeof value === "string" && value.length <= 500)
      || !exactKeys(content.data, names) || !exactKeys(content.projection, names) || !Array.isArray(content.source_inventory) || content.source_inventory.length !== names.length) throw unexpected();
    const seen = new Set();
    for (const source of content.source_inventory) {
      if (!exactKeys(source, ["id", "version", "source", "owner_filter", "available", "status", "missing_columns", "row_limit", "source_execution_allowed", "matched_rows", "truncated"])
        || !Object.hasOwn(SOURCES_V2, source.id) || seen.has(source.id) || source.version !== 1 || source.row_limit !== 10000
        || source.source_execution_allowed !== false || source.truncated !== false || typeof source.available !== "boolean"
        || typeof source.owner_filter !== "string" || source.owner_filter.length > 256 || !source.owner_filter
        || !Array.isArray(source.missing_columns) || source.missing_columns.length > 64
        || !source.missing_columns.every(value => typeof value === "string" && /^(?:auth|public)\.[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?$/.test(value))) throw unexpected();
      seen.add(source.id);
      const schema = SOURCES_V2[source.id], rows = content.data[source.id];
      if (source.source !== schema.source || !sameShape(content.projection[source.id], schema.shape)) throw unexpected();
      if (!source.available) {
        if (!["missing_table", "schema_mismatch"].includes(source.status) || !source.missing_columns.length || source.matched_rows !== null || rows !== null) throw unexpected();
        continue;
      }
      if (source.status !== "available" || source.missing_columns.length || !Number.isSafeInteger(source.matched_rows) || source.matched_rows < 0 || source.matched_rows > 10000
        || !Array.isArray(rows) || rows.length !== source.matched_rows) throw unexpected();
      const keys = new Set();
      for (const row of rows) {
        if (!projected(row, schema.shape, true) || (schema.ownerField && row[schema.ownerField] !== owner)) throw unexpected();
        const key = JSON.stringify(schema.keys.map(field => row[field]));
        if (keys.has(key) || schema.keys.some(field => row[field] === null)) throw unexpected();
        keys.add(key);
        if (["messages", "connections"].includes(source.id) && (typeof row.from_uid !== "string" || typeof row.to_uid !== "string"
          || !row.from_uid || !row.to_uid || (row.from_uid !== owner && row.to_uid !== owner))) throw unexpected();
        if (source.id === "support_messages" && (row.visibility !== "thread" || !["member", "staff"].includes(row.author_role))) throw unexpected();
        if (source.id === "post_reactions" && row.liked !== true) throw unexpected();
      }
    }
    if (content.coverage.known_source_schemas_available !== content.source_inventory.every(source => source.available)
      || content.data.identity?.length !== 1 || !Array.isArray(content.data.rights_requests) || !Array.isArray(content.data.rights_actions)) throw unexpected();
    content.data.rights_requests.forEach(row => receipt(row, owner));
    const requests = new Map(content.data.rights_requests.map(row => [row.id, row])), captured = requests.get(header.request_ref);
    if (!captured || captured.request_id !== header.receipt.request_id || captured.scope !== content.scope || captured.version >= header.receipt.version
      || !["received", "under_review"].includes(captured.status) || captured.snapshot_status !== "not_prepared" || captured.hold_status !== "clear") throw unexpected();
    for (const action of content.data.rights_actions) {
      if (!requests.has(action.request_ref) || !actionFields(action) || action.version > requests.get(action.request_ref).version) throw unexpected();
    }
    const stories = content.data.stories && new Set(content.data.stories.map(story => story.id));
    const cases = content.data.support_cases && new Set(content.data.support_cases.map(ticket => ticket.id));
    for (const row of content.data.story_content || []) if (stories && !stories.has(row.story_id)) throw unexpected();
    for (const row of content.data.support_messages || []) if (cases && !cases.has(row.case_id)) throw unexpected();
  }

  function create(options = {}) {
    const getAuth = options.getAuth || (() => typeof SupaAuth !== "undefined" ? SupaAuth : null);
    const pending = new Map(), controllers = new Set(), downloadUrls = new Map();
    let generation = 0, clearView = () => {}, destroyed = false, mounted = null, observing = false, observedOwner = "";
    function enabled() { return !destroyed && (typeof options.enabled === "function" ? options.enabled() === true : options.enabled === true); }
    function owner() {
      const auth = enabled() ? getAuth() : null;
      const uid = auth?.active() ? auth.uid() : "";
      return uuid(uid) ? uid.toLowerCase() : "";
    }
    function sessionChanged() { const next = owner(); if (next !== observedOwner) { observedOwner = next; reset(); } }
    function observeSession() {
      if (observing || typeof root.addEventListener !== "function") return;
      observedOwner = owner(); observing = true;
      root.addEventListener("formora:sessionchange", sessionChanged); root.addEventListener("pagehide", reset);
    }
    function check(lease) {
      const currentOwner = owner();
      if (!enabled() || lease.generation !== generation || currentOwner !== lease.owner) {
        if (mounted && mounted.owner !== currentOwner) reset();
        throw failure("account_changed", "The account changed. Reopen account rights.");
      }
      if (lease.controller?.signal.aborted) throw lease.controller.signal.reason;
      if (lease.deadline && Date.now() >= lease.deadline) {
        const error = timedOut("operation_timeout"); lease.controller.abort(error); throw error;
      }
    }
    function settings() {
      let url;
      try { url = new URL(options.url ?? root.SUPABASE_URL ?? ""); }
      catch (_) { throw failure("unavailable", "Account-rights service is not configured."); }
      const key = options.anonKey || root.SUPABASE_ANON_KEY;
      if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
        || !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
        || typeof key !== "string" || !key.trim() || key.length > 8192) throw failure("unavailable", "Account-rights service is not configured.");
      return { base: url.origin, key };
    }
    function timedOut(code) {
      const error = failure(code, "The operation timed out. Its server status is unknown. Refresh or retry with the retained identifier.");
      error.operation_status = "unknown"; return error;
    }
    async function bounded(signal, action) {
      if (signal.aborted) throw signal.reason;
      let onAbort;
      const aborted = new Promise((resolve, reject) => {
        onAbort = () => reject(signal.reason); signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([aborted, Promise.resolve().then(() => {
          if (signal.aborted) throw signal.reason; return action();
        })]);
      } finally { signal.removeEventListener("abort", onAbort); }
    }
    async function readJSON(response, limit, lease, signal) {
      const stated = response.headers?.get("content-length");
      if (stated && (!/^\d+$/.test(stated) || Number(stated) > limit)) throw unexpected();
      let text;
      if (response.body?.getReader) {
        const reader = response.body.getReader(), chunks = []; let size = 0;
        let cancelled = false;
        const cancel = () => { if (!cancelled) { cancelled = true; try { Promise.resolve(reader.cancel()).catch(() => {}); } catch (_) {} } };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          while (true) {
            const chunk = await bounded(signal, () => reader.read()); check(lease); if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > limit) throw unexpected();
            chunks.push(chunk.value);
          }
          const bytes = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch (error) { cancel(); throw error; }
        finally { signal.removeEventListener("abort", cancel); chunks.length = 0; try { reader.releaseLock(); } catch (_) {} }
      } else {
        text = await bounded(signal, () => response.text()); check(lease);
        if (new TextEncoder().encode(text).byteLength > limit) throw unexpected();
      }
      return JSON.parse(text);
    }
    async function request(lease, route, body, maxBytes = LIMITS.responseBytes) {
      check(lease);
      const controller = new AbortController(); controllers.add(controller);
      const timeout = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? Math.min(options.timeoutMs, 10000) : 10000;
      const stop = () => controller.abort(lease.controller.signal.reason);
      lease.controller.signal.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(() => controller.abort(timedOut("request_timeout")), timeout);
      try {
        const serialized = body === undefined ? undefined : JSON.stringify(body);
        if (serialized && new TextEncoder().encode(serialized).byteLength > LIMITS.requestBytes) throw failure("invalid_request", "Request exceeds the allowed size.");
        const response = await bounded(controller.signal, () => (options.fetch || root.fetch)(lease.base + route, {
          method: body === undefined ? "GET" : "POST", headers: { apikey: lease.key, Authorization: "Bearer " + lease.token,
            Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
          body: serialized, signal: controller.signal, cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer"
        }));
        check(lease);
        if (controller.signal.aborted) throw controller.signal.reason;
        if (!response.ok) {
          const messages = { 400: "The request is not valid.", 401: "Sign in again to continue; erasure requests need fresh authentication.",
            403: "This action is not permitted.", 404: "This request is unavailable.", 409: "The request changed. Refresh its status before continuing.",
            413: "The export exceeds automatic capacity. No partial archive was produced; contact support.",
            422: "Saved data needs a reviewed export. No partial archive was produced; contact support.",
            429: "Request or cached export capacity reached. Remove an existing cached export, finish a pending request, or contact support." };
          throw failure("http_" + response.status, messages[response.status] || "The service did not confirm the request. Retry when available.", response.status);
        }
        const result = await bounded(controller.signal, () => readJSON(response, maxBytes, lease, controller.signal)); check(lease);
        if (controller.signal.aborted) throw controller.signal.reason;
        return result;
      } catch (error) {
        check(lease);
        if (error.accountRightsFailure) throw error;
        throw failure("unavailable", "The service did not confirm the request. Your retry identifier is retained.");
      } finally { clearTimeout(timer); lease.controller.signal.removeEventListener("abort", stop); controllers.delete(controller); }
    }
    async function session(lease) {
      if (!enabled()) throw failure("disabled", "Account rights are not enabled.");
      observeSession();
      check(lease);
      const auth = getAuth(); Object.assign(lease, settings());
      if (!lease.owner) throw failure("sign_in_required", "Sign in again to continue.");
      lease.token = await bounded(lease.controller.signal, () => auth.token()); check(lease);
      if (typeof lease.token !== "string" || !lease.token || lease.token.length > 16384) throw failure("sign_in_required", "Sign in again to continue.");
      const user = await request(lease, "/auth/v1/user", undefined, 65536);
      if (!user || user.id !== lease.owner) throw failure("identity_mismatch", "The authenticated account could not be verified. Sign in again.");
      return lease;
    }
    function call(lease, name, body) {
      if (!RPCS.has(name)) throw failure("invalid_request", "Unsupported account-rights action.");
      return request(lease, "/rest/v1/rpc/" + name, body);
    }
    function single(key, action) {
      if (!enabled()) return Promise.reject(failure("disabled", "Account rights are not enabled."));
      const intent = { owner: owner(), generation };
      const requestKey = generation + ":" + intent.owner + ":" + key;
      if (pending.has(requestKey)) return pending.get(requestKey);
      const controller = new AbortController(); controllers.add(controller);
      const timeout = Number.isInteger(options.operationTimeoutMs) && options.operationTimeoutMs > 0
        ? Math.min(options.operationTimeoutMs, LIMITS.operationMs) : LIMITS.operationMs;
      const lease = { ...intent, controller, deadline: Date.now() + timeout };
      const timer = setTimeout(() => controller.abort(timedOut("operation_timeout")), timeout);
      const promise = bounded(controller.signal, async () => { check(lease); return action(lease); }).finally(() => {
        clearTimeout(timer); controllers.delete(controller);
        if (!controller.signal.aborted) controller.abort(failure("operation_finished", "This operation has finished."));
      });
      pending.set(requestKey, promise);
      promise.finally(() => { if (pending.get(requestKey) === promise) pending.delete(requestKey); }).catch(() => {});
      return promise;
    }
    function retryId(lease, action) {
      check(lease);
      try {
        const storage = options.storage || root.sessionStorage, key = "fm_account_rights_" + lease.owner + ":" + action;
        let id = storage.getItem(key);
        if (!uuid(id)) { id = root.crypto.randomUUID(); storage.setItem(key, id); }
        if (storage.getItem(key) !== id) throw new Error("retry_storage");
        return { id, remove() { check(lease); try { if (storage.getItem(key) === id) storage.removeItem(key); } catch (_) {} } };
      } catch (_) { throw failure("retry_storage", "Private retry storage is unavailable. No new request was sent."); }
    }
    function submit(kind, scope = SCOPES[kind]) {
      const action = "submit:" + kind + (scope === SCOPES[kind] ? "" : ":" + scope);
      return single(action, async lease => {
        await session(lease); const retry = retryId(lease, action);
        const payload = { schema_version: kind === "export" ? EXPORT_SCOPES[scope].requestVersion : 1, scope, ...(kind === "erasure" ? { confirmed: true } : {}) };
        const result = receipt(await call(lease, "submit_account_rights_request", { p_request_id: retry.id, p_kind: kind, p_payload: payload }), lease.owner);
        if (result.request_id !== retry.id || result.kind !== kind || result.scope !== scope) throw unexpected();
        retry.remove(); return result;
      });
    }
    function reset() {
      generation++; pending.clear(); controllers.forEach(controller => controller.abort(failure("account_changed", "The operation was stopped. Reopen account rights to check its server status."))); controllers.clear();
      downloadUrls.forEach((timer, url) => { clearTimeout(timer); root.URL.revokeObjectURL(url); }); downloadUrls.clear(); clearView();
    }
    function exportHeader(value, lease, id) {
      if (!object(value) || value.schema_version !== 1 || value.request_ref !== id || value.requester !== lease.owner || !date(value.generated_at)
        || !Number.isSafeInteger(value.total_bytes) || value.total_bytes < 1 || value.total_bytes > LIMITS.archiveBytes
        || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256) || value.max_chunk_bytes !== LIMITS.chunkBytes
        || !uuid(value.operation_id) || value.operation_status !== "committed") throw unexpected();
      const current = receipt(value.receipt, lease.owner);
      if (current.id !== id || current.kind !== "export" || current.status !== "export_ready"
        || current.snapshot_status !== "available" || current.hold_status !== "clear") throw unexpected();
      return value;
    }
    function exportPage(value, lease, id, offset, length, header) {
      check(lease);
      if (!exactKeys(value, [...EXPORT_KEYS, "offset", "next_offset", "complete", "chunk_base64"])) throw unexpected();
      exportHeader(value, lease, id);
      if (value.offset !== offset || value.next_offset !== Math.min(value.total_bytes, offset + length)
        || value.complete !== (value.next_offset === value.total_bytes) || typeof value.chunk_base64 !== "string"
        || (header && (["total_bytes", "sha256", "generated_at", "operation_id", "operation_status"].some(key => value[key] !== header[key])
          || ["request_id", "version", "hold_version", "scope"].some(key => value.receipt[key] !== header.receipt[key])))) throw unexpected();
      const encoded = value.chunk_base64.replace(/[\r\n]/g, "");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw unexpected();
      let bytes;
      try { bytes = Uint8Array.from(root.atob(encoded), character => character.charCodeAt(0)); } catch (_) { throw unexpected(); }
      if (bytes.byteLength !== value.next_offset - offset || bytes.byteLength > length) throw unexpected();
      return bytes;
    }
    async function prepare(lease, id) {
      const current = receipt(await call(lease, "my_account_rights_request", { p_id: id }), lease.owner);
      if (current.id !== id || current.kind !== "export") throw unexpected();
      if (current.hold_status !== "clear") throw failure("hold_unresolved", "Active or unverified holds prevent this export. Contact support.");
      if (current.status === "export_ready") {
        const first = await call(lease, "read_account_rights_export", { p_id: id, p_offset: 0, p_limit: 1 });
        exportPage(first, lease, id, 0, 1);
        if (["request_id", "version", "hold_version", "scope"].some(key => first.receipt[key] !== current[key])) throw unexpected();
        const { offset, next_offset, complete, chunk_base64, ...header } = first;
        return header;
      }
      if (!["received", "under_review"].includes(current.status)) throw failure("request_changed", "This request cannot produce an export. Refresh its status.");
      const retry = retryId(lease, "prepare:" + id + ":" + current.version);
      const result = await call(lease, "prepare_account_rights_export", { p_id: id, p_version: current.version, p_operation_id: retry.id });
      if (!exactKeys(result, EXPORT_KEYS)) throw unexpected();
      exportHeader(result, lease, id);
      if (result.operation_id !== retry.id || result.receipt.request_id !== current.request_id || result.receipt.scope !== current.scope
        || result.receipt.version < current.version + 1 || result.receipt.hold_version !== current.hold_version) throw unexpected();
      retry.remove(); return result;
    }
    function progress(lease, id, received, total, listener) {
      check(lease);
      const value = Object.freeze({ request_ref: id, received_bytes: received, total_bytes: total, percent: Math.floor(received * 100 / total) });
      if (mounted && current(mounted) && mounted.busy) mounted.notice.textContent = "Downloading cached export: " + value.percent + "%.";
      if (typeof listener === "function") listener(value);
      check(lease);
    }
    function saveArchive(lease, archive) {
      check(lease);
      if (typeof options.saveArchive === "function") return options.saveArchive({ ...archive, signal: lease.controller.signal });
      if (!root.document?.body || typeof root.URL.createObjectURL !== "function") throw failure("download_unavailable", "Download is unavailable in this browser.");
      const url = root.URL.createObjectURL(archive.blob), anchor = root.document.createElement("a");
      try {
        check(lease); anchor.href = url; anchor.download = archive.filename; anchor.hidden = true; anchor.rel = "noreferrer";
        root.document.body.append(anchor); anchor.click();
        const timer = setTimeout(() => { root.URL.revokeObjectURL(url); downloadUrls.delete(url); }, 1000);
        downloadUrls.set(url, timer);
      } catch (error) { root.URL.revokeObjectURL(url); throw error; }
      finally { anchor.remove(); }
    }
    const api = {
      enabled, owner, reset, exportScopes: EXPORT_SCOPES,
      close: reset,
      destroy() {
        reset(); destroyed = true;
        if (observing) { root.removeEventListener("formora:sessionchange", sessionChanged); root.removeEventListener("pagehide", reset); observing = false; }
      },
      requestExport(scope = SCOPES.export) {
        if (typeof scope !== "string" || !Object.hasOwn(EXPORT_SCOPES, scope)) return Promise.reject(failure("invalid_request", "Choose a supported export scope."));
        return submit("export", scope);
      },
      requestErasure(confirmation = {}) {
        if (confirmation?.confirmed !== true) return Promise.reject(failure("confirmation_required", "Confirm the erasure request before sending it."));
        return submit("erasure");
      },
      reauthenticate() {
        return single("reauthenticate", async lease => {
          if (!lease.owner || typeof options.reauthenticate !== "function") throw failure("reauthentication_required", "Sign in again, then reopen account rights to request erasure.");
          if (await bounded(lease.controller.signal, () => options.reauthenticate({ requester: lease.owner })) !== true) throw failure("reauthentication_cancelled", "Authentication was not confirmed. No erasure request was sent.");
          check(lease); await session(lease); return { requester: lease.owner };
        });
      },
      getRequest(id) {
        if (!uuid(id)) return Promise.reject(failure("invalid_request", "Invalid request identifier."));
        return single("get:" + id, async lease => {
          await session(lease); const result = receipt(await call(lease, "my_account_rights_request", { p_id: id }), lease.owner);
          if (result.id !== id) throw unexpected(); return result;
        });
      },
      async listRequests(cursor = null) {
        if (cursor !== null && (!exactKeys(cursor, ["created_at", "id"]) || !date(cursor.created_at) || !uuid(cursor.id))) throw failure("invalid_request", "Invalid request cursor.");
        cursor = cursor && { ...cursor };
        return single("list:" + JSON.stringify(cursor), async lease => {
          await session(lease);
          const result = await call(lease, "my_account_rights_requests", { p_before: cursor?.created_at || null, p_before_id: cursor?.id || null, p_limit: LIMITS.pageSize });
          if (!exactKeys(result, ["requester", "items", "has_more", "next_cursor"]) || result.requester !== lease.owner
            || !Array.isArray(result.items) || result.items.length > LIMITS.pageSize || typeof result.has_more !== "boolean") throw unexpected();
          result.items.forEach(row => receipt(row, lease.owner));
          if (new Set(result.items.map(row => row.id)).size !== result.items.length || result.items.some(row => row.id === cursor?.id)) throw unexpected();
          if (result.has_more) {
            const last = result.items.at(-1);
            if (!last || !exactKeys(result.next_cursor, ["created_at", "id"]) || result.next_cursor.id !== last.id || result.next_cursor.created_at !== last.created_at) throw unexpected();
          } else if (result.next_cursor !== null) throw unexpected();
          return result;
        });
      },
      async history(id, beforeVersion = null) {
        if (!uuid(id) || (beforeVersion !== null && (!Number.isSafeInteger(beforeVersion) || beforeVersion < 1))) throw failure("invalid_request", "Invalid history cursor.");
        return single("history:" + id + ":" + beforeVersion, async lease => {
          await session(lease);
          const result = await call(lease, "my_account_rights_history", { p_id: id, p_before_version: beforeVersion, p_limit: LIMITS.pageSize });
          if (!exactKeys(result, ["requester", "request_ref", "items", "has_more", "next_before_version"]) || result.requester !== lease.owner || result.request_ref !== id
            || !Array.isArray(result.items) || result.items.length > LIMITS.pageSize || typeof result.has_more !== "boolean") throw unexpected();
          let previous = beforeVersion || Infinity;
          for (const action of result.items) {
            if (!exactKeys(action, ["id", "action", "version", "from_status", "to_status", "created_at"]) || !uuid(action.id)
              || !actionFields(action) || action.version >= previous) throw unexpected();
            previous = action.version;
          }
          if (result.has_more ? (!result.items.length || result.next_before_version !== previous) : result.next_before_version !== null) throw unexpected();
          return result;
        });
      },
      prepareExport(id) {
        if (!uuid(id)) return Promise.reject(failure("invalid_request", "Invalid request identifier."));
        return single("prepare:" + id, async lease => prepare(await session(lease), id));
      },
      downloadExport(id, delivery = {}) {
        if (!uuid(id)) return Promise.reject(failure("invalid_request", "Invalid request identifier."));
        delivery = { save: delivery.save, onProgress: delivery.onProgress };
        return single("download:" + id, async lease => {
          await session(lease); const header = await prepare(lease, id), bytes = new Uint8Array(header.total_bytes);
          try {
            let offset = 0; progress(lease, id, offset, bytes.byteLength, delivery.onProgress);
            while (offset < bytes.byteLength) {
              const page = await call(lease, "read_account_rights_export", { p_id: id, p_offset: offset, p_limit: LIMITS.chunkBytes });
              const chunk = exportPage(page, lease, id, offset, LIMITS.chunkBytes, header);
              bytes.set(chunk, offset); offset = page.next_offset;
              progress(lease, id, offset, bytes.byteLength, delivery.onProgress);
            }
            check(lease);
            const digest = await bounded(lease.controller.signal, () => root.crypto.subtle.digest("SHA-256", bytes));
            check(lease);
            const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
            if (sha256 !== header.sha256) throw unexpected();
            let content;
            try { content = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch (_) { throw unexpected(); }
            if (header.receipt.scope === "account_server_personal_v2") archiveV2(content, header, lease.owner);
            else {
            if (!exactKeys(content, ["schema", "schema_version", "scope", "request_ref", "requester", "generated_at", "provenance", "projection", "exclusions", "data", "request_history"])
              || content.schema !== "formora.account-rights" || content.schema_version !== 1 || content.scope !== SCOPES.export
              || content.requester !== lease.owner || content.request_ref !== id || content.generated_at !== header.generated_at
              || content.data?.identity?.id !== lease.owner || !object(content.provenance) || !object(content.projection)
              || !Array.isArray(content.exclusions) || !content.exclusions.every(value => typeof value === "string")
              || !exactKeys(content.request_history, ["requests", "actions"])
              || !Array.isArray(content.request_history.requests) || !Array.isArray(content.request_history.actions)) throw unexpected();
            content.request_history.requests.forEach(row => receipt(row, lease.owner));
            const ownedRequests = new Map(content.request_history.requests.map(row => [row.id, row]));
            if (ownedRequests.size !== content.request_history.requests.length || !ownedRequests.has(id)) throw unexpected();
            for (const action of content.request_history.actions) {
              if (!exactKeys(action, ["request_ref", "action", "version", "from_status", "to_status", "created_at"])
                || !ownedRequests.has(action.request_ref) || !actionFields(action) || action.version > ownedRequests.get(action.request_ref).version) throw unexpected();
            }
            }
            check(lease);
            const result = { blob: new Blob([bytes], { type: "application/json" }), filename: "formora-account-" + id + ".json",
              request_ref: id, requester: lease.owner, generated_at: header.generated_at, total_bytes: bytes.byteLength, sha256 };
            if (delivery.save !== false) await bounded(lease.controller.signal, () => saveArchive(lease, result));
            check(lease); return result;
          } finally { bytes.fill(0); }
        });
      },
      releaseExport(value, confirmation = {}) {
        if (confirmation?.confirmed !== true) return Promise.reject(failure("confirmation_required", "Confirm removal of this cached export. Account data will not be deleted."));
        value = object(value) ? { ...value } : value;
        return single("release:" + value?.id, async lease => {
          await session(lease); const current = receipt(value, lease.owner);
          if (!current.release_allowed) throw failure("request_changed", "This cached export cannot be removed. Refresh its status or contact support.");
          const retry = retryId(lease, "release:" + current.id + ":" + current.version);
          const result = await call(lease, "release_my_account_rights_export", { p_id: current.id, p_version: current.version, p_operation_id: retry.id });
          if (!exactKeys(result, ["schema_version", "operation_id", "operation_status", "action", "scope", "request_ref", "requester", "released_bytes", "source_data_deleted", "receipt"])
            || result.schema_version !== 1 || result.operation_id !== retry.id || result.operation_status !== "committed"
            || result.action !== "release_export" || result.scope !== "cached_export_only" || result.request_ref !== current.id || result.requester !== lease.owner
            || !Number.isSafeInteger(result.released_bytes) || result.released_bytes < 1 || result.released_bytes > LIMITS.archiveBytes
            || result.source_data_deleted !== false) throw unexpected();
          const released = receipt(result.receipt, lease.owner);
          if (released.id !== current.id || released.request_id !== current.request_id || released.kind !== "export"
            || released.scope !== current.scope
            || released.version < current.version + 1 || released.hold_version < current.hold_version || released.snapshot_status !== "released"
            || released.status !== (TERMINAL.includes(current.status) ? current.status : "export_released")) throw unexpected();
          retry.remove(); return result;
        });
      },
      cancel(value) {
        value = object(value) ? { ...value } : value;
        return single("cancel:" + value?.id, async lease => {
          await session(lease); const current = receipt(value, lease.owner);
          if (!current.cancel_allowed) throw failure("request_changed", "This request is no longer cancellable.");
          const retry = retryId(lease, "cancel:" + current.id + ":" + current.version);
          const result = receipt(await call(lease, "cancel_account_rights_request", { p_id: current.id, p_version: current.version, p_operation_id: retry.id }), lease.owner);
          if (result.id !== current.id || result.request_id !== current.request_id || result.kind !== current.kind
            || result.scope !== current.scope
            || result.status !== "cancelled" || result.version < current.version + 1 || result.hold_version < current.hold_version
            || result.snapshot_status !== (current.snapshot_status === "available" ? "released" : current.snapshot_status)) throw unexpected();
          retry.remove(); return result;
        });
      }
    };
    function current(view) { return mounted === view && view.generation === generation && view.owner === owner() && view.container.contains(view.root); }
    function element(view, tag, text, className) {
      const node = view.document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    }
    function locked(button, value) { button.dataset.locked = value ? "true" : "false"; button.disabled = value; }
    function busy(view, value) {
      view.busy = value; view.root.setAttribute("aria-busy", String(value));
      for (const control of view.root.querySelectorAll("button, input, select")) {
        if (control.dataset.persistent === "true") { control.disabled = false; continue; }
        control.disabled = value || control.dataset.locked === "true";
      }
    }
    async function operate(view, action) {
      if (!current(view) || view.busy) {
        if (mounted === view && view.owner !== owner()) reset();
        return;
      }
      busy(view, true); view.notice.textContent = ""; view.notice.setAttribute("role", "status");
      try { await action(); }
      catch (error) {
        if (current(view)) { view.notice.setAttribute("role", "alert"); view.notice.textContent = error.accountRightsFailure ? error.message : "The request could not be confirmed. Retry."; }
      } finally { if (current(view)) busy(view, false); }
    }
    function button(view, label, action, icon, primary = false, persistent = false) {
      const node = element(view, "button", undefined, primary ? "btn" : "btn ghost"); node.type = "button";
      node.style.cssText = "min-height:44px;max-width:100%;white-space:normal;letter-spacing:0";
      if (typeof options.icon === "function" && icon) {
        const image = options.icon(icon); if (image?.nodeType) node.append(image);
      }
      if (persistent) node.dataset.persistent = "true";
      node.append(element(view, "span", label));
      node.addEventListener("click", () => persistent ? (current(view) && action()) : operate(view, action)); return node;
    }
    function controls(view) {
      const node = element(view, "div"); node.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;align-items:center;min-width:0"; return node;
    }
    function announce(view, result) {
      view.notice.textContent = STATUS[result.status] + ". Account erasure has not been executed. Reference " + result.id;
    }
    async function loadHistory(view, id, beforeVersion = null) {
      const result = await api.history(id, beforeVersion); if (!current(view)) return;
      const nodes = [element(view, "h3", "Request history")];
      for (const action of result.items) nodes.push(element(view, "p", "Version " + action.version + ": " + STATUS[action.to_status] + " - " + new Date(action.created_at).toLocaleString()));
      if (!result.items.length) nodes.push(element(view, "p", "No recorded actions."));
      const navigation = controls(view);
      if (beforeVersion !== null) navigation.append(button(view, "Latest actions", () => loadHistory(view, id), "undo"));
      if (result.has_more) navigation.append(button(view, "Earlier actions", () => loadHistory(view, id, result.next_before_version), "chevronR"));
      nodes.push(navigation); view.history.replaceChildren(...nodes);
    }
    async function loadPage(view, cursor = null, pageIndex = 0) {
      const result = await api.listRequests(cursor); if (!current(view)) return;
      view.cursors[pageIndex] = cursor; view.cursors.length = pageIndex + 1; view.pageIndex = pageIndex;
      const nodes = [];
      for (const row of result.items) {
        const item = element(view, "section"); item.dataset.requestId = row.id;
        item.style.cssText = "padding:12px 0;border-top:1px solid var(--line);min-width:0;overflow-wrap:anywhere";
        item.append(element(view, "strong", (row.kind === "export" ? "Export: " : "Erasure: ") + STATUS[row.status]),
          element(view, "div", "Reference " + row.id, "sub"), element(view, "div", new Date(row.created_at).toLocaleString(), "sub"));
        if (row.kind === "export") item.append(element(view, "div", EXPORT_SCOPES[row.scope].label, "sub"));
        const actions = controls(view);
        actions.append(button(view, "History", () => loadHistory(view, row.id), "clock"));
        if (row.kind === "export" && row.hold_status === "clear" && ["received", "under_review", "export_ready"].includes(row.status)) {
          actions.append(button(view, "Download export", async () => {
            await api.downloadExport(row.id); if (!current(view)) return;
            await loadPage(view, view.cursors[view.pageIndex], view.pageIndex);
            if (current(view)) view.notice.textContent = "Verified archive download started.";
          }, "download"));
        }
        if (row.release_allowed) actions.append(button(view, "Remove cached export", () => confirmRelease(view, row), "trash"));
        if (row.hold_status !== "clear") item.append(element(view, "p", row.hold_status === "unknown"
          ? "Hold status is unverified. Contact support before continuing." : "An active hold prevents this action.", "sub"));
        if (row.cancel_allowed) actions.append(button(view, "Cancel request", async () => {
          const cancelled = await api.cancel(row); if (!current(view)) return;
          await loadPage(view, view.cursors[view.pageIndex], view.pageIndex); if (current(view)) announce(view, cancelled);
        }, "close"));
        item.append(actions); nodes.push(item);
      }
      if (!nodes.length) nodes.push(element(view, "p", "No requests yet."));
      view.list.replaceChildren(...nodes); view.history.replaceChildren();
      const previous = button(view, "Previous requests", () => loadPage(view, view.cursors[view.pageIndex - 1], view.pageIndex - 1), "undo");
      const next = button(view, "Next requests", () => loadPage(view, result.next_cursor, view.pageIndex + 1), "chevronR");
      locked(previous, pageIndex === 0); locked(next, !result.has_more);
      view.paging.replaceChildren(previous, element(view, "span", "Page " + (pageIndex + 1)), next);
    }
    function confirmRelease(view, row) {
      const actions = controls(view);
      actions.append(button(view, "Confirm cached export removal", async () => {
        await api.releaseExport(row, { confirmed: true }); if (!current(view)) return;
        view.confirmation.replaceChildren(); await loadPage(view, view.cursors[view.pageIndex], view.pageIndex);
        if (current(view)) view.notice.textContent = "Cached server export removed. Your account data and downloaded files are unchanged.";
      }, "trash"), button(view, "Keep cached export", () => view.confirmation.replaceChildren(), "undo"));
      view.confirmation.replaceChildren(element(view, "p", "Remove the cached server export for request " + row.id
        + "? This does not delete account data or files already downloaded."), actions);
    }
    function confirmErasure(view) {
      const form = element(view, "form"), label = element(view, "label"), checkbox = element(view, "input");
      checkbox.type = "checkbox"; checkbox.required = true; checkbox.checked = false;
      label.style.cssText = "display:flex;align-items:center;gap:8px;min-height:44px;overflow-wrap:anywhere";
      label.append(checkbox, element(view, "span", "I confirm my request for account erasure review. Sending this request does not delete my account or cancel paid obligations."));
      const submitButton = element(view, "button", "Confirm erasure request", "btn"); submitButton.type = "submit";
      submitButton.style.cssText = "min-height:44px;max-width:100%;white-space:normal"; locked(submitButton, true);
      checkbox.addEventListener("change", () => locked(submitButton, view.busy || !checkbox.checked));
      const actions = controls(view);
      actions.append(submitButton, button(view, "Back", () => view.confirmation.replaceChildren(), "undo"));
      form.append(label, actions);
      form.addEventListener("submit", event => {
        event.preventDefault();
        if (!checkbox.checked) return;
        return operate(view, async () => {
          const result = await api.requestErasure({ confirmed: true }); if (!current(view)) return;
          view.confirmation.replaceChildren(); await loadPage(view); if (current(view)) announce(view, result);
        });
      });
      view.confirmation.replaceChildren(form); checkbox.focus();
    }
    clearView = () => { if (mounted) { mounted.root.remove(); mounted = null; } };
    api.mount = container => {
      if (!enabled()) { reset(); return false; }
      if (!container || typeof container.replaceChildren !== "function") throw failure("mount_required", "Provide an account-rights container.");
      reset(); observeSession();
      const view = { container, document: container.ownerDocument || root.document, owner: owner(), generation, cursors: [null], pageIndex: 0, busy: false };
      view.root = element(view, "section"); view.root.className = "account-rights";
      view.root.style.cssText = "max-width:100%;min-width:0;overflow-wrap:anywhere;letter-spacing:0";
      const heading = element(view, "h2", "Account rights"); heading.id = "account-rights-" + root.crypto.randomUUID();
      view.root.setAttribute("role", "region"); view.root.setAttribute("aria-labelledby", heading.id);
      const header = controls(view); header.append(heading, button(view, "Close", () => { api.close(); options.onClose?.(); }, "close", false, true));
      view.notice = element(view, "p"); view.notice.setAttribute("role", "status"); view.notice.setAttribute("aria-live", "polite");
      view.confirmation = element(view, "div"); view.list = element(view, "div"); view.history = element(view, "div"); view.paging = controls(view);
      const scopeLabel = element(view, "label", "Export scope", "field"), scopeSelect = element(view, "select");
      scopeSelect.setAttribute("aria-label", "Export scope"); scopeSelect.style.cssText = "min-height:44px;max-width:100%;min-width:0;width:100%;font-size:14px;letter-spacing:0";
      for (const [scope, description] of Object.entries(EXPORT_SCOPES)) {
        const option = element(view, "option", description.label); option.value = scope; scopeSelect.append(option);
      }
      scopeSelect.value = SCOPES.export; scopeLabel.append(scopeSelect);
      const scopeNote = element(view, "p", undefined, "sub");
      const describeScope = () => { scopeNote.textContent = scopeSelect.value === SCOPES.export
        ? "Export scope: your saved account identity, profile fields, and weight, workout, food and rest-day logs. This is not an export of all personal data. Device-only data, media, social activity, shared messages, support/report records and billing records are excluded."
        : "Export scope: known server personal records for your canonical Auth UID only, not legacy aliases; alias ownership is not verified. Schema availability recorded for each source does not mean complete data coverage. Authorized shared conversations include other participants' messages and IDs. This is not an export of all personal data. Device-only data, unknown schemas, provider-held data, media bytes and restricted third-party records outside those shared conversations are excluded."; };
      describeScope(); scopeSelect.addEventListener("change", describeScope);
      const actions = controls(view);
      actions.append(button(view, "Request export", async () => {
        const result = await api.requestExport(scopeSelect.value); if (!current(view)) return;
        await loadPage(view); if (current(view)) view.notice.textContent = STATUS[result.status] + ". Reference " + result.id;
      }, "download", true), button(view, "Request erasure", async () => {
        await api.reauthenticate(); if (current(view)) confirmErasure(view);
      }, "trash"), button(view, "Refresh", () => loadPage(view), "undo"));
      view.root.append(header, scopeLabel, scopeNote,
        element(view, "p", "Erasure requests are reviewed separately. Request received does not mean account deleted. Existing paid obligations are not cancelled.", "sub"),
        actions, view.notice, view.confirmation, element(view, "h3", "Your requests"), view.list, view.paging, view.history);
      if (typeof options.openSupport === "function") view.root.append(button(view, "Contact support", () => options.openSupport(), "info"));
      else view.root.append(element(view, "p", "A data-rights contact has not been configured.", "sub"));
      container.replaceChildren(view.root); mounted = view;
      if (!view.owner) { view.notice.textContent = "Sign in again to view account rights."; for (const control of actions.querySelectorAll("button")) locked(control, true); }
      return true;
    };
    api.open = async container => {
      const target = container || mounted?.container;
      if (!api.mount(target)) return false;
      const view = mounted;
      if (view.owner) await operate(view, () => loadPage(view));
      return current(view);
    };
    return api;
  }
  const api = create(); api.create = create; api.limits = LIMITS;
  root.AccountRights = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis);