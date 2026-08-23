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

  active() { return !!(window.USE_SUPABASE_AUTH && window.SUPABASE_URL && window.SUPABASE_ANON_KEY); },
  _base() { return (window.SUPABASE_URL || "").replace(/\/$/, "") + "/auth/v1"; },
  _hdr(extra) { return Object.assign({ apikey: window.SUPABASE_ANON_KEY, "Content-Type": "application/json" }, extra || {}); },

  load() {
    try { this.session = JSON.parse(localStorage.getItem(this.KEY)) || null; } catch { this.session = null; }
    return this.session;
  },
  clear() { this.session = null; try { localStorage.removeItem(this.KEY); } catch (_) {} },
  email() { return (this.session && this.session.email) || ""; },
  uid() { if (!this.active()) return ""; if (!this.session) this.load(); return (this.session && this.session.uid) || ""; },
  // synchronous current token for request headers (proactively refreshed on a timer)
  bearer() { if (!this.active()) return null; if (!this.session) this.load(); return this.session ? this.session.access_token : null; },

  _store(s) {
    if (!s || !s.access_token) return null;
    this.session = {
      access_token: s.access_token,
      refresh_token: s.refresh_token || (this.session && this.session.refresh_token) || "",
      expires_at: Math.floor(Date.now() / 1000) + (s.expires_in || 3600),
      email: (s.user && s.user.email) || (this.session && this.session.email) || "",
      uid: (s.user && s.user.id) || (this.session && this.session.uid) || "",
    };
    try { localStorage.setItem(this.KEY, JSON.stringify(this.session)); } catch (_) {}
    this._scheduleRefresh();
    return this.session;
  },

  async signup(email, password, meta) {
    const r = await fetch(this._base() + "/signup", { method: "POST", headers: this._hdr(), body: JSON.stringify({ email, password, data: meta || {} }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.msg || j.error_description || j.error || "Sign-up failed.");
    if (j.access_token) return this._store(j);
    return { needsConfirm: true, email }; // email confirmations are ON — no session until they click the link
  },
  async login(email, password) {
    const r = await fetch(this._base() + "/token?grant_type=password", { method: "POST", headers: this._hdr(), body: JSON.stringify({ email, password }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.msg || j.error_description || j.error || "Invalid email or password.");
    return this._store(j);
  },
  async refresh() {
    if (!this.session || !this.session.refresh_token) return null;
    try {
      const r = await fetch(this._base() + "/token?grant_type=refresh_token", { method: "POST", headers: this._hdr(), body: JSON.stringify({ refresh_token: this.session.refresh_token }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { if (r.status === 400 || r.status === 401) this.clear(); return null; } // keep the session on transient (5xx/network) errors
      return this._store(j);
    } catch (_) { return null; }
  },
  // ensure a usable, non-expired token (refreshes if within 60s of expiry)
  async token() {
    if (!this.active()) return null;
    if (!this.session) this.load();
    if (!this.session) return null;
    if (this.session.expires_at && this.session.expires_at - 60 < Math.floor(Date.now() / 1000)) await this.refresh();
    return this.session ? this.session.access_token : null;
  },
  _scheduleRefresh() {
    if (this._timer) clearTimeout(this._timer);
    if (!this.session || !this.session.expires_at) return;
    const ms = Math.max(30, (this.session.expires_at - 90) - Math.floor(Date.now() / 1000)) * 1000;
    this._timer = setTimeout(() => this.refresh(), ms);
  },
  async logout() {
    try {
      const t = this.session && this.session.access_token;
      if (t) await fetch(this._base() + "/logout", { method: "POST", headers: this._hdr({ Authorization: "Bearer " + t }) });
    } catch (_) {}
    if (this._timer) clearTimeout(this._timer);
    this.clear();
  },
};
