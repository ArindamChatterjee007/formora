/* ============================================================
   APP: UI rendering + interactions
   ============================================================ */

// escape user-supplied text before inserting into innerHTML
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// downscale + JPEG-compress an uploaded image so it fits in localStorage (avatars/posts)
function resizeImage(file, max = 512, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = reject;
    fr.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > h && w > max) { h = Math.round(h * max / w); w = max; }
        else if (h > max) { w = Math.round(w * max / h); h = max; }
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/jpeg", quality));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

const App = {
  // in-progress workout being built on the Today tab
  session: null,   // { split, slots:[{selected, sets:[{reps,weight}]}] }

  init() {
    Auth.load();
    this.spawnParticles();
    this.applySky();
    setInterval(() => this.applySky(), 5 * 60 * 1000);
    document.addEventListener("visibilitychange", () => this.onVisibility());
    this.guardImages();
    this.bindSwipe();
    if (Auth.isLoggedIn()) this.enterApp();
    else this.showAuth("login");
  },
  // ---- image protection: block right-click / drag / copy-paste on photos, blur when window loses focus (screenshot deterrent) ----
  guardImages() {
    const isImg = (t) => t && (t.tagName === "IMG" || (t.closest && t.closest(".post-media,.cslide,.vp-clip,.cp-thumb,.story-ring,.sv-media,.sv-card,.av")));
    document.addEventListener("contextmenu", (e) => { if (isImg(e.target)) e.preventDefault(); });
    document.addEventListener("dragstart", (e) => { if (isImg(e.target)) e.preventDefault(); });
    const blockCopy = (e) => {
      const sel = document.getSelection && document.getSelection();
      const node = sel && sel.anchorNode ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement) : null;
      if (isImg(e.target) || (node && node.closest && node.closest(".post-media,.cslide,.vp-clip"))) {
        e.preventDefault();
        if (e.clipboardData) e.clipboardData.setData("text/plain", "");
      }
    };
    document.addEventListener("copy", blockCopy);
    document.addEventListener("cut", blockCopy);
    // screenshot deterrent — blur media while the app is backgrounded / loses focus (best-effort; true blocking isn't possible on the web)
    const shield = (on) => document.body.classList.toggle("shot-guard", on);
    window.addEventListener("blur", () => shield(true));
    window.addEventListener("focus", () => shield(false));
    document.addEventListener("visibilitychange", () => shield(document.hidden));
  },
  // pause cloud polling + background animations when the tab is hidden (saves CPU/battery)
  onVisibility() {
    const hidden = document.hidden;
    document.body.classList.toggle("bg-paused", hidden);
    if (typeof Cloud !== "undefined" && Cloud.active && Cloud.active()) Cloud.setPaused(hidden);
  },

  /* ---------------- AUTH GATE ---------------- */
  async enterApp() {
    const u = Auth.currentUser();
    if (!u) return this.showAuth("login");
    Store.load("gymcoach_v1_" + u.id);
    this.applyAccount(u);
    if (this.onboardProfile) this.applyOnboarding();
    await this.syncAccountFromCloud(u);
    Social.load(u.id);
    this.ensureUsername();
    if (!Store.state.profile.onboarded) { this.onboardMode = "login"; return this.showAuth("details"); }
    this.initCloud(u);
    document.getElementById("auth-overlay").classList.add("hidden");
    document.getElementById("app-shell").classList.remove("hidden");
    if (!this.tabsBound) { this.bindTabs(); this.tabsBound = true; }
    this.renderChips();
    this.selectTab("home");
  },

  applyAccount(u) {
    const p = Store.state.profile;
    if (u.name && (!p.name || p.name === DEFAULT_PROFILE.name)) p.name = u.name.split(" ")[0];
    p.email = u.email || p.email || "";
    p.phone = u.phone || p.phone || "";
    Store.save();
  },

  // seed a brand-new account's profile from the signup onboarding answers
  applyOnboarding() {
    const o = this.onboardProfile; this.onboardProfile = null;
    if (!o) return;
    Object.assign(Store.state.profile, o.patch);
    if (o.weightKg) Store.logWeight(o.weightKg); // set today's weight without erasing history
    Store.save();
  },

  // pull this account's data from the cloud and union-merge it, so streak/logs/weight
  // follow the user across devices and no entry is ever lost either way
  async syncAccountFromCloud(u) {
    if (typeof Cloud === "undefined" || !Cloud.active()) return;
    Cloud._ensureIdentity(u.email);
    let cloud = null;
    try { cloud = await Cloud.pullAccount(); } catch (e) { cloud = null; }
    if (cloud && cloud.profile) {
      Store.merge(cloud);   // union of both devices — never drops a logged entry
      Store.normalize();
      Store.save();         // persist locally + mirror the merged result back to the cloud
    } else if (Store.state.profile && Store.state.profile.onboarded) {
      Cloud.pushAccount(Store.state);  // first device online — seed the cloud
    }
  },

  logout() {
    Auth.logout();
    this.session = null;
    document.getElementById("app-shell").classList.add("hidden");
    this.showAuth("login");
  },

  // ---- Backup & Restore (move account + data across devices, no backend) ----
  exportData() {
    const u = Auth.currentUser();
    const blob = { app: "formora", v: 1, exported: new Date().toISOString(), account: u, data: Store.state };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(blob)], { type: "application/json" }));
    a.download = `formora-backup-${(u && u.email ? u.email.split("@")[0] : "me")}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
  },
  restorePrompt() {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = "application/json,.json";
    inp.onchange = (e) => this.importFile(e);
    inp.click();
  },
  importFile(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { try { this.importData(r.result); } catch { alert("That doesn't look like a valid Formora backup file."); } };
    r.readAsText(f);
  },
  importData(text) {
    const blob = JSON.parse(text);
    if (!blob || !blob.account || !blob.data) throw new Error("bad backup");
    const acc = blob.account;
    Auth.load();
    const i = Auth.data.accounts.findIndex((a) => a.id === acc.id ||
      (a.email && acc.email && a.email.toLowerCase() === acc.email.toLowerCase()));
    if (i >= 0) Auth.data.accounts[i] = acc; else Auth.data.accounts.push(acc);
    Auth.setCurrent(acc.id);
    localStorage.setItem("gymcoach_v1_" + acc.id, JSON.stringify(blob.data));
    this.enterApp();
  },

  showAuth(view = "login") {
    document.getElementById("app-shell").classList.add("hidden");
    document.getElementById("auth-overlay").classList.remove("hidden");
    this.authView = view;
    this.renderAuth();
  },

  authErr(msg) { const e = document.getElementById("auth-err"); if (e) e.textContent = msg; },

  renderAuth() {
    const card = document.getElementById("auth-card");
    const isLanding = this.authView === "login" || this.authView === "signup";
    const brand = isLanding
      ? `<div class="landing-hero">
          <div class="auth-brand"><svg class="auth-mark" viewBox="0 0 44 44" fill="none" aria-hidden="true"><defs><linearGradient id="lg1" x1="4" y1="4" x2="40" y2="40" gradientUnits="userSpaceOnUse"><stop stop-color="#ff9d4d"/><stop offset=".55" stop-color="#ff5a4d"/><stop offset="1" stop-color="#ff3d7f"/></linearGradient></defs><rect x="2" y="2" width="40" height="40" rx="13" fill="url(#lg1)"/><path d="M15.5 31.5V16.2c0-1.5 1.2-2.7 2.7-2.7H30" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/><path d="M15.5 22.4h10" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/><circle cx="29.6" cy="29.6" r="2.7" fill="#fff"/></svg> FORM<span>ORA</span></div>
          <h1 class="landing-h1">Build your dream physique.</h1>
          <p class="landing-sub">Adaptive daily workouts, smart meal plans and progress tracking — personalised to the exact look you want.</p>
          <div class="landing-feats">
            <span>🏋️ Adaptive workouts</span><span>🍽️ Meal planner</span>
            <span>📈 Streaks &amp; progress</span><span>🎯 Physique goals</span>
          </div>
        </div>`
      : `<div class="auth-brand"><svg class="auth-mark" viewBox="0 0 44 44" fill="none" aria-hidden="true"><defs><linearGradient id="lg2" x1="4" y1="4" x2="40" y2="40" gradientUnits="userSpaceOnUse"><stop stop-color="#ff9d4d"/><stop offset=".55" stop-color="#ff5a4d"/><stop offset="1" stop-color="#ff3d7f"/></linearGradient></defs><rect x="2" y="2" width="40" height="40" rx="13" fill="url(#lg2)"/><path d="M15.5 31.5V16.2c0-1.5 1.2-2.7 2.7-2.7H30" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/><path d="M15.5 22.4h10" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/><circle cx="29.6" cy="29.6" r="2.7" fill="#fff"/></svg> FORM<span>ORA</span></div>
         <div class="auth-tag">Your aesthetic physique coach</div>`;
    const gbtn = window.GOOGLE_CLIENT_ID
      ? `<div id="gsi-btn" class="gsi-wrap"></div>`
      : `<button class="gbtn" onclick="App.goGoogle()">${this.googleIcon()} Continue with Google</button>`;
    const err = `<div class="auth-err" id="auth-err"></div>`;
    let body = "";

    if (this.authView === "login") {
      body = `${gbtn}
        <div class="auth-or"><span>or</span></div>
        <div class="field"><label>Email</label><input id="a-email" type="email" placeholder="you@email.com"></div>
        <div class="field"><label>Password</label><input id="a-pass" type="password" placeholder="••••••••"></div>
        ${err}
        <button class="btn wide" onclick="App.doLogin()">Log in</button>
        <div class="auth-switch">New here? <a onclick="App.showAuth('signup')">Create an account</a></div>
        <div class="auth-switch">Moving devices? <a onclick="App.restorePrompt()">Restore a backup</a></div>`;
    } else if (this.authView === "signup") {
      body = `${gbtn}
        <div class="auth-or"><span>or sign up with details</span></div>
        <div class="field"><label>Full name</label><input id="s-name" placeholder="Arindam"></div>
        <div class="field"><label>Email</label><input id="s-email" type="email" placeholder="you@email.com"></div>
        <div class="field"><label>Phone number</label><input id="s-phone" type="tel" placeholder="+91 98765 43210"></div>
        <div class="field"><label>Password</label><input id="s-pass" type="password" placeholder="min 6 characters"></div>
        <div class="field"><label>Confirm password</label><input id="s-pass2" type="password" placeholder="repeat password"></div>
        ${err}
        <button class="btn wide" onclick="App.doSignupStart()">Continue →</button>
        <div class="auth-switch">Already have an account? <a onclick="App.showAuth('login')">Log in</a></div>`;
    } else if (this.authView === "details") {
      body = `<div class="auth-sub">A few details so your plan fits <b>you</b> — you can change these anytime.</div>
        <div class="form-grid">
          <div class="field"><label>Sex</label>
            <select id="d-gender" onchange="App.onDetailsGender()">
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select></div>
          <div class="field"><label>Date of birth</label><input id="d-dob" type="date" value="2000-01-01"></div>
          <div class="field"><label>Height (cm)</label><input id="d-h" type="number" inputmode="decimal" placeholder="175"></div>
          <div class="field"><label>Current weight (kg)</label><input id="d-w" type="number" inputmode="decimal" placeholder="70"></div>
          <div class="field"><label>Goal weight (kg)</label><input id="d-tw" type="number" inputmode="decimal" placeholder="optional"></div>
          <div class="field"><label>Activity level</label>
            <select id="d-act">
              <option value="1.375">Light (1–2 days)</option>
              <option value="1.55" selected>Moderate (3–5 days)</option>
              <option value="1.725">High (6–7 days)</option>
            </select></div>
          <div class="field"><label>Diet preference</label>
            <select id="d-diet">
              ${Object.keys(DIETS).map((k) => `<option value="${k}">${DIETS[k]}</option>`).join("")}
            </select></div>
          <div class="field"><label>Your goal physique <span class="inline-hint">(change anytime)</span></label>
            <select id="d-physique">
              ${PHYSIQUES[this.detailsGender || "male"].map((ph) => `<option value="${ph.id}">${esc(ph.name)} — ${esc(ph.tagline)}</option>`).join("")}
            </select></div>
        </div>
        ${err}
        <button class="btn wide" onclick="App.submitDetails()">${this.onboardMode === "login" ? "Save &amp; continue" : "Create my account"}</button>
        <div class="auth-switch">${this.onboardMode === "login" ? `<a onclick="App.logout()">← Log out</a>` : `<a onclick="App.showAuth('signup')">← Back</a>`}</div>`;
    } else if (this.authView === "google") {
      body = `<div class="auth-sub">Choose your Google account</div>
        <div class="field"><label>Name</label><input id="g-name" placeholder="Your name"></div>
        <div class="field"><label>Google email</label><input id="g-email" type="email" placeholder="you@gmail.com"></div>
        ${err}
        <button class="btn wide" onclick="App.doGoogleContinue()">Continue</button>
        <div class="auth-switch"><a onclick="App.showAuth('login')">← Back</a></div>`;
    } else if (this.authView === "phone") {
      body = `<div class="auth-sub">Verify your phone to finish signing in</div>
        <div class="field"><label>Phone number</label><input id="p-phone" type="tel" placeholder="+91 98765 43210" value="${Auth.pending?.account?.phone || ""}"></div>
        ${err}
        <button class="btn wide" onclick="App.doSendOtp()">Send code</button>
        <div class="auth-switch"><a onclick="App.showAuth('login')">← Back</a></div>`;
    } else if (this.authView === "otp") {
      body = `<div class="auth-sub">Enter the 6-digit code sent to <b>${Auth.pending?.account?.phone || "your phone"}</b></div>
        <div class="otp-demo">📶 Demo mode (no SMS gateway) — your code is <b>${Auth.pending?.otp || ""}</b></div>
        <div class="field"><input id="o-code" class="otp-input" inputmode="numeric" maxlength="6" placeholder="000000"></div>
        ${err}
        <button class="btn wide" onclick="App.doVerifyOtp()">Verify &amp; continue</button>
        <div class="auth-switch">Didn't get it? <a onclick="App.doResend()">Resend code</a></div>`;
    }

    card.innerHTML = `${brand}${body}
      <div class="auth-note">${window.SHEETS_API ? "☁️ Secure cloud login — sign in from any device." : "🔒 Private login — your data is saved on this device."}</div>`;
    if (window.GOOGLE_CLIENT_ID && isLanding) this.renderGoogleButton();
  },

  // real Google Sign-In (loads Google Identity Services on demand)
  renderGoogleButton() {
    if (!window.GOOGLE_CLIENT_ID) return;
    const draw = () => {
      if (!(window.google && google.accounts && google.accounts.id)) return;
      google.accounts.id.initialize({ client_id: window.GOOGLE_CLIENT_ID, callback: (r) => App.onGoogleCredential(r) });
      const el = document.getElementById("gsi-btn");
      if (el) { el.innerHTML = ""; google.accounts.id.renderButton(el, { theme: "filled_black", size: "large", text: "continue_with", shape: "pill", width: 320 }); }
    };
    if (window.google && google.accounts && google.accounts.id) return draw();
    let s = document.getElementById("gsi-lib");
    if (!s) { s = document.createElement("script"); s.id = "gsi-lib"; s.src = "https://accounts.google.com/gsi/client"; s.async = true; s.defer = true; s.onload = draw; document.head.appendChild(s); }
    else setTimeout(draw, 300);
  },
  onGoogleCredential(r) {
    try {
      const p = JSON.parse(atob(r.credential.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      Auth.loginWithGoogle({ name: p.name, email: p.email });
      this.enterApp();
    } catch (e) { this.authErr("Google sign-in failed. Try again."); }
  },

  googleIcon() {
    return `<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.4 29.3 35.5 24 35.5c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20c11 0 19.7-8 19.7-20 0-1.3-.1-2.3-.4-3.5z"/>
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
      <path fill="#4CAF50" d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.2c-2 1.5-4.6 2.4-7.3 2.4-5.3 0-9.7-3.4-11.3-8.1l-6.5 5C9.6 39.6 16.2 44 24 44z"/>
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4 5.4l6.3 5.2C41.6 35.5 44 30.3 44 24c0-1.3-.1-2.3-.4-3.5z"/>
    </svg>`;
  },

  goGoogle() { Auth.pending = null; this.showAuth("google"); },
  doGoogleContinue() {
    const name = document.getElementById("g-name").value.trim();
    const email = document.getElementById("g-email").value.trim();
    if (!name || !Auth.validEmail(email)) return this.authErr("Enter a name and a valid Google email.");
    const pend = Auth.googleStart({ name, email });
    if (pend.account.phoneVerified) { Auth.setCurrent(pend.account.id); this.enterApp(); }
    else this.showAuth("phone");
  },

  async doSignupStart() {
    const name = document.getElementById("s-name").value.trim();
    const email = document.getElementById("s-email").value.trim();
    const phone = document.getElementById("s-phone").value.trim();
    const pass = document.getElementById("s-pass").value;
    const pass2 = document.getElementById("s-pass2").value;
    if (!name) return this.authErr("Please enter your name.");
    if (!Auth.validEmail(email)) return this.authErr("Enter a valid email address.");
    if (!Auth.validPhone(phone)) return this.authErr("Enter a valid phone number.");
    if (pass.length < 6) return this.authErr("Password must be at least 6 characters.");
    if (pass !== pass2) return this.authErr("Passwords don't match.");
    if (!Auth.remote() && Auth.findByEmail(email)) return this.authErr("An account with this email already exists. Try logging in.");
    this.signupDraft = { name, email, phone, pass };
    this.onboardMode = "signup";
    this.showAuth("details");
  },

  onDetailsGender() {
    const g = (document.getElementById("d-gender") || {}).value || "male";
    this.detailsGender = g;
    const sel = document.getElementById("d-physique");
    if (sel) sel.innerHTML = PHYSIQUES[g].map((ph) => `<option value="${ph.id}">${esc(ph.name)} — ${esc(ph.tagline)}</option>`).join("");
  },
  // read + validate the onboarding details form -> profile patch (or null)
  _readDetails() {
    const g = document.getElementById("d-gender").value;
    const dob = document.getElementById("d-dob").value;
    const h = parseFloat(document.getElementById("d-h").value);
    const w = parseFloat(document.getElementById("d-w").value);
    const tw = parseFloat(document.getElementById("d-tw").value);
    const act = parseFloat(document.getElementById("d-act").value);
    const diet = document.getElementById("d-diet").value;
    if (!dob) { this.authErr("Please enter your date of birth."); return null; }
    if (!h || h < 90 || h > 250) { this.authErr("Enter a valid height in cm."); return null; }
    if (!w || w < 25 || w > 400) { this.authErr("Enter a valid current weight in kg."); return null; }
    const physEl = document.getElementById("d-physique");
    const patch = {
      gender: g, dob, heightCm: h, startWeightKg: w,
      activityFactor: act, diet, physique: (physEl && physEl.value) || PHYSIQUES[g][0].id, physiqueChosen: true, onboarded: true,
      age: Math.max(13, Math.floor(daysBetween(dob, todayISO()) / 365.25)),
    };
    if (tw && tw >= 25 && tw <= 400) patch.targetWeightKg = tw;
    return patch;
  },
  submitDetails() {
    return this.onboardMode === "login" ? this.finishOnboarding() : this.doCreateAccount();
  },
  // first-time details for an already-logged-in user (e.g. Google sign-in)
  finishOnboarding() {
    const patch = this._readDetails(); if (!patch) return;
    Object.assign(Store.state.profile, patch);
    Store.logWeight(patch.startWeightKg); // never wipe existing weight history
    Store.save();
    this.enterApp();
  },
  async doCreateAccount() {
    const patch = this._readDetails(); if (!patch) return;
    this.onboardProfile = { patch, weightKg: patch.startWeightKg };
    const d = this.signupDraft || {};
    try {
      const r = await Auth.signup({ name: d.name, email: d.email, phone: d.phone, password: d.pass });
      if (r && r.direct) this.enterApp();     // cloud backend: signed in
      else this.showAuth("otp");              // local: verify phone OTP
    } catch (e) { this.authErr(e.message); }
  },

  async doLogin() {
    const email = document.getElementById("a-email").value.trim();
    const pass = document.getElementById("a-pass").value;
    try { await Auth.login({ email, password: pass }); this.enterApp(); }
    catch (e) { this.authErr(e.message); }
  },

  doSendOtp() {
    const phone = document.getElementById("p-phone").value.trim();
    if (!Auth.validPhone(phone)) return this.authErr("Enter a valid phone number.");
    Auth.sendPhoneOtp(phone);
    this.showAuth("otp");
  },
  doVerifyOtp() {
    const code = document.getElementById("o-code").value.trim();
    try { Auth.verifyOtp(code); this.enterApp(); }
    catch (e) { this.authErr(e.message); }
  },
  doResend() { Auth.resendOtp(); this.showAuth("otp"); },

  // floating energy particles in the animated background
  spawnParticles() {
    const c = document.querySelector(".bg-particles");
    if (!c) return;
    const colors = ["255,107,61", "255,61,127", "61,139,255", "34,197,94"];
    for (let i = 0; i < 10; i++) {
      const s = document.createElement("span");
      const size = 4 + Math.random() * 11;
      const col = colors[i % colors.length];
      s.style.left = Math.random() * 100 + "%";
      s.style.width = s.style.height = size + "px";
      s.style.background = `radial-gradient(circle, rgba(${col},.9), transparent 70%)`;
      s.style.animationDuration = 9 + Math.random() * 13 + "s";
      s.style.animationDelay = -Math.random() * 18 + "s";
      c.appendChild(s);
    }
  },

  bindTabs() {
    document.getElementById("tabbar").addEventListener("click", (e) => {
      const btn = e.target.closest(".tab");
      if (!btn) return;
      this.selectTab(btn.dataset.tab);
    });
  },

  // maps a top-level tab to the section element it activates
  _tabView: { home: "feed", search: "feed", coach: "coach", alerts: "alerts", profile: "profile" },
  _tabOrder: ["home", "search", "coach", "alerts", "profile"],

  selectTab(tab) {
    if (!this._tabView[tab]) tab = "home";
    const viewId = "view-" + this._tabView[tab];
    document.querySelectorAll("#tabbar .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
    document.querySelectorAll("#wrap > .view").forEach((v) => v.classList.toggle("active", v.id === viewId));
    this.curTab = tab;
    document.querySelector(".wrap").scrollTo ? window.scrollTo({ top: 0, behavior: "instant" }) : window.scrollTo(0, 0);
    this.renderTab(tab);
  },

  renderTab(tab) {
    if (tab === "home") Social.render("feed");
    else if (tab === "search") Social.render("crew");
    else if (tab === "coach") this.renderCoach();
    else if (tab === "alerts") this.renderAlerts();
    else if (tab === "profile") this.renderProfile();
  },

  // route legacy/deep-link targets (feed, today, progress, nutrition, overview) to the new nav
  goTab(tab) {
    const coachSubs = { overview: 1, today: 1, progress: 1, nutrition: 1 };
    if (coachSubs[tab]) { this.selectTab("coach"); this.renderCoach(tab); return; }
    if (tab === "feed") tab = "home";
    this.selectTab(tab);
  },

  // Coach hub — dashboard + workout + progress + nutrition under one sub-nav
  renderCoach(sub) {
    this.coachSub = sub || this.coachSub || "overview";
    const s = this.coachSub;
    const nav = [["overview", "🏠 Overview"], ["today", "🏋️ Today"], ["progress", "📈 Progress"], ["nutrition", "🍽️ Nutrition"]];
    const sn = document.getElementById("coach-subnav");
    if (sn) sn.innerHTML = nav.map(([n, l]) => `<button class="ssub ${n === s ? "active" : ""}" onclick="App.renderCoach('${n}')">${l}</button>`).join("");
    const views = { overview: "view-home", today: "view-today", progress: "view-progress", nutrition: "view-nutrition" };
    Object.entries(views).forEach(([k, id]) => { const el = document.getElementById(id); if (el) el.style.display = k === s ? "block" : "none"; });
    if (s === "overview") this.renderHome();
    else if (s === "today") this.renderToday();
    else if (s === "progress") this.renderProgress();
    else this.renderNutrition();
  },

  // Alerts tab — notifications feed (moved out of the top bar)
  renderAlerts() {
    const el = document.getElementById("view-alerts");
    if (!el) return;
    el.innerHTML = `<div class="alerts-head"><h2>Activity</h2></div><div class="card" style="padding:0;overflow:hidden"><div class="notif-list" id="notif-list"></div></div>`;
    this.renderNotifPanel();
    if (typeof Cloud !== "undefined" && Cloud.markNotifsRead) Cloud.markNotifsRead();
    this.updateNotifBadge(0);
  },

  // swipe left/right between tabs (Instagram-style)
  bindSwipe() {
    const wrap = document.getElementById("wrap");
    if (!wrap) return;
    let x0 = null, y0 = null, t0 = 0;
    wrap.addEventListener("touchstart", (e) => { const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; t0 = Date.now(); }, { passive: true });
    wrap.addEventListener("touchend", (e) => {
      if (x0 === null) return;
      const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0, dt = Date.now() - t0;
      x0 = null;
      if (dt > 600 || Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.8) return;
      if (e.target.closest && e.target.closest(".carousel, .chat-thread, .composer-photos, input, textarea, select, .social-subnav, .coach-subnav, .vp-tabs")) return;
      const i = this._tabOrder.indexOf(this.curTab || "home");
      if (i < 0) return;
      const next = dx < 0 ? i + 1 : i - 1;
      if (next >= 0 && next < this._tabOrder.length) this.selectTab(this._tabOrder[next]);
    }, { passive: true });
  },

  renderAll() {
    this.renderChips();
    this.selectTab("home");
  },

  renderChips() {
    const w = document.getElementById("chip-weight");
    if (w) w.textContent = `${Store.latestWeight()} kg`;
    const st = document.getElementById("chip-streak");
    if (st) st.textContent = `🔥 ${Engine.streak()}d`;
    const sub = document.querySelector(".logo-sub");
    if (sub) sub.textContent = `${Engine.getPhysique().tagline} · coach`.toLowerCase();
  },

  /* ---------------- HOME (dashboard) ---------------- */
  renderHome() {
    const el = document.getElementById("view-home");
    if (!el) return;
    const p = Store.state.profile;
    const s = Engine.stats();
    const today = todayISO();
    const done = Store.workoutOn(today);
    const isRest = Store.state.restDays.includes(today);
    const day = Store.foodOn(today);
    const eaten = day.items.reduce((n, i) => n + (i.kcal || 0), 0);
    const eatenP = day.items.reduce((n, i) => n + (i.protein || 0), 0);
    const calPct = Math.min(100, Math.round((eaten / s.calTarget) * 100));
    const proPct = Math.min(100, Math.round((eatenP / s.proteinG) * 100));
    const phys = Engine.getPhysique();
    const tp = this.timePeriod();
    const rec = Engine.recommendSplit();
    const trainStatus = done
      ? `Session done ✅ · ${done.exercises.length} exercises`
      : isRest ? "Rest day 😴 — recovery mode" : `Suggested: ${SPLITS[rec].label}`;
    const trainBadge = done ? "Done" : isRest ? "Rest" : "Planned";

    el.innerHTML = `
      <section class="home-hero card">
        <div class="hh-top">
          <div>
            <div class="hh-greet">${tp.greet}, ${esc(p.name)} 👋</div>
            <div class="hh-date">${prettyDate(today)}</div>
          </div>
          <div class="hh-goal">
            <span class="hh-goal-l">Your goal</span>
            <span class="hh-goal-v">${esc(phys.name)}</span>
          </div>
        </div>
        <div class="hh-stats">
          <div class="stat"><div class="stat-v"><span class="cnt" data-to="${s.weight}" data-dec="${Number.isInteger(s.weight) ? 0 : 1}">0</span><small>kg</small></div><div class="stat-l">Weight</div></div>
          <div class="stat"><div class="stat-v">🔥 <span class="cnt" data-to="${Engine.streak()}">0</span></div><div class="stat-l">Day streak</div></div>
          <div class="stat"><div class="stat-v"><span class="cnt" data-to="${s.bmi}" data-dec="1">0</span></div><div class="stat-l">BMI · ${s.bmiClass}</div></div>
          <div class="stat"><div class="stat-v"><span class="cnt" data-to="${s.calTarget}">0</span></div><div class="stat-l">Target kcal</div></div>
        </div>
      </section>

      ${!p.physiqueChosen ? `<div class="card phys-cta home-cta">
        <div><b>Pick your target physique</b><span>Choose how you want to look — your whole plan adapts to it.</span></div>
        <button class="btn" onclick="App.openPhysiquePicker()">Choose look →</button>
      </div>` : ""}

      <div class="home-grid">
        <div class="card home-card">
          <div class="hc-head"><h2>Today's training</h2><span class="hc-badge">${trainBadge}</span></div>
          <div class="hc-line">${trainStatus}</div>
          <div class="hc-actions">
            <button class="btn" onclick="App.goTab('today')">${done || isRest ? "Open Today" : "Start workout →"}</button>
          </div>
        </div>

        <div class="card home-card">
          <div class="hc-head"><h2>Today's nutrition</h2><span class="hc-badge">${eaten} / ${s.calTarget} kcal</span></div>
          <div class="bar"><div class="bar-f" data-w="${calPct}" style="width:0"></div></div>
          <div class="bar-l"><span>Calories</span><span>${calPct}%</span></div>
          <div class="bar"><div class="bar-f pro" data-w="${proPct}" style="width:0"></div></div>
          <div class="bar-l"><span>Protein</span><span>${eatenP} / ${s.proteinG}g</span></div>
          <div class="hc-actions">
            <button class="btn" onclick="App.goTab('nutrition')">Plan / log meals →</button>
          </div>
        </div>
      </div>

      <div class="home-quick">
        <button class="quick" onclick="App.goTab('nutrition')"><span>🍽️</span>Plan meals</button>
        <button class="quick" onclick="App.goTab('today')"><span>💪</span>Workout</button>
        <button class="quick" onclick="App.goTab('progress')"><span>📈</span>Progress</button>
        <button class="quick" onclick="App.goTab('profile')"><span>⚙️</span>Profile</button>
      </div>`;
    this.animateHome(el);
  },

  // count-up the stat numbers + grow the progress bars on the Home dashboard
  animateHome(el) {
    const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.querySelectorAll(".cnt").forEach((n) => {
      const to = parseFloat(n.dataset.to) || 0;
      const dec = parseInt(n.dataset.dec || "0", 10);
      if (reduce) { n.textContent = to.toFixed(dec); return; }
      const start = performance.now(), dur = 750;
      const tick = (t) => {
        const prog = Math.min(1, (t - start) / dur);
        const eased = 1 - Math.pow(1 - prog, 3);
        n.textContent = (to * eased).toFixed(dec);
        if (prog < 1) requestAnimationFrame(tick); else n.textContent = to.toFixed(dec);
      };
      requestAnimationFrame(tick);
    });
    el.querySelectorAll(".bar-f").forEach((b) => {
      const w = (b.dataset.w || "0") + "%";
      if (reduce) { b.style.width = w; return; }
      requestAnimationFrame(() => requestAnimationFrame(() => { b.style.width = w; }));
    });
  },

  /* ---------------- TODAY ---------------- */
  renderToday() {
    const el = document.getElementById("view-today");
    const today = todayISO();
    const done = Store.workoutOn(today);
    const isRest = Store.state.restDays.includes(today);
    const tip = COACH_TIPS[new Date().getDate() % COACH_TIPS.length];

    let html = `
      <div class="card hero">
        <div class="hero-title">${this.timePeriod().greet}, ${esc(Store.state.profile.name)} 👋</div>
        <div class="hero-date">${prettyDate(today)} · goal: ${Engine.getPhysique().name}</div>
        <div class="hint" style="margin-top:12px">💡 ${tip}</div>
        ${!Store.state.profile.physiqueChosen ? `<div class="phys-cta">
          <div><b>Pick your target physique</b><span>Choose how you want to look — your whole plan adapts to it.</span></div>
          <button class="btn" onclick="App.openPhysiquePicker()">Choose look →</button>
        </div>` : ""}`;

    if (this.session) {
      html += `</div>`;
      el.innerHTML = html + this.sessionCard();
      return;
    }

    if (done) {
      html += `<div class="focus-banner" style="margin-top:14px">
          <div><div class="ft">Session complete ✅</div>
          <div class="fs">${done.exercises.length} exercises · ${done.exercises.reduce((n,e)=>n+e.sets.length,0)} sets · ${Math.round(done.volume)} kg volume</div></div>
          <span class="pill" style="background:var(--green)">${SPLITS[done.split].label}</span>
        </div>
        <button class="btn ghost wide" style="margin-top:12px" onclick="App.editSession()">✏️ Edit this session</button>
        </div>`;
      html += this.guidanceCard();
      el.innerHTML = html;
      return;
    }

    if (isRest) {
      html += `<div class="focus-banner" style="margin-top:14px">
          <div><div class="ft">Rest day 😴</div><div class="fs">Recovery is where muscle is built. Eat, hydrate, sleep well.</div></div>
          <button class="swap" onclick="App.undoRest()">Actually, I'll train</button>
        </div></div>`;
      html += this.guidanceCard();
      el.innerHTML = html;
      return;
    }

    const rec = Engine.recommendSplit();
    html += `<div class="choice">
        <button class="btn-big go" onclick="App.startSession('${rec}')">Going to the gym 💪<small>Suggested: ${SPLITS[rec].label}</small></button>
        <button class="btn-big rest" onclick="App.markRest()">Rest today 😴<small>Log a recovery day</small></button>
      </div>
      <div class="pick-day">
        <span class="pick-label">or pick your day:</span>
        ${SPLIT_ROTATION.map((s) => `<button class="day-chip ${s === rec ? "rec" : ""}" onclick="App.startSession('${s}')">${SPLITS[s].label}${s === rec ? " ★" : ""}</button>`).join("")}
      </div>
      <div class="hint" style="margin-top:12px">ℹ️ ${Engine.splitReason(rec)}</div>
      </div>`;
    html += this.guidanceCard();
    el.innerHTML = html;
  },

  guidanceCard() {
    const items = Engine.guidance().map((m) => `<li>${m}</li>`).join("");
    return `<div class="card"><h2>Coach's read</h2>
      <div class="sub">Based on your full history</div>
      <ul class="guide">${items}</ul></div>`;
  },

  /* ---------------- PHYSIQUE PICKER ---------------- */
  physiqueFigure(f) {
    const S = f.shoulders, W = f.waist, H = f.hips, A = f.arms, L = f.legs, tone = f.tone, c = f.color;
    const cx = 50;
    const torso = `M${cx - S} 40 C ${cx - S} 56, ${cx - W - 3} 80, ${cx - W} 96 L ${cx - H} 112 L ${cx + H} 112 L ${cx + W} 96 C ${cx + W + 3} 80, ${cx + S} 56, ${cx + S} 40 C ${cx + S - 5} 35, ${cx + 9} 37, ${cx} 37 C ${cx - 9} 37, ${cx - S + 5} 35, ${cx - S} 40 Z`;
    const armL = `<rect x="${cx - S - A + 3}" y="42" width="${A}" height="54" rx="${A / 2}"/>`;
    const armR = `<rect x="${cx + S - 3}" y="42" width="${A}" height="54" rx="${A / 2}"/>`;
    const legL = `<rect x="${cx - H + 2}" y="108" width="${L}" height="66" rx="6"/>`;
    const legR = `<rect x="${cx + H - 2 - L}" y="108" width="${L}" height="66" rx="6"/>`;
    const head = `<circle cx="${cx}" cy="20" r="11"/><rect x="${cx - 4}" y="29" width="8" height="9" rx="3"/>`;
    const defn = tone > 0.45 ? `
      <line x1="${cx}" y1="46" x2="${cx}" y2="92"/>
      <path d="M ${cx - 13} 52 Q ${cx} 60 ${cx + 13} 52"/>
      <line x1="${cx - 10}" y1="70" x2="${cx + 10}" y2="70"/>
      <line x1="${cx - 9}" y1="80" x2="${cx + 9}" y2="80"/>` : "";
    return `<svg viewBox="0 0 100 180" class="phys-fig" preserveAspectRatio="xMidYMid meet">
      <g fill="${c}">${head}${armL}${armR}${legL}${legR}<path d="${torso}"/></g>
      <g stroke="rgba(255,255,255,.5)" stroke-width="1.3" fill="none" style="opacity:${Math.max(0, tone - 0.35)}">${defn}</g>
    </svg>`;
  },

  openPhysiquePicker(gender) {
    this.pickGender = gender || Store.state.profile.gender || "male";
    if (!this.pickId || !PHYSIQUES[this.pickGender].some((x) => x.id === this.pickId)) {
      const cur = PHYSIQUES[this.pickGender].find((x) => x.id === Store.state.profile.physique);
      this.pickId = (cur || PHYSIQUES[this.pickGender][0]).id;
    }
    document.getElementById("modal").classList.remove("hidden");
    this.renderPhysiqueGrid();
  },
  pickLook(id) { this.pickId = id; this.renderPhysiqueGrid(); },

  renderPhysiqueGrid() {
    const g = this.pickGender;
    const p = Store.state.profile;
    const cards = PHYSIQUES[g].map((ph) => `
      <button class="phys-card ${ph.id === this.pickId ? "sel" : ""}" onclick="App.pickLook('${ph.id}')">
        <div class="phys-fig-wrap">${this.physiqueFigure(ph.fig)}</div>
        <div class="phys-name">${ph.name}</div>
        <div class="phys-tag">${ph.tagline}</div>
        ${ph.id === p.physique && g === p.gender ? '<div class="phys-current-badge">✓ current</div>' : ""}
      </button>`).join("");
    document.getElementById("modal-card").innerHTML = `
      <div class="modal-head">
        <h2>How do you want to look?</h2>
        <button class="icon-btn" onclick="App.closeModal()">✕</button>
      </div>
      <div class="gender-toggle">
        <button class="${g === "male" ? "active" : ""}" onclick="App.openPhysiquePicker('male')">Men</button>
        <button class="${g === "female" ? "active" : ""}" onclick="App.openPhysiquePicker('female')">Women</button>
      </div>
      <div class="phys-grid">${cards}</div>
      ${this.physiqueDetail()}`;
    if (window.PEXELS_KEY && this.pickId) this.loadPexelsPhoto(this.pickId);
  },

  // fetch a real reference photo (only if a Pexels key is configured)
  async loadPexelsPhoto(id) {
    const box = document.getElementById("pd-photo");
    if (!box || !window.PEXELS_KEY) return;
    if (!this.pexelsCache) this.pexelsCache = {};
    if (this.pexelsCache[id]) {
      box.innerHTML = this.pexelsCache[id];
      return;
    }
    const query = (window.PHOTO_QUERIES || {})[id] || "fitness athlete";
    try {
      const res = await fetch(
        `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=10&orientation=portrait`,
        { headers: { Authorization: window.PEXELS_KEY } });
      if (!res.ok) return;
      const data = await res.json();
      const photos = data.photos || [];
      if (!photos.length) return;
      const pick = photos[Math.floor(Math.random() * Math.min(photos.length, 6))];
      const src = pick.src.portrait || pick.src.large || pick.src.medium;
      const html = `<img src="${src}" alt="reference physique" loading="lazy">
        <span class="pd-credit">Photo: ${esc(pick.photographer || "Pexels")} · Pexels</span>`;
      this.pexelsCache[id] = html;
      if (document.getElementById("pd-photo")) document.getElementById("pd-photo").innerHTML = html;
    } catch { /* stay on the illustrated figure */ }
  },

  physiqueDetail() {
    const ph = PHYSIQUES[this.pickGender].find((x) => x.id === this.pickId);
    if (!ph) return "";
    const photos = (Store.state.profile.lookPhotos || {})[ph.id] || [];
    const gallery = photos.map((src, i) => `
      <div class="ref-photo"><img src="${src}" alt="reference"><button class="icon-btn" onclick="App.removeLookPhoto(${i})">✕</button></div>`).join("");
    const balance = ph.calAdj > 0 ? `+${ph.calAdj} kcal surplus` : ph.calAdj < 0 ? `${ph.calAdj} kcal deficit` : "maintenance calories";
    return `<div class="phys-detail">
      <div class="pd-photo" id="pd-photo">
        <img src="assets/physiques/${ph.id}.jpg" alt="${esc(ph.name)} physique reference" loading="lazy"
          onerror="this.closest('.pd-photo').classList.add('none')">
        <span class="pd-credit">Reference photo · Wikimedia Commons</span>
      </div>
      <div class="pd-figure">${this.physiqueFigure(ph.fig)}</div>
      <div class="pd-info">
        <div class="pd-name">${ph.name}</div>
        <div class="pd-tag">${ph.tagline}</div>
        <p class="pd-desc">${ph.desc}</p>
        <div class="pd-facts">
          <span>🍽️ ${balance}</span><span>💪 ${ph.protein}g/kg protein</span>
        </div>
        <div class="pd-focus">Priority muscles: <b>${ph.emphasis.join(", ")}</b></div>
      </div>
      <div class="pd-outfits">
        <div class="pd-outfits-head">👗 Once you build this, confidently wear</div>
        <div class="outfit-tags">${(ph.outfits || []).map((o, i) => `<button class="outfit-tag" onclick="App.outfitSearch('${this.pickGender}','${ph.id}',${i})" title="Browse licensed photos">${esc(o)} <span class="ot-ico">🔎</span></button>`).join("")}</div>
      </div>
      <div class="pd-gallery">
        <div class="pd-gallery-head">Reference photos <small>your own — add angles you like</small></div>
        <div class="ref-grid">
          ${gallery}
          <label class="ref-add">＋ Add photo
            <input type="file" accept="image/*" onchange="App.addLookPhoto(event)" hidden>
          </label>
        </div>
      </div>
      <button class="btn wide" onclick="App.selectPhysique('${ph.id}')">✓ Use this as my goal</button>
    </div>`;
  },

  addLookPhoto(ev) {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 400, scale = Math.min(1, max / Math.max(img.width, img.height));
        const cv = document.createElement("canvas");
        cv.width = img.width * scale; cv.height = img.height * scale;
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        const p = Store.state.profile;
        if (!p.lookPhotos) p.lookPhotos = {};
        if (!p.lookPhotos[this.pickId]) p.lookPhotos[this.pickId] = [];
        p.lookPhotos[this.pickId].push(cv.toDataURL("image/jpeg", 0.7));
        Store.save();
        this.renderPhysiqueGrid();
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  },
  removeLookPhoto(i) {
    const p = Store.state.profile;
    p.lookPhotos[this.pickId].splice(i, 1);
    Store.save();
    this.renderPhysiqueGrid();
  },

  selectPhysique(id) {
    const p = Store.state.profile;
    p.gender = this.pickGender;
    p.physique = id;
    p.physiqueChosen = true;
    Store.save();
    this.closeModal();
    this.renderChips();
    const active = document.querySelector(".tab.active")?.dataset.tab || "today";
    this.renderTab(active);
  },
  closeModal() { document.getElementById("modal").classList.add("hidden"); },

  // open a licensed (SFW) photo search for an outfit — no scraping/embedding
  outfitSearch(gender, id, idx) {
    const ph = (PHYSIQUES[gender] || []).find((x) => x.id === id);
    const o = ph && ph.outfits && ph.outfits[idx];
    if (!o) return;
    const q = encodeURIComponent(`${o} indian fashion`);
    window.open(`https://www.pexels.com/search/${q}/`, "_blank", "noopener");
  },

  startSession(split) {
    const primary = SPLIT_SLOTS[split].map((s) => {
      const emph = Engine.isEmphasized(EXERCISES[s.options[0]].muscle);
      return {
        kind: "primary",
        slotName: s.name,
        targetSets: s.sets + (emph ? 1 : 0),
        reps: s.reps,
        options: s.options,
        selected: s.options[0],
        sets: [{ reps: "", weight: "" }],
      };
    });
    const extras = Engine.recommendExtras(split).map((e) => ({
      kind: "extra",
      slotName: `${e.group} · extra`,
      targetSets: e.targetSets,
      reps: e.reps,
      options: e.options,
      selected: e.selected,
      sets: [{ reps: "", weight: "" }],
    }));
    this.session = { split, items: [...primary, ...extras] };
    this.renderToday();
  },

  // reopen a finished workout to edit its sets
  editSession() {
    const done = Store.workoutOn(todayISO());
    if (!done) return;
    this.session = {
      split: done.split,
      editing: true,
      origDate: done.date,
      items: done.exercises.map((e) => ({
        kind: "primary",
        slotName: (EXERCISES[e.id] && EXERCISES[e.id].muscle) || e.muscle || e.name,
        targetSets: e.sets.length || 3,
        reps: "8–12",
        options: [e.id],
        selected: e.id,
        sets: e.sets.map((s) => ({ reps: String(s.reps), weight: String(s.weight) })),
      })),
    };
    this.renderToday();
  },

  // manually change the day (Push/Pull/Legs), even mid-session
  switchSplit(split) {
    if (this.session && this.session.split === split) return;
    const hasData = this.session && this.session.items.some((it) => it.sets.some((s) => s.reps !== ""));
    if (hasData && !confirm("Switch day? Logged sets in this session will be cleared.")) return;
    this.startSession(split);
  },

  markRest() { Store.logRestDay(); this.renderChips(); this.renderToday(); },
  undoRest() {
    Store.state.restDays = Store.state.restDays.filter((d) => d !== todayISO());
    Store.save(); this.renderChips(); this.renderToday();
  },

  sessionCard() {
    const split = this.session.split;
    const rec = Engine.recommendSplit();
    let html = `<div class="card">
      <div class="focus-banner">
        <div><div class="ft">${SPLITS[split].label}</div><div class="fs">${SPLITS[split].focus} · + smart extras</div></div>
        <span class="pill" style="background:${SPLITS[split].accent}">Dynamic plan</span>
      </div>
      <div class="split-switch">
        ${SPLIT_ROTATION.map((s) => `<button class="seg ${s === split ? "active" : ""}" onclick="App.switchSplit('${s}')" title="${s === rec ? "Suggested — most rested" : ""}">${SPLITS[s].label.replace(" Day", "")}${s === rec ? " ★" : ""}</button>`).join("")}
      </div>`;

    let extrasStarted = false;
    this.session.items.forEach((it, i) => {
      if (it.kind === "extra" && !extrasStarted) {
        extrasStarted = true;
        html += `<div class="section-split">
          <span>Extra / accessory work</span>
          <small>Smart picks from your lagging muscles — swap, remove, or add your own</small>
        </div>`;
      }
      html += this.itemCard(it, i);
    });

    html += `<div class="add-extra-wrap">
        <select class="add-extra" onchange="App.addExtra(this.value); this.value='';">
          <option value="">＋ Add another exercise (bench, biceps, anything)…</option>
          ${this.extraOptionsHTML()}
        </select>
      </div>
      <button class="btn wide" onclick="App.finishSession()">Finish &amp; save workout</button>
      <button class="btn ghost wide" style="margin-top:10px" onclick="App.cancelSession()">Cancel</button>
    </div>`;
    return html;
  },

  itemCard(it, i) {
    const ex = EXERCISES[it.selected];
    const done = it.sets.some((s) => s.reps !== "");
    const priority = Engine.isEmphasized(ex.muscle);
    const removeBtn = it.kind === "extra"
      ? `<button class="icon-btn" title="Remove" onclick="App.removeExtra(${i})">✕</button>` : "";
    return `<div class="slot ${done ? "done" : ""} ${it.kind === "extra" ? "extra" : ""}">
        <div class="slot-head">
          <div>
            <div class="slot-name">${it.slotName} · ${it.reps} reps · ${it.targetSets} sets ${priority ? '<span class="prio">★ priority</span>' : ""}</div>
            <div class="ex-name">${ex.name}</div>
            <div class="ex-meta">${ex.muscle} · ${ex.equip}</div>
            <div class="ex-tip">💡 ${ex.tip}</div>
          </div>
          <div class="slot-actions">
            <button class="swap" onclick="App.swap(${i})">⇄ Swap</button>
            ${removeBtn}
          </div>
        </div>
        <div class="hint">${Engine.overloadHint(it.selected)}</div>
        <div class="sets" id="sets-${i}">${this.setRows(i)}</div>
        <button class="add-set" onclick="App.addSet(${i})">＋ Add set</button>
      </div>`;
  },

  extraOptionsHTML() {
    return Object.entries(MUSCLE_GROUPS).map(([group, ids]) =>
      `<optgroup label="${group}">${ids.map((id) =>
        `<option value="${id}">${EXERCISES[id].name}</option>`).join("")}</optgroup>`
    ).join("");
  },

  setRows(i) {
    return this.session.items[i].sets.map((s, j) => `
      <div class="set-row">
        <span class="n">${j + 1}</span>
        <input type="number" inputmode="numeric" placeholder="reps" value="${s.reps}"
          oninput="App.updateSet(${i},${j},'reps',this.value)">
        <input type="number" inputmode="decimal" placeholder="kg" value="${s.weight}"
          oninput="App.updateSet(${i},${j},'weight',this.value)">
        <button class="icon-btn" onclick="App.removeSet(${i},${j})">✕</button>
      </div>`).join("");
  },

  swap(i) {
    const it = this.session.items[i];
    const cur = it.options.indexOf(it.selected);
    it.selected = it.options[(cur + 1) % it.options.length];
    this.renderToday();
  },
  addExtra(exId) {
    if (!exId) return;
    const group = groupOf(exId);
    this.session.items.push({
      kind: "extra",
      slotName: `${group} · extra`,
      targetSets: 3,
      reps: "8–12",
      options: MUSCLE_GROUPS[group],
      selected: exId,
      sets: [{ reps: "", weight: "" }],
    });
    this.renderToday();
  },
  removeExtra(i) { this.session.items.splice(i, 1); this.renderToday(); },
  addSet(i) { this.session.items[i].sets.push({ reps: "", weight: "" }); this.refreshSets(i); },
  removeSet(i, j) {
    if (this.session.items[i].sets.length > 1) this.session.items[i].sets.splice(j, 1);
    this.renderToday();
  },
  updateSet(i, j, k, v) { this.session.items[i].sets[j][k] = v; },
  refreshSets(i) { document.getElementById(`sets-${i}`).innerHTML = this.setRows(i); },

  cancelSession() { this.session = null; this.renderToday(); },

  finishSession() {
    const exercises = [];
    let volume = 0;
    this.session.items.forEach((it) => {
      const sets = it.sets
        .filter((s) => s.reps !== "")
        .map((s) => ({ reps: +s.reps || 0, weight: +s.weight || 0 }));
      if (!sets.length) return;
      const ex = EXERCISES[it.selected];
      sets.forEach((s) => (volume += s.reps * s.weight));
      exercises.push({ id: it.selected, name: ex.name, muscle: ex.muscle, sets });
    });
    if (!exercises.length) { alert("Log at least one set before finishing."); return; }
    const date = this.session.editing ? this.session.origDate : todayISO();
    if (this.session.editing) Store.state.workoutLog = Store.state.workoutLog.filter((w) => w.date !== date);
    Store.logWorkout({ date, split: this.session.split, exercises, volume });
    this.session = null;
    this.renderChips();
    this.renderToday();
  },

  /* ---------------- PROGRESS ---------------- */
  renderProgress() {
    const el = document.getElementById("view-progress");
    const t = Engine.weightTrend();
    const arrow = t.dir === "up" ? "▲" : t.dir === "down" ? "▼" : "▬";
    el.innerHTML = `
      <div class="card">
        <h2>Weight journey</h2>
        <div class="sub">Current ${Store.latestWeight()} kg · ${arrow} ${Math.abs(t.delta)} kg since start · target ${Store.state.profile.targetWeightKg} kg</div>
        <div id="weight-chart"></div>
        <div class="food-add" style="margin-top:14px">
          <input type="number" id="w-input" class="small" inputmode="decimal" placeholder="kg" value="${Store.latestWeight()}">
          <button class="btn" onclick="App.saveWeight()">Log today's weight</button>
        </div>
      </div>
      <div class="card">
        <h2>Your numbers</h2>
        <div class="sub">Consistency drives the aesthetic physique</div>
        <div class="stat-grid">
          <div class="stat"><div class="v">${Engine.streak()}<span> days</span></div><div class="l">Current streak</div></div>
          <div class="stat"><div class="v">${Engine.weeklyFrequency()}<span>/wk</span></div><div class="l">Sessions this week</div></div>
          <div class="stat"><div class="v">${Engine.totalWorkouts()}</div><div class="l">Total workouts</div></div>
        </div>
      </div>
      <div class="card">
        <h2>Muscle balance</h2>
        <div class="sub">Sets per split · last 4 weeks</div>
        <div id="balance"></div>
      </div>
      <div class="card"><h2>Coach's read</h2>
        <ul class="guide">${Engine.guidance().map((m) => `<li>${m}</li>`).join("")}</ul>
      </div>`;
    Charts.weightLine(document.getElementById("weight-chart"), Store.state.weightLog, Store.state.profile.targetWeightKg);
    Charts.bars(document.getElementById("balance"), Engine.muscleBalance());
  },

  saveWeight() {
    const v = parseFloat(document.getElementById("w-input").value);
    if (!v || v < 30 || v > 250) { alert("Enter a valid weight in kg."); return; }
    Store.logWeight(v);
    this.renderChips();
    this.renderProgress();
  },

  // diet-safe example text — never suggest non-veg foods to veg/vegan users
  dietExample(kind) {
    const d = Store.state.profile.diet || "nonveg";
    const plan = {
      vegan: "South Indian, high protein, tofu & chana",
      veg: "Bengali, high protein, paneer & dal",
      egg: "high protein, eggs, paneer & dal",
      nonveg: "Bengali, high protein, chicken & paneer",
    };
    const meal = {
      vegan: "2 rotis, a bowl of dal, tofu curry, tea",
      veg: "2 rotis, a bowl of dal, paneer curry, curd",
      egg: "2 rotis, dal, 2 boiled eggs, tea",
      nonveg: "2 rotis, a bowl of dal, chicken curry, tea",
    };
    return (kind === "plan" ? plan : meal)[d] || (kind === "plan" ? plan.veg : meal.veg);
  },

  /* ---------------- NUTRITION ---------------- */
  renderNutrition() {
    const el = document.getElementById("view-nutrition");
    const s = Engine.stats();
    const p = Store.state.profile;
    const day = Store.foodOn(todayISO());
    const eaten = day.items.reduce((n, i) => n + (i.kcal || 0), 0);
    const protein = day.items.reduce((n, i) => n + (i.protein || 0), 0);
    const calPct = Math.min(100, Math.round((eaten / s.calTarget) * 100));
    const proPct = Math.min(100, Math.round((protein / s.proteinG) * 100));
    const est = this.foodEstimate;
    const diet = p.diet || "nonveg";
    const slot = MEAL_SLOTS.includes(this.mealSlot) ? this.mealSlot : (this.mealSlot = this.mealSlotForNow());
    const nowSlot = this.mealSlotForNow();
    const mealSel = this.ensurePicks(slot);
    const tp = this.timePeriod();
    const balance = s.calAdj > 0 ? `+${s.calAdj} kcal surplus` : s.calAdj < 0 ? `${s.calAdj} kcal deficit` : "maintenance";
    el.innerHTML = `
      <section class="card">
        <div class="card-head"><h2>Today's targets</h2><span class="tag">${s.physName}</span></div>
        <div class="sub">${DIETS[diet]} diet · ${balance} for your goal</div>
        <div class="rings">
          <div class="ring"><div class="ring-v">${eaten}<small>/${s.calTarget}</small></div><div class="ring-l">calories</div>
            <div class="ring-bar"><span style="width:${calPct}%;background:var(--accent)"></span></div></div>
          <div class="ring"><div class="ring-v">${protein}<small>/${s.proteinG}g</small></div><div class="ring-l">protein</div>
            <div class="ring-bar"><span style="width:${proPct}%;background:var(--green)"></span></div></div>
          <div class="ring"><div class="ring-v">${s.carbG}<small>g</small></div><div class="ring-l">carbs target</div></div>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h2>Plan my day</h2><span class="tag">${DIETS[diet]}</span></div>
        <div class="sub">Tell me what you feel like — a cuisine, foods, or "high protein" — and I'll build breakfast, lunch, snack &amp; dinner for your ${s.calTarget} kcal / ${s.proteinG}g goal.</div>
        <textarea id="plan-text" class="food-text" rows="2" placeholder='e.g. "${this.dietExample("plan")}"'>${esc(this.planText || "")}</textarea>
        <button class="btn wide" onclick="App.generatePlan()">Generate my menu</button>
        ${this.dayPlan ? this.renderPlan() : ""}
      </section>

      <section class="card">
        <div class="card-head"><h2>Log a meal</h2></div>
        <div class="sub">Just say what you ate — I'll estimate the calories &amp; protein for you. No numbers needed.</div>
        <textarea id="f-text" class="food-text" rows="2" placeholder='e.g. "${this.dietExample("meal")}"'></textarea>
        <div class="food-actions">
          <label class="photo-btn">📷 Add photo
            <input type="file" accept="image/*" capture="environment" id="f-photo" onchange="App.onPhoto(event)" hidden>
          </label>
          <button class="btn" onclick="App.estimateFood()">Estimate</button>
        </div>
        ${this.pendingPhoto ? `<div class="photo-preview"><img src="${this.pendingPhoto}" alt="meal"><button class="icon-btn" onclick="App.clearPhoto()">✕</button></div>` : ""}
        ${est ? this.estimatePreview(est) : ""}
      </section>

      <section class="card">
        <div class="card-head"><h2>What do you feel like eating?</h2>
          <div class="diet-toggle">
            ${Object.keys(DIETS).map((d) => `<button class="${d === diet ? "active" : ""}" onclick="App.setDiet('${d}')">${DIETS[d]}</button>`).join("")}
          </div>
        </div>
        <div class="sub">${tp.icon} It's ${tp.label.toLowerCase()} — ${DIETS[diet].toLowerCase()} ${slot.toLowerCase()} ideas. Tap ⇄ for an alternative, ＋ to log.</div>
        <div class="cuisine-row">
          ${MEAL_SLOTS.map((sl) => `<button class="cuisine-chip ${sl === slot ? "active" : ""}" onclick="App.setMealSlot('${sl}')">${sl}${sl === nowSlot ? " • now" : ""}</button>`).join("")}
        </div>
        <div class="meal-grid">
          ${mealSel.picks.map((poolIdx, pos) => { const m = mealSel.pool[poolIdx]; return `
            <div class="meal-idea">
              <div class="mi-body"><div class="mi-name">${esc(m.name)}</div>
                <div class="mi-macros">${m.kcal} kcal · ${m.protein}g · <span class="mi-diet ${m.diet}">${m.diet}</span></div></div>
              <div class="mi-actions">
                <button class="mi-swap" title="Show an alternative" onclick="App.swapMeal('${slot}',${pos})">⇄</button>
                <button class="mi-add" title="Log this" onclick="App.logSlotMeal('${slot}',${pos})">＋</button>
              </div>
            </div>`; }).join("")}
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h2>Today's food</h2>${day.items.length ? `<span class="tag">${eaten} kcal · ${protein}g</span>` : ""}</div>
        <div class="food-log">${this.foodList(day)}</div>
      </section>`;
  },

  estimatePreview(est) {
    const tags = est.items.map((i) =>
      `<span class="food-tag">${i.qty > 1 ? i.qty + "× " : ""}${esc(i.name)} · ${i.kcal}kcal · ${i.protein}g</span>`).join("");
    const unk = est.unknown.length
      ? `<div class="est-unknown">⚠️ Couldn't identify: ${esc(est.unknown.join(", "))}. Adjust totals below if needed.</div>` : "";
    return `<div class="estimate">
      <div class="est-top">
        <div class="est-tile"><div class="est-v">~${est.kcal}</div><div class="est-l">calories</div></div>
        <div class="est-tile"><div class="est-v">${est.protein}g</div><div class="est-l">protein</div></div>
      </div>
      <div class="est-note">Our estimate from your description. Detected:</div>
      <div class="est-tags">${tags || '<span class="food-tag">No known foods detected — enter totals below</span>'}</div>
      ${unk}
      <div class="est-edit">
        <label>Calories <input type="number" id="e-kcal" value="${est.kcal}"></label>
        <label>Protein (g) <input type="number" id="e-pro" value="${est.protein}"></label>
      </div>
      <button class="btn wide" onclick="App.logEstimated()">✓ Log this meal</button>
    </div>`;
  },

  setDiet(d) { Store.state.profile.diet = d; Store.save(); this.renderNutrition(); },
  quickSetDiet(d) { Store.state.profile.diet = d; Store.save(); },
  setCuisine(c) { this.cuisine = c; this.renderNutrition(); },
  logCuisineMeal(c, idx) {
    const m = CUISINES[c] && CUISINES[c].meals[idx];
    if (!m) return;
    Store.logFood({ text: m.name, kcal: m.kcal, protein: m.protein, estimated: true });
    this.renderNutrition();
  },

  // ---- full-day meal plan ----
  generatePlan() {
    const el = document.getElementById("plan-text");
    if (el) this.planText = el.value;
    this.planSeed = (this.planSeed || 0) + 1;
    this.dayPlan = MealPlanner.generate(this.planText, Store.state.profile.diet || "nonveg", Engine.stats(), this.planSeed);
    this.renderNutrition();
  },
  renderPlan() {
    const p = this.dayPlan;
    const s = Engine.stats();
    const rows = p.plan.map((x) => `
      <div class="plan-row">
        <div class="plan-slot">${x.slot}</div>
        <div class="plan-meal"><div class="pm-name">${esc(x.meal.name)}${x.meal.portion && x.meal.portion !== 1 ? ` <span class="pm-portion">×${x.meal.portion}</span>` : ""}</div>
          <div class="pm-macros">${x.meal.kcal} kcal · ${x.meal.protein}g · <span class="mi-diet ${x.meal.diet}">${x.meal.diet}</span></div></div>
        <button class="mi-add" title="Log ${x.slot}" onclick="App.logPlanMeal('${x.slot}')">＋</button>
      </div>`).join("");
    const addonRows = (p.addons || []).map((a) => `
      <div class="plan-row addon">
        <div class="plan-slot">＋</div>
        <div class="plan-meal"><div class="pm-name">${esc(a.name)} <span class="pm-portion">top-up</span></div>
          <div class="pm-macros">${a.kcal} kcal · ${a.protein}g</div></div>
      </div>`).join("");
    const pPct = Math.round((p.totalP / s.proteinG) * 100);
    const kPct = Math.round((p.totalK / s.calTarget) * 100);
    return `<div class="day-plan">
      ${rows}${addonRows}
      <div class="plan-total">
        <span>Day total</span>
        <span><b>${p.totalK}</b> kcal (${kPct}%) · <b>${p.totalP}g</b> protein (${pPct}%) <small>· goal ${s.calTarget} / ${s.proteinG}g</small></span>
      </div>
      <div class="plan-actions">
        <button class="btn ghost" onclick="App.generatePlan()">↻ Regenerate</button>
        <button class="btn" onclick="App.logWholeDay()">Log whole day</button>
      </div>
    </div>`;
  },
  logPlanMeal(slot) {
    const x = this.dayPlan && this.dayPlan.plan.find((p) => p.slot === slot);
    if (!x) return;
    Store.logFood({ text: `${x.slot}: ${x.meal.name}`, kcal: x.meal.kcal, protein: x.meal.protein, estimated: true });
    this.renderNutrition();
  },
  logWholeDay() {
    if (!this.dayPlan) return;
    for (const x of this.dayPlan.plan)
      Store.logFood({ text: `${x.slot}: ${x.meal.name}${x.meal.portion && x.meal.portion !== 1 ? ` (×${x.meal.portion})` : ""}`, kcal: x.meal.kcal, protein: x.meal.protein, estimated: true });
    for (const a of (this.dayPlan.addons || []))
      Store.logFood({ text: `Add-on: ${a.name}`, kcal: a.kcal, protein: a.protein, estimated: true });
    this.dayPlan = null;
    this.renderNutrition();
  },

  // ---- time-based meal tabs + alternatives ----
  mealSlotForNow() {
    const h = new Date().getHours();
    if (h < 11) return "Breakfast";
    if (h < 16) return "Lunch";
    if (h < 19) return "Snack";
    return "Dinner";
  },
  setMealSlot(sl) { this.mealSlot = sl; this.renderNutrition(); },
  mealPool(slot) {
    return MEAL_LIBRARY[slot].filter((m) => dietAllows(m.diet, Store.state.profile.diet || "nonveg"));
  },
  ensurePicks(slot) {
    const pool = this.mealPool(slot);
    if (!this.mealPicks) this.mealPicks = {};
    let picks = this.mealPicks[slot];
    const n = Math.min(3, pool.length);
    if (!picks || picks.some((i) => i >= pool.length) || picks.length !== n) {
      picks = [];
      for (let i = 0; i < n; i++) picks.push(i);
      this.mealPicks[slot] = picks;
    }
    return { pool, picks };
  },
  swapMeal(slot, pos) {
    const { pool, picks } = this.ensurePicks(slot);
    if (pool.length <= picks.length) return; // no spare alternatives
    let next = (picks[pos] + 1) % pool.length;
    while (picks.includes(next)) next = (next + 1) % pool.length;
    picks[pos] = next;
    this.renderNutrition();
  },
  logSlotMeal(slot, pos) {
    const { pool, picks } = this.ensurePicks(slot);
    const m = pool[picks[pos]];
    if (!m) return;
    Store.logFood({ text: `${slot}: ${m.name}`, kcal: m.kcal, protein: m.protein, estimated: true });
    this.renderNutrition();
  },

  // ---- day/night theme + moon phase ----
  timePeriod(date = new Date()) {
    const h = date.getHours();
    if (h >= 5 && h < 11) return { key: "dawn", label: "Morning", icon: "🌅", greet: "Good morning" };
    if (h >= 11 && h < 17) return { key: "day", label: "Day", icon: "☀️", greet: "Good afternoon" };
    if (h >= 17 && h < 20) return { key: "dusk", label: "Evening", icon: "🌇", greet: "Good evening" };
    return { key: "night", label: "Night", icon: "🌙", greet: "Good evening" };
  },
  moonPhase(date = new Date()) {
    const syn = 29.530588853;                       // synodic month (days)
    const knownNew = Date.UTC(2000, 0, 6, 18, 14) / 86400000;
    const now = date.getTime() / 86400000;
    const age = (((now - knownNew) % syn) + syn) % syn;
    const phases = [
      { n: "New Moon", i: "🌑" }, { n: "Waxing Crescent", i: "🌒" }, { n: "First Quarter", i: "🌓" },
      { n: "Waxing Gibbous", i: "🌔" }, { n: "Full Moon", i: "🌕" }, { n: "Waning Gibbous", i: "🌖" },
      { n: "Last Quarter", i: "🌗" }, { n: "Waning Crescent", i: "🌘" },
    ];
    const idx = Math.floor((age / syn) * 8 + 0.5) % 8;
    return { ...phases[idx], age: Math.round(age) };
  },
  applySky() {
    const t = this.timePeriod();
    document.documentElement.dataset.time = t.key;
    const chip = document.getElementById("sky-chip");
    if (!chip) return;
    if (t.key === "night" || t.key === "dusk") {
      const m = this.moonPhase();
      chip.textContent = `${m.i} ${m.n}`;
      chip.title = `${t.label} · moon age ${m.age}d`;
    } else {
      chip.textContent = `${t.icon} ${t.label}`;
      chip.title = t.label;
    }
  },

  onPhoto(ev) {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 240, scale = Math.min(1, max / Math.max(img.width, img.height));
        const cv = document.createElement("canvas");
        cv.width = img.width * scale; cv.height = img.height * scale;
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        this.pendingPhoto = cv.toDataURL("image/jpeg", 0.6);
        this.renderNutrition();
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  },
  clearPhoto() { this.pendingPhoto = null; this.renderNutrition(); },

  estimateFood() {
    const text = document.getElementById("f-text").value.trim();
    if (!text && !this.pendingPhoto) { alert("Describe what you ate (or add a photo + note)."); return; }
    this.foodEstimate = FoodEstimator.parse(text);
    this.foodEstimate.text = text || "Photo meal";
    this.renderNutrition();
  },

  logEstimated() {
    const est = this.foodEstimate;
    if (!est) return;
    const kcal = parseInt(document.getElementById("e-kcal").value) || est.kcal;
    const protein = parseInt(document.getElementById("e-pro").value) || est.protein;
    Store.logFood({ text: est.text, kcal, protein, photo: this.pendingPhoto || null, estimated: true });
    this.foodEstimate = null;
    this.pendingPhoto = null;
    this.renderNutrition();
  },

  foodList(day) {
    if (!day.items.length) return `<div class="chart-empty">No meals logged yet today. Describe your first meal above 👆</div>`;
    return day.items.map((it, i) => `
      <div class="meal-log">
        ${it.photo ? `<img class="food-thumb" src="${it.photo}" alt="meal">` : `<div class="food-ic">🍽️</div>`}
        <div class="ml-body">
          <div class="ml-title">${esc(it.text)}</div>
          <div class="ml-macros">
            <span class="chip-k">${it.kcal || 0} kcal</span>
            <span class="chip-p">${it.protein || 0}g protein</span>
            ${it.estimated ? '<span class="chip-e" title="Estimated by the app from your description">est.</span>' : ""}
          </div>
        </div>
        <button class="icon-btn" onclick="App.removeFood(${i})">✕</button>
      </div>`).join("");
  },

  removeFood(i) { Store.removeFood(todayISO(), i); this.renderNutrition(); },

  /* ---------------- PROFILE ---------------- */
  renderProfile() {
    const el = document.getElementById("view-profile");
    const p = Store.state.profile;
    const s = Engine.stats();
    const u = Auth.currentUser() || {};
    const cloudOn = typeof Cloud !== "undefined" && Cloud.active();
    const myPosts = cloudOn ? Social.cloud.feed.filter((x) => x.author === Cloud.me) : Social.feed().filter((x) => x.author === "me");
    el.innerHTML = `
      <div class="card profile-hero">
        <div class="ph-cover"></div>
        <div class="ph-main">
          <label class="ph-avatar" title="Change photo">
            ${Social.avatar(Social.me(), 92)}
            <span class="ph-cam">📷</span>
            <input type="file" accept="image/*" onchange="App.uploadAvatar(event)" hidden>
          </label>
          <div class="ph-id">
            <div class="ph-name">${esc(p.name || "User")} <span class="lvl">${esc(Social.me().level)}</span></div>
            <div class="ph-handle">@${esc(p.username || (u.email || "you").split("@")[0])}${u.provider === "google" ? " · via Google" : ""}</div>
          </div>
          <button class="btn ghost sm ph-logout" onclick="App.logout()">Log out</button>
        </div>
        <div class="ph-stats">
          <div><b>${cloudOn ? (Social.cloud.connections || []).length : Social.crewList().length}</b><span>Crew</span></div>
          <div><b>${myPosts.length}</b><span>Posts</span></div>
          <div><b>${Engine.streak()}</b><span>Streak</span></div>
          <div><b>${s.calTarget}</b><span>Target kcal</span></div>
        </div>
        <div class="ph-bio-field field"><label>Username <span class="inline-hint">(your unique @handle)</span></label>
          <input id="p-username" maxlength="20" value="${esc(p.username || "")}" placeholder="e.g. arindam.fit">
        </div>
        <div class="ph-bio-field field"><label>Bio</label>
          <input id="p-bio" maxlength="120" placeholder="Add a short bio — e.g. Lean-bulk szn · chasing the shelf" value="${esc(p.bio || "")}">
        </div>
        <div class="ph-bio-field field"><label>Who can see your profile &amp; posts</label>
          <select id="p-privacy">
            <option value="public" ${(p.privacy || "public") === "public" ? "selected" : ""}>🌍 Public — anyone on Formora</option>
            <option value="friends" ${p.privacy === "friends" ? "selected" : ""}>👥 Friends only — just your crew</option>
          </select>
        </div>
        <div class="ph-socials">
          <div class="soc"><span class="soc-ic ig">📷</span><input id="soc-ig" placeholder="Instagram username" value="${esc((p.socials && p.socials.instagram) || "")}"></div>
          <div class="soc"><span class="soc-ic li">in</span><input id="soc-li" placeholder="LinkedIn profile URL" value="${esc((p.socials && p.socials.linkedin) || "")}"></div>
          <div class="soc"><span class="soc-ic fb">f</span><input id="soc-fb" placeholder="Facebook profile URL" value="${esc((p.socials && p.socials.facebook) || "")}"></div>
        </div>
        <div class="ph-actions">
          <button class="btn" onclick="App.saveSocialProfile()">Save profile</button>
          <button class="btn ghost" onclick="App.goTab('feed')">Open Feed →</button>
        </div>
        <div class="sub">Real LinkedIn/Facebook sign-in can be wired later (needs app setup) — for now these are your public links.</div>
      </div>
      ${myPosts.length ? `<div class="card"><div class="card-head"><h2>Your posts</h2><span class="tag">${myPosts.length}</span></div>${myPosts.map((x) => Social.postCard(cloudOn ? Social._cloudPost(x) : x)).join("")}</div>` : ""}
      <div class="card">
        <h2>Your fitness dashboard</h2>
        <div class="sub">Auto-calculated from your profile, workouts &amp; latest weight</div>
        <div class="stat-grid">
          <div class="stat"><div class="v">${Store.latestWeight()}<small>kg</small></div><div class="l">${p.targetWeightKg ? "Goal " + p.targetWeightKg + "kg" : "Current weight"}</div></div>
          <div class="stat"><div class="v">${s.bmi}</div><div class="l">BMI · ${s.bmiClass}</div></div>
          <div class="stat"><div class="v">${Engine.streak()}</div><div class="l">Day streak 🔥</div></div>
          <div class="stat"><div class="v">${(Store.state.workoutLog || []).length}</div><div class="l">Workouts logged</div></div>
          <div class="stat"><div class="v">${s.proteinG}<small>g</small></div><div class="l">Protein / day</div></div>
          <div class="stat"><div class="v">${s.calTarget}</div><div class="l">Target kcal</div></div>
          <div class="stat"><div class="v">${s.bmr}</div><div class="l">BMR kcal</div></div>
          <div class="stat"><div class="v">${s.tdee}</div><div class="l">TDEE kcal</div></div>
        </div>
      </div>
      <div class="card">
        <h2>Target physique</h2>
        <div class="sub">The look you're training for — your plan &amp; nutrition adapt to this</div>
        <div class="phys-current">
          <div class="phys-fig-mini">${this.physiqueFigure(Engine.getPhysique().fig)}</div>
          <div>
            <div class="phys-name">${Engine.getPhysique().name}</div>
            <div class="phys-tag">${Engine.getPhysique().tagline} · ${p.gender === "female" ? "Women" : "Men"}</div>
            <div class="phys-desc">${Engine.getPhysique().desc}</div>
          </div>
        </div>
        <button class="btn wide" style="margin-top:14px" onclick="App.openPhysiquePicker()">Change my target look</button>
      </div>
      <div class="card">
        <h2>Profile</h2>
        <div class="sub">Update anytime — targets recalculate instantly</div>
        <div class="form-grid">
          <div class="field"><label>Name</label><input id="p-name" value="${esc(p.name)}"></div>
          <div class="field"><label>Date of birth</label><input id="p-dob" type="date" value="${p.dob}"></div>
          <div class="field"><label>Height (cm)</label><input id="p-h" type="number" value="${p.heightCm}"></div>
          <div class="field"><label>Target weight (kg)</label><input id="p-tw" type="number" value="${p.targetWeightKg}"></div>
          <div class="field"><label>Gender</label>
            <select id="p-gender">
              <option value="male" ${p.gender === "male" ? "selected" : ""}>Male</option>
              <option value="female" ${p.gender === "female" ? "selected" : ""}>Female</option>
            </select>
          </div>
          <div class="field"><label>Diet <span class="inline-hint">(applies instantly)</span></label>
            <select id="p-diet" onchange="App.quickSetDiet(this.value)">
              ${Object.keys(DIETS).map((d) => `<option value="${d}" ${(p.diet || "nonveg") === d ? "selected" : ""}>${DIETS[d]}</option>`).join("")}
            </select>
          </div>
          <div class="field"><label>Activity level</label>
            <select id="p-act">
              <option value="1.375" ${p.activityFactor == 1.375 ? "selected" : ""}>Light (1–2 days)</option>
              <option value="1.55" ${p.activityFactor == 1.55 ? "selected" : ""}>Moderate (3–5 days)</option>
              <option value="1.725" ${p.activityFactor == 1.725 ? "selected" : ""}>High (6–7 days)</option>
            </select>
          </div>
        </div>
        <button class="btn wide" style="margin-top:14px" onclick="App.saveProfile()">Save profile</button>
      </div>
      <div class="card">
        <h2>Backup &amp; move devices</h2>
        <div class="sub">Your data now syncs across devices automatically — just log in with the same account (Google works on any device). This download is an extra offline copy.</div>
        <button class="btn wide" onclick="App.exportData()">⬇️ Download my backup</button>
        <label class="photo-btn" style="margin-top:10px">📂 Restore from a backup file
          <input type="file" accept="application/json,.json" onchange="App.importFile(event)" hidden>
        </label>
      </div>
      <div class="card">
        <h2 class="danger">Reset</h2>
        <div class="sub">Erase all logs and start fresh. This cannot be undone.</div>
        <button class="btn ghost wide" onclick="App.resetAll()">Reset all data</button>
      </div>`;
  },

  // give every member a unique @handle (unique vs the demo crew; global uniqueness needs the backend)
  async ensureUsername() {
    const p = Store.state.profile;
    if (p.username) return;
    const base = ((p.email || p.name || "user").split("@")[0] || "user").toLowerCase().replace(/[^a-z0-9._]/g, "").slice(0, 18) || "user";
    const taken = new Set(SOCIAL_PERSONAS.map((x) => x.handle.toLowerCase()));
    let u = base, n = 1;
    while (taken.has(u)) u = base + (++n);
    p.username = u; Store.save();                 // set immediately so login never blocks
    if (typeof Cloud !== "undefined" && Cloud.active()) {   // refine for global uniqueness in the background
      let guard = 0;
      while ((await Cloud.usernameTaken(u)) && guard++ < 25) u = base + (++n);
      if (u !== p.username) { p.username = u; Store.save(); Cloud.registerMe(p); }
    }
  },
  toast(msg) {
    let t = document.getElementById("toast");
    if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("show");
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => t.classList.remove("show"), 2200);
  },
  // connect the shared backend when configured (no-op otherwise)
  initCloud(u) {
    if (typeof Cloud === "undefined" || !Cloud.active()) return;
    Cloud.init(u, Store.state.profile);
    let last = "";
    Cloud.start((s) => {
      Social.cloud.users = Object.values(s.users || {}).filter((x) => x.uid !== Cloud.me);
      Social.cloud.requests = Object.values(s.requests || {}).filter((r) => r.to === Cloud.me && r.status === "pending");
      Social.cloud.sent = Object.values(s.requests || {}).filter((r) => r.from === Cloud.me).map((r) => r.to);
      Social.cloud.connections = Object.values(s.requests || {}).filter((r) => r.status === "accepted" && (r.from === Cloud.me || r.to === Cloud.me)).map((r) => (r.from === Cloud.me ? r.to : r.from));
      Social.cloud.feed = Object.values(s.posts || {}).sort((a, b) => (b.ts || 0) - (a.ts || 0));
      Social.cloud.comments = Object.values(s.comments || {});
      Social.cloud.stories = Object.values(s.stories || {}).sort((a, b) => (a.ts || 0) - (b.ts || 0));
      this.pollNotifs();
      if (Social.sub === "chat" && Social._dmWith) Social.refreshDM();
      const sig = JSON.stringify(s);
      if (sig === last) return;
      last = sig;
      const v = document.getElementById("view-feed");
      if (v && v.classList.contains("active")) Social.render();
    });
    Cloud.setPaused(false);
    this.pollNotifs();
  },
  async pollNotifs() {
    if (typeof Cloud === "undefined" || !Cloud.active()) return;
    const list = await Cloud.getNotifications();
    Social.cloud.notifs = list || [];
    const unread = (list || []).filter((n) => !n.read).length;
    if (this.curTab === "alerts") { this.renderNotifPanel(); this.updateNotifBadge(0); if (Cloud.markNotifsRead) Cloud.markNotifsRead(); }
    else this.updateNotifBadge(unread);
  },
  updateNotifBadge(n) {
    const b = document.getElementById("tab-notif-badge");
    if (!b) return;
    b.textContent = n > 9 ? "9+" : String(n);
    b.style.display = n > 0 ? "flex" : "none";
    const tab = document.querySelector('.tab[data-tab="alerts"]');
    if (tab && n > (this._lastUnread || 0)) { tab.classList.remove("shake"); void tab.offsetWidth; tab.classList.add("shake"); }
    this._lastUnread = n;
  },
  notifText(n) {
    const who = (Social.cloudUser(n.actor) || {}).name || "Someone";
    const map = { like: "❤️ liked your post", comment: "💬 commented on your post", reply: "↩️ replied to you", mention: "@ mentioned you", connect: "🤝 wants to connect", accept: "✅ accepted your request", reshare: "🔁 reshared your post", message: "✉️ sent you a message" };
    return `<b>${esc(who)}</b> ${map[n.type] || esc(n.type)}${n.body ? ` — “${esc((n.body || "").slice(0, 40))}”` : ""}`;
  },
  renderNotifPanel() {
    const list = Social.cloud.notifs || [];
    const body = list.length ? list.map((n) => `<div class="notif-item ${n.read ? "" : "unread"}" onclick="App.openNotif('${n.actor}','${n.type}')">${Social.avatar(Social.cloudUser(n.actor) || { name: "?", colors: ["#8b93a7", "#262c3a"] }, 38)}<div class="notif-txt">${this.notifText(n)}<div class="notif-time">${Social.timeAgo(n.ts)}</div></div></div>`).join("") : `<div class="sub" style="padding:28px;text-align:center">No activity yet. Likes, comments and new connections show up here 🔔</div>`;
    const el = document.getElementById("notif-list");
    if (el) el.innerHTML = body;
  },
  openNotif(actor, type) {
    if (type === "connect" || type === "accept") { this.selectTab("search"); }
    else if (type === "message" && actor) { Social.openDM(actor); }
    else if (actor) { Social.viewProfile(actor); }
  },
  uploadAvatar(e) {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    resizeImage(f, 256, 0.85).then((data) => {
      Store.state.profile.avatar = data;
      Store.save();
      this.renderProfile();
    }).catch(() => alert("Couldn't read that image. Try another one."));
  },
  async saveSocialProfile() {
    const p = Store.state.profile;
    const bio = document.getElementById("p-bio");
    if (bio) p.bio = bio.value.trim();
    const unEl = document.getElementById("p-username");
    if (unEl) {
      const un = unEl.value.trim().toLowerCase().replace(/[^a-z0-9._]/g, "");
      if (un && un !== p.username) {
        if (SOCIAL_PERSONAS.some((x) => x.handle.toLowerCase() === un)) { alert("That username is taken — try another."); return; }
        if (typeof Cloud !== "undefined" && Cloud.active() && (await Cloud.usernameTaken(un))) { alert("@" + un + " is already taken — please pick another."); return; }
        p.username = un;
      }
    }
    const privEl = document.getElementById("p-privacy");
    if (privEl) p.privacy = privEl.value;
    p.socials = {
      instagram: (document.getElementById("soc-ig").value || "").trim(),
      linkedin: (document.getElementById("soc-li").value || "").trim(),
      facebook: (document.getElementById("soc-fb").value || "").trim(),
    };
    Store.save();
    if (typeof Cloud !== "undefined" && Cloud.active()) Cloud.registerMe(p);
    this.renderProfile();
  },

  saveProfile() {
    const p = Store.state.profile;
    p.name = document.getElementById("p-name").value.trim() || p.name;
    p.dob = document.getElementById("p-dob").value || p.dob;
    p.heightCm = parseFloat(document.getElementById("p-h").value) || p.heightCm;
    p.targetWeightKg = parseFloat(document.getElementById("p-tw").value) || p.targetWeightKg;
    const newGender = document.getElementById("p-gender").value;
    if (newGender !== p.gender) {
      p.gender = newGender;
      if (!PHYSIQUES[newGender].some((x) => x.id === p.physique)) p.physique = PHYSIQUES[newGender][0].id;
    }
    p.activityFactor = parseFloat(document.getElementById("p-act").value);
    p.diet = document.getElementById("p-diet").value;
    p.age = Math.floor(daysBetween(p.dob, todayISO()) / 365.25);
    Store.save();
    this.renderChips();
    this.renderProfile();
  },

  resetAll() {
    if (!confirm("Erase all your workouts, weight and food logs?")) return;
    Store.reset();
    this.session = null;
    this.renderChips();
    document.querySelector('.tab[data-tab="today"]').click();
  },
};

document.addEventListener("DOMContentLoaded", () => App.init());
