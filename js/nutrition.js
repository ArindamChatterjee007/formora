/* ============================================================
   NUTRITION: estimate calories & protein from a plain-text
   description like "2 rotis, a bowl of dal, chicken curry,
   tea with sugar". Heuristic — approximate, editable by user.
   ============================================================ */

const FoodEstimator = {
  parse(text) {
    const segments = (text || "")
      .toLowerCase()
      .replace(/\band\b/g, ",")
      .replace(/\bwith\b/g, ",with ")
      .split(/[,\n+]/)
      .map((s) => s.trim())
      .filter(Boolean);

    const items = [];
    const unknown = [];
    let sugarHits = 0;
    let sawNoSugar = false;

    for (const seg of segments) {
      // sugar handling is segment-level
      if (/\bno sugar\b|\bwithout sugar\b|\bsugar[- ]?free\b|\bno added sugar\b|\bunsweetened\b/.test(seg)) {
        sawNoSugar = true;
      } else if (/\bsugar\b|\bwith sugar\b|\bsweet(ened)?\b|\bshakkar\b|\bcheeni\b/.test(seg) && !/\bsweet potato\b/.test(seg)) {
        sugarHits++;
      }

      const food = this.matchFood(seg);
      if (!food) {
        // pure sugar / modifier segments aren't "unknown"
        if (!/^(with\s+)?(sugar|no sugar|without sugar).*/.test(seg) && seg.length > 2 && !/^with$/.test(seg))
          unknown.push(seg);
        continue;
      }

      let qty = this.matchQty(seg, food);
      let mult = 1;
      if (/\b(large|big|extra|double|heaped|full)\b/.test(seg)) mult *= 1.4;
      if (/\b(small|little|light|mini|half)\b/.test(seg)) mult *= 0.65;
      let kcal = food.kcal * qty * mult;
      let protein = food.protein * qty * mult;
      if (/\b(fried|deep[- ]?fried|crispy)\b/.test(seg)) kcal *= 1.35;

      items.push({
        name: this.pretty(food.keys[0]),
        qty,
        unit: food.unit,
        kcal: Math.round(kcal),
        protein: Math.round(protein),
      });
    }

    // add sugar as its own item (≈2 tsp per mention)
    if (sugarHits > 0 && !sawNoSugar) {
      items.push({ name: "Sugar", qty: sugarHits, unit: "tsp", kcal: 32 * sugarHits, protein: 0 });
    }

    const kcal = items.reduce((n, i) => n + i.kcal, 0);
    const protein = items.reduce((n, i) => n + i.protein, 0);
    return { kcal, protein, items, unknown, sawNoSugar };
  },

  matchFood(seg) {
    let best = null, bestLen = 0;
    for (const food of FOOD_DB) {
      for (const key of food.keys) {
        if (key.length > bestLen && this._hasWord(seg, key)) { best = food; bestLen = key.length; }
      }
    }
    return best;
  },
  // whole-word match (allows a trailing plural) so "protine" can't match "roti", "price" can't match "rice", etc.
  _hasWord(seg, key) {
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("\\b" + esc + "(?:s|es)?\\b").test(seg);
  },

  // nominal serving sizes so real-world amounts (ml / grams) map to sensible portions
  _liquidMl: { glass: 250, cup: 200, bowl: 250, katori: 150, can: 355 },
  _solidG: { "100g": 100, bowl: 180, plate: 250, piece: 60, slice: 30, serving: 150, scoop: 30, tbsp: 15, tsp: 5, handful: 20, bar: 45, pack: 70, can: 150 },

  matchQty(seg, food) {
    const m = seg.match(/(\d+(?:\.\d+)?)\s*([a-z]+)?/);
    let value = null, unit = "";
    if (m) { value = parseFloat(m[1]); unit = (m[2] || "").toLowerCase(); }
    if (value == null || isNaN(value)) {
      for (const [w, v] of Object.entries(NUM_WORDS)) {
        if (new RegExp(`\\b${w}\\b`).test(seg)) return v;
      }
      return 1; // default one serving
    }
    // volume (ml/l) and weight (g/kg) → convert to portions of this food's serving
    const VOL = { ml: 1, milliliter: 1, milliliters: 1, cc: 1, l: 1000, lt: 1000, litre: 1000, litres: 1000, liter: 1000, liters: 1000 };
    const WT = { g: 1, gm: 1, gms: 1, gram: 1, grams: 1, kg: 1000, kgs: 1000, kilo: 1000, kilos: 1000, kilogram: 1000, kilograms: 1000 };
    if (unit && VOL[unit] != null) return (value * VOL[unit]) / ((food && this._liquidMl[food.unit]) || 250);
    if (unit && WT[unit] != null) return (value * WT[unit]) / ((food && this._solidG[food.unit]) || 150);
    return value; // plain count, or a serving word like "2 glasses"
  },

  pretty(s) {
    return (s || "").split(" ").map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
  },

  // clean "A + B + C" meal title from the detected items (+ any unrecognised bits), used as the log name
  summary(est) {
    if (!est) return "";
    const parts = (est.items || []).map((i) => {
      const q = Math.round((+i.qty || 1) * 10) / 10;
      return (Math.abs(q - 1) <= 0.1 ? "" : `${q}× `) + i.name;
    });
    for (const u of (est.unknown || [])) if (u) parts.push(u.charAt(0).toUpperCase() + u.slice(1));
    return parts.join(" + ");
  },
};

/* ============================================================
   MEAL PLANNER: build a full day (breakfast/lunch/snack/dinner)
   from a free-text preference, the user's diet, and targets.
   ============================================================ */
const MealPlanner = {
  // how the day's calories are split across meals (sums to 1.0)
  slotShare: { Breakfast: 0.27, Lunch: 0.34, Snack: 0.13, Dinner: 0.26 },
  // diet-aware protein top-ups, used to reach the protein goal
  boosters: {
    nonveg: { name: "Grilled chicken (100g)", kcal: 165, protein: 31 },
    egg:    { name: "3 boiled eggs",          kcal: 234, protein: 18 },
    veg:    { name: "Whey shake (1 scoop)",   kcal: 120, protein: 24 },
    vegan:  { name: "Soya chunks (50g dry)",  kcal: 173, protein: 26 },
  },
  // diet-aware calorie top-ups, used to reach the calorie goal
  calAddon: {
    nonveg: { name: "Peanut butter (2 tbsp)", kcal: 190, protein: 8 },
    egg:    { name: "Peanut butter (2 tbsp)", kcal: 190, protein: 8 },
    veg:    { name: "Nuts & trail mix (40g)", kcal: 230, protein: 7 },
    vegan:  { name: "Nuts & trail mix (40g)", kcal: 230, protein: 6 },
  },

  generate(prefText, diet, target, seed = 0) {
    const prefs = (prefText || "").toLowerCase();
    const wantProtein = /high.?protein|protein|gym|muscle|bulk|gain|lean/.test(prefs);
    const targetK = (target && (target.calTarget || target.kcal)) || 2200;
    const targetP = (target && (target.proteinG || target.protein)) || 130;

    const plan = [];
    for (const slot of MEAL_SLOTS) {
      const cands = MEAL_LIBRARY[slot].filter((m) => dietAllows(m.diet, diet));
      if (!cands.length) continue;
      const scored = cands.map((m, i) => {
        let score = 0;
        for (const tag of m.tags) if (prefs.includes(tag)) score += 3;
        for (const w of m.name.toLowerCase().split(/[^a-z]+/))
          if (w.length > 3 && prefs.includes(w)) score += 2;
        if (wantProtein) score += m.protein * 0.12;
        score += ((i + seed * 3) % cands.length) * 0.45; // deterministic variety on regenerate
        return { m, i, score };
      }).sort((a, b) => b.score - a.score || a.i - b.i);

      const base = scored[0].m;
      // scale the portion so this meal covers its share of the day's calories
      let factor = (targetK * (this.slotShare[slot] || 0.25)) / base.kcal;
      factor = Math.max(0.75, Math.min(2, Math.round(factor * 4) / 4)); // 0.75–2.0, quarter steps
      plan.push({
        slot,
        meal: {
          name: base.name, diet: base.diet, portion: factor,
          kcal: Math.round(base.kcal * factor),
          protein: Math.round(base.protein * factor),
        },
      });
    }

    let totalK = plan.reduce((n, x) => n + x.meal.kcal, 0);
    let totalP = plan.reduce((n, x) => n + x.meal.protein, 0);

    // close the protein gap first, then the calorie gap, with diet-aware add-ons
    const addons = [];
    let guard = 0;
    while (totalP < targetP - 6 && guard++ < 4) {
      const b = this.boosters[diet] || this.boosters.veg;
      addons.push({ ...b }); totalP += b.protein; totalK += b.kcal;
    }
    guard = 0;
    while (totalK < targetK - 130 && guard++ < 4) {
      const a = this.calAddon[diet] || this.calAddon.veg;
      addons.push({ ...a }); totalK += a.kcal; totalP += a.protein;
    }

    return { plan, addons, totalK, totalP, target, targetK, targetP };
  },
};
