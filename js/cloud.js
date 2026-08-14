/* ============================================================
   CLOUD: shared social backend via Pantry (free keyless JSON store).
   One basket holds { users, posts, requests } — the members directory,
   connect requests and shared feed. Active when window.SOCIAL_API (a
   Pantry basket URL) is set. Personal workout/food/weight logs stay
   in localStorage only and are never uploaded.
   ============================================================ */
const Cloud = {
  base: null,
  me: null,
  _timer: null,
  _cb: null,

  active() { return !!window.SOCIAL_API; },
  uidFor(email) { return (email || "guest").toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 60); },

  init(account, profile) {
    if (!this.active()) return false;
    this.base = window.SOCIAL_API;
    this.me = this.uidFor(account && account.email);
    this.registerMe(profile);
    return true;
  },

  async _get() {
    try {
      const r = await fetch(this.base, { headers: { Accept: "application/json" } });
      if (r.status === 404) return { users: {}, posts: {}, requests: {} };
      if (!r.ok) return null;
      const s = await r.json();
      s.users = s.users || {}; s.posts = s.posts || {}; s.requests = s.requests || {};
      return s;
    } catch (e) { return null; }
  },
  // single-request DEEP-MERGE write (Pantry PUT merges objects) — no read, no race
  async _merge(patch) {
    try { const r = await fetch(this.base, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }); return r.ok; }
    catch (e) { return false; }
  },

  registerMe(profile) {
    if (!this.active()) return;
    const p = profile || (typeof Store !== "undefined" && Store.state && Store.state.profile) || {};
    return this._merge({ users: { [this.me]: {
      uid: this.me, username: p.username || "", name: p.name || "", avatar: p.avatar || "",
      physique: (typeof Engine !== "undefined" && Engine.getPhysique) ? Engine.getPhysique().name : "",
      bio: p.bio || "", streak: (typeof Engine !== "undefined" && Engine.streak) ? Engine.streak() : 0,
      updated: Date.now(),
    } } });
  },
  addPost(post) {
    if (!this.active()) return;
    const id = "p" + Date.now() + Math.floor(Math.random() * 999);
    return this._merge({ posts: { [id]: { id, author: this.me, likes: {}, ...post, ts: Date.now() } } });
  },
  likeCloud(postId) {
    if (!this.active()) return;
    return this._merge({ posts: { [postId]: { likes: { [this.me]: true } } } });
  },
  sendRequest(toUid) {
    if (!this.active()) return;
    return this._merge({ requests: { [this.me + "__" + toUid]: { id: this.me + "__" + toUid, from: this.me, to: toUid, ts: Date.now(), status: "pending" } } });
  },
  acceptRequest(fromUid) {
    if (!this.active()) return;
    return this._merge({ requests: { [fromUid + "__" + this.me]: { status: "accepted" } } });
  },

  // poll the shared basket (only while the Feed is open) and push updates to the UI
  start(cb) {
    if (!this.active()) return;
    this._cb = cb;
    this._paused = true;
    clearInterval(this._timer);
    this._timer = setInterval(() => { if (!this._paused) this._tick(); }, 25000);
  },
  async _tick() {
    if (this._busy) return;
    this._busy = true;
    try { const s = await this._get(); if (s && this._cb) this._cb(s); } finally { this._busy = false; }
  },
  setPaused(p) { this._paused = !!p; if (!p) this._tick(); },
};
