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
    const p = (window.Store && Store.state && Store.state.profile) || {};
    const phys = (window.Engine && Engine.getPhysique && Engine.getPhysique().name) || "Lean Aesthetic";
    const streak = (window.Engine && Engine.streak && Engine.streak()) || 0;
    return { id: "me", name: p.name || "You", handle: (p.email || "you").split("@")[0], colors: ["#ff6b3d", "#ff3d7f"], physique: phys, bio: p.bio || "", level: streak > 60 ? "Elite" : streak > 30 ? "Pro" : streak > 7 ? "Rising" : "Rookie", streak, avatar: p.avatar || null };
  },
  persona(id) {
    if (id === "me") return this.me();
    return SOCIAL_PERSONAS.find((x) => x.id === id) || { id, name: "Unknown", handle: "unknown", colors: ["#8b93a7", "#262c3a"], physique: "", bio: "", level: "" };
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
  suggestions() { return SOCIAL_PERSONAS.filter((p) => !this.inCrew(p.id)); },

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
        ${this.pendingPost ? `<div class="composer-photo"><img src="${this.pendingPost}" alt="preview"></div>` : ""}
        <div class="composer-actions">
          <label class="photo-btn">📷 Photo<input type="file" accept="image/*" onchange="Social.postPhoto(event)" hidden></label>
          <button class="btn" onclick="Social.publishPost()">Post</button>
        </div>
      </div>`;
    return composer + this.feed().map((p) => this.postCard(p)).join("");
  },
  postCard(p) {
    const a = this.persona(p.author);
    const media = p.photo
      ? `<div class="post-media"><img src="${p.photo}" alt="post"></div>`
      : `<div class="post-media grad" style="background:linear-gradient(135deg,${(p.gradient || ["#ff6b3d", "#ff3d7f"]).join(",")})"><span>${esc(p.tag || "Flex")} 💪</span></div>`;
    const comments = (p.comments || []).map((c) => `<div class="cmt"><b>${esc(this.persona(c.by).name)}</b> ${esc(c.text)}</div>`).join("");
    const reshared = p.resharedFrom ? `<div class="reshare-note">🔁 reshared from ${esc(this.persona(p.resharedFrom).name)}</div>` : "";
    return `
      <div class="card post">
        <div class="post-head">
          ${this.avatar(a, 44)}
          <div class="post-who"><div class="pw-name">${esc(a.name)} ${a.level ? `<span class="lvl">${esc(a.level)}</span>` : ""}</div>
            <div class="pw-sub">@${esc(a.handle)} · ${this.timeAgo(p.ts)}</div></div>
          ${p.author === "me" ? `<button class="icon-btn" title="Delete" onclick="Social.removePost('${p.id}')">✕</button>` : ""}
        </div>
        ${reshared}
        ${p.text ? `<div class="post-text">${esc(p.text)}</div>` : ""}
        ${media}
        <div class="post-actions">
          <button class="pa ${p.likedByMe ? "on" : ""}" onclick="Social.likePost('${p.id}')">${p.likedByMe ? "❤️" : "🤍"} <span>${p.likes}</span></button>
          <button class="pa" onclick="Social.toggleComments('${p.id}')">💬 <span>${(p.comments || []).length}</span></button>
          <button class="pa" onclick="Social.resharePost('${p.id}')">🔁 <span>${p.reshares || 0}</span></button>
        </div>
        <div class="post-comments" id="cmts-${p.id}" style="display:none">
          ${comments}
          <div class="cmt-add">
            <input id="ci-${p.id}" placeholder="Add a comment…" onkeydown="if(event.key==='Enter')Social.submitComment('${p.id}')">
            <button class="btn ghost" onclick="Social.submitComment('${p.id}')">Send</button>
          </div>
        </div>
      </div>`;
  },
  postPhoto(e) {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    const r = new FileReader(); r.onload = () => { this.pendingPost = r.result; this.render(); }; r.readAsDataURL(f);
  },
  publishPost() {
    const t = document.getElementById("post-text");
    const text = t ? t.value.trim() : "";
    if (!text && !this.pendingPost) { alert("Write something or add a photo to post."); return; }
    this.createPost({ text, photo: this.pendingPost }); this.pendingPost = null; this.render();
  },
  removePost(id) { this.deletePost(id); this.render(); },
  likePost(id) { this.toggleLike(id); this.render(); },
  toggleComments(id) { const c = document.getElementById("cmts-" + id); if (c) c.style.display = c.style.display === "none" ? "block" : "none"; },
  submitComment(id) {
    const i = document.getElementById("ci-" + id); if (!i || !i.value.trim()) return;
    this.addComment(id, i.value); this._openCmt = id; this.render();
    const c = document.getElementById("cmts-" + id); if (c) c.style.display = "block";
  },
  resharePost(id) { this.reshare(id); this.render(); },

  // ---- crew UI ----
  crewCard(p, inCrew) {
    return `<div class="crew-card">
      ${this.avatar(p, 52)}
      <div class="crew-info"><div class="crew-name">${esc(p.name)} <span class="lvl">${esc(p.level || "")}</span></div>
        <div class="crew-sub">@${esc(p.handle)} · ${esc(p.physique)}</div>
        <div class="crew-bio">${esc(p.bio || "")}</div></div>
      <div class="crew-cta">
        ${inCrew
          ? `<button class="btn ghost sm" onclick="Social.crewRemove('${p.id}')">In crew ✓</button><button class="chip-btn" title="Message" onclick="Social.openChat('${p.id}')">💬</button>`
          : `<button class="btn sm" onclick="Social.crewAdd('${p.id}')">+ Add</button>`}
      </div>
    </div>`;
  },
  crewBody() {
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
  crewAdd(id) { this.addCrew(id); this.render(); },
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
