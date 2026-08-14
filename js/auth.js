/* ============================================================
   AUTH: local-first login / signup + phone OTP verification
   NOTE: This is on-device auth for a personal app. Passwords are
   salted + SHA-256 hashed in the browser. Google sign-in and SMS
   delivery are SIMULATED (no backend). For real Google OAuth and
   real SMS OTP, wire this to Firebase Auth (see notes in chat).
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
  randHex(n) {
    return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
  },
  genOtp() { return String(Math.floor(100000 + Math.random() * 900000)); },

  // ---- email/password ----
  async signup({ name, email, phone, password }) {
    if (this.findByEmail(email)) throw new Error("An account with this email already exists. Try logging in.");
    const salt = this.randHex(16);
    const hash = await this.hash(password, salt);
    const account = {
      id: "u" + Date.now(),
      name, email, phone, salt, hash,
      phoneVerified: false, provider: "email",
    };
    // hold the account aside until the phone OTP is confirmed
    this.pending = { account, otp: this.genOtp(), needsPhone: false, origin: "signup" };
    return this.pending.otp;
  },

  async login({ email, password }) {
    const acc = this.findByEmail(email);
    if (!acc || acc.provider !== "email") throw new Error("No email account found. Please sign up first.");
    const hash = await this.hash(password, acc.salt);
    if (hash !== acc.hash) throw new Error("Incorrect password.");
    this.setCurrent(acc.id);
    return acc;
  },

  // ---- simulated Google sign-in ----
  googleStart({ name, email }) {
    let acc = this.data.accounts.find(
      (a) => a.provider === "google" && a.email.toLowerCase() === (email || "").toLowerCase());
    if (!acc) {
      acc = {
        id: "u" + Date.now(), name, email, phone: "", salt: "", hash: "",
        phoneVerified: false, provider: "google",
      };
    }
    this.pending = { account: acc, otp: null, needsPhone: !acc.phoneVerified, origin: "google" };
    return this.pending;
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
    acc.phoneVerified = true;
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
