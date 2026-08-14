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
    return Object.assign({ apikey: this.key, Authorization: "Bearer " + this.key, "Content-Type": "application/json" }, extra || {});
  },

  _ensureIdentity(email) {
    if (!this.active()) return false;
    this.base = window.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1";
    this.key = window.SUPABASE_ANON_KEY;
    this.me = this.uidFor(email);
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
      const r = await fetch(this.base + "/rpc/get_state", { method: "POST", headers: this._headers(), body: "{}" });
      if (!r.ok) return null;
      const s = await r.json();
      return { users: (s && s.users) || {}, posts: (s && s.posts) || {}, requests: (s && s.requests) || {}, comments: (s && s.comments) || {} };
    } catch (e) { return null; }
  },
  async _write(path, body, extra) {
    try { const r = await fetch(this.base + path, { method: "POST", headers: this._headers(extra), body: JSON.stringify(body) }); return r.ok; }
    catch (e) { return false; }
  },

  registerMe(profile) {
    if (!this.active()) return;
    const p = profile || (typeof Store !== "undefined" && Store.state && Store.state.profile) || {};
    const data = {
      username: p.username || "", name: p.name || "", avatar: p.avatar || "",
      physique: (typeof Engine !== "undefined" && Engine.getPhysique) ? Engine.getPhysique().name : "",
      bio: p.bio || "", streak: (typeof Engine !== "undefined" && Engine.streak) ? Engine.streak() : 0,
      socials: p.socials || {}, privacy: p.privacy || "public",
    };
    return this._write("/profiles", { uid: this.me, data, updated_at: new Date().toISOString() }, { Prefer: "resolution=merge-duplicates,return=minimal" });
  },
  addPost(post) {
    if (!this.active()) return null;
    const id = "p" + Date.now() + Math.floor(Math.random() * 999);
    const data = { text: (post && post.text) || "", photo: (post && post.photo) || null, gradient: (post && post.gradient) || null, tag: (post && post.tag) || "Flex" };
    this._write("/posts", { id, author: this.me, data, likes: {} }, { Prefer: "return=minimal" });
    return { id, author: this.me, likes: {}, ts: Date.now(), ...data }; // for instant optimistic display
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
