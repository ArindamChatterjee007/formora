/* ============================================================
   ENTITLEMENTS — reads the member's paid tier (free | pro | elite) from the
   server. The tier is written ONLY by the payment webhook (service role, see
   supabase/functions/billing-webhook); the client can READ but never WRITE it,
   so a "Pro" unlock can't be forged from the browser. Inert until Cloud is
   active — free tier is the safe default everywhere.
   ============================================================ */
const Entitlements = {
  _e: { tier: "free", status: "inactive" },

  async load() {
    try {
      if (typeof Cloud === "undefined" || !Cloud.active() || !Cloud.me || !Cloud.base) return this._e;
      const r = await fetch(
        Cloud.base + "/entitlements?select=tier,status,current_period_end&uid=eq." + encodeURIComponent(Cloud.me),
        { headers: Cloud._headers() }
      );
      if (r.ok) { const rows = await r.json(); if (rows && rows[0]) this._e = rows[0]; }
    } catch (_) {}
    return this._e;
  },

  tier() { return this._e.tier || "free"; },
  status() { return this._e.status || "inactive"; },
  _active() { return this._e.status === "active" || this._e.status === "trialing"; },
  isPro() { return (this._e.tier === "pro" || this._e.tier === "elite") && this._active(); },
  isElite() { return this._e.tier === "elite" && this._active(); },

  // Gate a premium feature: run onOk if entitled, else open the pricing/paywall.
  gate(minTier, onOk) {
    const ok = minTier === "elite" ? this.isElite() : this.isPro();
    if (ok) return typeof onOk === "function" ? onOk() : undefined;
    if (typeof App !== "undefined" && App.openPricing) App.openPricing();
  },
};
