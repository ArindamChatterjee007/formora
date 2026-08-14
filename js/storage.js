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

  // ensure state has all arrays/profile fields (after schema changes or a cloud restore)
  normalize() {
    if (!this.state.profile) this.state.profile = structuredClone(DEFAULT_PROFILE);
    for (const k of ["weightLog", "workoutLog", "foodLog", "restDays"]) {
      if (!Array.isArray(this.state[k])) this.state[k] = [];
    }
    for (const k in DEFAULT_PROFILE) {
      if (this.state.profile[k] === undefined) this.state.profile[k] = structuredClone(DEFAULT_PROFILE[k]);
    }
  },

  // union-merge a cloud copy into local state so no logged entry is ever lost across devices
  merge(cloud) {
    if (!cloud) return this.state;
    const L = this.state, C = cloud;
    const wMap = new Map();
    (C.weightLog || []).forEach((w) => wMap.set(w.date, w));
    (L.weightLog || []).forEach((w) => wMap.set(w.date, w)); // local edit wins per date
    const weightLog = [...wMap.values()].sort((a, b) => a.date.localeCompare(b.date));
    const woMap = new Map();
    [...(C.workoutLog || []), ...(L.workoutLog || [])].forEach((e) => woMap.set(JSON.stringify(e), e));
    const workoutLog = [...woMap.values()].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const fMap = new Map();
    (C.foodLog || []).forEach((f) => fMap.set(f.date, { date: f.date, items: [...(f.items || [])] }));
    (L.foodLog || []).forEach((f) => {
      const ex = fMap.get(f.date);
      if (!ex) { fMap.set(f.date, { date: f.date, items: [...(f.items || [])] }); return; }
      const seen = new Set(ex.items.map((i) => i.text));
      (f.items || []).forEach((i) => { if (!seen.has(i.text)) ex.items.push(i); });
    });
    const foodLog = [...fMap.values()].sort((a, b) => a.date.localeCompare(b.date));
    const restDays = [...new Set([...(C.restDays || []), ...(L.restDays || [])])];
    const newer = (C.updatedAt || 0) > (L.updatedAt || 0) ? C.profile : L.profile;
    const older = newer === C.profile ? L.profile : C.profile;
    const profile = Object.assign({}, older || {}, newer || {});
    if (!profile.avatar && older && older.avatar) profile.avatar = older.avatar;
    profile.onboarded = !!(L.profile && L.profile.onboarded) || !!(C.profile && C.profile.onboarded);
    this.state = Object.assign({}, C, L, { profile, weightLog, workoutLog, foodLog, restDays });
    return this.state;
  },

  save() {
    this.state.updatedAt = Date.now();
    if (typeof Cloud !== "undefined" && Cloud.active && Cloud.active() && Cloud.me) {
      clearTimeout(this._pushTimer);
      this._pushTimer = setTimeout(() => Cloud.pushAccount(this.state), 1200);
    }
    const put = () => localStorage.setItem(this.key, JSON.stringify(this.state));
    try { put(); return; } catch (e) {}
    // out of space: protect the user's LOGS by shedding heavy on-device images, then retry
    try { if (this.state.profile) this.state.profile.avatar = null; put();
      alert("Your device storage was full, so your profile photo couldn't be saved on-device — but all your logs are safe. (Online photos are coming.)"); return; } catch (e) {}
    try { if (this.state.profile) this.state.profile.lookPhotos = {}; put();
      alert("Your device storage was full — on-device reference photos were cleared to protect your logs."); return; } catch (e) {}
    alert("Your device storage is full; the latest change couldn't be saved. Your existing logs are safe.");
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
