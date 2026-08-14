/* ============================================================
   CLOUD: optional shared backend (Firestore) for real multi-user
   social — members directory, connect requests, shared feed.
   DORMANT until window.FIREBASE_CONFIG is set: active() stays false
   and every method is a safe no-op, so the app is unchanged offline.
   ============================================================ */
const Cloud = {
  ready: false,
  db: null,
  me: null,

  active() { return this.ready && !!this.db; },

  // load the Firebase SDK on demand, then init (only when configured)
  async init() {
    if (this.ready) return true;
    if (!window.FIREBASE_CONFIG) return false;
    try {
      if (typeof firebase === "undefined") {
        await this._load("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
        await this._load("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js");
      }
      if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
      this.db = firebase.firestore();
      this.ready = true;
      return true;
    } catch (e) { console.warn("[Cloud] init failed:", e && e.message); return false; }
  },
  _load(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  },

  uidFor(email) { return (email || "guest").toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 60); },

  // upsert my public profile into the shared directory
  async registerMe(profile, account) {
    if (!this.active()) return;
    this.me = this.uidFor(account && account.email);
    try {
      await this.db.collection("users").doc(this.me).set({
        uid: this.me,
        username: profile.username || "",
        name: profile.name || "",
        avatar: profile.avatar || "",
        physique: (typeof Engine !== "undefined" && Engine.getPhysique) ? Engine.getPhysique().name : "",
        bio: profile.bio || "",
        streak: (typeof Engine !== "undefined" && Engine.streak) ? Engine.streak() : 0,
        updated: Date.now(),
      }, { merge: true });
    } catch (e) { console.warn("[Cloud] registerMe:", e && e.message); }
  },

  onUsers(cb) {
    if (!this.active()) return;
    this.db.collection("users").onSnapshot((snap) => {
      const out = []; snap.forEach((d) => { const u = d.data(); if (u.uid !== this.me) out.push(u); });
      cb(out);
    }, (e) => console.warn("[Cloud] onUsers:", e && e.message));
  },

  // ---- connect requests ----
  async sendRequest(toUid) {
    if (!this.active()) return;
    try { await this.db.collection("requests").doc(this.me + "__" + toUid).set({ from: this.me, to: toUid, ts: Date.now(), status: "pending" }); }
    catch (e) { console.warn("[Cloud] sendRequest:", e && e.message); }
  },
  onRequests(cb) {
    if (!this.active()) return;
    this.db.collection("requests").where("to", "==", this.me).onSnapshot((snap) => {
      const out = []; snap.forEach((d) => { const r = d.data(); if (r.status === "pending") out.push({ id: d.id, ...r }); });
      cb(out);
    }, (e) => console.warn("[Cloud] onRequests:", e && e.message));
  },
  async acceptRequest(id) {
    if (!this.active()) return;
    try { await this.db.collection("requests").doc(id).set({ status: "accepted" }, { merge: true }); } catch (e) {}
  },

  // ---- shared feed ----
  async addPost(post) {
    if (!this.active()) return null;
    try { const ref = await this.db.collection("posts").add({ author: this.me, ...post, ts: Date.now() }); return ref.id; }
    catch (e) { console.warn("[Cloud] addPost:", e && e.message); return null; }
  },
  onFeed(cb) {
    if (!this.active()) return;
    this.db.collection("posts").orderBy("ts", "desc").limit(60).onSnapshot((snap) => {
      const out = []; snap.forEach((d) => out.push({ id: d.id, ...d.data() })); cb(out);
    }, (e) => console.warn("[Cloud] onFeed:", e && e.message));
  },
};
