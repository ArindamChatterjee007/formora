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
