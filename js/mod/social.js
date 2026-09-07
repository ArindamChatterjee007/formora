/* ============================================================
   SOCIAL: "gym Instagram" layer — feed, crew, chat, challenges.
   Client-only + seeded demo profiles (per-user localStorage).
   NOTE: real cross-user social needs a backend (Firebase). This
   makes the full experience work locally on this device today.
   ============================================================ */

// demo gym profiles ("Crew" you can connect with)
const SOCIAL_PERSONAS = [
  { id: "p1", name: "Rohan Mehta",  handle: "rohanlifts",       colors: ["#ff6b3d", "#ff3d7f"], physique: "Powerful Mass",    bio: "Powerlifter · chasing a 200kg deadlift",     level: "Beast",  streak: 42 },
  { id: "p2", name: "Ananya Sharma", handle: "ananyafit",       colors: ["#3d8bff", "#22c55e"], physique: "Athletic Sculpted", bio: "Yoga + lifting · 5am grind",                 level: "Elite",  streak: 61 },
  { id: "p3", name: "Vikram Singh",  handle: "vikstrong",       colors: ["#a855f7", "#ff3d7f"], physique: "Greek God",        bio: "Classic physique · calisthenics",            level: "Pro",    streak: 28 },
  { id: "p4", name: "Priya Nair",    handle: "priya.moves",     colors: ["#f5b301", "#ff6b3d"], physique: "Toned & Lean",     bio: "Runner turned lifter 🏃→🏋️",                level: "Rising", streak: 15 },
  { id: "p5", name: "Arjun Kapoor",  handle: "arjun_aesthetic", colors: ["#22c55e", "#3d8bff"], physique: "Lean Aesthetic",   bio: "Lean-bulk szn · Bollywood body goals",       level: "Elite",  streak: 88 },
  { id: "p6", name: "Sara Iyer",     handle: "sara.strong",     colors: ["#ff3d7f", "#a855f7"], physique: "Strong & Fit",     bio: "Crossfit · strong is beautiful",             level: "Pro",    streak: 33 },
];

const Social = {
  key: null,
  state: null,

  resetSession() {
    this._session = (this._session || 0) + 1;
    if (typeof Stories !== "undefined") Stories.reset();
    this.cancelStory(); this.closeStory();
    if (typeof Cloud !== "undefined" && Cloud.resetPublishing) Cloud.resetPublishing();
    this._pendingActions = new Set();
    this._postRequest = null;
    this._postText = "";
    this.pendingPost = null;
    this.pendingPhotos = [];
    this.pendingVideo = null;
    this.pendingMusic = null;
    this.pendingVideoUploading = false;
    this._videoUpload = null;
    for (const key of Object.keys(this.cloud)) this.cloud[key] = [];
    this._feedRead = "idle";
    this._pinged = new Set();
    this._dmWith = null;
    this._dmMsgs = [];
    this._dmDrafts = new Map();
    this._dmConvos = [];
    this._dmInboxLoaded = false;
    this._dmInboxLoading = false;
    this._dmThreadLoading = false;
    this._dmReadError = false;
    this._dmInboxError = false;
    this._dmSearch = "";
    this._dmSearchOpen = false;
    this._editMsg = null;
    this._storyContext = new Map();
    this._storyContextPass = null;
    this._storyContextOpening = null;
    clearTimeout(this._editPrefillTimer);
  },
  load(uid) {
    if (this.key !== "formora_social_" + (uid || "guest")) this.resetSession();
    this.key = "formora_social_" + (uid || "guest");
    try {
      this.state = JSON.parse(localStorage.getItem(this.key));
    } catch { this.state = null; }
    if (!this.state || !this.state.seeded) this.state = this.seed();
    // guard arrays after schema changes
    this.state.crew = this.state.crew || [];
    this.state.posts = this.state.posts || [];
    this.state.challenges = this.state.challenges || [];
    this.state.chats = this.state.chats || {};
    this.state.following = this.state.following || [];
    this.save();
    return this.state;
  },
  save() { try { localStorage.setItem(this.key, JSON.stringify(this.state)); } catch (e) {} },

  seed() {
    const now = Date.now(), hr = 3600e3;
    const posts = [
      { id: "s1", author: "p5", text: "Upper-chest day done ✅ Incline volume is finally paying off. Shelf is coming in 💪", gradient: ["#22c55e", "#3d8bff"], tag: "Push Day", likes: 34, comments: [{ by: "p2", text: "Beast mode 🔥" }, { by: "p3", text: "That taper 👏" }], reshares: 3, likedByMe: false, ts: now - 2 * hr },
      { id: "s2", author: "p2", text: "5am club ☀️ 61-day streak. Consistency > motivation. Who's challenging me this week?", gradient: ["#3d8bff", "#22c55e"], tag: "Cardio", likes: 58, comments: [{ by: "p4", text: "Inspiring!" }], reshares: 7, likedByMe: false, ts: now - 6 * hr },
      { id: "s3", author: "p1", text: "New deadlift PR — 180kg x 3 🏋️ Road to 200 is ON.", gradient: ["#ff6b3d", "#ff3d7f"], tag: "Pull Day", likes: 91, comments: [{ by: "p5", text: "Monster 💪" }, { by: "p6", text: "Let's gooo" }], reshares: 12, likedByMe: false, ts: now - 20 * hr },
      { id: "s4", author: "p4", text: "First unassisted pull-up today 🥹 small wins add up!", gradient: ["#f5b301", "#ff6b3d"], tag: "Win", likes: 47, comments: [{ by: "p2", text: "Huge!! 🎉" }], reshares: 2, likedByMe: false, ts: now - 30 * hr },
    ];
    return { seeded: true, crew: [], posts, challenges: [], chats: {} };
  },

  // ---- identity ----
  me() {
    const p = (typeof Store !== "undefined" && Store.state && Store.state.profile) || {};
    const phys = (typeof Engine !== "undefined" && Engine.getPhysique) ? Engine.getPhysique().name : "Lean Aesthetic";
    const streak = (typeof Engine !== "undefined" && Engine.streak) ? Engine.streak() : 0;
    const st = (typeof Engine !== "undefined" && Engine.stats) ? Engine.stats() : {};
    const wt = (typeof Store !== "undefined" && Store.latestWeight) ? (Store.latestWeight() || p.startWeightKg || 0) : (p.startWeightKg || 0);
    return { id: "me", name: p.name || "You", handle: p.username || (p.email || "you").split("@")[0], colors: ["#ff6b3d", "#ff3d7f"], physique: phys, bio: p.bio || "", level: streak > 60 ? "Elite" : streak > 30 ? "Pro" : streak > 7 ? "Rising" : "Rookie", streak, avatar: p.avatar || null, verified: !!p.verified, email: p.email || "", heightCm: p.heightCm || 0, weightKg: Math.round(wt * 10) / 10, bmi: st.bmi || 0, score: (typeof Engine !== "undefined" && Engine.fitnessScore) ? Engine.fitnessScore() : 0, workouts: (typeof Engine !== "undefined" && Engine.totalWorkouts) ? Engine.totalWorkouts() : 0, seen: Date.now() };
  },
  persona(id) {
    if (id === "me") return this.me();
    if (typeof Cloud !== "undefined" && Cloud.me && id === Cloud.me) return this.me(); // my own cloud posts render as me
    const local = SOCIAL_PERSONAS.find((x) => x.id === id);
    if (local) return local;
    if (this.cloudActive()) { const c = this.cloudUser(id); if (c) return c; }
    return { id, name: "Unknown", handle: "unknown", colors: ["#8b93a7", "#262c3a"], physique: "", bio: "", level: "" };
  },

  // ---- feed ----
  feed() { return [...this.state.posts].sort((a, b) => b.ts - a.ts); },
  post(id) { return this.state.posts.find((p) => p.id === id); },
  toggleLike(id) {
    const p = this.post(id); if (!p) return;
    p.likedByMe = !p.likedByMe; p.likes += p.likedByMe ? 1 : -1; this.save();
  },
  addComment(id, text) {
    const p = this.post(id); if (!p || !text.trim()) return;
    p.comments.push({ by: "me", text: text.trim() }); this.save();
  },
  reshare(id) {
    const src = this.post(id); if (!src) return;
    src.reshares = (src.reshares || 0) + 1;
    this.state.posts.push({ id: "u" + Date.now(), author: "me", text: src.text, gradient: src.gradient, tag: src.tag, resharedFrom: src.author, likes: 0, comments: [], reshares: 0, likedByMe: false, ts: Date.now() });
    this.save();
  },
  createPost({ text, photo, tag }) {
    const grad = this.me().colors;
    this.state.posts.push({ id: "u" + Date.now(), author: "me", text: (text || "").trim(), photo: photo || null, gradient: grad, tag: tag || "Flex", likes: 0, comments: [], reshares: 0, likedByMe: false, ts: Date.now() });
    this.save();
  },
  deletePost(id) { this.state.posts = this.state.posts.filter((p) => p.id !== id); this.save(); },

  // ---- crew (connections) ----
  inCrew(id) { return this.state.crew.includes(id); },
  addCrew(id) { if (!this.inCrew(id)) { this.state.crew.push(id); this.save(); } },
  removeCrew(id) { this.state.crew = this.state.crew.filter((x) => x !== id); this.save(); },
  crewList() { return this.state.crew.map((id) => this.persona(id)); },
  suggestions() { return this.cloudActive() ? [] : SOCIAL_PERSONAS.filter((p) => !this.inCrew(p.id)); },
  isFollowing(id) { return (this.state.following || []).includes(id); },
  toggleFollow(id) {
    this.state.following = this.state.following || [];
    this.state.following = this.isFollowing(id) ? this.state.following.filter((x) => x !== id) : [...this.state.following, id];
    this.save(); this.render();
  },

  // ---- chat (simulated replies) ----
  messages(id) { return this.state.chats[id] || []; },
  sendMessage(id, text) {
    if (!text.trim()) return;
    const thread = this.state.chats[id] || (this.state.chats[id] = []);
    thread.push({ by: "me", text: text.trim(), ts: Date.now() });
    const replies = ["Let's train together soon 💪", "Beast! Keep it up 🔥", "Respect the grind 🙌", "Challenge me this week?", "That's solid progress!", "Haha same here, legs are sore 😅"];
    const r = replies[(text.length + thread.length) % replies.length];
    thread.push({ by: id, text: r, ts: Date.now() + 1000 });
    this.save();
  },

  // ---- challenges ----
  createChallenge({ withId, title, days }) {
    this.state.challenges.push({ id: "c" + Date.now(), withId, title: title || "7-day streak duel", days: days || 7, start: Date.now(), meDone: 0, status: "active" });
    this.save();
  },
  challengeTick(id) {
    const c = this.state.challenges.find((x) => x.id === id); if (!c) return;
    c.meDone = Math.min(c.days, c.meDone + 1);
    if (c.meDone >= c.days) c.status = "won";
    this.save();
  },
  dropChallenge(id) { this.state.challenges = this.state.challenges.filter((c) => c.id !== id); this.save(); },

  /* ============================ UI ============================ */
  sub: "feed",
  pendingPost: null,
  chatWith: null,
  cloud: { users: [], requests: [], feed: [], sent: [], connections: [], comments: [], notifs: [], stories: [] },
  cloudActive() { return typeof Cloud !== "undefined" && Cloud.active(); },
  // outcome of the shared-state read, so an outage is never rendered as an empty account
  _feedRead: "idle",
  noteFeedRead(ok) { this._feedRead = ok ? "ready" : "error"; },
  feedReadState() { return this._feedRead || "idle"; },
  feedStatusCard() {
    const state = this.feedReadState();
    if (state === "error") {
      return `<div class="card" role="alert"><div style="font-weight:800;margin-bottom:4px">Your feed could not be loaded</div>
        <div class="sub" style="margin-bottom:12px">We could not reach Formora just now. Nothing has been deleted — this is a connection problem, not an empty account.</div>
        <button class="btn ghost" onclick="App.retryFeed()">${App.ic("undo", { size: 16 })} Retry</button></div>`;
    }
    if (state === "loading" || state === "idle") {
      return `<div class="card"><div role="status" style="font-weight:700">Loading your feed…</div></div>`;
    }
    return `<div class="card">${App.emptyState("users", "No posts yet", "Share your first update above and your crew will see it here.")}</div>`;
  },
  cloudUser(uid) {
    const u = this.cloud.users.find((x) => x.uid === uid);
    if (!u) return null;
    const st = u.streak || 0;
    return { id: u.uid, name: u.name || u.username || "Member", handle: u.username || "member", physique: u.physique || "", bio: u.bio || "", level: (st > 60 ? "Elite" : st > 30 ? "Pro" : st > 7 ? "Rising" : ""), tier: u.tier || "free", colors: ["#ff6b3d", "#3d8bff"], avatar: u.avatar || null, streak: st, socials: u.socials || {}, privacy: u.privacy || "public", following: u.following || [], verified: !!u.verified, heightCm: u.heightCm || 0, weightKg: u.weightKg || 0, bmi: u.bmi || 0, score: u.score || 0, workouts: u.workouts || 0, gender: u.gender || "", seen: u.seen || 0, cover: u.cover || "" };
  },
  // small ✓ shown next to a verified member's name (email confirmed or Google sign-in)
  vbadge(u) { return (u && u.verified) ? ` <span class="vbadge" title="Verified — email confirmed">✓</span>` : ""; },
  // ---- presence (green dot / last-active) from profile.seen heartbeat ----
  isOnline(uid) {
    if (!uid) return false;
    if (uid === "me" || (typeof Cloud !== "undefined" && uid === Cloud.me)) return true;
    const u = (this.cloud.users || []).find((x) => x.uid === uid);
    return !!(u && u.seen && (Date.now() - u.seen) < 90000);
  },
  lastSeenText(uid) {
    if (this.isOnline(uid)) return "Active now";
    const u = (this.cloud.users || []).find((x) => x.uid === uid);
    return (u && u.seen) ? "Active " + this.timeAgo(u.seen) + " ago" : "";
  },
  avatarP(entity, size) {
    const e = typeof entity === "string" ? this.persona(entity) : entity;
    const on = e && e.id && this.isOnline(e.id);
    return `<span class="av-wrap">${this.avatar(e, size)}${on ? '<span class="online-dot"></span>' : ""}</span>`;
  },
  // ---- follow (one-way, LinkedIn-style) + counts ----
  myFollowing() { return (typeof Store !== "undefined" && Store.state.profile && Store.state.profile.following) || []; },
  isFollowing(uid) { return this.myFollowing().includes(uid); },
  toggleFollow(uid) {
    if (!uid || uid === (typeof Cloud !== "undefined" ? Cloud.me : null)) return; // can't follow yourself
    const p = Store.state.profile;
    if (!p.following) p.following = [];
    const i = p.following.indexOf(uid);
    if (i >= 0) { p.following.splice(i, 1); if (typeof App !== "undefined" && App.toast) App.toast("Unfollowed"); }
    else { p.following.push(uid); if (this.cloudActive() && Cloud.notify && Cloud.me) Cloud.notify(uid, "follow", null, ""); if (typeof App !== "undefined" && App.toast) App.toast("Following ✓"); }
    Store.save();
    if (this.cloudActive() && Cloud.registerMe && Cloud.me) Cloud.registerMe(p);
    this.render();
  },
  followingCount() { return this.myFollowing().length; },
  followersCount(uid) {
    const t = uid || (typeof Cloud !== "undefined" ? Cloud.me : null); if (!t) return 0;
    let n = (this.cloud.users || []).filter((u) => (u.following || []).includes(t)).length;
    // my own follow isn't in cloud.users (self is filtered out) — count it when viewing someone I follow
    if (typeof Cloud !== "undefined" && t !== Cloud.me && this.isFollowing(t)) n += 1;
    return n;
  },
  connectionsCount() { return (this.cloud.connections || []).length; },
  followBtn(uid) {
    if (!this.cloudActive() || uid === Cloud.me) return "";
    return this.isFollowing(uid)
      ? `<button class="btn ghost sm" onclick="event.stopPropagation();Social.toggleFollow('${uid}')">Following ✓</button>`
      : `<button class="btn sm follow" onclick="event.stopPropagation();Social.toggleFollow('${uid}')">+ Follow</button>`;
  },
  // connecting auto-follows both people (LinkedIn-style); unfollow = opt-out, remembered so we never re-auto-follow
  autoFollowOnConnect(uid) {
    if (!uid || (typeof Cloud !== "undefined" && uid === Cloud.me)) return;
    const p = Store.state.profile;
    if (!p.autoFollowed) p.autoFollowed = [];
    if (!p.following) p.following = [];
    if (p.autoFollowed.includes(uid) || p.following.includes(uid)) return;
    p.following.push(uid); p.autoFollowed.push(uid);
    Store.save();
    if (this.cloudActive() && Cloud.registerMe && Cloud.me) Cloud.registerMe(p);
  },
  syncAutoFollow() {
    const p = Store.state.profile;
    if (!p.autoFollowed) p.autoFollowed = [];
    if (!p.following) p.following = [];
    const me = (typeof Cloud !== "undefined") ? Cloud.me : null;
    let changed = false;
    (this.cloud.connections || []).forEach((uid) => {
      if (uid && uid !== me && !p.autoFollowed.includes(uid) && !p.following.includes(uid)) { p.following.push(uid); p.autoFollowed.push(uid); changed = true; }
    });
    if (changed) { Store.save(); if (this.cloudActive() && Cloud.registerMe && Cloud.me) Cloud.registerMe(p); }
  },
  // feed priority: your own + people you follow + connections rank above everyone else, each newest-first
  _rankFeed(posts) {
    const me = (typeof Cloud !== "undefined") ? Cloud.me : null;
    const following = this.myFollowing();
    const conns = this.cloud.connections || [];
    const pri = (p) => (p.author === me ? 3 : following.includes(p.author) ? 2 : conns.includes(p.author) ? 1 : 0);
    return posts.slice().sort((a, b) => (pri(b) - pri(a)) || ((b.ts || 0) - (a.ts || 0)));
  },
  // friends-only posts are hidden from non-connected viewers (UI-level privacy)
  _isBanned(uid) { return !!(uid && window.BANNED_UIDS && window.BANNED_UIDS.includes(uid)); },
  _canSeePost(p) {
    if (!p) return false;
    if (this.isHidden(p.id)) return false;
    if (p.author && this.isBlocked(p.author) && !this._isMine(p)) return false;
    if (this._isBanned(p.author)) return false;
    if (typeof Cloud === "undefined" || p.author === Cloud.me) return true;
    const a = this.cloudUser(p.author);
    if (a && a.privacy === "friends") return (this.cloud.connections || []).includes(p.author) || this.inCrew(p.author);
    return true;
  },

  render(sub) {
    if (sub) this.sub = sub;
    const el = document.getElementById("view-feed");
    if (!el) return;
    const sub2 = this.sub || "feed";
    const nav = [["feed", App.ic("flame", { size: 16 }) + " Feed"], ["crew", App.ic("users", { size: 16 }) + " Crew"], ["chat", App.ic("chat", { size: 16 }) + " Chat"], ["challenges", App.ic("trophy", { size: 16 }) + " Challenges"]];
    const body = sub2 === "feed" ? this.feedBody() : sub2 === "crew" ? this.crewBody() : sub2 === "chat" ? this.chatBody() : this.challengesBody();
    el.innerHTML = `<div class="social-subnav">${nav.map(([n, l]) => `<button class="ssub ${n === sub2 ? "active" : ""}" onclick="Social.feedTab('${n}')">${l}</button>`).join("")}</div>${body}`;
    if (sub2 === "feed") this._bindFeedVideos();
    if (sub2 === "chat") { this.scrollChat(); this._paintStoryContext(); }
  },
  feedTab(n) { this.sub = n; this.render(); },
  // Instagram-style feed video: muted autoplay in view; TAP the video turns sound on; speaker toggles it (persists across videos)
  _feedSound: false,
  _applyFeedSound(cur) {
    document.querySelectorAll("#view-feed .post-media.video video").forEach((v) => { v.muted = v.getAttribute("data-msrc") ? true : !this._feedSound; });
    document.querySelectorAll("#view-feed .fv-mute").forEach((b) => { b.innerHTML = App.ic(this._feedSound ? "volume" : "mute", { size: 18 }); });
    if (this._musicAudio) this._musicAudio.muted = !this._feedSound;
    if (cur) { cur.muted = cur.getAttribute("data-msrc") ? true : !this._feedSound; cur.play().catch(() => {}); }
  },
  tapFeedVideo(v) {
    if (v.muted) { this._feedSound = true; this._applyFeedSound(v); return; } // first tap = sound on
    if (v.paused) v.play().catch(() => {}); else v.pause();
  },
  toggleFeedMute(btn) {
    this._feedSound = !this._feedSound;
    const wrap = btn.closest(".post-media.video");
    this._applyFeedSound(wrap && wrap.querySelector("video"));
    if (typeof App !== "undefined" && App.toast) App.toast(this._feedSound ? "🔊 Sound on" : "Muted");
  },
  _bindFeedVideos() {
    const vids = [].slice.call(document.querySelectorAll("#view-feed .post-media.video video"));
    const pms = [].slice.call(document.querySelectorAll("#view-feed .post-media[data-pmsrc]"));
    const nodes = vids.concat(pms);
    if (!nodes.length) { if (this._feedVidObs) { this._feedVidObs.disconnect(); this._feedVidObs = null; } this.stopMusic(); return; }
    if (this._feedVidObs) this._feedVidObs.disconnect();
    this._feedVidObs = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        const el = e.target;
        const isVid = el.tagName === "VIDEO";
        const msrc = isVid ? (el.getAttribute("data-msrc") || "") : (el.getAttribute("data-pmsrc") || "");
        if (e.isIntersecting && e.intersectionRatio > 0.6) {
          document.querySelectorAll("#view-feed .post-media.video video").forEach((o) => { if (o !== el) o.pause(); });
          if (msrc) { if (isVid) el.muted = true; Social.playMusic(msrc); }
          else { if (isVid) el.muted = !Social._feedSound; if (Social._musicSrc) Social.stopMusic(); }
          if (isVid) el.play().catch(() => {});
        } else { if (isVid) el.pause(); if (msrc && Social._musicSrc === msrc) Social.stopMusic(); }
      });
    }, { threshold: [0, 0.6, 1] });
    nodes.forEach((n) => this._feedVidObs.observe(n));
  },
  // double-tap media = like (Instagram-style) with a heart burst; single tap keeps its action
  mediaTap(postId, ev, kind) {
    const now = Date.now();
    if (this._tapId === postId && now - (this._tapTime || 0) < 300) {
      clearTimeout(this._tapTimer); this._tapTime = 0; this._tapId = null;
      this._heartBurst(ev);
      this.likeIfNot(postId);
      return;
    }
    this._tapId = postId; this._tapTime = now;
    const target = ev.currentTarget;
    clearTimeout(this._tapTimer);
    this._tapTimer = setTimeout(() => {
      if (kind === "video") { const v = target.tagName === "VIDEO" ? target : target.querySelector("video"); if (v) this.tapFeedVideo(v); }
    }, 300);
  },
  likeIfNot(id) {
    const inFeed = this.cloudActive() ? (this.cloud.feed || []).find((p) => p.id === id) : (this.feed() || []).find((p) => p.id === id);
    if (!inFeed) return;
    const liked = this.cloudActive() ? !!(inFeed.likes && typeof Cloud !== "undefined" && Cloud.me && inFeed.likes[Cloud.me]) : !!inFeed.likedByMe;
    if (!liked) this.likePost(id); // double-tap only ever LIKES, never unlikes
  },
  _heartBurst(ev) {
    const x = (ev && (ev.clientX || (ev.touches && ev.touches[0] && ev.touches[0].clientX))) || (window.innerWidth / 2);
    const y = (ev && (ev.clientY || (ev.touches && ev.touches[0] && ev.touches[0].clientY))) || (window.innerHeight / 2);
    const h = document.createElement("div");
    h.className = "heart-burst";
    h.style.left = x + "px"; h.style.top = y + "px";
    h.innerHTML = App.ic("heart", { size: 96, solid: true });
    document.body.appendChild(h);
    this.haptic(18);
    setTimeout(() => h.remove(), 800);
  },
  // ---- music (royalty-free): attach a track in the composer; plays in feed + reels ----
  pendingMusic: null,
  _musicSrc: null,
  _musicCat: "Trending",
  _musicQuery: "",
  _musicCover(t) {
    const g = { Workout: "#ff5a3c,#ff2d55", Hype: "#b14bff,#ff3d7f", Chill: "#2dd4bf,#3b82f6", "Lo-fi": "#6366f1,#a855f7", Focus: "#10b981,#22c55e", Cinematic: "#f59e0b,#334155" }[t.genre] || "#ff9d4d,#ff3d7f";
    return "linear-gradient(135deg," + g + ")";
  },
  _trackById(id) { return ((window.MUSIC && window.MUSIC.tracks) || []).find((x) => x.id === id) || (this._searchResults || []).find((x) => x.id === id) || (this._trending || []).find((x) => x.id === id); },
  _langCC() { const l = (navigator.languages && navigator.languages[0]) || navigator.language || ""; const m = l.match(/[-_]([A-Za-z]{2})$/); return m ? m[1].toLowerCase() : "us"; },
  _trendCC() { try { return localStorage.getItem("fm_cc") || this._langCC(); } catch (e) { return this._langCC(); } },
  _rssImg(x) { const a = x["im:image"]; if (!a || !a.length) return ""; return (a[a.length - 1].label || "").replace("170x170bb", "300x300bb"); },
  _reRenderPicker() { const m = document.getElementById("modal"); if (m && !m.classList.contains("hidden")) this.pickMusic(); },
  _loadTrending() {
    if (this._trendLoading) return;
    this._trendLoading = true; this._trending = null;
    const cc = this._trendCC();
    fetch("https://itunes.apple.com/" + cc + "/rss/topsongs/limit=25/json")
      .then((r) => r.json())
      .then((d) => {
        const e = (d.feed && d.feed.entry) || [];
        this._trending = e.map((x, i) => ({ id: "ch" + i, title: (x["im:name"] || {}).label || "", artist: (x["im:artist"] || {}).label || "", cover: this._rssImg(x), genre: ((x.category || {}).attributes || {}).label || "Trending", source: "chart", src: null })).filter((t) => t.title);
        this._trendLoading = false; this._reRenderPicker();
      })
      .catch(() => { this._trendLoading = false; this._trending = []; this._reRenderPicker(); });
    if (!this._ccChecked) {
      this._ccChecked = true;
      fetch("https://ipapi.co/json/").then((r) => r.json()).then((g) => {
        const c = ((g || {}).country_code || "").toLowerCase();
        if (c) { try { localStorage.setItem("fm_cc", c); } catch (e) {} if (c !== cc && (this._musicCat || "Trending") === "Trending") { this._trending = null; this._trendLoading = false; this._loadTrending(); } }
      }).catch(() => {});
    }
  },
  _resolvePreview(t) {
    if (t.src || t._tried) return Promise.resolve(t);
    t._tried = true;
    return fetch("https://itunes.apple.com/search?media=music&entity=song&limit=1&term=" + encodeURIComponent(t.title + " " + t.artist))
      .then((r) => r.json())
      .then((d) => { const r0 = ((d.results) || [])[0]; if (r0) { t.src = r0.previewUrl; if (!t.cover) t.cover = (r0.artworkUrl100 || "").replace("100x100bb", "200x200bb"); } return t; })
      .catch(() => t);
  },
  _coverEl(t, lg) {
    const cls = "music-cover" + (lg ? " lg" : "");
    if (t.cover) return `<img class="${cls}" src="${esc(t.cover)}" alt="" loading="lazy">`;
    return `<span class="${cls}" style="background:${this._musicCover(t)}">♪</span>`;
  },
  _musicRow(t, pm, playingId) {
    const on = pm && pm.id === t.id, p = playingId === t.id;
    const tt = (t.title + " " + (t.genre || "") + " " + t.artist).toLowerCase();
    return `<div class="music-row ${on ? "sel" : ""} ${p ? "playing" : ""}" data-tt="${esc(tt)}" data-cat="${esc(t.genre || "")}" data-trend="${t.trending ? "1" : "0"}" onclick="Social.selectMusic('${t.id}')">
        ${this._coverEl(t)}
        <div class="music-meta"><div class="music-t">${esc(t.title)}${(t.trending || t.source === "chart") ? ` <span class="music-fire">🔥</span>` : ""}</div><div class="music-a">${esc(t.genre || "Song")} · ${esc(t.artist)}</div></div>
        <button class="music-play ${p ? "on" : ""}" onclick="event.stopPropagation();Social.previewMusic('${t.id}')" aria-label="Preview">${p ? "⏸" : "▶"}</button>
        ${on ? `<span class="music-check">✓</span>` : ""}
      </div>`;
  },
  pickMusic() {
    const M = (window.MUSIC && window.MUSIC.tracks) || [];
    const card = document.getElementById("modal-card"); if (!card) return;
    const pm = this.pendingMusic;
    const q = (this._musicQuery || "").trim();
    const searching = q.length >= 2;
    const cat = this._musicCat || "Trending";
    const cats = ["Trending", "Workout", "Hype", "Chill", "Lo-fi", "Focus", "Cinematic"];
    const chips = searching ? "" : `<div class="music-chips">${cats.map((c) => `<button class="music-chip ${c === cat ? "on" : ""}" onclick="Social.setMusicCat('${c}')">${c === "Trending" ? "🔥 " : ""}${esc(c)}</button>`).join("")}</div>`;
    const playingId = this._preview && this._preview.id;
    let listInner;
    if (searching) {
      if (this._searching) listInner = `<div class="sub" style="text-align:center;padding:18px">Searching millions of songs…</div>`;
      else { const res = this._searchResults || []; listInner = res.length ? res.map((t) => this._musicRow(t, pm, playingId)).join("") : `<div class="sub" style="text-align:center;padding:18px">No songs found for “${esc(q)}”.</div>`; }
    } else if (cat === "Trending") {
      if (!this._trending && !this._trendLoading) this._loadTrending();
      if (this._trendLoading || !this._trending) listInner = `<div class="sub" style="text-align:center;padding:18px">Loading trending songs…</div>`;
      else if (this._trending.length) listInner = this._trending.map((t) => this._musicRow(t, pm, playingId)).join("");
      else listInner = M.map((t) => this._musicRow(t, pm, playingId)).join("");
    } else {
      const mood = M.filter((t) => t.genre === cat);
      listInner = mood.length ? mood.map((t) => this._musicRow(t, pm, playingId)).join("") : `<div class="sub" style="text-align:center;padding:14px">No tracks.</div>`;
    }
    const np = playingId ? this._trackById(playingId) : null;
    const nowBar = np ? `<div class="music-now">
        ${this._coverEl(np, true)}
        <div class="music-meta"><div class="music-t">${esc(np.title)}</div><div class="music-a">Now playing · ${esc(np.genre || "Song")} · ${esc(np.artist)}</div></div>
        <button class="music-play on" onclick="Social.previewMusic('${np.id}')" aria-label="Pause">⏸</button>
      </div><div class="music-prog"><span id="mp-fill"></span></div>` : "";
    card.innerHTML = `<div class="modal-head"><h2>Add music 🎵</h2><button class="icon-btn" onclick="Social._stopPreview();App.closeModal()">✕</button></div>
      <input id="music-search" class="music-search" type="search" placeholder="Search any song — Hindi, Spanish, English…" value="${esc(this._musicQuery || "")}" oninput="Social.filterMusic(this.value)" autocomplete="off">
      ${chips}
      ${nowBar}
      <div class="music-list" id="music-list">${listInner}</div>
      <div class="music-credit">${(searching || cat === "Trending") ? "Real charts · 30-sec previews · iTunes" : esc((window.MUSIC && window.MUSIC.credit) || "")}</div>
      <div class="music-actions">${pm ? `<button class="btn ghost wide" onclick="Social.removeMusic()">Remove</button>` : ""}<button class="btn wide" onclick="Social.musicDone()">${pm ? "Use this sound" : "Done"}</button></div>`;
    document.getElementById("modal").classList.remove("hidden");
    if (this._focusSearch) { const si = document.getElementById("music-search"); if (si) { si.focus(); try { si.setSelectionRange(si.value.length, si.value.length); } catch (e) {} } this._focusSearch = false; }
  },
  setMusicCat(c) { this._musicCat = c; this._musicQuery = ""; this._searchResults = null; this.pickMusic(); },
  filterMusic(q) {
    this._musicQuery = q;
    clearTimeout(this._searchTimer);
    if (q.trim().length >= 2) {
      this._searching = true;
      const list = document.getElementById("music-list"); if (list) list.innerHTML = `<div class="sub" style="text-align:center;padding:18px">Searching millions of songs…</div>`;
      const chipsEl = document.querySelector(".music-chips"); if (chipsEl) chipsEl.remove();
      this._searchTimer = setTimeout(() => this._searchSongs(q.trim()), 350);
    } else {
      this._searching = false; this._searchResults = null; this._focusSearch = true; this.pickMusic();
    }
  },
  _searchSongs(q) {
    if ((this._musicQuery || "").trim() !== q) return;
    fetch("https://itunes.apple.com/search?media=music&entity=song&limit=24&term=" + encodeURIComponent(q))
      .then((r) => r.json())
      .then((d) => {
        if ((this._musicQuery || "").trim() !== q) return;
        this._searchResults = (d.results || []).filter((r) => r.previewUrl).map((r) => ({ id: "it" + r.trackId, title: r.trackName, artist: r.artistName, src: r.previewUrl, cover: (r.artworkUrl100 || "").replace("100x100bb", "200x200bb"), genre: r.primaryGenreName || "Song", source: "itunes" }));
        this._searching = false; this._focusSearch = true; this.pickMusic();
      })
      .catch(() => { this._searching = false; this._searchResults = []; this._focusSearch = true; this.pickMusic(); });
  },
  selectMusic(id) {
    const t = this._trackById(id); if (!t) return;
    if (!t.src && t.source === "chart" && !t._tried) { this._resolvePreview(t).then(() => this.selectMusic(id)); return; }
    if (!t.src) { if (typeof App !== "undefined" && App.toast) App.toast("Couldn't load that preview — try another."); return; }
    this.pendingMusic = { id: t.id, title: t.title, artist: t.artist, src: t.src, cover: t.cover || "", source: t.source || "formora" };
    this.previewMusic(id, true);
  },
  previewMusic(id, force) {
    const t = this._trackById(id); if (!t) return;
    if (!t.src && t.source === "chart" && !t._tried) { this._resolvePreview(t).then(() => this.previewMusic(id, force)); return; }
    if (!t.src) return;
    if (this._preview && this._preview.id === id && !force) { this._stopPreview(); this.pickMusic(); return; }
    this._stopPreview();
    const a = new Audio(t.src); this._preview = { id, a };
    a.ontimeupdate = () => { const f = document.getElementById("mp-fill"); if (f && a.duration) f.style.width = (100 * a.currentTime / a.duration) + "%"; };
    a.onended = () => { this._stopPreview(); this.pickMusic(); };
    a.play().catch(() => {});
    this.pickMusic();
  },
  _stopPreview() { if (this._preview) { try { const a = this._preview.a; a.pause(); a.ontimeupdate = null; a.onended = null; } catch (e) {} this._preview = null; } },
  musicDone() { this._stopPreview(); if (typeof App !== "undefined" && App.closeModal) App.closeModal(); this.render(); },
  removeMusic() { this.pendingMusic = null; this._stopPreview(); if (typeof App !== "undefined" && App.closeModal) App.closeModal(); this.render(); },
  _ensureMusic() { if (!this._musicAudio) { const a = document.createElement("audio"); a.loop = true; a.preload = "none"; this._musicAudio = a; } return this._musicAudio; },
  playMusic(src) { if (!src) return this.stopMusic(); const a = this._ensureMusic(); if (this._musicSrc !== src) { a.src = src; this._musicSrc = src; } a.muted = !this._feedSound; a.play().catch(() => {}); },
  // subtle two-note chime for a new incoming message (WebAudio — no asset, respects fm_msgsound)
  playPing() {
    if (this.msgSoundOff()) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      const ctx = this._actx || (this._actx = new AC());
      if (ctx.state === "suspended") { try { Promise.resolve(ctx.resume()).catch(() => {}); } catch (_) {} }
      const now = ctx.currentTime;
      [880, 1174.7].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "sine"; o.frequency.value = f;
        const t0 = now + i * 0.09;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(0.13, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.2);
        o.connect(g); g.connect(ctx.destination);
        o.start(t0); o.stop(t0 + 0.22);
      });
    } catch (_) {}
  },
  stopMusic() { if (this._musicAudio) { try { this._musicAudio.pause(); } catch (e) {} } this._musicSrc = null; },
  _musicPill(p) { return (p && p.music) ? `<span class="post-music" title="${esc(p.music.artist || "")}">🎵 ${esc(p.music.title || "Music")}</span>` : ""; },
  _pmAttr(p) { return (p && p.music) ? `data-pmsrc="${esc(p.music.src)}"` : ""; },
  _photoMusicCtrl(p) { return (p && p.music) ? `<button class="fv-mute" onclick="event.stopPropagation();Social.toggleFeedMute(this)" aria-label="Sound">${App.ic(this._feedSound ? "volume" : "mute", { size: 18 })}</button>${this._musicPill(p)}` : ""; },
  // ---- haptics + share-to-grow (viral loop) ----
  haptic(ms) { try { if (navigator.vibrate) navigator.vibrate(ms || 12); } catch (e) {} },
  _share(text) {
    window.Track && Track.event("shared");
    const url = this._refUrl();
    const data = { title: "Formora", text: (text || "Train with me on Formora") + " \ud83d\udcaa", url };
    if (navigator.share) return navigator.share(data).then(() => this.haptic(12)).catch(() => {});
    const done = () => { if (typeof App !== "undefined" && App.toast) App.toast("Link copied \u2014 share it anywhere \ud83d\udd17"); };
    if (navigator.clipboard) return navigator.clipboard.writeText(url).then(done).catch(() => { if (typeof App !== "undefined" && App.toast) App.toast(url); });
    if (typeof App !== "undefined" && App.toast) App.toast(url);
  },
  sharePost(id) {
    const list = this.cloudActive() ? (this.cloud.feed || []) : (this.feed() || []);
    const post = list.find((p) => p.id === id);
    this._share(post && post.text ? post.text : "Check out this fitness progress on Formora");
  },
  shareApp() { this._share("I'm tracking workouts and progress with Formora, a fitness and social app"); },
  _myRef() { try { let r = localStorage.getItem("fm_myref"); if (!r) { r = Math.random().toString(36).slice(2, 8); localStorage.setItem("fm_myref", r); } return r; } catch (e) { return ""; } },
  _refUrl() { const r = this._myRef(); const base = "https://arindamchatterjee007.github.io/formora/"; return r ? base + "?ref=" + r : base; },
  inviteFriends() {
    const card = document.getElementById("modal-card"); if (!card) return;
    const url = this._refUrl();
    card.innerHTML = `<div class="modal-head"><h2>Invite friends \ud83c\udf81</h2><button class="icon-btn" onclick="App.closeModal()">\u2715</button></div>
      <div style="text-align:center;padding:6px 2px 2px">
        <div style="font-size:52px;line-height:1">\ud83d\udcaa</div>
        <div style="font-weight:800;font-size:19px;margin:8px 0 4px">Train together, stay consistent</div>
        <div class="sub" style="margin-bottom:14px">Friends who train together stick with it. Invite yours \u2014 they'll show up in your feed and you'll keep each other going.</div>
        <div style="display:flex;gap:8px;margin-bottom:10px"><input id="inv-link" readonly value="${esc(url)}" style="flex:1;min-width:0;padding:11px 12px;border-radius:12px;border:1px solid var(--line);background:#12151d;color:#fff;font-size:13px"><button class="btn" onclick="Social.copyInvite()">Copy</button></div>
        <button class="btn wide" onclick="Social.doInvite()">Share your invite link</button>
      </div>`;
    document.getElementById("modal").classList.remove("hidden");
  },
  copyInvite() { const el = document.getElementById("inv-link"); const url = el ? el.value : this._refUrl(); if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => { if (typeof App !== "undefined" && App.toast) App.toast("Invite link copied \ud83d\udd17"); }).catch(() => {}); window.Track && Track.event("invite_shared"); },
  doInvite() { window.Track && Track.event("invite_shared"); this._share("Come train with me on Formora \u2014 free AI workouts + a fitness feed to flex your progress"); },
  // ---- save / bookmark (local, personal) ----
  isSaved(id) { return this._list("fm_saved").includes(id); },
  _setSaved(id) {
    const list = this._list("fm_saved"), index = list.indexOf(id), saved = index < 0;
    if (index >= 0) list.splice(index, 1); else list.unshift(id);
    if (!this._setList("fm_saved", list)) { if (App.toast) App.toast("Could not update saved posts on this device. Try again."); return !saved; }
    this.haptic(12);
    if (typeof App !== "undefined" && App.toast) App.toast(saved ? "Saved \ud83d\udd16" : "Removed from saved");
    return saved;
  },
  toggleSave(id) {
    this._setSaved(id); this.render();
    const saved = this.isSaved(id);
    if (document.querySelectorAll) document.querySelectorAll("[data-saved-post]").forEach(button => {
      if (button.getAttribute("data-saved-post") !== id) return;
      button.setAttribute("aria-pressed", String(saved)); button.classList.toggle("on", saved);
      button.innerHTML = App.ic("bookmark", { size: 21, solid: saved });
    });
    return saved;
  },
  openSaved() {
    const ids = this._list("fm_saved");
    const list = this.cloudActive() ? (this.cloud.feed || []) : (this.feed() || []);
    const posts = ids.map((id) => list.find((p) => p.id === id)).filter(Boolean);
    const card = document.getElementById("modal-card"); if (!card) return;
    const body = posts.length
      ? posts.map((p) => this.postCard(this.cloudActive() ? this._cloudPost(p) : p)).join("")
      : `<div class="sub" style="text-align:center;padding:24px 6px">No saved posts yet. Tap the \ud83d\udd16 on any post to save it here.</div>`;
    card.innerHTML = `<div class="modal-head"><h2>Saved</h2><button class="icon-btn" onclick="App.closeModal()">\u2715</button></div><div class="saved-list">${body}</div>`;
    document.getElementById("modal").classList.remove("hidden");
  },

  avatar(entity, size = 40) {
    const e = typeof entity === "string" ? this.persona(entity) : entity;
    if (e.avatar) return `<img class="av" style="width:${size}px;height:${size}px" src="${esc(e.avatar)}" alt="${esc(e.name)}">`;
    const ini = (e.name || "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
    const [c1, c2] = e.colors || ["#ff6b3d", "#ff3d7f"];
    return `<div class="av" style="width:${size}px;height:${size}px;background:linear-gradient(135deg,${c1},${c2});font-size:${Math.round(size * 0.4)}px">${esc(ini)}</div>`;
  },
  timeAgo(ts) {
    const t = typeof ts === "number" ? ts : Date.parse(ts);
    if (!isFinite(t)) return "now";
    const s = Math.floor((Date.now() - t) / 1000);
    if (s < 1) return "now";
    if (s < 60) return s + "s"; const m = Math.floor(s / 60);
    if (m < 60) return m + "m"; const h = Math.floor(m / 60);
    if (h < 24) return h + "h"; return Math.floor(h / 24) + "d";
  },

  // ---- feed UI ----
  feedBody() {
    const meU = this.me();
    const gate = (typeof Mailer !== "undefined" && Mailer.canSendCodes && Mailer.canSendCodes() && !meU.verified);
    const composer = gate ? `
      <div class="card composer verify-gate">
        <div class="vg-ic">✉️</div>
        <div class="vg-title">Verify your email to post</div>
        <div class="vg-sub">Confirm <b>${esc((Store.state.profile && Store.state.profile.email) || "your email")}</b> so the community knows you're real.</div>
        <button class="btn wide" onclick="App.verifyMyEmail()">Send me a code</button>
      </div>` : `
      <div class="card composer">
        <div class="composer-top">${this.avatar(meU, 42)}
          <textarea id="post-text" class="food-text" rows="2" placeholder="Share a win, flex your progress, or drop some motivation…" oninput="Social._postText=this.value">${esc(this._postText || "")}</textarea>
        </div>
        ${(this.pendingPhotos && this.pendingPhotos.length) ? `<div class="composer-photos">${this.pendingPhotos.map((src, i) => `<div class="cp-thumb"><img src="${esc(src)}" alt="preview" draggable="false"><button class="cp-x" onclick="Social.removePending(${i})">✕</button></div>`).join("")}</div>` : ""}
        ${this.pendingVideo ? `<div class="composer-video"><video src="${esc(this.pendingVideo)}" controls playsinline></video><button class="cp-x" onclick="Social.removeVideo()">✕</button></div>` : (this.pendingVideoUploading ? `<div class="sub upl">⏳ Uploading video…</div>` : "")}
        ${this.pendingMusic ? `<div class="composer-music">🎵 <b>${esc(this.pendingMusic.title)}</b> · ${esc(this.pendingMusic.artist)}<button class="cp-x" onclick="Social.removeMusic()">✕</button></div>` : ""}
        <div class="composer-actions">
          <button class="photo-btn" onclick="Social.pickPhotos()">${App.ic("camera", { size: 16 })} Photo</button>
          <button class="photo-btn" onclick="Social.pickReel()">${App.ic("film", { size: 16 })} Flex</button>
          <button class="photo-btn ${this.pendingMusic ? "on" : ""}" onclick="Social.pickMusic()">${App.ic("music", { size: 16 })} Music</button>
          <button id="post-publish" class="btn" onclick="Social.publishPost()" ${this._actionPending("create-post", "composer") || this.pendingVideoUploading ? 'disabled aria-busy="true"' : ""}>${this._actionPending("create-post", "composer") ? "Posting..." : this._postRequest ? "Retry post" : "Post"}</button>
        </div>
      </div>`;
    if (this.cloudActive()) {
      const visible = this._rankFeed(this.cloud.feed.filter((p) => this._canSeePost(p)));
      const posts = visible.map((p) => this.postCard(this._cloudPost(p))).join("");
      // posts already loaded stay on screen through a transient failure; only a cold
      // empty feed reports the read outcome instead of claiming an empty account
      return this.storiesRow() + composer + (visible.length ? posts : this.feedStatusCard());
    }
    return composer + this.suggestStrip() + this.feed().filter((p) => this._canSeePost(p)).map((p) => this.postCard(p)).join("");
  },
  _cloudPost(p) {
    const likes = p.likes || {};
    const meId = (typeof Cloud !== "undefined") ? Cloud.me : null;
    const reshares = (this.cloud.feed || []).filter((x) => x && x.reshareOf === p.id).length;
    const resharedByMe = (this.cloud.feed || []).some((x) => x && x.reshareOf === p.id && x.author === meId);
    return { id: p.id, author: p.author, text: p.text || "", photo: p.photo || null, photos: p.photos || null, video: p.video || null, resharedFrom: p.resharedFrom || null, gradient: p.gradient || ["#ff6b3d", "#ff3d7f"], tag: p.tag || "Flex", likes: Object.keys(likes).length, likedByMe: !!(meId && likes[meId]), likers: Object.keys(likes), comments: p.comments || [], reshares, resharedByMe, music: p.music || null, ts: p.ts || Date.now() };
  },
  _likerName(id) { const u = (typeof Cloud !== "undefined" && id === Cloud.me) ? this.me() : (this.cloudUser(id) || null); return u ? (u.name || ("@" + u.handle)) : ("@" + id); },
  _likerNames(uids) {
    const names = uids.slice(0, 2).map((id) => this._likerName(id));
    let s = names.join(", ");
    if (uids.length > 2) s += ` and ${uids.length - 2} other${uids.length - 2 > 1 ? "s" : ""}`;
    return esc(s);
  },
  showLikers(postId) {
    const post = this.cloud.feed.find((p) => p.id === postId);
    if (!post) return;
    const uids = Object.keys(post.likes || {});
    const rows = uids.map((id) => {
      const u = (typeof Cloud !== "undefined" && id === Cloud.me) ? this.me() : (this.cloudUser(id) || { id, name: id, handle: id, avatar: null, colors: ["#8b93a7", "#262c3a"] });
      return `<div class="crew-card"><div class="crew-click" onclick="App.closeModal();Social.viewProfile('${id}')">${this.avatar(u, 44)}<div class="crew-info"><div class="crew-name">${esc(u.name)}</div><div class="crew-sub">@${esc(u.handle)}</div></div></div></div>`;
    }).join("");
    const card = document.getElementById("modal-card");
    card.innerHTML = `<div class="modal-head"><h2>Liked by ${uids.length}</h2><button class="icon-btn" onclick="App.closeModal()">✕</button></div><div class="crew-list">${rows || `<div class="sub">No likes yet.</div>`}</div>`;
    document.getElementById("modal").classList.remove("hidden");
  },
  suggestStrip() {
    const s = this.suggestions().slice(0, 8);
    if (!s.length) return "";
    return `<div class="card suggest">
      <div class="card-head"><h2>Suggested crew</h2><button class="ssub" onclick="Social.feedTab('crew')">See all</button></div>
      <div class="suggest-row">
        ${s.map((p) => `<div class="sg-card">
          ${this.avatar(p, 56)}
          <div class="sg-name">${esc(p.name.split(" ")[0])}</div>
          <div class="sg-sub">${esc(p.physique)}</div>
          <div class="sg-cta">
            <button class="btn sm" onclick="Social.requestConnect('${p.id}')">Connect</button>
            <button class="chip-btn ${this.isFollowing(p.id) ? "on" : ""}" title="Follow" onclick="Social.toggleFollow('${p.id}')">${this.isFollowing(p.id) ? "\u2713" : "+"}</button>
          </div>
        </div>`).join("")}
      </div>
    </div>`;
  },
  postCard(p) {
    const a = this.persona(p.author);
    const saved = this.isSaved(p.id);
    const pics = (p.photos && p.photos.length) ? p.photos : (p.photo ? [p.photo] : []);
    const media = p.video
      ? `<div class="post-media video" data-fv="${p.id}"><video src="${esc(p.video)}" data-msrc="${esc(p.music ? p.music.src : "")}" playsinline preload="metadata" loop ${this._feedSound ? "" : "muted"} onclick="Social.mediaTap('${p.id}',event,'video')"></video><button class="fv-mute" onclick="event.stopPropagation();Social.toggleFeedMute(this)" aria-label="Sound">${App.ic(this._feedSound ? "volume" : "mute", { size: 18 })}</button><span class="reel-badge">Flex</span>${this._musicPill(p)}</div>`
      : pics.length
      ? (pics.length > 1
        ? `<div class="post-media carousel" ${this._pmAttr(p)} onclick="Social.mediaTap('${p.id}',event,'photo')">${pics.map((src) => `<div class="cslide"><img src="${esc(src)}" alt="post" draggable="false"></div>`).join("")}<div class="cdots">${pics.map(() => `<span class="cdot"></span>`).join("")}</div>${this._photoMusicCtrl(p)}</div>`
        : `<div class="post-media" ${this._pmAttr(p)} onclick="Social.mediaTap('${p.id}',event,'photo')"><img src="${esc(pics[0])}" alt="post" draggable="false">${this._photoMusicCtrl(p)}</div>`)
      : `<div class="post-media grad" ${this._pmAttr(p)} onclick="Social.mediaTap('${p.id}',event,'photo')" style="background:linear-gradient(135deg,${esc((p.gradient || ["#ff6b3d", "#ff3d7f"]).join(","))})"><span>${esc(p.tag || "Flex")} 💪</span>${this._photoMusicCtrl(p)}</div>`;
    const comments = (p.comments || []).map((c) => `<div class="cmt"><b>${esc(this.persona(c.by).name)}</b> ${esc(c.text)}</div>`).join("");
    const reshared = p.resharedFrom ? `<div class="reshare-note">🔁 reshared from ${esc(this.persona(p.resharedFrom).name)}</div>` : "";
    return `
      <div class="card post">
        <div class="post-head">
          <div class="post-author" role="button" tabindex="0" aria-label="${esc('View ' + a.name + ' profile')}" onclick="Social.viewProfile('${p.author}')" onkeydown="if(event.target===this&&(event.key==='Enter'||event.key===' ')){event.preventDefault();this.click()}">
            ${this.avatar(a, 44)}
            <div class="post-who"><div class="pw-name">${esc(a.name)}${this.vbadge(a)} ${a.level ? `<span class="lvl">${esc(a.level)}</span>` : ""}</div>
              <div class="pw-sub">@${esc(a.handle)} · ${this.timeAgo(p.ts)}</div></div>
          </div>
          <button class="icon-btn post-more" title="More options" aria-label="More options" onclick="Social.postMenu('${p.id}')">${App.ic("more", { size: 20 })}</button>
        </div>
        ${reshared}
        ${p.text ? `<div class="post-text">${esc(p.text)}</div>` : ""}
        ${media}
        ${p.music ? `<div class="music-pill">🎵 <b>${esc(p.music.title)}</b> · ${esc(p.music.artist)}</div>` : ""}
        <div class="post-actions">
          <button class="pa ${p.likedByMe ? "on" : ""}" onclick="Social.likePost('${p.id}')">${App.ic("heart", { size: 22, solid: p.likedByMe })} <span>${p.likes}</span></button>
          <button class="pa" onclick="Social.toggleComments('${p.id}')">${App.ic("comment", { size: 22 })} <span>${this.cloudActive() ? this.commentCount(p.id) : (p.comments || []).length}</span></button>
          <button class="pa ${p.resharedByMe ? "on" : ""}" title="${p.resharedByMe ? "Undo reshare" : "Reshare"}" onclick="Social.resharePost('${p.id}')">${App.ic("reshare", { size: 22 })} <span>${p.reshares || 0}</span></button>
          <button class="pa share" title="Share" onclick="Social.sharePost('${p.id}')">${App.ic("share", { size: 21 })}</button>
          <button class="pa save ${saved ? "on" : ""}" title="Save" aria-label="Save post" aria-pressed="${saved}" data-saved-post="${esc(p.id)}" onclick="Social.toggleSave('${p.id}')">${App.ic("bookmark", { size: 21, solid: saved })}</button>
        </div>
        ${p.likers && p.likers.length ? `<div class="post-likers" onclick="Social.showLikers('${p.id}')">❤️ Liked by ${this._likerNames(p.likers)}</div>` : ""}
        <div class="post-comments" id="cmts-${p.id}" style="display:${this._openCmt === p.id ? "block" : "none"}">
          ${this.cloudActive() ? this.renderCommentThread(p.id) : comments}
          <div class="cmt-add">
            <input id="ci-${p.id}" placeholder="Add a comment… @ to mention" onkeydown="if(event.key==='Enter')Social.submitComment('${p.id}')">
            ${App.sendIcon(`Social.submitComment('${p.id}')`)}
          </div>
        </div>
      </div>`;
  },
  postPhoto(e) {
    const files = Array.from((e.target && e.target.files) || []); if (!files.length) return;
    if (!this.pendingPhotos) this.pendingPhotos = [];
    const slots = Math.max(0, 6 - this.pendingPhotos.length);
    const scope = this._actionScope();
    return Promise.all(files.slice(0, slots).map((f) => resizeImage(f, 1080, 0.8))).then((datas) => {
      if (this._actionScope() !== scope) return;
      this.pendingPhotos.push(...datas.slice(0, Math.max(0, 6 - this.pendingPhotos.length))); this.render();
    }).catch(() => { if (this._actionScope() === scope) alert("Couldn't read one of those images."); });
  },
  removePending(i) { if (this.pendingPhotos) { this.pendingPhotos.splice(i, 1); this.render(); } },
  async postVideo(e) {
    const f = e.target && e.target.files && e.target.files[0]; if (!f) return;
    if (!this.cloudActive()) { alert("Flex videos need you to be signed in and online."); return; }
    if (f.size > 150 * 1024 * 1024) { alert("That clip is too large (max 150MB). Tip: record with the 🎨 Formora Camera — it auto-optimises clips to a small size."); return; }
    const scope = this._actionScope(), upload = this._videoUpload = {};
    this.pendingVideoUploading = true; this.render();
    let url;
    try { url = await Cloud.uploadMedia(f, "videos"); } catch (_) { url = null; }
    if (this._actionScope() !== scope || this._videoUpload !== upload) return;
    this.pendingVideoUploading = false;
    if (!url) { alert("Couldn't upload that video — check your connection and try again."); this.render(); return; }
    this.pendingVideo = url; this.render();
  },
  removeVideo() { this._videoUpload = null; this.pendingVideoUploading = false; this.pendingVideo = null; this.render(); },

  // ---- stories (Instagram-style, 24h) ----
  storyGroups() {
    if (window.STORY_INTERACTIONS) return typeof Stories !== "undefined" ? Stories.groups() : [];
    const byAuthor = {};
    (this.cloud.stories || []).forEach((s) => { (byAuthor[s.author] = byAuthor[s.author] || []).push(s); });
    const meId = (typeof Cloud !== "undefined") ? Cloud.me : null;
    return Object.keys(byAuthor)
      .filter((a) => !this._isBanned(a))
      .map((a) => ({ author: a, items: byAuthor[a].slice().sort((x, y) => (x.ts || 0) - (y.ts || 0)) }))
      .sort((g1, g2) => (g1.author === meId ? -1 : g2.author === meId ? 1 : (g2.items[g2.items.length - 1].ts || 0) - (g1.items[g1.items.length - 1].ts || 0)));
  },
  storiesRow() {
    const meId = (typeof Cloud !== "undefined") ? Cloud.me : null;
    const groups = this.storyGroups();
    const mine = groups.find((g) => g.author === meId);
    const others = groups.filter((g) => g.author !== meId);
    const ring = (g) => {
      const u = (g.author === meId) ? this.me() : (this.cloudUser(g.author) || { name: "?", handle: "?", colors: ["#8b93a7", "#262c3a"], avatar: null });
      const seen = window.STORY_INTERACTIONS && g.items.every(item => item.seen);
      return `<button class="story-ring has" aria-label="${esc(u.name || u.handle || 'Member')}: ${seen ? 'seen story' : 'new story'}" onclick="Social.openStory('${g.author}')"><span class="sr-halo"${seen ? ' style="filter:grayscale(1)"' : ''}>${this.avatar(u, 60)}</span><span class="sr-name">${esc((u.name || u.handle || "?").split(" ")[0])}</span></button>`;
    };
    const yours = `<button class="story-ring${mine ? " has" : ""}" onclick="${mine ? `Social.openStory('${meId}')` : "Social.addStoryPick()"}"><span class="sr-halo">${this.avatar(this.me(), 60)}<span class="sr-plus" onclick="event.stopPropagation();Social.addStoryPick()">＋</span></span><span class="sr-name">Your story</span></button>`;
    const uploading = this.pendingStoryUploading ? `<div class="story-ring"><span class="sr-halo up">⏳</span><span class="sr-name">Posting…</span></div>` : "";
    const controls = window.STORY_INTERACTIONS ? `<div style="display:flex;gap:8px;align-items:center">${typeof Stories === "undefined" || Stories.error ? `<button class="btn ghost" onclick="App.refreshStories()">${App.ic("undo", { size: 16 })} Retry Stories</button>` : ""}${typeof Stories !== "undefined" && Stories.nextCursor ? `<button class="btn ghost" onclick="Social.moreStories()">${App.ic("chevronR", { size: 16 })} Older Stories</button>` : ""}<button class="icon-btn" aria-label="Story preferences" title="Story preferences" onclick="App.openStorySettings()">${App.ic("cog", { size: 18 })}</button></div>` : "";
    return `<div class="stories-row">${yours}${uploading}${others.map(ring).join("")}</div>${controls}`;
  },
  async moreStories() {
    if (!window.STORY_INTERACTIONS || typeof Stories === "undefined" || !Stories.nextCursor) return;
    try { await Stories.refresh(Stories.nextCursor); } catch (error) { App.toast(error.message || "Stories unavailable."); }
  },
  addStoryPick() {
    const opts = [];
    if (typeof CameraLoader !== "undefined" && CameraLoader.supported()) opts.push({ label: "🎨 Formora Camera + filters", action: () => CameraLoader.open("story") });
    else opts.push({ label: "📷 Take a photo", accept: "image/*", capture: true, cb: (e) => this.onStoryFile(e) }, { label: "🎥 Record a video", accept: "video/*", capture: true, cb: (e) => this.onStoryFile(e) });
    opts.push({ label: "🖼️ Choose from gallery", accept: "image/*,video/*", cb: (e) => this.onStoryFile(e) });
    this.mediaSheet("Add to your story", opts);
  },
  // generic camera/gallery chooser sheet (reused by stories, photos & reels)
  mediaSheet(title, opts) {
    this._sheet = opts;
    const card = document.getElementById("modal-card");
    if (!card) return;
    card.innerHTML = `<div class="sheet"><div class="sheet-h">${esc(title)}</div>${opts.map((o, i) => `<button class="sheet-btn" onclick="Social._sheetPick(${i})">${o.label}</button>`).join("")}<button class="sheet-btn cancel" onclick="App.closeModal()">Cancel</button></div>`;
    document.getElementById("modal").classList.remove("hidden");
  },
  _sheetPick(i) {
    if (typeof App !== "undefined" && App.closeModal) App.closeModal();
    const o = (this._sheet || [])[i]; if (!o) return;
    if (o.action) { o.action(); return; }
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = o.accept;
    if (o.capture) inp.setAttribute("capture", "environment");
    if (o.multiple) inp.multiple = true;
    inp.hidden = true;
    inp.addEventListener("change", (e) => o.cb(e));
    document.body.appendChild(inp);
    inp.click();
  },
  // hand-off targets used by the Formora Camera
  attachPhoto(file) {
    const scope = this._actionScope();
    return resizeImage(file, 1080, 0.82).then((dataUrl) => {
      if (this._actionScope() !== scope) return;
      if (!this.pendingPhotos) this.pendingPhotos = [];
      if (this.pendingPhotos.length < 6) this.pendingPhotos.push(dataUrl);
      if (typeof App !== "undefined" && App.selectTab) App.selectTab("home");
      this.sub = "feed"; this.render();
    }).catch(() => { if (this._actionScope() === scope) alert("Couldn't process that photo."); });
  },
  attachReel(file, url) {
    if (typeof App !== "undefined" && App.selectTab) App.selectTab("home");
    this.sub = "feed";
    return this.postVideo({ target: { files: [file] } });
  },
  // story: preview the picked media full-screen before sharing (Instagram/Snapchat-style)
  onStoryFile(e) {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    if (!this.cloudActive()) { alert("Stories need you to be signed in and online."); return; }
    const owner = Cloud._publishingUid();
    if (!owner || !/^(image\/(jpeg|png|webp)|video\/(mp4|webm))$/.test(f.type)) { App.toast("Choose a supported photo or video while signed in."); return; }
    const isVid = /^video\//.test(f.type);
    if (window.STORY_MEDIA_VALIDATION === true && (window.STORY_INTERACTIONS !== true || f.size > (isVid ? 26214400 : 8388608))) {
      App.toast("Validated Stories require a photo up to 8 MiB or a video up to 25 MiB."); return;
    }
    if (isVid && f.size > 150 * 1024 * 1024) { alert("That clip is too large (max 150MB). Tip: record with the 🎨 Formora Camera — it auto-optimises clips to a small size."); return; }
    if (this._storyDraft && this._storyDraft.url) URL.revokeObjectURL(this._storyDraft.url);
    this._storyDraft = { file: f, isVid, url: URL.createObjectURL(f), owner, scope: this._actionScope(), id: Cloud._newActionId(), v2: window.STORY_INTERACTIONS === true };
    this.storyPreview();
  },
  storyPreview() {
    const d = this._storyDraft; if (!d) return;
    let ov = document.getElementById("story-preview");
    if (!ov) { ov = document.createElement("div"); ov.id = "story-preview"; document.body.appendChild(ov); }
    ov.className = "story-viewer preview";
    const media = d.isVid ? `<video src="${esc(d.url)}" class="sv-media" autoplay loop muted playsinline></video>` : `<img src="${esc(d.url)}" class="sv-media" alt="preview" draggable="false">`;
    ov.innerHTML = `<div class="sv-card">
      <div class="sv-head"><button class="sv-x" onclick="Social.cancelStory()">✕</button><div class="sv-name" style="margin-left:4px">New story</div><button class="sp-redo" onclick="Social.cancelStory();Social.addStoryPick()">↻ Retake</button></div>
      ${media}
      <div class="sp-bar"><button class="sp-share" onclick="Social.shareStory()">${d.isVid ? "Share Flex to your story" : "Share to your story"} →</button></div>
    </div>`;
  },
  cancelStory() { const d = this._storyDraft; if (d && d.url) URL.revokeObjectURL(d.url); this._storyDraft = null; this.pendingStoryUploading = false; const ov = typeof document !== "undefined" && document.getElementById("story-preview"); if (ov) ov.remove(); },
  async shareStory() {
    const d = this._storyDraft; if (!d || d.sending || !this.cloudActive() || !d.id) return false;
    d.v2 ??= window.STORY_INTERACTIONS === true;
    d.validation ??= window.STORY_MEDIA_VALIDATION === true;
    const current = () => this._storyDraft === d && this._actionScope() === d.scope && Cloud._publishingUid() === d.owner
      && d.v2 === (window.STORY_INTERACTIONS === true) && d.validation === (window.STORY_MEDIA_VALIDATION === true);
    if (!current()) return false;
    const ov = document.getElementById("story-preview");
    const btn = ov && ov.querySelector(".sp-share"); if (btn) { btn.textContent = "Uploading…"; btn.disabled = true; }
    d.sending = true; this.pendingStoryUploading = true;
    try {
      if (d.validation && !d.v2) throw new Error("Validated Stories unavailable");
      if (!d.uploadedURL) {
        let file = d.file;
        if (!d.isVid) {
          const dataUrl = await resizeImage(file, 1280, 0.82);
          if (!current()) return false;
          if (!dataUrl.startsWith("data:image/jpeg;base64,")) throw new Error("invalid_image");
          const bytes = Uint8Array.from(atob(dataUrl.slice("data:image/jpeg;base64,".length)), character => character.charCodeAt(0));
          file = new File([bytes], "story.jpg", { type: "image/jpeg" });
        }
        const uploaded = await Cloud.uploadMedia(file, "stories", d.validation ? { requestId: d.id, current } : undefined);
        if (!current()) return false;
        const url = d.validation ? uploaded?.media_url : uploaded;
        if (typeof url !== "string" || !/^https:\/\//.test(url)) throw new Error("upload_unconfirmed");
        if (d.validation) d.mediaReceipt = uploaded;
        d.uploadedURL = url;
      }
      if (!current()) return false;
      let story;
      if (d.v2) {
        if (typeof Stories === "undefined") throw new Error("Stories unavailable");
        const result = await Stories.publish(d.uploadedURL, d.isVid ? "video" : "photo", d.id, d.mediaReceipt);
        if (!current()) return false;
        if (result?.receipt?.committed !== true || result.receipt.request_id !== d.id || result.receipt.author !== d.owner) throw new Error("story_unconfirmed");
        story = result.row;
        if (story && (story.id !== result.receipt.id || story.author !== d.owner || story.photo !== d.uploadedURL)) throw new Error("story_unconfirmed");
      } else story = await Cloud.addStory(d.uploadedURL, d.isVid ? "video" : "photo", d.id);
      if (!current()) return false;
      if (!d.v2 && (!story || story.id !== d.id || story.author !== d.owner || story.photo !== d.uploadedURL)) throw new Error("story_unconfirmed");
      if (!d.v2 && !this.cloud.stories.some(item => item.id === story.id)) this.cloud.stories.push(story);
      this.cancelStory();
      App.toast(story ? "Story shared. Available for up to 24 hours." : "The earlier Story was received, but is no longer available."); this.render(); return true;
    } catch (error) {
      if (current()) {
        App.toast(error.message && error.status ? error.message : "Story not confirmed. Your draft is kept; retry sharing.");
        if (d.v2 && error.status === 409 && ov && !ov.querySelector(".story-reconcile")) {
          const recover = document.createElement("button"); recover.className = "btn ghost story-reconcile"; recover.textContent = "Check previous Story";
          recover.onclick = () => this.reconcileStory(); ov.querySelector(".sp-bar")?.append(recover);
        }
      }
      return false;
    } finally {
      d.sending = false;
      if (current()) {
        this.pendingStoryUploading = false;
        if (btn && document.getElementById("story-preview") === ov) { btn.textContent = "Retry sharing"; btn.disabled = false; }
      }
    }
  },
  async reconcileStory() {
    const draft = this._storyDraft;
    if (!draft?.v2 || draft.sending || typeof Stories === "undefined" || draft.owner !== Stories.owner()) return;
    draft.sending = true;
    try {
      const receipt = await Stories.reconcile(draft.isVid ? "publish_video" : "publish_photo", draft.owner);
      if (this._storyDraft !== draft || draft.owner !== Stories.owner()) return;
      draft.id = Cloud._newActionId();
      if (draft.validation) { delete draft.uploadedURL; delete draft.mediaReceipt; }
      App.toast(receipt ? "Previous Story received. Your new draft is kept; share it when ready." : "No previous Story receipt found. Your draft is kept.");
    } catch (error) { if (this._storyDraft === draft) App.toast(error.message || "Could not check the previous Story."); }
    finally { draft.sending = false; }
  },
  // composer: camera/gallery choosers for photos & reels
  pickPhotos() {
    const opts = [];
    if (typeof CameraLoader !== "undefined" && CameraLoader.supported()) opts.push({ label: "🎨 Formora Camera + filters", action: () => CameraLoader.open("post") });
    else opts.push({ label: "📷 Take a photo", accept: "image/*", capture: true, cb: (e) => this.postPhoto(e) });
    opts.push({ label: "🖼️ Choose from gallery", accept: "image/*", multiple: true, cb: (e) => this.postPhoto(e) });
    this.mediaSheet("Add a photo", opts);
  },
  pickReel() {
    const opts = [];
    if (typeof CameraLoader !== "undefined" && CameraLoader.supported()) opts.push({ label: "🎨 Formora Camera + filters", action: () => CameraLoader.open("post") });
    else opts.push({ label: "🎥 Record a video", accept: "video/*", capture: true, cb: (e) => this.postVideo(e) });
    opts.push({ label: "🖼️ Choose from gallery", accept: "video/*", cb: (e) => this.postVideo(e) });
    this.mediaSheet("Add a Flex", opts);
  },
  openStory(authorUid) {
    if (window.STORY_INTERACTIONS) {
      if (typeof Stories === "undefined") return App.toast("Stories unavailable.");
      return Stories.open(authorUid).catch(error => App.toast(error.message || "Stories unavailable."));
    }
    const groups = this.storyGroups();
    const gi = groups.findIndex((g) => g.author === authorUid);
    if (gi < 0) return;
    this._storyGroups = groups; this._storyGi = gi; this._storyIi = 0;
    this.renderStory();
  },
  renderStory() {
    const g = this._storyGroups && this._storyGroups[this._storyGi];
    if (!g) return this.closeStory();
    const item = g.items[this._storyIi];
    if (!item) return this.storyNext();
    const meId = (typeof Cloud !== "undefined") ? Cloud.me : null;
    const u = (g.author === meId) ? this.me() : (this.cloudUser(g.author) || { name: "?", handle: "?", colors: ["#8b93a7", "#262c3a"], avatar: null });
    const dur = item.kind === "video" ? 15 : 5;
    const bars = g.items.map((it, i) => `<span class="sv-bar"><b class="${i < this._storyIi ? "done" : i === this._storyIi ? "run" : ""}"></b></span>`).join("");
    const media = item.kind === "video"
      ? `<video src="${esc(item.photo)}" class="sv-media" playsinline autoplay ${this._feedSound ? "" : "muted"} onended="Social.storyNext()"></video>`
      : `<img src="${esc(item.photo)}" class="sv-media" alt="story" draggable="false">`;
    const mineDel = (g.author === meId) ? `<button class="sv-del" onclick="Social.deleteStory('${item.id}')" title="Delete">🗑️</button>` : "";
    let ov = document.getElementById("story-viewer");
    if (!ov) { ov = document.createElement("div"); ov.id = "story-viewer"; document.body.appendChild(ov); }
    ov.className = "story-viewer";
    ov.innerHTML = `<div class="sv-card">
      <div class="sv-bars">${bars}</div>
      <div class="sv-head" onclick="App.closeModal();Social.viewProfile('${g.author}')">${this.avatar(u, 34)}<div class="sv-name">${esc(u.name)}</div><div class="sv-time">${this.timeAgo(item.ts)}</div>${mineDel}<button class="sv-x" onclick="event.stopPropagation();Social.closeStory()">✕</button></div>
      ${media}
      <button class="sv-tap prev" onclick="Social.storyPrev()" aria-label="Previous"></button>
      <button class="sv-tap next" onclick="Social.storyNext()" aria-label="Next"></button>
    </div>`;
    clearTimeout(this._storyTimer);
    if (item.kind !== "video") this._storyTimer = setTimeout(() => this.storyNext(), dur * 1000);
    requestAnimationFrame(() => { const run = ov.querySelector(".sv-bar b.run"); if (run) { run.style.transition = `width ${dur}s linear`; run.style.width = "100%"; } });
  },
  storyNext() {
    clearTimeout(this._storyTimer);
    const g = this._storyGroups && this._storyGroups[this._storyGi];
    if (g && this._storyIi < g.items.length - 1) { this._storyIi++; return this.renderStory(); }
    if (this._storyGroups && this._storyGi < this._storyGroups.length - 1) { this._storyGi++; this._storyIi = 0; return this.renderStory(); }
    this.closeStory();
  },
  storyPrev() {
    clearTimeout(this._storyTimer);
    if (this._storyIi > 0) { this._storyIi--; return this.renderStory(); }
    if (this._storyGi > 0) { this._storyGi--; this._storyIi = 0; return this.renderStory(); }
    this.renderStory();
  },
  closeStory() { if (typeof Stories !== "undefined" && window.STORY_INTERACTIONS) Stories.close(); clearTimeout(this._storyTimer); this._storyGroups = null; const ov = typeof document !== "undefined" && document.getElementById("story-viewer"); if (ov) ov.remove(); },
  async deleteStory(id) {
    if (window.STORY_INTERACTIONS) {
      if (typeof Stories === "undefined" || !Stories.storyFeed.some(item => item.id === id && item.mine) || !confirm("Delete this story?")) return false;
      try { const receipt = await Stories.remove(id); if (receipt?.committed === true) { App.toast("Story removed"); return true; } } catch (error) { App.toast(error.message || "Story removal was not confirmed."); }
      return false;
    }
    const story = (this.cloud.stories || []).find(item => item.id === id);
    if (!story || story.author !== Cloud._publishingUid() || this._actionPending("delete-story", id)) return false;
    if (!confirm("Delete this story?")) return false;
    return this._ackAction("delete-story", id, () => Cloud.deleteStory(id), () => {
      this.cloud.stories = (this.cloud.stories || []).filter(item => item.id !== id);
      this.closeStory(); App.toast("Story removed"); this.render();
    }, "Story removal was not confirmed. Retry when signed in and online.");
  },

  async publishPost() {
    if (!this.state || this._actionPending("create-post", "composer") || this.pendingVideoUploading) return false;
    if (typeof Mailer !== "undefined" && Mailer.canSendCodes && Mailer.canSendCodes() && !this.me().verified) {
      if (typeof App !== "undefined" && App.verifyMyEmail) App.verifyMyEmail();
      return false;
    }
    const t = document.getElementById("post-text");
    if (!t) return false;
    this._postText = t.value;
    const text = t.value.trim();
    const photos = this.pendingPhotos || [];
    const video = this.pendingVideo || null;
    if (!text && !photos.length && !video && !this._postRequest) { alert("Write something, add a photo or a Flex to post."); return false; }
    if (this.cloudActive()) {
      const owner = Cloud._publishingUid(), scope = this._actionScope();
      if (!owner) { if (App.toast) App.toast("Could not post. Your draft is kept. Sign in and try again."); return false; }
      if (!this._postRequest || this._postRequest.scope !== scope) this._postRequest = {
        scope, id: Cloud._newActionId(), text: t.value,
        data: JSON.parse(JSON.stringify(this._postData({ text, photo: photos[0] || null, photos: photos.length ? photos : null, video, gradient: this.me().colors, music: this.pendingMusic }))),
      };
      const request = this._postRequest;
      const button = document.getElementById("post-publish");
      if (button) { button.disabled = true; button.textContent = "Posting..."; }
      let receipt;
      try {
        return await this._ackAction("create-post", "composer", async () => {
          if (!request.id || !Cloud.addPost) return false;
          receipt = await Cloud.addPost({ ...request.data, id: request.id, author: owner });
          return !!(receipt && receipt.id === request.id && receipt.author === owner && Cloud._samePayload(this._postData(receipt), request.data));
        }, () => {
          if (!this.cloud.feed.some(post => post.id === receipt.id)) this.cloud.feed.unshift(receipt);
          this._postRequest = null;
          const input = document.getElementById("post-text");
          const currentText = input ? input.value : this._postText;
          const currentPhotos = this.pendingPhotos || [];
          const current = this._postData({ text: currentText.trim(), photo: currentPhotos[0] || null, photos: currentPhotos.length ? currentPhotos : null, video: this.pendingVideo, gradient: this.me().colors, music: this.pendingMusic });
          if (currentText === request.text && Cloud._samePayload(current, request.data)) {
            this._postText = ""; if (input) input.value = "";
            this.pendingPhotos = []; this.pendingVideo = null; this.pendingMusic = null;
          } else this._postText = currentText;
          window.Track && Track.event("post_created", { has_photo: !!request.data.photo, has_video: !!request.data.video, has_music: !!request.data.music });
          if (App.toast) App.toast(request.data.video ? "Flex posted" : "Posted to the feed");
          this.render();
        }, "Could not confirm the post. Your draft is kept. Retry the original post.");
      } finally {
        if (this._actionScope() === scope) {
          const current = document.getElementById("post-publish");
          if (current) { current.disabled = !!this.pendingVideoUploading; current.textContent = this._postRequest ? "Retry post" : "Post"; current.removeAttribute && current.removeAttribute("aria-busy"); }
        }
      }
    }
    this.createPost({ text, photo: photos[0] || null, music: this.pendingMusic || null }); this._postText = ""; this.pendingPhotos = []; this.pendingMusic = null; this.render(); return true;
  },
  async removePost(id) {
    if (!this._isMine(this._postById(id)) || this._actionPending("delete-post", id)) return false;
    if (!confirm("Delete this post? This can't be undone.")) return false;
    if (this.cloudActive()) {
      return this._ackAction("delete-post", id, () => Cloud.deletePost && Cloud.deletePost(id), () => {
        this.cloud.feed = this.cloud.feed.filter((p) => p.id !== id);
        if (App.toast) App.toast("Post deleted");
        this.render();
      }, "Could not delete post. It is still here. Try again.");
    }
    this.deletePost(id); this.render(); return true;
  },
  // ---- post overflow menu (standard social actions) + personal feed curation ----
  _postById(id) {
    if (this.cloudActive() && this.cloud.feed) { const c = this.cloud.feed.find((x) => x.id === id); if (c) return c; }
    return ((this.state && this.state.posts) || []).find((x) => x.id === id) || ((this.cloud.feed || []).find((x) => x.id === id));
  },
  _isMine(p) {
    const uid = this.cloudActive() ? Cloud._actionUid() : "me";
    return !!(p && uid && p.author === uid);
  },
  _actionScope() {
    const uid = typeof Cloud !== "undefined" ? Cloud.me : null;
    const authUid = (typeof SupaAuth !== "undefined" && SupaAuth.active() && SupaAuth.uid()) || null;
    return JSON.stringify([this.key, uid, authUid, this._session]);
  },
  _actionPending(action, id) { return !!(this._pendingActions && this._pendingActions.has(this._actionScope() + ":" + action + ":" + id)); },
  async _ackAction(action, id, write, commit, failure) {
    const scope = this._actionScope(), state = this.state;
    const key = scope + ":" + action + ":" + id;
    const pending = this._pendingActions || (this._pendingActions = new Set());
    if (pending.has(key)) return false;
    pending.add(key);
    try {
      let ok = false;
      try { ok = await write(); } catch (error) {}
      if (scope !== this._actionScope() || state !== this.state) return false;
      if (ok !== true) { if (App.toast) App.toast(typeof failure === "function" ? failure() : failure); return false; }
      commit();
      return true;
    } finally { pending.delete(key); }
  },
  _listKey(name) {
    const account = this.cloudActive() ? "cloud_" + (Cloud._actionUid() || "guest") : (this.key || "guest");
    return name + "_" + account;
  },
  _legacyPreferences() {
    const names = ["fm_saved", "fm_hidden", "fm_hidden_cmt", "fm_blocked", "fm_notint", "fm_reported", "fm_muted"];
    try {
      const owner = localStorage.getItem("fm_legacy_preferences_owner");
      if (owner && owner !== this._listKey("owner")) return [];
      return names.flatMap(name => {
        const values = JSON.parse(localStorage.getItem(name) || "[]");
        return Array.isArray(values) && values.length ? [{ name, values }] : [];
      });
    } catch (_) { return []; }
  },
  showLegacyPreferences() {
    let notice = document.getElementById("legacy-preferences-status");
    const legacy = this._legacyPreferences();
    if (!legacy.length) { if (notice) notice.remove(); return; }
    if (!notice) {
      const shell = document.getElementById("app-shell"); if (!shell) return;
      notice = document.createElement("div"); notice.id = "legacy-preferences-status";
      notice.style.cssText = "margin:12px 16px;padding:12px 0;display:flex;gap:12px;align-items:center;flex-wrap:wrap";
      shell.insertBefore(notice, shell.querySelector("nav"));
    }
    notice.innerHTML = `<span role="status" style="flex:1;min-width:180px">Saved items, blocks or mutes from an older version are not active for this account. Their original device data is retained.</span><button class="btn ghost" onclick="Social.restoreLegacyPreferences()">${App.ic("undo", { size: 16 })} Restore preferences</button>`;
  },
  restoreLegacyPreferences() {
    const legacy = this._legacyPreferences();
    if (!legacy.length || (this.cloudActive() && !Cloud._actionUid())) return false;
    if (!confirm("Restore this device's older saved items, blocks, hides and mutes to this account? Continue only if they are yours. Other accounts will not inherit them.")) return false;
    try {
      localStorage.setItem("fm_legacy_preferences_owner", this._listKey("owner"));
      for (const item of legacy) {
        const values = [...new Set([...this._list(item.name), ...item.values])];
        if (!this._setList(item.name, values)) throw new Error("storage_unavailable");
      }
      for (const item of legacy) localStorage.removeItem(item.name);
    } catch (_) { if (App.toast) App.toast("Could not finish restoring preferences. Original data is retained; try again."); return false; }
    this.showLegacyPreferences(); this.render();
    if (App.toast) App.toast("Preferences restored for this account on this device");
    return true;
  },
  _list(name) {
    try { const list = JSON.parse(localStorage.getItem(this._listKey(name)) || "[]"); return Array.isArray(list) ? list : []; }
    catch (error) { return []; }
  },
  _setList(name, list) {
    try { localStorage.setItem(this._listKey(name), JSON.stringify(list)); return true; }
    catch (error) { return false; }
  },
  _addTo(name, value) {
    const list = this._list(name);
    if (!list.includes(value)) { list.unshift(value); if (!this._setList(name, list)) return null; }
    return list;
  },
  isHidden(id) { return this._list("fm_hidden").includes(id); },
  isBlocked(uid) { return this._list("fm_blocked").includes(uid); },
  postMenu(id) {
    const p = this._postById(id); if (!p) return;
    const mine = this._isMine(p);
    const a = this.persona(p.author) || {};
    const acts = [{ icon: "bookmark", label: this.isSaved(id) ? "Remove from saved" : "Save post", on: this.isSaved(id), fn: () => this.toggleSave(id) }];
    if (mine) {
      acts.push({ icon: "edit", label: "Edit caption", fn: () => this.editPost(id) });
      acts.push({ icon: "copy", label: "Copy link", fn: () => this.copyPostLink(id) });
      acts.push({ sep: true });
      acts.push({ icon: "trash", label: "Delete post", danger: true, fn: () => this.removePost(id) });
    } else {
      acts.push({ icon: "minusCircle", label: "Not interested", fn: () => this.notInterested(id) });
      acts.push({ icon: "eyeOff", label: "Hide this post", fn: () => this.hidePost(id) });
      acts.push({ icon: "users", label: (this.isFollowing(p.author) ? "Unfollow @" : "Follow @") + (a.handle || "user"), fn: () => this.toggleFollow(p.author) });
      acts.push({ icon: "copy", label: "Copy link", fn: () => this.copyPostLink(id) });
      acts.push({ sep: true });
      acts.push({ icon: "flag", label: "Report post", danger: true, fn: () => this.reportPost(id) });
      acts.push({ icon: "ban", label: "Block @" + (a.handle || "user"), danger: true, fn: () => this.blockUser(p.author) });
    }
    App.openSheet(mine ? "Your post" : (a.name || "Post"), acts);
  },
  hidePost(id) {
    if (!this._addTo("fm_hidden", id)) { if (App.toast) App.toast("Could not hide post on this device. Try again."); return false; }
    this.haptic(12); if (App.toast) App.toast("Post hidden on this device"); this.render(); return true;
  },
  notInterested(id) {
    const post = this._postById(id); if (!post) return false;
    if ((post.author && !this._addTo("fm_notint", post.author)) || !this._addTo("fm_hidden", id)) {
      if (App.toast) App.toast("Could not save this feed preference on this device. Try again."); return false;
    }
    this.haptic(12); if (App.toast) App.toast("Post hidden from your feed on this device"); this.render(); return true;
  },
  blockUser(uid) {
    if (!uid || this._isMine({ author: uid })) return false;
    if (!confirm("Hide this person's posts from your feed and their comments for this account on this device? They can still see your content and contact you.")) return false;
    if (!this._addTo("fm_blocked", uid)) { if (App.toast) App.toast("Could not save this local block. Try again."); return false; }
    this.haptic(16); if (App.toast) App.toast("Blocked in your feed on this device"); this.render(); return true;
  },
  reportPost(id) {
    const reasons = ["Spam or scam", "Nudity or sexual content", "Harassment or hate", "Violence or threats", "False information", "Something else"];
    App.openSheet("Why are you reporting this?", reasons.map((r) => ({ icon: "flag", label: r, fn: () => this._doReport(id, r) })));
  },
  async _doReport(id, reason) {
    const post = this._postById(id); if (!post) return false;
    return this._reportAction("post", id, reason, post.author);
  },
  async _reportAction(kind, id, reason, reportedUid) {
    if (!id) return false;
    return this._ackAction("report-" + kind, id,
      () => this.cloudActive() && Cloud.report && Cloud.report(kind, id, reason, reportedUid),
      () => {
        const hiddenList = kind === "post" ? "fm_hidden" : kind === "comment" ? "fm_hidden_cmt" : null;
        let hidden = false;
        try {
          if (kind === "post") this._addTo("fm_reported", id);
          if (hiddenList) hidden = !!this._addTo(hiddenList, id);
        } catch (error) {}
        this.haptic(12);
        if (App.toast) App.toast("Report sent." + (hiddenList ? (hidden ? " Hidden from your view." : " Could not hide this item on this device.") : ""));
        if (hiddenList) this.render();
      }, () => typeof Reports !== "undefined" && Reports.enabled() ? Reports.errorFor(kind, String(id), reason) : "Could not confirm the report. Try again when you are signed in and online.");
  },
  copyPostLink(id) {
    const base = (location.origin + location.pathname).replace(/(index\.html)?$/, "");
    const url = base + "?post=" + encodeURIComponent(id);
    const ok = () => { if (App.toast) App.toast("Link copied"); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(ok).catch(() => this._share(url));
    else this._share(url);
  },
  _postData(p) { return { text: p.text || "", photo: p.photo || null, photos: p.photos || null, video: p.video || null, gradient: p.gradient || null, tag: p.tag || "Flex", resharedFrom: p.resharedFrom || null, reshareOf: p.reshareOf || null, music: p.music || null }; },
  editPost(id) {
    const p = this._postById(id); if (!this._isMine(p)) return;
    const card = document.getElementById("modal-card"); if (!card) return;
    card.innerHTML = `<div class="modal-head"><h2>Edit caption</h2><button class="icon-btn" onclick="App.closeModal()">✕</button></div>
      <textarea id="edit-cap" class="food-text" rows="4" style="width:100%;box-sizing:border-box" placeholder="Write a caption…">${esc(p.text || "")}</textarea>
      <button id="edit-cap-save" class="btn wide" style="margin-top:12px" onclick="Social.saveEditPost('${id}')">Save changes</button>`;
    document.getElementById("modal").classList.remove("hidden");
  },
  async saveEditPost(id) {
    const p = this._postById(id); const el = document.getElementById("edit-cap");
    if (!this._isMine(p) || !el || this._actionPending("edit-post", id)) return false;
    const draft = el.value || "", text = draft.trim(), cloud = this.cloudActive();
    const button = document.getElementById("edit-cap-save");
    if (button) { button.disabled = true; button.textContent = "Saving..."; }
    try {
      return await this._ackAction("edit-post", id,
        () => cloud ? (Cloud.editPost && Cloud.editPost(id, this._postData({ ...p, text }))) : true,
        () => {
          const current = this._postById(id); if (current) current.text = text;
          if (!cloud) this.save();
          if (document.getElementById("edit-cap") === el && el.value === draft) App.closeModal();
          this.haptic(12); if (App.toast) App.toast("Caption updated"); this.render();
        }, "Could not update caption. Your draft is still here. Try again.");
    } finally { if (button) { button.disabled = false; button.textContent = "Save changes"; } }
  },
  likePost(id) {
    this.haptic(12);
    if (this.cloudActive()) {
      const post = this.cloud.feed.find((p) => p.id === id);
      if (post) {
        post.likes = post.likes || {};
        if (post.likes[Cloud.me]) { delete post.likes[Cloud.me]; Cloud.unlikeCloud(id); }
        else {
          const owner = Cloud.me, scope = this._actionScope();
          post.likes[owner] = true;
          Promise.resolve(Cloud.likeCloud(id)).then(ok => {
            if (ok === true && this._actionScope() === scope && post.likes[owner] && Cloud.notify && post.author !== owner) return Cloud.notify(post.author, "like", id, undefined, id);
          }).catch(() => {});
        }
        this.render();
        return;
      }
    }
    this.toggleLike(id); this.render();
  },
  toggleComments(id) { const c = document.getElementById("cmts-" + id); if (c) { const show = c.style.display === "none"; c.style.display = show ? "block" : "none"; this._openCmt = show ? id : null; } },
  // ---- cloud comments: threaded + @mentions ----
  commentsFor(postId) { const hid = this._list("fm_hidden_cmt"); return (this.cloud.comments || []).filter((c) => c.post_id === postId && !hid.includes(c.id) && !this.isBlocked(c.author)).sort((a, b) => (a.ts || 0) - (b.ts || 0)); },
  commentCount(postId) { return this.commentsFor(postId).length; },
  _commenter(uid) { return (typeof Cloud !== "undefined" && uid === Cloud.me) ? this.me() : (this.cloudUser(uid) || { id: uid, name: "Member", handle: "member", avatar: null, colors: ["#8b93a7", "#262c3a"] }); },
  _renderMentions(body) { return esc(body || "").replace(/@([a-z0-9._]+)/gi, (m, h) => `<span class="mention">@${esc(h)}</span>`); },
  _parseMentions(body) {
    const handles = (body.match(/@([a-z0-9._]+)/gi) || []).map((s) => s.slice(1).toLowerCase());
    const uids = [];
    handles.forEach((h) => { const u = (this.cloud.users || []).find((x) => (x.username || "").toLowerCase() === h); if (u && !uids.includes(u.uid)) uids.push(u.uid); });
    return uids;
  },
  renderCommentThread(postId) {
    const rows = this.commentRows(postId);
    if (!rows.length) return `<div class="sub" style="padding:6px 2px 10px">No comments yet — be the first 👋</div>`;
    return rows.map(row => this.commentNode(row.comment, [], row.reply)).join("");
  },
  commentRows(postId) {
    const comments = this.commentsFor(postId), ids = new Set(comments.map(comment => comment.id));
    const children = new Map(), roots = [], rows = [], seen = new Set();
    for (const comment of comments) {
      if (!comment.parent_id || !ids.has(comment.parent_id)) roots.push(comment);
      const replies = children.get(comment.parent_id) || [];
      replies.push(comment); children.set(comment.parent_id, replies);
    }
    for (const root of [...roots, ...comments]) {
      const pending = [{ comment: root, reply: false }];
      while (pending.length) {
        const row = pending.pop();
        if (seen.has(row.comment.id)) continue;
        seen.add(row.comment.id); rows.push(row);
        const replies = children.get(row.comment.id) || [];
        for (let index = replies.length - 1; index >= 0; index--) pending.push({ comment: replies[index], reply: true });
      }
    }
    return rows;
  },
  commentNode(c, all, reply = false) {
    const who = this._commenter(c.author);
    return `<div class="cmt2${reply ? " reply" : ""}"><span class="cmt2-av" onclick="Social.viewProfile('${c.author}')">${this.avatar(who, reply ? 26 : 30)}</span><div class="cmt2-body"><b onclick="Social.viewProfile('${c.author}')">${esc(who.name)}</b> ${this._renderMentions(c.body)} <span class="cmt2-time">${this.timeAgo(c.ts)}</span> <button class="cmt2-reply" onclick="Social.startReply('${c.post_id}','${c.id}','${c.author}')">Reply</button>${this._cmtMore(c)}</div></div>`;
  },
  startReply(postId, parentId, parentAuthor) {
    this._replyTo = { postId, parentId, parentAuthor };
    const i = document.getElementById("ci-" + postId);
    if (i) { i.value = "@" + this._commenter(parentAuthor).handle + " "; i.focus(); }
  },
  submitComment(id) {
    const i = document.getElementById("ci-" + id); if (!i || !i.value.trim()) return;
    const body = i.value.trim();
    if (this.cloudActive()) {
      const post = this.cloud.feed.find((p) => p.id === id);
      const mentions = this._parseMentions(body);
      const reply = (this._replyTo && this._replyTo.postId === id) ? this._replyTo : null;
      const nc = Cloud.addComment(id, body, reply ? reply.parentId : null, mentions, post ? post.author : null, reply ? reply.parentAuthor : null);
      if (nc) { if (!this.cloud.comments) this.cloud.comments = []; this.cloud.comments.push(nc); }
      this._replyTo = null; this._openCmt = id;
      if (typeof App !== "undefined" && App.toast) App.toast("Comment posted");
      this.render();
      const c = document.getElementById("cmts-" + id); if (c) c.style.display = "block";
      return;
    }
    this.addComment(id, i.value); this._openCmt = id; this.render();
    const c = document.getElementById("cmts-" + id); if (c) c.style.display = "block";
  },
  // ---- comment options (standard: own→delete, others→report/block, copy) ----
  _cmtMore(c) { return `<button class="cmt2-more" onclick="Social.commentMenu('${c.id}')" title="More" aria-label="More options">${App.ic("more", { size: 15 })}</button>`; },
  _commentById(id) { return (this.cloud.comments || []).find((c) => c.id === id); },
  commentMenu(id) {
    const c = this._commentById(id); if (!c) return;
    const mine = this._isMine(c);
    const who = this._commenter(c.author);
    const acts = [{ icon: "copy", label: "Copy text", fn: () => this.copyText(c.body) }];
    if (mine) {
      acts.push({ sep: true });
      acts.push({ icon: "trash", label: "Delete comment", danger: true, fn: () => this.deleteComment(id) });
    } else {
      acts.push({ sep: true });
      acts.push({ icon: "flag", label: "Report comment", danger: true, fn: () => this.reportComment(id) });
      acts.push({ icon: "ban", label: "Block @" + (who.handle || "user"), danger: true, fn: () => this.blockUser(c.author) });
    }
    App.openSheet(mine ? "Your comment" : (who.name || "Comment"), acts);
  },
  async deleteComment(id) {
    if (!this._isMine(this._commentById(id)) || this._actionPending("delete-comment", id)) return false;
    if (!confirm("Delete this comment?")) return false;
    return this._ackAction("delete-comment", id, () => this.cloudActive() && Cloud.deleteComment && Cloud.deleteComment(id), () => {
      this.cloud.comments = (this.cloud.comments || []).filter((c) => c.id !== id);
      this.haptic(12); if (App.toast) App.toast("Comment deleted"); this.render();
    }, "Could not delete comment. It is still here. Try again.");
  },
  async reportComment(id) {
    const comment = this._commentById(id); if (!comment) return false;
    return this._reportAction("comment", id, "reported", comment.author);
  },
  copyText(t) {
    const ok = () => { if (App.toast) App.toast("Copied"); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t || "").then(ok).catch(() => {}); else if (App.toast) App.toast("Copied");
  },
  // ---- profile-level moderation (report / block a user) ----
  profileMenu(uid) {
    const who = this.cloudUser(uid) || this.persona(uid) || { name: "Member", handle: "member" };
    const h = who.handle || "user";
    const acts = [{ icon: "copy", label: "Copy profile link", fn: () => this.copyProfileLink(uid) }, { sep: true }, { icon: "flag", label: "Report @" + h, danger: true, fn: () => this.reportUser(uid) }];
    if (this.isBlocked(uid)) acts.push({ icon: "ban", label: "Unblock @" + h, fn: () => this.unblockUser(uid) });
    else acts.push({ icon: "ban", label: "Block @" + h, danger: true, fn: () => this.blockFromProfile(uid) });
    App.openSheet(who.name || "Profile", acts);
  },
  blockFromProfile(uid) { if (this.blockUser(uid)) { App.closeModal(); return true; } return false; },
  unblockUser(uid) {
    if (!this._setList("fm_blocked", this._list("fm_blocked").filter((member) => member !== uid))) {
      if (App.toast) App.toast("Could not remove this local block. Try again."); return false;
    }
    this.haptic(12); if (App.toast) App.toast("Unblocked on this device"); this.render(); return true;
  },
  async reportUser(uid) { return this._reportAction("user", uid, "reported", uid); },
  copyProfileLink(uid) {
    const base = (location.origin + location.pathname).replace(/(index\.html)?$/, "");
    const ok = () => { if (App.toast) App.toast("Link copied"); };
    const url = base + "?user=" + encodeURIComponent(uid);
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(ok).catch(() => this._share(url)); else this._share(url);
  },
  async resharePost(id) {
    if (this.cloudActive()) {
      const src = this.cloud.feed.find((p) => p.id === id);
      const owner = Cloud._publishingUid();
      if (!src || !owner) return false;
      const origId = src.reshareOf || src.id;
      const origAuthor = src.resharedFrom || src.author;
      if (origAuthor === owner || this._actionPending("reshare", origId)) return false;
      const mine = this.cloud.feed.find((x) => x.author === owner && x.reshareOf === origId);
      if (mine) {
        return this._ackAction("reshare", origId, () => Cloud.deletePost && Cloud.deletePost(mine.id), () => {
          this.cloud.feed = this.cloud.feed.filter(post => post.id !== mine.id);
          if (App.toast) App.toast("Reshare removed"); this.render();
        }, "Could not remove reshare. Try again.");
      }
      const reshareId = "rs_" + owner + "__" + origId;
      const data = this._postData({ ...src, resharedFrom: origAuthor, reshareOf: origId });
      let receipt;
      return this._ackAction("reshare", origId, async () => {
        receipt = await Cloud.addPost({ ...data, id: reshareId, merge: true, author: owner });
        return !!(receipt && receipt.id === reshareId && receipt.author === owner && Cloud._samePayload(this._postData(receipt), data));
      }, () => {
        if (!this.cloud.feed.some(post => post.id === receipt.id)) this.cloud.feed.unshift(receipt);
        if (Cloud.notify && Cloud.me === owner) Cloud.notify(origAuthor, "reshare", origId, src.text || "");
        if (App.toast) App.toast("Reshared to your feed"); this.render();
      }, "Could not confirm reshare. Try again.");
    }
    this.reshare(id); this.render(); return true;
  },

  // ---- crew UI ----
  crewCard(p, inCrew) {
    return `<div class="crew-card">
      ${this.avatar(p, 52)}
      <div class="crew-info"><div class="crew-name">${esc(p.name)} <span class="lvl">${esc(p.level || "")}</span></div>
        <div class="crew-sub">@${esc(p.handle)} · ${esc(p.physique)}</div>
        <div class="crew-bio">${esc(p.bio || "")}</div></div>
      <div class="crew-cta">
        ${inCrew
          ? `<button class="btn ghost sm" onclick="Social.crewRemove('${p.id}')">Connected ✓</button><button class="chip-btn" title="Message" onclick="Social.openChat('${p.id}')">💬</button>`
          : `<button class="btn sm" onclick="Social.requestConnect('${p.id}')">Connect</button><button class="btn ghost sm" onclick="Social.toggleFollow('${p.id}')">${this.isFollowing(p.id) ? "Following" : "Follow"}</button>`}
      </div>
    </div>`;
  },
  crewBody() {
    if (this.cloudActive()) {
      const reqs = this.cloud.requests.map((r) => {
        const p = this.cloudUser(r.from) || { id: r.from, name: r.from, handle: r.from, colors: ["#8b93a7", "#262c3a"] };
        return `<div class="crew-card"><div class="crew-click" onclick="Social.viewProfile('${r.from}')">${this.avatar(p, 48)}<div class="crew-info"><div class="crew-name">${esc(p.name)}</div><div class="crew-sub">@${esc(p.handle)} wants to connect</div></div></div><div class="crew-cta"><button class="btn sm" onclick="event.stopPropagation();Social.acceptReq('${r.from}')">Accept</button><button class="btn ghost sm" onclick="event.stopPropagation();Social.declineReq('${r.from}')">Decline</button></div></div>`;
      }).join("");
      const q = (this._memberQuery || "").toLowerCase();
      const conns = this.cloud.connections || [];
      const crewMembers = this.cloud.users.filter((u) => conns.includes(u.uid) && !this._isBanned(u.uid));
      const others = this.cloud.users.filter((u) => !conns.includes(u.uid) && !this._isBanned(u.uid) && (!q || (u.name || "").toLowerCase().includes(q) || (u.username || "").toLowerCase().includes(q)));
      const crewCards = crewMembers.map((u) => this.memberCard(this.cloudUser(u.uid))).join("");
      const otherCards = others.map((u) => this.memberCard(this.cloudUser(u.uid))).join("");
      return `${this.cloud.requests.length ? `<div class="card"><div class="card-head"><h2>Connect requests</h2><span class="tag">${this.cloud.requests.length}</span></div><div class="crew-list">${reqs}</div></div>` : ""}
        <div class="card"><div class="card-head"><h2>Your crew</h2><span class="tag">${crewMembers.length}</span></div>
          ${crewMembers.length ? `<div class="crew-list">${crewCards}</div>` : `<div class="sub" style="padding:8px 2px">No crew yet — connect with people below and they'll appear here the moment you're linked 🤝</div>`}</div>
        <div class="card"><div class="card-head"><h2>Discover people</h2><span class="tag">${Math.max(0, this.cloud.users.length - crewMembers.length)}</span></div>
          <div class="member-search"><span>🔎</span><input id="member-search" placeholder="Search people by name or @handle" value="${esc(this._memberQuery || "")}" oninput="Social.searchMembers(this.value)"></div>
          ${this.cloud.users.length ? (others.length ? `<div class="crew-list">${otherCards}</div>` : `<div class="sub" style="padding:8px 2px">${q ? "No one matches your search." : "You've connected with everyone here — legend! 🎉"}</div>`) : `<div class="sub">No one else has joined yet — share Formora and have a friend log in on their phone. When they do, they'll appear here to connect.</div>`}</div>`;
    }
    const crew = this.crewList(), sugg = this.suggestions();
    return `
      <div class="card">
        <div class="card-head"><h2>Your crew</h2><span class="tag">${crew.length}</span></div>
        ${crew.length ? `<div class="crew-list">${crew.map((p) => this.crewCard(p, true)).join("")}</div>` : `<div class="sub">No crew yet — add people from suggestions below to build your circle.</div>`}
      </div>
      <div class="card">
        <div class="card-head"><h2>Crew suggestions</h2><span class="tag">for you</span></div>
        <div class="sub">People with similar goals you might vibe with.</div>
        <div class="crew-list">${sugg.map((p) => this.crewCard(p, false)).join("") || `<div class="sub">You've added everyone — legend! 🎉</div>`}</div>
      </div>`;
  },
  memberCard(p) {
    return `<div class="crew-card"><div class="crew-click" onclick="Social.viewProfile('${p.id}')">${this.avatarP(p, 52)}<div class="crew-info"><div class="crew-name">${esc(p.name)}${this.vbadge(p)}</div><div class="crew-sub">@${esc(p.handle)}${p.physique ? " · " + esc(p.physique) : ""}</div><div class="crew-bio">${esc(p.bio || "")}</div></div></div><div class="crew-cta">${this.memberCta(p.id)}${this.followBtn(p.id)}</div></div>`;
  },
  memberCta(uid) {
    if (this.inCrew(uid) || (this.cloud.connections || []).includes(uid)) return `<button class="btn ghost sm" onclick="event.stopPropagation();Social.openDM('${uid}')">💬 Message</button>`;
    if ((this.cloud.sent || []).includes(uid)) return `<button class="btn ghost sm" onclick="event.stopPropagation();Social.cancelRequest('${uid}')">Requested · Cancel</button>`;
    return `<button class="btn sm" onclick="event.stopPropagation();Social.requestMember('${uid}')">Connect</button>`;
  },
  searchMembers(q) {
    this._memberQuery = q;
    this.render();
    const el = document.getElementById("member-search");
    if (el) { el.focus(); const v = el.value.length; el.setSelectionRange(v, v); }
  },
  requestMember(uid) {
    if (typeof Cloud !== "undefined") { Cloud.sendRequest(uid); if (Cloud.notify) Cloud.notify(uid, "connect", null, ""); }
    if (!this.cloud.sent) this.cloud.sent = [];
    if (!this.cloud.sent.includes(uid)) this.cloud.sent.push(uid);
    if (typeof App !== "undefined" && App.toast) App.toast("Connect request sent ✓");
    this.render();
  },
  acceptReq(fromUid) {
    if (typeof Cloud !== "undefined") { Cloud.acceptRequest(fromUid); if (Cloud.notify) Cloud.notify(fromUid, "accept", null, ""); }
    this.addCrew(fromUid);
    if (!this.cloud.connections) this.cloud.connections = [];
    if (!this.cloud.connections.includes(fromUid)) this.cloud.connections.push(fromUid);
    this.cloud.requests = (this.cloud.requests || []).filter((r) => r.from !== fromUid);
    this.autoFollowOnConnect(fromUid);
    if (typeof App !== "undefined" && App.toast) App.toast("Connected 🎉");
    this.render();
  },
  declineReq(fromUid) {
    if (typeof Cloud !== "undefined" && Cloud.declineRequest) Cloud.declineRequest(fromUid);
    this.cloud.requests = (this.cloud.requests || []).filter((r) => r.from !== fromUid);
    if (typeof App !== "undefined" && App.toast) App.toast("Request declined");
    this.render();
  },
  cancelRequest(uid) {
    if (typeof Cloud !== "undefined" && Cloud.cancelRequest) Cloud.cancelRequest(uid);
    this.cloud.sent = (this.cloud.sent || []).filter((x) => x !== uid);
    if (typeof App !== "undefined" && App.toast) App.toast("Request cancelled");
    this.render();
  },
  _urlify(s) { s = (s || "").trim(); if (!s) return "#"; return /^https?:\/\//i.test(s) ? s : "https://" + s; },
  viewProfile(uid) {
    if (this._vpUid !== uid) { this._vpUid = uid; this._vpTab = "posts"; }
    const tab = this._vpTab || "posts";
    const isMe = (typeof Cloud !== "undefined" && uid === Cloud.me) || uid === "me";
    let u, socials;
    if (isMe) { u = this.me(); socials = (Store.state.profile && Store.state.profile.socials) || {}; }
    else { u = this.cloudUser(uid); if (!u) { u = SOCIAL_PERSONAS.find((x) => x.id === uid); if (!u) return; } socials = u.socials || {}; }
    const posts = this.cloudActive() ? this.cloud.feed.filter((x) => x.author === uid) : this.feed().filter((x) => x.author === (isMe ? "me" : uid));
    const clips = posts.filter((p) => p.photo);
    const links = [
      socials.instagram ? `<a class="soc-link" href="https://instagram.com/${esc((socials.instagram || "").replace(/^@/, ""))}" target="_blank" rel="noopener">📷 Instagram</a>` : "",
      socials.linkedin ? `<a class="soc-link" href="${esc(this._urlify(socials.linkedin))}" target="_blank" rel="noopener">💼 LinkedIn</a>` : "",
      socials.facebook ? `<a class="soc-link" href="${esc(this._urlify(socials.facebook))}" target="_blank" rel="noopener">📘 Facebook</a>` : "",
    ].filter(Boolean).join("");
    const connected = this.inCrew(uid) || (this.cloud.connections || []).includes(uid);
    const requested = (this.cloud.sent || []).includes(uid);
    const cta = isMe ? "" : connected ? `<button class="btn wide" onclick="App.closeModal();Social.openDM('${uid}')">💬 Message</button>`
      : requested ? `<button class="btn ghost wide" onclick="Social.cancelRequest('${uid}');App.closeModal()">Requested · Tap to cancel</button>`
      : `<button class="btn wide" onclick="Social.requestMember('${uid}');App.closeModal()">Connect</button>`;
    const isFriend = this.inCrew(uid) || (this.cloud.connections || []).includes(uid);
    const locked = !isMe && u.privacy === "friends" && !isFriend;
    let tabHtml;
    if (locked) tabHtml = `<div class="vp-locked"><div class="vp-lock-ic">🔒</div><div><b>Friends only</b><br>Connect with ${esc(u.name)} to see their posts &amp; clips.</div></div>`;
    else if (tab === "clips") tabHtml = clips.length ? `<div class="vp-clips">${clips.map((p) => `<div class="vp-clip"><img src="${esc(p.photo)}" alt="clip"></div>`).join("")}</div>` : `<div class="sub" style="text-align:center;padding:16px 0">No clips yet — posts with a photo show here 🎬</div>`;
    else if (tab === "stats") {
      const bmi = u.bmi || 0;
      const bmiCls = bmi ? (bmi < 18.5 ? "Underweight" : bmi < 25 ? "Healthy" : bmi < 30 ? "Overweight" : "Obese") : "—";
      const cell = (v, l) => `<div><b>${v}</b><span>${l}</span></div>`;
      tabHtml = `<div class="vp-stats">
        ${cell(u.heightCm ? u.heightCm + "cm" : "—", "Height")}
        ${cell(u.weightKg ? u.weightKg + "kg" : "—", "Weight")}
        ${cell(bmi ? bmi.toFixed(1) : "—", "BMI · " + bmiCls)}
        ${cell((u.score || 0) + "/100", "Fitness score")}
        ${cell(u.streak || 0, "Day streak")}
        ${cell(u.workouts || 0, "Workouts")}
      </div>${u.physique ? `<div class="vp-goal">Training for <b>${esc(u.physique)}</b></div>` : ""}${isMe ? `<button class="btn ghost wide" onclick="App.closeModal();App.goTab('progress')">Open my progress graph →</button>` : `<div class="sub" style="padding:10px 0;text-align:center">Detailed workout history stays private to each member.</div>`}`;
    }
    else tabHtml = posts.length ? posts.map((x) => this.postCard(this.cloudActive() ? this._cloudPost(x) : x)).join("") : `<div class="sub" style="text-align:center;padding:16px 0">No posts yet.</div>`;
    const card = document.getElementById("modal-card");
    const vpCounts = `<div class="vp-counts">
      <div><b>${posts.length}</b><span>Posts</span></div>
      <div><b>${this.followersCount(uid)}</b><span>Followers</span></div>
      <div><b>${(u.following || []).length}</b><span>Following</span></div>
      ${isMe ? `<div><b>${this.connectionsCount()}</b><span>Connections</span></div>` : ""}
    </div>`;
    const vpBody = (!locked && (u.heightCm || u.weightKg || u.bmi || u.score)) ? `<div class="vp-body">
      ${u.heightCm ? `<div><b>${u.heightCm}<i>cm</i></b><span>Height</span></div>` : ""}
      ${u.weightKg ? `<div><b>${u.weightKg}<i>kg</i></b><span>Weight</span></div>` : ""}
      ${u.bmi ? `<div><b>${(u.bmi).toFixed(1)}</b><span>BMI</span></div>` : ""}
      ${u.score ? `<div><b>${u.score}</b><span>Score</span></div>` : ""}
    </div>` : "";
    const coverImg = u.cover || (isMe && typeof Store !== "undefined" && Store.state && Store.state.profile ? (Store.state.profile.cover || "") : "");
    card.innerHTML = `
      <div class="modal-head"><h2>${isMe ? "Your profile" : "Profile"}</h2><div style="display:flex;gap:4px;align-items:center">${isMe ? "" : `<button class="icon-btn" onclick="Social.profileMenu('${uid}')" title="More" aria-label="More options">${App.ic("more", { size: 20 })}</button>`}<button class="icon-btn" onclick="App.closeModal()">✕</button></div></div>
      <div class="view-profile" data-tier="${this._tierOf(u)}">
        <div class="vp-hero${coverImg ? " has-cover" : ""}"${coverImg ? ` style="background-image:url('${esc(coverImg)}')"` : ""}>${this.avatarP(u, 88)}
          <div class="vp-id"><div class="vp-name">${esc(u.name)}${this.vbadge(u)}${this.tierBadge(u)} ${u.level ? `<span class="lvl">${esc(u.level)}</span>` : ""}</div>
            <div class="vp-handle">@${esc(u.handle)}</div>
            ${!isMe ? `<div class="vp-online ${this.isOnline(uid) ? "on" : ""}">${this.isOnline(uid) ? '<span class="online-dot"></span> Active now' : (this.lastSeenText(uid) || (u.physique ? "Training for " + esc(u.physique) : ""))}</div>` : (u.physique ? `<div class="vp-phys">Training for ${esc(u.physique)}</div>` : "")}
          </div>
        </div>
        ${vpCounts}
        ${vpBody}
        ${u.bio ? `<div class="vp-bio">${esc(u.bio)}</div>` : ""}
        ${links ? `<div class="vp-socials">${links}</div>` : ""}
        ${isMe ? "" : `<div class="vp-actions">${cta}${this.followBtn(uid)}</div>`}
        ${locked ? "" : `<div class="vp-tabs">
          <button class="vp-tab ${tab === "posts" ? "active" : ""}" onclick="Social.vpTab('${uid}','posts')">${App.ic("grid", { size: 15 })} Posts</button>
          <button class="vp-tab ${tab === "clips" ? "active" : ""}" onclick="Social.vpTab('${uid}','clips')">${App.ic("film", { size: 15 })} Clips</button>
          <button class="vp-tab ${tab === "stats" ? "active" : ""}" onclick="Social.vpTab('${uid}','stats')">${App.ic("chart", { size: 15 })} Stats</button>
        </div>`}
        <div class="vp-content">${tabHtml}</div>
      </div>`;
    document.getElementById("modal").classList.remove("hidden");
  },
  vpTab(uid, tab) { this._vpTab = tab; this.viewProfile(uid); },
  // Membership tier of a user (real paid tier when known; demo personas map their level → tier
  // so tier themes are visible across profiles). Returns "elite" | "pro" | "free".
  _tierOf(u) { return (u && u.tier) || (u && { Elite: "elite", Pro: "pro" }[u.level]) || "free"; },
  tierBadge(u) {
    const t = this._tierOf(u);
    if (t !== "elite" && t !== "pro") return "";
    return ` <span class="tier-badge ${t === "elite" ? "tb-elite" : "tb-pro"}">${t === "elite" ? "★" : "◆"} ${t === "elite" ? "Elite" : "Pro"}</span>`;
  },
  crewAdd(id) { this.addCrew(id); this.render(); },
  requestConnect(id) {
    if (this.inCrew(id)) { this.render(); return; }
    this.addCrew(id);
    if (typeof App !== "undefined" && App.toast) App.toast("Request sent · " + this.persona(id).name.split(" ")[0] + " accepted 🎉");
    this.render();
  },
  crewRemove(id) { this.removeCrew(id); this.render(); },

  // ---- chat UI ----
  chatBody() {
    if (this.cloudActive()) return this.dmBody();
    const crew = this.crewList();
    if (!crew.length) return `<div class="card"><div class="card-head"><h2>Chat</h2></div><div class="sub">Add crew members first — then message and hype each other up.</div><button class="btn wide" onclick="Social.feedTab('crew')">Find your crew →</button></div>`;
    const active = this.chatWith && this.inCrew(this.chatWith) ? this.chatWith : crew[0].id;
    this.chatWith = active;
    const p = this.persona(active), msgs = this.messages(active);
    return `<div class="card chat-card">
      <div class="chat-people">${crew.map((c) => `<button class="cp ${c.id === active ? "active" : ""}" onclick="Social.openChat('${c.id}')" title="${esc(c.name)}">${this.avatar(c, 40)}</button>`).join("")}</div>
      <div class="chat-main">
        <div class="chat-head">${this.avatar(p, 36)}<div><div class="ch-name">${esc(p.name)}</div><div class="ch-sub">@${esc(p.handle)}</div></div></div>
        <div class="chat-thread" id="chat-thread">${msgs.length ? msgs.map((m) => `<div class="bubble ${m.by === "me" ? "me" : "them"}">${esc(m.text)}</div>`).join("") : `<div class="sub">Say hi to ${esc(p.name.split(" ")[0])} 👋</div>`}</div>
        <div class="chat-input"><input id="chat-text" placeholder="Message…" onkeydown="if(event.key==='Enter')Social.sendChat()">${App.sendIcon("Social.sendChat()")}</div>
      </div>
    </div>`;
  },
  // ---- cloud direct messages (Instagram-style DMs) ----
  dmBody() {
    const meId = Cloud._actionUid();
    if (!this._dmInboxLoaded) { this._dmInboxLoaded = true; this.loadInbox(); }
    if (this._dmWith) {
      const u = (this._dmWith === meId) ? this.me() : (this.cloudUser(this._dmWith) || { name: "Member", handle: this._dmWith, colors: ["#8b93a7", "#262c3a"], avatar: null });
      const q = (this._dmSearch || "").trim().toLowerCase();
      let msgs = this._dmMsgs || [];
      if (q) msgs = msgs.filter((m) => (m.body || "").toLowerCase().includes(q));
      const thread = this._dmThreadLoading
        ? `<div class="sub" style="padding:20px;text-align:center">Loading…</div>`
        : (msgs.length ? msgs.map((m) => this.dmBubble(m, meId)).join("")
          : this._dmReadError ? "" : (q ? `<div class="sub" style="padding:20px;text-align:center">No messages match “${esc(this._dmSearch)}”.</div>`
            : `<div class="sub" style="padding:20px;text-align:center">Say hi to ${esc((u.name || "").split(" ")[0])} 👋</div>`));
      const draft = this._dmDraft();
      const sending = draft.request && this._actionPending("send-message", JSON.stringify([this._dmWith, draft.request.id]));
      const editing = this._editMsg && this._messagePending(this._editMsg.id);
      const input = this._editMsg
        ? `<div class="chat-input editing"><span class="ci-tag">✏️ Editing</span><input id="dm-edit" placeholder="Edit message…" value="${esc(this._editMsg.draft)}" oninput="if(Social._editMsg)Social._editMsg.draft=this.value" onkeydown="if(event.key==='Enter')Social.saveEditMsg();if(event.key==='Escape')Social.cancelEdit()"><button class="icon-btn" onclick="Social.cancelEdit()" title="Cancel">✕</button><button id="dm-save" class="send-ico" aria-label="Save message" aria-busy="${!!editing}" ${editing ? "disabled" : ""} onclick="Social.saveEditMsg()">${App.ic("send", { size: 20 })}</button></div>`
        : `<div class="chat-input"><input id="dm-text" placeholder="Message…" value="${esc(draft.text)}" oninput="Social._dmDraft().text=this.value" onkeydown="if(event.key==='Enter')Social.sendDM()"><button id="dm-send" class="send-ico" aria-label="${draft.request ? "Retry message" : "Send message"}" aria-busy="${!!sending}" ${sending ? "disabled" : ""} onclick="Social.sendDM()">${App.ic("send", { size: 20 })}</button></div>`;
      return `<div class="card chat-card">
        <div class="dm-head">
          <button class="icon-btn" onclick="Social.closeDM()">←</button>
          <div class="dm-head-u" onclick="Social.chatDetails()">${this.avatarP(u, 38)}<div><div class="ch-name">${esc(u.name)}${this.vbadge(u)}</div><div class="ch-sub">${this.isOnline(this._dmWith) ? '<span class="online-dot sm"></span> Active now' : (this.lastSeenText(this._dmWith) || "Tap for details")}</div></div></div>
          <div class="dm-head-actions"><button class="icon-btn" onclick="Social.toggleDmSearch()" title="Search messages">${App.ic("search", { size: 20 })}</button><button class="icon-btn" onclick="Social.chatDetails()" title="Chat details">${App.ic("info", { size: 20 })}</button></div>
        </div>
        ${this._dmSearchOpen ? `<div class="dm-search"><input id="dm-q" placeholder="Search this chat…" value="${esc(this._dmSearch || "")}" oninput="Social.dmSearch(this.value)"><button class="icon-btn" onclick="Social.toggleDmSearch()">✕</button></div>` : ""}
        <div class="chat-thread" id="chat-thread">${this._dmReadError ? '<div role="alert">Could not load messages. <button class="btn ghost" onclick="Social.refreshDM()">Retry</button></div>' : ""}${thread}</div>
        ${input}
      </div>`;
    }
    const convos = this._dmConvos || [];
    const crew = (this.cloud.connections || []).map((uid) => this.cloudUser(uid)).filter(Boolean);
    const startRow = crew.length ? `<div class="dm-newrow">${crew.map((u) => `<button class="dm-new" onclick="Social.openDM('${u.id}')" title="${esc(u.name)}">${this.avatar(u, 52)}<span>${esc(u.name.split(" ")[0])}</span></button>`).join("")}</div>` : "";
    const rows = convos.map((c) => {
      const u = this.cloudUser(c.uid) || { name: "Member", handle: c.uid, colors: ["#8b93a7", "#262c3a"], avatar: null };
      return `<div class="dm-row" onclick="Social.openDM('${c.uid}')">${this.avatarP(u, 48)}<div class="dm-meta"><div class="dm-name">${esc(u.name)}${this.isMuted(c.uid) ? " " + App.ic("bell", { size: 12 }) : ""}</div><div class="dm-last">${esc((c.last || "").slice(0, 46))}</div></div><div class="dm-time">${this.timeAgo(c.ts)}</div></div>`;
    }).join("");
    return `<div class="card">
      <div class="card-head"><h2>Messages</h2><span class="tag">💬</span></div>
      ${startRow}
      ${this._dmInboxError ? '<div role="alert">Could not load chats. <button class="btn ghost" onclick="Social.loadInbox()">Retry</button></div>' : ""}
      ${this._dmInboxLoading ? `<div class="sub" style="padding:10px 2px">Loading chats…</div>` : (convos.length ? `<div class="dm-list">${rows}</div>` : this._dmInboxError ? "" : `<div class="sub" style="padding:10px 2px">No messages yet. Tap a crew member above to start a chat, or connect with people in Search.</div>`)}
    </div>`;
  },
  // a single message bubble; my own messages are tappable for edit/unsend
  dmBubble(m, meId) {
    const mine = m.from === meId;
    const edited = m.edited ? ` <span class="msg-edited">Edited</span>` : "";
    const t = m.ts ? esc(this.timeAgo(m.ts) + " ago") : "";
    const more = mine ? ` <span onclick="event.stopPropagation();Social.msgMenu('${m.id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();this.click()}" tabindex="0" title="Edit or unsend" role="button" aria-label="Message options" style="opacity:.6;cursor:pointer;font-weight:800;padding:0 3px">⋯</span>` : "";
    return `<div class="bubble ${mine ? "me" : "them"}" data-message-id="${esc(m.id)}" aria-busy="${mine && this._messagePending(m.id)}" title="${t}"${mine ? ` onclick="Social.msgMenu('${m.id}')"` : ""}>${this._urlify2(m.body)}${edited}${more}${this._storyContextSlot(m)}</div>`;
  },

  // ---- Story reply context: reference marker + checked resolve. No story id, media URL or caption is ever kept in the DOM or storage. ----
  _storyContextScan: 50,
  _storyContextResolve: 8,
  _storyContextReady() {
    if (window.STORY_INTERACTIONS !== true || typeof Stories === "undefined" || !this.cloudActive()) return false;
    try { return Stories.enabled() && !!Stories.owner(); } catch (_) { return false; }
  },
  _storyContextSlot(m) {
    if (!m || typeof m.id !== "string" || !m.id || !this._storyContextReady()) return "";
    return `<span class="msg-context" data-story-context="${esc(m.id)}" style="display:block"></span>`;
  },
  _storyContextMap(withUid) {
    const outer = this._storyContext || (this._storyContext = new Map());
    const key = this._actionScope() + ":" + withUid;
    if (!outer.has(key)) {
      outer.set(key, new Map());
      while (outer.size > 8) outer.delete(outer.keys().next().value);
    }
    return outer.get(key);
  },
  _storyContextCurrent(withUid, scope, session, pass) {
    return this._session === session && this._actionScope() === scope && this._dmWith === withUid
      && this.sub === "chat" && (!pass || this._storyContextPass === pass);
  },
  _storyContextNode(id, status) {
    const wrap = document.createElement("span");
    wrap.setAttribute("style", "display:inline-flex;align-items:center;gap:6px;margin-top:4px;flex-wrap:wrap");
    if (status === "unavailable") {
      wrap.className = "msg-context-note";
      wrap.innerHTML = App.ic("info", { size: 14 }) + "<span style=\"font-size:12px;opacity:.8\">Story unavailable</span>";
      return wrap;
    }
    const failed = status === "error";
    if (failed) {
      const note = document.createElement("span");
      note.setAttribute("style", "font-size:12px;opacity:.8");
      note.textContent = "Story could not be checked.";
      wrap.appendChild(note);
    }
    const button = document.createElement("button");
    const label = failed ? "Retry the story this reply is about" : "View the story this reply is about";
    button.type = "button";
    button.className = "btn ghost sm";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("style", "display:inline-flex;align-items:center;gap:6px;min-width:44px;min-height:44px;border-radius:8px;font-size:12px;padding:4px 10px");
    button.innerHTML = App.ic(failed ? "undo" : "film", { size: 14 }) + "<span>" + (failed ? "Retry" : "View story") + "</span>";
    button.addEventListener("click", (event) => { event.stopPropagation(); this.openStoryContext(id); });
    wrap.appendChild(button);
    return wrap;
  },
  // replaces only the context slots, so composer focus, typing and thread scroll are never disturbed
  _paintStoryContext(withUid = this._dmWith) {
    if (typeof document === "undefined" || !document.querySelectorAll || !withUid || this._dmWith !== withUid) return;
    const state = this._storyContextMap(withUid);
    document.querySelectorAll("#chat-thread [data-story-context]").forEach((slot) => {
      const id = slot.getAttribute("data-story-context"), status = state.get(id) || "";
      if (slot.getAttribute("data-story-context-state") === status) return;
      slot.setAttribute("data-story-context-state", status);
      slot.replaceChildren();
      if (status) slot.appendChild(this._storyContextNode(id, status));
    });
  },
  async _scanStoryContext(withUid = this._dmWith, force = false) {
    this._paintStoryContext(withUid);
    if (!withUid || !this._storyContextReady() || this._dmWith !== withUid || this.sub !== "chat") return false;
    const scope = this._actionScope(), session = this._session, state = this._storyContextMap(withUid);
    const ids = (this._dmMsgs || []).map((message) => message && message.id)
      .filter((id) => typeof id === "string" && !!id && id.length <= 255 && !/[\x00-\x1f\x7f]/.test(id));
    const windowIds = [...new Set(ids)].slice(-this._storyContextScan);
    const scanned = state.scanned || (state.scanned = new Set());
    for (const id of scanned) if (!windowIds.includes(id)) scanned.delete(id);
    for (const id of state.keys()) if (!windowIds.includes(id)) state.delete(id);
    const batch = force ? windowIds : windowIds.filter(id => !scanned.has(id));
    if (!batch.length) return true;
    if (!force && this._storyContextPass?.state === state && this._storyContextPass.pending) return false;
    if (!force && state.retryAfter > Date.now()) return false;
    const pass = this._storyContextPass = { state, pending: true };
    state.retryAfter = Date.now() + 300000;
    let references;
    try { references = await Stories.replyReferences(batch); }
    catch (_) {
      // a transient outage must offer a retry, never assert a tombstone we could not confirm
      if (this._storyContextCurrent(withUid, scope, session, pass)) {
        for (const id of batch) if (state.has(id)) state.set(id, "error");
        this._paintStoryContext(withUid);
      }
      pass.pending = false;
      return false;
    }
    pass.pending = false;
    if (!this._storyContextCurrent(withUid, scope, session, pass)) return false;
    state.retryAfter = 0;
    for (const id of batch) scanned.add(id);
    const referenced = new Set(references);
    for (const id of batch) if (referenced.has(id)) { if (!state.has(id)) state.set(id, "reference"); } else state.delete(id);
    this._paintStoryContext(withUid);
    for (const id of batch.filter((value) => referenced.has(value)).reverse().slice(0, this._storyContextResolve)) {
      if (!this._storyContextCurrent(withUid, scope, session, pass)) return false;
      await this._checkStoryContext(id, withUid, scope, session, pass);
    }
    return true;
  },
  // resolves through the checked accessor only; the story id lives in this call frame and is never stored
  async _checkStoryContext(id, withUid, scope, session, pass) {
    const state = this._storyContextMap(withUid);
    try {
      const result = await Stories.resolveContext(id);
      if (!this._storyContextCurrent(withUid, scope, session, pass)) return null;
      const storyId = result && result.available === true && result.story ? result.story.id : null;
      state.set(id, storyId ? "reference" : "unavailable");
      this._paintStoryContext(withUid);
      return storyId || null;
    } catch (error) {
      if (this._storyContextCurrent(withUid, scope, session, pass)) {
        state.set(id, error && error.status === 404 ? "unavailable" : "error");
        this._paintStoryContext(withUid);
      }
      return null;
    }
  },
  async openStoryContext(id) {
    if (!this._storyContextReady()) { if (App.toast) App.toast("Stories are unavailable right now."); return false; }
    const withUid = this._dmWith, scope = this._actionScope(), session = this._session, key = withUid + ":" + id;
    if (this._storyContextOpening === key) return false;
    this._storyContextOpening = key;
    try {
      const storyId = await this._checkStoryContext(id, withUid, scope, session, null);
      if (!this._storyContextCurrent(withUid, scope, session, null)) return false;
      if (!storyId) {
        if (App.toast) App.toast(this._storyContextMap(withUid).get(id) === "error" ? "Could not check that story. Try again." : "Story unavailable.");
        return false;
      }
      await Stories.open(storyId);
      return true;
    } catch (error) {
      if (this._storyContextCurrent(withUid, scope, session, null) && App.toast) App.toast((error && error.message) || "Stories are unavailable right now.");
      return false;
    } finally { if (this._storyContextOpening === key) this._storyContextOpening = null; }
  },
  _dmDraft(withUid = this._dmWith) {
    const drafts = this._dmDrafts || (this._dmDrafts = new Map());
    const key = this._actionScope() + ":" + withUid;
    if (!drafts.has(key)) drafts.set(key, { text: "", request: null, mutations: new Map(), revision: 0 });
    return drafts.get(key);
  },
  _messagePending(id, withUid = this._dmWith) {
    const key = JSON.stringify([withUid, id]);
    return this._actionPending("edit-message", key) || this._actionPending("unsend-message", key);
  },
  _ownedMessage(id) {
    const owner = typeof Cloud !== "undefined" && Cloud._publishingUid && Cloud._publishingUid();
    return owner && (this._dmMsgs || []).find(message => message.id === id && message.from === owner && message.to === this._dmWith);
  },
  _dmRows(rows, withUid) {
    if (!Array.isArray(rows)) return null;
    const draft = this._dmDraft(withUid), owner = Cloud._actionUid();
    const messages = rows.filter(message => message && ((message.from === owner && message.to === withUid) || (message.from === withUid && message.to === owner)))
      .filter(message => !draft.request || message.id !== draft.request.id);
    for (const [id, mutation] of draft.mutations) {
      const index = messages.findIndex(message => message.id === id);
      if (index >= 0) messages[index] = { ...mutation.original }; else messages.push({ ...mutation.original });
    }
    if (this._dmWith === withUid) for (const message of messages) {
      const previous = (this._dmMsgs || []).find(item => item.id === message.id);
      if (previous && previous.edited && previous.body === message.body) message.edited = true;
    }
    return messages.sort((first, second) => first.ts - second.ts);
  },
  _dmWriteControls() {
    const draft = this._dmDraft();
    const sending = draft.request && this._actionPending("send-message", JSON.stringify([this._dmWith, draft.request.id]));
    for (const [id, pending] of [["dm-send", sending], ["dm-save", this._editMsg && this._messagePending(this._editMsg.id)]]) {
      const button = document.getElementById(id);
      if (button) {
        button.disabled = !!pending;
        if (button.setAttribute) { button.setAttribute("aria-busy", String(!!pending)); if (id === "dm-send") button.setAttribute("aria-label", draft.request ? "Retry message" : "Send message"); }
      }
    }
    if (document.querySelectorAll) document.querySelectorAll("#chat-thread [data-message-id]").forEach(bubble => {
      const pending = this._messagePending(bubble.getAttribute("data-message-id"));
      bubble.setAttribute("aria-busy", String(pending));
      const options = bubble.querySelector('[role="button"]');
      if (options) options.setAttribute("aria-disabled", String(pending));
    });
  },
  msgMenu(id) {
    const m = this._ownedMessage(id); if (!m || this._messagePending(id)) return;
    const when = m.ts ? "Sent " + this.timeAgo(m.ts) + " ago" + (m.edited ? " · edited" : "") : "Message";
    this.mediaSheet(when, [
      { label: `${App.ic("edit", { size: 18 })} <span>Edit</span>`, action: () => Social.editMsg(id) },
      { label: `${App.ic("undo", { size: 18 })} <span>Unsend</span>`, action: () => Social.unsendMsg(id) },
      { label: `${App.ic("copy", { size: 18 })} <span>Copy</span>`, action: () => { try { navigator.clipboard.writeText(m.body); if (App.toast) App.toast("Copied"); } catch (_) {} } },
    ]);
  },
  editMsg(id) {
    const m = (this._dmMsgs || []).find((x) => x.id === id); if (!m) return;
    if (this.cloudActive() && (!this._ownedMessage(id) || this._messagePending(id))) return;
    const session = this._session, withUid = this._dmWith;
    const edit = this._editMsg = { id, body: m.body, draft: m.body };
    this.render();
    clearTimeout(this._editPrefillTimer);
    this._editPrefillTimer = setTimeout(() => {
      if (this._session !== session || this._dmWith !== withUid || this._editMsg !== edit) return;
      const input = document.getElementById("dm-edit");
      if (input) { input.value = edit.draft; input.focus(); input.setSelectionRange(edit.draft.length, edit.draft.length); }
    }, 30);
  },
  async saveEditMsg() {
    const input = document.getElementById("dm-edit"), edit = this._editMsg;
    if (!this.state || !this.cloudActive() || !input || !edit || !input.value.trim() || this._messagePending(edit.id)) return false;
    const message = this._ownedMessage(edit.id); if (!message) return false;
    const raw = edit.draft = input.value, body = raw.trim(), withUid = this._dmWith, scope = this._actionScope();
    const draft = this._dmDraft(), key = JSON.stringify([withUid, edit.id]);
    if (!draft.mutations.has(edit.id)) draft.mutations.set(edit.id, { original: { ...message } });
    const saving = this._ackAction("edit-message", key, () => Cloud.editMessage && Cloud.editMessage(edit.id, body, withUid), () => {
      draft.revision++;
      draft.mutations.delete(edit.id);
      if (this._dmWith === withUid) {
        const current = this._ownedMessage(edit.id);
        if (current) { current.body = body; current.edited = true; }
        if (this._editMsg === edit) {
          const currentInput = document.getElementById("dm-edit");
          if (currentInput === input && input.value === raw) this._editMsg = null;
          else if (currentInput) edit.draft = currentInput.value;
        }
        if (this.sub === "chat") { this.render(); this.scrollChat(); }
      }
      this._dmInboxLoaded = false;
      if (App.toast) App.toast("Message edited");
    }, "Could not edit message. Your draft is kept. Try again.");
    this._dmWriteControls();
    try { return await saving; }
    finally { if (this._actionScope() === scope && this._dmWith === withUid) this._dmWriteControls(); }
  },
  cancelEdit() { clearTimeout(this._editPrefillTimer); this._editMsg = null; this.render(); },
  async unsendMsg(id, confirmed = false) {
    const message = this._ownedMessage(id);
    if (!this.state || !this.cloudActive() || !message || this._messagePending(id)) return false;
    if (!confirmed && typeof window !== "undefined" && window.confirm && !window.confirm("Unsend this message? It will be removed for both of you.")) return false;
    const withUid = this._dmWith, scope = this._actionScope(), draft = this._dmDraft(), key = JSON.stringify([withUid, id]);
    if (!draft.mutations.has(id)) draft.mutations.set(id, { original: { ...message } });
    const unsending = this._ackAction("unsend-message", key, () => Cloud.deleteMessage && Cloud.deleteMessage(id, withUid), () => {
      draft.revision++;
      draft.mutations.delete(id);
      if (this._dmWith === withUid) {
        this._dmMsgs = (this._dmMsgs || []).filter(message => message.id !== id);
        if (this._editMsg && this._editMsg.id === id) this._editMsg = null;
        if (this.sub === "chat") { this.render(); this.scrollChat(); }
      }
      this._dmInboxLoaded = false;
      if (App.toast) App.toast("Message unsent");
    }, "Could not confirm unsend. The message is kept here. Try again.");
    this._dmWriteControls();
    try { return await unsending; }
    finally { if (this._actionScope() === scope && this._dmWith === withUid) this._dmWriteControls(); }
  },
  toggleDmSearch() {
    this._dmSearchOpen = !this._dmSearchOpen; if (!this._dmSearchOpen) this._dmSearch = "";
    this.render();
    if (this._dmSearchOpen) setTimeout(() => { const i = document.getElementById("dm-q"); if (i) i.focus(); }, 30);
  },
  dmSearch(q) {
    this._dmSearch = q; this.render();
    const i = document.getElementById("dm-q"); if (i) { i.focus(); const v = i.value.length; i.setSelectionRange(v, v); }
  },
  isMuted(uid) { return this._list("fm_muted").includes(uid); },
  toggleMute(uid) {
    if (!uid) return false;
    let arr = this._list("fm_muted");
    if (arr.includes(uid)) arr = arr.filter((x) => x !== uid); else arr.push(uid);
    if (!this._setList("fm_muted", arr)) { if (App.toast) App.toast("Could not update notifications on this device. Try again."); return false; }
    if (typeof App !== "undefined" && App.toast) App.toast(arr.includes(uid) ? "Notifications muted" : "Unmuted");
    this.chatDetails(); return true;
  },
  msgSoundOff() {
    try {
      if (!this.key || (this.cloudActive() && !Cloud._actionUid())) return true;
      const preference = localStorage.getItem(this._listKey("fm_msgsound"));
      return preference === "off" || (preference !== "on" && localStorage.getItem("fm_msgsound") === "off");
    }
    catch (_) { return true; }
  },
  toggleMsgSound() {
    if (!this.key || (this.cloudActive() && !Cloud._actionUid())) return false;
    const off = this.msgSoundOff();
    try { localStorage.setItem(this._listKey("fm_msgsound"), off ? "on" : "off"); }
    catch (_) { if (typeof App !== "undefined" && App.toast) App.toast("Could not update message sound on this device. Try again."); return false; }
    if (off) this.playPing();
    if (typeof App !== "undefined" && App.toast) App.toast(off ? "Message sound on" : "Message sound off");
    this.chatDetails();
    return true;
  },
  chatDetails() {
    const uid = this._dmWith; if (!uid) return;
    const u = this.cloudUser(uid) || { name: "Member", handle: uid, avatar: null, colors: ["#8b93a7", "#262c3a"] };
    const mine = (this._dmMsgs || []).filter((m) => m.from === Cloud.me).length;
    const card = document.getElementById("modal-card"); if (!card) return;
    card.innerHTML = `<div class="modal-head"><h2>Chat details</h2><button class="icon-btn" onclick="App.closeModal()">✕</button></div>
      <div class="chat-details">
        <div class="cd-hero">${this.avatar(u, 76)}<div class="cd-name">${esc(u.name)}${this.vbadge(u)}</div><div class="cd-handle">@${esc(u.handle)}</div></div>
        <div class="cd-actions">
          <button class="btn ghost wide" onclick="App.closeModal();Social.viewProfile('${uid}')">${App.ic("user", { size: 16 })} View profile</button>
          <button class="btn ghost wide" onclick="App.closeModal();Social.toggleDmSearch()">${App.ic("search", { size: 16 })} Search messages</button>
          <button class="btn ghost wide" onclick="Social.toggleMute('${uid}')">${App.ic("bell", { size: 16 })} ${this.isMuted(uid) ? "Unmute notifications" : "Mute notifications"}</button>
          <button class="btn ghost wide" onclick="Social.toggleMsgSound()">${App.ic("bell", { size: 16 })} ${this.msgSoundOff() ? "Turn on message sound" : "Turn off message sound"}</button>
          <button class="btn ghost wide danger" onclick="Social.clearMyMessages('${uid}')">${App.ic("undo", { size: 16 })} Unsend all my messages</button>
        </div>
        <div class="cd-meta">${(this._dmMsgs || []).length} message${(this._dmMsgs || []).length === 1 ? "" : "s"} · ${mine} from you</div>
      </div>`;
    document.getElementById("modal").classList.remove("hidden");
  },
  async clearMyMessages(uid) {
    if (uid !== this._dmWith || !this.state || !this.cloudActive()) return false;
    const messages = (this._dmMsgs || []).filter(message => this._ownedMessage(message.id));
    if (!messages.length || !window.confirm("Unsend ALL your messages in this chat? This removes them for both of you.")) return false;
    const scope = this._actionScope(), card = document.getElementById("modal-card"), content = card && card.firstElementChild;
    let ok = true;
    for (const message of messages) {
      if (this._actionScope() !== scope || this._dmWith !== uid) return false;
      if (!await this.unsendMsg(message.id, true)) ok = false;
    }
    if (this._actionScope() !== scope || this._dmWith !== uid) return false;
    if (ok && card && card.firstElementChild === content) App.closeModal();
    if (!ok && App.toast) App.toast("Some messages could not be unsent. Try again.");
    return ok;
  },
  _urlify2(s) { return esc(s || ""); },
  loadInbox() {
    if (typeof Cloud === "undefined" || !Cloud.getInbox) return;
    const scope = this._actionScope(), meId = Cloud._actionUid();
    this._dmInboxLoading = true;
    return Cloud.getInbox().then((msgs) => {
      if (this._actionScope() !== scope) return;
      this._dmInboxLoading = false; this._dmInboxError = !Array.isArray(msgs);
      if (this._dmInboxError) { if (this.sub === "chat" && !this._dmWith) this.render(); return; }
      const map = {};
      (msgs || []).forEach((m) => { const other = m.from === meId ? m.to : m.from; if (!map[other] || m.ts > map[other].ts) map[other] = { uid: other, last: (m.from === meId ? "You: " : "") + m.body, ts: m.ts }; });
      this._dmConvos = Object.values(map).sort((a, b) => b.ts - a.ts);
      this._dmInboxLoading = false;
      if (this.sub === "chat" && !this._dmWith) this.render();
    });
  },
  openDM(uid) {
    if (this._dmWith !== uid) { clearTimeout(this._editPrefillTimer); this._editMsg = null; }
    if (typeof App !== "undefined" && App.closeModal) App.closeModal();
    if (typeof App !== "undefined" && App.selectTab) App.selectTab("home");
    this.sub = "chat"; this._dmWith = uid; this._dmMsgs = []; this._dmThreadLoading = true; this._dmReadError = false;
    this._storyContextPass = null;
    this.render();
    if (typeof Cloud !== "undefined" && Cloud.getMessages) {
      const scope = this._actionScope(), draft = this._dmDraft(uid), revision = draft.revision;
      return Cloud.getMessages(uid).then((msgs) => {
        if (this._actionScope() !== scope || this._dmWith !== uid) return;
        if (draft.revision !== revision) {
          this._dmThreadLoading = false;
          if (this.sub === "chat") { this.render(); return this.refreshDM(); }
          return;
        }
        this._dmReadError = !Array.isArray(msgs);
        this._dmMsgs = this._dmRows(msgs, uid) || []; this._dmThreadLoading = false;
        if (this.sub === "chat") { this.render(); this.scrollChat(); }
        if (!this._dmReadError) this._scanStoryContext(uid, true).catch(() => {});
      });
    }
  },
  closeDM() { clearTimeout(this._editPrefillTimer); this._editMsg = null; this._dmWith = null; this._storyContextPass = null; this._dmInboxLoaded = false; this.render(); this.loadInbox(); },
  async sendDM() {
    const input = document.getElementById("dm-text"), withUid = this._dmWith;
    if (!this.state || !this.cloudActive() || !input || !withUid) return false;
    const owner = Cloud._publishingUid(), scope = this._actionScope();
    if (!owner || !Cloud._messageRecipient(withUid)) { if (App.toast) App.toast("Could not send message. Sign in and try again."); return false; }
    const draft = this._dmDraft(); draft.text = input.value;
    if (!draft.request && !draft.text.trim()) return false;
    if (!draft.request) draft.request = { id: Cloud._newActionId(), body: draft.text.trim(), text: draft.text };
    const request = draft.request, key = JSON.stringify([withUid, request.id]);
    let receipt;
    const sending = this._ackAction("send-message", key, async () => {
      if (!request.id || !Cloud.sendMessage) return false;
      receipt = await Cloud.sendMessage(withUid, request.body, request.id);
      return !!(receipt && receipt.id === request.id && receipt.from === owner && receipt.to === withUid && receipt.body === request.body);
    }, () => {
      draft.revision++;
      draft.request = null;
      const currentInput = this._dmWith === withUid && document.getElementById("dm-text");
      if (currentInput) draft.text = currentInput.value;
      if ((!currentInput || currentInput === input) && draft.text === request.text) { draft.text = ""; if (currentInput) currentInput.value = ""; }
      if (this._dmWith === withUid) {
        if (!(this._dmMsgs || []).some(message => message.id === receipt.id)) this._dmMsgs = (this._dmMsgs || []).concat([receipt]);
        if (this.sub === "chat") { this.render(); this.scrollChat(); }
      }
      this._dmInboxLoaded = false;
      if (App.toast) App.toast("Message sent");
    }, "Could not confirm the message. Your draft is kept. Try again.");
    this._dmWriteControls();
    try { return await sending; }
    finally { if (this._actionScope() === scope && this._dmWith === withUid) this._dmWriteControls(); }
  },
  refreshDM(passive = false) {
    if (!this._dmWith || typeof Cloud === "undefined" || !Cloud.getMessages) return;
    const scope = this._actionScope(), withUid = this._dmWith;
    const draft = this._dmDraft(withUid), revision = draft.revision;
    return Cloud.getMessages(withUid).then((msgs) => {
      if (this._actionScope() !== scope || this.sub !== "chat" || this._dmWith !== withUid || draft.revision !== revision) return;
      const previousError = this._dmReadError;
      this._dmReadError = !Array.isArray(msgs);
      const prev = this._dmMsgs || [], current = this._dmRows(msgs, withUid);
      if (current && JSON.stringify(current) !== JSON.stringify(prev)) {
        const seen = new Set(prev.map((m) => m.id));
        const newIncoming = current.some((m) => m.from !== Cloud._actionUid() && !seen.has(m.id));
        this._dmMsgs = current; this.render(); this.scrollChat();
        if (newIncoming && !this.isMuted(this._dmWith)) this.playPing();
      } else if (previousError !== this._dmReadError) this.render();
      if (!this._dmReadError) this._scanStoryContext(withUid, !passive).catch(() => {});
    });
  },
  openChat(id) { this.chatWith = id; this.sub = "chat"; this.render(); },
  sendChat() { const i = document.getElementById("chat-text"); if (!i || !i.value.trim()) return; this.sendMessage(this.chatWith, i.value); this.render(); },
  scrollChat() { const t = document.getElementById("chat-thread"); if (t) t.scrollTop = t.scrollHeight; },

  // ---- challenges UI ----
  challengesBody() {
    const crew = this.crewList(), list = this.state.challenges;
    const opts = crew.length ? crew.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("") : `<option value="">Add crew first</option>`;
    const cards = list.map((c) => {
      const p = this.persona(c.withId), pct = Math.round((c.meDone / c.days) * 100);
      return `<div class="card chal">
        <div class="chal-head">${this.avatar(p, 40)}<div class="chal-t"><div class="pw-name">${esc(c.title)}</div><div class="pw-sub">vs ${esc(p.name)} · ${c.days} days</div></div>
          <span class="tag ${c.status === "won" ? "won" : ""}">${c.status === "won" ? "Won 🏆" : c.meDone + "/" + c.days}</span></div>
        <div class="bar"><div class="bar-f" style="width:${pct}%"></div></div>
        <div class="chal-actions">
          ${c.status !== "won" ? `<button class="btn sm" onclick="Social.tickChallenge('${c.id}')">✓ Log a day</button>` : ""}
          <button class="btn ghost sm" onclick="Social.removeChallenge('${c.id}')">${c.status === "won" ? "Clear" : "Give up"}</button>
        </div>
      </div>`;
    }).join("");
    return `<div class="card">
        <div class="card-head"><h2>Challenge your crew</h2><span class="tag">🏆</span></div>
        <div class="sub">Duel a crew member on a streak or goal — first to finish earns bragging rights.</div>
        <div class="chal-new">
          <select id="chal-with">${opts}</select>
          <input id="chal-title" placeholder="e.g. 7-day 5am club">
          <select id="chal-days"><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option></select>
          <button class="btn" onclick="Social.newChallenge()" ${crew.length ? "" : "disabled"}>Start</button>
        </div>
      </div>${list.length ? cards : `<div class="card"><div class="sub">No active challenges. Start one above! 💥</div></div>`}`;
  },
  newChallenge() {
    const w = document.getElementById("chal-with").value; if (!w) { alert("Add a crew member first."); return; }
    this.createChallenge({ withId: w, title: document.getElementById("chal-title").value, days: +document.getElementById("chal-days").value });
    this.render();
  },
  tickChallenge(id) { this.challengeTick(id); this.render(); },
  removeChallenge(id) { this.dropChallenge(id); this.render(); },
};
