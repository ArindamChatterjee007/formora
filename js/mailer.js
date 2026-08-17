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
  // type: content_removed | warning | suspended | verify | code | custom
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

  // ---- email verification codes (real: user must fetch it from their inbox) ----
  emailjsReady() { return !!(window.EMAILJS_PUBLIC_KEY && window.EMAILJS_SERVICE_ID && window.EMAILJS_TEMPLATE_ID); },
  canSendCodes() { return this.active() || this.emailjsReady(); },
  // returns { sent:true, via } if the code was actually emailed, else { sent:false }
  async sendCode(to, code, name) {
    // 1) Resend via our Edge Function (needs a verified domain to reach arbitrary users)
    if (this.active()) {
      try { const r = await this.send(to, "code", { name, details: String(code) }); if (r && r.ok) return { sent: true, via: "resend" }; } catch (_) {}
    }
    // 2) EmailJS — no domain needed, sends from your Gmail
    if (this.emailjsReady()) {
      try {
        const ej = await this._loadEmailJS();
        await ej.send(window.EMAILJS_SERVICE_ID, window.EMAILJS_TEMPLATE_ID, { to_email: to, email: to, code: String(code), name: name || "there" }, window.EMAILJS_PUBLIC_KEY);
        return { sent: true, via: "emailjs" };
      } catch (e) { console.warn("[Mailer] EmailJS send failed:", e); }
    }
    return { sent: false };
  },
  _loadEmailJS() {
    if (window.emailjs) return Promise.resolve(window.emailjs);
    if (this._ejP) return this._ejP;
    this._ejP = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js";
      s.onload = () => { try { window.emailjs.init({ publicKey: window.EMAILJS_PUBLIC_KEY }); } catch (_) {} resolve(window.emailjs); };
      s.onerror = () => reject(new Error("EmailJS SDK failed to load"));
      document.head.appendChild(s);
    });
    return this._ejP;
  },
};
