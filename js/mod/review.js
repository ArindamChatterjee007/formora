/* Elite AI Progress Review (T-87) — an honest, on-device coaching read for Elite members.
   Grounded ONLY in the member's own tracked data (weight trend, training consistency,
   body-composition estimate, goal progress) plus a real pixel-level lighting/consistency
   check on their progress photos so comparisons are fair. Nothing leaves the device, and we
   do NOT claim to read muscle from pixels — the physique read comes from logged metrics. */
window.EliteReview = (function () {
  var DAY = 86400000;
  function isElite() { return typeof Entitlements !== "undefined" && Entitlements.isElite(); }
  function r1(n) { return Math.round(n * 10) / 10; }
  function esc(s) {
    return (typeof window.esc === "function") ? window.esc(s)
      : String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
          return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
        });
  }

  // Average luminance (0–255) of a data-URL image, sampled small + entirely on-device.
  function luma(url) {
    return new Promise(function (res) {
      try {
        var img = new Image();
        img.onload = function () {
          try {
            var c = document.createElement("canvas"), w = (c.width = 40), h = (c.height = 56);
            var x = c.getContext("2d"); x.drawImage(img, 0, 0, w, h);
            var d = x.getImageData(0, 0, w, h).data, s = 0, n = w * h, i;
            for (i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            res(Math.round(s / n));
          } catch (e) { res(-1); }
        };
        img.onerror = function () { res(-1); };
        img.src = url;
      } catch (e) { res(-1); }
    });
  }

  function build() {
    var photos = (App.progressPhotos ? App.progressPhotos() : []).slice();
    var st = Engine.stats();
    var comp = Engine.bodyComp ? Engine.bodyComp() : null;
    var phys = Engine.getPhysique();
    var ep = Engine.experiencePlan ? Engine.experiencePlan() : { freq: 4, tip: "" };
    var p = Store.state.profile || {};
    var freq = Engine.weeklyFrequency ? Engine.weeklyFrequency() : 0;
    var tgtFreq = (ep && ep.freq) || 4;
    // Engine.goalProgress() returns { overall, bfScore, ... } — take the overall number.
    var gp = Engine.goalProgress ? Engine.goalProgress() : null;
    var overall = (gp && typeof gp === "object") ? gp.overall : gp;
    // Coaching phase — bodyfat-first so we don't tell an over-range member to "build" just
    // because their physique preset carries a surplus. Shared by the body-comp read + actions.
    var phase = "maintain";
    if (comp) {
      if (st.bodyFat > comp.targetHi) phase = "cut";
      else if (st.bodyFat < comp.targetLo) phase = "build";
      else phase = st.calAdj > 0 ? "build" : st.calAdj < 0 ? "cut" : "maintain";
    } else phase = st.calAdj > 0 ? "build" : st.calAdj < 0 ? "cut" : "maintain";
    var kcal = phase === "cut" ? Math.round(st.tdee - 400) : phase === "build" ? Math.max(st.calTarget, Math.round(st.tdee + 200)) : Math.round(st.tdee);
    var kcalWord = phase === "cut" ? "a controlled deficit to lean out first" : phase === "build" ? "a slight surplus to build" : "maintenance";
    var secs = [], acts = [];

    // 1) Training consistency — the single biggest lever.
    if (freq >= tgtFreq)
      secs.push({ t: "Training consistency", tone: "good", b: "You trained <b>" + freq + "×</b> this week — at or above your " + tgtFreq + "× target. This is the single biggest reason your body will change. Protect this before anything else." });
    else if (freq >= 1)
      secs.push({ t: "Training consistency", tone: "watch", b: "You're at <b>" + freq + "×</b> this week vs a " + tgtFreq + "× target. You're moving — but the gap is where faster results hide. Add " + (tgtFreq - freq) + " more session" + (tgtFreq - freq === 1 ? "" : "s") + " and hold it for a month." });
    else
      secs.push({ t: "Training consistency", tone: "watch", b: "No sessions logged this week. Nothing else here matters without training — the plan only works when the reps happen. Book your next session today, even a short one." });

    // 2) Body composition vs the target look.
    if (comp) {
      var bf = st.bodyFat, lo = comp.targetLo, hi = comp.targetHi;
      if (bf >= lo && bf <= hi)
        secs.push({ t: "Body composition", tone: "good", b: "Your estimated body fat (~<b>" + bf + "%</b>) sits inside your " + esc(phys.name) + " target of " + lo + "–" + hi + "%. You're in the look — now it's about holding it and sharpening the detail." });
      else if (bf > hi)
        secs.push({ t: "Body composition", tone: "watch", b: "Estimated body fat ~<b>" + bf + "%</b> vs a " + lo + "–" + hi + "% target for " + esc(phys.name) + " — about " + r1(bf - hi) + "% above the top. A steady deficit with protein at " + st.proteinG + "g/day trims it without costing muscle." + (st.calAdj > 0 ? " Heads up: your plan is set to <b>build</b>, but at ~" + bf + "% the smart order is to cut into your " + lo + "–" + hi + "% range first, then lean-bulk — so I'd run a short deficit now, not a surplus." : "") });
      else
        secs.push({ t: "Body composition", tone: "info", b: "Estimated body fat ~<b>" + bf + "%</b> is below your " + lo + "–" + hi + "% target — lean. For a fuller " + esc(phys.name) + " look, a small surplus (+200 kcal) plus progressive overload adds shape." });
    }

    // 3) Trajectory — goal progress + photo-measured rate of change.
    var traj = "";
    if (p.targetWeightKg && p.startWeightKg != null) {
      var cur = Store.latestWeight(), start = p.startWeightKg, tgt = p.targetWeightKg;
      var toGo = r1(tgt - cur);
      var pct = overall != null ? overall : Math.max(0, Math.min(100, Math.round(((cur - start) / ((tgt - start) || 1)) * 100)));
      traj = "You're <b>" + pct + "%</b> of the way from " + start + " to your " + tgt + " kg goal" + (toGo === 0 ? " — you're there." : " (" + Math.abs(toGo) + " kg to go).");
    }
    if (photos.length >= 2) {
      var a = photos[0], b = photos[photos.length - 1];
      var days = Math.max(1, Math.round((b.ts - a.ts) / DAY));
      var dW = r1(b.weightKg - a.weightKg), dBF = r1(b.bodyFat - a.bodyFat);
      var rate = r1((dW / days) * 7);
      var pace = "";
      if (Math.abs(rate) < 0.05) pace = " Your weight's held steady — if the mirror's still changing that's recomposition; if not, nudge calories " + (st.calAdj >= 0 ? "up" : "down") + " a touch.";
      else if (Math.abs(rate) > Store.latestWeight() * 0.011) pace = " That's a fast pace (>1% of bodyweight/week) — fine for a short cut, but watch that your strength holds so it's fat you're losing, not muscle.";
      traj += (traj ? " " : "") + "Across " + days + " days of photos you've " + (dW === 0 ? "held your weight" : (dW < 0 ? "lost " : "gained ") + Math.abs(dW) + " kg") + " (" + (rate === 0 ? "flat" : (rate > 0 ? "+" : "") + rate + " kg/week") + ")" + (dBF ? " and " + (dBF < 0 ? "dropped " : "added ") + Math.abs(dBF) + "% est. body fat" : "") + "." + pace;
    } else {
      traj += (traj ? " " : "") + "Add at least two progress photos a week or two apart and I'll measure your real rate of change here.";
    }
    secs.push({ t: "Trajectory", tone: "info", b: traj });

    // Next-two-weeks actions — concrete and grounded in the member's own numbers (phase above).
    acts.push("Train <b>" + tgtFreq + "×/week</b>. " + esc(ep.tip || "Progressive overload: add reps first, then weight once the top of the range feels easy."));
    acts.push("Hit <b>" + st.proteinG + "g protein</b> and about <b>" + kcal + " kcal</b>/day (" + kcalWord + ").");
    acts.push("Take your next progress photo in ~7 days — same spot, same light, same time of day.");

    return { secs: secs, acts: acts, overall: overall, photos: photos, phys: phys };
  }

  function render(data, photoNote) {
    var tonec = { good: "er-good", watch: "er-watch", info: "er-info" };
    var secHtml = data.secs.map(function (s) {
      return '<div class="er-sec ' + (tonec[s.tone] || "er-info") + '"><div class="er-t">' + esc(s.t) + '</div><div class="er-b">' + s.b + "</div></div>";
    }).join("");
    var actHtml = data.acts.map(function (a) { return "<li>" + a + "</li>"; }).join("");
    var score = data.overall != null
      ? '<div class="er-score"><div class="er-ring" style="--p:' + data.overall + '"><span>' + data.overall + "</span></div><div class=\"er-score-l\">Progress toward your <b>" + esc(data.phys.name) + "</b> look</div></div>"
      : "";
    var pn = photoNote ? '<div class="er-photo">' + photoNote + "</div>" : "";
    document.getElementById("modal-card").innerHTML =
      '<div class="modal-head"><h2>AI Progress Review <span class="tb-elite">★ Elite</span></h2><button class="icon-btn" onclick="App.closeModal()">✕</button></div>' +
      '<div class="er-intro">An honest read, computed on your device from <b>your</b> tracked data and photo timeline. Nothing leaves your phone.</div>' +
      score + secHtml + pn +
      '<div class="er-sec er-plan"><div class="er-t">Your next two weeks</div><ul class="er-acts">' + actHtml + "</ul></div>" +
      '<div class="er-foot">Estimates from your logged data (Mifflin-St Jeor + Deurenberg) — a coaching guide, not medical advice.</div>';
    document.getElementById("modal").classList.remove("hidden");
  }

  function open() {
    if (!isElite()) { if (App.openPricing) App.openPricing(); return; }
    var data = build();
    var ph = data.photos;
    var initial = ph.length === 1
      ? "<b>Photo check:</b> one photo so far. Add another in ~a week (same light and pose) and I'll track your real visual change."
      : ph.length === 0 ? "" : null;
    render(data, initial);
    if (ph.length >= 2) {
      Promise.all([luma(ph[0].url), luma(ph[ph.length - 1].url)]).then(function (ls) {
        var modal = document.getElementById("modal");
        if (!modal || modal.classList.contains("hidden")) return;
        var l0 = ls[0], l1 = ls[1];
        if (l0 < 0 || l1 < 0) return;
        var diff = Math.abs(l1 - l0);
        var note = diff <= 18
          ? "<b>Photo check:</b> your first and latest shots are lit consistently — that makes your side-by-side comparison trustworthy. Keep shooting them the same way."
          : "<b>Photo check:</b> your latest photo is noticeably " + (l1 > l0 ? "brighter" : "darker") + " than your first. Lighting swings can fake or hide progress — shoot in the same spot and light so the comparison stays honest.";
        render(data, note);
      });
    }
  }

  return { open: open, build: build };
})();
