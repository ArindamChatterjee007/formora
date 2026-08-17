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
    };
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

  // progressive-overload suggestion text
  overloadHint(exId) {
    const last = this.lastPerformance(exId);
    if (!last) return "First time — pick a weight you can control for the full range.";
    const w = last.best.weight;
    const suggest = w > 0 ? `${(w + 2.5).toFixed(1)} kg` : "add a rep";
    return `Last: ${w > 0 ? w + " kg × " : ""}${last.best.reps} reps. Try ${w > 0 ? suggest : "+1 rep"} today.`;
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
    const freq = this.weeklyFrequency();
    if (freq === 0) msgs.push("No sessions logged in the last 7 days — let's get one in today.");
    else if (freq >= 5) msgs.push(`${freq} sessions this week — strong. Make sure you're recovering.`);
    else msgs.push(`${freq} session${freq > 1 ? "s" : ""} this week. Aim for 4–5 for steady growth.`);

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
    if (phys.emphasis && phys.emphasis.length)
      msgs.push(`Priority muscles for your look: ${phys.emphasis.join(", ")}. They get extra volume in your plan.`);
    return msgs;
  },
};
