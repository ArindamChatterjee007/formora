/* ============================================================
   STORAGE: localStorage wrapper for all app data
   ============================================================ */

const STORE_KEY = "gymcoach_v1";

const DEFAULT_STATE = {
  profile: null,          // set from DEFAULT_PROFILE on first run
  weightLog: [],          // [{date:'YYYY-MM-DD', kg:Number}]
  workoutLog: [],         // [{date, split, exercises:[{id,name,muscle,sets:[{reps,weight}]}], volume}]
  foodLog: [],            // [{date, items:[{text, kcal, protein}]}]
  restDays: [],           // ['YYYY-MM-DD']
};

const Store = {
  state: null,
  key: STORE_KEY,

  load(key) {
    this.key = key || STORE_KEY;
    try {
      const raw = localStorage.getItem(this.key);
      this.state = raw ? JSON.parse(raw) : structuredClone(DEFAULT_STATE);
    } catch {
      this.state = structuredClone(DEFAULT_STATE);
    }
    if (!this.state.profile) {
      this.state.profile = structuredClone(DEFAULT_PROFILE);
      // seed the first weight entry
      this.state.weightLog.push({ date: todayISO(), kg: DEFAULT_PROFILE.startWeightKg });
      this.save();
    }
    // guard against missing arrays after schema changes
    for (const k of ["weightLog", "workoutLog", "foodLog", "restDays"]) {
      if (!Array.isArray(this.state[k])) this.state[k] = [];
    }
    // backfill any profile fields added in later versions
    for (const k in DEFAULT_PROFILE) {
      if (this.state.profile[k] === undefined) this.state.profile[k] = structuredClone(DEFAULT_PROFILE[k]);
    }
    // migrate pre-onboarding users: an existing, already-used profile is considered onboarded
    if (!this.state.profile.onboarded &&
      (this.state.profile.name || this.state.workoutLog.length || this.state.foodLog.length || this.state.weightLog.length > 1)) {
      this.state.profile.onboarded = true;
    }
    return this.state;
  },

  save() {
    try {
      localStorage.setItem(this.key, JSON.stringify(this.state));
    } catch (e) {
      alert("Storage is full — remove some meal or reference photos to free space.");
    }
  },

  // ---- weight ----
  latestWeight() {
    if (!this.state.weightLog.length) return this.state.profile.startWeightKg;
    return [...this.state.weightLog].sort((a, b) => a.date.localeCompare(b.date)).at(-1).kg;
  },
  logWeight(kg, date = todayISO()) {
    const existing = this.state.weightLog.find((w) => w.date === date);
    if (existing) existing.kg = kg;
    else this.state.weightLog.push({ date, kg });
    this.save();
  },

  // ---- workouts ----
  logWorkout(entry) {
    this.state.workoutLog.push(entry);
    // remove any rest-day mark for that date
    this.state.restDays = this.state.restDays.filter((d) => d !== entry.date);
    this.save();
  },
  logRestDay(date = todayISO()) {
    if (!this.state.restDays.includes(date)) this.state.restDays.push(date);
    this.save();
  },
  workoutOn(date) {
    return this.state.workoutLog.find((w) => w.date === date);
  },

  // ---- food ----
  logFood(item, date = todayISO()) {
    let day = this.state.foodLog.find((f) => f.date === date);
    if (!day) { day = { date, items: [] }; this.state.foodLog.push(day); }
    day.items.push(item);
    this.save();
  },
  removeFood(date, index) {
    const day = this.state.foodLog.find((f) => f.date === date);
    if (day) { day.items.splice(index, 1); this.save(); }
  },
  foodOn(date) {
    return this.state.foodLog.find((f) => f.date === date) || { date, items: [] };
  },

  reset() {
    localStorage.removeItem(this.key);
    this.state = null;
    this.load(this.key);
  },
};

// ---- date helpers ----
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function pad(n) { return String(n).padStart(2, "0"); }
function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}
function prettyDate(iso) {
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, {
    weekday: "short", day: "numeric", month: "short",
  });
}
