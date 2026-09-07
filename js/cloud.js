/* ============================================================
   CLOUD: shared social backend via Supabase (free Postgres + REST).
   Tables profiles/posts/requests hold the members directory, the
   shared feed and connect requests. A single get_state() RPC returns
   { users, posts, requests } ready for the UI. Active when
   window.SUPABASE_URL and window.SUPABASE_ANON_KEY are set. Personal
   workout/food/weight logs stay in localStorage and are never uploaded.
   ============================================================ */
const Cloud = {
  base: null,
  key: null,
  me: null,
  _timer: null,
  _cb: null,
  _paused: true,
  _busy: false,

  active() { return !!(window.SUPABASE_URL && window.SUPABASE_ANON_KEY); },
  uidFor(email) { return (email || "guest").toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 60); },

  _headers(extra) {
    const jwt = (typeof SupaAuth !== "undefined" && SupaAuth.bearer) ? SupaAuth.bearer() : null;
    return Object.assign({ apikey: this.key, Authorization: "Bearer " + (jwt || this.key), "Content-Type": "application/json" }, extra || {});
  },

  _ensureIdentity(email) {
    if (!this.active()) return false;
    this.base = window.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1";
    this.key = window.SUPABASE_ANON_KEY;
    // RLS checks auth.uid()::text = author/uid/from_uid, so under Supabase Auth our
    // identity MUST be the server-issued user UUID, not an email-derived slug.
    const secure = typeof SupaAuth !== "undefined" && SupaAuth.active();
    this.me = secure ? SupaAuth.uid() : this.uidFor(email);
    return !!this.me;
  },
  init(account, profile) {
    if (!this._ensureIdentity(account && account.email)) return false;
    this.registerMe(profile);
    return true;
  },

  // one RPC returns the whole shared state already shaped as { users, posts, requests }
  async _get(controller = new AbortController()) {
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const uid = this.me;
      if (typeof SupaAuth !== "undefined" && SupaAuth.active()) {
        if (!await SupaAuth.token() || SupaAuth.uid() !== uid || this.me !== uid) return null;
      }
      if (controller.signal.aborted) return null;
      const r = await fetch(this.base + "/rpc/get_state", { method: "POST", headers: this._headers(), body: "{}", signal: controller.signal });
      if (!r.ok) return null;
      const s = await r.json();
      return { users: (s && s.users) || {}, posts: (s && s.posts) || {}, requests: (s && s.requests) || {}, comments: (s && s.comments) || {}, stories: (s && s.stories) || {} };
    } catch (e) { return null; } finally { clearTimeout(timeout); }
  },
  async _write(path, body, extra) {
    const uid = this.me, payload = JSON.stringify(body);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      if (typeof SupaAuth !== "undefined" && SupaAuth.active()) {
        if (!await SupaAuth.token() || SupaAuth.uid() !== uid || this.me !== uid) return false;
      }
      if (controller.signal.aborted) return false;
      const r = await fetch(this.base + path, { method: "POST", headers: this._headers(extra), body: payload, signal: controller.signal });
      return r.ok;
    }
    catch (e) { return false; } finally { clearTimeout(timeout); }
  },

  // upload a File/Blob to the public 'media' Storage bucket → returns its public URL (used for video/reels + story media)
  async uploadMedia(file, folder, storyIntent) {
    if (folder === "stories" && window.STORY_MEDIA_VALIDATION === true) {
      const failure = (status, code) => Object.assign(new Error(code === "policy_changed" ? "Story media rules changed. This reservation was cancelled; select a supported file again."
        : code === "promotion_review_required" ? "Media promotion needs a storage review before this request can be reused."
        : code === "reservation_expired" ? "This media reservation expired and could not be renewed. Select the file again."
        : status === 422 ? "Choose a supported photo or a video up to 30 seconds."
        : status === 429 ? "Story media limit reached. Try again later."
        : status === 409 ? "This media attempt could not be reused. Retake or check the previous Story."
        : "Story media was not confirmed. Your draft is kept; retry when online."), { status, ...(code ? { code } : {}) });
      const owner = this._publishingUid(), generation = this._publishingGeneration, authEpoch = typeof SupaAuth !== "undefined" ? SupaAuth._authEpoch : null;
      const root = window.SUPABASE_URL, key = this.key, requestId = storyIntent?.requestId;
      const kinds = { "image/jpeg": ["photo", "jpg"], "image/png": ["photo", "png"], "image/webp": ["photo", "webp"],
        "video/mp4": ["video", "mp4"], "video/webm": ["video", "webm"] };
      const format = kinds[file?.type];
      if (window.STORY_INTERACTIONS !== true || !this.active() || !this._isUuid(owner) || !this._isUuid(requestId)
        || typeof storyIntent?.current !== "function" || typeof SupaAuth === "undefined" || !SupaAuth.active()
        || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(root) || typeof key !== "string" || !key || /\s/.test(key)
        || key.startsWith("sb_secret_") || !format || !Number.isSafeInteger(file.size) || file.size < 1
        || file.size > (format[0] === "photo" ? 8388608 : 26214400)) throw failure(422);
      if (key.startsWith("eyJ")) {
        try { if (JSON.parse(atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).role !== "anon") throw failure(503); }
        catch (_) { throw failure(503); }
      }
      const controller = new AbortController(), controllers = this._publishingControllers || (this._publishingControllers = new Set());
      controllers.add(controller);
      let rejectBoundary;
      const boundary = new Promise((resolve, reject) => { rejectBoundary = reject; });
      const abort = () => rejectBoundary(failure(504));
      controller.signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => controller.abort(), 60000);
      const check = () => {
        if (controller.signal.aborted || window.STORY_MEDIA_VALIDATION !== true || window.STORY_INTERACTIONS !== true
          || this._publishingUid() !== owner || generation !== this._publishingGeneration || authEpoch !== SupaAuth._authEpoch
          || root !== window.SUPABASE_URL || key !== this.key || !storyIntent.current()) throw failure(401);
      };
      const readJson = async response => {
        if (Number(response.headers?.get("content-length")) > 32768 || !response.body?.getReader) throw failure(502);
        const reader = response.body.getReader(), decoder = new TextDecoder(); let size = 0, text = "";
        const abortRead = () => { reader.cancel().catch(() => {}); };
        controller.signal.addEventListener("abort", abortRead, { once: true });
        try {
          while (true) {
            check(); const chunk = await reader.read(); check(); if (chunk.done) break;
            size += chunk.value.byteLength; if (size > 32768) throw failure(502);
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        } finally { controller.signal.removeEventListener("abort", abortRead); reader.cancel().catch(() => {}); }
        let value; try { value = JSON.parse(text); } catch (_) { throw failure(502); }
        if (!response.ok) throw failure([401, 403, 409, 422, 429, 503].includes(response.status) ? response.status : 502);
        return value;
      };
      const work = async () => {
        check(); const token = await SupaAuth.token(); check();
        if (typeof token !== "string" || !token || /\s/.test(token) || token.length > 16384) throw failure(401);
        const bytes = await file.arrayBuffer(); check();
        if (bytes.byteLength !== file.size) throw failure(422);
        const digest = await crypto.subtle.digest("SHA-256", bytes); check();
        const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
        const headers = { apikey: key, Authorization: "Bearer " + token, "Content-Type": "application/json" };
        const send = async (path, body, extra = {}) => {
          check(); const response = await fetch(root + path, { method: "POST", headers, body: JSON.stringify(body),
            credentials: "omit", redirect: "error", cache: "no-store", signal: controller.signal, ...extra });
          check(); const result = await readJson(response); check(); return result;
        };
        const reservation = await send("/rest/v1/rpc/reserve_story_media", { p_request_id: requestId, p_kind: format[0], p_content_type: file.type, p_declared_bytes: file.size });
        const objectKey = "stories/" + owner + "/" + reservation?.reservation_id + "." + format[1];
        const publicKey = "stories/" + owner + "/" + reservation?.public_key_id + "_" + hash + "." + format[1];
        const mediaUrl = root + "/storage/v1/object/public/story-media-public-v3/" + publicKey;
        const matches = value => value?.schema_version === 2 && value.owner === owner && value.request_id === requestId
          && this._isUuid(value.reservation_id) && value.reservation_id === reservation.reservation_id
          && value.bucket === "story-media-quarantine-v3" && value.object_key === objectKey
          && value.public_bucket === "story-media-public-v3" && this._isUuid(value.public_key_id)
          && value.public_key_id === reservation.public_key_id && value.public_key_id !== value.reservation_id
          && value.kind === format[0] && value.content_type === file.type && value.declared_bytes === file.size
          && Number.isSafeInteger(value.policy_epoch) && value.policy_epoch > 0 && Number.isFinite(Date.parse(value.expires_at))
          && typeof value.uploaded === "boolean";
        if (matches(reservation) && reservation.status === "cancelled"
          && ["policy_changed", "reservation_expired", "promotion_review_required"].includes(reservation.failure_code)) throw failure(409, reservation.failure_code);
        if (!matches(reservation) || !["reserved", "validating", "attested", "promoting", "approved", "published"].includes(reservation.status)
          || (reservation.status !== "published" && Date.parse(reservation.expires_at) <= Date.now())) throw failure(502);
        if (reservation.status === "reserved" && !reservation.uploaded) {
          const acknowledgement = await send("/storage/v1/object/story-media-quarantine-v3/" + objectKey, null, {
            headers: { ...headers, "Content-Type": file.type, "x-upsert": "false" }, body: file,
          });
          if (acknowledgement?.Key !== "story-media-quarantine-v3/" + objectKey || !this._isUuid(acknowledgement.Id)) throw failure(502);
        }
        const receipt = await send("/functions/v1/validate-story-media", { request_id: requestId });
        if (!matches(receipt) || !["approved", "published"].includes(receipt.status) || !receipt.uploaded
          || receipt.media_url !== mediaUrl || receipt.public_key !== publicKey || !this._isUuid(receipt.public_object_id)
          || typeof receipt.public_object_version !== "string" || receipt.public_object_version.length < 1 || receipt.public_object_version.length > 128
          || receipt.sha256 !== hash || receipt.actual_bytes !== file.size || receipt.policy_epoch !== reservation.policy_epoch
          || !Number.isSafeInteger(receipt.width) || !Number.isSafeInteger(receipt.height)
          || receipt.width < 1 || receipt.width > 8192 || receipt.height < 1 || receipt.height > 8192 || receipt.width * receipt.height > 16777216
          || (format[0] === "video" ? receipt.duration_verified !== true || !Number.isSafeInteger(receipt.duration_ms) || receipt.duration_ms < 1 || receipt.duration_ms > 30000
            : receipt.duration_verified !== false || receipt.duration_ms !== null)) throw failure(502);
        return Object.freeze(receipt);
      };
      try { return await Promise.race([work(), boundary]); }
      finally { clearTimeout(timeout); controller.signal.removeEventListener("abort", abort); controllers.delete(controller); }
    }
    if (!this.active() || !file) return null;
    const uid = this._actionUid();
    if (!uid) return null;
    const controller = new AbortController();
    const generation = this._publishingGeneration;
    const controllers = this._publishingControllers || (this._publishingControllers = new Set());
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const secure = typeof SupaAuth !== "undefined" && SupaAuth.active();
      if (window.USE_SUPABASE_AUTH && !secure) return null;
      const token = secure ? await SupaAuth.token() : null;
      if (this._actionUid() !== uid || generation !== this._publishingGeneration || (secure && !token) || controller.signal.aborted) return null;
      const mime = file.type || "application/octet-stream";
      const ext = (mime.split("/")[1] || "bin").split(";")[0].replace("quicktime", "mov").replace("jpeg", "jpg");
      const sub = (folder || "misc") + "/" + uid + "/" + Date.now() + "_" + Math.floor(Math.random() * 99999) + "." + ext;
      const root = window.SUPABASE_URL.replace(/\/$/, "");
      const r = await fetch(root + "/storage/v1/object/media/" + sub, {
        method: "POST",
        headers: { apikey: this.key, Authorization: "Bearer " + (token || this.key), "Content-Type": mime, "x-upsert": "true" },
        body: file, signal: controller.signal,
      });
      if (!r.ok || this._actionUid() !== uid || generation !== this._publishingGeneration || controller.signal.aborted) return null;
      return root + "/storage/v1/object/public/media/" + sub;
    } catch (e) { return null; } finally { clearTimeout(timeout); controllers.delete(controller); }
  },

  registerMe(profile) {
    if (!this.active() || !this.me) return;
    if (typeof Entitlements !== "undefined" && !Entitlements.ready()) return;
    const p = profile || (typeof Store !== "undefined" && Store.state && Store.state.profile) || {};
    // Data minimization (ISO 27001 A.8.3 / privacy A.5.34): raw biometrics
    // (weight, BMI, height, gender) are NEVER uploaded to the shared cloud —
    // they stay on-device. Only gamification stats sync for the social feed.
    let score = 0, workouts = 0;
    try {
      if (typeof Engine !== "undefined" && Engine.fitnessScore) score = Engine.fitnessScore();
      if (typeof Engine !== "undefined" && Engine.totalWorkouts) workouts = Engine.totalWorkouts();
    } catch (e) {}
    const data = {
      username: p.username || "", name: p.name || "", avatar: p.avatar || "",
      physique: (typeof Engine !== "undefined" && Engine.getPhysique) ? Engine.getPhysique().name : "",
      bio: p.bio || "", streak: (typeof Engine !== "undefined" && Engine.streak) ? Engine.streak() : 0,
      socials: p.socials || {}, privacy: p.privacy || "public", following: p.following || [],
      verified: !!p.verified, score, workouts, seen: Date.now(), tier: typeof Entitlements !== "undefined" ? Entitlements.tier() : "free",
      cover: p.coverUrl || "",
    };
    return this._write("/profiles", { uid: this.me, data, updated_at: new Date().toISOString() }, { Prefer: "resolution=merge-duplicates,return=minimal" });
  },
  async addPost(post) {
    const uid = this._publishingUid();
    if (!this.active() || !uid || !post || (post.author && post.author !== uid)) return false;
    const id = post.id || this._newActionId();
    if (typeof id !== "string" || !id) return false;
    const data = { text: (post && post.text) || "", photo: (post && post.photo) || null, photos: (post && post.photos) || null, video: (post && post.video) || null, gradient: (post && post.gradient) || null, tag: (post && post.tag) || "Flex", resharedFrom: (post && post.resharedFrom) || null, reshareOf: (post && post.reshareOf) || null, music: (post && post.music) || null };
    const row = await this._writeAction("/posts?on_conflict=id", "POST", { id, author: uid, data, likes: {} }, id, {
      owner: uid, receipt: true, prefer: "resolution=ignore-duplicates,return=representation",
      reconcile: "/posts?id=eq." + encodeURIComponent(id) + "&author=eq." + encodeURIComponent(uid) + "&select=id,author,data,likes,ts",
      matches: result => result.author === uid && this._samePayload(result.data, data),
    });
    return row ? { ...row.data, id: row.id, author: row.author, likes: row.likes || {}, ts: new Date(row.ts || Date.now()).getTime() } : false;
  },
  resetPublishing() {
    this._publishingGeneration = (this._publishingGeneration || 0) + 1;
    if (this._publishingControllers) { this._publishingControllers.forEach(controller => controller.abort()); this._publishingControllers.clear(); }
  },
  _isUuid(value) { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); },
  _publishingUid() {
    const secure = typeof SupaAuth !== "undefined" && SupaAuth.active();
    if (window.USE_SUPABASE_AUTH && !secure) return null;
    const uid = this._actionUid();
    return secure && !this._isUuid(uid) ? null : uid;
  },
  _newActionId() {
    if (typeof crypto === "undefined") return null;
    if (crypto.randomUUID) return crypto.randomUUID();
    if (!crypto.getRandomValues) return null;
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  },
  _samePayload(value, expected) {
    if (value === expected) return true;
    if (!value || !expected || typeof value !== "object" || typeof expected !== "object" || Array.isArray(value) !== Array.isArray(expected)) return false;
    const keys = Object.keys(expected);
    return Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key) && this._samePayload(value[key], expected[key]));
  },
  _actionUid() {
    if (typeof SupaAuth !== "undefined" && SupaAuth.active && SupaAuth.active()) return SupaAuth.uid() || null;
    return this.me;
  },
  async _writeAction(path, method, body, targetId, options = {}) {
    if (!this.base || !this.key) return false;
    const uid = this._actionUid(), payload = body === undefined ? undefined : JSON.stringify(body);
    const controller = new AbortController();
    const generation = this._publishingGeneration;
    const current = () => this._actionUid() === uid && !controller.signal.aborted && (!options.owner || (this._publishingUid() === uid && this._publishingGeneration === generation));
    const controllers = this._publishingControllers || (this._publishingControllers = new Set());
    if (options.owner) controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const secure = typeof SupaAuth !== "undefined" && SupaAuth.active();
      const token = secure ? await SupaAuth.token() : null;
      if (!uid || (options.owner && options.owner !== uid) || !current() || (secure && !token)) return false;
      const headers = this._headers({ Prefer: options.prefer || (targetId ? "return=representation" : "return=minimal"), ...(secure ? { Authorization: "Bearer " + token } : {}) });
      const result = await fetch(this.base + path, {
        method, headers, body: payload, signal: controller.signal,
      });
      if (!current() || (!result.ok && !(options.reconcile && result.status === 409))) return false;
      if (!targetId) return result.ok;
      let rows = result.ok ? await result.json() : [];
      if (options.reconcile && Array.isArray(rows) && !rows.length) {
        if (!current()) return false;
        const found = await fetch(this.base + options.reconcile, { method: "GET", headers, signal: controller.signal });
        if (!found.ok || !current()) return false;
        rows = await found.json();
      }
      if (!current() || !Array.isArray(rows) || rows.length !== 1 || !rows[0] || rows[0].id !== targetId || (options.matches && !options.matches(rows[0]))) return false;
      return options.receipt ? rows[0] : true;
    } catch (error) { return false; }
    finally { clearTimeout(timer); controllers.delete(controller); }
  },
  async deletePost(id) {
    const uid = this._actionUid();
    if (!this.active() || !id || !uid) return false;
    return this._writeAction("/posts?id=eq." + encodeURIComponent(id) + "&author=eq." + encodeURIComponent(uid) + "&select=id", "DELETE", undefined, id);
  },
  async editPost(id, data) {
    const uid = this._actionUid();
    if (!this.active() || !id || !uid) return false;
    return this._writeAction("/posts?id=eq." + encodeURIComponent(id) + "&author=eq." + encodeURIComponent(uid) + "&select=id", "PATCH", { data }, id);
  },
  async deleteComment(id) {
    const uid = this._actionUid();
    if (!this.active() || !id || !uid) return false;
    return this._writeAction("/comments?id=eq." + encodeURIComponent(id) + "&author=eq." + encodeURIComponent(uid) + "&select=id", "DELETE", undefined, id);
  },
  async report(kind, targetId, reason, reportedUid) {
    const uid = this._actionUid();
    if (!this.active() || !targetId || !uid) return false;
    if (window.MODERATION_RECEIPTS) return typeof Reports !== "undefined" && Reports.enabled() ? !!await Reports.submit(kind, String(targetId), reason || "reported") : false;
    return this._writeAction("/content_reports", "POST", { kind: kind, target_id: String(targetId), reported_uid: reportedUid || null, reason: reason || "", reporter: uid, status: "open" });
  },
  likeCloud(postId) {
    if (!this.active()) return;
    return this._write("/rpc/like_post", { p_id: postId, p_uid: this.me });
  },
  unlikeCloud(postId) {
    if (!this.active()) return;
    return this._write("/rpc/unlike_post", { p_id: postId, p_uid: this.me });
  },
  async usernameTaken(username) {
    if (!this.active() || !username) return false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(this.base + "/profiles?select=uid&data->>username=eq." + encodeURIComponent(username) + "&uid=neq." + encodeURIComponent(this.me || "_"), { headers: this._headers(), signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) return false;
      const rows = await r.json();
      return Array.isArray(rows) && rows.length > 0;
    } catch (e) { return false; }
  },
  sendRequest(toUid) {
    if (!this.active()) return;
    const id = this.me + "__" + toUid;
    return this._write("/requests", { id, from_uid: this.me, to_uid: toUid, status: "pending" }, { Prefer: "resolution=merge-duplicates,return=minimal" });
  },
  async acceptRequest(fromUid) {
    if (!this.active()) return;
    const id = fromUid + "__" + this.me;
    try { const r = await fetch(this.base + "/requests?id=eq." + encodeURIComponent(id), { method: "PATCH", headers: this._headers({ Prefer: "return=minimal" }), body: JSON.stringify({ status: "accepted" }) }); return r.ok; }
    catch (e) { return false; }
  },
  async declineRequest(fromUid) {
    if (!this.active()) return;
    const id = fromUid + "__" + this.me;
    try { const r = await fetch(this.base + "/requests?id=eq." + encodeURIComponent(id), { method: "DELETE", headers: this._headers({ Prefer: "return=minimal" }) }); return r.ok; }
    catch (e) { return false; }
  },
  async cancelRequest(toUid) {
    if (!this.active()) return;
    const id = this.me + "__" + toUid;
    try { const r = await fetch(this.base + "/requests?id=eq." + encodeURIComponent(id), { method: "DELETE", headers: this._headers({ Prefer: "return=minimal" }) }); return r.ok; }
    catch (e) { return false; }
  },

  // ---- comments (threaded), mentions & notifications ----
  addComment(postId, body, parentId, mentions, postAuthor, parentAuthor) {
    if (!this.active()) return null;
    const id = "c" + Date.now() + Math.floor(Math.random() * 99999);
    const m = mentions || [];
    this._write("/comments", { id, post_id: postId, author: this.me, body, parent_id: parentId || null, mentions: m }, { Prefer: "return=minimal" });
    if (parentId && parentAuthor && parentAuthor !== this.me) this.notify(parentAuthor, "reply", postId, body);
    else if (postAuthor && postAuthor !== this.me) this.notify(postAuthor, "comment", postId, body);
    m.forEach((u) => { if (u && u !== this.me && u !== postAuthor) this.notify(u, "mention", postId, body); });
    return { id, post_id: postId, author: this.me, body, parent_id: parentId || null, mentions: m, ts: Date.now() };
  },
  async notify(uid, type, postId, body, eventId) {
    if (!this._notificationId(uid) || !this._notificationType(type) || (postId != null && !this._notificationId(postId)) || (eventId != null && !this._notificationId(eventId))) return false;
    return await this._notificationRequest(async ({ owner: actor, request, current }) => {
      if (uid === actor) return false;
      const key = type === "like" ? postId : eventId;
      const digest = key ? await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([actor, uid, type, key]))) : null;
      const id = digest ? "n1_" + Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("") : this._newActionId();
      if (!id || !current()) return false;
      if (key && type === "like") {
        const rows = await request("/posts?id=eq." + encodeURIComponent(postId) + "&select=id,author,likes");
        if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.id !== postId || rows[0].author !== uid || rows[0].likes?.[actor] !== true) return false;
      } else if (key && ["comment", "reply", "mention"].includes(type)) {
        const rows = await request("/comments?id=eq." + encodeURIComponent(key) + "&author=eq." + encodeURIComponent(actor) + "&select=id,author,post_id,parent_id");
        if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.id !== key || rows[0].author !== actor || rows[0].post_id !== postId || (type === "reply" && !this._notificationId(rows[0].parent_id))) return false;
      }
      return request("/notifications?on_conflict=id", { method: "POST", body: { id, uid, type, actor, post_id: postId || null }, prefer: "resolution=ignore-duplicates,return=minimal", minimal: true });
    }) === true;
  },
  _notificationId(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/.test(value); },
  _notificationType(value) { return typeof value === "string" && /^[a-z][a-z_]{0,31}$/.test(value); },
  _notificationRows(rows, owner = this.me) {
    if (!this._notificationId(owner) || !Array.isArray(rows) || rows.length > 60) return null;
    const ids = new Set(), projected = [];
    for (const row of rows) {
      if (!row || !this._notificationId(row.id) || ids.has(row.id) || row.uid !== owner || !this._notificationId(row.actor) || !this._notificationType(row.type)
        || typeof row.read !== "boolean" || (row.post_id != null && !this._notificationId(row.post_id))
        || !((typeof row.ts === "string" && Number.isFinite(Date.parse(row.ts))) || (typeof row.ts === "number" && Number.isFinite(row.ts) && row.ts >= 0))) return null;
      ids.add(row.id);
      projected.push({ id: row.id, uid: owner, actor: row.actor, type: row.type, post_id: row.post_id || null, ts: row.ts, read: row.read });
    }
    return projected;
  },
  resetNotifications() {
    this._notificationGeneration = (this._notificationGeneration || 0) + 1;
    if (this._notificationControllers) { this._notificationControllers.forEach(controller => controller.abort()); this._notificationControllers.clear(); }
  },
  async _notificationRequest(operation) {
    const owner = this._publishingUid(), generation = this._publishingGeneration, notificationGeneration = this._notificationGeneration;
    if (!this.active() || !this.base || !this.key || !this._notificationId(owner) || this.me !== owner) return null;
    const controller = new AbortController(), controllers = this._notificationControllers || (this._notificationControllers = new Set());
    controllers.add(controller);
    const current = () => !controller.signal.aborted && this.me === owner && this._publishingUid() === owner
      && this._publishingGeneration === generation && this._notificationGeneration === notificationGeneration;
    const cancelled = new Promise(resolve => controller.signal.addEventListener("abort", () => resolve(null), { once: true }));
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const work = (async () => {
        const secure = typeof SupaAuth !== "undefined" && SupaAuth.active();
        const token = secure ? await SupaAuth.token() : null;
        if (!current() || (secure && !token) || (window.USE_SUPABASE_AUTH && !secure)) return null;
        const request = async (path, options = {}) => {
          if (!current()) throw new Error("notification_account_changed");
          const result = await fetch(this.base + path, {
            method: options.method || "GET", signal: controller.signal,
            headers: this._headers({ ...(secure ? { Authorization: "Bearer " + token } : {}), ...(options.prefer ? { Prefer: options.prefer } : {}) }),
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
          });
          if (!result.ok || !current()) throw new Error("notification_unavailable");
          const rows = options.minimal ? true : await result.json();
          if (!current()) throw new Error("notification_account_changed");
          return rows;
        };
        const result = await operation({ owner, request, current });
        return current() ? result : null;
      })().catch(() => null);
      return await Promise.race([work, cancelled]);
    } finally { clearTimeout(timer); controllers.delete(controller); }
  },
  async getNotifications() {
    return this._notificationRequest(async ({ owner, request }) => this._notificationRows(await request(
      "/notifications?uid=eq." + encodeURIComponent(owner) + "&select=id,uid,actor,type,post_id,ts,read&order=ts.desc,id.desc&limit=60"
    ), owner));
  },
  async markNotifsRead(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 60 || ids.some(id => !this._notificationId(id)) || new Set(ids).size !== ids.length) return false;
    const expected = new Set(ids);
    return await this._notificationRequest(async ({ owner, request }) => {
      const rows = await request("/notifications?uid=eq." + encodeURIComponent(owner) + "&id=in.(" + Array.from(expected, encodeURIComponent).join(",") + ")&select=id,uid,read", {
        method: "PATCH", body: { read: true }, prefer: "return=representation",
      });
      return Array.isArray(rows) && rows.length === expected.size && new Set(rows.map(row => row?.id)).size === expected.size
        && rows.every(row => row && expected.has(row.id) && row.uid === owner && row.read === true);
    }) === true;
  },
  async notificationMessageAvailable(actor) {
    if (!this._notificationId(actor) || !this._messageRecipient(actor)) return false;
    return await this._notificationRequest(async ({ owner, request }) => {
      if (actor === owner) return false;
      const rows = await request("/messages?from_uid=eq." + encodeURIComponent(actor) + "&to_uid=eq." + encodeURIComponent(owner) + "&select=id,from_uid,to_uid&limit=1");
      return Array.isArray(rows) && rows.length === 1 && this._notificationId(rows[0]?.id) && rows[0].from_uid === actor && rows[0].to_uid === owner;
    }) === true;
  },

  // ---- stories (24h) ----
  async addStory(url, kind = "photo", id = this._newActionId()) {
    const owner = this._publishingUid();
    if (!this.active() || !owner || !this._isUuid(id) || !["photo", "video"].includes(kind) || typeof url !== "string" || !/^https:\/\//.test(url)) return false;
    const row = await this._writeAction("/stories?on_conflict=id", "POST", { id, author: owner, photo: url, kind }, id, {
      owner, receipt: true, prefer: "resolution=ignore-duplicates,return=representation",
      reconcile: "/stories?id=eq." + encodeURIComponent(id) + "&author=eq." + encodeURIComponent(owner) + "&select=id,author,photo,kind,ts",
      matches: result => result.author === owner && result.photo === url && result.kind === kind && Number.isFinite(Date.parse(result.ts)),
    });
    return row ? { id: row.id, author: row.author, photo: row.photo, kind: row.kind, ts: Date.parse(row.ts) } : false;
  },
  async deleteStory(id) {
    const owner = this._publishingUid();
    if (!this.active() || !owner || typeof id !== "string" || !id || id.length > 255) return false;
    return this._writeAction("/stories?id=eq." + encodeURIComponent(id) + "&author=eq." + encodeURIComponent(owner) + "&select=id,author", "DELETE", undefined, id, {
      owner, matches: row => row.author === owner,
    });
  },

  // ---- direct messages ----
  _messageRecipient(uid) {
    const secure = window.USE_SUPABASE_AUTH || (typeof SupaAuth !== "undefined" && SupaAuth.active());
    return typeof uid === "string" && !!uid && (secure ? this._isUuid(uid) : uid.trim() === uid);
  },
  async sendMessage(toUid, body, id = this._newActionId()) {
    const uid = this._publishingUid(), notificationGeneration = this._notificationGeneration, publishingGeneration = this._publishingGeneration;
    if (!this.active() || !uid || !this._messageRecipient(toUid) || typeof body !== "string" || !body.trim() || typeof id !== "string" || !id) return false;
    const row = await this._writeAction("/messages?on_conflict=id", "POST", { id, from_uid: uid, to_uid: toUid, body }, id, {
      owner: uid, receipt: true, prefer: "resolution=ignore-duplicates,return=representation",
      reconcile: "/messages?id=eq." + encodeURIComponent(id) + "&from_uid=eq." + encodeURIComponent(uid) + "&to_uid=eq." + encodeURIComponent(toUid) + "&select=id,from_uid,to_uid,body,ts",
      matches: result => result.from_uid === uid && result.to_uid === toUid && result.body === body,
    });
    if (!row) return false;
    if (this.me === uid && this._notificationGeneration === notificationGeneration && this._publishingGeneration === publishingGeneration) {
      void Promise.resolve(this.notify(toUid, "message", null, undefined, row.id)).catch(() => {});
    }
    return { id: row.id, from: row.from_uid, to: row.to_uid, body: row.body, ts: new Date(row.ts || Date.now()).getTime() };
  },
  async _writeMessage(id, method, body, toUid) {
    const uid = this._publishingUid();
    if (!this.active() || !uid || typeof id !== "string" || !id || (toUid !== undefined && !this._messageRecipient(toUid))) return false;
    if (method === "PATCH" && (typeof body !== "string" || !body.trim())) return false;
    const recipient = toUid === undefined ? "" : "&to_uid=eq." + encodeURIComponent(toUid);
    return this._writeAction("/messages?id=eq." + encodeURIComponent(id) + "&from_uid=eq." + encodeURIComponent(uid) + recipient + "&select=id,from_uid,to_uid,body", method, method === "PATCH" ? { body } : undefined, id, {
      owner: uid,
      matches: row => row.from_uid === uid && this._messageRecipient(row.to_uid) && (toUid === undefined || row.to_uid === toUid) && (method !== "PATCH" || row.body === body),
    });
  },
  deleteMessage(id, toUid) { return this._writeMessage(id, "DELETE", undefined, toUid); },
  editMessage(id, body, toUid) { return this._writeMessage(id, "PATCH", body, toUid); },
  async getMessages(withUid) {
    return withUid ? this._readMessages(withUid) : null;
  },
  async getInbox() {
    return this._readMessages();
  },
  async _readMessages(withUid) {
    const uid = this._actionUid();
    if (!this.active() || !uid) return null;
    const controller = new AbortController(), generation = this._publishingGeneration;
    const controllers = this._publishingControllers || (this._publishingControllers = new Set());
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 6000);
    const current = () => this._actionUid() === uid && generation === this._publishingGeneration && !controller.signal.aborted;
    try {
      const secure = typeof SupaAuth !== "undefined" && SupaAuth.active();
      const token = secure ? await SupaAuth.token() : null;
      if (!current() || (secure && !token) || (window.USE_SUPABASE_AUTH && !secure)) return null;
      const me = encodeURIComponent(uid), other = encodeURIComponent(withUid || "");
      const filter = withUid ? "or=(and(from_uid.eq." + me + ",to_uid.eq." + other + "),and(from_uid.eq." + other + ",to_uid.eq." + me + "))&order=ts.asc"
        : "or=(from_uid.eq." + me + ",to_uid.eq." + me + ")&order=ts.desc";
      const result = await fetch(this.base + "/messages?" + filter + "&limit=300", { headers: this._headers(secure ? { Authorization: "Bearer " + token } : undefined), signal: controller.signal });
      if (!result.ok || !current()) return null;
      const rows = await result.json();
      if (!current() || !Array.isArray(rows) || rows.some(message => !message || typeof message.id !== "string" || typeof message.body !== "string")) return null;
      return rows.filter(message => (message.from_uid === uid || message.to_uid === uid)
        && (!withUid || (message.from_uid === uid && message.to_uid === withUid) || (message.from_uid === withUid && message.to_uid === uid)))
        .map(message => ({ id: message.id, from: message.from_uid, to: message.to_uid, body: message.body, ts: new Date(message.ts || 0).getTime() }));
    } catch (_) { return null; }
    finally { clearTimeout(timer); controllers.delete(controller); }
  },

  // ---- per-account personal data sync (streak/logs/weight follow the user across devices) ----
  async pushAccount(state) {
    if (!this.active() || !this.me || !state) return false;
    const uid = this.me;
    const generation = typeof Preferences !== "undefined" ? Preferences.generation : null;
    const body = JSON.stringify({ uid, data: state, updated_at: new Date().toISOString() });
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
    try {
      const secure = typeof SupaAuth !== "undefined" && SupaAuth.active();
      const token = secure ? await SupaAuth.token() : null;
      if (this.me !== uid || (secure && (!token || SupaAuth.uid() !== uid))) return false;
      const r = await fetch(this.base + "/accounts", { method: "POST", headers: this._headers({ Prefer: "resolution=merge-duplicates,return=minimal", ...(secure ? { Authorization: "Bearer " + token } : {}) }), body, signal: controller.signal });
      if (!r.ok || this.me !== uid || (secure && SupaAuth.uid() !== uid)) return false;
      if (typeof Preferences !== "undefined" && window.SERVER_MEASUREMENT && generation === Preferences.generation) {
        Promise.resolve(Preferences.accountSaved({ owner: uid, generation, acknowledged: true, snapshot: JSON.parse(body).data })).catch(() => {});
      }
      return true;
    } catch (e) { return false; }
    finally { clearTimeout(timer); }
  },
  async pullAccount() {
    if (!this.active() || !this.me) throw new Error("account_unavailable");
    const uid = this.me;
    const secure = typeof SupaAuth !== "undefined" && SupaAuth.active();
    const token = secure ? await SupaAuth.token() : null;
    if (this.me !== uid || (secure && (!token || SupaAuth.uid() !== uid))) throw new Error("account_auth_changed");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(this.base + "/accounts?uid=eq." + encodeURIComponent(uid) + "&select=data", { headers: this._headers(secure ? { Authorization: "Bearer " + token } : undefined), signal: controller.signal });
      if (!response.ok) throw new Error("account_unavailable");
      const rows = await response.json();
      if (!Array.isArray(rows) || (rows.length && !rows[0]?.data?.profile)) throw new Error("account_invalid");
      return rows.length ? rows[0].data : null;
    } finally { clearTimeout(timeout); }
  },

  // poll the shared state (only while the Feed is open) and push updates to the UI
  start(cb) {
    if (!this.active()) return;
    this.stop();
    this._cb = cb;
    this._paused = true;
    this._timer = setInterval(() => { if (!this._paused) this._tick(); }, 12000);
  },
  stop() {
    clearInterval(this._timer);
    this._timer = null;
    this._cb = null;
    this._paused = true;
    if (this._polling) this._polling.controller.abort();
    this._polling = null;
    this._busy = false;
  },
  async _tick() {
    if (this._polling) return;
    const request = this._polling = { controller: new AbortController(), uid: this.me, callback: this._cb };
    this._busy = true;
    try {
      const state = await this._get(request.controller);
      if (state && request.callback && this._polling === request && !this._paused && this.me === request.uid && this._cb === request.callback) request.callback(state);
    } finally {
      if (this._polling === request) { this._polling = null; this._busy = false; }
    }
  },
  setPaused(p) { this._paused = !!p; if (!p) this._tick(); },
};
