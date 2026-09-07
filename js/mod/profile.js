window.AppProfile = {
  renderProfile(preserveDraft = true) {
    if (preserveDraft && this.curTab === "profile" && this._sameDraftOwner(this._profileViewOwner, this._draftOwner())) this._captureProfileDraft();
    if (!preserveDraft) this._profileDraft = null;
    const el = document.getElementById("view-profile");
    const p = Store.state.profile;
    const s = Engine.stats();
    const u = Auth.currentUser() || {};
    const cloudOn = typeof Cloud !== "undefined" && Cloud.active();
    const myTier = (typeof Entitlements !== "undefined") ? (Entitlements.isElite() ? "elite" : Entitlements.isPro() ? "pro" : "free") : "free";
    const myPosts = cloudOn ? Social.cloud.feed.filter((x) => x.author === Cloud.me) : Social.feed().filter((x) => x.author === "me");
    el.innerHTML = `
      <div class="card profile-hero" data-tier="${myTier}">
        <div class="ph-cover"${p.cover ? ` style="background-image:url('${esc(p.cover)}');background-size:cover;background-position:center"` : ""}>
          <label class="ph-cover-edit" title="Change cover photo"><input type="file" accept="image/*" onchange="App.uploadCover(event)" hidden>${this.ic("camera", { size: 14 })}<span>Cover</span></label>
          <button class="ph-logout-ic" onclick="App.confirmLogout()" title="Log out" aria-label="Log out">${this.ic("logout", { size: 17 })}</button>
        </div>
        <div class="ph-main">
          <label class="ph-avatar" title="Change photo">
            ${Social.avatar(Social.me(), 92)}
            <span class="ph-cam">${this.ic("camera", { size: 13 })}</span>
            <input type="file" accept="image/*" onchange="App.uploadAvatar(event)" hidden>
          </label>
          <div class="ph-id">
            <div class="ph-name">${esc(p.name || "User")}</div>
            <div class="ph-handle">@${esc(p.username || (u.email || "you").split("@")[0])}${u.provider === "google" ? " · via Google" : ""}</div>
          </div>
        </div>
        <div class="ph-chips">
          ${(typeof Entitlements !== "undefined" && Entitlements.isPro()) ? Social.tierBadge({ tier: Entitlements.isElite() ? "elite" : "pro" }) : ""}
          <span class="lvl">${esc(Social.me().level)}</span>
        </div>
        ${p.coverPending ? `<div class="cover-sync" style="padding:12px 0;display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span role="status" style="flex:1;min-width:160px">${this._coverSync ? "Syncing cover..." : "Cover not synced. Retry sync, or choose another image."}</span><button class="btn ghost" onclick="App.syncCover()"${this._coverSync ? " disabled" : ""}>${this.ic("undo", { size: 16 })} Retry cover sync</button></div>` : ""}
        <div class="ph-stats">
          <div><b>${cloudOn ? Social.connectionsCount() : Social.crewList().length}</b><span>Connections</span></div>
          <div><b>${cloudOn ? Social.followersCount() : 0}</b><span>Followers</span></div>
          <div><b>${cloudOn ? Social.followingCount() : 0}</b><span>Following</span></div>
          <div><b>${myPosts.length}</b><span>Posts</span></div>
        </div>
        <div class="ph-bio-field field"><label for="p-username">Username <span class="inline-hint">(your unique @handle)</span></label>
          <input id="p-username" maxlength="20" value="${esc(p.username || "")}" placeholder="e.g. arindam.fit">
        </div>
        <div class="ph-bio-field field"><label for="p-bio">Bio</label>
          <input id="p-bio" maxlength="120" placeholder="Add a short bio — e.g. Lean-bulk szn · chasing the shelf" value="${esc(p.bio || "")}">
        </div>
        <div class="ph-bio-field field"><label for="p-privacy">Who can see your profile &amp; posts</label>
          <select id="p-privacy">
            <option value="public" ${(p.privacy || "public") === "public" ? "selected" : ""}>🌍 Public — anyone on Formora</option>
            <option value="friends" ${p.privacy === "friends" ? "selected" : ""}>👥 Friends only — just your crew</option>
          </select>
        </div>
        <div class="ph-socials">
          <div class="soc"><span class="soc-ic ig">📷</span><input id="soc-ig" aria-label="Instagram username" placeholder="Instagram username" value="${esc((p.socials && p.socials.instagram) || "")}"></div>
          <div class="soc"><span class="soc-ic li">in</span><input id="soc-li" aria-label="LinkedIn profile URL" placeholder="LinkedIn profile URL" value="${esc((p.socials && p.socials.linkedin) || "")}"></div>
          <div class="soc"><span class="soc-ic fb">f</span><input id="soc-fb" aria-label="Facebook profile URL" placeholder="Facebook profile URL" value="${esc((p.socials && p.socials.facebook) || "")}"></div>
        </div>
        <div class="ph-actions">
          <button class="btn" onclick="App.saveSocialProfile()">Save profile</button>
          <button class="btn ghost" onclick="App.goTab('feed')">Open Feed →</button>
          <button class="btn ghost" onclick="Social.inviteFriends()">Invite friends 🎁</button>
          <button class="btn ghost" onclick="Social.openSaved()">🔖 Saved</button>
        </div>
      </div>
      ${(() => {
        const isPro = typeof Entitlements !== "undefined" && Entitlements.isPro();
        if (typeof Entitlements !== "undefined" && (Entitlements.error || Entitlements.loading)) return "";
        if (!isPro) {
          return `<div class="card upgrade-card" onclick="App.openPricing()">
        <div class="uc-glow"></div>
        <div class="uc-badge">✨ Formora Pro</div>
        <div class="uc-title">Unlock training programs, Pro filters &amp; advanced analytics</div>
        <div class="uc-price">Compare current plans and checkout terms</div>
        <button class="btn wide uc-btn" onclick="event.stopPropagation();App.openPricing()">See plans →</button>
      </div>`;
        }
        const elite = Entitlements.isElite();
        const pe = (Entitlements._e && Entitlements._e.current_period_end) ? new Date(Entitlements._e.current_period_end) : null;
        const renew = pe && !isNaN(pe.getTime()) ? pe.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
        return `<div class="card member-card" data-tier="${elite ? "elite" : "pro"}">
        <div class="mc-row"><span class="tier-badge ${elite ? "tb-elite" : "tb-pro"}">${elite ? "★ Elite" : "◆ Pro"}</span><span class="mc-status">Active${renew ? " · access until " + esc(renew) : ""}</span></div>
        <div class="mc-title">You're a Formora ${elite ? "Elite" : "Pro"} member 🎉</div>
        <div class="mc-sub">${elite ? "Pro benefits, Elite filters, frames and a rules-based progress review." : "Training programs, Pro filters, meal plans and advanced analytics are yours."}</div>
        ${elite ? "" : `<button class="btn wide" onclick="App.upgradeToElite()">Upgrade to Elite →</button>`}
        <button class="btn ghost wide" style="margin-top:6px" onclick="App.openSupport()">Help &amp; support</button>
      </div>`;
      })()}
      ${myPosts.length ? `<div class="card"><div class="card-head"><h2>Your posts</h2><span class="tag">${myPosts.length}</span></div>${myPosts.map((x) => Social.postCard(cloudOn ? Social._cloudPost(x) : x)).join("")}</div>` : ""}
      <div class="card">
        <h2>Your fitness dashboard</h2>
        <div class="sub">Auto-calculated from your profile, workouts &amp; latest weight</div>
        <div class="stat-grid">
          <div class="stat"><div class="v">${Store.latestWeight()}<small>kg</small></div><div class="l">${p.targetWeightKg ? "Goal " + p.targetWeightKg + "kg" : "Current weight"}</div></div>
          <div class="stat"><div class="v">${s.bmi}</div><div class="l">BMI · ${s.bmiClass}</div></div>
          <div class="stat"><div class="v">${s.bodyFat}<small>%</small></div><div class="l">Body fat · ${Engine.bodyComp().bfClass}</div></div>
          <div class="stat"><div class="v">${Engine.streak()}</div><div class="l">Day streak 🔥</div></div>
          <div class="stat"><div class="v">${(Store.state.workoutLog || []).length}</div><div class="l">Workouts logged</div></div>
          <div class="stat"><div class="v">${s.proteinG}<small>g</small></div><div class="l">Protein / day</div></div>
          <div class="stat"><div class="v">${s.calTarget}</div><div class="l">Target kcal</div></div>
          <div class="stat"><div class="v">${s.bmr}</div><div class="l">BMR kcal</div></div>
          <div class="stat"><div class="v">${s.tdee}</div><div class="l">TDEE kcal</div></div>
        </div>
        <div class="comp-advice">${esc(Engine.bodyComp().advice)}</div>
      </div>
      <div class="card">
        <h2>Target physique</h2>
        <div class="sub">The look you're training for — your plan &amp; nutrition adapt to this</div>
        <div class="phys-current">
          <div class="phys-fig-mini">${this.physiqueFigure(Engine.getPhysique().fig)}</div>
          <div>
            <div class="phys-name">${Engine.getPhysique().name}</div>
            <div class="phys-tag">${Engine.getPhysique().tagline} · ${p.gender === "female" ? "Women" : "Men"}</div>
            <div class="phys-desc">${Engine.getPhysique().desc}</div>
          </div>
        </div>
        <button class="btn wide" style="margin-top:14px" onclick="App.openPhysiquePicker()">Change my target look</button>
      </div>
      <div class="card">
        <h2>Profile</h2>
        <div class="sub">Update anytime — targets recalculate instantly</div>
        <div class="form-grid">
          <div class="field"><label for="p-name">Name</label><input id="p-name" value="${esc(p.name)}"></div>
          <div class="field"><label for="p-dob">Date of birth</label><input id="p-dob" type="date" value="${p.dob}"></div>
          <div class="field"><label for="p-h">Height (cm)</label><input id="p-h" type="number" value="${p.heightCm}"></div>
          <div class="field"><label for="p-tw">Target weight (kg)</label><input id="p-tw" type="number" value="${p.targetWeightKg}"></div>
          <div class="field"><label for="p-gender">Gender</label>
            <select id="p-gender">
              <option value="male" ${p.gender === "male" ? "selected" : ""}>Male</option>
              <option value="female" ${p.gender === "female" ? "selected" : ""}>Female</option>
            </select>
          </div>
          <div class="field"><label for="p-diet">Diet <span class="inline-hint">(applies instantly)</span></label>
            <select id="p-diet" onchange="App.quickSetDiet(this.value)">
              ${Object.keys(DIETS).map((d) => `<option value="${d}" ${(p.diet || "nonveg") === d ? "selected" : ""}>${DIETS[d]}</option>`).join("")}
            </select>
          </div>
          <div class="field"><label for="p-act">Activity level</label>
            <select id="p-act">
              <option value="1.375" ${p.activityFactor == 1.375 ? "selected" : ""}>Light (1–2 days)</option>
              <option value="1.55" ${p.activityFactor == 1.55 ? "selected" : ""}>Moderate (3–5 days)</option>
              <option value="1.725" ${p.activityFactor == 1.725 ? "selected" : ""}>High (6–7 days)</option>
            </select>
          </div>
        </div>
        <button class="btn wide" style="margin-top:14px" onclick="App.saveProfile()">Save profile</button>
      </div>
      <div class="card">
        <h2>Backup &amp; move devices</h2>
        <div class="sub">Your data now syncs across devices automatically — just log in with the same account (Google works on any device). This download is an extra offline copy.</div>
        <button class="btn wide" onclick="App.exportData()">⬇️ Download my backup</button>
        <label class="photo-btn" style="margin-top:10px">📂 Restore from a backup file
          <input type="file" accept="application/json,.json" onchange="App.importFile(event)" hidden>
        </label>
      </div>
      <div class="card">
        <h2 class="danger">Reset</h2>
        <div class="sub">Erase all logs and start fresh. This cannot be undone.</div>
        <button class="btn ghost wide" onclick="App.resetAll()">Reset all data</button>
      </div>
      <div class="card about-card">
        <div class="about-brand"><svg viewBox="0 0 44 44" width="26" height="26" fill="none" aria-hidden="true"><defs><linearGradient id="alg" x1="4" y1="4" x2="40" y2="40" gradientUnits="userSpaceOnUse"><stop stop-color="#ff9d4d"/><stop offset=".55" stop-color="#ff5a4d"/><stop offset="1" stop-color="#ff3d7f"/></linearGradient></defs><rect x="2" y="2" width="40" height="40" rx="13" fill="url(#alg)"/><path d="M15.5 31.5V16.2c0-1.5 1.2-2.7 2.7-2.7H30" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/><path d="M15.5 22.4h10" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/><circle cx="29.6" cy="29.6" r="2.7" fill="#fff"/></svg><span>Formora</span></div>
        <div class="about-ver">Version ${window.APP_VERSION || "1.0.0"}</div>
        <div class="about-sub">Your aesthetic physique coach — train · track · connect.</div>
        <button class="btn ghost sm" style="margin:10px auto 2px" onclick="App.openSupport()">${this.ic("info", { size: 15 })} Help &amp; support</button>
        ${typeof Reports !== "undefined" && Reports.enabled() ? `<button class="btn ghost" onclick="Reports.open()">${this.ic("flag", { size: 16 })} Your reports</button>` : ""}
        ${window.ACCOUNT_RIGHTS ? `<button class="btn ghost" onclick="App.openAccountRights()">${this.ic("user", { size: 16 })} Account rights</button>` : ""}
        ${typeof Preferences !== "undefined" && Preferences.available() ? `<button class="btn ghost" onclick="Preferences.open()">${this.ic("cog", { size: 16 })} Privacy &amp; notifications</button>` : ""}
        ${this.renderCheckoutDiagnostics()}
        <div class="about-legal"><a href="legal.html#terms" target="_blank" rel="noopener">Terms</a> · <a href="legal.html#privacy" target="_blank" rel="noopener">Privacy</a> · <a href="legal.html#disclaimer" target="_blank" rel="noopener">Health disclaimer</a></div>
      </div>`;
    this._restoreProfileDraft();
    this._profileViewOwner = this._draftOwner();
  },
  async uploadCover(e) {
    const file = e.target.files && e.target.files[0]; if (!file) return false;
    const entry = this._entry, user = Auth.currentUser(), key = Store.key;
    const version = this._coverVersion = (this._coverVersion || 0) + 1;
    const cloudOn = typeof Cloud !== "undefined" && Cloud.active(), uid = cloudOn ? Cloud.me : null;
    const current = () => this._isCurrentEntry(entry, user) && Store.key === key && this._coverVersion === version &&
      (!cloudOn || (Cloud.active() && Cloud.me === uid &&
        (typeof SupaAuth === "undefined" || !SupaAuth.active() || SupaAuth.uid() === uid)));
    if (!user || (cloudOn && !uid) || !current()) return false;
    try {
      const data = await resizeImage(file, 900, 0.82);
      if (!current()) return false;
      if (cloudOn) {
        this._coverDraft = { entry, key, uid, version, data };
        try { localStorage.setItem("fm_cover_pending_" + uid, JSON.stringify({ data })); }
        catch (_) { this.toast("Cover draft could not be saved on this device. Keep this page open and retry sync."); }
      }
      else Store.state.profile.cover = data;
      Store.state.profile.coverPending = cloudOn;
      Store.save();
      if (this.curTab === "profile") this.renderProfile();
      if (!Store.state.profile.coverPending) return true;
      return await this.syncCover();
    } catch (_) {
      if (current()) this.toast("Could not read the cover image. Try another one.");
      return false;
    }
  },
  async syncCover() {
    if (typeof Cloud === "undefined" || !Cloud.active()) return false;
    const entry = this._entry, user = Auth.currentUser(), key = Store.key, uid = Cloud.me;
    const version = this._coverVersion;
    const owner = () => this._isCurrentEntry(entry, user) && Store.key === key && Cloud.active() && Cloud.me === uid &&
      (typeof SupaAuth === "undefined" || !SupaAuth.active() || SupaAuth.uid() === uid);
    if (!user || !uid || !owner()) return false;
    let draft = this._coverDraft;
    if (!draft || draft.entry !== entry || draft.key !== key || draft.uid !== uid || draft.version !== version) {
      let saved;
      try { saved = JSON.parse(localStorage.getItem("fm_cover_pending_" + uid)); } catch (_) {}
      const data = saved?.data || Store.state.profile.cover;
      if (typeof data !== "string" || !data.startsWith("data:image/jpeg;base64,")) {
        if (Store.state.profile.coverPending) this.toast("Choose the cover image again to retry.");
        return false;
      }
      draft = this._coverDraft = { entry, key, uid, version, data,
        url: typeof saved?.url === "string" && /^https?:\/\//.test(saved.url) ? saved.url : null };
    }
    const current = () => owner() && this._coverVersion === version && this._coverDraft === draft;
    if (this._coverSync) {
      if (this._coverSync.version === version) return false;
      await this._coverSync.done;
      return current() ? this.syncCover() : false;
    }
    let finish;
    const pending = this._coverSync = { version, done: new Promise(resolve => { finish = resolve; }) };
    if (this.curTab === "profile") this.renderProfile();
    try {
      if (!draft.url) {
        const bytes = Uint8Array.from(atob(draft.data.slice("data:image/jpeg;base64,".length)), character => character.charCodeAt(0));
        const blob = new Blob([bytes], { type: "image/jpeg" });
        if (!current()) return false;
        const url = await Cloud.uploadMedia(new File([blob], "cover.jpg", { type: "image/jpeg" }), "covers");
        if (!current()) return false;
        if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error("cover_upload_unavailable");
        draft.url = url;
        try { localStorage.setItem("fm_cover_pending_" + uid, JSON.stringify({ data: draft.data, url })); } catch (_) {}
      }
      if (!current()) return false;
      if (!await Cloud.registerMe({ ...Store.state.profile, coverUrl: draft.url })) throw new Error("cover_sync_unavailable");
      if (!current()) return false;
      Store.state.profile.cover = draft.url;
      Store.state.profile.coverUrl = draft.url;
      Store.state.profile.coverPending = false;
      Store.save();
      try { localStorage.removeItem("fm_cover_pending_" + uid); } catch (_) {}
      this._coverDraft = null;
      this.toast("Cover synced");
      return true;
    } catch (_) {
      if (current()) this.toast("Could not sync the cover publicly. Retry sync, or choose another image.");
      return false;
    } finally {
      if (this._coverSync === pending) this._coverSync = null;
      finish();
      if (!owner() && this._coverDraft === draft) this._coverDraft = null;
      if (owner() && this.curTab === "profile") this.renderProfile();
    }
  },
};