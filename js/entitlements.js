/* ============================================================
   ENTITLEMENTS — reads the member's paid tier (free | pro | elite) from the
   server. The tier is written ONLY by the payment webhook (service role, see
   supabase/functions/billing-webhook); the client can READ but never WRITE it,
   so a "Pro" unlock can't be forged from the browser. Inert until Cloud is
   active — free tier is the safe default everywhere.
   ============================================================ */
const Entitlements = {
  _e: { tier: "free", status: "inactive" },
  _request: 0,
  _owner: null,
  loading: false,
  error: null,

  reset() {
    this._request++;
    this._e = { tier: "free", status: "inactive" };
    this._owner = null;
    this.loading = false;
    this.error = null;
  },

  _identity() {
    if (typeof Cloud === "undefined" || !Cloud.active()) return "";
    return typeof SupaAuth !== "undefined" && SupaAuth.active() ? SupaAuth.uid() : Cloud.me;
  },

  async load() {
    const request = ++this._request;
    this._e = { tier: "free", status: "inactive" };
    this._owner = null;
    this.loading = true;
    this.error = null;
    let timeout;
    try {
      if (typeof Cloud === "undefined" || !Cloud.active() || !Cloud.base) return this._e;
      const authenticated = typeof SupaAuth !== "undefined" && SupaAuth.active();
      const token = authenticated ? await SupaAuth.token() : null;
      const uid = authenticated ? SupaAuth.uid() : Cloud.me;
      if (request !== this._request) return this._e;
      if (!uid || (authenticated && !token)) { this.error = "auth"; return this._e; }
      this._owner = uid;
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), 10000);
      const r = await fetch(
        Cloud.base + "/entitlements?select=tier,status,current_period_end&uid=eq." + encodeURIComponent(uid),
        { headers: Cloud._headers(authenticated ? { Authorization: "Bearer " + token } : undefined), signal: controller.signal }
      );
      if (!r.ok) throw new Error("membership_unavailable");
      const rows = await r.json();
      if (request !== this._request || uid !== (authenticated ? SupaAuth.uid() : Cloud.me)) return this._e;
      const row = Array.isArray(rows) ? rows[0] : null;
      if (row && ["free", "pro", "elite"].includes(row.tier)) {
        this._owner = uid;
        this._e = { tier: row.tier, status: row.status, current_period_end: row.current_period_end };
      }
    } catch (_) {
      if (request === this._request) this.error = "unavailable";
    } finally {
      clearTimeout(timeout);
      if (request === this._request) this.loading = false;
    }
    return this._e;
  },

  tier() { return this._active() && ["pro", "elite"].includes(this._e.tier) ? this._e.tier : "free"; },
  status() { return this._e.status || "inactive"; },
  ready() {
    this._active();
    return !this.loading && !this.error && (this._owner !== null || typeof Cloud === "undefined" || !Cloud.active());
  },
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
