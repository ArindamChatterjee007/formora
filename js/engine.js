/* ============================================================
   ENGINE: calculations, recommendations, analysis
   ============================================================ */

const Engine = {
  // the currently selected physique object for this profile's gender
  getPhysique() {
    const p = Store.state.profile;
    const list = PHYSIQUES[p.gender] || PHYSIQUES.male;
    return list.find((x) => x.id === p.physique) || list[0];
  },
  isEmphasized(muscle) {
    return (this.getPhysique().emphasis || []).includes(muscle);
  },

  // ---- body/nutrition math (Mifflin-St Jeor) ----
  stats() {
    const p = Store.state.profile;
    const w = Store.latestWeight();
    const sexAdj = p.gender === "female" ? -161 : 5;
    const bmr = 10 * w + 6.25 * p.heightCm - 5 * p.age + sexAdj;
    const tdee = bmr * p.activityFactor;
    const phys = this.getPhysique();
    const calTarget = tdee + (phys.calAdj || 0);
    const proteinG = Math.round(w * (phys.protein || 1.9));
    const fatG = Math.round((calTarget * 0.25) / 9);
    const carbG = Math.round((calTarget - proteinG * 4 - fatG * 9) / 4);
    const bmi = w / Math.pow(p.heightCm / 100, 2);
    // estimated body fat — Deurenberg (BMI + age + sex). Same BMI reads ~10.8% higher for women.
    const male = p.gender !== "female";
    const bodyFat = Math.max(4, Math.min(55, +(1.20 * bmi + 0.23 * (p.age || 25) - 10.8 * (male ? 1 : 0) - 5.4).toFixed(1)));
    return {
      weight: w,
      bmr: Math.round(bmr),
      tdee: Math.round(tdee),
      calTarget: Math.round(calTarget),
      proteinG, fatG, carbG,
      physName: phys.name,
      calAdj: phys.calAdj || 0,
      bmi: +bmi.toFixed(1),
      bmiClass: bmi < 18.5 ? "Underweight" : bmi < 25 ? "Healthy" : bmi < 30 ? "Overweight" : "Obese",
      bodyFat,
    };
  },

  bodyFat() { return this.stats().bodyFat; },
  // gender-specific body-composition read + goal (men → muscular physique, women → toned figure)
  bodyComp() {
    const p = Store.state.profile;
    const male = p.gender !== "female";
    const bf = this.stats().bodyFat;
    // gender-specific body-fat bands (ACE)
    const cats = male
      ? [[6, "Athletic"], [14, "Fit"], [18, "Average"], [25, "High"], [200, "Very high"]]
      : [[14, "Athletic"], [21, "Fit"], [25, "Average"], [32, "High"], [200, "Very high"]];
    const bfClass = (cats.find(([hi]) => bf < hi) || cats[cats.length - 1])[1];
    const target = male ? { lo: 10, hi: 14, look: "sharp, muscular physique" } : { lo: 20, hi: 24, look: "toned, sculpted figure" };
    let advice;
    if (bf > target.hi + 4) advice = male
      ? `Lean toward ${target.lo}–${target.hi}% body fat to carve out that ${target.look}.`
      : `Trim toward ${target.lo}–${target.hi}% body fat to reveal a ${target.look} — keep training glutes & shoulders.`;
    else if (bf < target.lo - 2) advice = male
      ? `Very lean already — add lean muscle in a small surplus to build the ${target.look}.`
      : `Very lean already — a little more shape on glutes & legs gives a stronger ${target.look}.`;
    else advice = male
      ? `You're in the aesthetic range — recomp: build muscle while holding body fat for that ${target.look}.`
      : `You're in the aesthetic range — sculpt curves (glutes, waist, shoulders) for that ${target.look}.`;
    return { bodyFat: bf, bfClass, targetLo: target.lo, targetHi: target.hi, look: target.look, advice, male };
  },

  // days since a split was last trained (Infinity if never)
  daysSinceSplit(split) {
    const logs = Store.state.workoutLog.filter((w) => w.split === split);
    if (!logs.length) return Infinity;
    const last = logs.map((w) => w.date).sort().at(-1);
    return daysBetween(last, todayISO());
  },

  // choose today's recommended split
  recommendSplit() {
    const scores = SPLIT_ROTATION.map((s) => ({ split: s, days: this.daysSinceSplit(s) }));
    // never-trained first, then longest recovery, tie broken by rotation order
    scores.sort((a, b) => {
      if (a.days === Infinity && b.days === Infinity)
        return SPLIT_ROTATION.indexOf(a.split) - SPLIT_ROTATION.indexOf(b.split);
      return b.days - a.days;
    });
    return scores[0].split;
  },

  // plain-English reason for the current suggestion
  splitReason(split) {
    const days = this.daysSinceSplit(split);
    if (days === Infinity)
      return `No workout history yet, so it opens on ${SPLITS[split].label}. Pick any day you like — once you start logging, it suggests whichever split you've rested the longest.`;
    return `${SPLITS[split].label} is suggested because it's your most-rested split — ${days} day${days === 1 ? "" : "s"} since you last trained it.`;
  },

  // last recorded performance for an exercise
  lastPerformance(exId) {
    for (const w of [...Store.state.workoutLog].sort((a, b) => b.date.localeCompare(a.date))) {
      const ex = w.exercises.find((e) => e.id === exId);
      if (ex && ex.sets.length) {
        const best = ex.sets.reduce((m, s) => (s.weight > m.weight ? s : m), ex.sets[0]);
        return { date: w.date, best, sets: ex.sets.length };
      }
    }
    return null;
  },

  // build today's suggested workout from the split slots
  buildWorkout(split) {
    return SPLIT_SLOTS[split].map((slot, i) => {
      const exId = slot.options[0];
      return {
        slot: i,
        slotName: slot.name,
        targetSets: slot.sets,
        reps: slot.reps,
        options: slot.options,
        selected: exId,
        last: this.lastPerformance(exId),
      };
    });
  },

  // dynamic accessory picks from the two NON-primary splits.
  // varies with total workouts + date so it's never a fixed routine.
  recommendExtras(primary) {
    const others = SPLIT_ROTATION.filter((s) => s !== primary)
      .sort((a, b) => this.daysSinceSplit(b) - this.daysSinceSplit(a));
    const emph = this.getPhysique().emphasis || [];
    const seed = this.totalWorkouts() + new Date().getDate();
    const extras = [];
    others.forEach((split, idx) => {
      const groups = CATEGORY_GROUPS[split];
      // prefer a group that contains an emphasized muscle
      const emGroups = groups.filter((g) => MUSCLE_GROUPS[g].some((id) => emph.includes(EXERCISES[id].muscle)));
      const pool = emGroups.length ? emGroups : groups;
      const group = pool[(seed + idx) % pool.length];
      const opts = MUSCLE_GROUPS[group];
      const emOpts = opts.filter((id) => emph.includes(EXERCISES[id].muscle));
      const pickPool = emOpts.length ? emOpts : opts;
      const exId = pickPool[(seed + idx * 3) % pickPool.length];
      extras.push({ group, options: opts, selected: exId, targetSets: 3, reps: "8–12" });
    });
    return extras;
  },

  // progressive-overload suggestion text (unit-aware; storage is always kg)
  overloadHint(exId, unit) {
    unit = unit === "lbs" ? "lbs" : "kg";
    const last = this.lastPerformance(exId);
    if (!last) return "First time — pick a weight you can control for the full range.";
    const w = unit === "lbs" ? Math.round(last.best.weight * 2.20462 * 10) / 10 : last.best.weight;
    const inc = unit === "lbs" ? 5 : 2.5;
    return `Last: ${w > 0 ? w + " " + unit + " × " : ""}${last.best.reps} reps. Try ${w > 0 ? (Math.round((w + inc) * 10) / 10) + " " + unit : "+1 rep"} today.`;
  },

  // ---- analysis for the Progress tab ----
  weeklyFrequency() {
    const cut = todayISO();
    const start = new Date(cut); start.setDate(start.getDate() - 6);
    const startISO = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
    return Store.state.workoutLog.filter((w) => w.date >= startISO && w.date <= cut).length;
  },

  muscleBalance() {
    // count sets per split over last 28 days
    const start = new Date(); start.setDate(start.getDate() - 27);
    const startISO = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
    const counts = { push: 0, pull: 0, legs: 0 };
    for (const w of Store.state.workoutLog) {
      if (w.date < startISO) continue;
      const sets = w.exercises.reduce((n, e) => n + e.sets.length, 0);
      if (counts[w.split] != null) counts[w.split] += sets;
    }
    return counts;
  },

  streak() {
    // consecutive days ending today that had a workout OR logged rest
    let streak = 0;
    const d = new Date();
    for (;;) {
      const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const active = Store.workoutOn(iso) || Store.state.restDays.includes(iso);
      if (active) { streak++; d.setDate(d.getDate() - 1); }
      else break;
    }
    return streak;
  },

  totalWorkouts() { return Store.state.workoutLog.length; },

  // 0–100 fitness score: BMI in the healthy band (40) + streak (30) + total workouts (30)
  fitnessScore() {
    try {
      const bmi = this.stats().bmi || 0;
      let score = 0;
      if (bmi >= 18.5 && bmi <= 24.9) score += 40;
      else if (bmi > 0) score += Math.max(0, 40 - (bmi < 18.5 ? 18.5 - bmi : bmi - 24.9) * 6);
      score += Math.min(30, this.streak() || 0);
      score += Math.min(30, (this.totalWorkouts() || 0) / 2);
      score = Math.round(score);
      return isNaN(score) ? 0 : Math.max(0, Math.min(100, score));
    } catch (e) { return 0; }
  },

  weightTrend() {
    const log = [...Store.state.weightLog].sort((a, b) => a.date.localeCompare(b.date));
    if (log.length < 2) return { delta: 0, dir: "flat" };
    const delta = +(log.at(-1).kg - log[0].kg).toFixed(1);
    return { delta, dir: delta > 0.1 ? "up" : delta < -0.1 ? "down" : "flat" };
  },

  // human guidance shown after a workout / on dashboard
  guidance() {
    const msgs = [];
    const comp = this.bodyComp();
    msgs.push(`Body fat ~${comp.bodyFat}% (${comp.bfClass}) — ${comp.advice}`);
    const freq = this.weeklyFrequency();
    if (freq === 0) msgs.push(this.totalWorkouts() > 0
      ? "Missed a few days? No stress — one session today and you're right back on track."
      : "No sessions yet — let's get your first one in today.");
    else if (freq >= 5) msgs.push(`${freq} sessions this week — strong. Make sure you're recovering.`);
    else msgs.push(`${freq} session${freq > 1 ? "s" : ""} this week. Aim for ${this.experiencePlan().freq}–${this.experiencePlan().freq + 1} for steady growth.`);

    const bal = this.muscleBalance();
    const min = Object.entries(bal).sort((a, b) => a[1] - b[1])[0];
    if (this.totalWorkouts() >= 3 && min[1] === 0)
      msgs.push(`You've been skipping ${SPLITS[min[0]].label.toLowerCase()} — don't neglect it for balance.`);

    const t = this.weightTrend();
    const phys = this.getPhysique();
    const bulking = (phys.calAdj || 0) > 0;
    const cutting = (phys.calAdj || 0) < 0;
    if (bulking && t.dir === "down")
      msgs.push(`Chasing the ${phys.name} look means gaining — weight is dropping, nudge calories up ~150.`);
    if (bulking && t.dir === "up")
      msgs.push(`Bodyweight up ${t.delta}kg toward your ${phys.name} goal — keep the gain slow to stay lean.`);
    if (cutting && t.dir === "up")
      msgs.push(`For the ${phys.name} look you want to lean down — weight is up, trim ~200 calories.`);
    if (cutting && t.dir === "down")
      msgs.push(`Down ${Math.abs(t.delta)}kg on your ${phys.name} cut — nice, protein high to keep muscle.`);
    const gp = this.goalProgress();
    if (gp.atGoal)
      msgs.push(`You're in your ${phys.name} target range — shift to MAINTAIN: train ~${this.experiencePlan().freq}×/week and hold calories near maintenance (${this.stats().tdee} kcal).`);
    const sp = this.strengthProfile();
    if (sp.enough && sp.strongest && sp.weakest && sp.weakest.volume < sp.strongest.volume * 0.7) {
      const recs = this.weaknessRecs();
      if (recs.length) msgs.push(`Your ${sp.weakest.label.toLowerCase()} is lagging behind — add ${recs.slice(0, 2).map((r) => r.name).join(" & ")} to balance it out.`);
    }
    if (phys.emphasis && phys.emphasis.length)
      msgs.push(`Priority muscles for your look: ${phys.emphasis.join(", ")}. They get extra volume in your plan.`);
    const ep = this.experiencePlan();
    if (ep.tip) msgs.push(ep.tip);
    return msgs;
  },

  // ---- experience level (tunes frequency, progression & coaching) ----
  experienceLevel() { return (Store.state.profile && Store.state.profile.experience) || "beginner"; },
  experiencePlan() {
    return ({
      beginner:     { freq: 3, incKg: 2.5, incLbs: 5,  tip: "Beginner focus: nail your form on machines and the basics — add a little weight only once every rep feels easy." },
      intermediate: { freq: 4, incKg: 2.5, incLbs: 5,  tip: "Progressive overload: add reps first, then weight once you hit the top of the range." },
      advanced:     { freq: 5, incKg: 5,   incLbs: 10, tip: "Push intensity with free weights, chase PRs, and manage your weekly fatigue." },
      returning:    { freq: 3, incKg: 2.5, incLbs: 5,  tip: "Ease back in — start ~20% lighter than your old numbers and rebuild over 2–3 weeks." },
    })[this.experienceLevel()] || { freq: 4, incKg: 2.5, incLbs: 5, tip: "" };
  },

  // ---- strength & weakness (per split, from all logs) ----
  strengthProfile() {
    const splits = ["push", "pull", "legs"];
    const data = splits.map((s) => {
      const logs = Store.state.workoutLog.filter((w) => w.split === s);
      let volume = 0, sets = 0;
      logs.forEach((w) => w.exercises.forEach((e) => e.sets.forEach((st) => { volume += (+st.reps || 0) * (+st.weight || 0); sets += 1; })));
      return { split: s, label: SPLITS[s].label, sessions: logs.length, sets, volume: Math.round(volume) };
    });
    const maxVol = Math.max(1, ...data.map((d) => d.volume));
    data.forEach((d) => (d.dev = Math.round((d.volume / maxVol) * 100)));
    const trained = data.filter((d) => d.sessions > 0);
    const strongest = trained.length ? trained.reduce((a, b) => (b.volume > a.volume ? b : a)) : null;
    const weakest = data.reduce((a, b) => (b.volume < a.volume ? b : a));
    return { data, strongest, weakest, enough: this.totalWorkouts() >= 3 };
  },
  // a couple of exercises to bring up the weakest split (prefers your look's priority muscles)
  weaknessRecs() {
    const sp = this.strengthProfile();
    if (!sp.enough || !sp.weakest) return [];
    const slots = SPLIT_SLOTS[sp.weakest.split] || [];
    const emph = this.getPhysique().emphasis || [];
    const picks = [];
    slots.forEach((slot) => {
      const id = slot.options.find((x) => emph.includes(EXERCISES[x].muscle)) || slot.options[0];
      if (id && !picks.includes(id)) picks.push(id);
    });
    return picks.slice(0, 3).map((id) => ({ id, name: EXERCISES[id].name, muscle: EXERCISES[id].muscle }));
  },

  // ---- progress toward the goal look (0–100) ----
  goalProgress() {
    const comp = this.bodyComp();
    const mid = (comp.targetLo + comp.targetHi) / 2;
    const bfScore = Math.max(0, Math.min(100, Math.round(100 - Math.abs(comp.bodyFat - mid) * 8)));
    const consistency = Math.max(0, Math.min(100, Math.round(this.fitnessScore())));
    const p = Store.state.profile;
    let wScore = null;
    if (p.targetWeightKg) {
      const start = p.startWeightKg || Store.latestWeight();
      const denom = p.targetWeightKg - start;
      wScore = denom === 0 ? 100 : Math.max(0, Math.min(100, Math.round(((Store.latestWeight() - start) / denom) * 100)));
    }
    const parts = [bfScore, consistency].concat(wScore == null ? [] : [wScore]);
    const overall = Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
    return { overall: Math.max(0, Math.min(100, overall)), bfScore, consistency, wScore,
             bodyFat: comp.bodyFat, targetLo: comp.targetLo, targetHi: comp.targetHi, look: comp.look,
             atGoal: comp.bodyFat >= comp.targetLo && comp.bodyFat <= comp.targetHi };
  },

  // ---- natural-language workout logging ----
  // "Overhead Barbell Press 1 set 15kg 2 sets 20kg" -> [{id,name,muscle,sets:[{reps,weight}],matched}]
  parseWorkoutText(text, unit) {
    const u = unit === "lbs" ? "lbs" : ((Store.state.profile && Store.state.profile.unit) || "kg");
    return String(text || "").split(/\n|;/).map((l) => l.trim()).filter(Boolean)
      .map((line) => this._parseWorkoutLine(line, u)).filter(Boolean);
  },
  _parseWorkoutLine(line, unit) {
    const norm = " " + line.toLowerCase().replace(/×/g, "x").replace(/\bkgs\b/g, "kg").replace(/\b(?:pounds|lbs|lb)\b/g, "lbs").replace(/\bkilos?\b/g, "kg") + " ";
    const cut = norm.search(/\d/);
    const nameRaw = (cut === -1 ? norm : norm.slice(0, cut)).replace(/[^a-z\s\-()/&]/g, " ").replace(/\s+/g, " ").trim();
    const sets = this._parseSets(cut === -1 ? "" : norm.slice(cut), unit);
    const match = this._matchExercise(nameRaw);
    return { input: line, id: match ? match.id : null,
             name: match ? match.name : (nameRaw.replace(/\b\w/g, (c) => c.toUpperCase()) || "Exercise"),
             muscle: match ? match.muscle : "", matched: !!match, sets };
  },
  _toKgU(w, unit) { if (w == null || isNaN(w)) return 0; return unit === "lbs" ? Math.round(w * 0.453592 * 10) / 10 : w; },
  _parseSets(str, unit) {
    const sets = [];
    const re = /(\d+)\s*sets?\s*(?:of\s*)?(?:(\d+)\s*reps?\s*)?(?:@\s*|at\s*)?(\d+(?:\.\d+)?)?\s*(kg|lbs)?|(\d+)\s*x\s*(\d+)\s*(?:@\s*|at\s*)?(\d+(?:\.\d+)?)?\s*(kg|lbs)?|(\d+(?:\.\d+)?)\s*(kg|lbs)\s*(?:x|for)\s*(\d+)|(\d+(?:\.\d+)?)\s*(kg|lbs)/g;
    let m;
    while ((m = re.exec(str))) {
      if (m[0].trim() === "") { re.lastIndex++; continue; }
      if (m[1] != null) {
        const n = +m[1], reps = m[2] ? +m[2] : 0, w = m[3] != null ? +m[3] : null, un = m[4] || unit;
        for (let i = 0; i < n; i++) sets.push({ reps, weight: this._toKgU(w, un) });
      } else if (m[5] != null) {
        const n = +m[5], reps = +m[6], w = m[7] != null ? +m[7] : null, un = m[8] || unit;
        for (let i = 0; i < n; i++) sets.push({ reps, weight: this._toKgU(w, un) });
      } else if (m[9] != null) {
        sets.push({ reps: +m[11], weight: this._toKgU(+m[9], m[10] || unit) });
      } else if (m[12] != null) {
        sets.push({ reps: 0, weight: this._toKgU(+m[12], m[13] || unit) });
      }
    }
    return sets;
  },
  _matchExercise(q) {
    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    const qn = norm(q); if (!qn) return null;
    const qt = qn.split(" ").filter(Boolean);
    let best = null, bestScore = 0;
    const consider = (id, name, muscle) => {
      const nn = norm(name); if (!nn) return;
      const nt = nn.split(" ").filter(Boolean);
      const inter = qt.filter((tk) => nt.includes(tk)).length;
      let score = inter / Math.max(qt.length, nt.length);
      if (nn === qn) score = 1;
      else if (nn.includes(qn) || qn.includes(nn)) score = Math.max(score, 0.85);
      if (score > bestScore) { bestScore = score; best = { id, name, muscle }; }
    };
    for (const id in EXERCISES) consider(id, EXERCISES[id].name, EXERCISES[id].muscle);
    if (typeof Exercises !== "undefined" && Exercises._cat) Exercises._cat.forEach((e) => consider(e.id, e.name, e.muscle));
    return bestScore >= 0.5 ? best : null;
  },
  // infer push/pull/legs from the muscles in a parsed/logged workout
  _splitForMuscles(muscles) {
    const map = { push: ["Chest", "Upper Chest", "Shoulders", "Side Delts", "Triceps"], pull: ["Back", "Lats", "Biceps", "Rear Delts", "Traps", "Forearms"], legs: ["Quads", "Hamstrings", "Glutes", "Calves"] };
    const score = { push: 0, pull: 0, legs: 0 };
    (muscles || []).forEach((mu) => { for (const s in map) if (map[s].includes(mu)) score[s]++; });
    const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
    return best && best[1] > 0 ? best[0] : this.recommendSplit();
  },

  // ---- suggested working weight (history-based overload, else estimate from bodyweight/BMI/experience/gender) ----
  suggestWeight(ex, unit) {
    unit = unit === "lbs" ? "lbs" : "kg";
    const id = ex && ex.id;
    const last = id ? this.lastPerformance(id) : null;
    let kg;
    if (last && last.best && last.best.weight > 0) kg = last.best.weight + this.experiencePlan().incKg;
    else kg = this._estimateStartKg(ex);
    if (kg <= 0) return { kg: 0, shown: 0, unit, text: "bodyweight", fromHistory: false };
    const shown = unit === "lbs" ? Math.round((kg * 2.20462) / 2.5) * 2.5 : kg;
    return { kg, shown, unit, text: `${shown} ${unit}`, fromHistory: !!(last && last.best && last.best.weight > 0) };
  },
  // starting working weight (~8–12 reps) as a fraction of bodyweight, tuned by movement, gender & experience
  _estimateStartKg(ex) {
    const p = Store.state.profile;
    const bw = Store.latestWeight() || p.startWeightKg || 70;
    const muscle = (ex && ex.muscle) || "";
    const name = (ex && ex.name) || "";
    const equip = ((ex && ex.equip) || "").toLowerCase();
    if (/bodyweight|body only/.test(equip) || /push[- ]?up|pull[- ]?up|chin[- ]?up|plank|sit[- ]?up|crunch|mountain|burpee/i.test(name)) return 0;
    let frac;
    if (/quad|hamstring|glute|leg|calf/i.test(muscle)) frac = /deadlift/i.test(name) ? 0.9 : 0.65;
    else if (/back|lat|trap/i.test(muscle)) frac = 0.5;
    else if (/chest/i.test(muscle)) frac = 0.5;
    else if (/shoulder|delt/i.test(muscle)) frac = 0.3;
    else if (/bicep|tricep|arm|forearm/i.test(muscle)) frac = 0.2;
    else if (/ab|core/i.test(muscle)) frac = 0.1;
    else frac = 0.35;
    if (/raise|fly|flye|curl|extension|pushdown|kickback|shrug|lateral|pec deck|reverse|cable cross/i.test(name)) frac *= 0.4; // isolation
    if (/dumbbell/.test(equip)) frac *= 0.5; // per hand
    if (p.gender === "female") frac *= 0.65;
    const exp = this.experienceLevel();
    frac *= exp === "beginner" ? 0.8 : exp === "advanced" ? 1.25 : exp === "returning" ? 0.7 : 1;
    return Math.max(0, Math.round((bw * frac) / 2.5) * 2.5);
  },

  // ---- ask-the-coach: grounded rule-based advice from the user's own stats ----
  coachAnswer(question) {
    const s = this.stats(), comp = this.bodyComp(), phys = this.getPhysique();
    const male = comp.male, ql = String(question || "").toLowerCase();
    const has = (...w) => w.some((x) => ql.includes(x));
    const emph = (phys.emphasis || []).slice(0, 3).join(", ");
    if (has("belly", "abs", "six pack", "6 pack", "sixpack", "cut", "lean ", "lose fat", "fat loss", "lose weight", "weight loss", "tummy", "love handle", "shredded", "ripped")) {
      return { title: "Getting leaner & visible abs", points: [
        `Abs show when body fat drops — not from crunches alone. You're ~${comp.bodyFat}% now; abs usually appear around ${male ? "10–12%" : "18–20%"}.`,
        `Eat in a modest deficit: ~${Math.max(1200, s.calTarget - 400)} kcal/day, protein ${s.proteinG}g to hold muscle while the fat comes off.`,
        `Keep lifting 3–5×/week (not just cardio) so you lose fat, not muscle. Hit abs 2–3×/week: hanging leg raises, cable crunches, planks.`,
        `Walk ~8–10k steps/day. Target ~0.5 kg loss/week — faster burns muscle. Be patient; a visible six-pack is mostly a body-fat number.`,
      ] };
    }
    if (has("bulk", "gain muscle", "build muscle", "mass", "bigger", "grow", "gain weight", "skinny", "size", "hardgainer")) {
      return { title: "Building muscle & size", points: [
        `Eat in a slight surplus: ~${s.calTarget + 250} kcal/day, protein ${s.proteinG}g. Gain ~0.25–0.5 kg/week so it's mostly muscle.`,
        `Progressive overload wins — add a rep or a little weight each week on the big lifts, and train each muscle 2×/week.`,
        `Anchor sessions with compounds (bench, row, squat, overhead press, deadlift) plus your priority muscles${emph ? " (" + emph + ")" : ""}.`,
        `Sleep 7–9h and don't skip meals — muscle is built in recovery, not just the gym.`,
      ] };
    }
    if (has("chest", "pec")) return { title: "Growing your chest", points: [
      `Train chest 2×/week with an incline press (upper-chest shelf) + a flat press + a fly for stretch.`,
      `Progress the press weights over time; controlled tempo and a full stretch at the bottom grow the pecs.`,
      `In a surplus you'll add size faster; ~${s.proteinG}g protein/day supports it.` ] };
    if (has("arm", "bicep", "tricep")) return { title: "Bigger arms", points: [
      `Triceps are ~2/3 of your arm — train them hard (dips, close-grip press, pushdowns) alongside curls.`,
      `6–10 hard sets each per week, 8–15 reps, close to failure. Arms recover fast — 2×/week works.`,
      `Arms follow overall mass — keep eating ${s.proteinG}g protein and progressing.` ] };
    if (has("shoulder", "delt", "boulder")) return { title: "Rounder, wider shoulders", points: [
      `Side delts create width — do lateral raises 3–4×/week, light and strict, high reps.`,
      `Press overhead for size + rear-delt work (face pulls) for balance and posture.` ] };
    if (has("back", "lat", "wide", "v taper", "v-taper")) return { title: "A wider, thicker back", points: [
      `Vertical pulls (pulldowns/pull-ups) build width; rows build thickness — do both weekly.`,
      `Focus on pulling with the elbows and a full stretch; add weight gradually.` ] };
    if (has("leg", "quad", "glute", "booty", "hamstring", "squat")) return { title: "Legs & glutes", points: [
      `Squats, hip thrusts, and Romanian deadlifts drive glutes and legs — train them 2×/week.`,
      `Go deep with control and progress the load; glutes love hip thrusts and lunges.` ] };
    if (has("protein", "diet", "eat", "nutrition", "food", "meal", "calorie", "macro")) return { title: "Your nutrition", points: [
      `Daily target: ~${s.calTarget} kcal, ${s.proteinG}g protein, ${s.carbG}g carbs, ${s.fatG}g fat — built from your body & goal.`,
      `Protein is the priority — spread ${s.proteinG}g across 3–4 meals. Whole foods first; a shake helps you hit the number.`,
      `${(phys.calAdj || 0) > 0 ? "You're gaining, so eat slightly above maintenance." : (phys.calAdj || 0) < 0 ? "You're leaning down, so stay in a modest deficit." : "You're at maintenance — keep it steady."} Check the Nutrition tab for meal ideas.` ] };
    if (has("sleep", "recover", "rest", "sore", "doms", "tired", "overtrain")) return { title: "Recovery", points: [
      `Sleep 7–9h — it's when muscle is built and fat loss is easiest.`,
      `Soreness is normal; train through mild DOMS but take a rest day if a joint hurts. 1–2 rest days/week is healthy.` ] };
    if (has("motivat", "lazy", "consistent", "habit", "discipline", "give up", "quit")) return { title: "Staying consistent", points: [
      `Consistency beats intensity. Aim for ${this.experiencePlan().freq}×/week and never miss twice in a row.`,
      `Make it easy: pack your bag the night before, same time each day. Log it here — your streak is ${this.streak()} days.`,
      `Missed a few days? No stress — just start again today.` ] };
    return { title: "Your plan right now", points: [
      `You're chasing the ${phys.name} look. Body fat ~${comp.bodyFat}% (target ${comp.targetLo}–${comp.targetHi}%).`,
      comp.advice,
      `Daily target: ${s.calTarget} kcal, ${s.proteinG}g protein. Train ${this.experiencePlan().freq}×/week.`,
      `Try asking: "how do I lose belly fat", "how to grow my chest", "what should I eat", or "how to build muscle".`,
    ] };
  },
};
