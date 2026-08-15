/* ============================================================
   DATA: Exercise database, split templates, profile defaults
   Goal: Lean-bulk aesthetic physique (Hrithik Roshan style)
   ============================================================ */

// Default profile — NEUTRAL. Never hardcode a real person; each user's real
// values come from the onboarding step (or their account).
const DEFAULT_PROFILE = {
  name: "",
  email: "",
  phone: "",
  gender: "male",
  dob: "2000-01-01",          // neutral fallback until onboarding
  age: 25,
  heightCm: 170,
  startWeightKg: 70,
  goal: "lean-bulk",          // legacy; physique drives targets now
  physique: "lean_aesthetic", // chosen target look
  physiqueChosen: false,
  diet: "veg",                // safe default; user chooses in onboarding
  lookPhotos: {},             // { physiqueId: [dataURL, ...] } user reference photos
  activityFactor: 1.55,       // moderate (3-5 sessions/week)
  targetWeightKg: 72,
  avatar: null,               // profile photo (dataURL)
  bio: "",                    // short social bio
  socials: { instagram: "", linkedin: "", facebook: "" },
  username: "",               // unique @handle (auto-generated, editable)
  privacy: "public",          // "public" | "friends" — who can see profile & posts
  following: [],              // uids this user follows (one-way, LinkedIn-style)
  autoFollowed: [],           // uids auto-followed when connected (so unfollow = opt-out, no re-follow)
  onboarded: false,           // true once the user completes the details step
};

// Muscle groups mapped to split categories
const SPLITS = {
  push: { label: "Push Day", focus: "Chest · Shoulders · Triceps", accent: "#ff6b3d" },
  pull: { label: "Pull Day", focus: "Back · Biceps · Rear Delts", accent: "#3d8bff" },
  legs: { label: "Leg Day", focus: "Quads · Hamstrings · Glutes · Calves", accent: "#22c55e" },
};

// Preferred rotation order when nothing has been trained yet
const SPLIT_ROTATION = ["push", "pull", "legs"];

/* ---------- EXERCISE DATABASE ----------
   Each exercise: id, name, muscle, equipment, repRange, tip
   Alternatives are grouped by "slot" below.                    */
const EXERCISES = {
  // ----- CHEST -----
  bench_press:        { name: "Barbell Bench Press",        muscle: "Chest",     equip: "Barbell",  tip: "Control the descent, drive through mid-chest." },
  incline_db_press:   { name: "Incline Dumbbell Press",     muscle: "Upper Chest", equip: "Dumbbell", tip: "Best for the upper-chest shelf — key for aesthetics." },
  incline_bb_press:   { name: "Incline Barbell Press",      muscle: "Upper Chest", equip: "Barbell",  tip: "30–45° bench angle for upper pec focus." },
  flat_db_press:      { name: "Flat Dumbbell Press",        muscle: "Chest",     equip: "Dumbbell", tip: "Deeper stretch than the barbell." },
  chest_dip:          { name: "Chest Dip",                  muscle: "Chest",     equip: "Bodyweight", tip: "Lean forward to bias the chest." },
  cable_fly:          { name: "Cable Fly (High-to-Low)",    muscle: "Chest",     equip: "Cable",    tip: "Squeeze and hold for a peak contraction." },
  pec_deck:           { name: "Machine Pec Deck",           muscle: "Chest",     equip: "Machine",  tip: "Great finisher, constant tension." },
  pushup:             { name: "Push-ups",                   muscle: "Chest",     equip: "Bodyweight", tip: "Full range, elbows ~45°." },

  // ----- SHOULDERS -----
  ohp:                { name: "Overhead Barbell Press",     muscle: "Shoulders", equip: "Barbell",  tip: "Brace your core, press in a straight line." },
  db_shoulder_press:  { name: "Seated DB Shoulder Press",   muscle: "Shoulders", equip: "Dumbbell", tip: "Don't clash the dumbbells at the top." },
  arnold_press:       { name: "Arnold Press",               muscle: "Shoulders", equip: "Dumbbell", tip: "Rotate for full delt activation." },
  lateral_raise:      { name: "Dumbbell Lateral Raise",     muscle: "Side Delts", equip: "Dumbbell", tip: "Lead with the elbows — builds shoulder width." },
  cable_lateral:      { name: "Cable Lateral Raise",        muscle: "Side Delts", equip: "Cable",    tip: "Constant tension = round 3D delts." },
  upright_row:        { name: "Cable Upright Row",          muscle: "Side Delts", equip: "Cable",    tip: "Pull to chest height, elbows lead." },
  rear_delt_fly:      { name: "Rear Delt Fly (Reverse Pec)", muscle: "Rear Delts", equip: "Machine", tip: "Balances the shoulder, improves posture." },
  face_pull:          { name: "Face Pull",                  muscle: "Rear Delts", equip: "Cable",    tip: "Shoulder health + rear-delt detail." },

  // ----- TRICEPS -----
  close_grip_bench:   { name: "Close-Grip Bench Press",     muscle: "Triceps",   equip: "Barbell",  tip: "Elbows tucked, hands shoulder-width." },
  rope_pushdown:      { name: "Triceps Rope Pushdown",      muscle: "Triceps",   equip: "Cable",    tip: "Spread the rope at the bottom." },
  overhead_ext:       { name: "Overhead Cable Extension",   muscle: "Triceps",   equip: "Cable",    tip: "Hits the long head for arm size." },
  skull_crusher:      { name: "EZ-Bar Skull Crusher",       muscle: "Triceps",   equip: "Barbell",  tip: "Lower to forehead, keep elbows still." },
  triceps_dip:        { name: "Triceps Dip",                muscle: "Triceps",   equip: "Bodyweight", tip: "Stay upright to bias triceps." },

  // ----- BACK -----
  pullup:             { name: "Pull-ups",                   muscle: "Lats",      equip: "Bodyweight", tip: "The #1 lat-width builder for the V-taper." },
  lat_pulldown:       { name: "Lat Pulldown",               muscle: "Lats",      equip: "Cable",    tip: "Pull to upper chest, drive elbows down." },
  barbell_row:        { name: "Barbell Row",                muscle: "Back",      equip: "Barbell",  tip: "Hinge ~45°, pull to lower ribs." },
  cable_row:          { name: "Seated Cable Row",           muscle: "Back",      equip: "Cable",    tip: "Squeeze shoulder blades together." },
  db_row:             { name: "Single-Arm Dumbbell Row",    muscle: "Back",      equip: "Dumbbell", tip: "Full stretch and squeeze each rep." },
  tbar_row:           { name: "T-Bar Row",                  muscle: "Back",      equip: "Barbell",  tip: "Thick mid-back builder." },
  straight_arm:       { name: "Straight-Arm Pulldown",      muscle: "Lats",      equip: "Cable",    tip: "Isolates the lats, great mind-muscle." },
  deadlift:           { name: "Deadlift",                   muscle: "Posterior", equip: "Barbell",  tip: "Neutral spine, push the floor away." },

  // ----- BICEPS -----
  barbell_curl:       { name: "Barbell Curl",               muscle: "Biceps",    equip: "Barbell",  tip: "No swinging — strict elbows." },
  db_curl:            { name: "Dumbbell Curl",              muscle: "Biceps",    equip: "Dumbbell", tip: "Supinate at the top for the peak." },
  incline_curl:       { name: "Incline Dumbbell Curl",      muscle: "Biceps",    equip: "Dumbbell", tip: "Stretched position = long-head growth." },
  hammer_curl:        { name: "Hammer Curl",                muscle: "Biceps",    equip: "Dumbbell", tip: "Builds the brachialis for arm thickness." },
  preacher_curl:      { name: "Preacher Curl",              muscle: "Biceps",    equip: "Machine",  tip: "Strict short-head isolation." },
  cable_curl:         { name: "Cable Curl",                 muscle: "Biceps",    equip: "Cable",    tip: "Constant tension throughout." },

  // ----- QUADS -----
  back_squat:         { name: "Barbell Back Squat",         muscle: "Quads",     equip: "Barbell",  tip: "King of leg builders — depth to parallel." },
  front_squat:        { name: "Front Squat",                muscle: "Quads",     equip: "Barbell",  tip: "Upright torso, big quad focus." },
  leg_press:          { name: "Leg Press",                  muscle: "Quads",     equip: "Machine",  tip: "Don't lock out hard, control depth." },
  bulgarian:          { name: "Bulgarian Split Squat",      muscle: "Quads",     equip: "Dumbbell", tip: "Great for symmetry and glutes." },
  hack_squat:         { name: "Hack Squat",                 muscle: "Quads",     equip: "Machine",  tip: "Quad-dominant with a fixed path." },
  leg_extension:      { name: "Leg Extension",              muscle: "Quads",     equip: "Machine",  tip: "Squeeze at the top — quad detail." },
  walking_lunge:      { name: "Walking Lunges",             muscle: "Quads",     equip: "Dumbbell", tip: "Long strides, control each step." },

  // ----- HAMSTRINGS -----
  rdl:                { name: "Romanian Deadlift",          muscle: "Hamstrings", equip: "Barbell", tip: "Hinge at the hips, feel the stretch." },
  lying_leg_curl:     { name: "Lying Leg Curl",             muscle: "Hamstrings", equip: "Machine", tip: "Full curl, control the negative." },
  seated_leg_curl:    { name: "Seated Leg Curl",            muscle: "Hamstrings", equip: "Machine", tip: "Best stretch-position hamstring work." },
  good_morning:       { name: "Good Mornings",              muscle: "Hamstrings", equip: "Barbell", tip: "Light load, strong hinge." },

  // ----- GLUTES -----
  hip_thrust:         { name: "Barbell Hip Thrust",         muscle: "Glutes",    equip: "Barbell",  tip: "Full lockout, squeeze the glutes." },
  glute_bridge:       { name: "Glute Bridge",               muscle: "Glutes",    equip: "Dumbbell", tip: "Pause at the top." },

  // ----- CALVES -----
  standing_calf:      { name: "Standing Calf Raise",        muscle: "Calves",    equip: "Machine",  tip: "Full stretch, pause at the top." },
  seated_calf:        { name: "Seated Calf Raise",          muscle: "Calves",    equip: "Machine",  tip: "Targets the soleus." },

  // ----- ABS / CORE -----
  hanging_leg_raise:  { name: "Hanging Leg Raise",          muscle: "Abs",       equip: "Bodyweight", tip: "Controlled — no swinging." },
  cable_crunch:       { name: "Cable Crunch",               muscle: "Abs",       equip: "Cable",    tip: "Progressive overload for abs." },
  plank:              { name: "Plank",                      muscle: "Core",      equip: "Bodyweight", tip: "Brace hard, straight line." },
  ab_wheel:           { name: "Ab Wheel Rollout",           muscle: "Core",      equip: "Bodyweight", tip: "Keep the core tight, don't sag." },
  bicycle_crunch:     { name: "Bicycle Crunch",             muscle: "Abs",       equip: "Bodyweight", tip: "Slow and controlled twists." },
};

/* ---------- WORKOUT SLOTS PER SPLIT ----------
   Each slot has a primary + alternatives (first = default).
   Aesthetic-focused ordering for a Hrittik-style physique.     */
const SPLIT_SLOTS = {
  push: [
    { name: "Chest — Compound",   sets: 4, reps: "6–10",  options: ["bench_press", "incline_bb_press", "flat_db_press", "chest_dip"] },
    { name: "Upper Chest",        sets: 3, reps: "8–12",  options: ["incline_db_press", "incline_bb_press", "cable_fly"] },
    { name: "Shoulders — Press",  sets: 4, reps: "6–10",  options: ["ohp", "db_shoulder_press", "arnold_press"] },
    { name: "Side Delts (Width)", sets: 4, reps: "12–20", options: ["lateral_raise", "cable_lateral", "upright_row"] },
    { name: "Triceps",            sets: 3, reps: "8–12",  options: ["rope_pushdown", "skull_crusher", "overhead_ext", "close_grip_bench"] },
    { name: "Triceps / Chest Finisher", sets: 3, reps: "10–15", options: ["overhead_ext", "cable_fly", "pec_deck", "triceps_dip"] },
  ],
  pull: [
    { name: "Back — Vertical Pull", sets: 4, reps: "6–10",  options: ["pullup", "lat_pulldown"] },
    { name: "Back — Row",           sets: 4, reps: "8–12",  options: ["barbell_row", "cable_row", "db_row", "tbar_row"] },
    { name: "Lat Isolation",        sets: 3, reps: "10–15", options: ["straight_arm", "lat_pulldown"] },
    { name: "Rear Delts",           sets: 3, reps: "12–20", options: ["face_pull", "rear_delt_fly"] },
    { name: "Biceps",               sets: 4, reps: "8–12",  options: ["barbell_curl", "db_curl", "preacher_curl", "cable_curl"] },
    { name: "Biceps — Detail",      sets: 3, reps: "10–15", options: ["incline_curl", "hammer_curl"] },
  ],
  legs: [
    { name: "Quads — Compound",   sets: 4, reps: "6–10",  options: ["back_squat", "front_squat", "leg_press", "hack_squat"] },
    { name: "Hamstrings — Hinge", sets: 4, reps: "8–12",  options: ["rdl", "good_morning"] },
    { name: "Quads — Secondary",  sets: 3, reps: "10–15", options: ["leg_press", "bulgarian", "walking_lunge", "leg_extension"] },
    { name: "Hamstring Curl",     sets: 3, reps: "10–15", options: ["lying_leg_curl", "seated_leg_curl"] },
    { name: "Glutes",             sets: 3, reps: "10–15", options: ["hip_thrust", "glute_bridge"] },
    { name: "Calves",             sets: 4, reps: "12–20", options: ["standing_calf", "seated_calf"] },
    { name: "Abs / Core",         sets: 3, reps: "12–20", options: ["hanging_leg_raise", "cable_crunch", "ab_wheel", "bicycle_crunch"] },
  ],
};

/* ---------- MUSCLE GROUPS (for smart extras + manual add) ---------- */
const MUSCLE_GROUPS = {
  "Chest":      ["bench_press", "incline_db_press", "incline_bb_press", "flat_db_press", "chest_dip", "cable_fly", "pec_deck", "pushup"],
  "Shoulders":  ["ohp", "db_shoulder_press", "arnold_press", "lateral_raise", "cable_lateral", "upright_row", "rear_delt_fly", "face_pull"],
  "Triceps":    ["rope_pushdown", "overhead_ext", "skull_crusher", "close_grip_bench", "triceps_dip"],
  "Back":       ["pullup", "lat_pulldown", "barbell_row", "cable_row", "db_row", "tbar_row", "straight_arm", "deadlift"],
  "Biceps":     ["barbell_curl", "db_curl", "incline_curl", "hammer_curl", "preacher_curl", "cable_curl"],
  "Quads":      ["back_squat", "front_squat", "leg_press", "bulgarian", "hack_squat", "leg_extension", "walking_lunge"],
  "Hamstrings": ["rdl", "lying_leg_curl", "seated_leg_curl", "good_morning"],
  "Glutes":     ["hip_thrust", "glute_bridge"],
  "Calves":     ["standing_calf", "seated_calf"],
  "Abs / Core": ["hanging_leg_raise", "cable_crunch", "ab_wheel", "bicycle_crunch", "plank"],
};

// which muscle groups belong to each split (used to pick smart extras)
const CATEGORY_GROUPS = {
  push: ["Chest", "Shoulders", "Triceps"],
  pull: ["Back", "Biceps"],
  legs: ["Quads", "Hamstrings", "Glutes", "Calves"],
};

// find the muscle group an exercise belongs to
function groupOf(exId) {
  for (const [g, ids] of Object.entries(MUSCLE_GROUPS)) if (ids.includes(exId)) return g;
  return "Extra";
}

// Motivational tips shown on rest days / dashboard
const COACH_TIPS = [
  "Progressive overload is king — beat your last log by a rep or a little weight.",
  "For the V-taper, never skip side-delt and lat work.",
  "Protein target first, calories second. Hit ~140g protein daily.",
  "Sleep 7–8h — that's when the lean muscle is actually built.",
  "Upper chest + side delts = the aesthetic Hrittik-style frame.",
  "Rest days grow muscle. Recovery is part of the plan.",
  "Track everything. What gets measured gets improved.",
  "Stay lean while bulking — aim for ~0.25 kg/week gain, no faster.",
];

/* ============================================================
   PHYSIQUE GOALS — pick how you want to look (both genders)
   Each look retunes nutrition (calAdj vs TDEE, protein/kg) and
   training emphasis (muscle groups that get extra priority).
   fig = parameters for the illustrated body figure.
   ============================================================ */
const PHYSIQUES = {
  male: [
    { id: "lean_aesthetic", name: "Lean Aesthetic", tagline: "V-taper · Bollywood-lean",
      desc: "Wide shoulders, upper-chest shelf, tiny waist and sharp arms. The classic lean-bulk aesthetic.",
      calAdj: 300, protein: 1.9, emphasis: ["Side Delts", "Upper Chest", "Lats", "Biceps", "Abs"],
      outfits: ["Fitted tees & tanks", "Slim-fit shirts", "Tailored suits", "Beach shorts"],
      fig: { shoulders: 40, waist: 16, hips: 20, arms: 9, legs: 13, tone: 0.95, color: "#ff6b3d" } },
    { id: "greek_classic", name: "Greek God", tagline: "Classic proportions",
      desc: "Broad, square shoulders and full chest with a slim waist — timeless classic-physique look.",
      calAdj: 250, protein: 2.0, emphasis: ["Shoulders", "Side Delts", "Chest", "Upper Chest", "Lats"],
      outfits: ["Open-collar shirts", "Fitted tanks", "Sharp blazers", "Polo tees"],
      fig: { shoulders: 42, waist: 15, hips: 20, arms: 10, legs: 13, tone: 0.85, color: "#f5b301" } },
    { id: "athletic_beach", name: "Athletic Beach", tagline: "Lean & functional",
      desc: "Fit, defined and mobile — abs and shoulders on show without heavy mass.",
      calAdj: 100, protein: 1.8, emphasis: ["Abs", "Side Delts", "Chest", "Quads"],
      outfits: ["Swim shorts", "Tank tops", "Fitted casual tees", "Athleisure"],
      fig: { shoulders: 36, waist: 18, hips: 20, arms: 8, legs: 13, tone: 0.7, color: "#22c55e" } },
    { id: "power_mass", name: "Powerful Mass", tagline: "Big & strong",
      desc: "Maximum size and strength — thick chest, back and legs. Serious bulk.",
      calAdj: 500, protein: 2.0, emphasis: ["Quads", "Back", "Chest", "Shoulders", "Hamstrings"],
      outfits: ["Muscle-fit tees", "Oversized hoodies", "Tank tops", "Broad jackets"],
      fig: { shoulders: 44, waist: 25, hips: 26, arms: 13, legs: 17, tone: 0.4, color: "#3d8bff" } },
    { id: "shredded", name: "Shredded", tagline: "Ripped & dry",
      desc: "Very low body fat with visible abs and vascularity. Conditioning-first.",
      calAdj: -400, protein: 2.2, emphasis: ["Abs", "Side Delts", "Lats", "Triceps"],
      outfits: ["Tank tops", "Beachwear", "Cropped hoodies", "Anything fitted"],
      fig: { shoulders: 36, waist: 14, hips: 18, arms: 8, legs: 12, tone: 1, color: "#ff3d7f" } },
  ],
  female: [
    { id: "toned_lean", name: "Toned & Lean", tagline: "Slim & defined",
      desc: "Light muscle tone, flat stomach and lean limbs — fit without size.",
      calAdj: -150, protein: 1.8, emphasis: ["Glutes", "Abs", "Side Delts"],
      outfits: ["Crop tops", "High-waist jeans", "Fitted dresses", "Bikini & swimwear", "Activewear sets"],
      fig: { shoulders: 26, waist: 15, hips: 30, arms: 7, legs: 12, tone: 0.7, color: "#ff7eb6" } },
    { id: "hourglass", name: "Hourglass Curves", tagline: "Glutes & waist",
      desc: "Rounder glutes and shaped legs with a narrow waist and toned shoulders for the curvy look.",
      calAdj: 150, protein: 1.8, emphasis: ["Glutes", "Hamstrings", "Side Delts", "Quads"],
      outfits: ["Bodycon dresses", "High-waist styles", "Fitted-waist tops", "Swimwear with confidence", "Wrap dresses"],
      fig: { shoulders: 28, waist: 12, hips: 36, arms: 7, legs: 14, tone: 0.6, color: "#ff5c8a" } },
    { id: "athletic_sculpted", name: "Athletic Sculpted", tagline: "Fit & strong",
      desc: "Defined shoulders, abs and glutes — the sporty, sculpted athlete look.",
      calAdj: 0, protein: 1.9, emphasis: ["Shoulders", "Abs", "Glutes", "Back"],
      outfits: ["Sports bras & crop tops", "Backless dresses", "Athleisure sets", "Bikini & swimwear", "Fitted tanks"],
      fig: { shoulders: 31, waist: 15, hips: 30, arms: 8, legs: 13, tone: 0.9, color: "#22c55e" } },
    { id: "strong_fit", name: "Strong & Fit", tagline: "Muscle & power",
      desc: "Build real strength and shapely muscle across the whole body.",
      calAdj: 250, protein: 1.9, emphasis: ["Quads", "Glutes", "Back", "Shoulders"],
      outfits: ["Shoulder-baring tops", "Fitted tanks", "Athletic sets", "Structured dresses"],
      fig: { shoulders: 33, waist: 17, hips: 32, arms: 9, legs: 15, tone: 0.6, color: "#3d8bff" } },
    { id: "slim_slender", name: "Slim & Slender", tagline: "Light & lean",
      desc: "Lower body fat with a slender, elongated line and gentle tone.",
      calAdj: -350, protein: 1.8, emphasis: ["Abs", "Glutes", "Side Delts"],
      outfits: ["Flowy summer dresses", "Slim-fit styles", "Crop tops", "Elegant gowns", "Swimwear"],
      fig: { shoulders: 24, waist: 12, hips: 26, arms: 6, legs: 11, tone: 0.5, color: "#a855f7" } },
  ],
};

/* ============================================================
   FOOD DATABASE — approximate per typical serving.
   Used by the text estimator so you never need to know numbers.
   ============================================================ */
const FOOD_DB = [
  { keys: ["white rice", "cooked rice", "rice", "bhaat", "chawal"], kcal: 200, protein: 4, unit: "bowl" },
  { keys: ["fried rice"], kcal: 330, protein: 8, unit: "plate" },
  { keys: ["biryani", "biriyani"], kcal: 500, protein: 20, unit: "plate" },
  { keys: ["roti", "chapati", "chapathi", "phulka"], kcal: 120, protein: 3, unit: "piece" },
  { keys: ["paratha", "porota"], kcal: 260, protein: 5, unit: "piece" },
  { keys: ["naan"], kcal: 260, protein: 7, unit: "piece" },
  { keys: ["bread", "toast", "slice of bread"], kcal: 80, protein: 3, unit: "slice" },
  { keys: ["dal", "daal", "lentil", "lentils"], kcal: 150, protein: 9, unit: "bowl" },
  { keys: ["rajma", "kidney beans"], kcal: 200, protein: 12, unit: "bowl" },
  { keys: ["chole", "chana", "chickpea", "chickpeas"], kcal: 210, protein: 11, unit: "bowl" },
  { keys: ["soya", "soybean", "soya chunks"], kcal: 180, protein: 26, unit: "bowl" },
  { keys: ["paneer"], kcal: 265, protein: 18, unit: "100g" },
  { keys: ["tofu"], kcal: 180, protein: 15, unit: "100g" },
  { keys: ["chicken breast", "grilled chicken", "chicken curry", "chicken"], kcal: 250, protein: 46, unit: "serving" },
  { keys: ["mutton", "lamb", "goat"], kcal: 300, protein: 25, unit: "bowl" },
  { keys: ["fish", "salmon", "rohu", "tuna"], kcal: 200, protein: 22, unit: "piece" },
  { keys: ["prawn", "shrimp"], kcal: 120, protein: 20, unit: "serving" },
  { keys: ["egg white", "egg whites"], kcal: 18, protein: 4, unit: "piece" },
  { keys: ["omelette", "omelet"], kcal: 180, protein: 12, unit: "serving" },
  { keys: ["boiled egg", "egg", "eggs", "anda"], kcal: 78, protein: 6, unit: "piece" },
  { keys: ["milk", "doodh"], kcal: 150, protein: 8, unit: "glass" },
  { keys: ["curd", "yogurt", "dahi", "greek yogurt"], kcal: 100, protein: 8, unit: "bowl" },
  { keys: ["cheese"], kcal: 110, protein: 7, unit: "slice" },
  { keys: ["whey", "protein shake", "protein powder", "scoop"], kcal: 120, protein: 24, unit: "scoop" },
  { keys: ["oats", "oatmeal", "dalia"], kcal: 150, protein: 5, unit: "bowl" },
  { keys: ["poha"], kcal: 250, protein: 5, unit: "plate" },
  { keys: ["upma"], kcal: 250, protein: 6, unit: "plate" },
  { keys: ["idli"], kcal: 60, protein: 2, unit: "piece" },
  { keys: ["dosa", "masala dosa"], kcal: 170, protein: 4, unit: "piece" },
  { keys: ["vada", "medu vada"], kcal: 140, protein: 4, unit: "piece" },
  { keys: ["samosa"], kcal: 260, protein: 4, unit: "piece" },
  { keys: ["pakora", "pakoda", "bhaji"], kcal: 180, protein: 4, unit: "serving" },
  { keys: ["banana", "kela"], kcal: 105, protein: 1, unit: "piece" },
  { keys: ["apple", "seb"], kcal: 95, protein: 0, unit: "piece" },
  { keys: ["mango", "aam"], kcal: 150, protein: 1, unit: "piece" },
  { keys: ["orange"], kcal: 62, protein: 1, unit: "piece" },
  { keys: ["peanut butter", "peanuts", "moongfali"], kcal: 95, protein: 4, unit: "tbsp" },
  { keys: ["almonds", "badam"], kcal: 70, protein: 3, unit: "handful" },
  { keys: ["ghee"], kcal: 45, protein: 0, unit: "tsp" },
  { keys: ["butter", "makhan"], kcal: 36, protein: 0, unit: "tsp" },
  { keys: ["oil"], kcal: 40, protein: 0, unit: "tsp" },
  { keys: ["salad"], kcal: 50, protein: 2, unit: "bowl" },
  { keys: ["mixed vegetables", "sabzi", "sabji", "vegetable curry", "veg curry"], kcal: 150, protein: 4, unit: "bowl" },
  { keys: ["coffee", "latte"], kcal: 60, protein: 2, unit: "cup" },
  { keys: ["tea", "chai"], kcal: 60, protein: 2, unit: "cup" },
  { keys: ["green tea", "black coffee"], kcal: 5, protein: 0, unit: "cup" },
  { keys: ["gulab jamun", "rasgulla", "sweet", "mithai", "dessert"], kcal: 150, protein: 2, unit: "piece" },
  { keys: ["ice cream"], kcal: 200, protein: 4, unit: "scoop" },
  { keys: ["chocolate"], kcal: 230, protein: 3, unit: "bar" },
  { keys: ["biscuit", "cookie"], kcal: 50, protein: 1, unit: "piece" },
  { keys: ["pizza"], kcal: 285, protein: 12, unit: "slice" },
  { keys: ["burger"], kcal: 350, protein: 15, unit: "piece" },
  { keys: ["maggi", "noodles", "ramen"], kcal: 350, protein: 8, unit: "pack" },
  { keys: ["pasta"], kcal: 300, protein: 10, unit: "bowl" },
  { keys: ["sandwich"], kcal: 250, protein: 9, unit: "piece" },
  { keys: ["protein bar"], kcal: 200, protein: 20, unit: "bar" },
];

// number words → value
const NUM_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, half: 0.5, couple: 2, few: 3, dozen: 12,
};

// words that denote a serving (counted as 1 when no number given)
const SERVING_WORDS = ["bowl", "bowls", "plate", "plates", "glass", "glasses", "cup", "cups",
  "piece", "pieces", "slice", "slices", "scoop", "scoops", "spoon", "tbsp", "tsp",
  "katori", "handful", "pack", "bar", "bowlful", "serving", "servings"];

/* ---------- DIET PREFERENCES + CUISINE MEAL SUGGESTIONS ---------- */
const DIETS = { nonveg: "Non-veg", egg: "Eggetarian", veg: "Vegetarian", vegan: "Vegan" };

// diet hierarchy — a meal is allowed if its requirement rank <= the user's rank
const DIET_RANK = { vegan: 0, veg: 1, egg: 2, nonveg: 3 };
function dietAllows(mealDiet, userDiet) {
  return (DIET_RANK[mealDiet] ?? 0) <= (DIET_RANK[userDiet] ?? 3);
}

// tell me the cuisine, I'll suggest meals (filtered by your diet)
const CUISINES = {
  bengali: { name: "Bengali", meals: [
    { name: "Macher jhol (fish curry) + rice", kcal: 550, protein: 35, diet: "nonveg" },
    { name: "Chicken kosha + rice", kcal: 650, protein: 42, diet: "nonveg" },
    { name: "Dim'er dalna (egg curry) + rice", kcal: 520, protein: 22, diet: "egg" },
    { name: "Cholar dal + luchi", kcal: 600, protein: 16, diet: "veg" },
    { name: "Shukto + rice + moong dal", kcal: 450, protein: 15, diet: "veg" },
    { name: "Ghugni (yellow peas) + rice", kcal: 480, protein: 18, diet: "vegan" },
  ] },
  north_indian: { name: "North Indian", meals: [
    { name: "Butter chicken + 2 roti", kcal: 680, protein: 40, diet: "nonveg" },
    { name: "Chicken curry + rice", kcal: 600, protein: 38, diet: "nonveg" },
    { name: "Egg bhurji + 2 roti", kcal: 450, protein: 22, diet: "egg" },
    { name: "Paneer butter masala + roti", kcal: 620, protein: 26, diet: "veg" },
    { name: "Dal makhani + rice", kcal: 560, protein: 18, diet: "veg" },
    { name: "Chana masala + rice", kcal: 520, protein: 18, diet: "vegan" },
  ] },
  south_indian: { name: "South Indian", meals: [
    { name: "Chicken Chettinad + rice", kcal: 620, protein: 40, diet: "nonveg" },
    { name: "Fish fry + rice + sambar", kcal: 580, protein: 34, diet: "nonveg" },
    { name: "Egg dosa + chutney", kcal: 420, protein: 16, diet: "egg" },
    { name: "Masala dosa + sambar", kcal: 450, protein: 12, diet: "veg" },
    { name: "Curd rice + veg poriyal", kcal: 420, protein: 12, diet: "veg" },
    { name: "Idli + sambar", kcal: 350, protein: 12, diet: "vegan" },
  ] },
  punjabi: { name: "Punjabi", meals: [
    { name: "Tandoori chicken + 2 roti", kcal: 600, protein: 45, diet: "nonveg" },
    { name: "Amritsari fish + rice", kcal: 620, protein: 34, diet: "nonveg" },
    { name: "Egg curry + paratha", kcal: 560, protein: 22, diet: "egg" },
    { name: "Paneer tikka + roti", kcal: 560, protein: 30, diet: "veg" },
    { name: "Rajma chawal", kcal: 550, protein: 22, diet: "vegan" },
    { name: "Chole + rice", kcal: 540, protein: 20, diet: "vegan" },
  ] },
  chinese: { name: "Chinese", meals: [
    { name: "Chicken fried rice", kcal: 550, protein: 32, diet: "nonveg" },
    { name: "Chilli chicken + noodles", kcal: 660, protein: 35, diet: "nonveg" },
    { name: "Egg fried rice", kcal: 480, protein: 18, diet: "egg" },
    { name: "Veg Manchurian + fried rice", kcal: 560, protein: 14, diet: "veg" },
    { name: "Tofu stir-fry + rice", kcal: 500, protein: 24, diet: "vegan" },
    { name: "Veg Hakka noodles", kcal: 480, protein: 12, diet: "vegan" },
  ] },
  italian: { name: "Italian", meals: [
    { name: "Grilled chicken pasta", kcal: 600, protein: 40, diet: "nonveg" },
    { name: "Chicken parmesan + salad", kcal: 660, protein: 42, diet: "nonveg" },
    { name: "Cheese & veg frittata", kcal: 420, protein: 24, diet: "egg" },
    { name: "Margherita pizza", kcal: 700, protein: 26, diet: "veg" },
    { name: "Pasta primavera", kcal: 520, protein: 16, diet: "veg" },
    { name: "Minestrone + bread", kcal: 400, protein: 14, diet: "vegan" },
  ] },
  continental: { name: "Continental", meals: [
    { name: "Grilled chicken + veggies", kcal: 450, protein: 45, diet: "nonveg" },
    { name: "Steak + salad", kcal: 600, protein: 45, diet: "nonveg" },
    { name: "Omelette + toast", kcal: 400, protein: 24, diet: "egg" },
    { name: "Paneer steak + salad", kcal: 480, protein: 28, diet: "veg" },
    { name: "Grilled veg + hummus", kcal: 420, protein: 16, diet: "vegan" },
    { name: "Bean & quinoa bowl", kcal: 470, protein: 20, diet: "vegan" },
  ] },
  mexican: { name: "Mexican", meals: [
    { name: "Chicken burrito", kcal: 650, protein: 38, diet: "nonveg" },
    { name: "Chicken quesadilla", kcal: 600, protein: 34, diet: "nonveg" },
    { name: "Egg breakfast burrito", kcal: 500, protein: 22, diet: "egg" },
    { name: "Bean & cheese burrito", kcal: 580, protein: 22, diet: "veg" },
    { name: "Bean tacos + guacamole", kcal: 500, protein: 20, diet: "vegan" },
    { name: "Veg fajita bowl", kcal: 460, protein: 14, diet: "vegan" },
  ] },
};

/* ---------- FULL-DAY PLANNER: meals by slot ----------
   You type preferences, the planner builds Breakfast/Lunch/Snack/Dinner.
   tags = cuisine + food keywords used for text matching.               */
const MEAL_SLOTS = ["Breakfast", "Lunch", "Snack", "Dinner"];

const MEAL_LIBRARY = {
  Breakfast: [
    { name: "3 eggs + 2 toast + milk", kcal: 450, protein: 28, diet: "egg", tags: ["egg", "western", "quick", "highprotein"] },
    { name: "Masala omelette + 2 roti", kcal: 480, protein: 26, diet: "egg", tags: ["egg", "indian", "highprotein"] },
    { name: "Chicken sausage + scrambled eggs", kcal: 500, protein: 35, diet: "nonveg", tags: ["chicken", "western", "highprotein"] },
    { name: "Paneer paratha + curd", kcal: 500, protein: 22, diet: "veg", tags: ["paneer", "indian", "punjabi"] },
    { name: "Greek yogurt + granola + nuts", kcal: 400, protein: 24, diet: "veg", tags: ["western", "quick", "highprotein"] },
    { name: "Oats + peanut butter + banana", kcal: 420, protein: 16, diet: "vegan", tags: ["oats", "western", "quick"] },
    { name: "Poha + roasted peanuts", kcal: 350, protein: 10, diet: "vegan", tags: ["indian", "light", "quick"] },
    { name: "Idli + sambar", kcal: 350, protein: 12, diet: "vegan", tags: ["south indian", "indian", "light"] },
  ],
  Lunch: [
    { name: "Chicken curry + rice + salad", kcal: 650, protein: 45, diet: "nonveg", tags: ["chicken", "indian", "highprotein"] },
    { name: "Macher jhol (fish) + rice", kcal: 600, protein: 35, diet: "nonveg", tags: ["fish", "bengali", "indian"] },
    { name: "Grilled chicken pasta", kcal: 600, protein: 40, diet: "nonveg", tags: ["chicken", "italian", "western", "highprotein"] },
    { name: "Chicken fried rice", kcal: 620, protein: 34, diet: "nonveg", tags: ["chicken", "chinese"] },
    { name: "Egg curry + rice", kcal: 560, protein: 24, diet: "egg", tags: ["egg", "indian"] },
    { name: "Paneer + 2 roti + dal", kcal: 620, protein: 30, diet: "veg", tags: ["paneer", "indian", "highprotein"] },
    { name: "Rajma + rice + curd", kcal: 580, protein: 24, diet: "veg", tags: ["indian", "punjabi"] },
    { name: "Veg fried rice + Manchurian", kcal: 600, protein: 16, diet: "veg", tags: ["chinese"] },
    { name: "Chole + rice", kcal: 540, protein: 20, diet: "vegan", tags: ["indian", "punjabi"] },
  ],
  Snack: [
    { name: "Whey shake + banana", kcal: 250, protein: 28, diet: "veg", tags: ["highprotein", "quick", "western"] },
    { name: "3 boiled eggs + fruit", kcal: 280, protein: 20, diet: "egg", tags: ["egg", "highprotein", "quick"] },
    { name: "Chicken sandwich", kcal: 350, protein: 26, diet: "nonveg", tags: ["chicken", "western", "highprotein"] },
    { name: "Paneer tikka (small)", kcal: 300, protein: 22, diet: "veg", tags: ["paneer", "indian", "highprotein"] },
    { name: "Greek yogurt + berries", kcal: 200, protein: 18, diet: "veg", tags: ["western", "quick", "light"] },
    { name: "Roasted chana + peanuts", kcal: 250, protein: 12, diet: "vegan", tags: ["indian", "quick"] },
    { name: "Sprouts salad", kcal: 200, protein: 14, diet: "vegan", tags: ["indian", "light"] },
    { name: "Peanut butter toast", kcal: 300, protein: 12, diet: "vegan", tags: ["western", "quick"] },
  ],
  Dinner: [
    { name: "Grilled chicken + veggies", kcal: 500, protein: 45, diet: "nonveg", tags: ["chicken", "western", "highprotein", "light"] },
    { name: "Fish + rice + sabzi", kcal: 580, protein: 34, diet: "nonveg", tags: ["fish", "bengali", "indian"] },
    { name: "Egg curry + 2 roti", kcal: 520, protein: 24, diet: "egg", tags: ["egg", "indian"] },
    { name: "Paneer bhurji + 2 roti", kcal: 560, protein: 28, diet: "veg", tags: ["paneer", "indian", "highprotein"] },
    { name: "Soya chunks curry + rice", kcal: 540, protein: 34, diet: "veg", tags: ["indian", "highprotein"] },
    { name: "Margherita pizza (2 slices)", kcal: 560, protein: 22, diet: "veg", tags: ["italian", "western"] },
    { name: "Tofu stir-fry + rice", kcal: 520, protein: 26, diet: "vegan", tags: ["chinese", "highprotein"] },
    { name: "Dal + rice + salad", kcal: 500, protein: 18, diet: "vegan", tags: ["indian", "light"] },
  ],
};
