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

  load(uid) {
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
    return { id: "me", name: p.name || "You", handle: p.username || (p.email || "you").split("@")[0], colors: ["#ff6b3d", "#ff3d7f"], physique: phys, bio: p.bio || "", level: streak > 60 ? "Elite" : streak > 30 ? "Pro" : streak > 7 ? "Rising" : "Rookie", streak, avatar: p.avatar || null };
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
  cloud: { users: [], requests: [], feed: [], sent: [], connections: [], comments: [], notifs: [] },
  cloudActive() { return typeof Cloud !== "undefined" && Cloud.active(); },
  cloudUser(uid) {
    const u = this.cloud.users.find((x) => x.uid === uid);
    if (!u) return null;
    const st = u.streak || 0;
    return { id: u.uid, name: u.name || u.username || "Member", handle: u.username || "member", physique: u.physique || "", bio: u.bio || "", level: (st > 60 ? "Elite" : st > 30 ? "Pro" : st > 7 ? "Rising" : ""), colors: ["#ff6b3d", "#3d8bff"], avatar: u.avatar || null, streak: st, socials: u.socials || {}, privacy: u.privacy || "public" };
  },
  // friends-only posts are hidden from non-connected viewers (UI-level privacy)
  _canSeePost(p) {
    if (typeof Cloud === "undefined" || p.author === Cloud.me) return true;
    const a = this.cloudUser(p.author);
    if (a && a.privacy === "friends") return (this.cloud.connections || []).includes(p.author) || this.inCrew(p.author);
    return true;
  },

  render() {
    const el = document.getElementById("view-feed");
    if (!el) return;
    const sub = this.sub || "feed";
    const nav = [["feed", "🔥 Feed"], ["crew", "🤝 Crew"], ["chat", "💬 Chat"], ["challenges", "🏆 Challenges"]];
    const body = sub === "feed" ? this.feedBody() : sub === "crew" ? this.crewBody() : sub === "chat" ? this.chatBody() : this.challengesBody();
    el.innerHTML = `<div class="social-subnav">${nav.map(([n, l]) => `<button class="ssub ${n === sub ? "active" : ""}" onclick="Social.feedTab('${n}')">${l}</button>`).join("")}</div>${body}`;
    if (sub === "chat") this.scrollChat();
  },
  feedTab(n) { this.sub = n; this.render(); },

  avatar(entity, size = 40) {
    const e = typeof entity === "string" ? this.persona(entity) : entity;
    if (e.avatar) return `<img class="av" style="width:${size}px;height:${size}px" src="${e.avatar}" alt="${esc(e.name)}">`;
    const ini = (e.name || "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
    const [c1, c2] = e.colors || ["#ff6b3d", "#ff3d7f"];
    return `<div class="av" style="width:${size}px;height:${size}px;background:linear-gradient(135deg,${c1},${c2});font-size:${Math.round(size * 0.4)}px">${esc(ini)}</div>`;
  },
  timeAgo(ts) {
    const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return s + "s"; const m = Math.floor(s / 60);
    if (m < 60) return m + "m"; const h = Math.floor(m / 60);
    if (h < 24) return h + "h"; return Math.floor(h / 24) + "d";
  },

  // ---- feed UI ----
  feedBody() {
    const composer = `
      <div class="card composer">
        <div class="composer-top">${this.avatar(this.me(), 42)}
          <textarea id="post-text" class="food-text" rows="2" placeholder="Share a win, flex your progress, or drop some motivation…"></textarea>
        </div>
        ${(this.pendingPhotos && this.pendingPhotos.length) ? `<div class="composer-photos">${this.pendingPhotos.map((src, i) => `<div class="cp-thumb"><img src="${src}" alt="preview" draggable="false"><button class="cp-x" onclick="Social.removePending(${i})">✕</button></div>`).join("")}</div>` : ""}
        <div class="composer-actions">
          <label class="photo-btn">📷 Photos<input type="file" accept="image/*" multiple onchange="Social.postPhoto(event)" hidden></label>
          <button class="btn" onclick="Social.publishPost()">Post</button>
        </div>
      </div>`;
    if (this.cloudActive()) {
      const visible = this.cloud.feed.filter((p) => this._canSeePost(p));
      const posts = visible.map((p) => this.postCard(this._cloudPost(p))).join("");
      return composer + (visible.length ? posts
        : `<div class="card"><div class="sub" style="text-align:center;padding:22px 6px">No posts yet — share your first update above and your crew will see it 💪</div></div>`);
    }
    return composer + this.suggestStrip() + this.feed().map((p) => this.postCard(p)).join("");
  },
  _cloudPost(p) {
    const likes = p.likes || {};
    const meId = (typeof Cloud !== "undefined") ? Cloud.me : null;
    return { id: p.id, author: p.author, text: p.text || "", photo: p.photo || null, photos: p.photos || null, resharedFrom: p.resharedFrom || null, gradient: p.gradient || ["#ff6b3d", "#ff3d7f"], tag: p.tag || "Flex", likes: Object.keys(likes).length, likedByMe: !!(meId && likes[meId]), likers: Object.keys(likes), comments: p.comments || [], reshares: p.reshares || 0, ts: p.ts || Date.now() };
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
    const pics = (p.photos && p.photos.length) ? p.photos : (p.photo ? [p.photo] : []);
    const media = pics.length
      ? (pics.length > 1
        ? `<div class="post-media carousel">${pics.map((src) => `<div class="cslide"><img src="${src}" alt="post" draggable="false"></div>`).join("")}<div class="cdots">${pics.map(() => `<span class="cdot"></span>`).join("")}</div></div>`
        : `<div class="post-media"><img src="${pics[0]}" alt="post" draggable="false"></div>`)
      : `<div class="post-media grad" style="background:linear-gradient(135deg,${(p.gradient || ["#ff6b3d", "#ff3d7f"]).join(",")})"><span>${esc(p.tag || "Flex")} 💪</span></div>`;
    const comments = (p.comments || []).map((c) => `<div class="cmt"><b>${esc(this.persona(c.by).name)}</b> ${esc(c.text)}</div>`).join("");
    const reshared = p.resharedFrom ? `<div class="reshare-note">🔁 reshared from ${esc(this.persona(p.resharedFrom).name)}</div>` : "";
    return `
      <div class="card post">
        <div class="post-head">
          <div class="post-author" onclick="Social.viewProfile('${p.author}')">
            ${this.avatar(a, 44)}
            <div class="post-who"><div class="pw-name">${esc(a.name)} ${a.level ? `<span class="lvl">${esc(a.level)}</span>` : ""}</div>
              <div class="pw-sub">@${esc(a.handle)} · ${this.timeAgo(p.ts)}</div></div>
          </div>
          ${p.author === "me" ? `<button class="icon-btn" title="Delete" onclick="Social.removePost('${p.id}')">✕</button>` : ""}
        </div>
        ${reshared}
        ${p.text ? `<div class="post-text">${esc(p.text)}</div>` : ""}
        ${media}
        <div class="post-actions">
          <button class="pa ${p.likedByMe ? "on" : ""}" onclick="Social.likePost('${p.id}')">${p.likedByMe ? "❤️" : "🤍"} <span>${p.likes}</span></button>
          <button class="pa" onclick="Social.toggleComments('${p.id}')">💬 <span>${this.cloudActive() ? this.commentCount(p.id) : (p.comments || []).length}</span></button>
          <button class="pa" onclick="Social.resharePost('${p.id}')">🔁 <span>${p.reshares || 0}</span></button>
        </div>
        ${p.likers && p.likers.length ? `<div class="post-likers" onclick="Social.showLikers('${p.id}')">❤️ Liked by ${this._likerNames(p.likers)}</div>` : ""}
        <div class="post-comments" id="cmts-${p.id}" style="display:${this._openCmt === p.id ? "block" : "none"}">
          ${this.cloudActive() ? this.renderCommentThread(p.id) : comments}
          <div class="cmt-add">
            <input id="ci-${p.id}" placeholder="Add a comment… @ to mention" onkeydown="if(event.key==='Enter')Social.submitComment('${p.id}')">
            <button class="btn ghost" onclick="Social.submitComment('${p.id}')">Send</button>
          </div>
        </div>
      </div>`;
  },
  postPhoto(e) {
    const files = Array.from((e.target && e.target.files) || []); if (!files.length) return;
    if (!this.pendingPhotos) this.pendingPhotos = [];
    const slots = Math.max(0, 6 - this.pendingPhotos.length);
    Promise.all(files.slice(0, slots).map((f) => resizeImage(f, 1080, 0.8))).then((datas) => { this.pendingPhotos.push(...datas); this.render(); }).catch(() => alert("Couldn't read one of those images."));
  },
  removePending(i) { if (this.pendingPhotos) { this.pendingPhotos.splice(i, 1); this.render(); } },
  publishPost() {
    const t = document.getElementById("post-text");
    const text = t ? t.value.trim() : "";
    const photos = this.pendingPhotos || [];
    if (!text && !photos.length) { alert("Write something or add a photo to post."); return; }
    if (this.cloudActive()) {
      const np = Cloud.addPost({ text, photo: photos[0] || null, photos: photos.length ? photos : null, gradient: this.me().colors, tag: "Flex" });
      if (np) this.cloud.feed.unshift(np);
      this.pendingPhotos = [];
      if (typeof App !== "undefined" && App.toast) App.toast("Posted to the feed 🎉");
      const el = document.getElementById("post-text"); if (el) el.value = "";
      this.render();
      return;
    }
    this.createPost({ text, photo: photos[0] || null }); this.pendingPhotos = []; this.render();
  },
  removePost(id) { this.deletePost(id); this.render(); },
  likePost(id) {
    if (this.cloudActive()) {
      const post = this.cloud.feed.find((p) => p.id === id);
      if (post) {
        post.likes = post.likes || {};
        if (post.likes[Cloud.me]) { delete post.likes[Cloud.me]; Cloud.unlikeCloud(id); }
        else { post.likes[Cloud.me] = true; Cloud.likeCloud(id); if (Cloud.notify && post.author !== Cloud.me) Cloud.notify(post.author, "like", id, post.text || ""); }
        this.render();
        return;
      }
    }
    this.toggleLike(id); this.render();
  },
  toggleComments(id) { const c = document.getElementById("cmts-" + id); if (c) { const show = c.style.display === "none"; c.style.display = show ? "block" : "none"; this._openCmt = show ? id : null; } },
  // ---- cloud comments: threaded + @mentions ----
  commentsFor(postId) { return (this.cloud.comments || []).filter((c) => c.post_id === postId).sort((a, b) => (a.ts || 0) - (b.ts || 0)); },
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
    const all = this.commentsFor(postId);
    const tops = all.filter((c) => !c.parent_id);
    if (!tops.length) return `<div class="sub" style="padding:6px 2px 10px">No comments yet — be the first 👋</div>`;
    return tops.map((c) => this.commentNode(c, all)).join("");
  },
  commentNode(c, all) {
    const replies = all.filter((r) => r.parent_id === c.id);
    const who = this._commenter(c.author);
    const rep = replies.map((r) => { const rw = this._commenter(r.author); return `<div class="cmt2 reply"><span class="cmt2-av" onclick="Social.viewProfile('${r.author}')">${this.avatar(rw, 26)}</span><div class="cmt2-body"><b onclick="Social.viewProfile('${r.author}')">${esc(rw.name)}</b> ${this._renderMentions(r.body)} <span class="cmt2-time">${this.timeAgo(r.ts)}</span></div></div>`; }).join("");
    return `<div class="cmt2"><span class="cmt2-av" onclick="Social.viewProfile('${c.author}')">${this.avatar(who, 30)}</span><div class="cmt2-body"><b onclick="Social.viewProfile('${c.author}')">${esc(who.name)}</b> ${this._renderMentions(c.body)} <span class="cmt2-time">${this.timeAgo(c.ts)}</span> <button class="cmt2-reply" onclick="Social.startReply('${c.post_id}','${c.id}','${c.author}')">Reply</button></div>${rep}</div>`;
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
  resharePost(id) {
    if (this.cloudActive()) {
      const src = this.cloud.feed.find((p) => p.id === id);
      if (src) {
        const np = Cloud.addPost({ text: src.text, photo: src.photo, photos: src.photos, gradient: src.gradient, tag: src.tag, resharedFrom: src.author });
        if (np) this.cloud.feed.unshift(np);
        if (Cloud.notify && src.author !== Cloud.me) Cloud.notify(src.author, "reshare", id, src.text || "");
        if (typeof App !== "undefined" && App.toast) App.toast("Reshared to your feed 🔁");
        this.render();
      }
      return;
    }
    this.reshare(id); this.render();
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
      const filtered = this.cloud.users.filter((u) => !q || (u.name || "").toLowerCase().includes(q) || (u.username || "").toLowerCase().includes(q));
      const members = filtered.map((u) => this.memberCard(this.cloudUser(u.uid))).join("");
      return `${this.cloud.requests.length ? `<div class="card"><div class="card-head"><h2>Connect requests</h2><span class="tag">${this.cloud.requests.length}</span></div><div class="crew-list">${reqs}</div></div>` : ""}
        <div class="card"><div class="card-head"><h2>Members</h2><span class="tag">${this.cloud.users.length}</span></div>
          <div class="member-search"><span>🔎</span><input id="member-search" placeholder="Search people by name or @handle" value="${esc(this._memberQuery || "")}" oninput="Social.searchMembers(this.value)"></div>
          ${this.cloud.users.length ? (filtered.length ? `<div class="crew-list">${members}</div>` : `<div class="sub" style="padding:8px 2px">No one matches your search.</div>`) : `<div class="sub">No one else has joined yet — share Formora and have a friend log in on their phone. When they do, they'll appear here to connect.</div>`}</div>`;
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
    return `<div class="crew-card"><div class="crew-click" onclick="Social.viewProfile('${p.id}')">${this.avatar(p, 52)}<div class="crew-info"><div class="crew-name">${esc(p.name)}</div><div class="crew-sub">@${esc(p.handle)}${p.physique ? " · " + esc(p.physique) : ""}</div><div class="crew-bio">${esc(p.bio || "")}</div></div></div><div class="crew-cta">${this.memberCta(p.id)}</div></div>`;
  },
  memberCta(uid) {
    if (this.inCrew(uid) || (this.cloud.connections || []).includes(uid)) return `<button class="btn ghost sm" disabled>Connected ✓</button>`;
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
    const cta = isMe ? "" : connected ? `<button class="btn ghost wide" disabled>Connected ✓</button>`
      : requested ? `<button class="btn ghost wide" onclick="Social.cancelRequest('${uid}');App.closeModal()">Requested · Tap to cancel</button>`
      : `<button class="btn wide" onclick="Social.requestMember('${uid}');App.closeModal()">Connect</button>`;
    const isFriend = this.inCrew(uid) || (this.cloud.connections || []).includes(uid);
    const locked = !isMe && u.privacy === "friends" && !isFriend;
    let tabHtml;
    if (locked) tabHtml = `<div class="vp-locked"><div class="vp-lock-ic">🔒</div><div><b>Friends only</b><br>Connect with ${esc(u.name)} to see their posts &amp; clips.</div></div>`;
    else if (tab === "clips") tabHtml = clips.length ? `<div class="vp-clips">${clips.map((p) => `<div class="vp-clip"><img src="${p.photo}" alt="clip"></div>`).join("")}</div>` : `<div class="sub" style="text-align:center;padding:16px 0">No clips yet — posts with a photo show here 🎬</div>`;
    else if (tab === "stats") tabHtml = `<div class="vp-stats"><div><b>${posts.length}</b><span>Posts</span></div><div><b>${u.streak || 0}</b><span>Day streak</span></div>${u.physique ? `<div><b>🎯</b><span>${esc(u.physique)}</span></div>` : ""}</div>${isMe ? `<button class="btn ghost wide" onclick="App.closeModal();App.goTab('progress')">Open my progress graph →</button>` : `<div class="sub" style="padding:10px 0;text-align:center">Detailed progress stays private to each member.</div>`}`;
    else tabHtml = posts.length ? posts.map((x) => this.postCard(this.cloudActive() ? this._cloudPost(x) : x)).join("") : `<div class="sub" style="text-align:center;padding:16px 0">No posts yet.</div>`;
    const card = document.getElementById("modal-card");
    card.innerHTML = `
      <div class="modal-head"><h2>${isMe ? "Your profile" : "Profile"}</h2><button class="icon-btn" onclick="App.closeModal()">✕</button></div>
      <div class="view-profile">
        <div class="vp-hero">${this.avatar(u, 88)}
          <div class="vp-id"><div class="vp-name">${esc(u.name)} ${u.level ? `<span class="lvl">${esc(u.level)}</span>` : ""}</div>
            <div class="vp-handle">@${esc(u.handle)}</div>
            ${u.physique ? `<div class="vp-phys">🎯 ${esc(u.physique)}</div>` : ""}
          </div>
        </div>
        ${u.bio ? `<div class="vp-bio">${esc(u.bio)}</div>` : ""}
        ${links ? `<div class="vp-socials">${links}</div>` : ""}
        ${cta}
        ${locked ? "" : `<div class="vp-tabs">
          <button class="vp-tab ${tab === "posts" ? "active" : ""}" onclick="Social.vpTab('${uid}','posts')">📝 Posts</button>
          <button class="vp-tab ${tab === "clips" ? "active" : ""}" onclick="Social.vpTab('${uid}','clips')">🎬 Clips</button>
          <button class="vp-tab ${tab === "stats" ? "active" : ""}" onclick="Social.vpTab('${uid}','stats')">📊 Stats</button>
        </div>`}
        <div class="vp-content">${tabHtml}</div>
      </div>`;
    document.getElementById("modal").classList.remove("hidden");
  },
  vpTab(uid, tab) { this._vpTab = tab; this.viewProfile(uid); },
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
        <div class="chat-input"><input id="chat-text" placeholder="Message…" onkeydown="if(event.key==='Enter')Social.sendChat()"><button class="btn" onclick="Social.sendChat()">Send</button></div>
      </div>
    </div>`;
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
