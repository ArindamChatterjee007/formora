/* ============================================================
   MAILER — client for the Supabase `send-email` Edge Function.
   Moderation emails are ADMIN-only: the function is protected by a
   MOD_TOKEN secret. The owner enables in-app sending by pasting the
   token once in their OWN browser:
       localStorage.setItem("fm_mod_token", "<the-MOD_TOKEN>")
   Public users never have it, so they can't send mail (function 401s).
   Inert until window.EMAIL_FN_URL is set in config.js.
   ============================================================ */
const Mailer = {
  active() { return !!window.EMAIL_FN_URL; },
  _token() { return window.MOD_TOKEN || (typeof localStorage !== "undefined" && localStorage.getItem("fm_mod_token")) || ""; },
  // type: content_removed | warning | suspended | verify | custom
  async send(to, type, data) {
    if (!this.active()) { console.warn("[Mailer] EMAIL_FN_URL not set — email skipped:", type, to); return { ok: false, skipped: true }; }
    const headers = { "Content-Type": "application/json" };
    const tok = this._token(); if (tok) headers["x-mod-token"] = tok;
    try {
      const r = await fetch(window.EMAIL_FN_URL, {
        method: "POST", headers,
        body: JSON.stringify({ to, type, name: (data && data.name) || "", details: (data && data.details) || "" }),
      });
      return await r.json();
    } catch (e) { return { ok: false, error: String(e) }; }
  },
};
