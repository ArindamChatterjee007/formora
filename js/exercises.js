/* ============================================================
   EXERCISES — full searchable exercise library with real photos.
   Data: yuhonas/free-exercise-db (public domain, 873 exercises,
   every one has demo images). Loaded once from the jsDelivr CDN
   and kept in memory; falls back to the built-in EXERCISES set
   if the network is unavailable.
   ============================================================ */
const Exercises = {
  CDN: "https://cdn.jsdelivr.net/gh/yuhonas/free-exercise-db@main",
  _cat: null,
  _loading: null,
  _onPick: null,
  _q: "",
  _group: "",
  _equip: "",

  imgFor(ex) {
    if (!ex) return "";
    if (ex.photo) return ex.photo;                                   // explicit URL (logged history)
    if (ex.images && ex.images[0]) return this.CDN + "/exercises/" + ex.images[0];
    return "";
  },
  ready() { return !!this._cat; },
  async load() {
    if (this._cat) return this._cat;
    if (this._loading) return this._loading;
    this._loading = fetch(this.CDN + "/dist/exercises.json")
      .then((r) => { if (!r.ok) throw new Error("catalog " + r.status); return r.json(); })
      .then((d) => {
        this._cat = (d || []).map((e) => ({
          id: e.id, name: e.name,
          equip: this._equipName(e.equipment), equipCat: this._equipCat(e.equipment),
          muscle: this._muscleName(e.primaryMuscles), group: this._group2(e.primaryMuscles),
          images: e.images || [], instr: (e.instructions || []).slice(0, 4),
        }));
        return this._cat;
      })
      .catch(() => { this._cat = this._fallback(); return this._cat; });
    return this._loading;
  },
  _fallback() {
    return Object.entries(EXERCISES).map(([id, x]) => ({ id, name: x.name, equip: x.equip, equipCat: (x.equip || "").toLowerCase().includes("machine") ? "Machine" : x.equip, muscle: x.muscle, group: this._groupFromMuscle(x.muscle), images: [], instr: [x.tip] }));
  },
  _equipName(e) { if (!e) return "Other"; if (e === "body only") return "Bodyweight"; if (e === "e-z curl bar") return "EZ-Bar"; return e[0].toUpperCase() + e.slice(1); },
  _equipCat(e) { if (!e) return "Other"; if (["machine", "barbell", "dumbbell", "cable"].includes(e)) return e[0].toUpperCase() + e.slice(1); if (e === "body only") return "Bodyweight"; return "Other"; },
  _muscleName(arr) { const m = (arr && arr[0]) || ""; return m ? m[0].toUpperCase() + m.slice(1) : "Full body"; },
  _group2(arr) { return this._groupFromMuscle((arr && arr[0]) || ""); },
  _groupFromMuscle(m) {
    m = (m || "").toLowerCase();
    if (m.includes("chest")) return "Chest";
    if (["lats", "middle back", "traps"].some((x) => m.includes(x)) || m === "back") return "Back";
    if (m.includes("shoulder") || m.includes("delt")) return "Shoulders";
    if (["bicep", "tricep", "forearm"].some((x) => m.includes(x))) return "Arms";
    if (["quad", "hamstring", "glute", "calve", "calf", "adductor", "abductor"].some((x) => m.includes(x))) return "Legs";
    if (["abdominal", "abs", "core", "lower back"].some((x) => m.includes(x))) return "Core";
    return "Other";
  },
  GROUPS: ["Chest", "Back", "Shoulders", "Arms", "Legs", "Core"],
  EQUIPS: ["Machine", "Barbell", "Dumbbell", "Cable", "Bodyweight"],

  // built-in plan exercises → best free-exercise-db demo photo (every URL verified 200)
  CURATED_IMG: {
    bench_press: "Barbell_Bench_Press_-_Medium_Grip/0.jpg", incline_db_press: "Incline_Dumbbell_Press/0.jpg", incline_bb_press: "Barbell_Incline_Bench_Press_-_Medium_Grip/0.jpg",
    flat_db_press: "Dumbbell_Bench_Press/0.jpg", chest_dip: "Dip_Machine/0.jpg", cable_fly: "Cable_Crossover/0.jpg", pec_deck: "Butterfly/0.jpg", pushup: "Pushups/0.jpg",
    ohp: "Standing_Military_Press/0.jpg", db_shoulder_press: "Seated_Dumbbell_Press/0.jpg", arnold_press: "Arnold_Dumbbell_Press/0.jpg", lateral_raise: "Side_Lateral_Raise/0.jpg",
    cable_lateral: "Cable_Seated_Lateral_Raise/0.jpg", upright_row: "Upright_Cable_Row/0.jpg", rear_delt_fly: "Reverse_Machine_Flyes/0.jpg", face_pull: "Face_Pull/0.jpg",
    close_grip_bench: "Close-Grip_Barbell_Bench_Press/0.jpg", rope_pushdown: "Triceps_Pushdown_-_Rope_Attachment/0.jpg", overhead_ext: "Standing_Overhead_Barbell_Triceps_Extension/0.jpg",
    skull_crusher: "Lying_Triceps_Press/0.jpg", triceps_dip: "Dips_-_Triceps_Version/0.jpg", pullup: "Pullups/0.jpg", lat_pulldown: "Wide-Grip_Lat_Pulldown/0.jpg",
    barbell_row: "Bent_Over_Barbell_Row/0.jpg", cable_row: "Seated_Cable_Rows/0.jpg", db_row: "One-Arm_Dumbbell_Row/0.jpg", tbar_row: "T-Bar_Row_with_Handle/0.jpg",
    straight_arm: "Straight-Arm_Pulldown/0.jpg", deadlift: "Barbell_Deadlift/0.jpg", barbell_curl: "Barbell_Curl/0.jpg", db_curl: "Dumbbell_Bicep_Curl/0.jpg",
    incline_curl: "Incline_Dumbbell_Curl/0.jpg", hammer_curl: "Hammer_Curls/0.jpg", preacher_curl: "Preacher_Curl/0.jpg", cable_curl: "Standing_Biceps_Cable_Curl/0.jpg",
    back_squat: "Barbell_Squat/0.jpg", front_squat: "Front_Barbell_Squat/0.jpg", leg_press: "Leg_Press/0.jpg", bulgarian: "Barbell_Side_Split_Squat/0.jpg", hack_squat: "Hack_Squat/0.jpg",
    leg_extension: "Leg_Extensions/0.jpg", walking_lunge: "Dumbbell_Lunges/0.jpg", rdl: "Romanian_Deadlift/0.jpg", lying_leg_curl: "Lying_Leg_Curls/0.jpg",
    seated_leg_curl: "Seated_Leg_Curl/0.jpg", good_morning: "Good_Morning/0.jpg", hip_thrust: "Barbell_Hip_Thrust/0.jpg", glute_bridge: "Butt_Lift_Bridge/0.jpg",
    standing_calf: "Standing_Calf_Raises/0.jpg", seated_calf: "Seated_Calf_Raise/0.jpg", hanging_leg_raise: "Hanging_Leg_Raise/0.jpg", cable_crunch: "Cable_Crunch/0.jpg",
    plank: "Plank/0.jpg", ab_wheel: "Ab_Roller/0.jpg", bicycle_crunch: "Air_Bike/0.jpg",
  },
  imgForCurated(id) { const p = this.CURATED_IMG[id]; return p ? this.CDN + "/exercises/" + p : ""; },

  search(q, group, equip) {
    const list = this._cat || [];
    const s = (q || "").trim().toLowerCase();
    return list.filter((e) =>
      (!group || e.group === group) &&
      (!equip || e.equipCat === equip) &&
      (!s || e.name.toLowerCase().includes(s) || (e.muscle || "").toLowerCase().includes(s) || (e.equip || "").toLowerCase().includes(s))
    );
  },
  byId(id) { return (this._cat || []).find((e) => e.id === id) || (EXERCISES[id] ? { id, ...EXERCISES[id], images: [] } : null); },

  /* ---------- visual picker (search + photos) ---------- */
  async open(onPick) {
    this._onPick = onPick; this._q = ""; this._group = ""; this._equip = "";
    const card = document.getElementById("modal-card"); if (!card) return;
    card.innerHTML = `<div class="modal-head"><h2>Add exercise</h2><button class="icon-btn" onclick="App.closeModal()">✕</button></div>
      <div class="exp-search"><input id="exp-q" placeholder="Search 800+ exercises & machines…" oninput="Exercises.setQ(this.value)"></div>
      <div class="exp-filters" id="exp-groups"></div>
      <div class="exp-grid" id="exp-grid"><div class="sub" style="text-align:center;padding:24px">Loading exercise library…</div></div>`;
    document.getElementById("modal").classList.remove("hidden");
    await this.load();
    this._renderFilters(); this._renderGrid();
    const q = document.getElementById("exp-q"); if (q) q.focus();
  },
  _renderFilters() {
    const el = document.getElementById("exp-groups"); if (!el) return;
    const chip = (val, label, cur) => `<button class="exp-chip ${cur === val ? "active" : ""}" onclick="${label ? `Exercises.setGroup('${val}')` : ""}">${label || val}</button>`;
    el.innerHTML =
      `<div class="exp-chiprow">${["", ...this.GROUPS].map((g) => `<button class="exp-chip ${this._group === g ? "active" : ""}" onclick="Exercises.setGroup('${g}')">${g || "All"}</button>`).join("")}</div>` +
      `<div class="exp-chiprow">${["", ...this.EQUIPS].map((q) => `<button class="exp-chip eq ${this._equip === q ? "active" : ""}" onclick="Exercises.setEquip('${q}')">${q || "Any gear"}</button>`).join("")}</div>`;
  },
  setQ(v) { this._q = v; this._renderGrid(); },
  setGroup(g) { this._group = g; this._renderFilters(); this._renderGrid(); },
  setEquip(e) { this._equip = e; this._renderFilters(); this._renderGrid(); },
  _renderGrid() {
    const el = document.getElementById("exp-grid"); if (!el) return;
    const res = this.search(this._q, this._group, this._equip);
    if (!res.length) { el.innerHTML = `<div class="sub" style="text-align:center;padding:24px">No exercises match. Try another word or clear the filters.</div>`; return; }
    const shown = res.slice(0, 60);
    el.innerHTML = shown.map((e) => `
      <button class="exp-card" onclick="Exercises.pick('${e.id}')">
        <span class="exp-thumb" data-exmuscle="${esc(this._groupFromMuscle(e.muscle) || "")}" data-exkey="${esc(e.id)}">${this.imgFor(e) ? `<img src="${this.imgFor(e)}" alt="${esc(e.name)}" loading="lazy" onerror="this.style.display='none';this.parentElement.classList.add('noimg')">` : ""}</span>
        <span class="exp-info"><span class="exp-name">${esc(e.name)}</span><span class="exp-meta">${esc(e.muscle)} · ${esc(e.equip)}</span></span>
      </button>`).join("") + (res.length > 60 ? `<div class="sub" style="grid-column:1/-1;text-align:center;padding:8px">Showing 60 of ${res.length} — refine your search to see more.</div>` : "");
    if (typeof App !== "undefined" && App.loadFemaleExPhotos) App.loadFemaleExPhotos(el);
  },
  pick(id) {
    const ex = this.byId(id); if (!ex) return;
    const cb = this._onPick; this._onPick = null;
    if (typeof App !== "undefined" && App.closeModal) App.closeModal();
    if (cb) cb(ex);
  },
};
