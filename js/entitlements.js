/* ============================================================
   ENTITLEMENTS — reads the member's paid tier (free | pro | elite) from the
   server. The tier is written ONLY by the payment webhook (service role, see
   supabase/functions/billing-webhook); the client can READ but never WRITE it,
   so a "Pro" unlock can't be forged from the browser. Inert until Cloud is
   active — free tier is the safe default everywhere.
   A confirmed membership is remembered per account on this device so a slow
   token refresh or a dropped connection re-checks in the background instead of
   showing a paid member as free; an explicit server denial still clears access.
   ============================================================ */
const Entitlements = {
  _e: { tier: "free", status: "inactive" },
  _request: 0,
  _owner: null,
  _source: "none", // none | cache | server — where the current membership came from
  _retry: null,
  _retries: 0,
  loading: false,
  error: null,
  onChange: null,

  reset() {
    this._request++;
    this._e = { tier: "free", status: "inactive" };
    this._owner = null;
    this._source = "none";
    this._cancelRetry();
    this.loading = false;
    this.error = null;
  },

  _identity() {
    if (typeof Cloud === "undefined" || !Cloud.active()) return "";
    return typeof SupaAuth !== "undefined" && SupaAuth.active() ? SupaAuth.uid() : Cloud.me;
  },
  _valid(row) {
    return !!row && ["pro", "elite"].includes(row.tier) && ["active", "trialing"].includes(row.status)
      && (row.current_period_end == null || (Number.isFinite(Date.parse(row.current_period_end)) && Date.parse(row.current_period_end) > Date.now()));
  },
  _cacheKey(uid) { return "fm_membership:" + uid; },
  _readCache(uid) {
    try {
      const saved = JSON.parse(localStorage.getItem(this._cacheKey(uid)) || "null");
      const fresh = saved && Number.isFinite(saved.confirmedAt) && saved.confirmedAt <= Date.now() && Date.now() - saved.confirmedAt < 30 * 86400000;
      return fresh && this._valid(saved) ? { tier: saved.tier, status: saved.status, current_period_end: saved.current_period_end ?? null } : null;
    } catch (_) { return null; }
  },
  _writeCache(uid, row) {
    try {
      if (this._valid(row)) localStorage.setItem(this._cacheKey(uid), JSON.stringify({ tier: row.tier, status: row.status, current_period_end: row.current_period_end ?? null, confirmedAt: Date.now() }));
      else localStorage.removeItem(this._cacheKey(uid));
    } catch (_) {}
  },
  _cancelRetry() { if (this._retry) clearTimeout(this._retry); this._retry = null; },
  // transient failures re-check quietly a few times; the app re-renders through onChange when the answer changes
  _scheduleRetry() {
    this._cancelRetry();
    const delays = [4000, 15000, 60000];
    if (this._retries >= delays.length) return;
    const request = this._request, delay = delays[this._retries++];
    this._retry = setTimeout(() => { this._retry = null; if (request === this._request) this.load(); }, delay);
    if (this._retry && this._retry.unref) this._retry.unref();
  },

  async load() {
    this._active(); // an account change resets stale state before this request is numbered
    const before = this.tier() + ":" + this.ready();
    const request = ++this._request;
    this._cancelRetry();
    this.loading = true;
    this.error = null;
    let timeout;
    try {
      if (typeof Cloud === "undefined" || !Cloud.active() || !Cloud.base) { this._e = { tier: "free", status: "inactive" }; this._owner = null; this._source = "none"; return this._e; }
      const authenticated = typeof SupaAuth !== "undefined" && SupaAuth.active();
      const uid = authenticated ? SupaAuth.uid() : Cloud.me;
      if (uid && uid !== this._owner) {
        // a different account: start from this device's last confirmed membership for it, never the previous member's
        const cached = this._readCache(uid);
        this._e = cached || { tier: "free", status: "inactive" };
        this._source = cached ? "cache" : "none";
        this._owner = uid;
      } else if (!uid) { this._e = { tier: "free", status: "inactive" }; this._owner = null; this._source = "none"; }
      const token = authenticated ? await SupaAuth.token() : null;
      if (request !== this._request) return this._e;
      if (!uid || (authenticated && !token)) { this.error = "auth"; if (uid) this._scheduleRetry(); return this._e; }
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), 10000);
      const r = await fetch(
        Cloud.base + "/entitlements?select=tier,status,current_period_end&uid=eq." + encodeURIComponent(uid),
        { headers: Cloud._headers(authenticated ? { Authorization: "Bearer " + token } : undefined), signal: controller.signal }
      );
      if (request !== this._request || uid !== (authenticated ? SupaAuth.uid() : Cloud.me)) return this._e;
      if (!r.ok) {
        // an explicit denial for a valid session fails closed; a server outage keeps the last confirmed answer
        if (r.status >= 500 || r.status === 429) throw new Error("membership_unavailable");
        this._e = { tier: "free", status: "inactive" }; this._source = "server"; this._writeCache(uid, null); this._retries = 0;
        return this._e;
      }
      const rows = await r.json();
      if (request !== this._request || uid !== (authenticated ? SupaAuth.uid() : Cloud.me)) return this._e;
      const row = Array.isArray(rows) ? rows[0] : null;
      this._e = row && ["free", "pro", "elite"].includes(row.tier) ? { tier: row.tier, status: row.status, current_period_end: row.current_period_end } : { tier: "free", status: "inactive" };
      this._source = "server";
      this._writeCache(uid, this._e);
      this._retries = 0;
    } catch (_) {
      if (request === this._request) { this.error = "unavailable"; if (this._owner) this._scheduleRetry(); }
    } finally {
      clearTimeout(timeout);
      if (request === this._request) {
        this.loading = false;
        if (typeof this.onChange === "function" && before !== this.tier() + ":" + this.ready()) { try { this.onChange(); } catch (_) {} }
      }
    }
    return this._e;
  },

  tier() { return this._active() && ["pro", "elite"].includes(this._e.tier) ? this._e.tier : "free"; },
  status() { return this._e.status || "inactive"; },
  // a usable answer exists: a fresh server read, or the last confirmed membership while a transient failure is re-checked
  ready() {
    this._active();
    if (typeof Cloud === "undefined" || !Cloud.active()) return !this.loading;
    return !this.loading && this._owner !== null && (!this.error || this._source !== "none");
  },
  known() { this._active(); return this._owner !== null && this._source !== "none"; },
  stale() { this._active(); return this._owner !== null && !!this.error && this._source !== "none"; },
  _active() {
    if (this._owner !== null && this._owner !== this._identity()) { this.reset(); this.error = "auth"; return false; }
    if (this._e.status !== "active" && this._e.status !== "trialing") return false;
    const end = this._e.current_period_end;
    return end == null || (Number.isFinite(Date.parse(end)) && Date.parse(end) > Date.now());
  },
  isPro() { return (this._e.tier === "pro" || this._e.tier === "elite") && this._active(); },
  isElite() { return this._e.tier === "elite" && this._active(); },

  // Gate a premium feature: run onOk if entitled, else open the pricing/paywall.
  gate(minTier, onOk) {
    const ok = minTier === "elite" ? this.isElite() : this.isPro();
    if (ok) return typeof onOk === "function" ? onOk() : undefined;
    if (typeof App !== "undefined" && App.openPricing) App.openPricing();
  },
};
// coming back online or to the foreground re-checks a membership that could not be confirmed
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  const recheckMembership = () => { if (Entitlements._owner && Entitlements.error && !Entitlements.loading) Entitlements.load(); };
  window.addEventListener("online", recheckMembership);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") recheckMembership(); });
}
