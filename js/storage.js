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
    clearTimeout(this._pushTimer);
    this._syncReady = false;
    this.key = key || STORE_KEY;
    try {
      const raw = localStorage.getItem(this.key);
      this.state = raw ? JSON.parse(raw) : structuredClone(DEFAULT_STATE);
    } catch {
      this.state = structuredClone(DEFAULT_STATE);
    }
    if (!this.state.profile) {
      this.state.profile = structuredClone(DEFAULT_PROFILE);
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
    [...(C.workoutLog || []), ...(L.workoutLog || [])].forEach((entry) => {
      const previous = woMap.get(entry.date);
      if (!previous || entry.finalizationRequestId || !previous.finalizationRequestId) woMap.set(entry.date, entry);
    });
    const workoutLog = [...woMap.values()].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const foodLog = this._mergeFoodLog(C.foodLog, L.foodLog);
    const restDays = [...new Set([...(C.restDays || []), ...(L.restDays || [])])];
    const newer = (C.updatedAt || 0) > (L.updatedAt || 0) ? C.profile : L.profile;
    const older = newer === C.profile ? L.profile : C.profile;
    const profile = Object.assign({}, older || {}, newer || {});
    if (!profile.avatar && older && older.avatar) profile.avatar = older.avatar;
    profile.onboarded = !!(L.profile && L.profile.onboarded) || !!(C.profile && C.profile.onboarded);
    this.state = Object.assign({}, C, L, { profile, weightLog, workoutLog, foodLog, restDays, updatedAt: Math.max(C.updatedAt || 0, L.updatedAt || 0) });
    return this.state;
  },

  _foodId(item) {
    return item && typeof item === "object" && typeof item.id === "string" && item.id ? item.id : "";
  },
  // identity of an id-less entry is its whole content, so an edited or differently portioned meal stays distinct
  _foodKey(item) {
    const canon = (value) => {
      if (Array.isArray(value)) return value.map(canon);
      if (value && typeof value === "object") {
        const out = {};
        for (const k of Object.keys(value).sort()) if (value[k] !== undefined) out[k] = canon(value[k]);
        return out;
      }
      return value === undefined ? null : value;
    };
    if (!item || typeof item !== "object" || Array.isArray(item)) return JSON.stringify(canon(item));
    const rest = Object.assign({}, item);
    delete rest.id;
    return JSON.stringify(canon(rest));
  },
  _copyFood(item) {
    return item && typeof item === "object" && !Array.isArray(item) ? Object.assign({}, item) : item;
  },

  // union one day of food across two copies: every id survives exactly once, and identical id-less
  // entries keep the LARGER multiplicity of the two copies — a re-sent older copy can neither drop a
  // second serving nor invent a third one, and repeating the merge changes nothing.
  _mergeFoodItems(cloudItems, localItems) {
    const cloudById = new Map(), localById = new Map();
    const index = (items, map) => items.forEach((item) => { const id = this._foodId(item); if (id && !map.has(id)) map.set(id, item); });
    index(cloudItems, cloudById);
    index(localItems, localById);
    const winner = (id) => localById.get(id) || cloudById.get(id); // a local edit of the same entry wins
    const stats = new Map();
    const statFor = (key) => {
      let s = stats.get(key);
      if (!s) { s = { cloud: 0, local: 0, winners: 0 }; stats.set(key, s); }
      return s;
    };
    // count each side by the signature an entry actually keeps once id winners are resolved, so a
    // superseded older copy of an id neither counts as nor consumes a legacy serving of its old value
    const scan = (items, side) => {
      const seen = new Set();
      items.forEach((item) => {
        const id = this._foodId(item);
        if (id) { if (seen.has(id)) return; seen.add(id); }
        statFor(this._foodKey(id ? winner(id) : item))[side]++;
      });
    };
    scan(cloudItems, "cloud");
    scan(localItems, "local");
    new Set([...cloudById.keys(), ...localById.keys()]).forEach((id) => { statFor(this._foodKey(winner(id))).winners++; });
    const items = [], usedIds = new Set(), usedLegacy = new Map();
    const take = (item) => {
      const id = this._foodId(item);
      if (id) {
        if (usedIds.has(id)) return;
        usedIds.add(id);
        items.push(this._copyFood(winner(id)));
        return;
      }
      const key = this._foodKey(item), s = stats.get(key);
      const quota = Math.max(s.cloud, s.local, s.winners) - s.winners;
      const used = usedLegacy.get(key) || 0;
      if (used >= quota) return;
      usedLegacy.set(key, used + 1);
      items.push(this._copyFood(item));
    };
    cloudItems.forEach(take);
    localItems.forEach(take);
    return items;
  },
  _mergeFoodLog(cloudLog, localLog) {
    const days = new Map();
    const collect = (log, side) => (Array.isArray(log) ? log : []).forEach((f) => {
      if (!f) return;
      let slot = days.get(f.date);
      if (!slot) { slot = { date: f.date, cloud: [], local: [] }; days.set(f.date, slot); }
      if (Array.isArray(f.items)) slot[side] = slot[side].concat(f.items);
    });
    collect(cloudLog, "cloud");
    collect(localLog, "local");
    return [...days.values()]
      .map((slot) => ({ date: slot.date, items: this._mergeFoodItems(slot.cloud, slot.local) }))
      .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  },

  save({ touch = true } = {}) {
    if (touch) this.state.updatedAt = Date.now();
    if (this._syncReady && typeof Cloud !== "undefined" && Cloud.active && Cloud.active() && Cloud.me) {
      clearTimeout(this._pushTimer);
      const key = this.key, uid = Cloud.me;
      this._pushTimer = setTimeout(() => {
        if (this._syncReady && this.key === key && Cloud.me === uid) Cloud.pushAccount(this.state);
      }, 1200);
    }
    const put = () => localStorage.setItem(this.key, JSON.stringify(this.state));
    try { put(); return; } catch (e) {}
    // out of space: protect the user's LOGS by shedding heavy on-device images, then retry
    try { if (this.state.profile) this.state.profile.cover = null; put();
      alert("Your device storage was full, so your cover photo couldn't be saved on-device — but all your logs are safe."); return; } catch (e) {}
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
    day.items.push(this._newFoodEntry(item));
    this.save();
  },
  // the id is minted only here, at the moment a serving is logged: that is what lets a later merge
  // tell a genuine second serving from the same serving arriving again from another device.
  // Entries logged before this existed stay id-less on purpose — assigning ids on load would mint a
  // different id per device for the same entry and turn one meal into two.
  _newFoodEntry(item) {
    const entry = this._copyFood(item);
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || this._foodId(entry)) return entry;
    const source = typeof crypto !== "undefined" ? crypto : null;
    if (source && typeof source.randomUUID === "function") entry.id = source.randomUUID();
    return entry;
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
