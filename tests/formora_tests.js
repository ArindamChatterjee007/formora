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
    Social.requestConnect("p3"); ok("requestConnect adds to crew", Social.inCrew("p3"));

    /* ---------- CLOUD SOCIAL: normal + edge + impossible scenarios (where the real bugs live) ---------- */
    {
      const _m = { addPost: Cloud.addPost, deletePost: Cloud.deletePost, notify: Cloud.notify, registerMe: Cloud.registerMe, sendRequest: Cloud.sendRequest, acceptRequest: Cloud.acceptRequest, declineRequest: Cloud.declineRequest, cancelRequest: Cloud.cancelRequest, render: Social.render, toast: App.toast, me: Cloud.me };
      // stub network + render so we test pure logic (no Supabase writes)
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

      // restore
      Cloud.addPost = _m.addPost; Cloud.deletePost = _m.deletePost; Cloud.notify = _m.notify; Cloud.registerMe = _m.registerMe;
      Cloud.sendRequest = _m.sendRequest; Cloud.acceptRequest = _m.acceptRequest; Cloud.declineRequest = _m.declineRequest; Cloud.cancelRequest = _m.cancelRequest;
      Social.render = _m.render; if (typeof App !== "undefined") App.toast = _m.toast; Cloud.me = _m.me;
      Store.state.profile.following = origFollowing;
      Social.cloud = { users: [], requests: [], feed: [], sent: [], connections: [], comments: [], notifs: [], stories: [] };
    }

    /* ---------- CLOUD RENDER SMOKE: template-heavy paths (catches syntax/render bugs) ---------- */
    {
      const _me = Cloud.me, _render = Social.render, _toast = (typeof App !== "undefined") ? App.toast : null;
      Cloud.me = "u_me"; Social.render = () => {}; if (typeof App !== "undefined") App.toast = () => {};
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
      Social._dmWith = null; Social._dmInboxLoaded = false;
      Cloud.me = _me; Social.render = _render; if (typeof App !== "undefined") App.toast = _toast;
      Social.cloud = { users: [], requests: [], feed: [], sent: [], connections: [], comments: [], notifs: [], stories: [] };
      const ov = document.getElementById("story-viewer"); if (ov) ov.remove();
      const fx = document.getElementById("view-flex"); if (fx) fx.innerHTML = "";
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
