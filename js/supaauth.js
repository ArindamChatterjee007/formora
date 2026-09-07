/* ============================================================
   SUPABASE AUTH (GoTrue) — real email login so the database can
   TRUST who the caller is. When window.USE_SUPABASE_AUTH is on, the
   app authenticates against Supabase and every cloud request carries
   the signed-in user's JWT (not just the public anon key). That JWT
   is what Row Level Security (see supabase/security.sql) uses to
   sandbox each user to their own rows.

   Off by default — flip window.USE_SUPABASE_AUTH = true in config.js
   AFTER you enable the Email provider in the Supabase dashboard and
   run supabase/security.sql.
   ============================================================ */
const SupaAuth = {
  KEY: "formora_supa_session",
  session: null,
  _timer: null,
  _revision: 0,
  _refreshing: null,
  _authAttempt: 0,
  _authEpoch: 0,

  active() { return !!(window.USE_SUPABASE_AUTH && window.SUPABASE_URL && window.SUPABASE_ANON_KEY); },
  _base() { return (window.SUPABASE_URL || "").replace(/\/$/, "") + "/auth/v1"; },
  _hdr(extra) { return Object.assign({ apikey: window.SUPABASE_ANON_KEY, "Content-Type": "application/json" }, extra || {}); },

  load() {
    let stored;
    try { stored = JSON.parse(localStorage.getItem(this.KEY)) || null; } catch { stored = null; }
    if (["access_token", "refresh_token", "uid", "email", "expires_at"].some(key => stored?.[key] !== this.session?.[key])) {
      const previousUid = this.session?.uid;
      if (previousUid !== stored?.uid || this.session?.email !== stored?.email) this._authEpoch++;
      this._revision++;
      this.session = stored;
      this._scheduleRefresh();
      if (previousUid !== stored?.uid) window.dispatchEvent?.(new Event("formora:sessionchange"));
    }
    return this.session;
  },
  clear() {
    this._revision++;
    this._authAttempt++;
    this._authEpoch++;
    this.session = null;
    this._refreshing = null;
    clearTimeout(this._timer);
    this._timer = null;
    try { localStorage.removeItem(this.KEY); } catch (_) {}
    window.dispatchEvent?.(new Event("formora:sessionchange"));
  },
  cancelAuthAttempt() { this._authAttempt++; },
  email() { return (this.session && this.session.email) || ""; },
  uid() { if (!this.active()) return ""; if (!this.session) this.load(); return (this.session && this.session.uid) || ""; },
  // synchronous current token for request headers (proactively refreshed on a timer)
  bearer() { if (!this.active()) return null; if (!this.session) this.load(); return this.session ? this.session.access_token : null; },

  _store(s, refreshed = false) {
    if (!s || !s.access_token) return null;
    const previousUid = this.session?.uid;
    const previousEmail = this.session?.email;
    this._revision++;
    this.session = {
      access_token: s.access_token,
      refresh_token: s.refresh_token || (this.session && this.session.refresh_token) || "",
      expires_at: Math.floor(Date.now() / 1000) + (s.expires_in || 3600),
      email: (s.user && s.user.email) || (this.session && this.session.email) || "",
      uid: (s.user && s.user.id) || (this.session && this.session.uid) || "",
    };
    if (!refreshed || previousUid !== this.session.uid || previousEmail !== this.session.email) this._authEpoch++;
    try { localStorage.setItem(this.KEY, JSON.stringify(this.session)); } catch (_) {}
    this._scheduleRefresh();
    if (previousUid !== this.session.uid) window.dispatchEvent?.(new Event("formora:sessionchange"));
    return this.session;
  },

  _validAuthUser(user, email) {
    return !!user && ["id", "email"].every(key => typeof user[key] === "string" && user[key].trim())
      && (email === undefined || user.email.toLowerCase() === String(email).trim().toLowerCase());
  },
  _storeAuthSession(body, email) {
    if (!body || !["access_token", "refresh_token"].every(key => typeof body[key] === "string" && body[key].trim())
      || !this._validAuthUser(body.user, email)
      || (body.expires_in !== undefined && (!Number.isFinite(body.expires_in) || body.expires_in <= 0))) {
      const error = new Error("The authentication service returned an invalid session. Please try again.");
      error.code = "AUTH_INVALID_RESPONSE";
      throw error;
    }
    return this._store(body);
  },
  async _authRequest(path, options, failure, complete = body => this._storeAuthSession(body)) {
    this.load();
    const attempt = ++this._authAttempt, epoch = this._authEpoch;
    const check = () => {
      this.load();
      if (attempt === this._authAttempt && epoch === this._authEpoch) return;
      const error = new Error("Sign-in was cancelled because the authentication state changed.");
      error.name = "AbortError";
      error.code = "AUTH_ATTEMPT_CANCELLED";
      error.cancelled = true;
      throw error;
    };
    let response, body;
    try {
      response = await fetch(this._base() + path, options);
      body = await response.json().catch(() => ({}));
    } catch (error) { check(); throw error; }
    check();
    if (!response.ok) {
      const error = new Error(body?.msg || body?.error_description || body?.error || failure);
      error.status = response.status;
      throw error;
    }
    return complete(body);
  },

  async signup(email, password, meta) {
    return this._authRequest("/signup", { method: "POST", headers: this._hdr(), body: JSON.stringify({ email, password, data: meta || {} }) }, "Sign-up failed.", body => {
      const user = body?.user || body;
      if (!body?.access_token && !body?.refresh_token && !body?.session && this._validAuthUser(user, email)
        && !user.email_confirmed_at && !user.confirmed_at
        && typeof user.confirmation_sent_at === "string" && Number.isFinite(Date.parse(user.confirmation_sent_at))) return { needsConfirm: true, email };
      return this._storeAuthSession(body, email);
    });
  },
  async login(email, password) {
    return this._authRequest("/token?grant_type=password", { method: "POST", headers: this._hdr(), body: JSON.stringify({ email, password }) }, "Invalid email or password.", body => this._storeAuthSession(body, email));
  },
  // exchange a Google ID token (from GIS / the SocialLogin plugin) for a Supabase session
  async signInWithGoogle(idToken) {
    return this._authRequest("/token?grant_type=id_token", { method: "POST", headers: this._hdr(), body: JSON.stringify({ provider: "google", id_token: idToken }) }, "Google sign-in failed.");
  },
  async _timedFetch(url, options, json = false) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      return json ? { ok: response.ok, status: response.status, body: await response.json().catch(() => ({})) } : response;
    } finally { clearTimeout(timeout); }
  },
  refresh() {
    const session = this.session, revision = this._revision;
    if (!session || !session.refresh_token) return Promise.resolve(null);
    if (this._refreshing?.revision === revision) return this._refreshing.promise;
    const perform = async () => {
      try {
        this.load();
        if (revision !== this._revision || this.session !== session) return this.session;
        const response = await this._timedFetch(this._base() + "/token?grant_type=refresh_token", { method: "POST", headers: this._hdr(), body: JSON.stringify({ refresh_token: session.refresh_token }) }, true);
        if (revision !== this._revision || this.session !== session) return null;
        let stored;
        try { stored = JSON.parse(localStorage.getItem(this.KEY)); } catch (_) { stored = session; }
        if (!stored) { this.clear(); return null; }
        if (stored.access_token !== session.access_token || stored.uid !== session.uid) { this.load(); return this.session; }
        if (!response.ok) { if (response.status === 400 || response.status === 401) this.clear(); return null; }
        return this._store(response.body, true);
      } catch (_) { return null; }
    };
    const promise = typeof navigator !== "undefined" && navigator.locks
      ? navigator.locks.request("formora-session-refresh", perform) : perform();
    this._refreshing = { revision, promise };
    promise.finally(() => { if (this._refreshing?.promise === promise) this._refreshing = null; });
    return promise;
  },
  // ensure a usable, non-expired token (refreshes if within 60s of expiry)
  async token() {
    if (!this.active()) return null;
    this.load();
    if (!this.session) return null;
    const uid = this.session.uid;
    if (this.session.expires_at && this.session.expires_at - 60 < Math.floor(Date.now() / 1000)) await this.refresh();
    if (!this.session || this.session.uid !== uid) return null;
    if (this.session.expires_at && this.session.expires_at <= Math.floor(Date.now() / 1000)) return null;
    return this.session.access_token;
  },
  _scheduleRefresh() {
    if (this._timer) clearTimeout(this._timer);
    if (!this.session || !this.session.expires_at) return;
    const ms = Math.max(30, (this.session.expires_at - 90) - Math.floor(Date.now() / 1000)) * 1000;
    this._timer = setTimeout(() => this.refresh(), ms);
  },
  // ---- password recovery ----
  async recover(email) {
    // send the reset link back to THIS app URL (must be in Supabase's redirect allow-list)
    const redirect = (location.origin + location.pathname).replace(/[#?].*$/, "");
    // Supabase always returns 200 (even for unknown emails) to prevent user enumeration
    try { await fetch(this._base() + "/recover?redirect_to=" + encodeURIComponent(redirect), { method: "POST", headers: this._hdr(), body: JSON.stringify({ email }) }); } catch (_) {}
    return true;
  },
  // set a new password using the recovery access-token from the emailed link, then keep the session
  async setPasswordWithToken(accessToken, refreshToken, expiresIn, newPassword) {
    return this._authRequest("/user", { method: "PUT", headers: this._hdr({ Authorization: "Bearer " + accessToken }), body: JSON.stringify({ password: newPassword }) }, "Could not reset your password. The link may have expired - request a new one.", body => this._storeAuthSession({ access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn || 3600, user: body }));
  },
  async logout() {
    const token = this.session && this.session.access_token;
    this.clear();
    try {
      if (token) await this._timedFetch(this._base() + "/logout", { method: "POST", headers: this._hdr({ Authorization: "Bearer " + token }) });
    } catch (_) {}
  },
};
