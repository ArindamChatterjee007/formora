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
    const supaUid = (typeof SupaAuth !== "undefined" && SupaAuth.active && SupaAuth.active() && SupaAuth.uid()) || "";
    this.me = supaUid || this.uidFor(email);
    return true;
  },
  init(account, profile) {
    if (!this._ensureIdentity(account && account.email)) return false;
    this.registerMe(profile);
    return true;
  },

  // one RPC returns the whole shared state already shaped as { users, posts, requests }
  async _get() {
    try {
      if (typeof SupaAuth !== "undefined" && SupaAuth.active()) { await SupaAuth.token(); } // fresh JWT for RLS
      const r = await fetch(this.base + "/rpc/get_state", { method: "POST", headers: this._headers(), body: "{}" });
      if (!r.ok) return null;
      const s = await r.json();
      return { users: (s && s.users) || {}, posts: (s && s.posts) || {}, requests: (s && s.requests) || {}, comments: (s && s.comments) || {}, stories: (s && s.stories) || {} };
    } catch (e) { return null; }
  },
  async _write(path, body, extra) {
    try { const r = await fetch(this.base + path, { method: "POST", headers: this._headers(extra), body: JSON.stringify(body) }); return r.ok; }
    catch (e) { return false; }
  },

  // upload a File/Blob to the public 'media' Storage bucket → returns its public URL (used for video/reels + story media)
  async uploadMedia(file, folder) {
    if (!this.active() || !file) return null;
    try {
      const mime = file.type || "application/octet-stream";
      const ext = (mime.split("/")[1] || "bin").split(";")[0].replace("quicktime", "mov").replace("jpeg", "jpg");
      const sub = (folder || "misc") + "/" + this.me + "/" + Date.now() + "_" + Math.floor(Math.random() * 99999) + "." + ext;
      const root = window.SUPABASE_URL.replace(/\/$/, "");
      const r = await fetch(root + "/storage/v1/object/media/" + sub, {
        method: "POST",
        headers: { apikey: this.key, Authorization: "Bearer " + (((typeof SupaAuth !== "undefined" && SupaAuth.bearer) ? SupaAuth.bearer() : null) || this.key), "Content-Type": mime, "x-upsert": "true" },
        body: file,
      });
      if (!r.ok) return null;
      return root + "/storage/v1/object/public/media/" + sub;
    } catch (e) { return null; }
  },

  registerMe(profile) {
    if (!this.active()) return;
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
      verified: !!p.verified, score, workouts, seen: Date.now(), tier: p.tier || "free",
      cover: p.coverUrl || "",
    };
    return this._write("/profiles", { uid: this.me, data, updated_at: new Date().toISOString() }, { Prefer: "resolution=merge-duplicates,return=minimal" });
  },
  addPost(post) {
    if (!this.active()) return null;
    const id = (post && post.id) || ("p" + Date.now() + Math.floor(Math.random() * 999));
    const data = { text: (post && post.text) || "", photo: (post && post.photo) || null, photos: (post && post.photos) || null, video: (post && post.video) || null, gradient: (post && post.gradient) || null, tag: (post && post.tag) || "Flex", resharedFrom: (post && post.resharedFrom) || null, reshareOf: (post && post.reshareOf) || null, music: (post && post.music) || null };
    // deterministic-id reshares upsert (merge-duplicates) so a post can't be reshared twice by the same account
    const extra = (post && post.merge) ? { Prefer: "resolution=merge-duplicates,return=minimal" } : { Prefer: "return=minimal" };
    this._write("/posts", { id, author: this.me, data, likes: {} }, extra);
    return { id, author: this.me, likes: {}, ts: Date.now(), ...data }; // for instant optimistic display
  },
  async deletePost(id) {
    if (!this.active() || !id) return false;
    try { const r = await fetch(this.base + "/posts?id=eq." + encodeURIComponent(id), { method: "DELETE", headers: this._headers({ Prefer: "return=minimal" }) }); return r.ok; }
    catch (e) { return false; }
  },
  async editPost(id, data) {
    if (!this.active() || !id) return false;
    try { const r = await fetch(this.base + "/posts?id=eq." + encodeURIComponent(id) + "&author=eq." + encodeURIComponent(this.me), { method: "PATCH", headers: this._headers({ Prefer: "return=minimal" }), body: JSON.stringify({ data }) }); return r.ok; }
    catch (e) { return false; }
  },
  async deleteComment(id) {
    if (!this.active() || !id) return false;
    try { const r = await fetch(this.base + "/comments?id=eq." + encodeURIComponent(id), { method: "DELETE", headers: this._headers({ Prefer: "return=minimal" }) }); return r.ok; }
    catch (e) { return false; }
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
  notify(uid, type, postId, body) {
    if (!this.active() || !uid || uid === this.me) return;
    const id = "n" + Date.now() + Math.floor(Math.random() * 99999);
    return this._write("/notifications", { id, uid, type, actor: this.me, post_id: postId || null, body: (body || "").slice(0, 140) }, { Prefer: "return=minimal" });
  },
  async getNotifications() {
    if (!this.active() || !this.me) return [];
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(this.base + "/notifications?uid=eq." + encodeURIComponent(this.me) + "&order=ts.desc&limit=60", { headers: this._headers(), signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) return [];
      return await r.json();
    } catch (e) { return []; }
  },
  async markNotifsRead() {
    if (!this.active() || !this.me) return;
    try { await fetch(this.base + "/notifications?uid=eq." + encodeURIComponent(this.me) + "&read=eq.false", { method: "PATCH", headers: this._headers({ Prefer: "return=minimal" }), body: JSON.stringify({ read: true }) }); } catch (e) {}
  },

  // ---- stories (24h) ----
  addStory(url, kind) {
    if (!this.active() || !url) return null;
    const id = "st" + Date.now() + Math.floor(Math.random() * 99999);
    this._write("/stories", { id, author: this.me, photo: url, kind: kind || "photo" }, { Prefer: "return=minimal" });
    return { id, author: this.me, photo: url, kind: kind || "photo", ts: Date.now() };
  },
  async deleteStory(id) {
    if (!this.active() || !id) return;
    try { const r = await fetch(this.base + "/stories?id=eq." + encodeURIComponent(id), { method: "DELETE", headers: this._headers({ Prefer: "return=minimal" }) }); return r.ok; }
    catch (e) { return false; }
  },

  // ---- direct messages ----
  sendMessage(toUid, body) {
    if (!this.active() || !toUid || !body) return null;
    const id = "m" + Date.now() + Math.floor(Math.random() * 99999);
    this._write("/messages", { id, from_uid: this.me, to_uid: toUid, body }, { Prefer: "return=minimal" });
    this.notify(toUid, "message", null, body);
    return { id, from: this.me, to: toUid, body, ts: Date.now() };
  },
  async deleteMessage(id) {
    if (!this.active() || !id) return false;
    try { const r = await fetch(this.base + "/messages?id=eq." + encodeURIComponent(id) + "&from_uid=eq." + encodeURIComponent(this.me), { method: "DELETE", headers: this._headers({ Prefer: "return=minimal" }) }); return r.ok; }
    catch (e) { return false; }
  },
  async editMessage(id, body) {
    if (!this.active() || !id || !body) return false;
    try { const r = await fetch(this.base + "/messages?id=eq." + encodeURIComponent(id) + "&from_uid=eq." + encodeURIComponent(this.me), { method: "PATCH", headers: this._headers({ Prefer: "return=minimal" }), body: JSON.stringify({ body }) }); return r.ok; }
    catch (e) { return false; }
  },
  async getMessages(withUid) {
    if (!this.active() || !this.me || !withUid) return [];
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 6000);
      const me = encodeURIComponent(this.me), o = encodeURIComponent(withUid);
      const url = this.base + "/messages?or=(and(from_uid.eq." + me + ",to_uid.eq." + o + "),and(from_uid.eq." + o + ",to_uid.eq." + me + "))&order=ts.asc&limit=300";
      const r = await fetch(url, { headers: this._headers(), signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) return [];
      const rows = await r.json();
      return rows.map((m) => ({ id: m.id, from: m.from_uid, to: m.to_uid, body: m.body, ts: new Date(m.ts).getTime() }));
    } catch (e) { return []; }
  },
  async getInbox() {
    if (!this.active() || !this.me) return [];
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 6000);
      const me = encodeURIComponent(this.me);
      const url = this.base + "/messages?or=(from_uid.eq." + me + ",to_uid.eq." + me + ")&order=ts.desc&limit=300";
      const r = await fetch(url, { headers: this._headers(), signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) return [];
      const rows = await r.json();
      return rows.map((m) => ({ id: m.id, from: m.from_uid, to: m.to_uid, body: m.body, ts: new Date(m.ts).getTime() }));
    } catch (e) { return []; }
  },

  // ---- per-account personal data sync (streak/logs/weight follow the user across devices) ----
  async pushAccount(state) {
    if (!this.active() || !this.me || !state) return false;
    try {
      const r = await fetch(this.base + "/accounts", { method: "POST", headers: this._headers({ Prefer: "resolution=merge-duplicates,return=minimal" }), body: JSON.stringify({ uid: this.me, data: state, updated_at: new Date().toISOString() }) });
      return r.ok;
    } catch (e) { return false; }
  },
  async pullAccount() {
    if (!this.active() || !this.me) return null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(this.base + "/accounts?uid=eq." + encodeURIComponent(this.me) + "&select=data", { headers: this._headers(), signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) return null;
      const rows = await r.json();
      return rows && rows[0] ? rows[0].data : null;
    } catch (e) { return null; }
  },

  // poll the shared state (only while the Feed is open) and push updates to the UI
  start(cb) {
    if (!this.active()) return;
    this._cb = cb;
    this._paused = true;
    clearInterval(this._timer);
    this._timer = setInterval(() => { if (!this._paused) this._tick(); }, 12000);
  },
  async _tick() {
    if (this._busy) return;
    this._busy = true;
    try { const s = await this._get(); if (s && this._cb) this._cb(s); } finally { this._busy = false; }
  },
  setPaused(p) { this._paused = !!p; if (!p) this._tick(); },
};
