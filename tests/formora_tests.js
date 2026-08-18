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

    /* ---------------- MODULE COVERAGE: storage / engine / nutrition / auth ---------------- */
    // ---- Store ----
    Store.load("gymcoach_v1_COV_STORE_" + Date.now());
    Store.state.weightLog = []; Store.state.workoutLog = []; Store.state.foodLog = []; Store.state.restDays = [];
    Store.state.profile.startWeightKg = 72;
    ok("latestWeight falls back to startWeight", Store.latestWeight() === 72);
    Store.logWeight(75, "2026-01-01"); Store.logWeight(76, "2026-01-02");
    ok("logWeight new dates", Store.state.weightLog.length === 2 && Store.latestWeight() === 76);
    Store.logWeight(77, "2026-01-02");
    ok("logWeight same date updates", Store.state.weightLog.length === 2 && Store.latestWeight() === 77);
    Store.logRestDay("2026-01-03"); Store.logRestDay("2026-01-03");
    ok("logRestDay adds + dedupes", Store.state.restDays.filter((d) => d === "2026-01-03").length === 1);
    Store.logWorkout({ date: "2026-01-03", split: "push", exercises: [], volume: 0 });
    ok("logWorkout clears rest mark", !Store.state.restDays.includes("2026-01-03") && !!Store.workoutOn("2026-01-03"));
    ok("workoutOn missing → undefined", Store.workoutOn("1999-01-01") === undefined);
    Store.logFood({ text: "eggs", kcal: 200, protein: 18 }, "2026-01-04");
    Store.logFood({ text: "rice", kcal: 300, protein: 6 }, "2026-01-04");
    ok("logFood appends to day", Store.foodOn("2026-01-04").items.length === 2);
    Store.removeFood("2026-01-04", 0);
    ok("removeFood removes item", Store.foodOn("2026-01-04").items.length === 1 && Store.foodOn("2026-01-04").items[0].text === "rice");
    ok("foodOn missing → empty", Store.foodOn("1999-01-01").items.length === 0);
    Store.removeFood("1999-01-01", 0); ok("removeFood missing day safe", true);
    Store.state.weightLog = null; Store.state.profile = null; Store.normalize();
    ok("normalize restores arrays + profile", Array.isArray(Store.state.weightLog) && !!Store.state.profile);
    Store.state = { profile: { name: "L", onboarded: false }, weightLog: [{ date: "2026-02-01", kg: 80 }], workoutLog: [], foodLog: [{ date: "2026-02-01", items: [{ text: "a" }] }], restDays: ["2026-02-01"], updatedAt: 1 };
    const merged = Store.merge({ profile: { name: "C", onboarded: true }, weightLog: [{ date: "2026-01-01", kg: 70 }], workoutLog: [], foodLog: [{ date: "2026-02-01", items: [{ text: "b" }] }], restDays: ["2026-01-30"], updatedAt: 5 });
    ok("merge unions weight dates", merged.weightLog.length === 2);
    ok("merge unions food items per date", merged.foodLog.find((f) => f.date === "2026-02-01").items.length === 2);
    ok("merge unions restDays", merged.restDays.includes("2026-01-30") && merged.restDays.includes("2026-02-01"));
    ok("merge newer profile wins", merged.profile.name === "C");
    ok("merge onboarded = either true", merged.profile.onboarded === true);
    ok("merge null cloud → state", Store.merge(null) === Store.state);
    Store.reset();
    ok("reset reloads fresh state", !!Store.state && !!Store.state.profile);
    ok("todayISO format", /^\d{4}-\d{2}-\d{2}$/.test(todayISO()));
    ok("pad works", pad(3) === "03" && pad(11) === "11");
    ok("daysBetween", daysBetween("2026-01-01", "2026-01-08") === 7);
    ok("prettyDate returns string", typeof prettyDate("2026-01-01") === "string" && prettyDate("2026-01-01").length > 0);

    // ---- Engine ----
    Store.load("gymcoach_v1_COV_ENGINE_" + Date.now());
    Object.assign(Store.state.profile, { gender: "male", age: 26, heightCm: 178, activityFactor: 1.55, physique: "lean_aesthetic", diet: "veg", onboarded: true });
    Store.state.workoutLog = []; Store.state.restDays = [];
    Store.state.weightLog = [{ date: todayISO(), kg: 75 }];
    ok("engine stats healthy bmi", Engine.stats().bmiClass === "Healthy");
    Store.state.weightLog = [{ date: todayISO(), kg: 50 }];
    ok("engine bmi underweight", Engine.stats().bmiClass === "Underweight");
    Store.state.weightLog = [{ date: todayISO(), kg: 100 }];
    ok("engine bmi obese", Engine.stats().bmiClass === "Obese");
    Store.state.weightLog = [{ date: todayISO(), kg: 85 }];
    ok("engine bmi overweight", Engine.stats().bmiClass === "Overweight");
    Store.state.profile.gender = "female";
    ok("engine female bmr positive", Engine.stats().bmr > 0);
    Store.state.profile.gender = "male";
    ok("getPhysique valid", Engine.getPhysique().id === "lean_aesthetic");
    Store.state.profile.physique = "nonexistent_xyz";
    ok("getPhysique fallback", !!Engine.getPhysique().id);
    Store.state.profile.physique = "lean_aesthetic";
    ok("isEmphasized returns bool", typeof Engine.isEmphasized("Chest") === "boolean");
    ok("daysSinceSplit never → Infinity", Engine.daysSinceSplit("push") === Infinity);
    ok("recommendSplit returns split", typeof Engine.recommendSplit() === "string" && Engine.recommendSplit().length > 0);
    ok("splitReason no history", /No workout history/.test(Engine.splitReason(Engine.recommendSplit())));
    ok("lastPerformance none → null", Engine.lastPerformance("bench_press") === null);
    Store.state.workoutLog = [{ date: todayISO(), split: "push", exercises: [{ id: "bench_press", name: "Bench", muscle: "Chest", sets: [{ reps: 8, weight: 40 }, { reps: 6, weight: 50 }] }], volume: 700 }];
    const lp = Engine.lastPerformance("bench_press");
    ok("lastPerformance best set", lp && lp.best.weight === 50);
    ok("splitReason with history", typeof Engine.splitReason("push") === "string");
    ok("overloadHint no last", /First time/.test(Engine.overloadHint("squat")));
    ok("overloadHint with last", /Last/.test(Engine.overloadHint("bench_press")));
    ok("buildWorkout has slots", Engine.buildWorkout("push").length > 0);
    ok("recommendExtras returns array", Array.isArray(Engine.recommendExtras("push")));
    ok("weeklyFrequency >=1", Engine.weeklyFrequency() >= 1);
    ok("muscleBalance push counted", Engine.muscleBalance().push > 0);
    ok("streak >=1 today", Engine.streak() >= 1);
    ok("totalWorkouts = 1", Engine.totalWorkouts() === 1);
    Store.state.weightLog = [{ date: "2026-01-01", kg: 70 }, { date: "2026-02-01", kg: 73 }];
    ok("weightTrend up", Engine.weightTrend().dir === "up" && Engine.weightTrend().delta === 3);
    Store.state.weightLog = [{ date: "2026-01-01", kg: 73 }, { date: "2026-02-01", kg: 70 }];
    ok("weightTrend down", Engine.weightTrend().dir === "down");
    Store.state.weightLog = [{ date: "2026-01-01", kg: 70 }];
    ok("weightTrend flat when <2", Engine.weightTrend().dir === "flat");
    ok("guidance returns messages", Array.isArray(Engine.guidance()) && Engine.guidance().length > 0);

    // ---- Nutrition ----
    const est = FoodEstimator.parse("2 rotis and a bowl of dal with chicken curry, tea with sugar");
    ok("parse returns kcal+protein", est.kcal > 0 && est.protein > 0 && Array.isArray(est.items));
    ok("parse adds sugar item", est.items.some((i) => i.name === "Sugar"));
    const noSugar = FoodEstimator.parse("tea with no sugar");
    ok("parse respects no sugar", noSugar.sawNoSugar === true && !noSugar.items.some((i) => i.name === "Sugar"));
    ok("matchQty digit", FoodEstimator.matchQty("3 eggs") === 3);
    ok("matchQty word", FoodEstimator.matchQty("two eggs") === 2);
    ok("matchQty default 1", FoodEstimator.matchQty("egg") === 1);
    ok("pretty capitalizes", FoodEstimator.pretty("dal") === "Dal");
    ok("parse tracks unknown", FoodEstimator.parse("xyzzy blorp").unknown.length >= 1);
    for (const diet of ["veg", "vegan", "nonveg", "egg"]) {
      const mp = MealPlanner.generate("high protein muscle", diet, { calTarget: 2400, proteinG: 150 }, 1);
      ok("mealplan " + diet + " plan+targets", mp.plan.length > 0 && mp.totalK > 1500 && mp.totalP > 50);
      ok("mealplan " + diet + " respects diet", mp.plan.every((x) => dietAllows(x.meal.diet, diet)));
    }

    // ---- Auth ----
    Auth.load();
    const h1 = await Auth.hash("pw", "salt"), h2 = await Auth.hash("pw", "salt"), h3 = await Auth.hash("pw", "other");
    ok("hash deterministic + 64 hex", h1 === h2 && h1 !== h3 && h1.length === 64);
    ok("randHex length", Auth.randHex(8).length === 16);
    ok("genOtp 6 digits", /^\d{6}$/.test(Auth.genOtp()));
    ok("validEmail cases", Auth.validEmail("a@b.co") && !Auth.validEmail("a@b") && !Auth.validEmail("") && !Auth.validEmail("no"));
    ok("validPhone cases", Auth.validPhone("9876543210") && Auth.validPhone("+91 98765-43210") && !Auth.validPhone("123"));
    const em2 = "cov_auth_" + Date.now() + "@x.com";
    const su = await Auth.signup({ name: "T", email: em2, phone: "9876543210", password: "secret1" });
    ok("signup returns otp (local)", su.direct === false && /^\d{6}$/.test(su.otp));
    const vu = Auth.verifyOtp(Auth.pending.otp);
    ok("verifyOtp commits + sets current", vu.email === em2 && Auth.currentUser().email === em2);
    let dupThrew = false; try { await Auth.signup({ name: "T", email: em2, phone: "9", password: "y" }); } catch (e) { dupThrew = true; }
    ok("signup duplicate throws", dupThrew);
    let badPw = false; try { await Auth.login({ email: em2, password: "wrong" }); } catch (e) { badPw = true; }
    ok("login wrong password throws", badPw);
    ok("login correct works", (await Auth.login({ email: em2, password: "secret1" })).email === em2);
    let noAcc = false; try { await Auth.login({ email: "nobody" + Date.now() + "@x.com", password: "x" }); } catch (e) { noAcc = true; }
    ok("login no account throws", noAcc);
    Auth.pending = null;
    let noPending = false; try { Auth.verifyOtp("123456"); } catch (e) { noPending = true; }
    ok("verifyOtp no pending throws", noPending);
    const gs = Auth.googleStart({ name: "G", email: "g_" + Date.now() + "@x.com" });
    ok("googleStart pending", !!gs && gs.origin === "google");
    Auth.sendPhoneOtp("9998887776");
    ok("sendPhoneOtp sets otp+phone", /^\d{6}$/.test(Auth.pending.otp) && Auth.pending.account.phone === "9998887776");
    ok("resendOtp new otp", /^\d{6}$/.test(Auth.resendOtp()));
    let badCode = false; try { Auth.verifyOtp("000000"); } catch (e) { badCode = true; }
    ok("verifyOtp wrong code throws", badCode);
    Auth.pending = null;
    ok("findByEmail case-insensitive", !!Auth.findByEmail(em2.toUpperCase()));
    Auth.logout();
    ok("logout clears current", Auth.currentUser() === null && Auth.isLoggedIn() === false);

    // remote (Google Sheets) backend paths — mocked
    const _postSheet = Auth.postSheet;
    window.SHEETS_API = "https://fake.example";
    ok("Auth.remote() true when configured", Auth.remote() === true);
    Auth.postSheet = async (payload) => (payload.action === "signup" ? { ok: true } : { ok: true, user: { name: "R", phone: "9" } });
    ok("remote signup direct", (await Auth.signup({ name: "R", email: "rem_" + Date.now() + "@x.com", phone: "9", password: "p" })).direct === true);
    ok("remote login creates account", (await Auth.login({ email: "rem2_" + Date.now() + "@x.com", password: "p" })).remote === true);
    Auth.postSheet = async () => ({ ok: false, error: "nope" });
    let remoteErr = false; try { await Auth.signup({ name: "x", email: "e" + Date.now() + "@x.com", phone: "9", password: "p" }); } catch (e) { remoteErr = true; }
    ok("remote signup error throws", remoteErr);
    Auth.postSheet = _postSheet; window.SHEETS_API = "";
    ok("Auth.remote() false when unset", Auth.remote() === false);
    const gem = "gx_" + Date.now() + "@x.com";
    Auth.data.accounts.push({ id: "uG", name: "G", email: gem, phone: "", phoneVerified: true, provider: "google" });
    const gs2 = Auth.googleStart({ name: "G2", email: gem });
    ok("googleStart reuses existing account", gs2.account.id === "uG" && gs2.needsPhone === false);

    // Store.save quota-exceeded → sheds on-device avatar to protect logs
    Store.load("gymcoach_v1_COV_QUOTA_" + Date.now());
    Store.state.profile.avatar = "data:image/jpeg;base64,AAAA";
    const _setItem = localStorage.setItem.bind(localStorage);
    let qcalls = 0;
    localStorage.setItem = function (k, v) { if (k === Store.key && qcalls++ === 0) throw new Error("QuotaExceeded"); return _setItem(k, v); };
    const _alert = window.alert; window.alert = () => {};
    Store.save();
    localStorage.setItem = _setItem; window.alert = _alert;
    ok("save sheds avatar on quota (logs safe)", Store.state.profile.avatar === null);

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
    Social.requestConnect("p3"); ok("requestConnect adds to crew", Social.inCrew("p3"));

    /* ---------- CLOUD SOCIAL: normal + edge + impossible scenarios (where the real bugs live) ---------- */
    {
      const _m = { addPost: Cloud.addPost, deletePost: Cloud.deletePost, notify: Cloud.notify, registerMe: Cloud.registerMe, sendRequest: Cloud.sendRequest, acceptRequest: Cloud.acceptRequest, declineRequest: Cloud.declineRequest, cancelRequest: Cloud.cancelRequest, render: Social.render, toast: App.toast, me: Cloud.me, active: Cloud.active };
      // stub network + render so we test pure logic (no Supabase writes)
      Cloud.active = () => true; // exercise cloud-gated paths even when the runner forces local-only
      Cloud.addPost = (post) => ({ id: "np_" + Math.floor(Math.random() * 1e9), author: Cloud.me, likes: {}, ts: Date.now(), ...post });
      Cloud.deletePost = () => true; Cloud.notify = () => {}; Cloud.registerMe = () => {};
      Cloud.sendRequest = () => {}; Cloud.acceptRequest = () => {}; Cloud.declineRequest = () => {}; Cloud.cancelRequest = () => {};
      Social.render = () => {}; if (typeof App !== "undefined") App.toast = () => {};
      const me = "u_me"; Cloud.me = me;
      const origFollowing = Store.state.profile.following;
      Social.state.crew = [];
      const setState = () => {
        Store.state.profile.following = [];
        Social.cloud = {
          users: [
            { uid: "u_a", name: "Alice", username: "alice", following: [], privacy: "public" },
            { uid: "u_b", name: "Bob", username: "bob", following: ["u_me"], privacy: "public" },
            { uid: "u_c", name: "Cara", username: "cara", following: [], privacy: "friends" },
          ],
          requests: [{ from: "u_a", to: me, status: "pending" }],
          sent: ["u_b"], connections: ["u_c"],
          feed: [
            { id: "P1", author: "u_a", likes: { u_x: true } },
            { id: "R1", author: me, reshareOf: "P1", likes: {} },
            { id: "P2", author: me, likes: {} },
            { id: "P3", author: "u_c", likes: {} },
          ],
          comments: [{ id: "c1", post_id: "P1", author: "u_a", body: "hi" }],
          notifs: [], stories: [
            { id: "s1", author: "u_a", photo: "x", ts: 100 },
            { id: "s2", author: me, photo: "y", ts: 200 },
            { id: "s3", author: "u_a", photo: "z", ts: 300 },
          ],
        };
      };
      setState();

      // memberCta ordering (the recurring connect bug)
      ok("cloud memberCta connected→Message", /Message/.test(Social.memberCta("u_c")));
      ok("cloud memberCta requested→Cancel", /Requested/.test(Social.memberCta("u_b")));
      ok("cloud memberCta none→Connect", /Connect/.test(Social.memberCta("u_a")));
      Social.cloud.connections.push("u_b"); // impossible-ish: connected AND still in sent
      ok("cloud memberCta connected+sent→Message (connections win)", /Message/.test(Social.memberCta("u_b")));
      Social.cloud.connections = ["u_c"];

      // _cloudPost reshare/like counts + missing-field safety
      ok("cloud reshares count from reshareOf", Social._cloudPost(Social.cloud.feed[0]).reshares === 1);
      ok("cloud resharedByMe true", Social._cloudPost(Social.cloud.feed[0]).resharedByMe === true);
      ok("cloud likes count", Social._cloudPost(Social.cloud.feed[0]).likes === 1);
      const zp = Social._cloudPost({ id: "Z", author: "u_a" });
      ok("cloud _cloudPost missing fields safe", zp.likes === 0 && zp.reshares === 0 && zp.video === null && Array.isArray(zp.likers) && zp.likedByMe === false);

      // reshare once + undo + impossible cases
      setState();
      const len0 = Social.cloud.feed.length;
      Social.resharePost("P1"); // already reshared (R1) → undo
      ok("reshare undo removes my reshare", !Social.cloud.feed.some((p) => p.id === "R1") && Social.cloud.feed.length === len0 - 1);
      Social.resharePost("P1"); // now create one
      ok("reshare creates exactly one", Social.cloud.feed.filter((p) => p.reshareOf === "P1" && p.author === me).length === 1);
      Social.resharePost("P1"); // toggle off again
      ok("reshare toggles back to zero", Social.cloud.feed.filter((p) => p.reshareOf === "P1" && p.author === me).length === 0);
      setState();
      const own0 = Social.cloud.feed.length;
      Social.resharePost("P2"); // impossible: reshare own post
      ok("cannot reshare own post", Social.cloud.feed.length === own0);
      Social.resharePost("does_not_exist"); // impossible: non-existent id
      ok("reshare non-existent is safe", Social.cloud.feed.length === own0);

      // delete button visibility (own vs others)
      ok("delete btn on own cloud post", Social.postCard(Social._cloudPost({ id: "P2", author: me })).includes("removePost"));
      ok("no delete btn on others' post", !Social.postCard(Social._cloudPost({ id: "P1", author: "u_a" })).includes("removePost"));

      // follow / counts + impossible self-follow
      setState();
      ok("not following initially", !Social.isFollowing("u_a") && Social.followingCount() === 0);
      Social.toggleFollow("u_a");
      ok("toggleFollow follows + count", Social.isFollowing("u_a") && Social.followingCount() === 1);
      ok("followers includes my own follow (self excluded from users)", Social.followersCount("u_a") === 1);
      Social.toggleFollow("u_a");
      ok("toggleFollow unfollows", !Social.isFollowing("u_a") && Social.followingCount() === 0);
      Social.toggleFollow(me); // impossible: follow self
      ok("cannot follow self", !Social.isFollowing(me) && Social.followingCount() === 0);
      ok("followers from users list (u_b follows me)", Social.followersCount(me) === 1);
      ok("connectionsCount = 1", Social.connectionsCount() === 1);
      ok("followBtn shows Follow", /Follow/.test(Social.followBtn("u_a")));
      ok("followBtn empty for self", Social.followBtn(me) === "");

      // privacy visibility
      ok("canSee public post", Social._canSeePost({ author: "u_a" }));
      ok("canSee own post", Social._canSeePost({ author: me }));
      ok("canSee friends-only when connected", Social._canSeePost({ author: "u_c" }));
      Social.cloud.connections = [];
      ok("hide friends-only when NOT connected", !Social._canSeePost({ author: "u_c" }));
      Social.cloud.connections = ["u_c"];

      // stories grouping + comments
      const groups = Social.storyGroups();
      ok("storyGroups: 2 authors", groups.length === 2);
      ok("storyGroups: me first", groups[0].author === me);
      ok("storyGroups: author items grouped", groups.find((g) => g.author === "u_a").items.length === 2);
      ok("commentCount = 1 for P1", Social.commentCount("P1") === 1);
      ok("commentCount = 0 for P2", Social.commentCount("P2") === 0);

      // moderation / ban (window.BANNED_UIDS from config.js)
      ok("banned uid detected", Social._isBanned("miakhalifa_gmail_com") === true && Social._isBanned("someone_ok") === false);
      ok("banned author's post hidden from feed", Social._canSeePost({ author: "miakhalifa_gmail_com" }) === false);
      ok("App.isBanned matches ban list", (typeof App === "undefined") || App.isBanned("miakhalifa_gmail_com") === true);

      // ---- email verification (real, replaces the fake on-screen phone OTP) ----
      {
        const _ad = Auth.data, _ap = Auth.pending;
        Auth.data = { accounts: [], currentUserId: null }; Auth.pending = null;
        const sr = await Auth.signup({ name: "Ver Ify", email: "verify_test@example.com", phone: "+919812345670", password: "test1234" });
        ok("signup opens an EMAIL-channel code (email unverified)", Auth.pending && Auth.pending.channel === "email" && Auth.pending.account.emailVerified === false);
        Auth.pending.delivered = false;                 // no mail backend → demo code shown on screen
        Auth.verifyOtp(sr.otp);
        ok("demo code does NOT mark email verified", Auth.currentUser() && Auth.currentUser().emailVerified === false);

        Auth.data = { accounts: [], currentUserId: null }; Auth.pending = null;
        const sr2 = await Auth.signup({ name: "Ver Two", email: "verify_test2@example.com", phone: "+919812345671", password: "test1234" });
        Auth.pending.delivered = true;                  // code actually emailed
        Auth.verifyOtp(sr2.otp);
        ok("emailed code marks email verified", Auth.currentUser() && Auth.currentUser().emailVerified === true);

        Auth.data = { accounts: [], currentUserId: null }; Auth.pending = null;
        await Auth.signup({ name: "X", email: "x_test@example.com", phone: "+919812345672", password: "test1234" });
        let rejected = false; try { Auth.verifyOtp("000000"); } catch { rejected = true; }
        ok("wrong code rejected", rejected === true);

        Auth.data = { accounts: [], currentUserId: null }; Auth.pending = null;
        const g = Auth.loginWithGoogle({ name: "Goo Gle", email: "goo_test@example.com" });
        ok("google login is email-verified (the exception)", g.emailVerified === true);
        Auth.data = _ad; Auth.pending = _ap;
      }
      // Mailer code-delivery gating (nothing configured in tests → inert)
      ok("Mailer.emailjsReady false when unconfigured", typeof Mailer === "undefined" || Mailer.emailjsReady() === false);
      ok("Mailer.canSendCodes reflects backend config", typeof Mailer === "undefined" || Mailer.canSendCodes() === (!!window.EMAIL_FN_URL || Mailer.emailjsReady()));
      // verified badge
      ok("vbadge shows only for verified users", /vbadge/.test(Social.vbadge({ verified: true })) && Social.vbadge({ verified: false }) === "");

      // restore
      Cloud.addPost = _m.addPost; Cloud.deletePost = _m.deletePost; Cloud.notify = _m.notify; Cloud.registerMe = _m.registerMe;
      Cloud.sendRequest = _m.sendRequest; Cloud.acceptRequest = _m.acceptRequest; Cloud.declineRequest = _m.declineRequest; Cloud.cancelRequest = _m.cancelRequest;
      Social.render = _m.render; if (typeof App !== "undefined") App.toast = _m.toast; Cloud.me = _m.me; Cloud.active = _m.active;
      Store.state.profile.following = origFollowing;
      Social.cloud = { users: [], requests: [], feed: [], sent: [], connections: [], comments: [], notifs: [], stories: [] };
    }

    /* ---------- CLOUD RENDER SMOKE: template-heavy paths (catches syntax/render bugs) ---------- */
    {
      const _me = Cloud.me, _render = Social.render, _toast = (typeof App !== "undefined") ? App.toast : null, _active = Cloud.active;
      Cloud.me = "u_me"; Social.render = () => {}; if (typeof App !== "undefined") App.toast = () => {}; Cloud.active = () => true;
      Social.state.crew = [];
      Social.cloud = {
        users: [{ uid: "u_a", name: "Alice", username: "alice", following: [], privacy: "public" }],
        requests: [], sent: [], connections: ["u_a"], comments: [],
        feed: [
          { id: "V1", author: "u_a", video: "http://x/v.mp4", likes: {} },
          { id: "C1", author: "u_a", photos: ["a", "b", "c"], likes: {} },
          { id: "RS1", author: "u_me", reshareOf: "V1", resharedFrom: "u_a", text: "re", likes: {} },
        ],
        notifs: [], stories: [{ id: "s1", author: "u_a", photo: "http://x/p.jpg", kind: "photo", ts: 100 }, { id: "s2", author: "u_a", photo: "http://x/v.mp4", kind: "video", ts: 200 }],
      };
      ok("postCard renders <video> for reel", Social.postCard(Social._cloudPost(Social.cloud.feed[0])).includes("<video"));
      ok("postCard renders carousel for multi-photo", Social.postCard(Social._cloudPost(Social.cloud.feed[1])).includes("carousel"));
      ok("postCard shows reshared note", Social.postCard(Social._cloudPost(Social.cloud.feed[2])).includes("reshared"));
      const vpost = Social.postCard(Social._cloudPost(Social.cloud.feed[0]));
      ok("feed video is Instagram-style (no native controls, tap + mute)", !/controls/.test(vpost) && vpost.includes("tapFeedVideo") && vpost.includes("fv-mute"));
      ok("Social._bindFeedVideos exists", typeof Social._bindFeedVideos === "function");
      ok("feed sound is a persistent global toggle", (() => { const b0 = Social._feedSound; Social.toggleFeedMute(document.createElement("button")); const flipped = Social._feedSound !== b0; Social._feedSound = false; return flipped; })());
      const rs = App.reelSlide(Social._cloudPost(Social.cloud.feed[0]));
      ok("reelSlide builds video + actions", rs.includes("reel-vid") && rs.includes("reel-act"));
      App.renderFlex();
      ok("renderFlex shows one reel", document.querySelectorAll("#view-flex .reel").length === 1);
      ok("storiesRow builds rings", Social.storiesRow().includes("story-ring"));
      Social.openStory("u_a");
      ok("story viewer opens with media", !!document.getElementById("story-viewer") && !!document.querySelector("#story-viewer .sv-media"));
      Social.storyNext();
      ok("story next advances", Social._storyIi === 1);
      Social.storyPrev();
      ok("story prev goes back", Social._storyIi === 0);
      Social.closeStory();
      ok("story viewer closes", !document.getElementById("story-viewer"));
      Social._dmWith = null; Social._dmInboxLoaded = true; Social._dmConvos = [{ uid: "u_a", last: "hey", ts: Date.now() }];
      ok("dmBody renders inbox row", Social.dmBody().includes("dm-row"));
      Social._dmWith = "u_a"; Social._dmMsgs = [{ from: "u_a", to: "u_me", body: "hi there" }];
      ok("dmBody renders thread bubble", Social.dmBody().includes("bubble"));

      // ---- v51: premium icons + reel comments + chat tools ----
      ok("icon set renders svg (solid heart filled)", App.ic("heart", { solid: true }).includes("<svg") && App.ic("heart", { solid: true }).includes('fill="currentColor"'));
      ok("sendIcon is app-branded button", App.sendIcon("X()").includes("send-ico") && App.sendIcon("X()").includes("ic-send"));
      const rslide = App.reelSlide(Social._cloudPost(Social.cloud.feed[0]));
      ok("reel comment opens in-app overlay (not a page)", rslide.includes("openReelComments(") && rslide.includes("ic-comment"));
      ok("reel actions use premium icons", rslide.includes("ic-heart") && rslide.includes("ic-reshare"));
      ok("reel comments empty state", App._reelCommentsList("V1").includes("No comments"));
      Social.cloud.comments = [{ id: "rc1", post_id: "V1", author: "u_a", body: "sick reel", ts: Date.now() }];
      ok("reel comments list renders a comment", App._reelCommentsList("V1").includes("sick reel"));
      ok("Cloud has editMessage + deleteMessage", typeof Cloud.editMessage === "function" && typeof Cloud.deleteMessage === "function");
      ok("own bubble is tappable (edit/unsend)", Social.dmBubble({ id: "m1", from: "u_me", body: "yo" }, "u_me").includes("Social.msgMenu"));
      ok("their bubble not tappable", !Social.dmBubble({ id: "m2", from: "u_a", body: "hey" }, "u_me").includes("msgMenu"));
      ok("edited tag shows on edited msg", Social.dmBubble({ id: "m3", from: "u_me", body: "x", edited: true }, "u_me").includes("msg-edited"));
      const _del = Cloud.deleteMessage, _editm = Cloud.editMessage, _cf = window.confirm;
      Cloud.deleteMessage = () => true; Cloud.editMessage = () => true; window.confirm = () => true;
      Social._dmWith = "u_a"; Social._dmMsgs = [{ id: "mA", from: "u_me", to: "u_a", body: "one" }, { id: "mB", from: "u_a", to: "u_me", body: "two" }];
      Social.unsendMsg("mA");
      ok("unsend removes my message locally", !(Social._dmMsgs || []).some((m) => m.id === "mA"));
      Social._dmMsgs = [{ id: "mC", from: "u_me", to: "u_a", body: "old" }];
      const _ei = document.createElement("input"); _ei.id = "dm-edit"; _ei.value = "new text"; document.body.appendChild(_ei);
      Social._editMsg = { id: "mC", body: "old" }; Social.saveEditMsg();
      const _mc = (Social._dmMsgs || []).find((m) => m.id === "mC");
      ok("edit updates message body + edited flag", _mc && _mc.body === "new text" && _mc.edited === true);
      document.body.removeChild(_ei);
      Social._dmMsgs = [{ id: "mD", from: "u_me", to: "u_a", body: "keep" }, { id: "mE", from: "u_a", to: "u_me", body: "theirs" }];
      Social.clearMyMessages("u_a");
      ok("clear removes only my messages", !(Social._dmMsgs || []).some((m) => m.from === "u_me") && (Social._dmMsgs || []).some((m) => m.id === "mE"));
      Cloud.deleteMessage = _del; Cloud.editMessage = _editm; window.confirm = _cf;
      const _cd = Social.chatDetails; Social.chatDetails = () => {};
      const _wasMuted = Social.isMuted("u_zz"); Social.toggleMute("u_zz");
      ok("toggleMute flips mute state", Social.isMuted("u_zz") !== _wasMuted);
      Social.toggleMute("u_zz"); Social.chatDetails = _cd; Social._editMsg = null;

      // ---- v52: presence + public body stats + premium logo icons ----
      ok("Engine.fitnessScore is a 0..100 number", (() => { const s = Engine.fitnessScore(); return typeof s === "number" && s >= 0 && s <= 100; })());
      ok("premium logo icons render", App.ic("flame").includes("ic-flame") && App.ic("users").includes("<svg") && App.ic("trophy").includes("<svg") && App.ic("dumbbell").includes("<svg") && App.ic("grid").includes("<svg"));
      Social.cloud.users = [{ uid: "u_on", name: "On", username: "on", seen: Date.now() }, { uid: "u_off", name: "Off", username: "off", seen: Date.now() - 5 * 60000 }];
      ok("isOnline: recent seen = online", Social.isOnline("u_on") === true);
      ok("isOnline: stale seen = offline", Social.isOnline("u_off") === false);
      ok("isOnline: me is always online", Social.isOnline("me") === true && Social.isOnline("u_me") === true);
      ok("lastSeenText shows active-ago", /Active/.test(Social.lastSeenText("u_off")));
      ok("avatarP adds dot only when online", Social.avatarP({ id: "u_on", name: "On" }, 40).includes("online-dot") && !Social.avatarP({ id: "u_off", name: "Off" }, 40).includes("online-dot"));
      Social.cloud.users = [{ uid: "u_bod", name: "Bod", username: "bod", heightCm: 180, weightKg: 78, bmi: 24.1, score: 82, workouts: 12, seen: Date.now() }];
      const cu = Social.cloudUser("u_bod");
      ok("cloudUser exposes height/weight/bmi/score", cu.heightCm === 180 && cu.weightKg === 78 && cu.bmi === 24.1 && cu.score === 82);
      Social.viewProfile("u_bod"); Social.vpTab("u_bod", "stats");
      const vph = document.getElementById("modal-card").innerHTML;
      ok("public profile shows body stats + score", /180cm/.test(vph) && /78kg/.test(vph) && /Fitness score/.test(vph) && vph.includes("82"));
      if (typeof App !== "undefined" && App.closeModal) App.closeModal();

      Social._dmWith = null; Social._dmInboxLoaded = false;
      Cloud.me = _me; Social.render = _render; if (typeof App !== "undefined") App.toast = _toast; Cloud.active = _active;
      Social.cloud = { users: [], requests: [], feed: [], sent: [], connections: [], comments: [], notifs: [], stories: [] };
      const ov = document.getElementById("story-viewer"); if (ov) ov.remove();
      const fx = document.getElementById("view-flex"); if (fx) fx.innerHTML = "";
    }

    /* ---------- v47: auto-follow-on-connect + feed ranking + reshare idempotency + 100 filters ---------- */
    {
      const _m = { registerMe: Cloud.registerMe, notify: Cloud.notify, acceptRequest: Cloud.acceptRequest, addPost: Cloud.addPost, deletePost: Cloud.deletePost, render: Social.render, toast: (typeof App !== "undefined") ? App.toast : null, me: Cloud.me, active: Cloud.active };
      Cloud.active = () => true;
      Cloud.registerMe = () => {}; Cloud.notify = () => {}; Cloud.acceptRequest = () => {}; Cloud.deletePost = () => true;
      Cloud.addPost = (post) => ({ id: post.id || ("np_" + Math.random()), author: Cloud.me, likes: {}, ts: Date.now(), ...post });
      Social.render = () => {}; if (typeof App !== "undefined") App.toast = () => {};
      Cloud.me = "u_me"; Social.state.crew = [];
      Store.state.profile.following = []; Store.state.profile.autoFollowed = [];
      Social.cloud = { users: [{ uid: "u_a", name: "A", username: "a", following: [] }, { uid: "u_b", name: "B", username: "b", following: [] }], requests: [{ from: "u_a", to: "u_me", status: "pending" }], sent: [], connections: [], comments: [], feed: [], notifs: [], stories: [] };

      Social.acceptReq("u_a");
      ok("accept auto-follows the connection", Social.isFollowing("u_a"));
      ok("accept adds to connections", (Social.cloud.connections || []).includes("u_a"));
      Social.cloud.connections = ["u_a", "u_b"];
      Social.syncAutoFollow();
      ok("syncAutoFollow follows all connections", Social.isFollowing("u_a") && Social.isFollowing("u_b"));
      Social.toggleFollow("u_b");
      ok("can unfollow a connection (opt-out)", !Social.isFollowing("u_b"));
      Social.syncAutoFollow();
      ok("opt-out respected (no re-auto-follow)", !Social.isFollowing("u_b"));

      Store.state.profile.following = ["u_a"]; Social.cloud.connections = ["u_a"];
      const ranked = Social._rankFeed([
        { id: "old_stranger", author: "u_x", ts: 1000 },
        { id: "new_stranger", author: "u_y", ts: 9000 },
        { id: "followed", author: "u_a", ts: 500 },
        { id: "mine", author: "u_me", ts: 100 },
      ]);
      ok("feed ranks own+followed above strangers", ranked[0].id === "mine" && ranked[1].id === "followed");
      ok("strangers ranked below, newest-first", ranked[2].id === "new_stranger" && ranked[3].id === "old_stranger");

      Social.cloud.feed = [{ id: "PX", author: "u_a", likes: {} }];
      Social.resharePost("PX");
      const r1 = Social.cloud.feed.find((p) => p.reshareOf === "PX" && p.author === "u_me");
      ok("reshare uses deterministic id", r1 && r1.id === "rs_u_me__PX");
      ok("only one reshare per account", Social.cloud.feed.filter((p) => p.reshareOf === "PX" && p.author === "u_me").length === 1);

      ok("camera has ~100 filters", Camera.FILTERS.length >= 100);
      Camera.filterIdx = 0; Camera.setFilter(Camera.FILTERS.length - 1);
      ok("setFilter selects last", Camera.filterIdx === Camera.FILTERS.length - 1);
      Camera.nextFilter();
      ok("nextFilter wraps to first", Camera.filterIdx === 0);
      Camera.prevFilter();
      ok("prevFilter wraps to last", Camera.filterIdx === Camera.FILTERS.length - 1);
      Camera.filterIdx = 0;

      Cloud.registerMe = _m.registerMe; Cloud.notify = _m.notify; Cloud.acceptRequest = _m.acceptRequest; Cloud.addPost = _m.addPost; Cloud.deletePost = _m.deletePost;
      Social.render = _m.render; if (typeof App !== "undefined") App.toast = _m.toast; Cloud.me = _m.me; Cloud.active = _m.active;
      Store.state.profile.following = []; Store.state.profile.autoFollowed = [];
      Social.cloud = { users: [], requests: [], feed: [], sent: [], connections: [], comments: [], notifs: [], stories: [] };
    }

    // DATA SAFETY: onboarding must NEVER erase existing logs (the reported bug)
    Store.load("gymcoach_v1_TEST_SAFE_" + Date.now());
    Store.state.workoutLog = [{ date: todayISO(), split: "push", exercises: [{ id: "bench_press", name: "x", muscle: "Chest", sets: [{ reps: 10, weight: 40 }] }], volume: 400 }];
    Store.state.foodLog = [{ date: todayISO(), items: [{ text: "eggs", kcal: 200, protein: 18 }] }];
    Store.state.profile.onboarded = false; Store.state.profile.name = "";
    App.onboardMode = "login";
    const f2 = document.createElement("div");
    f2.innerHTML = '<select id="d-gender"><option value="male" selected>m</option></select><input id="d-dob" value="1995-01-01"><input id="d-h" value="180"><input id="d-w" value="80"><input id="d-tw" value=""><select id="d-act"><option value="1.55" selected>m</option></select><select id="d-diet"><option value="nonveg" selected>n</option></select>';
    document.body.appendChild(f2);
    const realEnter = App.enterApp; App.enterApp = function () {};
    App.finishOnboarding();
    App.enterApp = realEnter;
    document.body.removeChild(f2);
    ok("onboarding keeps workout log", Store.state.workoutLog.length === 1, "wk=" + Store.state.workoutLog.length);
    ok("onboarding keeps food log", Store.state.foodLog.length === 1, "food=" + Store.state.foodLog.length);
    ok("onboarding sets weight without wiping history", Store.latestWeight() === 80, "w=" + Store.latestWeight());

    // unique username (avoids demo-crew handle collision)
    Store.load("gymcoach_v1_TEST_UN_" + Date.now());
    Store.state.profile.username = ""; Store.state.profile.email = "vikstrong@x.com";
    App.ensureUsername();
    ok("ensureUsername avoids persona-handle collision", Store.state.profile.username !== "vikstrong" && !!Store.state.profile.username, "un=" + Store.state.profile.username);

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

    // ---- v55: exercise library (photos) + kg/lbs + delete/replace ----
    ok("Exercises.imgFor builds CDN url", Exercises.imgFor({ images: ["Foo/0.jpg"] }).includes("cdn.jsdelivr.net") && Exercises.imgFor({ images: ["Foo/0.jpg"] }).endsWith("Foo/0.jpg"));
    ok("Exercises.imgFor prefers explicit photo", Exercises.imgFor({ photo: "http://x/p.jpg", images: ["a/0.jpg"] }) === "http://x/p.jpg");
    ok("muscle→group mapping", Exercises._groupFromMuscle("Chest") === "Chest" && Exercises._groupFromMuscle("lats") === "Back" && Exercises._groupFromMuscle("biceps") === "Arms" && Exercises._groupFromMuscle("quadriceps") === "Legs" && Exercises._groupFromMuscle("abdominals") === "Core");
    ok("equipment bucket", Exercises._equipCat("machine") === "Machine" && Exercises._equipCat("body only") === "Bodyweight" && Exercises._equipCat("bands") === "Other");
    const _savedCat = Exercises._cat;
    Exercises._cat = [
      { id: "a", name: "Dip Machine", muscle: "Chest", equip: "Machine", group: "Chest", equipCat: "Machine", images: ["Dip_Machine/0.jpg"] },
      { id: "b", name: "Barbell Curl", muscle: "Biceps", equip: "Barbell", group: "Arms", equipCat: "Barbell", images: [] },
      { id: "c", name: "Leg Press", muscle: "Quadriceps", equip: "Machine", group: "Legs", equipCat: "Machine", images: [] },
    ];
    ok("catalog search by text", Exercises.search("dip").length === 1 && Exercises.search("dip")[0].id === "a");
    ok("catalog search by group", Exercises.search("", "Legs").length === 1 && Exercises.search("", "Legs")[0].id === "c");
    ok("catalog search by equipment", Exercises.search("", "", "Machine").length === 2);
    ok("Exercises.byId", Exercises.byId("a").name === "Dip Machine" && Exercises.byId("bench_press").name === EXERCISES.bench_press.name);
    Exercises._cat = _savedCat;

    ok("_exOf resolves EXERCISES id", App._exOf({ selected: "bench_press" }).name === EXERCISES.bench_press.name);
    ok("_exOf resolves catalog ex", App._exOf({ selected: "a", ex: { id: "a", name: "Dip Machine", muscle: "Chest", equip: "Machine" } }).name === "Dip Machine");
    ok("_exOf unknown id is safe", App._exOf({ selected: "zzz" }).name === "zzz");
    ok("curated exercise has a real photo", Exercises.imgForCurated("bench_press").includes("cdn.jsdelivr.net") && /Bench_Press/.test(Exercises.imgForCurated("bench_press")));
    ok("every built-in exercise is mapped to a photo", Object.keys(EXERCISES).every((id) => !!Exercises.imgForCurated(id)));
    ok("_exImg resolves curated photo", /Bench_Press/.test(App._exImg({ selected: "bench_press" })));
    ok("_exImg resolves catalog image", App._exImg({ ex: { images: ["Dip_Machine/0.jpg"] } }).includes("Dip_Machine"));
    App.session = { split: "push", items: [{ selected: "bench_press", options: ["bench_press", "x"], reps: "6-10", targetSets: 4, slotName: "Chest", sets: [{ reps: "", weight: "" }], kind: "primary" }] };
    ok("plan slot renders a photo", App.itemCard(App.session.items[0], 0).includes("cdn.jsdelivr.net"));
    App.session = null;

    const _unitSave = Store.state.profile.unit;
    Store.state.profile.unit = "kg";
    ok("kg passthrough", App._toKg(100) === 100 && App._fromKg(100) === 100);
    Store.state.profile.unit = "lbs";
    ok("lbs→kg conversion", Math.abs(App._toKg(220) - 99.8) < 0.6);
    ok("kg→lbs conversion", Math.abs(App._fromKg(100) - 220.5) < 1);
    ok("overloadHint is unit-aware", typeof Engine.overloadHint("bench_press", "lbs") === "string");
    Store.state.profile.unit = _unitSave || "kg";

    // full flow: add catalog exercise, log in lbs, verify kg storage + photo; delete keeps ≥1
    const _cf = window.confirm; window.confirm = () => true;
    Store.load("gymcoach_v1_TEST_EXLIB_" + Date.now());
    Object.assign(Store.state.profile, { onboarded: true, physique: "lean_aesthetic", gender: "male", unit: "lbs" });
    App.session = null; App.startSession("push");
    const nStart = App.session.items.length;
    App.removeItem(0);
    ok("removeItem deletes an exercise", App.session.items.length === nStart - 1);
    App.addExerciseFromCatalog({ id: "Dip_Machine", name: "Dip Machine", muscle: "Chest", equip: "Machine", images: ["Dip_Machine/0.jpg"] });
    const li = App.session.items.length - 1;
    ok("itemCard shows photo + replace + remove", (() => { const c = App.itemCard(App.session.items[li], li); return c.includes("Dip_Machine/0.jpg") && c.includes("replaceExercise") && c.includes("removeItem"); })());
    App.session.items.forEach((it) => { it.sets = [{ reps: "", weight: "" }]; });
    App.session.items[li].sets[0] = { reps: "10", weight: "110" }; // 110 lbs
    App.finishSession();
    const wlog = Store.workoutOn(todayISO());
    const dip = wlog && wlog.exercises.find((e) => e.id === "Dip_Machine");
    ok("catalog exercise logged with photo", !!dip && !!dip.photo && dip.photo.includes("Dip_Machine"));
    ok("weight saved in kg from a lbs entry", dip && Math.abs(dip.sets[0].weight - 49.9) < 1);
    App.editSession();
    ok("editSession shows the lbs value back", (() => { const it = App.session.items.find((x) => x.selected === "Dip_Machine"); return it && Math.abs((+it.sets[0].weight) - 110) < 2; })());
    App.setUnit("kg");
    ok("setUnit converts session weight lbs→kg", (() => { const it = App.session.items.find((x) => x.selected === "Dip_Machine"); return it && Math.abs((+it.sets[0].weight) - 49.9) < 1 && App._unit() === "kg"; })());
    window.confirm = _cf; App.session = null;

    // v59: gender-aware body composition — same BMI reads higher body-fat for women, and goals differ
    {
      const _g = Store.state.profile.gender, _age = Store.state.profile.age;
      Store.state.profile.age = 25;
      Store.state.profile.gender = "male";
      const bfM = Engine.bodyFat(), compM = Engine.bodyComp();
      Store.state.profile.gender = "female";
      const bfF = Engine.bodyFat(), compF = Engine.bodyComp();
      ok("female body-fat estimate reads higher than male at same BMI/age", bfF > bfM + 8);
      ok("male body-comp coaches a muscular physique", /physique/i.test(compM.advice) && compM.male === true);
      ok("female body-comp coaches a toned figure", /figure/i.test(compF.advice) && compF.male === false);
      ok("body-fat class is gender-specific", typeof compM.bfClass === "string" && typeof compF.bfClass === "string");
      ok("stats() exposes body-fat", typeof Engine.stats().bodyFat === "number" && Engine.stats().bodyFat > 0);
      ok("guidance leads with the body-fat read", (Engine.guidance()[0] || "").toLowerCase().includes("body fat"));
      Store.state.profile.gender = _g; Store.state.profile.age = _age;
    }

    // v59: Pexels reference photo un-hides the #pd-photo box (female looks were staying hidden)
    {
      const _f = window.fetch, _k = window.PEXELS_KEY;
      window.PEXELS_KEY = "testkey";
      window.fetch = async () => ({ ok: true, json: async () => ({ photos: [{ src: { portrait: "http://x/ref.jpg" }, photographer: "Tester" }] }) });
      const box = document.createElement("div"); box.id = "pd-photo"; box.className = "pd-photo none"; document.body.appendChild(box);
      App.pexelsCache = {};
      await App.loadPexelsPhoto("hourglass");
      ok("pexels photo shows + un-hides the box", !box.classList.contains("none") && box.innerHTML.includes("http://x/ref.jpg") && box.innerHTML.includes("Pexels"));
      document.body.removeChild(box);
      window.fetch = _f; window.PEXELS_KEY = _k;
    }

    // Female exercise imagery — GROUP/browse-picker path (no data-exq): deterministic + stable
    {
      const _f = window.fetch, _k = window.PEXELS_KEY, _g = Store.state.profile.gender;
      window.PEXELS_KEY = "testkey";
      Store.state.profile.gender = "female";
      window.fetch = async () => ({ ok: true, json: async () => ({ photos: [0, 1, 2, 3, 4, 5].map((n) => ({ src: { portrait: "P" + n } })) }) });
      const render = async (keys) => {
        App.exFemalePool = {}; App.exFemalePhotos = {};
        const w = document.createElement("div");
        w.innerHTML = keys.map((k) => `<span class="ex-thumb noimg" data-exmuscle="Chest" data-exkey="${k}"></span>`).join("");
        document.body.appendChild(w);
        await App.loadFemaleExPhotos(w);
        const m = {};
        w.querySelectorAll(".ex-thumb").forEach((e) => { const i = e.querySelector("img"); m[e.getAttribute("data-exkey")] = i ? i.getAttribute("src") : null; });
        document.body.removeChild(w);
        return m;
      };
      const m1 = await render(["bench_press", "ohp"]);
      ok("picker female thumbnail gets a woman photo", /^P\d$/.test(m1.bench_press || ""));
      const m2 = await render(["a", "b", "bench_press", "ohp"]);
      ok("picker: same exercise keeps the SAME photo across re-renders", m1.ohp === m2.ohp && m1.bench_press === m2.bench_press);
      const mv = await render(["bench_press", "ohp", "incline_db_press", "cable_fly", "pec_deck", "chest_dip"]);
      ok("picker: different exercises spread across photos", new Set(Object.values(mv)).size >= 2);
      Store.state.profile.gender = "male";
      const wm = document.createElement("div");
      wm.innerHTML = '<span class="ex-thumb noimg" data-exmuscle="Chest" data-exkey="bench_press"></span>';
      document.body.appendChild(wm);
      await App.loadFemaleExPhotos(wm);
      ok("male users keep the male form demo (no swap)", wm.querySelectorAll("img").length === 0);
      document.body.removeChild(wm);
      ok("_femaleExQuery maps every group to a woman query", /woman/.test(App._femaleExQuery("Legs")) && /woman/.test(App._femaleExQuery("")));
      window.fetch = _f; window.PEXELS_KEY = _k; Store.state.profile.gender = _g;
    }

    // Female exercise imagery — EXACT per-exercise path (data-exq): thumbnail == preview, exercise-specific
    {
      const _f = window.fetch, _k = window.PEXELS_KEY, _g = Store.state.profile.gender;
      window.PEXELS_KEY = "testkey"; Store.state.profile.gender = "female";
      // photos echo the query so we can prove each exercise gets its OWN (not generic) photo
      window.fetch = async (url) => {
        const q = decodeURIComponent((String(url).match(/query=([^&]+)/) || [])[1] || "");
        const tag = /bench/.test(q) ? "BENCH" : /overhead/.test(q) ? "OHP" : "GEN";
        return { ok: true, json: async () => ({ photos: [0, 1, 2].map((n) => ({ src: { portrait: tag + n } })) }) };
      };
      ok("_femaleExQueryFor builds a specific per-exercise query", App._femaleExQueryFor({ name: "Barbell Bench Press" }) === "woman barbell bench press gym");
      const thumb = async (key, q, grp) => {
        App.exFemalePhotos = {};
        const w = document.createElement("div");
        w.innerHTML = `<span class="ex-thumb noimg" data-exkey="${key}" data-exq="${q}" data-exmuscle="${grp}"></span>`;
        document.body.appendChild(w); await App.loadFemaleExPhotos(w);
        const src = w.querySelector("img") && w.querySelector("img").getAttribute("src");
        document.body.removeChild(w); return src;
      };
      const bench = await thumb("bench_press", "woman barbell bench press gym", "Chest");
      const ohp = await thumb("ohp", "woman overhead barbell press gym", "Shoulders");
      ok("exact thumbnails are exercise-specific (not generic)", bench === "BENCH0" && ohp === "OHP0");
      // preview reuses the SAME cached exercise photos → matches the thumbnail + a 2nd photo
      App.exFemalePhotos = {};
      const b2 = await thumb("bench_press", "woman barbell bench press gym", "Chest");
      const box = document.createElement("div"); box.id = "exp-hero"; document.body.appendChild(box);
      await App._loadFemaleHero("bench_press", "woman barbell bench press gym", "Chest");
      const heroSrcs = [...box.querySelectorAll("img")].map((i) => i.getAttribute("src"));
      document.body.removeChild(box);
      ok("exact preview[0] == thumbnail photo", heroSrcs[0] === b2);
      ok("exact preview shows two photos", heroSrcs.length === 2 && heroSrcs[1] === "BENCH1");
      // fallback to the muscle-group query when the specific one returns nothing
      App.exFemalePhotos = {};
      window.fetch = async (url) => {
        const q = decodeURIComponent((String(url).match(/query=([^&]+)/) || [])[1] || "");
        return { ok: true, json: async () => ({ photos: /bench/.test(q) ? [] : [{ src: { portrait: "GROUP0" } }] }) };
      };
      const fb = await thumb("bench_press", "woman barbell bench press gym", "Chest");
      ok("exact path falls back to a muscle-group photo when specific is empty", fb === "GROUP0");
      window.fetch = _f; window.PEXELS_KEY = _k; Store.state.profile.gender = _g;
    }
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
