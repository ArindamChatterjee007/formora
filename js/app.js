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
    if (this._checkRecovery()) return;
    if (typeof SupaAuth !== "undefined" && SupaAuth.active()) {
      const s = SupaAuth.load();
      if (s && s.email) { SupaAuth.token(); Auth.supabaseSignIn({ email: s.email, name: (Auth.findByEmail(s.email) || {}).name }); this.enterApp(); }
      else this.showAuth("login");
    } else if (Auth.isLoggedIn()) this.enterApp();
    else this.showAuth("login");
  },
  // a Supabase password-reset link redirects back with #access_token=...&type=recovery
  _checkRecovery() {
    try {
      const h = location.hash || "";
      if (!/type=recovery/.test(h) || h.indexOf("access_token=") < 0) return false;
      const p = new URLSearchParams(h.replace(/^#/, ""));
      const at = p.get("access_token"); if (!at) return false;
      this._recoverTokens = { access_token: at, refresh_token: p.get("refresh_token") || "", expires_in: +(p.get("expires_in") || 3600) };
      try { history.replaceState(null, "", location.pathname + location.search); } catch (_) {}
      this.showAuth("reset");
      return true;
    } catch (_) { return false; }
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

  // ---- moderation ----
  isBanned(uid) { return !!(uid && window.BANNED_UIDS && window.BANNED_UIDS.includes(uid)); },
  // admin helper: email a user about a moderation action (needs Mailer configured + owner's fm_mod_token)
  async moderate(email, type, name, details) {
    if (typeof Mailer === "undefined" || !Mailer.active()) { console.warn("Mailer not configured — set window.EMAIL_FN_URL in config.js + localStorage fm_mod_token"); return { ok: false, skipped: true }; }
    const r = await Mailer.send(email, type || "warning", { name, details });
    if (this.toast) this.toast(r.ok ? "📧 Email sent to " + email : "Email failed — check config/token");
    return r;
  },

  // ---- in-app email verification (for a logged-in, still-unverified user) ----
  async verifyMyEmail() {
    const p = Store.state.profile; const email = p.email || "";
    if (!email) return this.toast && this.toast("No email on file for this account.");
    if (typeof Mailer === "undefined" || !Mailer.canSendCodes || !Mailer.canSendCodes()) return this.toast && this.toast("Email delivery isn't set up yet.");
    this._verifyCode = Auth.genOtp();
    let sent = false;
    try { const r = await Mailer.sendCode(email, this._verifyCode, p.name); sent = !!(r && r.sent); } catch (_) {}
    this._verifyDelivered = sent;
    const card = document.getElementById("modal-card");
    card.innerHTML = `<div class="modal-head"><h2>Verify your email</h2><button class="icon-btn" onclick="App.closeModal()">✕</button></div>
      <div style="padding:6px 2px">
        <div class="auth-sub">${sent ? `We emailed a 6-digit code to <b>${esc(email)}</b> — check your inbox (and spam).` : `Couldn't send the code right now — please try again shortly.`}</div>
        <div class="field"><input id="my-code" class="otp-input" inputmode="numeric" maxlength="6" placeholder="000000"></div>
        <button class="btn wide" onclick="App.submitMyEmailCode()">Verify</button>
      </div>`;
    document.getElementById("modal").classList.remove("hidden");
  },
  submitMyEmailCode() {
    if (!this._verifyDelivered) return this.toast && this.toast("Code wasn't delivered — tap Send again.");
    const el = document.getElementById("my-code");
    const code = el ? el.value.trim() : "";
    if (!code || code !== this._verifyCode) return this.authErr ? (this.toast && this.toast("Invalid code")) : null;
    const p = Store.state.profile; p.verified = true; Store.save();
    const acc = Auth.currentUser(); if (acc) { acc.emailVerified = true; Auth.save(); }
    if (typeof Cloud !== "undefined" && Cloud.registerMe && Cloud.me) Cloud.registerMe(p);
    this._verifyCode = null;
    this.closeModal();
    if (this.toast) this.toast("Email verified ✓");
    if (typeof Social !== "undefined" && Social.render) Social.render();
  },
  showSuspended() {
    const shell = document.getElementById("app-shell"); if (shell) shell.classList.add("hidden");
    const ov = document.getElementById("auth-overlay"); if (ov) ov.classList.remove("hidden");
    const card = document.getElementById("auth-card");
    if (card) card.innerHTML = `<div class="suspended">
      <div class="susp-ic">🚫</div>
      <h2>Account suspended</h2>
      <p>Your account has been suspended for violating Formora's community guidelines — impersonating another person.</p>
      <p class="susp-sub">If you believe this is a mistake, you can appeal by verifying your identity with our team.</p>
      <button class="btn ghost wide" onclick="App.logout()">Log out</button>
    </div>`;
  },

  /* ---------------- AUTH GATE ---------------- */
  async enterApp() {
    const u = Auth.currentUser();
    if (!u) return this.showAuth("login");
    const myUid = (typeof Cloud !== "undefined" && Cloud.uidFor) ? Cloud.uidFor(u.email) : (u.email || "").toLowerCase();
    if (this.isBanned(myUid)) return this.showSuspended();
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
    if (window.Track) { Track.identify((typeof Cloud !== "undefined" && Cloud.me) ? Cloud.me : u.id, { name: u.name || "" }); Track.event("app_opened"); }
    this.selectTab("home");
    if (this._showWelcome) { this._showWelcome = false; try { this.showWelcome(); } catch (e) {} }
  },

  applyAccount(u) {
    const p = Store.state.profile;
    if (u.name && (!p.name || p.name === DEFAULT_PROFILE.name)) p.name = u.name.split(" ")[0];
    p.email = u.email || p.email || "";
    p.phone = u.phone || p.phone || "";
    if (u.emailVerified || u.provider === "google") p.verified = true; // real email / Google → verified badge
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
    if (typeof SupaAuth !== "undefined" && SupaAuth.active()) { try { SupaAuth.logout(); } catch (_) {} }
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
    const invited = (function () { try { return !!localStorage.getItem("fm_ref"); } catch (e) { return false; } })();
    const inviteBanner = invited ? `<div style="background:linear-gradient(135deg,rgba(255,157,77,.16),rgba(255,61,127,.16));border:1px solid rgba(255,90,77,.4);border-radius:12px;padding:10px 14px;font-weight:700;font-size:13.5px;margin-bottom:14px;text-align:center">🎉 You've been invited — start free with your friend on Formora 💪</div>` : "";
    const brand = isLanding
      ? `<div class="landing-hero">
          ${inviteBanner}
          <div class="auth-brand"><svg class="auth-mark" viewBox="0 0 44 44" fill="none" aria-hidden="true"><defs><linearGradient id="lg1" x1="4" y1="4" x2="40" y2="40" gradientUnits="userSpaceOnUse"><stop stop-color="#ff9d4d"/><stop offset=".55" stop-color="#ff5a4d"/><stop offset="1" stop-color="#ff3d7f"/></linearGradient></defs><rect x="2" y="2" width="40" height="40" rx="13" fill="url(#lg1)"/><path d="M15.5 31.5V16.2c0-1.5 1.2-2.7 2.7-2.7H30" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/><path d="M15.5 22.4h10" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/><circle cx="29.6" cy="29.6" r="2.7" fill="#fff"/></svg> FORM<span>ORA</span></div>
          <h1 class="landing-h1">Build your dream physique.</h1>
          <p class="landing-sub">Adaptive daily workouts, smart meal plans and progress tracking — personalised to the exact look you want.</p>
          <div class="landing-feats">
            <span>${this.ic("dumbbell", { size: 14 })} Adaptive workouts</span><span>${this.ic("utensils", { size: 14 })} Meal planner</span>
            <span>${this.ic("chart", { size: 14 })} Streaks &amp; progress</span><span>${this.ic("target", { size: 14 })} Physique goals</span>
          </div>
          <div class="landing-sub" style="margin-top:12px;font-size:12.5px;opacity:.75">Free to start · no card needed · iPhone, Android &amp; web</div>
          <div style="margin-top:10px;font-size:12.5px"><a href="guides/" style="color:#ff9d4d;text-decoration:none;display:inline-flex;align-items:center;gap:6px">${this.ic("book", { size: 14 })} Free fitness guides →</a></div>
        </div>`
      : `<div class="auth-brand"><svg class="auth-mark" viewBox="0 0 44 44" fill="none" aria-hidden="true"><defs><linearGradient id="lg2" x1="4" y1="4" x2="40" y2="40" gradientUnits="userSpaceOnUse"><stop stop-color="#ff9d4d"/><stop offset=".55" stop-color="#ff5a4d"/><stop offset="1" stop-color="#ff3d7f"/></linearGradient></defs><rect x="2" y="2" width="40" height="40" rx="13" fill="url(#lg2)"/><path d="M15.5 31.5V16.2c0-1.5 1.2-2.7 2.7-2.7H30" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/><path d="M15.5 22.4h10" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/><circle cx="29.6" cy="29.6" r="2.7" fill="#fff"/></svg> FORM<span>ORA</span></div>
         <div class="auth-tag">Your aesthetic physique coach</div>`;
    // Web uses Google Identity Services (GSI). Native uses the SocialLogin plugin (real Google account picker).
    // Google is wired into secure Supabase Auth via id_token sign-in (see onGoogleCredential).
    const gbtn = window.Capacitor
      ? `<button class="gbtn" onclick="App.goGoogleNative()">${this.googleIcon()} Continue with Google</button>`
      : (window.GOOGLE_CLIENT_ID
        ? `<div id="gsi-btn" class="gsi-wrap"></div>`
        : `<button class="gbtn" onclick="App.goGoogle()">${this.googleIcon()} Continue with Google</button>`);
    const err = `<div class="auth-err" id="auth-err"></div>`;
    let body = "";

    if (this.authView === "login") {
      body = `${gbtn}
        ${gbtn ? `<div class="auth-or"><span>or</span></div>` : ""}
        <div class="field"><label>Email</label><input id="a-email" type="email" placeholder="you@email.com" autocomplete="email"></div>
        ${this.pwField("a-pass", "Password", "••••••••", "current-password")}
        ${err}
        <button class="btn wide" onclick="App.doLogin()">Log in</button>
        <div class="auth-switch"><a onclick="App.showAuth('forgot')">Forgot your password?</a></div>
        <div class="auth-switch">New here? <a onclick="App.showAuth('signup')">Create an account</a></div>
        <div class="auth-switch">Moving devices? <a onclick="App.restorePrompt()">Restore a backup</a></div>
        <div class="auth-legal">By using Formora you agree to our <a href="legal.html#terms" target="_blank" rel="noopener">Terms</a> &amp; <a href="legal.html#privacy" target="_blank" rel="noopener">Privacy</a>.</div>`;
    } else if (this.authView === "signup") {
      body = `${gbtn}
        ${gbtn ? `<div class="auth-or"><span>or sign up with details</span></div>` : ""}
        <div class="field"><label>Full name</label><input id="s-name" placeholder="Arindam"></div>
        <div class="field"><label>Email</label><input id="s-email" type="email" placeholder="you@email.com"></div>
        <div class="field"><label>Phone number <span class="inline-hint">(optional)</span></label><input id="s-phone" type="tel" placeholder="+91 98765 43210" autocomplete="tel"></div>
        ${this.pwField("s-pass", "Password", "min 6 characters", "new-password", true)}
        ${this.pwField("s-pass2", "Confirm password", "repeat password", "new-password")}
        ${err}
        <button class="btn wide" onclick="App.doSignupStart()">Continue →</button>
        <div class="auth-switch">Already have an account? <a onclick="App.showAuth('login')">Log in</a></div>
        <div class="auth-legal">By creating an account you agree to our <a href="legal.html#terms" target="_blank" rel="noopener">Terms</a>, <a href="legal.html#privacy" target="_blank" rel="noopener">Privacy</a> &amp; <a href="legal.html#disclaimer" target="_blank" rel="noopener">Health disclaimer</a>.</div>`;
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
          <div class="field"><label>Gym experience</label>
            <select id="d-exp">
              <option value="beginner">Beginner — new to the gym</option>
              <option value="intermediate">Intermediate — 6+ months</option>
              <option value="advanced">Advanced — 2+ years</option>
              <option value="returning">Returning after a break</option>
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
    } else if (this.authView === "forgot") {
      body = `<div class="auth-sub">Enter your account email and we'll send you a link to reset your password.</div>
        <div class="field"><label>Email</label><input id="f-email" type="email" placeholder="you@email.com" autocomplete="email"></div>
        ${err}
        <button class="btn wide" onclick="App.doForgot()">Send reset link</button>
        <div class="auth-switch"><a onclick="App.showAuth('login')">← Back to log in</a></div>`;
    } else if (this.authView === "reset") {
      body = `<div class="auth-sub">Choose a new password for your account.</div>
        ${this.pwField("r-pass", "New password", "min 6 characters", "new-password", true)}
        ${this.pwField("r-pass2", "Confirm new password", "repeat password", "new-password")}
        ${err}
        <button class="btn wide" onclick="App.doResetPassword()">Update password &amp; log in</button>
        <div class="auth-switch"><a onclick="App.showAuth('login')">← Back to log in</a></div>`;
    } else if (this.authView === "phone") {
      body = `<div class="auth-sub">Verify your phone to finish signing in</div>
        <div class="field"><label>Phone number</label><input id="p-phone" type="tel" placeholder="+91 98765 43210" value="${Auth.pending?.account?.phone || ""}"></div>
        ${err}
        <button class="btn wide" onclick="App.doSendOtp()">Send code</button>
        <div class="auth-switch"><a onclick="App.showAuth('login')">← Back</a></div>`;
    } else if (this.authView === "otp") {
      const pend = Auth.pending || {};
      const isEmail = pend.channel === "email";
      const dest = isEmail ? (pend.account && pend.account.email) || "your email" : (pend.account && pend.account.phone) || "your phone";
      const demoCode = isEmail ? (this.pendingCode || "") : (pend.otp || "");
      const sub = isEmail
        ? (demoCode ? "Enter the 6-digit code below to verify your email" : `We emailed a 6-digit code to <b>${esc(dest)}</b> — check your inbox (and spam) and enter it below.`)
        : `Enter the 6-digit code sent to <b>${esc(dest)}</b>`;
      const demoNote = isEmail
        ? `✉️ Email delivery isn't set up yet — your code is <b>${demoCode}</b>`
        : `📶 Demo mode (no SMS gateway) — your code is <b>${demoCode}</b>`;
      body = `<div class="auth-sub">${sub}</div>
        ${demoCode ? `<div class="otp-demo">${demoNote}</div>` : ""}
        <div class="field"><input id="o-code" class="otp-input" inputmode="numeric" maxlength="6" placeholder="000000"></div>
        ${err}
        <button class="btn wide" onclick="App.doVerifyOtp()">Verify &amp; continue</button>
        <div class="auth-switch">Didn't get it? <a onclick="App.doResend()">Resend code</a></div>`;
    }

    card.innerHTML = `${brand}${body}
      <div class="auth-note"><span style="display:inline-flex;align-items:center;gap:5px;justify-content:center">${this.ic("lock", { size: 12 })} ${window.SHEETS_API ? "Secure cloud login — sign in from any device." : "Private login — your data is saved on this device."}</span></div>`;
    if (window.GOOGLE_CLIENT_ID && isLanding && !window.Capacitor) this.renderGoogleButton();
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
  async onGoogleCredential(r) {
    try {
      const p = JSON.parse(atob(r.credential.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      // exchange the Google ID token for a secure Supabase session (the RLS identity)
      if (typeof SupaAuth !== "undefined" && SupaAuth.active()) await SupaAuth.signInWithGoogle(r.credential);
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
  // native Google via the SocialLogin plugin (real Google account picker on Android + iOS)
  async _initSocialLogin() {
    if (this._slInit) return true;
    const SL = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.SocialLogin;
    if (!SL) return false;
    try {
      await SL.initialize({ google: { webClientId: window.GOOGLE_CLIENT_ID, iOSClientId: window.GOOGLE_IOS_CLIENT_ID || undefined, mode: "online" } });
      this._slInit = true; return true;
    } catch (e) { return false; }
  },
  async goGoogleNative() {
    const SL = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.SocialLogin;
    if (!SL) return this.authErr("Google sign-in isn't available here — use email.");
    if (!(await this._initSocialLogin())) return this.authErr("Google sign-in couldn't start — use email.");
    try {
      // No custom scopes: the plugin adds email/profile/openid by default (custom scopes would require a native MainActivity change).
      const res = await SL.login({ provider: "google", options: {} });
      const r = (res && res.result) || {};
      let email = r.profile && r.profile.email, name = r.profile && r.profile.name;
      if (!email && r.idToken) { try { const p = JSON.parse(atob(r.idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); email = email || p.email; name = name || p.name; } catch (e) {} }
      if (!email) return this.authErr("Google didn't return an email. Try again or use email login.");
      Auth.loginWithGoogle({ name: name || email.split("@")[0], email });
      this.enterApp();
    } catch (e) {
      const s = String((e && (e.message || e.errorMessage || e.code || e.error)) || e || "");
      if (/cancel/i.test(s)) return this.authErr("Google sign-in was cancelled — tap Continue with Google to retry.");
      this.authErr("Google: " + (s || "sign-in failed") + ". If you just enabled it, wait a few minutes then retry — or use email.");
    }
  },
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
    if (phone && !Auth.validPhone(phone)) return this.authErr("Enter a valid phone number.");
    if (pass.length < 6) return this.authErr("Password must be at least 6 characters.");
    if (pass !== pass2) return this.authErr("Passwords don't match.");
    if (!Auth.remote() && Auth.findByEmail(email)) return this.authErr("An account with this email already exists. Try logging in.");
    this.signupDraft = { name, email, phone, pass };
    window.Track && Track.event("signup_started");
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
    const exp = (document.getElementById("d-exp") || {}).value || "beginner";
    if (!dob) { this.authErr("Please enter your date of birth."); return null; }
    if (!h || h < 90 || h > 250) { this.authErr("Enter a valid height in cm."); return null; }
    if (!w || w < 25 || w > 400) { this.authErr("Enter a valid current weight in kg."); return null; }
    const physEl = document.getElementById("d-physique");
    const patch = {
      gender: g, dob, heightCm: h, startWeightKg: w,
      activityFactor: act, diet, physique: (physEl && physEl.value) || PHYSIQUES[g][0].id, physiqueChosen: true, onboarded: true,
      experience: exp,
      age: Math.max(13, Math.floor(daysBetween(dob, todayISO()) / 365.25)),
    };
    if (tw && tw >= 25 && tw <= 400) patch.targetWeightKg = tw;
    return patch;
  },
  submitDetails() {
    this._showWelcome = true; // T-16: reveal the personalised preview + Pro upsell on first entry
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
    try { const _ref = localStorage.getItem("fm_ref"); if (_ref) { patch.referredBy = _ref; window.Track && Track.event("referred_signup", { ref: _ref }); } } catch (e) {}
    this.onboardProfile = { patch, weightKg: patch.startWeightKg };
    const d = this.signupDraft || {};
    try {
      // Verify the email first (real OTP via EmailJS). Under secure Supabase Auth the
      // isolated DB session is created AFTER verification (in doVerifyOtp).
      const r = await Auth.signup({ name: d.name, email: d.email, phone: d.phone, password: d.pass });
      if (r && r.direct) return this.enterApp();     // cloud backend: signed in
      const del = await Auth.deliverCode();          // email a 6-digit code to verify the address
      this.pendingCode = del.sent ? null : (del.otp || null); // no mail backend → show code on screen (demo)
      this.showAuth("otp");
    } catch (e) { this.authErr(e.message); }
  },

  async doLogin() {
    const email = document.getElementById("a-email").value.trim();
    const pass = document.getElementById("a-pass").value;
    try {
      if (typeof SupaAuth !== "undefined" && SupaAuth.active()) {
        let signedIn = false;
        try { await SupaAuth.login(email, pass); signedIn = true; } catch (_) {}
        if (!signedIn) {
          const local = Auth.findByEmail(email);
          if (local && local.provider !== "supabase" && local.hash) {
            let ok = false; try { await Auth.login({ email, password: pass }); ok = true; } catch (_) {}
            if (!ok) return this.authErr("Incorrect password.");
          }
          try {
            const s = await SupaAuth.signup(email, pass, { name: local ? local.name : "" });
            if (s && s.needsConfirm) return this.authErr("Check your email to confirm your account, then log in.");
          } catch (_) {
            return this.authErr("Incorrect email or password.");
          }
        }
        Auth.supabaseSignIn({ email, name: (Auth.findByEmail(email) || {}).name });
        return this.enterApp();
      }
      await Auth.login({ email, password: pass }); this.enterApp();
    }
    catch (e) { this.authErr(e.message); }
  },

  doSendOtp() {
    const phone = document.getElementById("p-phone").value.trim();
    if (!Auth.validPhone(phone)) return this.authErr("Enter a valid phone number.");
    Auth.sendPhoneOtp(phone);
    this.showAuth("otp");
  },
  async doVerifyOtp() {
    const code = document.getElementById("o-code").value.trim();
    try {
      Auth.verifyOtp(code); this.pendingCode = null;
      // email verified → now create/adopt the secure Supabase session (RLS identity)
      if (typeof SupaAuth !== "undefined" && SupaAuth.active()) {
        const d = this.signupDraft || {};
        if (d.email && d.pass) {
          try { await SupaAuth.signup(d.email, d.pass, { name: d.name }); }
          catch (_) { try { await SupaAuth.login(d.email, d.pass); } catch (__) {} }
          Auth.supabaseSignIn({ email: d.email, name: d.name });
        }
      }
      this.enterApp();
    }
    catch (e) { this.authErr(e.message); }
  },
  async doResend() {
    Auth.resendOtp();
    if (Auth.pending && Auth.pending.channel === "email") {
      const del = await Auth.deliverCode();
      this.pendingCode = del.sent ? null : (del.otp || null);
      if (this.toast) this.toast(del.sent ? "New code emailed ✓" : "New code generated");
    }
    this.showAuth("otp");
  },

  async doForgot() {
    const email = (document.getElementById("f-email").value || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return this.authErr("Enter a valid email address.");
    try {
      if (typeof SupaAuth !== "undefined" && SupaAuth.active()) await SupaAuth.recover(email);
      this.showAuth("login");
      if (this.toast) this.toast("If that email is registered, a reset link is on its way — check your inbox (and spam).");
    } catch (e) { this.authErr(e.message); }
  },
  async doResetPassword() {
    const p1 = document.getElementById("r-pass").value || "";
    const p2 = document.getElementById("r-pass2").value || "";
    if (p1.length < 6) return this.authErr("Password must be at least 6 characters.");
    if (p1 !== p2) return this.authErr("Those passwords don't match.");
    const t = this._recoverTokens;
    if (!t || !t.access_token) return this.authErr("This reset link has expired — request a new one from Forgot your password.");
    try {
      const sess = await SupaAuth.setPasswordWithToken(t.access_token, t.refresh_token, t.expires_in, p1);
      this._recoverTokens = null;
      Auth.supabaseSignIn({ email: (sess && sess.email) || "", name: (Auth.findByEmail((sess && sess.email) || "") || {}).name });
      if (this.toast) this.toast("Password updated — you're logged in.");
      this.enterApp();
    } catch (e) { this.authErr(e.message); }
  },

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
  _tabView: { home: "feed", search: "feed", flex: "flex", coach: "coach", alerts: "alerts", profile: "profile" },
  _tabOrder: ["home", "search", "flex", "coach", "alerts", "profile"],

  selectTab(tab) {
    if (!this._tabView[tab]) tab = "home";
    if (typeof Social !== "undefined" && Social.stopMusic) Social.stopMusic();
    const viewId = "view-" + this._tabView[tab];
    // direction-aware slide: compare the new tab's position to the current one
    const wrap = document.getElementById("wrap");
    const prevIdx = this._tabOrder.indexOf(this.curTab), nextIdx = this._tabOrder.indexOf(tab);
    if (wrap) {
      wrap.classList.remove("nav-l", "nav-r");
      if (this.curTab && prevIdx !== -1 && nextIdx !== -1 && nextIdx !== prevIdx)
        wrap.classList.add(nextIdx > prevIdx ? "nav-r" : "nav-l");
    }
    document.querySelectorAll("#tabbar .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
    document.querySelectorAll("#wrap > .view").forEach((v) => v.classList.toggle("active", v.id === viewId));
    this.curTab = tab;
    document.querySelector(".wrap").scrollTo ? window.scrollTo({ top: 0, behavior: "instant" }) : window.scrollTo(0, 0);
    this.renderTab(tab);
    // replay the slide animation even when the target section element is unchanged (e.g. home↔search share view-feed)
    const av = document.getElementById(viewId);
    if (av) { av.style.animation = "none"; void av.offsetWidth; av.style.animation = ""; }
  },

  renderTab(tab) {
    if (tab === "home") Social.render("feed");
    else if (tab === "search") Social.render("crew");
    else if (tab === "flex") this.renderFlex();
    else if (tab === "coach") this.renderCoach();
    else if (tab === "alerts") this.renderAlerts();
    else if (tab === "profile") this.renderProfile();
  },

  // ---- Flex: full-screen vertical-scroll reels (TikTok/Reels-style) ----
  renderFlex() {
    const el = document.getElementById("view-flex");
    if (!el) return;
    const cloudOn = Social.cloudActive();
    const reels = cloudOn ? Social.cloud.feed.filter((p) => p.video && Social._canSeePost(p)) : [];
    if (!reels.length) {
      el.innerHTML = this.emptyState("film", "No Flex videos yet", "Record a Flex from the Home feed and it'll show here to scroll — like Reels, but yours.", `<button class="btn" onclick="App.selectTab('home');Social.pickReel()">Record a Flex</button>`);
      if (this._reelObs) { this._reelObs.disconnect(); this._reelObs = null; }
      return;
    }
    el.innerHTML = `<div class="reels" id="reels">${reels.map((p) => this.reelSlide(Social._cloudPost(p))).join("")}</div>`;
    this._bindReels();
  },
  reelSlide(p) {
    const a = Social.persona(p.author);
    return `<div class="reel" data-id="${p.id}">
      <video class="reel-vid" src="${p.video}" data-msrc="${esc(p.music ? p.music.src : "")}" playsinline loop ${Social._feedSound ? "" : "muted"} preload="metadata" onclick="App.reelTap('${p.id}',event)"></video>
      <div class="reel-grad"></div>
      <button class="reel-mute" onclick="App.toggleReelMute(this)" title="Sound">${this.ic(Social._feedSound ? "volume" : "mute", { size: 20 })}</button>
      <div class="reel-actions">
        <button class="reel-act like ${p.likedByMe ? "on" : ""}" onclick="App.reelLike('${p.id}',this)">${this.ic("heart", { size: 29, solid: p.likedByMe })}<span>${p.likes}</span></button>
        <button class="reel-act" onclick="App.openReelComments('${p.id}')">${this.ic("comment", { size: 29 })}<span id="rcnt-${p.id}">${Social.cloudActive() ? Social.commentCount(p.id) : 0}</span></button>
        <button class="reel-act reshare ${p.resharedByMe ? "on" : ""}" onclick="App.reelReshare('${p.id}',this)">${this.ic("reshare", { size: 28 })}<span>${p.reshares || 0}</span></button>
        <button class="reel-act" onclick="App.reelShare('${p.id}')">${this.ic("share", { size: 28 })}<span>Share</span></button>
        <button class="reel-act save ${Social.isSaved(p.id) ? "on" : ""}" onclick="App.reelSave('${p.id}',this)">${this.ic("bookmark", { size: 28, solid: Social.isSaved(p.id) })}<span>Save</span></button>
      </div>
      <div class="reel-info" onclick="Social.viewProfile('${p.author}')">
        ${Social.avatar(a, 40)}
        <div class="reel-meta"><div class="reel-name">${esc(a.name)} <span>@${esc(a.handle)}</span></div>${p.text ? `<div class="reel-cap">${esc(p.text)}</div>` : ""}${p.music ? `<div class="reel-music">🎵 ${esc(p.music.title)} · ${esc(p.music.artist)}</div>` : ""}</div>
      </div>
    </div>`;
  },
  _bindReels() {
    const cont = document.getElementById("reels");
    if (!cont) return;
    const vids = cont.querySelectorAll(".reel-vid");
    if (this._reelObs) this._reelObs.disconnect();
    this._reelObs = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        const v = e.target;
        const msrc = v.getAttribute("data-msrc") || "";
        if (e.isIntersecting && e.intersectionRatio > 0.6) {
          cont.querySelectorAll(".reel-vid").forEach((o) => { if (o !== v) o.pause(); });
          if (msrc) { v.muted = true; Social.playMusic(msrc); } else { v.muted = !Social._feedSound; if (Social._musicSrc) Social.stopMusic(); }
          v.play().catch(() => {});
        } else { v.pause(); if (msrc && Social._musicSrc === msrc) Social.stopMusic(); }
      });
    }, { threshold: [0, 0.6, 1] });
    vids.forEach((v) => this._reelObs.observe(v));
    if (vids[0]) { const m0 = vids[0].getAttribute("data-msrc") || ""; if (m0) { vids[0].muted = true; Social.playMusic(m0); } else { vids[0].muted = !Social._feedSound; } vids[0].play().catch(() => {}); }
  },
  toggleReelPlay(v) {
    const msrc = v.getAttribute && v.getAttribute("data-msrc");
    if (v.paused) { v.play().catch(() => {}); if (msrc) Social.playMusic(msrc); }
    else { v.pause(); if (msrc && Social._musicSrc === msrc && Social._musicAudio) Social._musicAudio.pause(); }
  },
  // double-tap the reel = like (Instagram-style); single tap toggles play
  reelTap(id, ev) {
    const now = Date.now();
    if (this._rTapId === id && now - (this._rTapT || 0) < 300) {
      clearTimeout(this._rTapTimer); this._rTapT = 0; this._rTapId = null;
      Social._heartBurst(ev);
      const src = Social.cloudActive() && Social.cloud.feed.find((x) => x.id === id);
      const p = src ? Social._cloudPost(src) : null;
      if (p && !p.likedByMe) { const btn = document.querySelector(`.reel[data-id="${id}"] .reel-act.like`); this.reelLike(id, btn); }
      return;
    }
    this._rTapId = id; this._rTapT = now;
    const v = ev.currentTarget;
    clearTimeout(this._rTapTimer);
    this._rTapTimer = setTimeout(() => { this.toggleReelPlay(v); }, 300);
  },
  toggleReelMute(btn) {
    Social._feedSound = !Social._feedSound;
    document.querySelectorAll(".reel-vid").forEach((v) => { v.muted = v.getAttribute("data-msrc") ? true : !Social._feedSound; });
    document.querySelectorAll(".reel-mute").forEach((b) => { b.innerHTML = this.ic(Social._feedSound ? "volume" : "mute", { size: 20 }); });
    if (Social._musicAudio) Social._musicAudio.muted = !Social._feedSound;
    if (App.toast) App.toast(Social._feedSound ? "🔊 Sound on" : "Muted");
  },
  reelLike(id, btn) {
    Social.likePost(id);
    const src = Social.cloud.feed.find((x) => x.id === id);
    if (!src || !btn) return;
    const p = Social._cloudPost(src);
    btn.classList.toggle("on", p.likedByMe);
    btn.innerHTML = this.ic("heart", { size: 29, solid: p.likedByMe }) + `<span>${p.likes}</span>`;
  },
  reelReshare(id, btn) {
    Social.resharePost(id);
    const src = Social.cloud.feed.find((x) => x.id === id);
    const p = src ? Social._cloudPost(src) : { reshares: 0, resharedByMe: false };
    btn.classList.toggle("on", p.resharedByMe);
    btn.innerHTML = this.ic("reshare", { size: 28 }) + `<span>${p.reshares || 0}</span>`;
  },
  reelShare(id) { Social.sharePost(id); },
  reelSave(id, btn) {
    const saved = Social._setSaved(id);
    if (!btn) return;
    btn.classList.toggle("on", saved);
    btn.innerHTML = this.ic("bookmark", { size: 28, solid: saved }) + "<span>Save</span>";
  },

  // ---- premium inline icon set (24-grid, stroke-based, inherits currentColor) ----
  _ICONS: {
    heart: '<path d="M19.5 4.9a5 5 0 0 0-7.1 0l-.4.4-.4-.4a5 5 0 1 0-7.1 7.1l.4.4L12 20l7.1-7.2.4-.4a5 5 0 0 0 0-7.1Z"/>',
    comment: '<path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5Z"/>',
    reshare: '<path d="m17 2 4 4-4 4"/><path d="M3 12v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 12v1a4 4 0 0 1-4 4H3"/>',
    share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="m16 6-4-4-4 4"/><path d="M12 2v14"/>',
    bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/>',
    volume: '<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/>',
    mute: '<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="m23 9-6 6"/><path d="m17 9 6 6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3a2.5 2.5 0 0 0 2 2.5Z"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
    chat: '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2Z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
    trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.7V17c0 .6-.5 1-1 1.2C7.9 18.8 7 20.2 7 22"/><path d="M14 14.7V17c0 .6.5 1 1 1.2C16.1 18.8 17 20.2 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z"/><circle cx="12" cy="13" r="3.5"/>',
    film: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18"/><path d="M17 3v18"/><path d="M3 12h18"/><path d="M3 7.5h4"/><path d="M17 7.5h4"/><path d="M3 16.5h4"/><path d="M17 16.5h4"/>',
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-6h6v6"/>',
    dumbbell: '<path d="M4 9v6"/><path d="M20 9v6"/><path d="M7 7.5v9"/><path d="M17 7.5v9"/><path d="M7 12h10"/>',
    chart: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>',
    apple: '<path d="M12 7C10 4 6 4 5 7c-1 2-1 5 1 8 1 2 3 4 6 4s5-2 6-4c2-3 2-6 1-8-1-3-5-3-7 0Z"/><path d="M12 7c.4-2 2-3.5 3.5-3.5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M5.5 21a6.5 6.5 0 0 1 13 0"/>',
    bell: '<path d="M6 9a6 6 0 1 1 12 0c0 5 2 7 2 7H4s2-2 2-7Z"/><path d="M10.5 20a2 2 0 0 0 3 0"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
    cog: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
    utensils: '<path d="M3 2v7c0 1.1.9 2 2 2h0a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3H3Z"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M9.9 5.1A9.6 9.6 0 0 1 12 5c6.4 0 10 7 10 7a15.6 15.6 0 0 1-3.4 4.1"/><path d="M6.5 6.6A15.5 15.5 0 0 0 2 12s3.6 7 10 7a9.5 9.5 0 0 0 4-.9"/><path d="M14.1 14.1A3 3 0 1 1 9.9 9.9"/><path d="m2 2 20 20"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    chevronR: '<path d="M9 6l6 6-6 6"/>',
  },
  ic(name, opts) {
    opts = opts || {};
    const size = opts.size || 24, solid = !!opts.solid, sw = opts.sw || 1.9;
    return `<svg class="ic ic-${name}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="${solid ? "currentColor" : "none"}" stroke="${solid ? "none" : "currentColor"}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${this._ICONS[name] || ""}</svg>`;
  },
  // reusable app-branded send button (gradient paper-plane) — comments, reels & DMs
  sendIcon(onclick, extra) {
    return `<button class="send-ico ${extra || ""}" onclick="${onclick}" aria-label="Send" title="Send">${this.ic("send", { size: 18, sw: 2 })}</button>`;
  },
  // slide-to-confirm control (iOS "slide to answer" feel) for commit moments. `action` is a live function.
  _slides: {},
  _slideN: 0,
  slideBtn(action, label, opts) {
    opts = opts || {};
    const id = "sl" + (++this._slideN);
    this._slides[id] = action;
    return `<div class="slidebtn ${opts.cls || ""}" data-sl="${id}" role="button" tabindex="0" aria-label="${esc(opts.aria || label)}">
        <span class="sb-fill"></span>
        <span class="sb-track"><span class="sb-label">${esc(label)}</span></span>
        <span class="sb-thumb">${this.ic("chevronR", { size: 22, sw: 2.4 })}</span>
      </div>`;
  },
  bindSlides() {
    if (this._slideBound) return; this._slideBound = true;
    const shell = document.getElementById("app-shell") || document.body;
    let el = null, id = null, x0 = 0, max = 0, cur = 0, thumb = null, fill = null;
    const start = (e) => {
      const t = e.target.closest && e.target.closest(".slidebtn");
      if (!t || t.classList.contains("done")) return;
      el = t; id = t.getAttribute("data-sl");
      thumb = t.querySelector(".sb-thumb"); fill = t.querySelector(".sb-fill");
      max = t.clientWidth - thumb.offsetWidth - 10; cur = 0; x0 = e.clientX;
      el.classList.add("sliding");
      try { t.setPointerCapture(e.pointerId); } catch (_) {}
    };
    const move = (e) => {
      if (!el) return;
      cur = Math.max(0, Math.min(max, e.clientX - x0));
      thumb.style.transform = "translateX(" + cur + "px)";
      fill.style.width = (thumb.offsetWidth + 10 + cur) + "px";
      if (e.cancelable) e.preventDefault();
    };
    const end = () => {
      if (!el) return;
      const t = el;
      if (cur >= max * 0.82) {
        thumb.style.transform = "translateX(" + max + "px)"; fill.style.width = "100%";
        t.classList.add("done"); t.classList.remove("sliding");
        try { navigator.vibrate && navigator.vibrate(18); } catch (_) {}
        const fn = this._slides[id];
        setTimeout(() => { if (typeof fn === "function") fn(); }, 200);
      } else {
        thumb.style.transform = ""; fill.style.width = ""; t.classList.remove("sliding");
      }
      el = null; id = null; cur = 0;
    };
    shell.addEventListener("pointerdown", start);
    shell.addEventListener("pointermove", move, { passive: false });
    shell.addEventListener("pointerup", end);
    shell.addEventListener("pointercancel", end);
    shell.addEventListener("keydown", (e) => {
      const t = e.target.closest && e.target.closest(".slidebtn");
      if (t && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); const fn = this._slides[t.getAttribute("data-sl")]; if (typeof fn === "function") fn(); }
    });
  },
  // password field with a show/hide eye toggle (inline-styled — no new CSS)
  pwField(id, label, ph, ac, meter) {
    return `<div class="field">
        <label>${label}</label>
        <div style="position:relative">
          <input id="${id}" type="password" placeholder="${ph}" autocomplete="${ac || "current-password"}"${meter ? ` oninput="App.pwStrength('${id}')"` : ""} style="width:100%;box-sizing:border-box;padding-right:42px">
          <button type="button" onclick="App.togglePw('${id}',this)" aria-label="Show password" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:0;color:var(--muted);cursor:pointer;padding:6px;display:flex;line-height:0">${this.ic("eye", { size: 18 })}</button>
        </div>${meter ? `<div id="${id}-str" style="min-height:2px"></div>` : ""}
      </div>`;
  },
  pwStrength(id) {
    const inp = document.getElementById(id), box = document.getElementById(id + "-str"); if (!inp || !box) return;
    const v = inp.value || ""; let s = 0;
    if (v.length >= 6) s++; if (v.length >= 10) s++;
    if (/[a-z]/.test(v) && /[A-Z]/.test(v)) s++; if (/\d/.test(v)) s++; if (/[^A-Za-z0-9]/.test(v)) s++;
    const map = [["", "transparent"], ["Weak", "#ff5a4d"], ["Fair", "#ff9d4d"], ["Good", "#f5b301"], ["Strong", "#22c55e"]];
    const lvl = v ? Math.max(1, Math.min(4, s)) : 0, row = map[lvl], pct = lvl * 25;
    box.innerHTML = `<div style="height:4px;border-radius:3px;background:rgba(255,255,255,.08);overflow:hidden;margin-top:6px"><div style="height:100%;width:${pct}%;background:${row[1]};transition:width .2s"></div></div>${row[0] ? `<div style="font-size:11px;color:${row[1]};margin-top:3px;font-weight:600">${row[0]} password</div>` : ""}`;
  },
  togglePw(id, btn) {
    const inp = document.getElementById(id); if (!inp) return;
    const show = inp.type === "password";
    inp.type = show ? "text" : "password";
    if (btn) { btn.innerHTML = this.ic(show ? "eyeOff" : "eye", { size: 18 }); btn.setAttribute("aria-label", show ? "Hide password" : "Show password"); }
  },
  // premium empty state: gradient icon badge + title + subtext + optional CTA (inline-styled, no new CSS)
  emptyState(icon, title, sub, cta) {
    return `<div style="text-align:center;padding:40px 20px 32px">
      <div style="width:62px;height:62px;margin:0 auto 15px;border-radius:19px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,rgba(255,157,77,.16),rgba(255,61,127,.14));color:var(--accent)">${this.ic(icon, { size: 28 })}</div>
      <div style="font-weight:800;font-size:16.5px;margin-bottom:5px">${esc(title)}</div>
      <div class="sub" style="max-width:290px;margin:0 auto;line-height:1.5">${esc(sub)}</div>
      ${cta ? `<div style="margin-top:16px">${cta}</div>` : ""}
    </div>`;
  },

  // ---- Flex comments: in-app bottom sheet (no navigation away) ----
  openReelComments(id) {
    this._reelCmtId = id;
    const v = document.querySelector(`.reel[data-id="${id}"] .reel-vid`); if (v) v.pause();
    let ov = document.getElementById("reel-comments");
    if (!ov) { ov = document.createElement("div"); ov.id = "reel-comments"; document.body.appendChild(ov); }
    ov.className = "reel-comments open";
    const n = Social.cloudActive() ? Social.commentCount(id) : 0;
    ov.innerHTML = `<div class="rc-backdrop" onclick="App.closeReelComments()"></div>
      <div class="rc-sheet">
        <div class="rc-grip"></div>
        <div class="rc-head"><div class="rc-title">${n} comment${n === 1 ? "" : "s"}</div><button class="icon-btn" onclick="App.closeReelComments()">✕</button></div>
        <div class="rc-list" id="rc-list">${this._reelCommentsList(id)}</div>
        <div class="rc-input-row">${Social.avatar(Social.me(), 32)}
          <input id="rc-input" placeholder="Add a comment… @ to mention" onkeydown="if(event.key==='Enter')App.submitReelComment('${id}')">
          ${this.sendIcon(`App.submitReelComment('${id}')`)}
        </div>
      </div>`;
    setTimeout(() => { const i = document.getElementById("rc-input"); if (i) i.focus(); }, 60);
  },
  _reelCommentsList(id) {
    if (!Social.cloudActive()) return `<div class="sub" style="padding:14px 4px;text-align:center">Sign in online to comment.</div>`;
    const all = Social.commentsFor(id);
    const tops = all.filter((c) => !c.parent_id);
    if (!tops.length) return `<div class="sub" style="padding:18px 4px;text-align:center">No comments yet — be the first 👋</div>`;
    const row = (c, isReply) => {
      const who = Social._commenter(c.author);
      return `<div class="cmt2 ${isReply ? "reply" : ""}"><span class="cmt2-av" onclick="App.closeReelComments();Social.viewProfile('${c.author}')">${Social.avatar(who, isReply ? 26 : 30)}</span><div class="cmt2-body"><b onclick="App.closeReelComments();Social.viewProfile('${c.author}')">${esc(who.name)}</b> ${Social._renderMentions(c.body)} <span class="cmt2-time">${Social.timeAgo(c.ts)}</span>${isReply ? "" : ` <button class="cmt2-reply" onclick="App.reelReply('${c.author}')">Reply</button>`}</div></div>`;
    };
    return tops.map((c) => row(c, false) + all.filter((r) => r.parent_id === c.id).map((r) => row(r, true)).join("")).join("");
  },
  reelReply(author) {
    const i = document.getElementById("rc-input");
    if (i) { i.value = "@" + Social._commenter(author).handle + " "; i.focus(); }
  },
  submitReelComment(id) {
    const i = document.getElementById("rc-input");
    if (!i || !i.value.trim() || !Social.cloudActive()) return;
    const body = i.value.trim(); i.value = "";
    const post = Social.cloud.feed.find((p) => p.id === id);
    const mentions = Social._parseMentions(body);
    const nc = (typeof Cloud !== "undefined" && Cloud.addComment) ? Cloud.addComment(id, body, null, mentions, post ? post.author : null, null) : null;
    if (nc) { if (!Social.cloud.comments) Social.cloud.comments = []; Social.cloud.comments.push(nc); }
    const list = document.getElementById("rc-list"); if (list) { list.innerHTML = this._reelCommentsList(id); list.scrollTop = list.scrollHeight; }
    const n = Social.commentCount(id);
    const title = document.querySelector("#reel-comments .rc-title"); if (title) title.textContent = n + " comment" + (n === 1 ? "" : "s");
    const badge = document.getElementById("rcnt-" + id); if (badge) badge.textContent = n;
  },
  closeReelComments() {
    const id = this._reelCmtId;
    const ov = document.getElementById("reel-comments");
    if (ov) { ov.classList.remove("open"); ov.innerHTML = ""; }
    this._reelCmtId = null;
    const v = document.querySelector(`.reel[data-id="${id}"] .reel-vid`);
    if (v) { const r = v.getBoundingClientRect(); if (r.top > -r.height && r.top < window.innerHeight) v.play().catch(() => {}); }
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
    const nav = [["overview", this.ic("home", { size: 15 }) + " Overview"], ["today", this.ic("dumbbell", { size: 15 }) + " Today"], ["progress", this.ic("chart", { size: 15 }) + " Progress"], ["nutrition", this.ic("apple", { size: 15 }) + " Nutrition"]];
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

  // swipe left/right between tabs — the page follows your finger, then slides to the next tab (native pager feel)
  bindSwipe() {
    const wrap = document.getElementById("wrap");
    if (!wrap) return;
    let x0 = null, y0 = null, t0 = 0, dir = 0, view = null, w = 0;
    const blocked = (el) => el && el.closest && el.closest(".carousel, .chat-thread, .composer-photos, input, textarea, select, .social-subnav, .coach-subnav, .vp-tabs");
    const clear = (v) => { if (v) { v.style.transition = ""; v.style.transform = ""; v.style.opacity = ""; } };
    wrap.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1 || blocked(e.target)) { x0 = null; return; }
      const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; t0 = Date.now();
      dir = 0; view = document.querySelector("#wrap > .view.active"); w = wrap.clientWidth || window.innerWidth;
    }, { passive: true });
    wrap.addEventListener("touchmove", (e) => {
      if (x0 === null || !view) return;
      const t = e.touches[0], dx = t.clientX - x0, dy = t.clientY - y0;
      if (dir === 0) {                                   // lock the gesture axis on first real movement
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        dir = Math.abs(dx) > Math.abs(dy) ? 1 : -1;      // 1 = horizontal (pager), -1 = vertical (let it scroll)
        if (dir === 1) view.style.transition = "none";
      }
      if (dir !== 1) return;
      e.preventDefault();                                // take over the horizontal drag
      const i = this._tabOrder.indexOf(this.curTab || "home");
      const atEdge = (dx < 0 && i >= this._tabOrder.length - 1) || (dx > 0 && i <= 0);
      const d = atEdge ? dx * 0.28 : dx;                 // rubber-band at the first/last tab
      view.style.transform = `translateX(${d}px)`;
      view.style.opacity = String(Math.max(0.5, 1 - Math.abs(d) / (w * 1.5)));
    }, { passive: false });
    const end = (e) => {
      if (x0 === null) return;
      const c = e.changedTouches && e.changedTouches[0], dx = c ? c.clientX - x0 : 0, dt = Date.now() - t0;
      x0 = null;
      const v = view; view = null;
      if (dir !== 1 || !v) { clear(v); return; }
      const i = this._tabOrder.indexOf(this.curTab || "home");
      const next = dx < 0 ? i + 1 : i - 1;
      const commit = (Math.abs(dx) > w * 0.3 || (Math.abs(dx) > 55 && dt < 300)) && next >= 0 && next < this._tabOrder.length;
      if (commit) {                                      // fling the page out, then the next tab slides in
        v.style.transition = "transform .16s ease-out, opacity .16s ease-out";
        v.style.transform = `translateX(${dx < 0 ? -w : w}px)`; v.style.opacity = "0";
        setTimeout(() => { clear(v); this.selectTab(this._tabOrder[next]); }, 150);
      } else {                                           // snap back to place
        v.style.transition = "transform .22s cubic-bezier(.22,.61,.36,1), opacity .22s ease";
        v.style.transform = "translateX(0)"; v.style.opacity = "1";
        setTimeout(() => clear(v), 230);
      }
    };
    wrap.addEventListener("touchend", end, { passive: true });
    wrap.addEventListener("touchcancel", end, { passive: true });
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
    const isPro = typeof Entitlements !== "undefined" && Entitlements.isPro();
    const ep = Engine.experiencePlan();
    const programCard = `<div class="card program-cta">
        <div class="hc-head"><h2>Your training program</h2><span class="hc-badge">${isPro ? "Pro" : "Pro \u2728"}</span></div>
        <div class="hc-line">A periodised 4-week plan for your <b>${esc(phys.name)}</b> goal \u2014 ${ep.freq} days/week, auto-progressed each week.</div>
        <div class="hc-actions"><button class="btn" onclick="App.openProgram()">${isPro ? "View my program \u2192" : "Unlock with Pro \u2192"}</button></div>
      </div>`;

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
          <div class="stat"><div class="stat-v"><span class="cnt" data-to="${s.bodyFat}" data-dec="1">0</span><small>%</small></div><div class="stat-l">Body fat</div></div>
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

      ${programCard}

      <div class="home-quick">
        <button class="quick" onclick="App.goTab('nutrition')"><span>${this.ic("apple", { size: 20 })}</span>Plan meals</button>
        <button class="quick" onclick="App.goTab('today')"><span>${this.ic("dumbbell", { size: 20 })}</span>Workout</button>
        <button class="quick" onclick="App.goTab('progress')"><span>${this.ic("chart", { size: 20 })}</span>Progress</button>
        <button class="quick" onclick="App.goTab('profile')"><span>${this.ic("cog", { size: 20 })}</span>Profile</button>
      </div>

      <div class="card ask-card">
        <h2>${this.ic("chat", { size: 18 })} Ask your coach</h2>
        <div class="sub">Any fitness question — answered from your own stats</div>
        <div class="ask-row">
          <input id="ask-q" placeholder="How do I lose belly fat and get abs?" onkeydown="if(event.key==='Enter')App.askCoach()">
          <button class="btn" onclick="App.askCoach()">Ask</button>
        </div>
        <div class="ask-chips">
          ${["How to lose belly fat", "Build bigger arms", "Grow my chest", "What should I eat"].map((q) => `<button class="ask-chip" onclick="App.askCoach('${q}')">${q}</button>`).join("")}
        </div>
        <div id="ask-answer" class="ask-answer"></div>
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
    this._slides = {}; this.bindSlides();
    const el = document.getElementById("view-today");
    // resume an in-progress workout saved earlier today; drop a stale one
    const _draft = Store.state.draftSession;
    if (!this.session && _draft && _draft.date === todayISO() && _draft.session) this.session = _draft.session;
    else if (_draft && _draft.date && _draft.date !== todayISO()) Store.state.draftSession = null;
    if (this.session && !this.session.editing) this._saveDraft();
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
    html += `<div class="start-wrap">
        ${this.slideBtn(() => App.startSession(rec), "Slide to start \u00b7 " + SPLITS[rec].label)}
        <button class="btn-big rest" onclick="App.markRest()" style="margin-top:12px">${this.ic("moon", { size: 18 })} Rest today<small>Log a recovery day</small></button>
      </div>
      <div class="pick-day">
        <span class="pick-label">or pick your day:</span>
        ${SPLIT_ROTATION.map((s) => `<button class="day-chip ${s === rec ? "rec" : ""}" onclick="App.startSession('${s}')">${SPLITS[s].label}${s === rec ? " ★" : ""}</button>`).join("")}
      </div>
      <button class="btn ghost wide" style="margin-top:10px" onclick="App.openTextLog()">${this.ic("edit", { size: 16 })} Already trained? Type what you did</button>
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
      box.classList.remove("none"); box.innerHTML = this.pexelsCache[id];
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
      const b2 = document.getElementById("pd-photo");
      if (b2) { b2.classList.remove("none"); b2.innerHTML = html; } // un-hide (the missing static jpg added .none)
    } catch { /* stay on the illustrated figure */ }
  },

  // gender-aware exercise imagery: female users see women training (Pexels), not the male form-demo photos
  _exGroupOf(ex) {
    const m = (ex && ex.muscle) || "";
    if (typeof Exercises !== "undefined" && Exercises._groupFromMuscle) return Exercises._groupFromMuscle(m) || "";
    return "";
  },
  _femaleExQuery(group) {
    return ({
      Chest: "fit woman chest press workout gym",
      Back: "fit woman back workout gym",
      Shoulders: "fit woman shoulder press workout gym",
      Arms: "fit woman arms dumbbell workout gym",
      Legs: "fit woman legs squat workout gym",
      Core: "fit woman abs core workout gym",
    })[group] || "fit woman workout gym";
  },
  // a specific query for ONE exercise (e.g. "woman barbell bench press gym") so the photo matches the movement, not just the muscle
  _femaleExQueryFor(ex) {
    const raw = (ex && (ex.name || ex.id)) || "";
    const name = raw.replace(/[_-]+/g, " ").replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    return name ? `woman ${name} gym` : "";
  },
  async _fetchFemaleQuery(q, n) {
    try {
      const res = await fetch(
        `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=${n || 6}&orientation=portrait`,
        { headers: { Authorization: window.PEXELS_KEY } });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.photos || []).map((ph) => ph.src.portrait || ph.src.large || ph.src.medium).filter(Boolean);
    } catch { return []; }
  },
  async _fetchFemalePool(group) { return this._fetchFemaleQuery(this._femaleExQuery(group), 12); },
  // stable hash so a group-pool exercise keeps ONE photo across re-renders (used by the browse picker)
  _hash(s) { s = String(s == null ? "" : s); let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); },
  async _femalePool(group) {
    if (!this.exFemalePool) this.exFemalePool = {};
    if (!this.exFemalePool[group] || !this.exFemalePool[group].length) {
      this.exFemalePool[group] = (await this._fetchFemalePool(group)) || [];
    }
    return this.exFemalePool[group];
  },
  _femaleSrc(pool, exKey) { return pool.length ? pool[this._hash(exKey) % pool.length] : ""; },
  // exact per-exercise photos, cached by exercise id (specific query → muscle-group fallback)
  async _femalePhotosFor(key, specificQ, group) {
    if (!this.exFemalePhotos) this.exFemalePhotos = {};
    if (this.exFemalePhotos[key] && this.exFemalePhotos[key].length) return this.exFemalePhotos[key];
    let photos = specificQ ? await this._fetchFemaleQuery(specificQ, 6) : [];
    if (!photos.length) photos = await this._fetchFemaleQuery(this._femaleExQuery(group), 6);
    photos = photos.slice(0, 4);
    if (photos.length) this.exFemalePhotos[key] = photos; // don't cache an empty result — retry next render
    return photos;
  },
  // swap female exercise thumbnails in place; data-exq → exact per-exercise photo, else the muscle-group pool
  async loadFemaleExPhotos(root) {
    const p = Store.state.profile;
    if (!window.PEXELS_KEY || !p || p.gender !== "female") return;
    const scope = root || document;
    const thumbs = Array.from(scope.querySelectorAll("[data-exkey]:not([data-fem])"));
    if (!thumbs.length) return;
    await Promise.all(thumbs.map(async (t) => {
      const key = t.getAttribute("data-exkey");
      const specificQ = t.getAttribute("data-exq");
      let src;
      if (specificQ != null) {
        const photos = await this._femalePhotosFor(key, specificQ, t.getAttribute("data-exmuscle") || "");
        src = photos[0];
      } else {
        const pool = await this._femalePool(t.getAttribute("data-exmuscle") || "_");
        src = this._femaleSrc(pool, key);
      }
      if (!src) return; // leave it for a later render to retry
      t.setAttribute("data-fem", "1");
      const im = t.querySelector("img");
      if (im) { im.src = src; im.style.display = ""; }
      else { t.classList.remove("noimg"); t.innerHTML = `<img src="${src}" alt="exercise" loading="lazy" onerror="this.style.display='none';this.parentElement.classList.add('noimg')">`; }
    }));
  },
  // exercise preview for women: the SAME photo as the thumbnail + one more (parity with men's two frames)
  async _loadFemaleHero(exKey, group) {
    if (!document.getElementById("exp-hero")) return;
    const pool = await this._femalePool(group);
    const box = document.getElementById("exp-hero"); if (!box) return;
    if (!pool.length) { box.classList.add("noimg"); box.innerHTML = ""; return; }
    const i = this._hash(exKey) % pool.length;
    const j = pool.length > 1 ? (i + 1) % pool.length : i;
    box.classList.remove("noimg");
    box.innerHTML = [pool[i], pool[j]].map((src) => `<img src="${src}" alt="reference" loading="lazy" onerror="this.style.display='none'">`).join("");
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
  closeModal() { document.getElementById("modal").classList.add("hidden"); if (typeof Social !== "undefined" && Social._stopPreview) Social._stopPreview(); },
  shareProgress() {
    const p = (typeof Store !== "undefined" && Store.state && Store.state.profile) || {};
    const meName = p.name || (typeof Social !== "undefined" && Social.me ? Social.me().name : "") || "Me";
    const streak = (typeof Engine !== "undefined" && Engine.streak) ? Engine.streak() : 0;
    const workouts = (typeof Engine !== "undefined" && Engine.totalWorkouts) ? Engine.totalWorkouts() : 0;
    const st = (typeof Engine !== "undefined" && Engine.stats) ? Engine.stats() : {};
    const score = Math.round(st.score || 0);
    const wt = (typeof Store !== "undefined" && Store.latestWeight) ? (Store.latestWeight() || p.startWeightKg || 0) : 0;
    const phys = p.physique || "my dream physique";
    const url = (typeof Social !== "undefined" && Social._refUrl) ? Social._refUrl() : "https://arindamchatterjee007.github.io/formora/";
    const C = document.createElement("canvas"); C.width = 1080; C.height = 1080;
    const x = C.getContext("2d");
    const rr = (bx, by, w, h, r) => { if (x.roundRect) { x.beginPath(); x.roundRect(bx, by, w, h, r); } else { x.beginPath(); x.moveTo(bx + r, by); x.arcTo(bx + w, by, bx + w, by + h, r); x.arcTo(bx + w, by + h, bx, by + h, r); x.arcTo(bx, by + h, bx, by, r); x.arcTo(bx, by, bx + w, by, r); x.closePath(); } };
    let g = x.createLinearGradient(0, 0, 1080, 1080); g.addColorStop(0, "#13141c"); g.addColorStop(1, "#0a0b10"); x.fillStyle = g; x.fillRect(0, 0, 1080, 1080);
    let rg = x.createRadialGradient(860, 240, 0, 860, 240, 560); rg.addColorStop(0, "rgba(255,61,127,.22)"); rg.addColorStop(1, "rgba(255,61,127,0)"); x.fillStyle = rg; x.fillRect(0, 0, 1080, 1080);
    let bg = x.createLinearGradient(96, 96, 210, 210); bg.addColorStop(0, "#ff9d4d"); bg.addColorStop(.5, "#ff5a4d"); bg.addColorStop(1, "#ff3d7f");
    x.fillStyle = bg; rr(96, 96, 108, 108, 26); x.fill();
    x.fillStyle = "#fff"; x.textAlign = "center"; x.font = "800 72px -apple-system,Arial,sans-serif"; x.fillText("F", 150, 174);
    x.textAlign = "left"; x.fillStyle = "#fff"; x.font = "800 50px -apple-system,Arial,sans-serif"; x.fillText("FORMORA", 226, 150);
    x.fillStyle = "#9aa4b2"; x.font = "600 23px -apple-system,Arial,sans-serif"; x.fillText("AI PHYSIQUE COACH", 228, 185);
    x.fillStyle = "#fff"; x.font = "800 62px -apple-system,Arial,sans-serif"; x.fillText(String(meName).slice(0, 18), 96, 336);
    x.fillStyle = "#ff9d4d"; x.font = "700 33px -apple-system,Arial,sans-serif"; x.fillText("Chasing " + String(phys).slice(0, 26), 98, 388);
    const cardStat = (sx, val, lbl) => { x.fillStyle = "#191b25"; rr(sx, 448, 288, 210, 24); x.fill(); x.fillStyle = "#fff"; x.textAlign = "center"; x.font = "800 74px -apple-system,Arial,sans-serif"; x.fillText(String(val), sx + 144, 556); x.fillStyle = "#9aa4b2"; x.font = "600 24px -apple-system,Arial,sans-serif"; x.fillText(lbl, sx + 144, 606); x.textAlign = "left"; };
    cardStat(96, streak, "Day streak \ud83d\udd25"); cardStat(396, workouts, "Workouts \ud83d\udcaa"); cardStat(696, score, "Fit score");
    x.fillStyle = "#c7cdd6"; x.font = "600 34px -apple-system,Arial,sans-serif"; x.textAlign = "left";
    if (wt) x.fillText("Now " + wt + " kg" + (p.targetWeightKg ? "   \u2192   Goal " + p.targetWeightKg + " kg" : ""), 96, 762);
    x.fillStyle = "#fff"; x.font = "800 46px -apple-system,Arial,sans-serif"; x.fillText("Building my dream physique \ud83d\udcaa", 96, 902);
    x.fillStyle = "#9aa4b2"; x.font = "600 30px -apple-system,Arial,sans-serif"; x.fillText("Train with me on Formora \u2014 free", 96, 950);
    x.fillStyle = "#ff6b9d"; x.font = "700 29px -apple-system,Arial,sans-serif"; x.fillText(String(url).replace("https://", ""), 96, 998);
    window.Track && Track.event("progress_shared");
    const txt = "My progress on Formora \ud83d\udcaa " + streak + "-day streak, " + workouts + " workouts. Train with me \u2014 free:";
    const self = this;
    C.toBlob(function (blob) {
      if (!blob) { if (self.toast) self.toast("Couldn't build the card \u2014 try again."); return; }
      const file = new File([blob], "formora-progress.png", { type: "image/png" });
      try { if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], text: txt, url: url }).then(function () { if (typeof Social !== "undefined" && Social.haptic) Social.haptic(12); }).catch(function () {}); return; } } catch (e) {}
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "formora-progress.png"; a.click();
      if (navigator.clipboard) navigator.clipboard.writeText(url).catch(function () {});
      if (self.toast) self.toast("Progress card saved \u2014 your invite link is copied \ud83d\udd17");
    }, "image/png");
  },
  // Personalised preview + Pro upsell shown once, right after onboarding (T-16 funnel).
  showWelcome() {
    const p = Store.state.profile;
    const s = Engine.stats();
    const phys = Engine.getPhysique();
    const ep = Engine.experiencePlan();
    const name = ((p.name || "").split(" ")[0]) || "champ";
    const goalW = p.targetWeightKg ? `${Store.latestWeight()} \u2192 <b>${p.targetWeightKg}</b> kg` : `${Store.latestWeight()} kg`;
    window.Track && Track.event("onboarding_completed", { physique: phys.name, goal_kg: p.targetWeightKg || null });
    document.getElementById("modal-card").innerHTML = `
      <div class="welcome">
        <div class="wc-emoji">\ud83c\udf89</div>
        <h2 class="wc-h">You're all set, ${esc(name)}!</h2>
        <p class="wc-sub">Your <b>${esc(phys.name)}</b> plan is ready \u2014 tuned to your body and goal.</p>
        <div class="wc-fig">${this.physiqueFigure(phys.fig)}</div>
        <div class="wc-stats">
          <div class="wc-stat"><div class="v">${goalW}</div><div class="l">Weight goal</div></div>
          <div class="wc-stat"><div class="v">${s.calTarget}</div><div class="l">Daily kcal</div></div>
          <div class="wc-stat"><div class="v">${s.proteinG}g</div><div class="l">Protein/day</div></div>
          <div class="wc-stat"><div class="v">${ep.freq}\u00d7</div><div class="l">Sessions/wk</div></div>
        </div>
        <ul class="wc-inc">
          <li>Adaptive daily workouts for your ${esc(phys.name)}</li>
          <li>Smart meal planner at ${s.calTarget} kcal</li>
          <li>Progress tracking, streaks &amp; the community feed</li>
        </ul>
        <div class="wc-pro" onclick="App.closeModal();App.openPricing()">
          <div class="wc-pro-badge">\u2728 Formora Pro</div>
          <div class="wc-pro-t">Unlock AI multi-week programs, all 115 camera filters &amp; advanced analytics</div>
          <div class="wc-pro-p">See plans \u2192</div>
        </div>
        <button class="btn wide" onclick="App.closeModal()">Start training \ud83d\udcaa</button>
      </div>`;
    document.getElementById("modal").classList.remove("hidden");
  },
  // ---- Pro training programme (T-38). Free members hit the paywall; Pro/Elite get
  // a full periodised multi-week block generated from their profile. ----
  openProgram(week) {
    if (!(typeof Entitlements !== "undefined" && Entitlements.isPro())) { this.openPricing(); return; }
    if (!this._program) this._program = Engine.generateProgram({ unit: this._unit() });
    this.showProgram(typeof week === "number" ? week : (this._programWeek || 0));
  },
  regenProgram() {
    this._progShuffle = (this._progShuffle || 0) + 1;
    this._program = Engine.generateProgram({ unit: this._unit(), shuffle: this._progShuffle });
    this.showProgram(0);
  },
  showProgram(wi) {
    const prog = this._program;
    if (!prog) return;
    this._programWeek = Math.max(0, Math.min(prog.weeks.length - 1, wi || 0));
    const wk = prog.weeks[this._programWeek];
    const tabs = prog.weeks.map((w, i) => `<button class="pw-tab ${i === this._programWeek ? "active" : ""}" onclick="App.showProgram(${i})">W${w.week}${w.deload ? "\u00b7D" : ""}</button>`).join("");
    const days = wk.days.map((d) => `
      <div class="pg-day">
        <div class="pg-day-head"><b>Day ${d.day} \u00b7 ${esc(d.title)}</b><span>${esc(d.focus)}</span></div>
        ${d.exercises.map((x) => `<div class="pg-ex"><div class="pg-ex-n">${x.star ? "\u2605 " : ""}${esc(x.name)}</div><div class="pg-ex-s">${x.sets} \u00d7 ${esc(x.reps)} \u00b7 RPE ${x.rpe}</div></div>`).join("")}
      </div>`).join("");
    document.getElementById("modal-card").innerHTML =
      `<div class="modal-head"><h2>Your ${prog.meta.weeks}-week program</h2><button class="icon-btn" onclick="App.closeModal()">\u2715</button></div>
       <div class="program">
         <div class="pg-meta">${esc(prog.meta.physique)} \u00b7 ${prog.meta.days} days/week \u00b7 ${esc(prog.meta.experience)} \u00b7 \u2605 = priority muscle</div>
         <div class="pg-weeks">${tabs}</div>
         <div class="pg-phase ${wk.deload ? "deload" : ""}"><b>Week ${wk.week} \u2014 ${esc(wk.phase)}</b><span>${esc(wk.note)}</span></div>
         ${days}
         <div class="pg-actions"><button class="btn ghost wide" onclick="App.regenProgram()">\u21bb Regenerate</button></div>
       </div>`;
    document.getElementById("modal").classList.remove("hidden");
  },
  // ---- Pricing / upgrade (T-28). Real checkout wires in once a Merchant-of-Record is live (office T-25). ----
  openPricing() {
    window.Track && Track.event("paywall_opened");
    const P = (window.PRICING && window.PRICING.tiers) || [];
    const cur = (typeof Entitlements !== "undefined") ? Entitlements.tier() : "free";
    const tiers = P.map((t) => `
      <div class="ptier ${t.id === "pro" ? "featured" : ""}">
        ${t.badge ? `<div class="pt-badge">${esc(t.badge)}</div>` : ""}
        <div class="pt-name">${esc(t.name)}</div>
        <div class="pt-price">${t.price === "0" ? "Free" : (typeof Currency !== "undefined" && Currency.isLocal() ? "≈" : "") + (typeof Currency !== "undefined" ? Currency.price(t.price) : "$" + esc(t.price))}<small>${esc(t.period || "")}</small></div>
        ${t.yearly ? `<div class="pt-year">or ${typeof Currency !== "undefined" && Currency.isLocal() ? "≈" : ""}${typeof Currency !== "undefined" ? Currency.yearly(t.yearly) : esc(t.yearly)}${(() => { const my = parseFloat(t.price), yr = parseFloat(String(t.yearly).replace(/[^\d.]/g, "")); const pct = my > 0 && yr > 0 ? Math.round((1 - yr / (my * 12)) * 100) : 0; return pct > 0 ? ` <span class="pt-save">Save ${pct}%</span>` : ""; })()}</div>` : ""}
        <ul class="pt-feats">${(t.features || []).map((f) => `<li${/^Everything in /.test(f) ? ' class="pt-inc"' : ""}>${esc(f)}</li>`).join("")}</ul>
        ${t.id === cur ? `<button class="btn ghost wide" disabled>Current plan</button>` : (window.RAZORPAY && RAZORPAY.enabled && t.id !== "free" && (typeof Currency !== "undefined" && Currency.cur === "INR") ? `<button class="btn wide" onclick="App.choosePlan('${esc(t.id)}','upi')">Pay with UPI</button><button class="btn ghost wide" style="margin-top:6px" onclick="App.choosePlan('${esc(t.id)}','card')">Card / PayPal</button>` : `<button class="btn ${t.id === "pro" ? "" : "ghost "}wide" onclick="App.choosePlan('${esc(t.id)}')">Choose ${esc(t.name)}</button>`)}
      </div>`).join("");
    document.getElementById("modal-card").innerHTML =
      `<div class="modal-head"><h2>Formora plans</h2><button class="icon-btn" onclick="App.closeModal()">✕</button></div>
       <div class="pricing"><div class="pt-lead">Start free. Upgrade when you're ready — cancel anytime.</div>
       <div class="ptiers">${tiers}</div>
       <div class="pt-foot">Secure checkout · Cancel anytime · Powered by Lemon Squeezy</div>${typeof Currency !== "undefined" && Currency.isLocal() ? `<div class="pt-foot" style="opacity:.65;margin-top:6px">Prices shown in your local currency (${esc(Currency.cur)}). International cards are billed in USD.</div>` : ""}</div>`;
    document.getElementById("modal").classList.remove("hidden");
    if (typeof Currency !== "undefined" && !Currency.ready) { Currency.init().then(() => { if (!document.getElementById("modal").classList.contains("hidden")) this.openPricing(); }); }
  },
  _loadRzp() {
    return new Promise(function (resolve, reject) {
      if (window.Razorpay) return resolve();
      const s = document.createElement("script");
      s.src = "https://checkout.razorpay.com/v1/checkout.js";
      s.onload = function () { resolve(); };
      s.onerror = reject;
      document.head.appendChild(s);
    });
  },
  async choosePlan(tier, rail) {
    window.Track && Track.event("plan_selected", { tier: tier, rail: rail || "card" });
    // India UPI rail (Razorpay Standard Checkout) — order made server-side, charged in ₹,
    // uid+tier in notes; the razorpay-webhook grants the entitlement on payment.captured.
    if (rail === "upi" && window.RAZORPAY && RAZORPAY.enabled) {
      const base = (window.SUPABASE_URL || "").replace(/\/$/, "");
      const meR = (typeof Cloud !== "undefined" && Cloud.me) ? Cloud.me : "";
      const emailR = ((typeof Auth !== "undefined" && Auth.currentUser && Auth.currentUser()) || {}).email || "";
      if (!base || !meR) { this.toast("Please log in first"); return; }
      this.toast("Opening UPI checkout…");
      try {
        const r = await fetch(base + "/functions/v1/razorpay-create-order", {
          method: "POST", headers: { "Content-Type": "application/json", apikey: window.SUPABASE_ANON_KEY || "" },
          body: JSON.stringify({ tier, uid: meR, email: emailR }),
        });
        const o = await r.json();
        if (!o || !o.order_id) { this.toast("UPI isn't ready yet — use Card / PayPal"); return; }
        await this._loadRzp();
        const rzp = new Razorpay({
          key: o.key_id, order_id: o.order_id, amount: o.amount, currency: o.currency || "INR",
          name: "Formora", description: (tier === "elite" ? "Elite" : "Pro") + " membership",
          prefill: { email: emailR }, notes: { uid: meR, tier }, theme: { color: "#ff5a4d" },
          handler: function () { App.closeModal(); App.toast("Payment received — unlocking your plan ✨"); setTimeout(function () { if (typeof Entitlements !== "undefined") Entitlements.load(); }, 3000); },
        });
        this.closeModal();
        rzp.open();
      } catch (_) { this.toast("Couldn't open UPI checkout — use Card / PayPal"); }
      return;
    }
    // Global rail — Lemon Squeezy hosted checkout (Merchant of Record). Opens the tier's
    // checkout with the member's email + uid prefilled; the billing-webhook then
    // grants the entitlement server-side. No API key needed on the client.
    const ls = window.LEMONSQUEEZY || {};
    const link = (ls.buy || {})[tier];
    if (link) {
      const me = (typeof Cloud !== "undefined" && Cloud.me) ? Cloud.me : "";
      const email = ((typeof Auth !== "undefined" && Auth.currentUser && Auth.currentUser()) || {}).email || "";
      const q = [];
      if (email) q.push("checkout[email]=" + encodeURIComponent(email));
      if (me) q.push("checkout[custom][uid]=" + encodeURIComponent(me));
      q.push("checkout[custom][tier]=" + encodeURIComponent(tier));
      const url = link + (link.indexOf("?") > -1 ? "&" : "?") + q.join("&");
      this.closeModal();
      const w = window.open(url, "_blank", "noopener");
      if (!w) location.href = url;
      return;
    }
    // Fallback (no link configured for this tier): capture interest locally.
    try { const d = JSON.parse(localStorage.getItem("fm_upgrade_interest") || "{}"); d[tier] = Date.now(); localStorage.setItem("fm_upgrade_interest", JSON.stringify(d)); } catch (_) {}
    this.closeModal();
    this.toast("Saved — you're first in line for " + (tier === "elite" ? "Elite" : "Pro") + " ✨");
  },

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
      items: done.exercises.map((e) => {
        const known = EXERCISES[e.id];
        const it = {
          kind: "primary",
          slotName: (known && known.muscle) || e.muscle || e.name,
          targetSets: e.sets.length || 3,
          reps: "8–12",
          options: known ? [e.id] : [],
          selected: e.id,
          sets: e.sets.map((s) => ({ reps: String(s.reps), weight: String(this._fromKg(s.weight)) })),
        };
        if (!known) it.ex = { id: e.id, name: e.name, muscle: e.muscle || "", equip: e.equip || "", images: [], photo: e.photo || "", tip: "" };
        return it;
      }),
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
      </div>
      <div class="unit-toggle"><span>Weight in</span><button class="ut ${this._unit() === "kg" ? "active" : ""}" onclick="App.setUnit('kg')">kg</button><button class="ut ${this._unit() === "lbs" ? "active" : ""}" onclick="App.setUnit('lbs')">lbs</button></div>`;

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
        <button class="btn ghost wide add-ex-btn" onclick="App.addExercisePicker()">${this.ic("grid", { size: 16 })} Add another exercise — browse with photos</button>
        <button class="btn ghost wide add-ex-btn" style="margin-top:8px" onclick="App.openTextLog()">${this.ic("edit", { size: 16 })} Add by typing what you did</button>
      </div>
      ${this.session.editing ? `<button class="btn wide" onclick="App.finishSession()">Save changes</button>` : this.slideBtn(() => App.finishSession(), "Slide to finish workout")}
      ${this.session.editing ? "" : `<button class="btn ghost wide" style="margin-top:10px" onclick="App.saveProgress()">${this.ic("clock", { size: 16 })} Save &amp; continue later</button>`}
      <button class="btn ghost wide" style="margin-top:10px" onclick="App.cancelSession()">Cancel</button>
    </div>`;
    return html;
  },

  _exOf(it) { return (it && it.ex) || EXERCISES[it && it.selected] || { name: (it && it.selected) || "Exercise", muscle: "", equip: "", tip: "" }; },
  _exImg(it) {
    if (typeof Exercises === "undefined") return "";
    if (it && it.ex) return Exercises.imgFor(it.ex);
    return Exercises.imgForCurated(it && it.selected) || "";
  },
  // verified static female photo for the exercise's muscle group (female profiles only; deterministic, no API)
  _femaleGroupIds(group) {
    if (!this._femGroups) this._femGroups = {};
    if (!this._femGroups[group]) this._femGroups[group] = Object.keys(EXERCISES).filter((id) => this._exGroupOf(EXERCISES[id]) === group);
    return this._femGroups[group];
  },
  _femaleExUrl(ex, key) {
    const p = Store.state.profile;
    if (!p || p.gender !== "female") return "";
    const k = key || (ex && ex.id) || "";
    const exact = (window.FEMALE_EX_BY_ID || {})[k];
    if (exact && exact.length) return exact[0]; // verified per-exercise movement match
    const group = this._exGroupOf(ex);
    const urls = (window.FEMALE_EX_PHOTOS || {})[group] || [];
    if (!urls.length) return "";
    // spread same-group built-in exercises across the photos by their stable list position; else hash
    const pos = this._femaleGroupIds(group).indexOf(k);
    const idx = pos >= 0 ? pos % urls.length : this._hash(k) % urls.length;
    return urls[idx];
  },
  // verified per-exercise match ONLY (no muscle-group fallback) — used by the 800+ library grid
  // so uncurated exercises show their exact movement demo, not a generic same-muscle woman
  _femaleExactUrl(key) {
    const p = Store.state.profile;
    if (!p || p.gender !== "female") return "";
    const exact = (window.FEMALE_EX_BY_ID || {})[key || ""];
    return exact && exact.length ? exact[0] : "";
  },
  // the female photo(s) for the preview: verified per-exercise matches only (up to two).
  // if none exist the preview falls back to the exercise's own accurate demo frames — never a
  // generic same-muscle woman (that mismatch is what kept getting reported)
  _femaleExList(ex, key) {
    const p = Store.state.profile;
    if (!p || p.gender !== "female") return [];
    const exact = (window.FEMALE_EX_BY_ID || {})[key || (ex && ex.id) || ""];
    return exact && exact.length ? exact.slice(0, 2) : [];
  },
  // weight unit: stored canonically in kg, shown/entered in the user's chosen unit
  _unit() { return (Store.state.profile && Store.state.profile.unit) || "kg"; },
  _toKg(v) { const n = +v || 0; return this._unit() === "lbs" ? Math.round(n * 0.453592 * 10) / 10 : n; },
  _fromKg(kg) { const n = +kg || 0; return this._unit() === "lbs" ? Math.round(n * 2.20462 * 10) / 10 : n; },
  _suggest(it) { return Engine.suggestWeight(this._exOf(it), this._unit()); },
  _exHint(it) {
    const id = it.ex ? it.ex.id : it.selected;
    const last = Engine.lastPerformance(id);
    if (last && last.best && last.best.weight > 0) return Engine.overloadHint(id, this._unit());
    const sg = this._suggest(it);
    if (!sg.kg) return "Bodyweight movement — add reps as it gets easier.";
    return `Suggested start ~${sg.text} for your bodyweight &amp; level — use a weight you control for every rep.`;
  },
  itemCard(it, i) {
    const ex = this._exOf(it);
    const done = it.sets.some((s) => s.reps !== "");
    const priority = ex.muscle && Engine.isEmphasized(ex.muscle);
    const demo = this._exImg(it);
    const femUrl = this._femaleExactUrl(it.ex ? it.ex.id : it.selected);
    const img = femUrl || demo;
    const thumbErr = (femUrl && demo) ? `this.onerror=null;this.src='${demo}'` : "this.style.display='none';this.parentElement.classList.add('noimg')";
    const canCycle = it.options && it.options.length > 1;
    return `<div class="slot ${done ? "done" : ""} ${it.kind === "extra" ? "extra" : ""}">
        <div class="slot-head">
          <div class="slot-lead">
            <span class="ex-thumb ${img ? "" : "noimg"}" onclick="App.exPreview(${i})">${img ? `<img src="${img}" alt="${esc(ex.name)}" loading="lazy" onerror="${thumbErr}">` : ""}</span>
            <div class="slot-txt">
              <div class="slot-name">${esc(it.slotName)} · ${it.reps} reps · ${it.targetSets} sets ${priority ? '<span class="prio">★ priority</span>' : ""}</div>
              <div class="ex-name">${esc(ex.name)}</div>
              <div class="ex-meta">${esc(ex.muscle || "")}${ex.equip ? " · " + esc(ex.equip) : ""}</div>
              ${ex.tip ? `<div class="ex-tip">💡 ${esc(ex.tip)}</div>` : ""}
            </div>
          </div>
          <div class="slot-actions">
            <button class="swap" onclick="App.${canCycle ? `swap(${i})` : `replaceExercise(${i})`}">⇄ ${canCycle ? "Swap" : "Replace"}</button>
            <button class="icon-btn" title="Remove exercise" onclick="App.removeItem(${i})">✕</button>
          </div>
        </div>
        <div class="hint">${this._exHint(it)}</div>
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
    const u = this._unit();
    const sug = Engine.suggestWeight(this._exOf(this.session.items[i]), u);
    const wph = sug.kg ? String(sug.shown) : u;
    return this.session.items[i].sets.map((s, j) => `
      <div class="set-row">
        <span class="n">${j + 1}</span>
        <input type="number" inputmode="numeric" placeholder="reps" value="${s.reps}"
          oninput="App.updateSet(${i},${j},'reps',this.value)">
        <input type="number" inputmode="decimal" placeholder="${wph}" value="${s.weight}"
          oninput="App.updateSet(${i},${j},'weight',this.value)">
        <span class="set-unit">${u}</span>
        <button class="icon-btn" onclick="App.removeSet(${i},${j})">✕</button>
      </div>`).join("");
  },
  setUnit(u) {
    const unit = u === "lbs" ? "lbs" : "kg", cur = this._unit();
    if (cur === unit) return;
    if (this.session) this.session.items.forEach((it) => it.sets.forEach((s) => {
      if (s.weight === "" || s.weight == null) return;
      const kg = cur === "lbs" ? (+s.weight || 0) * 0.453592 : (+s.weight || 0);
      s.weight = String(unit === "lbs" ? Math.round(kg * 2.20462 * 10) / 10 : Math.round(kg * 10) / 10);
    }));
    Store.state.profile.unit = unit; Store.save();
    this.renderToday();
  },

  swap(i) {
    const it = this.session.items[i];
    if (!it.options || it.options.length < 2) return this.replaceExercise(i);
    const cur = it.options.indexOf(it.selected);
    it.selected = it.options[(cur + 1) % it.options.length];
    it.ex = null;
    this.renderToday();
  },
  addExercisePicker() { if (typeof Exercises !== "undefined") Exercises.open((ex) => App.addExerciseFromCatalog(ex)); },
  addExerciseFromCatalog(ex) {
    if (!this.session || !ex) return;
    this.session.items.push({
      kind: "extra", slotName: (ex.muscle || "Custom") + " · added", targetSets: 3, reps: "8–12",
      options: [], selected: ex.id,
      ex: { id: ex.id, name: ex.name, muscle: ex.muscle || "", equip: ex.equip || "", images: ex.images || [], tip: ex.tip || "" },
      sets: [{ reps: "", weight: "" }],
    });
    this.renderToday();
    if (this.toast) this.toast("Added " + ex.name);
  },
  replaceExercise(i) {
    if (typeof Exercises === "undefined") return;
    Exercises.open((ex) => {
      const it = App.session && App.session.items[i]; if (!it) return;
      it.selected = ex.id; it.options = [];
      it.ex = { id: ex.id, name: ex.name, muscle: ex.muscle || "", equip: ex.equip || "", images: ex.images || [], tip: ex.tip || "" };
      it.slotName = ex.muscle || it.slotName;
      App.renderToday();
    });
  },
  // tap a slot photo to see the movement (start + end frames) and the cue
  exPreview(i) {
    const it = this.session && this.session.items[i]; if (!it) return;
    const ex = this._exOf(it);
    const base = this._exImg(it);
    let frames = [];
    if (it.ex && it.ex.images && it.ex.images.length) frames = it.ex.images.map((im) => Exercises.CDN + "/exercises/" + im);
    else if (base) { frames = [base]; const alt = base.replace(/\/0\.jpg$/, "/1.jpg"); if (alt !== base) frames.push(alt); }
    const femList = this._femaleExList(ex, it.ex ? it.ex.id : it.selected);
    const card = document.getElementById("modal-card"); if (!card) return;
    const media = femList.length
      ? `<div class="exp-frames ${femList.length > 1 ? "" : "one"}">${femList.map((u) => `<img src="${u}" alt="reference" loading="lazy"${base ? ` onerror="this.onerror=null;this.src='${base}'"` : ""}>`).join("")}</div>`
      : (frames.length ? `<div class="exp-frames">${frames.map((f) => `<img src="${f}" alt="${esc(ex.name)}" loading="lazy" onerror="this.closest('.exp-frames').classList.add('noimg')">`).join("")}</div>` : `<div class="exp-frames noimg"></div>`);
    card.innerHTML = `<div class="modal-head"><h2>${esc(ex.name)}</h2><button class="icon-btn" onclick="App.closeModal()">✕</button></div>
      <div class="ex-preview">
        ${media}
        <div class="exp-sub">${esc(ex.muscle || "")}${ex.equip ? " · " + esc(ex.equip) : ""}</div>
        ${ex.tip ? `<div class="ex-tip">💡 ${esc(ex.tip)}</div>` : ""}
      </div>`;
    document.getElementById("modal").classList.remove("hidden");
  },
  addExtra(exId) {
    if (!exId) return;
    const group = groupOf(exId);
    this.session.items.push({ kind: "extra", slotName: `${group} · extra`, targetSets: 3, reps: "8–12", options: MUSCLE_GROUPS[group], selected: exId, sets: [{ reps: "", weight: "" }] });
    this.renderToday();
  },
  removeItem(i) {
    if (!this.session) return;
    if (this.session.items.length <= 1) { if (this.toast) this.toast("Keep at least one exercise"); return; }
    const ex = this._exOf(this.session.items[i]);
    if (!confirm("Remove " + (ex.name || "this exercise") + "?")) return;
    this.session.items.splice(i, 1);
    this.renderToday();
  },
  removeExtra(i) { this.removeItem(i); },
  addSet(i) { this.session.items[i].sets.push({ reps: "", weight: "" }); this.refreshSets(i); },
  removeSet(i, j) {
    if (this.session.items[i].sets.length > 1) this.session.items[i].sets.splice(j, 1);
    this.renderToday();
  },
  updateSet(i, j, k, v) { this.session.items[i].sets[j][k] = v; this._saveDraft(); },
  refreshSets(i) { document.getElementById(`sets-${i}`).innerHTML = this.setRows(i); },

  cancelSession() { this.session = null; Store.state.draftSession = null; Store.save(); this.renderToday(); },

  askCoach(preset) {
    const inp = document.getElementById("ask-q");
    if (preset && inp) inp.value = preset;
    const q = preset || (inp ? inp.value : "") || "";
    const box = document.getElementById("ask-answer"); if (!box) return;
    if (!q.trim()) { box.innerHTML = ""; return; }
    const a = Engine.coachAnswer(q);
    box.innerHTML = `<div class="ans-title">${esc(a.title)}</div>
      <ul class="ans-list">${a.points.map((pt) => `<li>${esc(pt)}</li>`).join("")}</ul>
      <div class="ans-foot">General guidance from your stats — not medical advice.</div>`;
  },

  // build a workout entry from the logged sets in the current session
  _buildEntry() {
    const exercises = [];
    let volume = 0;
    this.session.items.forEach((it) => {
      const sets = it.sets
        .filter((s) => s.reps !== "")
        .map((s) => ({ reps: +s.reps || 0, weight: this._toKg(s.weight) }));
      if (!sets.length) return;
      const ex = this._exOf(it);
      sets.forEach((s) => (volume += s.reps * s.weight));
      const rec = { id: it.ex ? it.ex.id : it.selected, name: ex.name, muscle: ex.muscle, sets };
      if (it.ex && typeof Exercises !== "undefined" && Exercises.imgFor(it.ex)) rec.photo = Exercises.imgFor(it.ex);
      exercises.push(rec);
    });
    return { exercises, volume };
  },
  // persist the open session so it survives navigation/reload (resume later the same day)
  _saveDraft() {
    if (!this.session || this.session.editing) return;
    Store.state.draftSession = { date: todayISO(), session: this.session };
    clearTimeout(this._draftTimer);
    this._draftTimer = setTimeout(() => { try { Store.save(); } catch (e) {} }, 400);
  },
  // save what's logged so far into today's workout WITHOUT ending the session
  saveProgress() {
    if (!this.session) return;
    const { exercises, volume } = this._buildEntry();
    const date = this.session.editing ? this.session.origDate : todayISO();
    Store.state.workoutLog = Store.state.workoutLog.filter((w) => w.date !== date);
    if (exercises.length) Store.logWorkout({ date, split: this.session.split, exercises, volume });
    Store.state.draftSession = { date: todayISO(), session: this.session };
    Store.save();
    this.renderChips();
    this.renderToday();
    if (this.toast) this.toast(exercises.length ? "Saved — resume and finish anytime today" : "Progress saved");
  },
  finishSession() {
    const { exercises, volume } = this._buildEntry();
    if (!exercises.length) { alert("Log at least one set before finishing."); return; }
    const isEdit = !!this.session.editing;
    const date = isEdit ? this.session.origDate : todayISO();
    Store.state.workoutLog = Store.state.workoutLog.filter((w) => w.date !== date);
    Store.logWorkout({ date, split: this.session.split, exercises, volume });
    this.session = null;
    Store.state.draftSession = null;
    Store.save();
    this.renderChips();
    this.renderToday();
    if (!isEdit) { this.celebrate(); this.toast(`Workout saved 💪 ${exercises.length} exercise${exercises.length > 1 ? "s" : ""} logged`); }
  },

  // tasteful confetti burst for win-moments (workout saved). Appended to <body> like _heartBurst, self-removing.
  celebrate() {
    const c = document.createElement("div");
    c.className = "confetti";
    const colors = ["var(--accent)", "var(--accent2)", "#12b981", "#f5c451", "#ffffff"];
    let html = "";
    for (let i = 0; i < 16; i++) {
      html += `<i style="left:${Math.round(Math.random() * 100)}%;background:${colors[i % colors.length]};animation-delay:${(Math.random() * 0.25).toFixed(2)}s;animation-duration:${(0.9 + Math.random() * 0.6).toFixed(2)}s"></i>`;
    }
    c.innerHTML = html;
    document.body.appendChild(c);
    try { navigator.vibrate && navigator.vibrate([16, 40, 16]); } catch (_) {}
    setTimeout(() => c.remove(), 2000);
  },

  /* ---------------- TEXT (NATURAL-LANGUAGE) LOGGING ---------------- */
  openTextLog() {
    const card = document.getElementById("modal-card"); if (!card) return;
    const u = this._unit();
    card.innerHTML = `<div class="modal-head"><h2>Type your workout</h2><button class="icon-btn" onclick="App.closeModal()">✕</button></div>
      <div class="sub">Write what you did — one exercise per line. I'll find the exercise and log your sets. Forgot the reps? I'll fill 10 — edit before saving.</div>
      <textarea id="tl-text" class="tl-text" rows="6" placeholder="Overhead Barbell Press 1 set 15${u} 2 sets 20${u}\nBench Press 3x10 60${u}\nLat Pulldown 3 sets of 12 reps 50${u}"></textarea>
      <div id="tl-preview" class="tl-preview"></div>
      <div class="tl-actions">
        <button class="btn ghost" onclick="App.closeModal()">Cancel</button>
        <button class="btn" onclick="App.commitTextLog()">Add to today →</button>
      </div>`;
    document.getElementById("modal").classList.remove("hidden");
    const ta = document.getElementById("tl-text");
    if (ta) { ta.oninput = () => this.previewTextLog(); ta.focus(); }
  },
  previewTextLog() {
    const box = document.getElementById("tl-preview"); if (!box) return;
    const parsed = Engine.parseWorkoutText((document.getElementById("tl-text") || {}).value || "", this._unit());
    if (!parsed.length) { box.innerHTML = ""; return; }
    const u = this._unit();
    box.innerHTML = parsed.map((r) => {
      const setTxt = r.sets.length
        ? r.sets.map((s) => `${s.reps > 0 ? s.reps + "×" : ""}${this._fromKg(s.weight)}${u}`).join(", ")
        : "add a weight so I can log it";
      return `<div class="tl-row ${r.matched ? "" : "tl-unmatched"}">
        <div class="tl-name">${esc(r.name)}${r.matched ? "" : ' <span class="tl-warn">— logged as typed</span>'}</div>
        <div class="tl-sets">${esc(setTxt)}</div></div>`;
    }).join("");
  },
  commitTextLog() {
    const parsed = Engine.parseWorkoutText((document.getElementById("tl-text") || {}).value || "", this._unit());
    const withSets = parsed.filter((r) => r.sets.length);
    if (!withSets.length) { alert("Add at least one exercise with a weight, e.g. “Bench Press 3x10 60kg”."); return; }
    const items = withSets.map((r) => {
      const known = r.id && EXERCISES[r.id];
      const it = {
        kind: "primary",
        slotName: r.muscle || r.name,
        targetSets: r.sets.length,
        reps: "8–12",
        options: known ? [r.id] : [],
        selected: r.id || r.name,
        sets: r.sets.map((s) => ({ reps: String(s.reps > 0 ? s.reps : 10), weight: String(this._fromKg(s.weight)) })),
      };
      if (!known) it.ex = { id: r.id || r.name, name: r.name, muscle: r.muscle || "", equip: "", images: [], photo: "", tip: "" };
      return it;
    });
    if (this.session) this.session.items = this.session.items.concat(items);
    else this.session = { split: Engine._splitForMuscles(withSets.map((r) => r.muscle)), items };
    this.closeModal();
    this.renderToday();
    if (this.toast) this.toast(`Added ${items.length} exercise${items.length > 1 ? "s" : ""} — review the reps and save`);
  },

  /* ---------------- PROGRESS ---------------- */
  renderProgress() {
    const el = document.getElementById("view-progress");
    const t = Engine.weightTrend();
    const arrow = t.dir === "up" ? "▲" : t.dir === "down" ? "▼" : "▬";
    const gp = Engine.goalProgress();
    const sp = Engine.strengthProfile();
    const recs = Engine.weaknessRecs();
    const isPro = typeof Entitlements !== "undefined" && Entitlements.isPro();
    const vt = isPro ? Engine.volumeTrend(8) : [];
    const lifts = isPro ? Engine.liftProgress(5) : [];
    const advanced = isPro
      ? `<div class="card">
          <h2>Training volume <span class="pro-tag">PRO</span></h2>
          <div class="sub">Weekly tonnage (reps × weight) · last 8 weeks — trending up means progressive overload</div>
          <div id="vol-chart"></div>
        </div>
        <div class="card">
          <h2>Strength progression <span class="pro-tag">PRO</span></h2>
          <div class="sub">Estimated 1-rep max per lift (Epley) · change since you started logging it</div>
          ${lifts.length ? `<div class="lift-tbl">${lifts.map((l) => `<div class="lift-row"><span class="lift-n">${esc(l.name)}</span><span class="lift-1rm">${this._fromKg(l.e1rm)} ${this._unit()}</span><span class="lift-d ${l.delta >= 0 ? "up" : "down"}">${l.delta >= 0 ? "▲" : "▼"} ${this._fromKg(Math.abs(l.delta))}</span></div>`).join("")}</div>` : `<div class="chart-empty">Log the same lift on 2+ days to see progression.</div>`}
        </div>`
      : `<div class="card upgrade-card" onclick="App.openPricing()">
          <div class="uc-glow"></div>
          <div class="uc-badge">✨ Formora Pro</div>
          <div class="uc-title">Unlock analytics &amp; progress photos</div>
          <div class="uc-price">Volume trends · 1-rep-max progression · progress photo studio · deeper insights</div>
          <button class="btn wide uc-btn" onclick="event.stopPropagation();App.openPricing()">See plans →</button>
        </div>`;
    const photoStudio = isPro ? this.renderPhotoStudio() : "";
    el.innerHTML = `
      <div class="card goal-card">
        <h2>Progress to your goal</h2>
        <div class="sub">${esc(Engine.getPhysique().name)} — a ${esc(gp.look)}</div>
        <div class="goal-flex">
          <div id="goal-ring"></div>
          <div class="goal-legend">
            <div class="gl-row"><span>Body fat</span><b>${gp.bodyFat}% <small>→ ${gp.targetLo}–${gp.targetHi}%</small></b></div>
            <div class="gl-row"><span>Consistency</span><b>${gp.consistency}%</b></div>
            ${gp.wScore != null ? `<div class="gl-row"><span>Weight goal</span><b>${gp.wScore}%</b></div>` : ""}
            <div class="gl-note">${gp.atGoal ? "You're in your target range — maintain &amp; refine." : "Keep training and dialing in nutrition to close the gap."}</div>
          </div>
        </div>
      </div>
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
        <button class="btn ghost wide" onclick="App.shareProgress()" style="margin-top:12px">📣 Share my progress card</button>
      </div>
      <div class="card">
        <h2>Strength &amp; weakness</h2>
        <div class="sub">${sp.enough ? "Where you're developed vs lagging — across all your logs" : "Log 3+ workouts to reveal your strong &amp; weak areas"}</div>
        <div class="strength-bars">
          ${sp.data.map((d) => `<div class="bar-row">
            <span class="bar-label">${d.label.replace(" Day", "")}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${d.sessions ? d.dev : 0}%;background:${SPLITS[d.split].accent}"></div></div>
            <span class="bar-val">${d.sessions ? d.dev + "%" : "—"}</span>
          </div>`).join("")}
        </div>
        ${sp.enough && recs.length ? `<div class="weak-recs"><b>Bring up your ${esc(sp.weakest.label.toLowerCase())}:</b> ${recs.map((r) => esc(r.name)).join(" · ")}</div>` : ""}
      </div>
      <div class="card">
        <h2>Muscle balance</h2>
        <div class="sub">Sets per split · last 4 weeks</div>
        <div id="balance"></div>
      </div>
      ${advanced}
      ${photoStudio}
      <div class="card"><h2>Coach's read</h2>
        <ul class="guide">${Engine.guidance().map((m) => `<li>${m}</li>`).join("")}</ul>
      </div>`;
    Charts.ring(document.getElementById("goal-ring"), gp.overall, "to goal");
    Charts.weightLine(document.getElementById("weight-chart"), Store.state.weightLog, Store.state.profile.targetWeightKg);
    Charts.bars(document.getElementById("balance"), Engine.muscleBalance());
    if (isPro) Charts.columns(document.getElementById("vol-chart"), vt);
  },

  saveWeight() {
    const v = parseFloat(document.getElementById("w-input").value);
    if (!v || v < 30 || v > 250) { alert("Enter a valid weight in kg."); return; }
    Store.logWeight(v);
    this.renderChips();
    this.renderProgress();
  },

  // ---- Progress Photo Studio (Pro) — private, on-device visual progress ----
  _progKey() { return "fm_progress_" + (((typeof Auth !== "undefined" && Auth.currentUser && Auth.currentUser()) || {}).id || "me"); },
  progressPhotos() { try { return JSON.parse(localStorage.getItem(this._progKey()) || "[]").sort((a, b) => a.ts - b.ts); } catch (e) { return []; } },
  addProgressPhoto() {
    if (!(typeof Entitlements !== "undefined" && Entitlements.isPro())) return this.openPricing();
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = "image/*"; inp.hidden = true;
    inp.addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0]; inp.remove();
      if (!f) return;
      resizeImage(f, 760, 0.68).then((url) => {
        let arr = this.progressPhotos();
        arr.push({ id: "p" + Date.now(), ts: Date.now(), url, weightKg: Store.latestWeight(), bodyFat: Engine.stats().bodyFat });
        arr = arr.slice(-40);
        try { localStorage.setItem(this._progKey(), JSON.stringify(arr)); }
        catch (err) { alert("Storage is full — delete a few older progress photos and try again."); return; }
        if (this.toast) this.toast("Progress photo saved \ud83d\udcf8");
        this.renderProgress();
      }).catch(() => alert("Couldn't read that image."));
    });
    document.body.appendChild(inp); inp.click();
  },
  removeProgressPhoto(id) {
    if (!confirm("Delete this progress photo?")) return;
    const arr = this.progressPhotos().filter((p) => p.id !== id);
    try { localStorage.setItem(this._progKey(), JSON.stringify(arr)); } catch (e) {}
    this.closeModal(); this.renderProgress();
  },
  viewProgressPhoto(id) {
    const p = this.progressPhotos().find((x) => x.id === id); if (!p) return;
    document.getElementById("modal-card").innerHTML = `<div class="modal-head"><h2>${new Date(p.ts).toLocaleDateString()}</h2><button class="icon-btn" onclick="App.closeModal()">✕</button></div>
      <img class="pp-full" src="${esc(p.url)}" alt="progress photo">
      <div class="pp-meta">${p.weightKg} kg · ~${p.bodyFat}% body fat</div>
      <button class="btn ghost wide" style="margin-top:12px" onclick="App.removeProgressPhoto('${p.id}')">Delete photo</button>`;
    document.getElementById("modal").classList.remove("hidden");
  },
  renderPhotoStudio() {
    const arr = this.progressPhotos();
    let cmp = "";
    if (arr.length >= 2) {
      const a = arr[0], b = arr[arr.length - 1];
      const days = Math.max(1, Math.round((b.ts - a.ts) / 86400000));
      const dW = Math.round((b.weightKg - a.weightKg) * 10) / 10;
      const dBF = Math.round((b.bodyFat - a.bodyFat) * 10) / 10;
      const workouts = (Store.state.workoutLog || []).filter((w) => { const t = Date.parse(w.date); return t >= a.ts - 86400000 && t <= b.ts + 86400000; }).length;
      const wTxt = dW === 0 ? "held your weight" : `${dW < 0 ? "lost" : "gained"} ${Math.abs(dW)} kg`;
      const bfTxt = dBF === 0 ? "" : ` and ${dBF < 0 ? "dropped" : "added"} ${Math.abs(dBF)}% body fat`;
      const closer = (dW < 0 || dBF < 0) ? `The camera doesn't lie — real progress toward your ${esc(Engine.getPhysique().name)} \ud83d\udcaa` : `Keep stacking sessions — your ${esc(Engine.getPhysique().name)} is being built rep by rep.`;
      cmp = `<div class="pp-ba"><figure><img src="${esc(a.url)}"><figcaption>Start · ${a.weightKg}kg</figcaption></figure><figure><img src="${esc(b.url)}"><figcaption>Now · ${b.weightKg}kg</figcaption></figure></div>
        <div class="pp-analysis"><b>Your ${days}-day change:</b> you've ${wTxt}${bfTxt} across ${workouts} logged workout${workouts === 1 ? "" : "s"}. ${closer}</div>`;
    }
    const strip = arr.slice().reverse().map((p) => `<button class="pp-thumb" onclick="App.viewProgressPhoto('${p.id}')"><img src="${esc(p.url)}" alt="progress"><span>${new Date(p.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span></button>`).join("");
    return `<div class="card">
      <h2>Progress photos <span class="pro-tag">PRO</span></h2>
      <div class="sub">Your visual transformation — stored privately on this device</div>
      ${cmp}
      ${arr.length ? `<div class="pp-strip">${strip}</div>` : `<div class="chart-empty">Add your first progress photo — then one every 1–2 weeks to watch your body change.</div>`}
      <button class="btn wide" style="margin-top:12px" onclick="App.addProgressPhoto()">${this.ic("camera", { size: 16 })} Add progress photo</button>
    </div>`;
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
    const tags = est.items.map((i) => {
      const q = Math.round(i.qty * 10) / 10;
      const ql = Math.abs(q - 1) <= 0.1 ? "" : `${q}× `;
      return `<span class="food-tag">${ql}${esc(i.name)} · ${i.kcal}kcal · ${i.protein}g</span>`;
    }).join("");
    const unk = est.unknown.length
      ? `<div class="est-unknown">⚠️ Couldn't identify: ${esc(est.unknown.join(", "))}. Adjust totals below if needed.</div>` : "";
    return `<div class="estimate">
      <div class="est-top">
        <div class="est-tile"><div class="est-v">~${est.kcal}</div><div class="est-l">calories</div></div>
        <div class="est-tile"><div class="est-v">${est.protein}g</div><div class="est-l">protein</div></div>
      </div>
      ${est.text ? `<div class="est-meal">🍽️ ${esc(est.text)}</div>` : ""}
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
  // AI meal plans are a Pro feature. Free members get a few tastes, then the
  // paywall opens — Pro/Elite generate & regenerate without limit.
  _planGate() {
    if (typeof Entitlements !== "undefined" && Entitlements.isPro()) return true;
    const FREE = 3;
    const used = +(localStorage.getItem("fm_plan_gens") || 0);
    if (used >= FREE) { this.openPricing(); return false; }
    localStorage.setItem("fm_plan_gens", String(used + 1));
    return true;
  },
  generatePlan() {
    if (!this._planGate()) return;
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
        <button class="btn ghost" onclick="App.showGroceryList()">🛒 Grocery list</button>
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

  // ---- grocery list from the day plan (T-18) ----
  // Meal names are already " + "-separated components (e.g. "Chicken curry + rice + salad"),
  // so we split, drop parentheticals/leading quantities, and aggregate into a shopping list.
  groceryItems() {
    const p = this.dayPlan;
    if (!p) return [];
    const counts = {}, order = [];
    const add = (name) => {
      for (let part of String(name).split("+")) {
        part = part.replace(/\([^)]*\)/g, " ").replace(/^\s*\d+\s+/, "").trim();
        if (!part) continue;
        const key = part.toLowerCase();
        if (!(key in counts)) { counts[key] = { label: part, n: 0 }; order.push(key); }
        counts[key].n++;
      }
    };
    for (const x of p.plan) add(x.meal.name);
    for (const a of (p.addons || [])) add(a.name);
    return order.map((k) => counts[k]);
  },
  showGroceryList() {
    const items = this.groceryItems();
    if (!items.length) { this.toast && this.toast("Generate a plan first"); return; }
    this._groceryText = "Formora — grocery list\n" + items.map((it) => "• " + it.label + (it.n > 1 ? ` ×${it.n}` : "")).join("\n");
    const li = items.map((it) => `<li style="padding:7px 0;border-bottom:1px solid rgba(255,255,255,.06);display:flex;justify-content:space-between;align-items:center"><span>${esc(it.label)}</span>${it.n > 1 ? `<span class="pm-portion">×${it.n}</span>` : ""}</li>`).join("");
    document.getElementById("modal-card").innerHTML =
      `<div class="modal-head"><h2>🛒 Grocery list</h2><button class="icon-btn" onclick="App.closeModal()">✕</button></div>
       <div class="sub" style="margin:-4px 0 10px">Auto-built from today's plan — a starting shopping list.</div>
       <ul style="list-style:none;padding:0;margin:0 0 14px">${li}</ul>
       <div class="plan-actions">
         <button class="btn ghost" onclick="App.copyGrocery()">Copy list</button>
         <button class="btn" onclick="App.shareGrocery()">Share</button>
       </div>`;
    document.getElementById("modal").classList.remove("hidden");
  },
  copyGrocery() {
    const t = this._groceryText || "";
    if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => this.toast && this.toast("Copied ✓"));
  },
  shareGrocery() {
    const text = this._groceryText || "";
    if (navigator.share) navigator.share({ title: "Grocery list", text }).catch(() => {});
    else this.copyGrocery();
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
    const est = FoodEstimator.parse(text);
    est.text = FoodEstimator.summary(est) || text || "Photo meal";
    this.foodEstimate = est;
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
          <div><b>${cloudOn ? Social.connectionsCount() : Social.crewList().length}</b><span>Connections</span></div>
          <div><b>${cloudOn ? Social.followersCount() : 0}</b><span>Followers</span></div>
          <div><b>${cloudOn ? Social.followingCount() : 0}</b><span>Following</span></div>
          <div><b>${myPosts.length}</b><span>Posts</span></div>
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
          <button class="btn ghost" onclick="Social.inviteFriends()">Invite friends 🎁</button>
          <button class="btn ghost" onclick="Social.openSaved()">🔖 Saved</button>
        </div>
        <div class="sub">Real LinkedIn/Facebook sign-in can be wired later (needs app setup) — for now these are your public links.</div>
      </div>
      <div class="card upgrade-card" onclick="App.openPricing()">
        <div class="uc-glow"></div>
        <div class="uc-badge">✨ Formora Pro</div>
        <div class="uc-title">Unlock AI plans, all filters &amp; advanced analytics</div>
        <div class="uc-price">From <b>$7.99</b>/mo · 5-day free trial</div>
        <button class="btn wide uc-btn" onclick="event.stopPropagation();App.openPricing()">See plans →</button>
      </div>
      ${myPosts.length ? `<div class="card"><div class="card-head"><h2>Your posts</h2><span class="tag">${myPosts.length}</span></div>${myPosts.map((x) => Social.postCard(cloudOn ? Social._cloudPost(x) : x)).join("")}</div>` : ""}
      <div class="card">
        <h2>Your fitness dashboard</h2>
        <div class="sub">Auto-calculated from your profile, workouts &amp; latest weight</div>
        <div class="stat-grid">
          <div class="stat"><div class="v">${Store.latestWeight()}<small>kg</small></div><div class="l">${p.targetWeightKg ? "Goal " + p.targetWeightKg + "kg" : "Current weight"}</div></div>
          <div class="stat"><div class="v">${s.bmi}</div><div class="l">BMI · ${s.bmiClass}</div></div>
          <div class="stat"><div class="v">${s.bodyFat}<small>%</small></div><div class="l">Body fat · ${Engine.bodyComp().bfClass}</div></div>
          <div class="stat"><div class="v">${Engine.streak()}</div><div class="l">Day streak 🔥</div></div>
          <div class="stat"><div class="v">${(Store.state.workoutLog || []).length}</div><div class="l">Workouts logged</div></div>
          <div class="stat"><div class="v">${s.proteinG}<small>g</small></div><div class="l">Protein / day</div></div>
          <div class="stat"><div class="v">${s.calTarget}</div><div class="l">Target kcal</div></div>
          <div class="stat"><div class="v">${s.bmr}</div><div class="l">BMR kcal</div></div>
          <div class="stat"><div class="v">${s.tdee}</div><div class="l">TDEE kcal</div></div>
        </div>
        <div class="comp-advice">${esc(Engine.bodyComp().advice)}</div>
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
      </div>
      <div class="card about-card">
        <div class="about-brand"><svg viewBox="0 0 44 44" width="26" height="26" fill="none" aria-hidden="true"><defs><linearGradient id="alg" x1="4" y1="4" x2="40" y2="40" gradientUnits="userSpaceOnUse"><stop stop-color="#ff9d4d"/><stop offset=".55" stop-color="#ff5a4d"/><stop offset="1" stop-color="#ff3d7f"/></linearGradient></defs><rect x="2" y="2" width="40" height="40" rx="13" fill="url(#alg)"/><path d="M15.5 31.5V16.2c0-1.5 1.2-2.7 2.7-2.7H30" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/><path d="M15.5 22.4h10" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/><circle cx="29.6" cy="29.6" r="2.7" fill="#fff"/></svg><span>Formora</span></div>
        <div class="about-ver">Version ${window.APP_VERSION || "1.0.0"}</div>
        <div class="about-sub">Your aesthetic physique coach — train · track · connect.</div>
        <div class="about-legal"><a href="legal.html#terms" target="_blank" rel="noopener">Terms</a> · <a href="legal.html#privacy" target="_blank" rel="noopener">Privacy</a> · <a href="legal.html#disclaimer" target="_blank" rel="noopener">Health disclaimer</a></div>
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
    if (typeof Entitlements !== "undefined") Entitlements.load();
    let last = "";
    Cloud.start((s) => {
      Social.cloud.users = Object.values(s.users || {}).filter((x) => x.uid !== Cloud.me);
      Social.cloud.requests = Object.values(s.requests || {}).filter((r) => r.to === Cloud.me && r.status === "pending");
      Social.cloud.sent = Object.values(s.requests || {}).filter((r) => r.from === Cloud.me).map((r) => r.to);
      Social.cloud.connections = Object.values(s.requests || {}).filter((r) => r.status === "accepted" && (r.from === Cloud.me || r.to === Cloud.me)).map((r) => (r.from === Cloud.me ? r.to : r.from));
      Social.cloud.feed = Object.values(s.posts || {}).sort((a, b) => (b.ts || 0) - (a.ts || 0));
      Social.cloud.comments = Object.values(s.comments || {});
      Social.cloud.stories = Object.values(s.stories || {}).sort((a, b) => (a.ts || 0) - (b.ts || 0));
      Social.syncAutoFollow();
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
    // presence heartbeat — refresh my profile.seen so others see me "online"
    if (this._hb) clearInterval(this._hb);
    this._hb = setInterval(() => { if (typeof Cloud !== "undefined" && Cloud.active() && Cloud.me) Cloud.registerMe(Store.state.profile); }, 60000);
  },
  async pollNotifs() {
    if (typeof Cloud === "undefined" || !Cloud.active()) return;
    const list = await Cloud.getNotifications();
    Social.cloud.notifs = list || [];
    // message sound: chime once per NEW unread message notif (seed on first poll so we don't blast on load)
    if (!Social._pinged) Social._pinged = new Set();
    const nkey = (n) => n.id || (n.type + "|" + n.actor + "|" + n.ts);
    if (this._notifSeeded) {
      (list || []).forEach((n) => {
        if (n.type === "message" && !n.read && !Social._pinged.has(nkey(n))) {
          Social._pinged.add(nkey(n));
          const chatOpen = Social.sub === "chat" && Social._dmWith === n.actor;
          if (!chatOpen && !Social.isMuted(n.actor) && Social.playPing) Social.playPing();
        }
      });
    } else { (list || []).forEach((n) => Social._pinged.add(nkey(n))); this._notifSeeded = true; }
    // instant connect: if someone accepted my request, reflect it now (don't wait for the 12s state poll)
    let gained = false;
    (list || []).forEach((n) => { if (n.type === "accept" && n.actor && !(Social.cloud.connections || []).includes(n.actor)) { (Social.cloud.connections = Social.cloud.connections || []).push(n.actor); gained = true; } });
    if (gained) { Social.syncAutoFollow(); const v = document.getElementById("view-feed"); if (v && v.classList.contains("active")) Social.render(); }
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
    const map = { like: "❤️ liked your post", comment: "💬 commented on your post", reply: "↩️ replied to you", mention: "@ mentioned you", connect: "🤝 wants to connect", accept: "✅ accepted your request — you're connected", reshare: "🔁 reshared your post", message: "✉️ sent you a message", follow: "➕ started following you" };
    return `<b>${esc(who)}</b> ${map[n.type] || esc(n.type)}${n.body ? ` — “${esc((n.body || "").slice(0, 40))}”` : ""}`;
  },
  renderNotifPanel() {
    const list = Social.cloud.notifs || [];
    const body = list.length ? list.map((n) => `<div class="notif-item ${n.read ? "" : "unread"}" onclick="App.openNotif('${n.actor}','${n.type}')">${Social.avatar(Social.cloudUser(n.actor) || { name: "?", colors: ["#8b93a7", "#262c3a"] }, 38)}<div class="notif-txt">${this.notifText(n)}<div class="notif-time">${Social.timeAgo(n.ts)}</div></div></div>`).join("") : this.emptyState("bell", "No activity yet", "Likes, comments and new connections will show up here.");
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
