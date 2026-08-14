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
   ============================================================ */
window.PEXELS_KEY = "";

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

/* ---- Shared social backend (Supabase: free Postgres + REST) — real members,
   connect requests and shared feed sync across devices. Empty = local-only. ---- */
window.SUPABASE_URL = "https://ptukgtxpigdkdzsewuvz.supabase.co";
window.SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0dWtndHhwaWdka2R6c2V3dXZ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3MTUwNDEsImV4cCI6MjEwMjI5MTA0MX0.nlm6efF_qABMFaB3BgLk0RMCPbbmiiWd00BdSSJPYfA";
window.SOCIAL_API = "";

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
