/* ============================================================
   AUTH: local-first login / signup + phone OTP verification
   NOTE: This is on-device auth for a personal app. Passwords are
   salted + PBKDF2-SHA256 (150k iterations) hashed in the browser;
   legacy SHA-256 accounts are auto-upgraded on next login. Google
   sign-in and SMS delivery are SIMULATED (no backend). For real
   Google OAuth and real SMS OTP, wire this to Firebase Auth.
   ============================================================ */

const AUTH_KEY = "gymcoach_auth";

const Auth = {
  data: null,
  pending: null, // { account, otp, needsPhone, origin } while verifying

  load() {
    try {
      this.data = JSON.parse(localStorage.getItem(AUTH_KEY)) || { accounts: [], currentUserId: null };
    } catch {
      this.data = { accounts: [], currentUserId: null };
    }
    if (!Array.isArray(this.data.accounts)) this.data.accounts = [];
    return this.data;
  },
  save() { localStorage.setItem(AUTH_KEY, JSON.stringify(this.data)); },

  currentUser() { return this.data.accounts.find((a) => a.id === this.data.currentUserId) || null; },
  isLoggedIn() { return !!this.currentUser(); },
  findByEmail(email) {
    return this.data.accounts.find((a) => a.email.toLowerCase() === (email || "").toLowerCase());
  },

  // ---- crypto helpers ----
  async hash(pw, salt) {
    const bytes = new TextEncoder().encode(`${salt}:${pw}`);
    const buf = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  },
  // PBKDF2-SHA256 key-stretching (150k iterations) for all new/updated passwords
  async hashPbkdf2(pw, salt, iterations = 150000) {
    const enc = new TextEncoder();
    const keyMat = await crypto.subtle.importKey("raw", enc.encode(pw), { name: "PBKDF2" }, false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(salt), iterations, hash: "SHA-256" }, keyMat, 256);
    return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
  },
  // verify against the PBKDF2 hash, or a legacy SHA-256 hash for older accounts
  async verifyPassword(acc, pw) {
    if (acc && acc.algo === "pbkdf2") return (await this.hashPbkdf2(pw, acc.salt, acc.iter || 150000)) === acc.hash;
    return (await this.hash(pw, acc.salt)) === acc.hash;
  },
  randHex(n) {
    return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
  },
  genOtp() { return String(Math.floor(100000 + Math.random() * 900000)); },

  // ---- email/password ----
  // ---- cloud backend (Google Sheets) when configured ----
  remote() { return !!window.SHEETS_API; },
  async postSheet(payload) {
    // no Content-Type header => text/plain => avoids CORS preflight on Apps Script
    const res = await fetch(window.SHEETS_API, { method: "POST", body: JSON.stringify(payload) });
    if (!res.ok) throw new Error("Backend unreachable (" + res.status + ").");
    return res.json();
  },

  async signup({ name, email, phone, password }) {
    if (this.remote()) {
      const res = await this.postSheet({ action: "signup", name, email, phone, password });
      if (!res.ok) throw new Error(res.error || "Sign-up failed.");
      const acc = { id: "u" + Date.now(), name, email, phone, salt: "", hash: "", phoneVerified: true, provider: "email", remote: true };
      if (!this.findByEmail(email)) this.data.accounts.push(acc);
      this.setCurrent(acc.id);
      return { direct: true };
    }
    if (this.findByEmail(email)) throw new Error("An account with this email already exists. Try logging in.");
    const salt = this.randHex(16);
    const iter = 150000;
    const hash = await this.hashPbkdf2(password, salt, iter);
    const account = {
      id: "u" + Date.now(),
      name, email, phone, salt, hash, algo: "pbkdf2", iter,
      phoneVerified: false, emailVerified: false, provider: "email",
    };
    // hold the account aside until the email verification code is confirmed
    this.pending = { account, otp: this.genOtp(), needsPhone: false, origin: "signup", channel: "email", delivered: false };
    return { direct: false, otp: this.pending.otp };
  },

  // email the pending signup its 6-digit code. Returns { sent, otp } —
  // when a mail backend delivered it, otp is null (user must fetch it from their inbox);
  // with no backend configured we return the code so the UI can show it (demo mode).
  async deliverCode() {
    if (!this.pending) return { sent: false };
    const acc = this.pending.account, code = this.pending.otp;
    if (typeof Mailer !== "undefined" && Mailer.canSendCodes && Mailer.canSendCodes()) {
      let r = null; try { r = await Mailer.sendCode(acc.email, code, acc.name); } catch (_) { r = null; }
      this.pending.delivered = !!(r && r.sent);
      return { sent: this.pending.delivered, otp: this.pending.delivered ? null : code };
    }
    this.pending.delivered = false;
    return { sent: false, otp: code };
  },

  async login({ email, password }) {
    if (this.remote()) {
      const res = await this.postSheet({ action: "login", email, password });
      if (!res.ok) throw new Error(res.error || "Login failed.");
      let acc = this.findByEmail(email);
      if (!acc) {
        acc = { id: "u" + Date.now(), name: res.user.name, email, phone: res.user.phone, salt: "", hash: "", phoneVerified: true, provider: "email", remote: true };
        this.data.accounts.push(acc);
      } else {
        acc.name = res.user.name || acc.name;
        acc.phone = res.user.phone || acc.phone;
      }
      this.setCurrent(acc.id);
      return acc;
    }
    const acc = this.findByEmail(email);
    if (!acc || acc.provider !== "email") throw new Error("No email account found. Please sign up first.");
    const ok = await this.verifyPassword(acc, password);
    if (!ok) throw new Error("Incorrect password.");
    // transparently re-hash legacy SHA-256 accounts to PBKDF2 on successful login
    if (acc.algo !== "pbkdf2") {
      acc.salt = this.randHex(16);
      acc.iter = 150000;
      acc.hash = await this.hashPbkdf2(password, acc.salt, acc.iter);
      acc.algo = "pbkdf2";
    }
    this.setCurrent(acc.id);
    return acc;
  },

  // ---- simulated Google sign-in ----
  googleStart({ name, email }) {
    const key = (email || "").toLowerCase();
    let acc = this.data.accounts.find((a) => a.email && a.email.toLowerCase() === key);
    if (!acc) {
      acc = {
        id: "u" + Date.now(), name, email, phone: "", salt: "", hash: "",
        phoneVerified: false, provider: "google",
      };
    }
    this.pending = { account: acc, otp: null, needsPhone: !acc.phoneVerified, origin: "google" };
    return this.pending;
  },

  // ---- real Google sign-in (verified email from Google ID token) ----
  loginWithGoogle({ name, email }) {
    const key = (email || "").toLowerCase();
    // reuse ANY existing account with this email so data (diet, logs) follows the person
    let acc = this.data.accounts.find((a) => a.email && a.email.toLowerCase() === key);
    if (!acc) {
      acc = { id: "u" + Date.now(), name: name || email, email, phone: "", salt: "", hash: "", phoneVerified: true, emailVerified: true, provider: "google" };
      this.data.accounts.push(acc);
    } else {
      acc.phoneVerified = true;
      acc.emailVerified = true;
      if (name && !acc.name) acc.name = name;
    }
    this.setCurrent(acc.id);
    return acc;
  },

  // ---- phone OTP ----
  sendPhoneOtp(phone) {
    if (this.pending) this.pending.account.phone = phone;
    this.pending.otp = this.genOtp();
    this.pending.needsPhone = false;
    return this.pending.otp;
  },
  resendOtp() { this.pending.otp = this.genOtp(); return this.pending.otp; },

  verifyOtp(code) {
    if (!this.pending || !this.pending.otp) throw new Error("No code was sent. Please request one.");
    if (String(code).trim() !== this.pending.otp) throw new Error("Invalid code. Please try again.");
    const acc = this.pending.account;
    if (this.pending.channel === "email") acc.emailVerified = !!this.pending.delivered; // real only if actually emailed
    else acc.phoneVerified = true;
    if (!this.data.accounts.find((a) => a.id === acc.id)) this.data.accounts.push(acc);
    this.setCurrent(acc.id);
    const user = acc;
    this.pending = null;
    return user;
  },

  setCurrent(id) { this.data.currentUserId = id; this.save(); },
  logout() { this.data.currentUserId = null; this.save(); },

  // ---- validators ----
  validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || ""); },
  validPhone(p) { return /^[+]?[\d\s-]{7,15}$/.test(p || ""); },
};
