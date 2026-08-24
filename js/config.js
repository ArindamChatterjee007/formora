/* ============================================================
   CONFIG — add your FREE Pexels API key to show real photos
   in the physique picker.

   Get a key in ~30 seconds (free, no cost, no card):
     1. Go to  https://www.pexels.com/api/
     2. Sign up → "Your API Key" → copy it
     3. Paste it between the quotes below
     4. Hard-reload the app (Cmd+Shift+R)

   Leave it empty to keep the illustrated figures instead.
   Photos are athletic/fitness references, filtered SFW.

   SECURITY: never hardcode a key here — it is served publicly and can be
   scraped/abused. Set it at runtime in your own browser instead:
     localStorage.setItem("fm_pexels_key", "<your-key>")
   or proxy Pexels through a serverless function.
   ============================================================ */
window.PEXELS_KEY = (typeof localStorage !== "undefined" && localStorage.getItem("fm_pexels_key")) || "";

/* ---- Google Sheets login backend (optional; for cross-device accounts) ----
   Deploy backend/Code.gs as a Web App, then paste its /exec URL here.
   Empty = local device-only login (default).                              */
window.SHEETS_API = "";

/* ---- Real Google Sign-In (optional) ----
   Create a free OAuth Client ID (Web) at https://console.cloud.google.com
   → APIs & Services → Credentials → OAuth client ID → Web application.
   Authorised JavaScript origins:
     https://arindamchatterjee007.github.io
   Paste the Client ID below. Empty = simulated Google login (default).   */
window.GOOGLE_CLIENT_ID = "451449440769-sg1vov2ido298dods2ltr32bchevffle.apps.googleusercontent.com";
// iOS OAuth client id (from Google Cloud) for native Google sign-in on iOS.
window.GOOGLE_IOS_CLIENT_ID = "451449440769-na4iu4tvjitfan1jqicegn8knd77qgem.apps.googleusercontent.com";
// User-facing app version (semantic). The ?v= number in index.html is a separate cache-bust build id, not the app version.
window.APP_VERSION = "1.0.0";

/* ---- Shared social backend (Supabase: free Postgres + REST) — real members,
   connect requests and shared feed sync across devices. Empty = local-only. ---- */
window.SUPABASE_URL = "https://ptukgtxpigdkdzsewuvz.supabase.co";
window.SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0dWtndHhwaWdka2R6c2V3dXZ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3MTUwNDEsImV4cCI6MjEwMjI5MTA0MX0.nlm6efF_qABMFaB3BgLk0RMCPbbmiiWd00BdSSJPYfA";
// Real Supabase Auth — OFF (rolled back v99). The v98 flag-on cutover broke
// existing users' sessions on refresh (their Supabase user was wiped mid-session),
// so we reverted to the stable anon-key app: local login persists, the feed loads
// without a login wall, and posts stay owned by uidFor(email). RLS is disabled in
// the DB to match. Re-enable later WITH backups + a real existing-user migration.
window.USE_SUPABASE_AUTH = false;
window.SOCIAL_API = "";

/* ---- Music library (royalty-free) — attach a track to a Flex/post and it plays
   in Reels + on feed videos, synced to the global sound toggle. A licensed
   trending-song catalog (like Instagram's) needs a label/distributor deal; this
   is the legal royalty-free MVP. Clips hosted in our own Supabase storage. ---- */
window.MUSIC = {
  credit: "Royalty-free music by SoundHelix (T. Sch\u00fcrger)",
  tracks: [
    { id: "m1", title: "Adrenaline",  artist: "Formora Sounds", genre: "Workout", src: "https://ptukgtxpigdkdzsewuvz.supabase.co/storage/v1/object/public/media/music/track1.mp3" },
    { id: "m2", title: "Momentum",    artist: "Formora Sounds", genre: "Hype",    src: "https://ptukgtxpigdkdzsewuvz.supabase.co/storage/v1/object/public/media/music/track2.mp3" },
    { id: "m3", title: "Golden Hour", artist: "Formora Sounds", genre: "Chill",   src: "https://ptukgtxpigdkdzsewuvz.supabase.co/storage/v1/object/public/media/music/track3.mp3" },
    { id: "m5", title: "Focus Flow",  artist: "Formora Sounds", genre: "Focus",   src: "https://ptukgtxpigdkdzsewuvz.supabase.co/storage/v1/object/public/media/music/track5.mp3" },
    { id: "m8", title: "Night Drive", artist: "Formora Sounds", genre: "Lo-fi",   src: "https://ptukgtxpigdkdzsewuvz.supabase.co/storage/v1/object/public/media/music/track8.mp3" },
  ],
};

// Subscription tiers (T-28 pricing page). Real checkout wires in once a
// Merchant-of-Record is live (office T-25/T-14); until then the CTA captures
// early-access interest locally.
window.PRICING = {
  tiers: [
    { id: "free",  name: "Free",  price: "0",     period: "",    features: ["Adaptive daily workouts", "Food & weight logging", "Social feed + Flex reels", "10 camera filters"] },
    { id: "pro",   name: "Pro",   price: "7.99",  period: "/mo", yearly: "$49.99/yr", badge: "Most popular", features: ["Everything in Free", "Unlimited AI workout plans", "Full AI meal plans + grocery lists", "All 100 camera filters", "Advanced analytics", "No ads · unlimited Flex"] },
    { id: "elite", name: "Elite", price: "19.99", period: "/mo", yearly: "$149/yr",   features: ["Everything in Pro", "AI progress-photo analysis", "Monthly human-coach check-in", "Priority support", "Early access to new features"] },
  ],
};

/* ---- Lemon Squeezy (Merchant of Record) — LIVE hosted checkout. Store "Formora"
   (#458401), USD. Clicking Upgrade opens the tier's hosted checkout with the
   member's email + uid prefilled — no API key needed on the client. The
   billing-webhook edge function grants the entitlement on payment (Lemon Squeezy
   echoes back checkout[custom][uid]). Currently in TEST mode until the store is
   activated for live payouts; flip testMode:false after activation. ---- */
window.LEMONSQUEEZY = {
  store: "formora",
  storeId: 458401,
  testMode: true,
  buy: {
    pro: "https://formora.lemonsqueezy.com/checkout/buy/ef961463-efc0-48fe-b96d-87421e91cc71",
    elite: "https://formora.lemonsqueezy.com/checkout/buy/e700787c-a588-4935-b381-e60552e6e732",
  },
  variant: { pro: 2049632, elite: 2049732 },
};

/* ---- Razorpay (India rail) — UPI + cards + netbanking + wallets, charged in ₹.
   Filled in after the Razorpay account + KYC + Payment Pages exist. enabled:false →
   the paywall shows only the global (Lemon Squeezy) card/PayPal option. ---- */
window.RAZORPAY = {
  enabled: true, // UPI live (India). Test keys until KYC approves → swap to live keys, no code change.
  inr: { pro: 699, elite: 1699 }, // ₹ shown on the India rail (the edge function is authoritative)
};

/* ---- Auto local-currency display — every visitor sees prices in THEIR currency.
   country→currency via ipapi.co + USD→local rate via open.er-api.com (both free, no key),
   cached 24h. Display-only estimate ("≈"); the actual charge is USD (Lemon Squeezy, the
   buyer's bank converts) or ₹ (Razorpay/UPI for India, once live). Silently falls back to USD. ---- */
window.Currency = {
  cur: "USD", rate: 1, ready: false,
  _sym: { USD: "$", INR: "₹", EUR: "€", GBP: "£", JPY: "¥", AUD: "A$", CAD: "C$", AED: "AED ", SGD: "S$", BRL: "R$" },
  async init() {
    if (this.ready) return;
    try {
      const c = JSON.parse(localStorage.getItem("fm_cur") || "null");
      if (c && c.t > Date.now() - 864e5 && c.cur) { this.cur = c.cur; this.rate = c.rate || 1; this.ready = true; return; }
    } catch (_) {}
    try {
      const geo = await (await fetch("https://ipapi.co/json/")).json();
      this.cur = (geo && geo.currency ? String(geo.currency) : "USD").toUpperCase();
    } catch (_) { this.cur = "USD"; }
    if (this.cur !== "USD") {
      try {
        const fx = await (await fetch("https://open.er-api.com/v6/latest/USD")).json();
        this.rate = (fx && fx.rates && fx.rates[this.cur]) || 1;
      } catch (_) { this.rate = 1; }
      if (this.rate === 1) this.cur = "USD";
    }
    this.ready = true;
    try { localStorage.setItem("fm_cur", JSON.stringify({ cur: this.cur, rate: this.rate, t: Date.now() })); } catch (_) {}
  },
  isLocal() { return this.cur !== "USD" && this.rate !== 1; },
  _fmt(usd) {
    const n = parseFloat(usd) || 0;
    if (!this.isLocal()) return "$" + n.toFixed(2);
    const local = Math.round(n * this.rate);
    try { return new Intl.NumberFormat(undefined, { style: "currency", currency: this.cur, maximumFractionDigits: 0 }).format(local); }
    catch (_) { return (this._sym[this.cur] || this.cur + " ") + local; }
  },
  price(usd) { return this._fmt(usd); },
  yearly(s) { const m = String(s).match(/([\d.]+)/); const per = /\/yr/.test(s) ? "/yr" : (/\/mo/.test(s) ? "/mo" : ""); return m ? this._fmt(m[1]) + per : String(s); }
};

/* ---- Moderation: suspended accounts (uid = email lowercased, non-alphanumerics → "_").
   A banned user is blocked at login with a suspension notice, and their posts /
   stories / profile are hidden across the app. Remove a uid here to lift a ban. ---- */
window.BANNED_UIDS = ["miakhalifa_gmail_com"];

/* ---- Moderation emails (optional): deploy supabase/functions/send-email and paste its
   URL here to email users on warn / content-removal / suspension. Empty = no emails.
   The function is protected by a MOD_TOKEN secret; the owner enables in-app sending by
   running once in their OWN browser: localStorage.setItem("fm_mod_token","<MOD_TOKEN>") ---- */
window.EMAIL_FN_URL = "";

/* ---- Email verification delivery (so a signup's email is REAL, not fake) ----
   The signup step emails a 6-digit code; the user must fetch it from their inbox.
   Two ways to deliver — configure EITHER (both optional; empty = demo code on screen):
   1) Resend (via EMAIL_FN_URL above) — needs a verified domain in Resend.
   2) EmailJS — no domain needed, sends from your Gmail. Create a free account at
      https://www.emailjs.com → add an email service + a template with variables
      {{to_email}}, {{code}}, {{name}} → paste the 3 IDs below. Free ~200/mo.        */
window.EMAILJS_PUBLIC_KEY = "";
window.EMAILJS_SERVICE_ID = "";
window.EMAILJS_TEMPLATE_ID = "";

/* ---- Product analytics (PostHog, T-27) — measures the growth funnel:
   app_opened → signup_started → onboarding_completed → paywall_opened →
   plan_selected → post_created / shared. INERT until you set POSTHOG_KEY.
   Setup: free account at https://posthog.com → Project Settings → copy the
   "Project API Key" (starts with phc_ — a client-side/public key by design) →
   paste below. US host default, or set https://eu.i.posthog.com for the EU. ---- */
window.POSTHOG_KEY = "";
window.POSTHOG_HOST = "https://us.i.posthog.com";
window.Track = {
  _ready: false, _sdk: false, _q: [], _id: null,
  init() {
    if (this._ready || !window.POSTHOG_KEY) return;
    this._ready = true;
    try {
      var host = window.POSTHOG_HOST || "https://us.i.posthog.com";
      var s = document.createElement("script"); s.async = true;
      s.src = host.replace(".i.posthog.com", "-assets.i.posthog.com") + "/static/array.js";
      var self = this;
      s.onload = function () {
        try {
          window.posthog.init(window.POSTHOG_KEY, { api_host: host, capture_pageview: true, persistence: "localStorage" });
          self._sdk = true;
          if (self._id) window.posthog.identify(self._id[0], self._id[1]);
          var q = self._q; self._q = [];
          q.forEach(function (e) { try { window.posthog.capture(e[0], e[1]); } catch (_) {} });
        } catch (e) {}
      };
      document.head.appendChild(s);
    } catch (e) {}
  },
  event(name, props) {
    if (!window.POSTHOG_KEY) return;
    this.init();
    if (this._sdk && window.posthog) { try { window.posthog.capture(name, props || {}); } catch (e) {} }
    else this._q.push([name, props || {}]);
  },
  identify(id, props) {
    if (!window.POSTHOG_KEY) return;
    this.init();
    this._id = [String(id), props || {}];
    if (this._sdk && window.posthog && window.posthog.identify) { try { window.posthog.identify(String(id), props || {}); } catch (e) {} }
  },
};

// tasteful, athletic search terms per physique (id must match PHYSIQUES ids)
// localized to Indian fitness models for relatable references
window.PHOTO_QUERIES = {
  lean_aesthetic: "indian male fitness model lean physique",
  greek_classic: "indian bodybuilder physique man",
  athletic_beach: "indian fit athletic man workout",
  power_mass: "indian bodybuilder muscular man",
  shredded: "indian male fitness model abs",
  toned_lean: "indian woman fitness athletic gym",
  hourglass: "indian woman gym workout fitness",
  athletic_sculpted: "indian female fitness model athletic",
  strong_fit: "indian woman weightlifting strength gym",
  slim_slender: "indian woman running fitness athlete",
};

// verified female exercise photos per muscle group — bundled locally (same-origin) so they always load fast, never hang on an external CDN
window.FEMALE_EX_PHOTOS = {
  Chest:     ["assets/female-ex/chest-1.jpg", "assets/female-ex/chest-2.jpg", "assets/female-ex/chest-3.jpg", "assets/female-ex/chest-4.jpg"],
  Back:      ["assets/female-ex/back-1.jpg", "assets/female-ex/back-2.jpg", "assets/female-ex/back-3.jpg", "assets/female-ex/back-4.jpg"],
  Shoulders: ["assets/female-ex/shoulders-1.jpg", "assets/female-ex/shoulders-2.jpg", "assets/female-ex/shoulders-3.jpg", "assets/female-ex/shoulders-4.jpg"],
  Arms:      ["assets/female-ex/arms-1.jpg", "assets/female-ex/arms-2.jpg", "assets/female-ex/arms-3.jpg", "assets/female-ex/arms-4.jpg"],
  Legs:      ["assets/female-ex/legs-1.jpg", "assets/female-ex/legs-2.jpg", "assets/female-ex/legs-3.jpg", "assets/female-ex/legs-4.jpg"],
  Core:      ["assets/female-ex/core-1.jpg", "assets/female-ex/core-2.jpg", "assets/female-ex/core-3.jpg", "assets/female-ex/core-4.jpg"],
};

// exact per-exercise female photos (verified movement match, bundled) — used before the muscle-group fallback
window.FEMALE_EX_BY_ID = {
  ab_wheel: ["assets/female-ex-byid/ab_wheel-1.jpg"],
  arnold_press: ["assets/female-ex-byid/arnold_press-1.jpg", "assets/female-ex-byid/arnold_press-2.jpg"],
  back_squat: ["assets/female-ex-byid/back_squat-1.jpg", "assets/female-ex-byid/back_squat-2.jpg"],
  barbell_curl: ["assets/female-ex-byid/barbell_curl-1.jpg", "assets/female-ex-byid/barbell_curl-2.jpg"],
  barbell_row: ["assets/female-ex-byid/barbell_row-1.jpg", "assets/female-ex-byid/barbell_row-2.jpg"],
  bench_press: ["assets/female-ex-byid/bench_press-1.jpg", "assets/female-ex-byid/bench_press-2.jpg"],
  bicycle_crunch: ["assets/female-ex-byid/bicycle_crunch-1.jpg", "assets/female-ex-byid/bicycle_crunch-2.jpg"],
  bulgarian: ["assets/female-ex-byid/bulgarian-1.jpg"],
  cable_crunch: ["assets/female-ex-byid/cable_crunch-1.jpg", "assets/female-ex-byid/cable_crunch-2.jpg"],
  cable_curl: ["assets/female-ex-byid/cable_curl-1.jpg"],
  cable_lateral: ["assets/female-ex-byid/cable_lateral-1.jpg", "assets/female-ex-byid/cable_lateral-2.jpg"],
  cable_row: ["assets/female-ex-byid/cable_row-1.jpg", "assets/female-ex-byid/cable_row-2.jpg"],
  chest_dip: ["assets/female-ex-byid/chest_dip-1.jpg", "assets/female-ex-byid/chest_dip-2.jpg"],
  db_curl: ["assets/female-ex-byid/db_curl-1.jpg", "assets/female-ex-byid/db_curl-2.jpg"],
  db_row: ["assets/female-ex-byid/db_row-1.jpg", "assets/female-ex-byid/db_row-2.jpg"],
  db_shoulder_press: ["assets/female-ex-byid/db_shoulder_press-1.jpg", "assets/female-ex-byid/db_shoulder_press-2.jpg"],
  deadlift: ["assets/female-ex-byid/deadlift-1.jpg", "assets/female-ex-byid/deadlift-2.jpg"],
  front_squat: ["assets/female-ex-byid/front_squat-1.jpg", "assets/female-ex-byid/front_squat-2.jpg"],
  glute_bridge: ["assets/female-ex-byid/glute_bridge-1.jpg"],
  good_morning: ["assets/female-ex-byid/good_morning-1.jpg"],
  hack_squat: ["assets/female-ex-byid/hack_squat-1.jpg", "assets/female-ex-byid/hack_squat-2.jpg"],
  hammer_curl: ["assets/female-ex-byid/hammer_curl-1.jpg", "assets/female-ex-byid/hammer_curl-2.jpg"],
  hanging_leg_raise: ["assets/female-ex-byid/hanging_leg_raise-1.jpg", "assets/female-ex-byid/hanging_leg_raise-2.jpg"],
  hip_thrust: ["assets/female-ex-byid/hip_thrust-1.jpg", "assets/female-ex-byid/hip_thrust-2.jpg"],
  incline_bb_press: ["assets/female-ex-byid/incline_bb_press-1.jpg", "assets/female-ex-byid/incline_bb_press-2.jpg"],
  incline_curl: ["assets/female-ex-byid/incline_curl-1.jpg"],
  incline_db_press: ["assets/female-ex-byid/incline_db_press-1.jpg"],
  lat_pulldown: ["assets/female-ex-byid/lat_pulldown-1.jpg", "assets/female-ex-byid/lat_pulldown-2.jpg"],
  lateral_raise: ["assets/female-ex-byid/lateral_raise-1.jpg", "assets/female-ex-byid/lateral_raise-2.jpg"],
  leg_extension: ["assets/female-ex-byid/leg_extension-1.jpg", "assets/female-ex-byid/leg_extension-2.jpg"],
  leg_press: ["assets/female-ex-byid/leg_press-1.jpg", "assets/female-ex-byid/leg_press-2.jpg"],
  lying_leg_curl: ["assets/female-ex-byid/lying_leg_curl-1.jpg", "assets/female-ex-byid/lying_leg_curl-2.jpg"],
  ohp: ["assets/female-ex-byid/ohp-1.jpg"],
  overhead_ext: ["assets/female-ex-byid/overhead_ext-1.jpg", "assets/female-ex-byid/overhead_ext-2.jpg"],
  pec_deck: ["assets/female-ex-byid/pec_deck-1.jpg", "assets/female-ex-byid/pec_deck-2.jpg"],
  plank: ["assets/female-ex-byid/plank-1.jpg", "assets/female-ex-byid/plank-2.jpg"],
  preacher_curl: ["assets/female-ex-byid/preacher_curl-1.jpg", "assets/female-ex-byid/preacher_curl-2.jpg"],
  pullup: ["assets/female-ex-byid/pullup-1.jpg", "assets/female-ex-byid/pullup-2.jpg"],
  pushup: ["assets/female-ex-byid/pushup-1.jpg", "assets/female-ex-byid/pushup-2.jpg"],
  rdl: ["assets/female-ex-byid/rdl-1.jpg", "assets/female-ex-byid/rdl-2.jpg"],
  rear_delt_fly: ["assets/female-ex-byid/rear_delt_fly-1.jpg", "assets/female-ex-byid/rear_delt_fly-2.jpg"],
  rope_pushdown: ["assets/female-ex-byid/rope_pushdown-1.jpg", "assets/female-ex-byid/rope_pushdown-2.jpg"],
  seated_calf: ["assets/female-ex-byid/seated_calf-1.jpg"],
  seated_leg_curl: ["assets/female-ex-byid/seated_leg_curl-1.jpg", "assets/female-ex-byid/seated_leg_curl-2.jpg"],
  standing_calf: ["assets/female-ex-byid/standing_calf-1.jpg"],
  straight_arm: ["assets/female-ex-byid/straight_arm-1.jpg"],
  tbar_row: ["assets/female-ex-byid/tbar_row-1.jpg", "assets/female-ex-byid/tbar_row-2.jpg"],
  upright_row: ["assets/female-ex-byid/upright_row-1.jpg", "assets/female-ex-byid/upright_row-2.jpg"],
  walking_lunge: ["assets/female-ex-byid/walking_lunge-1.jpg", "assets/female-ex-byid/walking_lunge-2.jpg"],
};
