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

      let qty = this.matchQty(seg);
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
        if (seg.includes(key) && key.length > bestLen) { best = food; bestLen = key.length; }
      }
    }
    return best;
  },

  matchQty(seg) {
    const digit = seg.match(/(\d+(\.\d+)?)/);
    if (digit) return parseFloat(digit[1]);
    for (const [w, v] of Object.entries(NUM_WORDS)) {
      if (new RegExp(`\\b${w}\\b`).test(seg)) return v;
    }
    return 1; // default one serving
  },

  pretty(s) { return s.charAt(0).toUpperCase() + s.slice(1); },
};

/* ============================================================
   MEAL PLANNER: build a full day (breakfast/lunch/snack/dinner)
   from a free-text preference, the user's diet, and targets.
   ============================================================ */
const MealPlanner = {
  generate(prefText, diet, target, seed = 0) {
    const prefs = (prefText || "").toLowerCase();
    const wantProtein = /high.?protein|protein|gym|muscle|bulk|gain/.test(prefs);
    const plan = [];
    let totalK = 0, totalP = 0;

    for (const slot of MEAL_SLOTS) {
      const cands = MEAL_LIBRARY[slot].filter((m) => dietAllows(m.diet, diet));
      if (!cands.length) continue;
      const scored = cands.map((m, i) => {
        let score = 0;
        for (const tag of m.tags) if (prefs.includes(tag)) score += 3;
        for (const w of m.name.toLowerCase().split(/[^a-z]+/))
          if (w.length > 3 && prefs.includes(w)) score += 2;
        if (wantProtein) score += m.protein * 0.15;
        score += ((i + seed * 7) % 5) * 0.6; // variety on regenerate
        return { m, score };
      }).sort((a, b) => b.score - a.score);

      const pick = scored[0].m;
      plan.push({ slot, meal: pick });
      totalK += pick.kcal;
      totalP += pick.protein;
    }
    return { plan, totalK, totalP, target };
  },
};
