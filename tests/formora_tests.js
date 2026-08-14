/* ============================================================
   FORMORA test harness — unit + end-to-end.
   Run in the browser (all app globals must be loaded):
     window.runFormoraTests().then(r => console.log(r));
   Uses throwaway localStorage keys and restores real state after.
   ============================================================ */
window.runFormoraTests = async function () {
  const results = [];
  const ok = (name, cond, extra) => results.push({ name, pass: !!cond, extra: cond ? "" : (extra || "") });
  const approx = (a, b, tol) => Math.abs(a - b) <= tol;

  // snapshot every app key so we can fully restore afterwards
  const snap = {};
  Object.keys(localStorage).forEach((k) => { if (/^(gymcoach_|formora_)/.test(k)) snap[k] = localStorage.getItem(k); });
  const restore = () => {
    Object.keys(localStorage).forEach((k) => { if (/^(gymcoach_|formora_)/.test(k)) localStorage.removeItem(k); });
    Object.keys(snap).forEach((k) => localStorage.setItem(k, snap[k]));
  };

  try {
    /* ---------------- UNIT ---------------- */
    ok("DEFAULT_PROFILE has no hardcoded person", DEFAULT_PROFILE.name === "" && DEFAULT_PROFILE.onboarded === false, "name=" + DEFAULT_PROFILE.name);
    ok("validEmail works", Auth.validEmail("a@b.com") && !Auth.validEmail("nope"));
    ok("validPhone works", Auth.validPhone("+919876543210") && !Auth.validPhone("12"));

    Store.load("gymcoach_v1_TEST_UNIT");
    Object.assign(Store.state.profile, { gender: "male", dob: "2000-01-01", age: 25, heightCm: 178, diet: "veg", activityFactor: 1.55, physique: "lean_aesthetic", onboarded: true });
    Store.state.weightLog = [{ date: todayISO(), kg: 70 }];
    const s = Engine.stats();
    ok("stats calTarget sane", s.calTarget > 1500 && s.calTarget < 4000, "calTarget=" + s.calTarget);
    ok("stats proteinG sane", s.proteinG > 80 && s.proteinG < 220, "proteinG=" + s.proteinG);

    const plan = MealPlanner.generate("high protein", "veg", s, 1);
    ok("meal plan hits calorie target (±12%)", approx(plan.totalK, s.calTarget, s.calTarget * 0.12), "totalK=" + plan.totalK + " target=" + s.calTarget);
    ok("meal plan meets protein goal", plan.totalP >= s.proteinG - 5, "totalP=" + plan.totalP + " goal=" + s.proteinG);
    ok("meal plan respects veg diet", plan.plan.every((x) => ["veg", "vegan"].includes(x.meal.diet)), plan.plan.map((x) => x.meal.diet).join(","));

    // image resize
    const cv = document.createElement("canvas"); cv.width = 1200; cv.height = 900;
    cv.getContext("2d").fillStyle = "#e33"; cv.getContext("2d").fillRect(0, 0, 1200, 900);
    const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
    const resized = await resizeImage(new File([blob], "t.png", { type: "image/png" }), 256, 0.8);
    ok("resizeImage returns jpeg dataURL", resized.startsWith("data:image/jpeg"), resized.slice(0, 24));
    const rimg = new Image(); await new Promise((res, rej) => { rimg.onload = res; rimg.onerror = rej; rimg.src = resized; });
    ok("resizeImage caps longest side to 256", rimg.width <= 256 && rimg.height <= 256, rimg.width + "x" + rimg.height);

    /* ---------------- E2E ---------------- */
    // account unify by email (fixes diet/data forking between login methods)
    Auth.load();
    const em = "e2e_unify_" + Date.now() + "@x.com";
    Auth.data.accounts.push({ id: "uEM", name: "E", email: em, provider: "email", phoneVerified: false });
    ok("google login reuses same-email account", Auth.loginWithGoogle({ name: "E G", email: em }).id === "uEM");

    // NEW USER must NOT inherit a real person's data (the reported bug)
    Store.load("gymcoach_v1_TEST_FRESH_" + Date.now());
    ok("fresh store name is empty (not a person)", Store.state.profile.name === "", "name=" + Store.state.profile.name);
    ok("fresh store weight is neutral 70 (not inherited)", Store.state.profile.startWeightKg === 70, "w=" + Store.state.profile.startWeightKg);
    ok("fresh store onboarded=false (forces onboarding)", Store.state.profile.onboarded === false);

    // onboarding reads the form → patch with real values + onboarded flag
    const form = document.createElement("div");
    form.innerHTML = '<select id="d-gender"><option value="female" selected>f</option></select>' +
      '<input id="d-dob" value="1998-05-10"><input id="d-h" value="165"><input id="d-w" value="58">' +
      '<input id="d-tw" value="55"><select id="d-act"><option value="1.725" selected>h</option></select>' +
      '<select id="d-diet"><option value="vegan" selected>v</option></select>';
    document.body.appendChild(form);
    const patch = App._readDetails();
    document.body.removeChild(form);
    ok("_readDetails builds correct patch", patch && patch.onboarded === true && patch.gender === "female" && patch.heightCm === 165 && patch.startWeightKg === 58 && patch.diet === "vegan", JSON.stringify(patch));

    // social lifecycle
    Social.load("TEST_SOCIAL_" + Date.now());
    const p0 = Social.feed().length;
    Social.createPost({ text: "hi", photo: null });
    ok("createPost adds a post", Social.feed().length === p0 + 1);
    const pid = Social.feed()[0].id, likes0 = Social.post(pid).likes;
    Social.toggleLike(pid);
    ok("toggleLike increments + flags", Social.post(pid).likes === likes0 + 1 && Social.post(pid).likedByMe === true);
    Social.addComment(pid, "nice");
    ok("addComment adds a comment", Social.post(pid).comments.some((c) => c.text === "nice"));
    Social.crewAdd("p1"); ok("crewAdd connects", Social.inCrew("p1"));
    Social.toggleFollow("p2"); ok("follow works", Social.isFollowing("p2"));
    Social.sendMessage("p1", "yo"); ok("chat auto-replies", Social.messages("p1").length === 2);
    Social.createChallenge({ withId: "p1", title: "t", days: 7 }); ok("createChallenge", Social.state.challenges.length === 1);

    // workout edit lifecycle (no duplicate on re-finish)
    Store.load("gymcoach_v1_TEST_WK_" + Date.now());
    Object.assign(Store.state.profile, { onboarded: true, physique: "lean_aesthetic", gender: "male" });
    App.session = null;
    App.startSession("push");
    App.session.items[0].sets[0] = { reps: "10", weight: "40" };
    App.finishSession();
    const wk1 = Store.workoutOn(todayISO());
    ok("workout saved", !!wk1 && wk1.exercises.length >= 1);
    App.editSession();
    ok("editSession reopens finished workout", !!App.session && App.session.editing === true);
    App.session.items[0].sets[0] = { reps: "12", weight: "50" };
    App.finishSession();
    const todays = Store.state.workoutLog.filter((w) => w.date === todayISO());
    ok("edit updates in place (no duplicate)", todays.length === 1, "count=" + todays.length);
    ok("edited set persisted", todays[0].exercises[0].sets[0].weight === 50, JSON.stringify(todays[0].exercises[0].sets[0]));
  } catch (e) {
    results.push({ name: "EXCEPTION", pass: false, extra: (e && e.message) + " @ " + ((e && e.stack) || "").split("\n")[1] });
  } finally {
    restore();
    App.session = null; App.onboardMode = null;
    Auth.load();
  }

  const failures = results.filter((r) => !r.pass);
  return { total: results.length, passed: results.length - failures.length, failed: failures.length,
    failures: failures.map((f) => f.name + " — " + f.extra),
    all: results.map((r) => (r.pass ? "✓ " : "✗ ") + r.name) };
};
