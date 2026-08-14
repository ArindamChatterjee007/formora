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
