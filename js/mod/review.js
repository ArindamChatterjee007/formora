/* Elite Progress Review (T-87) — a rules-based, on-device coaching read for Elite members.
   Grounded ONLY in the member's own tracked data: logged weight, training frequency, and the
   BMI-derived body-fat ESTIMATE from engine.js. Progress photos are NOT analysed for body
   composition — the only thing read from the pixels is average brightness, so we can tell the
   member whether two shots are lit similarly enough to compare fairly. Nothing leaves the device. */
window.EliteReview = (function () {
  var DAY = 86400000;
  var renderVersion = 0;
  function isElite() { return typeof Entitlements !== "undefined" && Entitlements.isElite(); }
  function r1(n) { return Math.round(n * 10) / 10; }
  // Every value here comes from on-device storage, so anything non-finite is dropped rather
  // than concatenated into the HTML we build.
  function num(v) { var n = typeof v === "number" ? v : parseFloat(v); return isFinite(n) ? n : null; }
  function n0(v) { var n = num(v); return n == null ? null : Math.round(n); }
  function esc(s) {
    return (typeof window.esc === "function") ? window.esc(s)
      : String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
          return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
        });
  }

  // Average luminance (0–255) of a data-URL image, sampled small + entirely on-device.
  function luma(url) {
    return new Promise(function (res) {
      if (typeof url !== "string" || !/^data:image\/(jpeg|png|webp);base64,/i.test(url)) { res(-1); return; }
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

  // Percent of the way from the member's starting weight to their target weight. Handles both
  // gain and loss goals; returns null when any of the three weights is missing or non-finite.
  function weightProgress(start, cur, tgt) {
    var s = num(start), c = num(cur), t = num(tgt);
    if (s == null || c == null || t == null) return null;
    var denom = t - s, toGo = r1(t - c);
    // start === target is a "hold your weight" goal, where a percentage only means met/not-met.
    if (denom === 0) return { pct: toGo === 0 ? 100 : 0, toGo: toGo, start: s, cur: c, tgt: t, hold: true };
    return { pct: Math.max(0, Math.min(100, Math.round(((c - s) / denom) * 100))),
             toGo: toGo, start: s, cur: c, tgt: t, hold: false };
  }

  function build() {
    var photos = (App.progressPhotos ? App.progressPhotos() : []).slice();
    var st = Engine.stats() || {};
    var comp = Engine.bodyComp ? Engine.bodyComp() : null;
    var phys = (Engine.getPhysique && Engine.getPhysique()) || { name: "" };
    var ep = Engine.experiencePlan ? Engine.experiencePlan() : { freq: 4, tip: "" };
    var p = Store.state.profile || {};
    var freq = n0(Engine.weeklyFrequency ? Engine.weeklyFrequency() : 0) || 0;
    var tgtFreq = n0(ep && ep.freq) || 4;
    var proteinG = n0(st.proteinG), tdee = n0(st.tdee), calAdj = num(st.calAdj) || 0;
    // Engine.goalProgress().overall is a COMPOSITE (body-fat estimate + consistency + weight
    // score averaged together). It is kept for the ring only — the weight-goal percentage is
    // computed separately in weightProgress() so the two are never confused.
    var gp = Engine.goalProgress ? Engine.goalProgress() : null;
    var overall = n0((gp && typeof gp === "object") ? gp.overall : gp);
    if (overall != null) overall = Math.max(0, Math.min(100, overall));
    var bfEst = num(st.bodyFat);
    // Coaching phase — bodyfat-first so we don't tell an over-range member to "build" just
    // because their physique preset carries a surplus. Shared by the body-comp read + actions.
    var phase = calAdj > 0 ? "build" : calAdj < 0 ? "cut" : "maintain";
    if (comp && bfEst != null) {
      if (num(comp.targetHi) != null && bfEst > comp.targetHi) phase = "cut";
      else if (num(comp.targetLo) != null && bfEst < comp.targetLo) phase = "build";
    }
    var kcal = tdee == null ? null
      : phase === "cut" ? Math.round(tdee * 0.85)
      : phase === "build" ? Math.max(n0(st.calTarget) || 0, tdee + 200)
      : tdee;
    var kcalWord = phase === "cut" ? "roughly 15% under your estimated maintenance"
      : phase === "build" ? "a small surplus" : "around maintenance";
    var secs = [], acts = [];

    // 1) Training consistency — the lever the member controls most directly.
    if (freq >= tgtFreq)
      secs.push({ t: "Training consistency", tone: "good", b: "You trained <b>" + freq + "×</b> this week — at or above your " + tgtFreq + "× target. Consistency is the part of this you control most directly, so protect it before fine-tuning anything else." });
    else if (freq >= 1)
      secs.push({ t: "Training consistency", tone: "watch", b: "You're at <b>" + freq + "×</b> this week vs a " + tgtFreq + "× target. Adding " + (tgtFreq - freq) + " more session" + (tgtFreq - freq === 1 ? "" : "s") + " and holding that for a few weeks is the most reliable change you can make here." });
    else
      secs.push({ t: "Training consistency", tone: "watch", b: "No sessions logged this week. If that's a rest week or life got busy, that's fine — just book the next one, even a short session, so the habit stays intact." });

    // 2) Body composition vs the target look — all from the BMI-based estimate, never from photos.
    if (comp && bfEst != null && num(comp.targetLo) != null && num(comp.targetHi) != null) {
      var lo = num(comp.targetLo), hi = num(comp.targetHi), nm = esc(phys.name);
      var caveat = " This is a BMI-based estimate, not a measurement — it can't see muscle, so treat it as a rough marker.";
      if (bfEst >= lo && bfEst <= hi)
        secs.push({ t: "Body composition", tone: "good", b: "Your estimated body fat (~<b>" + bfEst + "%</b>) sits inside your " + nm + " target of " + lo + "–" + hi + "%." + caveat });
      else if (bfEst > hi)
        secs.push({ t: "Body composition", tone: "watch", b: "Estimated body fat ~<b>" + bfEst + "%</b> vs a " + lo + "–" + hi + "% target for " + nm + " — about " + r1(bfEst - hi) + "% above the top of the range." + (proteinG != null ? " Eating slightly under maintenance while keeping protein near " + proteinG + "g/day is the common approach; how much you actually lose, and what it comes from, varies a lot between people." : "") + (calAdj > 0 ? " Worth noting: your plan is currently set to <b>build</b>. Some people prefer to move toward the range first and build after — either order is a reasonable choice." : "") + caveat });
      else
        secs.push({ t: "Body composition", tone: "info", b: "Estimated body fat ~<b>" + bfEst + "%</b> is below your " + lo + "–" + hi + "% target. For a fuller " + nm + " look, a small surplus alongside progressive overload is the usual route." + caveat });
    }

    // 3) Trajectory — weight-goal progress (its own arithmetic) plus the logged weights either
    //    side of the photo window. Nothing in here is derived from the images.
    var curW = num(Store.latestWeight ? Store.latestWeight() : null);
    var wp = weightProgress(p.startWeightKg, curW, p.targetWeightKg);
    var traj;
    if (!wp)
      traj = "Log a starting weight, a current weight and a target weight and I can show exactly how far along you are.";
    else if (wp.hold)
      traj = "Your goal weight matches your starting weight, so this is a hold: you're at <b>" + wp.cur + " kg</b>" + (wp.toGo === 0 ? " — right on it." : " (" + Math.abs(wp.toGo) + " kg off).");
    else
      traj = "On weight alone you're <b>" + wp.pct + "%</b> of the way from " + wp.start + " to your " + wp.tgt + " kg goal" + (wp.toGo === 0 ? " — you're there." : " (" + Math.abs(wp.toGo) + " kg to go).");

    if (photos.length >= 2) {
      var a = photos[0], b = photos[photos.length - 1];
      var ta = num(a && a.ts), tb = num(b && b.ts);
      var days = (ta != null && tb != null) ? Math.max(1, Math.round((tb - ta) / DAY)) : null;
      var wa = num(a && a.weightKg), wb = num(b && b.weightKg);
      var dW = (wa != null && wb != null) ? r1(wb - wa) : null;
      var rate = (dW != null && days != null) ? r1((dW / days) * 7) : null;
      var pace = "";
      if (rate != null && Math.abs(rate) < 0.05) pace = " Your logged weight has held steady. Scale weight alone can't tell us what changed underneath — your strength logs and how clothes fit are better signals.";
      else if (rate != null && curW != null && Math.abs(rate) > curW * 0.011) pace = " That's faster than about 1% of bodyweight per week. Changes that quick are worth raising with a doctor or dietitian.";
      traj += " " + (days != null && dW != null
        ? "Between your first and latest photo (" + days + " days) your <b>logged</b> weight " + (dW === 0 ? "held" : (dW < 0 ? "went down " : "went up ") + Math.abs(dW) + " kg") + " (" + (rate === 0 || rate == null ? "flat" : (rate > 0 ? "+" : "") + rate + " kg/week") + "). The photos only date that window — none of these numbers are read from the images." + pace
        : "Your photos don't have logged weights attached, so there's no rate of change to report from them.");
    } else {
      traj += " Photos here are used for a side-by-side and a lighting check only. Add two, a week or so apart, and log your weight with each so the numbers beside them mean something.";
    }
    secs.push({ t: "Trajectory", tone: "info", b: traj });

    // Next-two-weeks actions — grounded in the member's own numbers (phase above).
    acts.push("Aim for <b>" + tgtFreq + "×/week</b>. " + esc(ep && ep.tip ? ep.tip : "Progressive overload: add reps first, then weight once the top of the range feels easy."));
    acts.push(proteinG != null && kcal != null
      ? "Try around <b>" + proteinG + "g protein</b> and roughly <b>" + kcal + " kcal</b>/day (" + kcalWord + "). Both are estimates from your logged stats — adjust to how you're recovering."
      : "Fill in your height, age and current weight so I can estimate calorie and protein targets for you.");
    acts.push("If you take progress photos, keep the spot, light and time of day the same so the comparison stays fair.");

    return { secs: secs, acts: acts, overall: overall, weight: wp, photos: photos, phys: phys };
  }

  function render(data, photoNote) {
    var tonec = { good: "er-good", watch: "er-watch", info: "er-info" };
    var secHtml = data.secs.map(function (s) {
      return '<div class="er-sec ' + (tonec[s.tone] || "er-info") + '"><div class="er-t">' + esc(s.t) + '</div><div class="er-b">' + s.b + "</div></div>";
    }).join("");
    var actHtml = data.acts.map(function (a) { return "<li>" + a + "</li>"; }).join("");
    // Composite look-score, unchanged in meaning — the label spells out what feeds it so it is
    // not mistaken for weight-goal progress. Clamped to an integer before it reaches the style
    // attribute so a corrupted stored value can't break out of it.
    var pv = n0(data.overall);
    if (pv != null) pv = Math.max(0, Math.min(100, pv));
    var score = pv == null ? ""
      : '<div class="er-score"><div class="er-ring" style="--p:' + pv + '"><span>' + pv + "</span></div><div class=\"er-score-l\">Progress toward your <b>" + esc(data.phys && data.phys.name) + "</b> look — a blend of your body-fat estimate, training consistency and weight trend</div></div>";
    var pn = photoNote ? '<div class="er-photo">' + photoNote + "</div>" : "";
    document.getElementById("modal-card").innerHTML =
      '<div class="modal-head"><h2>Logged Progress Review <span class="tb-elite">★ Elite</span></h2><button class="icon-btn" onclick="App.closeModal()">✕</button></div>' +
      '<div class="er-intro">A rules-based read computed on your device from <b>your</b> logged data. Your photos are only checked for lighting consistency — nothing is measured from the images, and nothing leaves your phone.</div>' +
      score + secHtml + pn +
      '<div class="er-sec er-plan"><div class="er-t">Your next two weeks</div><ul class="er-acts">' + actHtml + "</ul></div>" +
      '<div class="er-foot">Body-fat figures are estimates calculated from your logged stats (Deurenberg), not measurements. Calorie estimates use Mifflin-St Jeor. General guidance, not medical advice — talk to a clinician or dietitian before making big changes.</div>';
    document.getElementById("modal").classList.remove("hidden");
  }

  function open() {
    if (!isElite()) { if (App.openPricing) App.openPricing(); return; }
    var version = ++renderVersion, owner = Store.key;
    var data = build();
    var ph = data.photos;
    var initial = ph.length === 1
      ? "<b>Photo lighting check:</b> one photo so far. Add another in ~a week, shot in the same light and pose, and I can tell you whether the two are comparable."
      : ph.length === 0 ? "" : null;
    render(data, initial);
    var displayed = document.getElementById("modal-card").innerHTML;
    if (ph.length >= 2) {
      Promise.all([luma(ph[0].url), luma(ph[ph.length - 1].url)]).then(function (ls) {
        var modal = document.getElementById("modal");
        if (version !== renderVersion || Store.key !== owner || !isElite() || !modal || modal.classList.contains("hidden") || document.getElementById("modal-card").innerHTML !== displayed) return;
        var l0 = ls[0], l1 = ls[1];
        if (l0 < 0 || l1 < 0) return;
        var diff = Math.abs(l1 - l0);
        // Average brightness only — this says nothing about the member's body composition.
        var note = diff <= 18
          ? "<b>Photo lighting check:</b> your first and latest shots have similar average brightness. Pose, angle and shadows can still differ; similar brightness alone does not establish a fair comparison. This compares lighting only — it doesn't read your body composition."
          : "<b>Photo lighting check:</b> your latest photo is noticeably " + (l1 > l0 ? "brighter" : "darker") + " overall than your first. Lighting swings can make progress look bigger or smaller than it is, so shoot in the same spot and light. This compares lighting only — it doesn't read your body composition.";
        render(data, note);
      });
    }
  }

  return { open: open, build: build };
})();
