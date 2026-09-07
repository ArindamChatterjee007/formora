(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else root.Stories = factory();
})(typeof window === "undefined" ? globalThis : window, function createStories(options) {
  "use strict";
  options = options || {};
  const host = options.host || (typeof window === "undefined" ? globalThis : window);
  const auth = () => options.auth || (typeof SupaAuth === "undefined" ? host.SupaAuth : SupaAuth);
  const cloud = () => options.cloud || (typeof Cloud === "undefined" ? host.Cloud : Cloud);
  const app = () => options.app || (typeof App === "undefined" ? host.App : App);
  const social = () => options.social || (typeof Social === "undefined" ? host.Social : Social);
  const doc = () => options.document || host.document;
  const clock = options.clock || {};
  const now = () => clock.now ? clock.now() : host.performance.now();
  const wallNow = () => clock.wallNow ? clock.wallNow() : Date.now();
  const later = (callback, delay) => (clock.setTimeout || host.setTimeout.bind(host))(callback, delay);
  const cancelLater = timer => (clock.clearTimeout || host.clearTimeout.bind(host))(timer);
  const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
  const bytes = value => new TextEncoder().encode(value).byteLength;
  const iso = value => typeof value === "string" && value.length <= 64 && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const messageId = value => typeof value === "string" && value.length > 0 && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value);
  const plain = (value, report = false) => typeof value === "string" && !!value.trim() && [...value].length <= 512
    && bytes(value) <= 2048 && !(report ? /[<>\x00-\x1f\x7f]/ : /[<>\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/).test(value);
  const pick = (value, fields) => Object.fromEntries(fields.map(field => [field, value[field]]));
  const calls = Object.freeze({
    publish_story: ["p_request_id", "p_media_url", "p_kind", "p_audience"],
    publish_validated_story: ["p_request_id", "p_reservation_id", "p_sha256"],
    story_feed: ["p_cursor"], get_story: ["p_id"], record_story_view: ["p_id", "p_request_id"],
    set_story_like: ["p_id", "p_desired", "p_request_id"], story_viewers: ["p_id", "p_cursor"],
    reply_to_story: ["p_id", "p_text", "p_request_id"], resolve_story_reply_context: ["p_message_id"],
    story_reply_references: ["p_message_ids"],
    delete_story: ["p_id", "p_request_id"], get_story_notification_preferences: [],
    set_story_notification_preferences: ["p_likes", "p_replies", "p_sound", "p_reply_permission", "p_version", "p_request_id"],
    list_story_notifications: ["p_cursor"], mark_story_notifications_read: ["p_ids", "p_request_id"],
    set_story_block: ["p_member", "p_blocked", "p_request_id"], story_action_receipt: ["p_request_id"],
    report_story_content: ["p_id", "p_message_id", "p_reason", "p_request_id"]
  });
  function failure(status, retryAfter = 0) {
    const messages = {
      400: "Check your story or message and try again.", 401: "Sign in again to continue.",
      403: "This action is not permitted. Story replies may be turned off.",
      404: "Story unavailable.", 409: "This attempt conflicts with an earlier request. Check its receipt before starting again.",
      429: "Too many requests. Try again later.", 503: "Stories are unavailable right now.",
      504: "Confirmation timed out. Your attempt is kept for retry."
    };
    const message = status === 429 && retryAfter > 0 ? "Too many requests. Try again in " + retryAfter + " seconds." : messages[status];
    const error = new Error(message || "Could not confirm this action. Your attempt is kept for retry.");
    error.status = status; error.retryAfter = retryAfter;
    return error;
  }
  const api = {
    feed: [], _owner: null, pending: new Map(), _generation: 0, _revision: 0,
    _requests: new Set(), _intents: new Map(), error: null,
    _ownedRequestKeys: new Set(),
    _known: new Set(), _rowEpoch: new Map(), _likes: new Map(), _drafts: new Map(),
    _feedEpoch: 0, nextCursor: null, preference: null, _notificationRows: [],
    _visibleNotifications: new Map(),
    muted: true, onChange: null, onClose: null,
    limits: Object.freeze({ requestBytes: 32768, responseBytes: 262144, pageItems: 50, pending: 3, deadlineMs: 10000,
      storedRequests: 64, requestTtlMs: 86400000, storageScanKeys: 1024, photoSeconds: 5, qualifySeconds: 2 }),
    enabled() { return !this._destroyed && host.STORY_INTERACTIONS === true; },
    owner() {
      if (!this.enabled()) return "";
      const current = auth(), uid = current?.active?.() ? current.uid() : "";
      return uuid(uid) && cloud()?.me === uid ? uid : "";
    },
    _scope() {
      if (!this.enabled()) throw failure(503);
      const owner = this.owner();
      const identity = JSON.stringify([owner, auth()?._authEpoch, auth()?._generation, cloud()?.base]);
      if (this._identity !== identity) {
        this.reset({ purgeOwner: this._identity ? this._owner : null }); this._owner = owner; this._identity = identity;
      }
      if (!owner) throw failure(401);
      this._pruneRequests();
      if (!this._sessionListener && host.addEventListener) {
        this._sessionListener = () => { const purgeOwner = this._owner; this.reset({ purgeOwner }); };
        host.addEventListener("formora:sessionchange", this._sessionListener);
        this._pagehideListener = () => this.close(false);
        host.addEventListener("pagehide", this._pagehideListener);
      }
      return { owner, generation: this._generation, authEpoch: auth()?._authEpoch,
        authGeneration: auth()?._generation, base: cloud()?.base, key: cloud()?.key };
    },
    _current(scope) {
      return this.enabled() && scope.owner === this.owner() && scope.generation === this._generation
        && scope.authGeneration === auth()?._generation && scope.authEpoch === auth()?._authEpoch
        && scope.base === cloud()?.base && scope.key === cloud()?.key;
    },
    _assert(scope) { if (!this._current(scope)) throw failure(401); },
    reset({ purgeOwner = this._owner } = {}) {
      this._clearOldOwnerRequests(purgeOwner);
      this.close(false); this._generation++; this._owner = null; this.feed = []; this.error = null;
      this._identity = null;
      this.pending.clear(); this._intents.clear();
      this._ownedRequestKeys.clear();
      this._known.clear(); this._rowEpoch.clear(); this._likes.clear(); this._drafts.clear();
      this.preference = null; this._notificationRows = []; this._visibleNotifications.clear();
      this.nextCursor = null; this._feedEpoch++;
    },
    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      if (this._sessionListener) host.removeEventListener?.("formora:sessionchange", this._sessionListener);
      if (this._pagehideListener) host.removeEventListener?.("pagehide", this._pagehideListener);
      this._sessionListener = null; this._pagehideListener = null;
      this.reset({ purgeOwner: null }); this.onChange = null; this.onClose = null;
    },
    close(notify = true) {
      const wasOpen = !!this._root;
      this._revision++;
      this._requests.forEach(request => request.cancel()); this._requests.clear();
      this._cleanPlayback?.(); this._clearPanel?.(); this._unmount?.();
      this.feed = []; this._known.clear(); this._drafts.clear(); this._likes.clear(); this.pending.clear(); this._intents.clear();
      this._notificationRows = []; this._visibleNotifications.clear(); this._notificationRoot = null;
      this.preference = null; this._ids = []; this._index = 0; this._openTarget = null; this._panelReturnFocus = null;
      this.nextCursor = null; this.error = null; this.muted = true; this._hovered = false; this._feedEpoch++;
      if (wasOpen && notify) this._notify("onClose");
    },
    _notify(name) {
      const callback = this[name] || options[name];
      if (!this.enabled() || this._owner !== this.owner() || typeof callback !== "function") return;
      try { callback()?.catch?.(() => {}); } catch (_) {}
    },
    _base() {
      const value = cloud()?.base;
      if (typeof value !== "string") throw failure(503);
      let parsed;
      try { parsed = new URL(value); } catch (_) { throw failure(503); }
      const production = parsed.protocol === "https:" && /^[a-z0-9-]+\.supabase\.co$/.test(parsed.hostname) && !parsed.port;
      const fixture = options.allowLoopback === true && parsed.protocol === "http:"
        && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) && parsed.origin === host.location?.origin;
      if ((!production && !fixture) || parsed.username || parsed.password || parsed.search || parsed.hash
        || parsed.pathname !== "/rest/v1" || parsed.href !== value) throw failure(503);
      return parsed;
    },
    async _body(response) {
      const length = Number(response.headers?.get("content-length"));
      if (length > this.limits.responseBytes) throw failure(502);
      let text = "";
      if (response.body?.getReader) {
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let total = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            total += chunk.value.byteLength;
            if (total > this.limits.responseBytes) throw failure(502);
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        } finally { reader.cancel().catch(() => {}); }
      } else text = await response.text();
      if (bytes(text) > this.limits.responseBytes) throw failure(502);
      try { return JSON.parse(text); } catch (_) { throw failure(502); }
    },
    async _call(name, body = {}, scope = this._scope()) {
      this._assert(scope);
      if (!Object.hasOwn(calls, name) || !body || Array.isArray(body)
        || Object.keys(body).some(key => !calls[name].includes(key))) throw failure(400);
      const payload = JSON.stringify(body);
      if (bytes(payload) > this.limits.requestBytes) throw failure(400);
      const base = this._base(), key = cloud()?.key;
      if (typeof key !== "string" || !key || key.length > 8192 || /\s/.test(key) || key.startsWith("sb_secret_")) throw failure(503);
      if (key.startsWith("eyJ")) {
        try {
          const claim = JSON.parse(atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
          if (claim.role !== "anon") throw failure(503);
        } catch (_) { throw failure(503); }
      }
      if (this._requests.size >= this.limits.pending) throw failure(429);
      const controller = new AbortController();
      let rejectBoundary;
      const boundary = new Promise((resolve, reject) => { rejectBoundary = reject; });
      const request = { stopped: false, cancel: () => {
        request.stopped = true; controller.abort(); rejectBoundary(failure(401));
      } };
      const timer = later(() => {
        request.stopped = true; controller.abort(); rejectBoundary(failure(504));
      }, options.deadlineMs || this.limits.deadlineMs);
      this._requests.add(request);
      const check = () => { this._assert(scope); if (request.stopped) throw failure(504); };
      const work = (async () => {
        const token = await auth().token();
        check();
        if (typeof token !== "string" || !token || token.length > 16384 || /\s/.test(token)) throw failure(401);
        const response = await (options.fetch || host.fetch.bind(host))(base.href + "/rpc/" + name, {
          method: "POST", headers: { apikey: key, Authorization: "Bearer " + token, "Content-Type": "application/json" },
          credentials: "omit", cache: "no-store", redirect: "error", body: payload, signal: controller.signal
        });
        check();
        let result;
        try { result = await this._body(response); }
        catch (error) {
          if (!response.ok && [401, 403, 404, 409, 429, 503].includes(response.status)) throw failure(response.status);
          throw error;
        }
        check();
        if (!response.ok) {
          const code = /^PT(401|403|404|409|429|503)$/.exec(result?.code || "");
          let retryAfter = Number(response.headers?.get("retry-after")) || 0;
          try { retryAfter = JSON.parse(result.details)?.retry_after_seconds || retryAfter; } catch (_) {}
          throw failure(code ? Number(code[1]) : response.status, Math.min(86400, Math.max(0, Math.ceil(Number(retryAfter) || 0))));
        }
        return result;
      })();
      try { return await Promise.race([work, boundary]); }
      catch (error) { throw error.status ? error : failure(502); }
      finally { request.stopped = true; controller.abort(); cancelLater(timer); this._requests.delete(request); }
    },
    _storedRequest(key) {
      const storage = host.localStorage, raw = storage.getItem(key);
      if (raw === null) return null;
      let saved;
      if (uuid(raw)) saved = { id: raw };
      else if (typeof raw === "string" && raw.length <= 128) { try { saved = JSON.parse(raw); } catch (_) {} }
      if (saved && uuid(saved.id) && Object.keys(saved).every(field => field === "id" || field === "at")) {
        if (saved.at === undefined) { saved.at = wallNow(); storage.setItem(key, JSON.stringify(saved)); }
        if (integer(saved.at) && saved.at <= wallNow() && wallNow() - saved.at < this.limits.requestTtlMs + this.limits.deadlineMs) return saved;
      }
      storage.removeItem(key); this._intents.delete(key); this._ownedRequestKeys.delete(key);
      return null;
    },
    _pruneRequests() {
      const entries = new Map();
      let complete = true;
      try {
        const storage = host.localStorage, length = storage.length;
        complete = integer(length) && length <= this.limits.storageScanKeys;
        for (let index = Math.min(length, this.limits.storageScanKeys) - 1; index >= 0; index--) {
          const key = storage.key(index);
          if (typeof key !== "string" || !key.startsWith("fm_stories_request_")) continue;
          const saved = this._storedRequest(key);
          if (saved) {
            entries.set(key, saved);
            if (entries.size >= this.limits.storedRequests) { complete = complete && index === 0; break; }
          }
        }
      } catch (_) { complete = false; }
      return { entries, complete };
    },
    _clearOldOwnerRequests(owner) {
      if (!uuid(owner)) return;
      const prefix = "fm_stories_request_" + owner + "_";
      try {
        const storage = host.localStorage;
        for (const key of this._ownedRequestKeys) if (key.startsWith(prefix)) storage.removeItem(key);
        for (let index = Math.min(storage.length, this.limits.storageScanKeys) - 1; index >= 0; index--) {
          const key = storage.key(index);
          if (typeof key === "string" && key.startsWith(prefix)) storage.removeItem(key);
        }
      } catch (_) {}
    },
    _storageTarget(action, target) {
      if (!/^(publish_photo|publish_video|view|like|reply|delete|preferences|read_notifications|block|report|report_message)$/.test(action)) throw failure(400);
      if (action === "report_message") {
        if (!messageId(target) || bytes(target) > 1020) throw failure(400);
        try { return encodeURIComponent(target); } catch (_) { throw failure(400); }
      }
      if (!uuid(target)) throw failure(400);
      return target;
    },
    _request(action, target, payload, explicitId, scope) {
      const key = "fm_stories_request_" + scope.owner + "_" + action + "_" + this._storageTarget(action, target);
      const retained = this._pruneRequests();
      let held = this._intents.get(key);
      if (held && (held.payload !== payload || (explicitId && explicitId !== held.id))) throw failure(409);
      if (!held) {
        let saved;
        try { saved = this._storedRequest(key); } catch (_) { throw failure(503); }
        if (explicitId && (!uuid(explicitId) || (saved && saved.id !== explicitId))) throw failure(409);
        if (!saved && (!retained.complete || retained.entries.size >= this.limits.storedRequests)) throw failure(429);
        const id = explicitId || saved?.id || host.crypto.randomUUID();
        if (!uuid(id)) throw failure(400);
        held = { key, id, at: saved?.at ?? wallNow(), payload };
        try { host.localStorage.setItem(key, JSON.stringify({ id, at: held.at })); } catch (_) { throw failure(503); }
        this._intents.set(key, held);
        if (this._ownedRequestKeys.size < this.limits.storedRequests) this._ownedRequestKeys.add(key);
      }
      return held;
    },
    _settle(held, scope) {
      if (!this._current(scope) || this._intents.get(held.key) !== held) return;
      this._intents.delete(held.key);
      try { if (this._storedRequest(held.key)?.id === held.id) host.localStorage.removeItem(held.key); } catch (_) {}
      this._ownedRequestKeys.delete(held.key);
    },
    _media(value, kind, author) {
      const origin = options.mediaOrigin || this._base().origin, bucket = options.publicBucket || "media";
      if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(origin) || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(bucket)
        || typeof value !== "string" || value.length > 2048 || !uuid(author) || !["photo", "video"].includes(kind)) return false;
      return [...new Set([bucket, ...(host.STORY_MEDIA_VALIDATION === true ? ["media", "story-media-public-v3"] : [])])].some(allowedBucket => {
        const prefix = origin + "/storage/v1/object/public/" + allowedBucket + "/stories/" + author + "/";
        const filename = value.slice(prefix.length);
        if (allowedBucket === "story-media-public-v3" && (!uuid(filename.slice(0, 36)) || filename[36] !== "_"
          || !/^[a-f0-9]{64}\.(jpg|png|webp|mp4|webm)$/.test(filename.slice(37)))) return false;
        return value.startsWith(prefix) && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\.(jpg|jpeg|png|webp|mp4|webm)$/.test(filename)
          && (kind === "photo" ? /\.(jpg|jpeg|png|webp)$/ : /\.(mp4|webm)$/).test(filename);
      });
    },
    _shape(value, scope) {
      if (!value || !uuid(value.id) || !uuid(value.author) || !this._media(value.photo, value.kind, value.author)
        || value.audience !== "authenticated" || !integer(value.ts) || !iso(value.expires_at)
        || typeof value.mine !== "boolean" || value.mine !== (value.author === scope.owner)
        || typeof value.seen !== "boolean" || typeof value.liked !== "boolean"
        || (value.mine ? !integer(value.view_count) || !integer(value.like_count) : value.view_count !== null || value.like_count !== null)
        || (value.created_at !== undefined && !iso(value.created_at))) throw failure(502);
      if (Date.parse(value.expires_at) <= wallNow()) throw failure(404);
      const row = pick(value, ["id", "author", "photo", "kind", "audience", "ts", "expires_at", "mine", "seen", "liked", "view_count", "like_count"]);
      if (value.created_at !== undefined) row.created_at = value.created_at;
      return Object.freeze(row);
    },
    _cursor(value) {
      if (value === null) return null;
      if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== "at,id"
        || !iso(value.at) || !uuid(value.id) || bytes(JSON.stringify(value)) > 200) throw failure(400);
      return { at: value.at, id: value.id };
    },
    _page(value, project, before = null) {
      if (!value || !Array.isArray(value.items) || value.items.length > 50 || value.next_cursor === undefined) throw failure(502);
      const items = value.items.map(project), cursor = this._cursor(value.next_cursor);
      if (new Set(items.map(row => row.id)).size !== items.length || (cursor && (items.length !== 50
        || cursor.id !== items.at(-1).id || JSON.stringify(cursor) === JSON.stringify(before)))) throw failure(502);
      return { items, next_cursor: cursor };
    },
    _upsert(row, notify = true) {
      this._known.add(row.id);
      const index = this.feed.findIndex(item => item.id === row.id);
      if (index < 0) this.feed.push(row); else this.feed[index] = row;
      if (this._play?.row.id === row.id) this._play.row = row;
      this._updateActions?.();
      if (notify) this._notify("onChange");
    },
    _drop(id) {
      this._rowEpoch.set(id, (this._rowEpoch.get(id) || 0) + 1);
      this.feed = this.feed.filter(row => row.id !== id); this._known.delete(id);
      if (this._play?.row.id === id) this._unavailable?.(failure(404));
      this._notify("onChange");
    },
    async get(id) {
      if (!this.enabled()) return null;
      const scope = this._scope(), revision = this._revision;
      if (!uuid(id)) throw failure(400);
      const epoch = (this._rowEpoch.get(id) || 0) + 1;
      this._rowEpoch.set(id, epoch);
      try {
        const row = this._shape(await this._call("get_story", { p_id: id }, scope), scope);
        this._assert(scope);
        if (epoch !== this._rowEpoch.get(id) || revision !== this._revision) throw failure(409);
        this._upsert(row); return row;
      } catch (error) {
        if (this._current(scope) && epoch === this._rowEpoch.get(id) && error.status === 404) this._drop(id);
        throw error;
      }
    },
    async refresh(cursor = null) {
      if (!this.enabled()) return null;
      const scope = this._scope(), before = this._cursor(cursor), epoch = ++this._feedEpoch;
      const revisions = new Map(this._rowEpoch);
      if (before && JSON.stringify(before) !== JSON.stringify(this.nextCursor)) throw failure(400);
      try {
        const page = this._page(await this._call("story_feed", { p_cursor: before }, scope), row => this._shape(row, scope), before);
        this._assert(scope);
        if (epoch !== this._feedEpoch) throw failure(409);
        if (!before) {
          this.feed = this.feed.filter(row => this._rowEpoch.get(row.id) !== revisions.get(row.id));
          this._known = new Set(this.feed.map(row => row.id));
        }
        for (const row of page.items) if (this._rowEpoch.get(row.id) === revisions.get(row.id)) this._upsert(row, false);
        this.nextCursor = page.next_cursor; this.error = null;
        this._notify("onChange");
        return page;
      } catch (error) { if (this._current(scope) && epoch === this._feedEpoch) this.error = error; throw error; }
    },
    groups() {
      const grouped = new Map();
      for (const row of this.storyFeed) {
        if (!grouped.has(row.author)) grouped.set(row.author, { author: row.author, items: [] });
        grouped.get(row.author).items.push(row);
      }
      return [...grouped.values()].map(group => ({ ...group, items: group.items.sort((left, right) => left.ts - right.ts || left.id.localeCompare(right.id)) }))
        .sort((left, right) => left.author === this._owner ? -1 : right.author === this._owner ? 1 : right.items.at(-1).ts - left.items.at(-1).ts);
    },
    _preferences(value, status = 502) {
      if (!value || ["likes", "replies", "sound"].some(key => typeof value[key] !== "boolean")
        || !["none", "authenticated"].includes(value.reply_permission) || !integer(value.version)) throw failure(status);
      return pick(value, ["likes", "replies", "sound", "reply_permission", "version"]);
    },
    _receipt(value, action, requestId, scope, body = {}) {
      if (!value || value.action !== action || value.request_id !== requestId || !uuid(requestId)
        || value.committed !== true || typeof value.duplicate !== "boolean") throw failure(502);
      let fields;
      switch (action) {
        case "publish":
          if (!uuid(value.id) || value.author !== scope.owner || !iso(value.created_at) || !iso(value.expires_at)) throw failure(502);
          fields = ["id", "author", "created_at", "expires_at"]; break;
        case "delete":
          if (!uuid(value.id) || (body.p_id && value.id !== body.p_id) || value.author !== scope.owner || !iso(value.deleted_at)) throw failure(502);
          fields = ["id", "author", "deleted_at"]; break;
        case "view":
          if (!uuid(value.id) || (body.p_id && value.id !== body.p_id) || typeof value.qualified !== "boolean"
            || (value.qualified ? !iso(value.qualified_at) : value.qualified_at !== null)) throw failure(502);
          fields = ["id", "qualified", "qualified_at"]; break;
        case "like":
          if (!uuid(value.id) || (body.p_id && value.id !== body.p_id) || typeof value.liked !== "boolean"
            || (body.p_desired !== undefined && value.liked !== body.p_desired)) throw failure(502);
          fields = ["id", "liked"]; break;
        case "reply":
          if (!messageId(value.id) || !uuid(value.story_id) || (body.p_id && value.story_id !== body.p_id)
            || value.from !== scope.owner || !uuid(value.to) || value.to === scope.owner || !integer(value.ts)) throw failure(502);
          fields = ["id", "story_id", "from", "to", "ts"]; break;
        case "preferences":
          this._preferences(value); fields = ["likes", "replies", "sound", "reply_permission", "version"]; break;
        case "block":
          if (!uuid(value.id) || (body.p_member && value.id !== body.p_member) || typeof value.blocked !== "boolean"
            || (body.p_blocked !== undefined && value.blocked !== body.p_blocked)) throw failure(502);
          fields = ["id", "blocked"]; break;
        case "report":
          if (!uuid(value.id) || value.status !== "received") throw failure(502);
          fields = ["id", "status"]; break;
        case "read_notifications":
          if (!Array.isArray(value.ids) || !value.ids.length || value.ids.length > 50 || !value.ids.every(uuid) || value.read !== true
            || new Set(value.ids).size !== value.ids.length || (body.p_ids && JSON.stringify(value.ids) !== JSON.stringify([...new Set(body.p_ids)].sort()))) throw failure(502);
          fields = ["ids", "read"]; break;
        default: throw failure(502);
      }
      return Object.freeze(pick(value, ["action", "request_id", "committed", "duplicate", ...fields]));
    },
    async _mutate(action, name, target, body, after, explicitId, slot = action) {
      if (!this.enabled()) return null;
      const scope = this._scope(), revision = this._revision, payload = JSON.stringify(body);
      const pendingKey = scope.owner + ":" + slot + ":" + target;
      const existing = this.pending.get(pendingKey);
      if (existing) {
        if (existing.payload !== payload || (explicitId && existing.id !== explicitId)) throw failure(409);
        return existing.promise;
      }
      if (this.pending.size >= this.limits.pending) throw failure(429);
      const held = this._request(slot, target, payload, explicitId, scope);
      const flight = { payload, id: held.id };
      flight.promise = Promise.resolve().then(async () => {
        this._assert(scope);
        if (revision !== this._revision) throw failure(409);
        const receipt = this._receipt(await this._call(name, { ...body, p_request_id: held.id }, scope), action, held.id, scope, body);
        this._assert(scope);
        if (revision !== this._revision) throw failure(409);
        const result = after ? await after(receipt, scope) : receipt;
        this._assert(scope);
        if (revision !== this._revision) throw failure(409);
        this._settle(held, scope); this.error = null;
        return result;
      }).catch(error => {
        if (this._current(scope)) { held.failure = error.status; if (revision === this._revision) this.error = error; }
        throw error;
      }).finally(() => {
        if (this.pending.get(pendingKey) === flight) this.pending.delete(pendingKey);
        if (this._current(scope)) this._updateActions?.();
      });
      this.pending.set(pendingKey, flight); this._updateActions?.();
      return flight.promise;
    },
    async publish(url, kind, requestId, mediaReceipt) {
      if (!this.enabled()) return null;
      const scope = this._scope();
      if (!this._media(url, kind, scope.owner)) throw failure(400);
      const validated = host.STORY_MEDIA_VALIDATION === true;
      if (validated && (!mediaReceipt || mediaReceipt.owner !== scope.owner || mediaReceipt.request_id !== requestId
        || !uuid(mediaReceipt.reservation_id) || !/^[a-f0-9]{64}$/.test(mediaReceipt.sha256)
        || mediaReceipt.media_url !== url || mediaReceipt.kind !== kind || mediaReceipt.schema_version !== 2
        || mediaReceipt.bucket !== "story-media-quarantine-v3" || mediaReceipt.public_bucket !== "story-media-public-v3"
        || !uuid(mediaReceipt.public_object_id) || typeof mediaReceipt.public_object_version !== "string" || !mediaReceipt.public_object_version
        || !["approved", "published"].includes(mediaReceipt.status) || mediaReceipt.actual_bytes !== mediaReceipt.declared_bytes
        || (kind === "video" && (mediaReceipt.duration_verified !== true || !integer(mediaReceipt.duration_ms)
          || mediaReceipt.duration_ms < 1 || mediaReceipt.duration_ms > 30000)))) throw failure(400);
      const body = validated ? { p_reservation_id: mediaReceipt.reservation_id, p_sha256: mediaReceipt.sha256 }
        : { p_media_url: url, p_kind: kind, p_audience: "authenticated" };
      return this._mutate("publish", validated ? "publish_validated_story" : "publish_story", scope.owner, body, async receipt => {
        let row;
        try { row = await this.get(receipt.id); } catch (error) { if (error.status !== 404) throw error; row = null; }
        if (row && (row.author !== scope.owner || row.photo !== url || row.kind !== kind)) throw failure(502);
        return { receipt, row };
      }, requestId, "publish_" + kind);
    },
    async remove(id, requestId) {
      if (!this.enabled()) return null;
      if (!uuid(id)) throw failure(400);
      const row = this.storyFeed.find(item => item.id === id);
      if (row && !row.mine) throw failure(403);
      return this._mutate("delete", "delete_story", id, { p_id: id }, receipt => { this._drop(id); return receipt; }, requestId);
    },
    async setLike(id, desired) {
      if (!this.enabled()) return null;
      if (!uuid(id) || typeof desired !== "boolean") throw failure(400);
      const scope = this._scope(), row = this.storyFeed.find(item => item.id === id);
      if (row?.mine) throw failure(400);
      const active = this._likes.get(id);
      if (active) { active.desired = desired; return active.promise; }
      const intent = { desired };
      intent.promise = Promise.resolve().then(async () => {
        let result;
        for (let pass = 0; pass < 2; pass++) {
          this._assert(scope);
          const sending = intent.desired;
          result = await this._mutate("like", "set_story_like", id, { p_id: id, p_desired: sending }, async receipt => {
            const latest = await this.get(id);
            return { receipt, row: latest };
          });
          if (intent.desired === sending || intent.desired === result.row.liked) break;
        }
        return result;
      }).finally(() => { if (this._likes.get(id) === intent) this._likes.delete(id); this._updateActions?.(); });
      this._likes.set(id, intent); this._updateActions?.();
      return intent.promise;
    },
    async reply(id, text, requestId) {
      if (!this.enabled()) return null;
      if (!uuid(id) || !plain(text)) throw failure(400);
      const row = this.storyFeed.find(item => item.id === id);
      if (row?.mine) throw failure(400);
      return this._mutate("reply", "reply_to_story", id, { p_id: id, p_text: text }, receipt => {
        if (row && receipt.to !== row.author) throw failure(502);
        return receipt;
      }, requestId);
    },
    async resolveContext(id) {
      if (!this.enabled() || !messageId(id)) return { available: false };
      const scope = this._scope(), result = await this._call("resolve_story_reply_context", { p_message_id: id }, scope);
      this._assert(scope);
      if (result?.available === false) return { available: false };
      if (result?.available !== true) throw failure(502);
      try { return { available: true, story: this._shape(result.story, scope) }; }
      catch (error) { if (error.status === 404) return { available: false }; throw error; }
    },
    // Reference markers only: which of the supplied message IDs are Story replies. Never returns a story ID, media or body.
    async replyReferences(ids) {
      if (!this.enabled()) return [];
      if (!Array.isArray(ids)) throw failure(400);
      const exact = [...new Set(ids)];
      if (!exact.length) return [];
      if (exact.length > this.limits.pageItems || !exact.every(messageId)) throw failure(400);
      const scope = this._scope();
      const result = await this._call("story_reply_references", { p_message_ids: exact }, scope);
      this._assert(scope);
      const rows = result?.message_ids;
      if (!result || Object.keys(result).length !== 1 || !Array.isArray(rows) || rows.length > exact.length
        || new Set(rows).size !== rows.length || !rows.every(row => messageId(row) && exact.includes(row))) throw failure(502);
      return rows;
    },
    async viewers(id, cursor = null) {
      if (!this.enabled()) return null;
      const scope = this._scope(), before = this._cursor(cursor);
      if (!uuid(id)) throw failure(400);
      if (this.storyFeed.find(item => item.id === id)?.mine === false) throw failure(403);
      return this._page(await this._call("story_viewers", { p_id: id, p_cursor: before }, scope), value => {
        if (!value || !uuid(value.id) || !iso(value.qualified_at) || typeof value.liked !== "boolean"
          || typeof value.name !== "string" || [...value.name].length > 80 || typeof value.username !== "string" || [...value.username].length > 64) throw failure(502);
        return pick(value, ["id", "name", "username", "qualified_at", "liked"]);
      }, before);
    },
    async getPreferences() {
      if (!this.enabled()) return null;
      const scope = this._scope();
      const result = this._preferences(await this._call("get_story_notification_preferences", {}, scope));
      this._assert(scope); this.preference = result; return result;
    },
    async setPreferences(value, requestId) {
      if (!this.enabled()) return null;
      const scope = this._scope(), desired = this._preferences(value, 400);
      const body = Object.fromEntries(Object.entries(desired).map(([key, entry]) => ["p_" + key, entry]));
      return this._mutate("preferences", "set_story_notification_preferences", scope.owner, body, async receipt => {
        const preferences = await this.getPreferences();
        return { receipt, preferences };
      }, requestId);
    },
    async notifications(cursor = null) {
      if (!this.enabled()) return null;
      const scope = this._scope(), before = this._cursor(cursor);
      const page = this._page(await this._call("list_story_notifications", { p_cursor: before }, scope), value => {
        if (!value || !uuid(value.id) || !uuid(value.actor) || !uuid(value.story_id) || !["like", "reply"].includes(value.kind)
          || !iso(value.created_at) || (value.read_at !== null && !iso(value.read_at)) || typeof value.available !== "boolean"
          || (value.message_id !== null && !messageId(value.message_id))) throw failure(502);
        return pick(value, ["id", "actor", "story_id", "kind", "message_id", "created_at", "read_at", "available"]);
      }, before);
      this._assert(scope); this._notificationPage = page; this._notificationScope = scope; return page;
    },
    async markRead(ids, requestId) {
      if (!this.enabled()) return null;
      const scope = this._scope();
      if (!Array.isArray(ids) || !ids.length || ids.length > 50 || !ids.every(uuid)) throw failure(400);
      const exact = [...new Set(ids)].sort();
      if (!this._notificationRoot?.isConnected || !exact.every(id => this._visibleNotifications.has(id)
        && this._notificationRoot.querySelector('[data-story-notification-id="' + id + '"]'))) throw failure(403);
      return this._mutate("read_notifications", "mark_story_notifications_read", scope.owner, { p_ids: exact }, receipt => {
        for (const id of receipt.ids) { this._visibleNotifications.delete(id); this._readIds.add(id); }
        return receipt;
      }, requestId);
    },
    async setBlock(member, blocked, requestId) {
      if (!this.enabled()) return null;
      const scope = this._scope();
      if (!uuid(member) || member === scope.owner || typeof blocked !== "boolean") throw failure(400);
      return this._mutate("block", "set_story_block", member, { p_member: member, p_blocked: blocked }, receipt => {
        if (blocked) {
          for (const row of this.feed.filter(item => item.author === member)) this._drop(row.id);
        }
        return receipt;
      }, requestId);
    },
    async report(id, reason, contextMessageId = null, requestId) {
      if (!this.enabled()) return null;
      if (!uuid(id) || !plain(reason, true) || (contextMessageId !== null && !messageId(contextMessageId))) throw failure(400);
      return this._mutate("report", "report_story_content", contextMessageId ?? id,
        { p_id: id, p_message_id: contextMessageId, p_reason: reason }, null, requestId, contextMessageId === null ? "report" : "report_message");
    },
    async receipt(requestId) {
      if (!this.enabled()) return null;
      const scope = this._scope();
      if (!uuid(requestId)) throw failure(400);
      const result = await this._call("story_action_receipt", { p_request_id: requestId }, scope);
      return this._receipt(result, result?.action, requestId, scope);
    },
    async reconcile(action, target) {
      if (!this.enabled()) return null;
      const scope = this._scope();
      const key = "fm_stories_request_" + scope.owner + "_" + action + "_" + this._storageTarget(action, target);
      if (this.pending.has(scope.owner + ":" + action + ":" + target)) throw failure(409);
      let held = this._intents.get(key), id = held?.id;
      if (!id) { try { id = this._storedRequest(key)?.id; } catch (_) { throw failure(503); } }
      if (!uuid(id)) return null;
      let receipt;
      try { receipt = await this.receipt(id); }
      catch (error) {
        if (error.status === 404 && held && [400, 403, 404, 409, 429, 503].includes(held.failure)) {
          this._settle(held, scope); return null;
        }
        throw error;
      }
      this._assert(scope);
      if (receipt.action !== action.replace(/^publish_.+$/, "publish").replace(/^report_message$/, "report")) {
        if (held && [400, 403, 404, 409, 429, 503].includes(held.failure)) { this._settle(held, scope); return null; }
        throw failure(409);
      }
      if (!held) { held = { key, id }; this._intents.set(key, held); }
      this._settle(held, scope);
      return receipt;
    }
  };
  Object.defineProperty(api, "storyFeed", { get() {
    if (!this.enabled() || this._owner !== this.owner()) return [];
    return this.feed.filter(row => this._known.has(row.id) && Date.parse(row.expires_at) > wallNow());
  } });
  Object.assign(api, {
    _text(value) { return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character])); },
    _icon(name, solid = false) { return app()?.ic ? app().ic(name, { size: 20, solid }) : this._text(name); },
    _button(action, label, icon, extra = "", text = "") {
      return `<button type="button" class="icon-btn" id="stories-${action}" data-stories-action="${action}" title="${this._text(label)}" aria-label="${this._text(label)}" style="width:${action === "pause" ? "96px" : text ? "auto" : "44px"};height:auto;min-width:${action === "pause" ? 96 : 44}px;min-height:44px;max-width:100%;padding:${text ? "6px 10px" : "0"};white-space:normal;flex-shrink:0;color:inherit;display:inline-flex;gap:4px;align-items:center;justify-content:center" ${extra}>${this._icon(icon)}${text ? `<span style="min-width:0;overflow-wrap:anywhere">${this._text(text)}</span>` : ""}</button>`;
    },
    _element(id) { return this._root?.querySelector("#stories-" + id) || null; },
    _feedback(error, notice = false) {
      if (!this._root) return;
      const output = this._panel?.querySelector(notice ? "#stories-panel-notice" : "#stories-panel-error") || this._element(notice ? "notice" : "error");
      if (output) output.textContent = typeof error === "string" ? error : error?.message || failure(502).message;
    },
    _listen(target, name, handler, settings, collection = this._listeners) {
      target.addEventListener(name, handler, settings);
      collection.push(() => target.removeEventListener(name, handler, settings));
    },
    _mount() {
      if (this._root) return;
      const document = doc();
      if (!document?.body) throw failure(503);
      if (document.getElementById("story-viewer")) throw failure(409);
      const root = document.createElement("div");
      root.id = "story-viewer"; root.className = "story-viewer"; root.dataset.storiesV2 = "true";
      root.setAttribute("role", "dialog"); root.setAttribute("aria-modal", "true"); root.setAttribute("aria-label", "Stories");
      root.tabIndex = -1; root.style.touchAction = "pan-y";
      root.innerHTML = `<div class="sv-card" style="display:grid;grid-template-rows:auto minmax(0,1fr) auto;height:min(100dvh,860px);max-height:100dvh;border-radius:8px">
        <header id="stories-header"></header><div id="stories-stage" style="position:relative;min-height:0;overflow:hidden"></div>
        <footer id="stories-footer" style="padding:6px 10px max(8px,env(safe-area-inset-bottom));background:#111;color:#fff"></footer></div>`;
      this._returnFocus = document.activeElement; this._listeners = []; this._background = [];
      for (const element of document.body.children) {
        if (["SCRIPT", "STYLE", "LINK"].includes(element.tagName)) continue;
        this._background.push({ element, inert: element.inert, inertAttribute: element.hasAttribute("inert"), hidden: element.getAttribute("aria-hidden") });
        element.inert = true; element.setAttribute("aria-hidden", "true");
      }
      this._previousOverflow = document.body.style.overflow; document.body.style.overflow = "hidden";
      document.body.appendChild(root); this._root = root;
      this._listen(root, "click", event => {
        event.stopPropagation();
        const button = event.target.closest("[data-stories-action]");
        if (!button || button.disabled) return;
        const revision = this._revision, owner = this.owner();
        Promise.resolve().then(() => this._dispatch(button.dataset.storiesAction, button)).catch(error => {
          if (this._root === root && this._revision === revision && this.owner() === owner) {
            this._feedback(error);
            if (error.status === 409) {
              const action = button.dataset.storiesAction;
              if (action === "like" && this._play) this._offerRecovery("like", this._play.row.id);
              if (action === "notifications-read") this._offerRecovery("read_notifications", owner);
              if (action === "confirm-action" && this._confirmation) this._offerRecovery(this._confirmation.action, this._confirmation.target);
            }
          }
        });
      });
      this._listen(root, "keydown", event => this._key(event));
      this._listen(root, "focusin", event => { if (event.target.matches("textarea,input,select,[contenteditable=true]")) this.pause("editing", true); });
      this._listen(root, "focusout", () => {
        Promise.resolve().then(() => { if (this._root === root) this.pause("editing", !!document.activeElement?.matches("textarea,input,select,[contenteditable=true]")); });
      });
      this._listen(root, "input", event => {
        if (event.target.id === "stories-reply" && this._play) this._drafts.set(this._play.row.id, event.target.value);
      });
      this._listen(root, "pointerdown", event => {
        event.stopPropagation();
        if (!this._play || !event.target.closest("#stories-stage") || event.target.closest("button")) return;
        this._gesture = { pointer: event.pointerId, type: event.pointerType, x: event.clientX, y: event.clientY };
        this.pause("hold", true);
        this._element("stage").setPointerCapture?.(event.pointerId);
      });
      const release = event => {
        event.stopPropagation();
        const gesture = this._gesture; this._gesture = null;
        if (!gesture) return;
        this.pause("hold", false);
        const horizontal = event.clientX - gesture.x, vertical = event.clientY - gesture.y;
        if (event.type !== "pointercancel" && gesture.type === "touch" && Math.abs(horizontal) >= 60 && Math.abs(vertical) < Math.abs(horizontal) * 0.6) {
          (horizontal < 0 ? this.next() : this.previous()).catch(error => this._feedback(error));
        }
      };
      this._listen(root, "pointerup", release); this._listen(root, "pointercancel", release);
      for (const name of ["touchstart", "touchmove", "touchend"]) this._listen(root, name, event => event.stopPropagation(), { passive: true });
      const stage = this._element("stage");
      this._listen(stage, "pointerenter", event => { if (event.pointerType === "mouse") { this._hovered = true; this.pause("hover", true); } });
      this._listen(stage, "pointerleave", event => { if (event.pointerType === "mouse") { this._hovered = false; this.pause("hover", false); } });
      this._listen(host, "blur", () => { this.pause("blur", true); if (this._play?.media) this._play.media.style.visibility = "hidden"; });
      this._listen(host, "focus", () => this._resumeChecked("blur"));
      this._listen(document, "visibilitychange", () => {
        if (document.hidden) { this.pause("hidden", true); if (this._play?.media) this._play.media.style.visibility = "hidden"; }
        else this._resumeChecked("hidden");
      });
      root.focus();
    },
    _unmount() {
      if (!this._root) return;
      for (const remove of this._listeners || []) remove(); this._listeners = [];
      this._root.remove(); this._root = null; this._panel = null; this._panelRevision = (this._panelRevision || 0) + 1;
      for (const prior of this._background || []) {
        prior.element.inert = prior.inert;
        if (prior.inertAttribute) prior.element.setAttribute("inert", ""); else prior.element.removeAttribute("inert");
        if (prior.hidden === null) prior.element.removeAttribute("aria-hidden"); else prior.element.setAttribute("aria-hidden", prior.hidden);
      }
      this._background = []; doc().body.style.overflow = this._previousOverflow;
      if (this._returnFocus?.isConnected) this._returnFocus.focus();
      this._returnFocus = null; this._gesture = null;
    },
    _key(event) {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); if (this._panel) this.closePanel(); else this.close(); return; }
      if (event.key === "Tab") {
        const area = this._panel || this._root;
        const candidates = [...area.querySelectorAll('button:not(:disabled),textarea:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')]
          .filter(element => element.getClientRects().length && !element.closest("[hidden],[inert]"));
        const first = candidates[0], last = candidates.at(-1);
        if (!first) { event.preventDefault(); area.focus(); }
        else if (event.shiftKey && (doc().activeElement === first || !area.contains(doc().activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (doc().activeElement === last || !area.contains(doc().activeElement))) { event.preventDefault(); first.focus(); }
        return;
      }
      if (this._panel || event.target.matches("textarea,input,select,[contenteditable=true]")) return;
      if ([" ", "Spacebar", "ArrowLeft", "ArrowRight"].includes(event.key)) event.preventDefault();
      if (event.key === " " || event.key === "Spacebar") this.togglePause();
      if (event.key === "ArrowLeft") this.previous().catch(error => this._feedback(error));
      if (event.key === "ArrowRight") this.next().catch(error => this._feedback(error));
    },
    async open(authorOrId) {
      if (!this.enabled()) return null;
      const scope = this._scope();
      if (!uuid(authorOrId)) throw failure(400);
      this._mount();
      this._openTarget = authorOrId;
      this._revision++; const revision = this._revision;
      this._cleanPlayback(); this._loading();
      try {
        if (!this.storyFeed.length) await this.refresh();
        this._assert(scope);
        if (revision !== this._revision || !this._root) return null;
        const groups = this.groups(), author = groups.find(group => group.author === authorOrId);
        this._ids = groups.flatMap(group => group.items.map(row => row.id));
        if (author) this._index = this._ids.indexOf(author.items.find(row => !row.seen)?.id || author.items[0].id);
        else {
          this._index = this._ids.indexOf(authorOrId);
          if (this._index < 0) { this._ids = [authorOrId]; this._index = 0; }
        }
        return await this._show();
      } catch (error) {
        if (this._current(scope) && revision === this._revision && this._root) this._unavailable(error);
        throw error;
      }
    },
    _loading() {
      if (!this._root) return;
      this._element("header").innerHTML = `<div class="sv-head" style="position:static;padding:10px;cursor:default"><div class="sv-name" style="flex:1">Story</div>${this._button("close", "Close stories", "close")}</div>`;
      this._element("stage").innerHTML = `<div id="stories-media-status" role="status" style="display:grid;place-content:center;height:100%;text-align:center;color:#fff"><progress aria-label="Loading story" style="max-width:100%"></progress><p>Loading...</p></div>`;
      this._element("footer").innerHTML = `<p id="stories-error" role="alert" style="margin:0;overflow-wrap:anywhere"></p><p id="stories-notice" role="status" style="margin:0"></p>`;
      this._element("close").focus();
    },
    async _show() {
      const scope = this._scope(), focusId = doc().activeElement?.id;
      const revision = ++this._revision, id = this._ids[this._index];
      if (this._panel) this._clearPanel();
      this._cleanPlayback(); this._loading();
      if (!id) return null;
      try {
        const row = await this.get(id);
        this._assert(scope);
        if (revision !== this._revision || !this._root) return null;
        this._render(row, scope, revision);
        const focus = doc().getElementById(focusId?.startsWith("stories-") ? focusId : "stories-close");
        if (focus && this._root.contains(focus) && !focus.disabled) focus.focus(); else this._element("close").focus();
        return row;
      } catch (error) {
        if (this._current(scope) && revision === this._revision && this._root) this._unavailable(error);
        throw error;
      }
    },
    _render(row, scope, revision) {
      const person = (row.mine ? social()?.me?.() : social()?.cloudUser?.(row.author)) || {};
      const name = typeof person.name === "string" ? [...person.name].slice(0, 80).join("") : "Member";
      const safeAvatar = typeof person.avatar === "string" && person.avatar.startsWith(this._base().origin + "/storage/v1/object/public/") && !/[<>"'\s]/.test(person.avatar) ? person.avatar : null;
      const avatar = social()?.avatar ? social().avatar({ name, avatar: safeAvatar, colors: ["#444", "#222"] }, 34)
        : `<span class="av" style="width:34px;height:34px;flex-shrink:0;background:#333">${this._text(name.slice(0, 1))}</span>`;
      this._element("header").innerHTML = `<div class="sv-bars" style="position:static;padding:8px 8px 0">${this._ids.map((id, index) => `<span class="sv-bar"><b ${index === this._index ? 'id="stories-progress"' : ""} style="width:${index < this._index ? 100 : 0}%;transition:none"></b></span>`).join("")}</div>
        <div class="sv-head" style="position:static;cursor:default;padding:6px 10px;gap:6px">${avatar}<div style="flex:1;min-width:0"><div class="sv-name" style="overflow-wrap:anywhere;line-height:1.2">${this._text(name)}</div><time class="sv-time" datetime="${this._text(row.expires_at)}" title="Expires ${this._text(new Date(row.expires_at).toLocaleString())}">${this._text(new Date(row.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</time></div>${this._button("close", "Close stories", "close")}</div>`;
      const stage = this._element("stage");
      stage.innerHTML = `<div id="stories-media-status" role="status" style="position:absolute;inset:0;display:grid;place-content:center;text-align:center;color:#fff"><progress aria-label="Loading media"></progress><p>Loading...</p></div>${this._navigation()}`;
      const media = doc().createElement(row.kind === "photo" ? "img" : "video");
      media.className = "sv-media"; media.id = "stories-media"; media.draggable = false; media.style.display = "block";
      if (row.kind === "photo") media.alt = "Story photo";
      else { media.playsInline = true; media.muted = this.muted; media.preload = "auto"; }
      stage.prepend(media);
      this._element("footer").innerHTML = `<div style="display:flex;gap:4px;align-items:center;justify-content:space-between;flex-wrap:wrap">
        ${row.mine ? this._button("viewers", "Viewers and likes", "users", "", row.view_count + " views") : this._button("like", "Like story", "heart", 'aria-pressed="false"')}
        ${this._button("pause", "Pause story", "film", 'aria-pressed="false"', "Pause")}
        ${row.kind === "video" ? this._button("mute", this.muted ? "Unmute story" : "Mute story", this.muted ? "mute" : "volume", 'aria-pressed="' + this.muted + '"') : ""}
        ${row.mine ? this._button("settings", "Story preferences", "cog") + this._button("delete", "Delete story", "trash")
          : this._button("report", "Report story", "flag") + this._button("block", "Block member", "ban")}</div>
        ${row.mine ? `<div id="stories-counts" class="sub" style="color:#ddd;padding:4px 0">${row.view_count} views / ${row.like_count} likes</div>` : `<form id="stories-reply-form" style="display:flex;gap:8px;margin-top:6px;align-items:center"><textarea id="stories-reply" aria-label="Reply to story" placeholder="Reply" maxlength="512" rows="2" style="flex:1;min-width:0;width:100%;min-height:48px;resize:vertical;max-height:110px;font-size:16px"></textarea><button id="stories-send" type="submit" class="send-ico" title="Send reply" aria-label="Send reply" style="width:44px;min-width:44px;min-height:48px">${this._icon("send")}</button></form>`}
        <p id="stories-error" role="alert" style="font-size:13px;margin:4px 0 0;overflow-wrap:anywhere"></p><p id="stories-notice" role="status" style="font-size:13px;margin:4px 0 0;overflow-wrap:anywhere"></p>
        <div id="stories-recovery"></div>`;
      const play = { row, scope, revision, media, ready: false, waiting: row.kind === "video", pauses: new Set(),
        last: null, elapsed: 0, qualifiedMs: 0, viewAttempted: row.mine || row.seen, progressSeen: false, mediaTime: 0, progressAt: now(), handlers: [] };
      this._play = play;
      if (this._hovered) play.pauses.add("hover");
      if (doc().hidden) play.pauses.add("hidden");
      if (doc().hasFocus && !doc().hasFocus()) play.pauses.add("blur");
      if (play.pauses.has("hidden") || play.pauses.has("blur")) media.style.visibility = "hidden";
      const editor = this._element("reply");
      if (editor) {
        editor.value = this._drafts.get(row.id) || "";
        this._listen(this._element("reply-form"), "submit", event => { event.preventDefault(); this._sendReply().catch(error => this._feedback(error)); }, undefined, play.handlers);
      }
      const current = () => this._play === play && this._revision === revision && this._current(scope);
      this._listen(media, "error", () => { if (current()) this._unavailable(failure(502)); }, undefined, play.handlers);
      if (row.kind === "photo") {
        const loaded = async () => {
          try {
            if (media.decode) await media.decode();
            if (!current()) return;
            if (!media.complete || !media.naturalWidth) throw failure(502);
            this._ready(play);
          } catch (_) { if (current()) this._unavailable(failure(502)); }
        };
        this._listen(media, "load", loaded, undefined, play.handlers);
      } else {
        const playing = () => {
          if (!current() || media.readyState < 3 || !Number.isFinite(media.duration) || media.duration <= 0 || media.paused) return;
          play.waiting = false; play.pauses.delete("autoplay"); play.pauses.delete("media"); this._ready(play);
        };
        for (const name of ["playing", "canplay", "durationchange"]) this._listen(media, name, playing, undefined, play.handlers);
        for (const name of ["waiting", "stalled", "seeking"]) this._listen(media, name, () => {
          if (!current()) return;
          play.waiting = true; play.progressSeen = false; this._stopClock(play);
        }, undefined, play.handlers);
        this._listen(media, "pause", () => {
          if (!current()) return;
          if (!play.pauses.size && !media.ended) play.pauses.add("media");
          this._stopClock(play); this._updateActions();
        }, undefined, play.handlers);
        this._listen(media, "ended", () => {
          if (current() && play.ready && play.progressSeen && !play.waiting && !play.pauses.size && this._foreground()
            && media.currentTime >= this.getDuration() - 0.15) this.next(true).catch(error => this._feedback(error));
        }, undefined, play.handlers);
      }
      this._expiryTimer = later(() => {
        if (this._play !== play) return;
        if (!this._current(scope)) this.reset(); else this._unavailable(failure(404));
      }, Math.max(0, Date.parse(row.expires_at) - wallNow()));
      this._loadTimer = later(() => { if (current() && !play.ready) this._unavailable(failure(504)); }, this.limits.deadlineMs);
      media.src = row.photo;
      if (row.kind === "video") this._playVideo(play);
      this._updateActions();
    },
    _navigation() {
      return this._button("prev", "Previous story", "chevronR", this._index <= 0 ? "disabled" : "")
        + this._button("next", "Next story", "chevronR", this._index >= this._ids.length - 1 ? "disabled" : "");
    },
    _positionNavigation() {
      for (const direction of ["prev", "next"]) {
        const button = this._element(direction); if (!button) continue;
        button.classList.add("sv-tap", direction);
        Object.assign(button.style, { position: "absolute", width: "44px", height: "64px", top: "50%", bottom: "auto", transform: "translateY(-50%)", background: "rgba(0,0,0,.45)", borderRadius: "8px", zIndex: "2" });
        button.style[direction === "prev" ? "left" : "right"] = "0";
        if (direction === "prev") { const icon = button.querySelector(".ic"); if (icon) icon.style.transform = "rotate(180deg)"; }
      }
    },
    _ready(play) {
      if (this._play !== play) return;
      play.ready = true; cancelLater(this._loadTimer); this._loadTimer = null;
      const status = this._element("media-status"); if (status) status.remove();
      this._queueTick(); this._updateActions();
    },
    _foreground() {
      const document = doc();
      return !document?.hidden && (!document?.hasFocus || document.hasFocus());
    },
    _stopClock(play = this._play) {
      cancelLater(this._tickTimer); this._tickTimer = null;
      if (play) { play.last = null; play.qualifiedMs = 0; }
    },
    _queueTick() {
      const play = this._play;
      if (!play || !play.ready || play.pauses.size || play.waiting || !this._foreground() || this._tickTimer != null) return;
      if (play.last === null) play.last = now();
      this._tickTimer = later(() => { this._tickTimer = null; this._tick(); }, 100);
    },
    _tick() {
      const play = this._play;
      if (!play) return;
      if (!this._current(play.scope)) { this.reset(); return; }
      if (Date.parse(play.row.expires_at) <= wallNow()) { this._unavailable(failure(404)); return; }
      if (!this._foreground() || play.pauses.size || !play.ready || play.waiting) { this._stopClock(play); return; }
      const stamp = now();
      let elapsed = play.last === null ? 0 : stamp - play.last;
      if (elapsed < 0 || elapsed > 500) { play.qualifiedMs = 0; elapsed = 0; }
      play.last = stamp;
      if (play.row.kind === "video") {
        if (play.media.currentTime > play.mediaTime) { play.progressAt = stamp; play.progressSeen = true; }
        if (play.media.currentTime < play.mediaTime) { play.progressSeen = false; play.qualifiedMs = 0; }
        play.mediaTime = play.media.currentTime;
        if (play.media.paused || play.media.readyState < 3 || !play.progressSeen || stamp - play.progressAt > 500) {
          play.qualifiedMs = 0; elapsed = 0;
        }
      }
      play.elapsed += elapsed; play.qualifiedMs += elapsed;
      const duration = this.getDuration(), position = play.row.kind === "photo" ? play.elapsed / 1000 : play.media.currentTime;
      const progress = this._element("progress");
      if (progress && duration) progress.style.width = Math.min(100, position / duration * 100) + "%";
      if (play.qualifiedMs >= this.limits.qualifySeconds * 1000 && !play.viewAttempted && !play.row.mine) this._recordQualified(play);
      if (play.row.kind === "photo" && play.elapsed >= this.limits.photoSeconds * 1000) { this.next(true).catch(error => this._feedback(error)); return; }
      this._queueTick();
    },
    getDuration() {
      const play = this._play;
      if (!play) return null;
      return play.row.kind === "photo" ? this.limits.photoSeconds : Number.isFinite(play.media.duration) && play.media.duration > 0 ? play.media.duration : null;
    },
    _recordQualified(play) {
      if (this._play !== play || play.row.mine || play.viewAttempted || play.qualifiedMs < 2000) return;
      play.viewAttempted = true;
      this._mutate("view", "record_story_view", play.row.id, { p_id: play.row.id }, async receipt => {
        const row = await this.get(play.row.id);
        if (!receipt.qualified || !row.seen) throw failure(502);
        return { receipt, row };
      }).catch(error => {
        if (this._play !== play || !this._current(play.scope)) return;
        this._feedback(error);
        const recovery = this._element("recovery");
        if (recovery) recovery.innerHTML = this._button("retry-view", "Retry view confirmation", "undo", "", "Retry confirmation");
      });
    },
    pause(reason = "manual", paused = true) {
      const play = this._play; if (!play) return;
      if (paused) {
        play.pauses.add(reason); this._stopClock(play);
        if (play.row.kind === "video") play.media.pause();
      } else {
        play.pauses.delete(reason);
        if (!play.pauses.size && this._foreground()) {
          if (play.row.kind === "video") this._playVideo(play); else this._queueTick();
        }
      }
      this._updateActions();
    },
    togglePause() {
      const play = this._play; if (!play) return;
      const resume = play.pauses.has("manual") || play.pauses.has("autoplay") || play.pauses.has("media") || play.pauses.has("hover");
      if (resume) { play.pauses.delete("autoplay"); play.pauses.delete("media"); play.pauses.delete("hover"); this._hovered = false; }
      this.pause("manual", !resume);
    },
    toggleMute() {
      const play = this._play;
      if (!play || play.row.kind !== "video") return null;
      this.muted = !play.media.muted; play.media.muted = this.muted;
      const button = this._element("mute");
      if (button) {
        button.innerHTML = this._icon(this.muted ? "mute" : "volume"); button.title = this.muted ? "Unmute story" : "Mute story";
        button.setAttribute("aria-label", button.title); button.setAttribute("aria-pressed", String(this.muted));
      }
      return this.muted;
    },
    _playVideo(play) {
      if (this._play !== play || play.pauses.size || !this._foreground()) return;
      try {
        const promise = play.media.play();
        if (promise?.catch) promise.catch(() => {
          if (this._play !== play) return;
          play.pauses.add("autoplay"); this._stopClock(play); this._feedback("Playback paused.", true); this._updateActions();
        });
      } catch (_) { play.pauses.add("autoplay"); this._stopClock(play); this._updateActions(); }
    },
    async _resumeChecked(reason) {
      const play = this._play;
      if (!play || !this._foreground() || !play.pauses.has(reason)) return;
      if (!play.rechecking) {
        play.rechecking = this.get(play.row.id).then(row => {
          if (this._play !== play || !this._current(play.scope)) return;
          if (row.photo !== play.media.getAttribute("src")) { this._show().catch(error => this._feedback(error)); return; }
          play.media.style.visibility = "";
          play.pauses.delete("hidden"); play.pauses.delete("blur"); this.pause("checking", false);
        }).catch(error => { if (this._play === play) this._unavailable(error); }).finally(() => { play.rechecking = null; });
      }
      return play.rechecking;
    },
    _cleanPlayback() {
      const play = this._play;
      this._stopClock(play); cancelLater(this._expiryTimer); cancelLater(this._loadTimer);
      this._expiryTimer = null; this._loadTimer = null;
      if (!play) return;
      for (const remove of play.handlers || []) remove();
      if (play.media) {
        if (play.row.kind === "video") { play.media.pause(); play.media.removeAttribute("src"); try { play.media.load(); } catch (_) {} }
        else play.media.removeAttribute("src");
        play.media.remove();
      }
      this._play = null;
    },
    _unavailable(error) {
      const id = this._play?.row.id || this._ids?.[this._index];
      const previouslyKnown = this._known.has(id);
      const evict = [401, 403, 404].includes(error?.status);
      this._cleanPlayback();
      if (id && evict) { this.feed = this.feed.filter(row => row.id !== id); this._known.delete(id); }
      if (previouslyKnown && evict) this._notify("onChange");
      if (!this._root) return;
      if (this._panel) this._clearPanel();
      this._loading();
      this._element("stage").innerHTML = `<div id="stories-unavailable" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;height:100%;padding:12px 52px;box-sizing:border-box;text-align:center;color:#fff;overflow-wrap:anywhere"><p role="status">${this._text(error?.message || "Story unavailable.")}</p>${this._button("retry", "Retry story", "undo", "", "Retry")}</div>${this._navigation()}`;
      this._positionNavigation();
    },
    async next(ended = false) {
      if (!this._root || !this.enabled()) return null;
      if (this._index >= this._ids.length - 1) { if (ended) this.close(); return null; }
      this._index++; return this._show();
    },
    async previous() {
      if (!this._root || !this.enabled() || this._index <= 0) return null;
      this._index--; return this._show();
    },
    _updateActions() {
      if (!this._root) return;
      this._positionNavigation();
      const play = this._play; if (!play) return;
      const like = this._element("like"), pause = this._element("pause"), send = this._element("send");
      if (like) {
        const changed = like.getAttribute("aria-pressed") !== String(play.row.liked);
        like.disabled = this._likes.has(play.row.id) || this.pending.has(this._owner + ":like:" + play.row.id);
        like.setAttribute("aria-pressed", String(play.row.liked)); like.setAttribute("aria-label", play.row.liked ? "Unlike story" : "Like story");
        like.title = play.row.liked ? "Unlike story" : "Like story";
        if (changed) like.innerHTML = this._icon("heart", play.row.liked);
        like.style.color = play.row.liked ? "#ff6b88" : "#fff";
      }
      if (pause) {
        const paused = play.pauses.size > 0;
        const changed = pause.getAttribute("aria-pressed") !== String(paused);
        pause.setAttribute("aria-pressed", String(paused)); pause.setAttribute("aria-label", paused ? "Play story" : "Pause story");
        pause.title = paused ? "Play story" : "Pause story";
        if (changed) pause.innerHTML = this._icon("film") + '<span style="min-width:0;overflow-wrap:anywhere">' + (paused ? "Play" : "Pause") + '</span>';
      }
      if (send) send.disabled = this.pending.has(this._owner + ":reply:" + play.row.id);
      const counts = this._element("counts"), viewers = this._element("viewers");
      if (counts && play.row.mine) counts.textContent = play.row.view_count + " views / " + play.row.like_count + " likes";
      if (viewers && play.row.mine && viewers.dataset.count !== String(play.row.view_count)) {
        viewers.innerHTML = this._icon("users") + play.row.view_count + " views"; viewers.dataset.count = String(play.row.view_count);
      }
    },
    async _sendReply() {
      const play = this._play, editor = this._element("reply");
      if (!play || !editor || play.sending) return;
      play.sending = true;
      const text = editor.value;
      this._drafts.set(play.row.id, text);
      try {
        const receipt = await this.reply(play.row.id, text);
        if (this._play !== play || !this._current(play.scope)) return;
        if (editor.value === text) { editor.value = ""; this._drafts.delete(play.row.id); }
        this._feedback("", false); this._feedback("Reply sent.", true);
        const recovery = this._element("recovery"); if (recovery) recovery.replaceChildren();
        if (options.onReply) { try { options.onReply(receipt)?.catch?.(() => {}); } catch (_) {} }
        return receipt;
      } catch (error) {
        if (this._play !== play || !this._current(play.scope)) return;
        this._feedback(error);
        if (error.status === 409) this._element("recovery").innerHTML = this._button("reconcile-reply", "Check previous reply", "info", "", "Check previous reply");
      } finally { play.sending = false; }
    },
    _openPanel(title) {
      const scope = this._scope();
      if (!this._root) { this._mount(); this._loading(); }
      const returnFocus = this._panelReturnFocus || doc().activeElement;
      this._clearPanel(); this._panelReturnFocus = returnFocus;
      this.pause("panel", true);
      this._panelBackground = [...this._root.querySelector(".sv-card").children].map(element => ({ element, inert: element.inert, hidden: element.getAttribute("aria-hidden") }));
      for (const previous of this._panelBackground) { previous.element.inert = true; previous.element.setAttribute("aria-hidden", "true"); }
      const panel = doc().createElement("section");
      panel.id = "stories-panel"; panel.tabIndex = -1; panel.setAttribute("aria-labelledby", "stories-panel-heading");
      panel.style.cssText = "position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;background:var(--card,#151515);color:var(--text,#fff);padding:12px;overflow:hidden";
      panel.innerHTML = `<header style="display:flex;gap:8px;align-items:center;flex-shrink:0"><h2 id="stories-panel-heading" style="font-size:18px;line-height:1.3;flex:1;min-width:0;overflow-wrap:anywhere;margin:0">${this._text(title)}</h2>${this._button("panel-close", "Close " + title.toLowerCase(), "close")}</header>
        <div id="stories-panel-body" style="overflow-y:auto;min-height:0;flex:1;padding-top:12px"><p role="status">Loading...</p></div>`;
      this._root.querySelector(".sv-card").appendChild(panel); this._panel = panel;
      this._root.setAttribute("aria-label", title); this._panelListeners = [];
      this._element("panel-close").focus();
      return { scope, element: panel, revision: this._panelRevision };
    },
    _panelCurrent(context) {
      return this._current(context.scope) && this._panel === context.element && context.revision === this._panelRevision;
    },
    _panelContent(context, html) {
      if (!this._panelCurrent(context)) return null;
      const body = context.element.querySelector("#stories-panel-body");
      body.innerHTML = html + `<p id="stories-panel-error" role="alert" style="overflow-wrap:anywhere;font-size:13px"></p><p id="stories-panel-notice" role="status" style="overflow-wrap:anywhere;font-size:13px"></p>`;
      return body;
    },
    _panelFailure(context, error, retry) {
      if (!this._panelCurrent(context)) return;
      this._panelRetry = retry;
      this._panelContent(context, `<p role="alert" style="overflow-wrap:anywhere">${this._text(error.message)}</p>${this._button("panel-retry", "Retry", "undo", "", "Retry")}`);
    },
    _clearPanel() {
      for (const remove of this._panelListeners || []) remove(); this._panelListeners = [];
      if (this._notificationBinding) {
        this._notificationBinding.element.removeEventListener("click", this._notificationBinding.handler); this._notificationBinding = null;
      }
      this._notificationRoot?.replaceChildren();
      this._panel?.remove(); this._panel = null; this._panelRevision = (this._panelRevision || 0) + 1;
      for (const previous of this._panelBackground || []) {
        previous.element.inert = previous.inert;
        if (previous.hidden === null) previous.element.removeAttribute("aria-hidden"); else previous.element.setAttribute("aria-hidden", previous.hidden);
      }
      this._panelBackground = [];
      this._confirmation = null; this._panelRetry = null; this._viewerPage = null; this._viewerCursor = null;
      this._recoveryIntent = null; this._reportTarget = null;
      this._notificationRoot = null; this._visibleNotifications.clear(); this._notificationRows = [];
      this._notificationPage = null; this._notificationScope = null; this._readIds = new Set();
    },
    closePanel() {
      const focus = this._panelReturnFocus; this._panelReturnFocus = null;
      this._clearPanel();
      if (!this._play) return this.close();
      this._root.setAttribute("aria-label", "Stories"); this.pause("panel", false);
      if (focus?.isConnected && !focus.disabled) focus.focus(); else this._element("close").focus();
    },
    async openViewers(cursor = null) {
      if (!this.enabled()) return null;
      const play = this._play;
      if (!play?.row.mine) throw failure(403);
      const context = this._openPanel("Story viewers");
      try {
        const page = await this.viewers(play.row.id, cursor);
        if (!this._panelCurrent(context)) return null;
        this._viewerPage = page; this._viewerCursor = cursor;
        this._panelContent(context, `<div role="list">${page.items.map(row => `<section role="listitem" data-story-viewer-id="${row.id}" style="display:flex;gap:8px;align-items:center;padding:12px 0;border-bottom:1px solid var(--line);min-width:0">
          <span class="av" style="width:34px;height:34px;flex-shrink:0;background:#333">${this._text((row.name || row.username || "?").slice(0, 1))}</span><div style="min-width:0;flex:1;overflow-wrap:anywhere"><b>${this._text(row.name || "Member")}</b><div class="sub">${this._text(row.username)}</div><time class="sub" datetime="${this._text(row.qualified_at)}">${this._text(new Date(row.qualified_at).toLocaleString())}</time></div>${row.liked ? `<span title="Liked" aria-label="Liked" style="flex-shrink:0;color:#ff6b88">${this._icon("heart", true)}</span>` : ""}</section>`).join("")}</div>
          ${page.items.length ? "" : '<p>No views yet.</p>'}<div style="display:flex;gap:8px;flex-wrap:wrap">${cursor ? this._button("viewers-first", "Latest viewers", "undo", "", "Latest") : ""}${page.next_cursor ? this._button("viewers-more", "Older viewers", "chevronR", "", "Older viewers") : ""}</div>`);
        return page;
      } catch (error) { this._panelFailure(context, error, () => this.openViewers(cursor)); return null; }
    },
    async openSettings() {
      if (!this.enabled()) return null;
      const context = this._openPanel("Story preferences");
      try {
        const value = await this.getPreferences();
        if (!this._panelCurrent(context)) return null;
        const content = this._panelContent(context, `<form id="stories-preferences-form"><fieldset style="border:0;padding:0;margin:0;min-width:0">
          <div class="field"><label for="stories-reply-permission">Story replies</label><select id="stories-reply-permission" style="min-height:44px;width:100%"><option value="none" ${value.reply_permission === "none" ? "selected" : ""}>Off</option><option value="authenticated" ${value.reply_permission === "authenticated" ? "selected" : ""}>Authenticated members</option></select></div>
          ${[["likes", "Like notifications"], ["replies", "Reply notifications"], ["sound", "Sound"]].map(([key, label]) => `<label style="min-height:44px;display:flex;gap:12px;align-items:center;overflow-wrap:anywhere"><input type="checkbox" id="stories-pref-${key}" ${value[key] ? "checked" : ""}>${label}</label>`).join("")}
          <button class="btn" id="stories-preferences-save" type="submit" title="Save story preferences" style="min-height:44px">${this._icon("edit")} Save</button></fieldset></form>
          <div id="stories-preferences-recovery"></div>`);
        this._listen(content.querySelector("form"), "submit", async event => {
          event.preventDefault();
          if (!this._panelCurrent(context)) return;
          const form = event.currentTarget, fieldset = form.querySelector("fieldset");
          if (fieldset.disabled) return;
          const desired = { version: value.version, reply_permission: form.querySelector("select").value,
            likes: form.querySelector("#stories-pref-likes").checked, replies: form.querySelector("#stories-pref-replies").checked, sound: form.querySelector("#stories-pref-sound").checked };
          fieldset.disabled = true;
          try {
            const result = await this.setPreferences(desired);
            if (!this._panelCurrent(context)) return;
            Object.assign(value, result.preferences);
            this._feedback("", false); this._feedback("Preferences saved.", true);
          } catch (error) {
            if (!this._panelCurrent(context)) return;
            this._feedback(error);
            if (error.status === 409) content.querySelector("#stories-preferences-recovery").innerHTML = this._button("preferences-reload", "Reload current preferences", "undo", "", "Reload preferences");
          } finally { if (this._panelCurrent(context)) fieldset.disabled = false; }
        }, undefined, this._panelListeners);
        return value;
      } catch (error) { this._panelFailure(context, error, () => this.openSettings()); return null; }
    },
    async openNotifications(cursor = null) {
      if (!this.enabled()) return null;
      const context = this._openPanel("Story notifications");
      try {
        const page = await this.notifications(cursor);
        const content = this._panelContent(context, '<div id="stories-notifications"></div>');
        if (!content) return null;
        this.renderNotifications(content.querySelector("#stories-notifications"), page);
        this._notificationCursor = cursor;
        return page;
      } catch (error) { this._panelFailure(context, error, () => this.openNotifications(cursor)); return null; }
    },
    renderNotifications(container, page) {
      if (!this.enabled()) return;
      if (!container?.isConnected || page !== this._notificationPage || !this._notificationScope || !this._current(this._notificationScope)) throw failure(403);
      if (this._notificationBinding) this._notificationBinding.element.removeEventListener("click", this._notificationBinding.handler);
      this._notificationRows = page.items; this._notificationRoot = container;
      this._readIds = this._readIds || new Set();
      this._visibleNotifications = new Map(page.items.filter(row => row.read_at === null && !this._readIds.has(row.id)).map(row => [row.id, row]));
      container.innerHTML = `<div role="list">${page.items.map(row => `<section role="listitem" data-story-notification-id="${row.id}" style="padding:10px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere">
        <button class="btn ghost" type="button" data-stories-action="notification-open" data-notification-id="${row.id}" style="min-height:44px;width:100%;white-space:normal;text-align:left" title="Open story notification">${this._icon(row.kind === "reply" ? "comment" : "heart")} ${row.kind === "reply" ? "Replied to your story" : "Liked your story"}</button>
        <div class="sub">${row.available ? "" : "Story unavailable. "}${this._visibleNotifications.has(row.id) ? "Unread" : "Read"}</div><time class="sub" datetime="${this._text(row.created_at)}">${this._text(new Date(row.created_at).toLocaleString())}</time></section>`).join("")}</div>
        ${page.items.length ? "" : '<p>No notifications.</p>'}<div style="display:flex;gap:8px;flex-wrap:wrap;padding-top:8px">${this._visibleNotifications.size ? this._button("notifications-read", "Mark displayed notifications as read", "eye", "", "Mark displayed as read") : ""}
        ${page.next_cursor ? this._button("notifications-more", "Older notifications", "chevronR", "", "Older") : ""}${this._button("notifications-first", "Latest notifications", "undo", "", "Latest")}</div>`;
      if (!this._root?.contains(container)) {
        const handler = event => {
          const button = event.target.closest("[data-stories-action]");
          if (!button || button.disabled) return;
          this._dispatch(button.dataset.storiesAction, button).catch(error => {
            const notice = container.querySelector('[role="alert"]') || doc().createElement("p");
            notice.setAttribute("role", "alert"); notice.textContent = error.message; if (!notice.isConnected) container.appendChild(notice);
          });
        };
        container.addEventListener("click", handler); this._notificationBinding = { element: container, handler };
      }
    },
    async openReport(id, contextMessageId = null) {
      if (!this.enabled()) return null;
      if (!uuid(id) || (contextMessageId !== null && !messageId(contextMessageId))) throw failure(400);
      const context = this._openPanel(contextMessageId ? "Report story reply" : "Report story");
      const content = this._panelContent(context, `<form id="stories-report-form"><label class="field" for="stories-report-reason">Reason<textarea id="stories-report-reason" rows="4" maxlength="512" required style="width:100%;min-height:100px;resize:vertical;font-size:16px"></textarea></label>
        <button type="submit" class="btn" id="stories-report-send" title="Send report" style="min-height:44px">${this._icon("flag")} Send report</button></form><div id="stories-report-recovery"></div>`);
      this._listen(content.querySelector("form"), "submit", async event => {
        event.preventDefault();
        if (!this._panelCurrent(context)) return;
        const button = content.querySelector("#stories-report-send"), editor = content.querySelector("textarea"), reason = editor.value;
        if (button.disabled) return;
        button.disabled = true;
        try {
          await this.report(id, reason, contextMessageId);
          if (!this._panelCurrent(context)) return;
          if (editor.value === reason) editor.value = "";
          this._feedback("", false); this._feedback("Report received.", true);
        } catch (error) {
          if (!this._panelCurrent(context)) return;
          this._feedback(error);
          if (error.status === 409) {
            this._reportTarget = { action: contextMessageId === null ? "report" : "report_message", target: contextMessageId ?? id };
            content.querySelector("#stories-report-recovery").innerHTML = this._button("reconcile-report", "Check previous report", "info", "", "Check previous report");
          }
        } finally { if (this._panelCurrent(context)) button.disabled = false; }
      }, undefined, this._panelListeners);
    },
    _confirmAction(title, label, run) {
      const target = label === "Delete" ? this._play.row.id : this._play.row.author;
      const context = this._openPanel(title); this._confirmation = { context, run, action: label === "Delete" ? "delete" : "block", target };
      this._panelContent(context, `${label === "Delete" ? '<p>Public URL copies are not erased.</p>' : ""}<div style="display:flex;gap:12px;flex-wrap:wrap">${this._button("confirm-action", label, label === "Delete" ? "trash" : "ban", "", label)}${this._button("cancel-action", "Cancel", "close", "", "Cancel")}</div>`);
    },
    _offerRecovery(action, target) {
      if (!this._root || !this.enabled()) return;
      const root = this._root, revision = this._revision;
      let scope;
      try { scope = this._scope(); } catch (error) { this._feedback(error); return; }
      if (this._root !== root || this._revision !== revision || !this._current(scope)) return;
      this._recoveryIntent = { action, target, scope, revision };
      let area = this._panel?.querySelector("#stories-mutation-recovery") || this._element("recovery");
      if (this._panel && !this._panel.contains(area)) {
        area = doc().createElement("div"); area.id = "stories-mutation-recovery";
        this._panel.querySelector("#stories-panel-body").appendChild(area);
      }
      if (area) area.innerHTML = this._button("reconcile-action", "Check previous attempt", "info", "", "Check previous attempt");
    },
    async _dispatch(action, button) {
      if (!this.enabled()) { this.reset(); return; }
      const play = this._play;
      if (action === "close") return this.close();
      if (action === "prev") return this.previous();
      if (action === "next") return this.next();
      if (action === "retry") return this._ids[this._index] ? this._show() : this.open(this._openTarget);
      if (action === "pause") return this.togglePause();
      if (action === "panel-close" || action === "cancel-action") return this.closePanel();
      if (action === "settings") return this.openSettings();
      if (action === "notifications") return this.openNotifications();
      if (action === "reconcile-action") {
        const intent = this._recoveryIntent;
        if (!intent || !this._current(intent.scope)) return;
        const receipt = await this.reconcile(intent.action, intent.target);
        if (intent !== this._recoveryIntent || intent.revision !== this._revision || !this._current(intent.scope)) return;
        this._recoveryIntent = null;
        this._element("recovery")?.replaceChildren(); this._panel?.querySelector("#stories-mutation-recovery")?.remove();
        if (intent.action === "read_notifications") await this.openNotifications(this._notificationCursor);
        else if (intent.action === "like" || intent.action === "delete") {
          try { await this.get(intent.target); } catch (error) { if (error.status !== 404) throw error; }
        }
        this._feedback("", false); this._feedback(receipt ? "Earlier attempt confirmed." : "Earlier attempt was not committed.", true);
        return receipt;
      }
      if (action === "panel-retry") return this._panelRetry?.();
      if (action === "preferences-reload") { await this.reconcile("preferences", this.owner()); return this.openSettings(); }
      if (action === "viewers-first") return this.openViewers();
      if (action === "viewers-more") return this.openViewers(this._viewerPage?.next_cursor);
      if (action === "notifications-first") return this.openNotifications();
      if (action === "notifications-more") return this.openNotifications(this._notificationPage?.next_cursor);
      if (action === "notifications-read") {
        const container = this._notificationRoot, page = this._notificationPage;
        if (button) button.disabled = true;
        try {
          const receipt = await this.markRead([...this._visibleNotifications.keys()]);
          if (container === this._notificationRoot && page === this._notificationPage && container?.isConnected) this.renderNotifications(container, page);
          return receipt;
        } finally { if (button?.isConnected) button.disabled = false; }
      }
      if (action === "notification-open") {
        const row = this._notificationRows.find(item => item.id === button?.dataset.notificationId);
        if (!row) return;
        const result = row.message_id ? await this.resolveContext(row.message_id) : { available: true, story: await this.get(row.story_id) };
        if (!result.available) { this._feedback("Story unavailable."); return; }
        this.closePanel(); return this.open(result.story.id);
      }
      if (action === "confirm-action") {
        const confirmation = this._confirmation;
        if (!confirmation || !this._panelCurrent(confirmation.context)) return;
        button.disabled = true;
        try {
          const receipt = await confirmation.run();
          if (this._panelCurrent(confirmation.context)) this.closePanel();
          this._feedback(receipt.action === "delete" ? "Story removed." : "Member blocked.", true);
          return receipt;
        } finally { if (button.isConnected) button.disabled = false; }
      }
      if (action === "reconcile-report") {
        const intent = this._reportTarget;
        if (!intent) return;
        const receipt = await this.reconcile(intent.action, intent.target);
        if (intent !== this._reportTarget) return;
        this._reportTarget = null; this._element("report-recovery")?.replaceChildren();
        this._feedback("", false); this._feedback(receipt ? "Earlier report confirmed." : "Earlier attempt was not committed.", true);
        return;
      }
      if (!play) return;
      if (action === "like") return this.setLike(play.row.id, !play.row.liked);
      if (action === "mute") return this.toggleMute();
      if (action === "retry-view") { play.viewAttempted = false; play.qualifiedMs = 0; this._element("recovery")?.replaceChildren(); this._queueTick(); }
      if (action === "reconcile-reply") {
        const receipt = await this.reconcile("reply", play.row.id);
        if (this._play === play) { this._feedback("", false); this._feedback(receipt ? "Earlier reply confirmed." : "Earlier attempt was not committed.", true); this._element("recovery")?.replaceChildren(); }
      }
      if (action === "viewers") return this.openViewers();
      if (action === "report") return this.openReport(play.row.id);
      if (action === "block") return this._confirmAction("Block member?", "Block", () => this.setBlock(play.row.author, true));
      if (action === "delete") return this._confirmAction("Delete story?", "Delete", () => this.remove(play.row.id));
    }
  });
  api.create = createStories;
  return api;
});