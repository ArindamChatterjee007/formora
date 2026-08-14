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
      if (r.status === 404) return { users: {}, posts: [], requests: [] };
      if (!r.ok) return null;
      const s = await r.json();
      s.users = s.users || {}; s.posts = s.posts || []; s.requests = s.requests || [];
      return s;
    } catch (e) { return null; }
  },
  async _put(s) {
    try { const r = await fetch(this.base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ users: s.users, posts: s.posts, requests: s.requests }) }); return r.ok; }
    catch (e) { return false; }
  },
  // read -> mutate -> write, with retries to survive concurrent writers
  async _update(mutate) {
    for (let i = 0; i < 3; i++) {
      const s = await this._get();
      if (!s) { await this._sleep(400); continue; }
      mutate(s);
      if (await this._put(s)) { if (this._cb) this._cb(s); return true; }
      await this._sleep(400);
    }
    return false;
  },
  _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); },

  registerMe(profile) {
    if (!this.active()) return;
    const p = profile || (typeof Store !== "undefined" && Store.state && Store.state.profile) || {};
    return this._update((s) => {
      s.users[this.me] = {
        uid: this.me, username: p.username || "", name: p.name || "", avatar: p.avatar || "",
        physique: (typeof Engine !== "undefined" && Engine.getPhysique) ? Engine.getPhysique().name : "",
        bio: p.bio || "", streak: (typeof Engine !== "undefined" && Engine.streak) ? Engine.streak() : 0,
        updated: Date.now(),
      };
    });
  },
  addPost(post) {
    if (!this.active()) return;
    return this._update((s) => {
      s.posts.unshift({ id: "p" + Date.now() + Math.floor(Math.random() * 999), author: this.me, likedBy: [], ...post, ts: Date.now() });
      s.posts = s.posts.slice(0, 80);
    });
  },
  toggleLike(postId) {
    if (!this.active()) return;
    return this._update((s) => {
      const p = s.posts.find((x) => x.id === postId); if (!p) return;
      p.likedBy = p.likedBy || [];
      const i = p.likedBy.indexOf(this.me);
      if (i >= 0) p.likedBy.splice(i, 1); else p.likedBy.push(this.me);
    });
  },
  sendRequest(toUid) {
    if (!this.active()) return;
    return this._update((s) => { if (!s.requests.find((r) => r.from === this.me && r.to === toUid)) s.requests.push({ from: this.me, to: toUid, ts: Date.now(), status: "pending" }); });
  },
  acceptRequest(fromUid) {
    if (!this.active()) return;
    return this._update((s) => { const r = s.requests.find((x) => x.from === fromUid && x.to === this.me); if (r) r.status = "accepted"; });
  },

  // poll the shared basket and push updates to the UI
  start(cb) {
    if (!this.active()) return;
    this._cb = cb;
    const tick = async () => { const s = await this._get(); if (s && this._cb) this._cb(s); };
    tick();
    clearInterval(this._timer);
    this._timer = setInterval(tick, 7000);
  },
};
