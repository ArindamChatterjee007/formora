const Preferences = {
  generation: 0,
  _measurement: null,
  _push: null,
  _unmount: null,
  _panel: null,
  _registrationPanel: null,
  _registrationNotice: Object.freeze({ version: "qat-registration-v1", text: "Optional QAT test measurement. Share this test account's registration and first completed workout dates. No external analytics delivery. Withdraw under Privacy & notifications. Test accounts only." }),
  registrationEnabled() {
    const stage = window.FORMORA_STAGE;
    return window.REGISTRATION_CONSENT === true && stage?.stage === "qat" && stage.mode === "isolated-backend"
      && stage.backendProjectRef === "wospznckvryiihfzwwtn" && stage.backendOrigin === window.SUPABASE_URL
      && window.SUPABASE_URL === "https://wospznckvryiihfzwwtn.supabase.co" && SupaAuth.active();
  },
  _measurementEnabled() { return window.SERVER_MEASUREMENT === true || this.registrationEnabled(); },
  async registrationHash(value) {
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  },
  async _registrationRequest(name, body) {
    if (!this.registrationEnabled() || SupaAuth.uid()) throw new Error("Registration measurement unavailable");
    const response = await SupaAuth._timedFetch(window.SUPABASE_URL + "/rest/v1/rpc/" + name, {
      method: "POST", credentials: "omit", cache: "no-store", redirect: "error",
      headers: SupaAuth._hdr({ Authorization: "Bearer " + window.SUPABASE_ANON_KEY }), body: JSON.stringify(body)
    }, true);
    if (!response.ok) throw new Error("Registration measurement unavailable");
    return response.body;
  },
  async renderRegistrationConsent() {
    this._registrationPanel = null;
    const node = document.getElementById("registration-consent");
    if (!node || !this.registrationEnabled() || SupaAuth.uid() || App.authView !== "details" || App.onboardMode !== "signup") return;
    const panel = this._registrationPanel = { node, draft: App.signupDraft };
    try {
      const policy = await this._registrationRequest("get_registration_consent_policy", {});
      const digest = await this.registrationHash(this._registrationNotice.text);
      if (this._registrationPanel !== panel || !node.isConnected || panel.draft !== App.signupDraft
        || policy?.enabled !== true || policy.stage !== "qat" || policy.version !== this._registrationNotice.version || policy.notice_sha256 !== digest) return;
      const label = document.createElement("label"), checkbox = document.createElement("input"), text = document.createElement("span");
      label.style.cssText = "display:flex;align-items:center;gap:10px;min-height:44px;font-size:13px;line-height:1.5;margin:12px 0";
      checkbox.type = "checkbox"; checkbox.id = "signup-measurement";
      checkbox.style.cssText = "width:20px;height:20px;flex:none;accent-color:var(--accent)";
      text.textContent = this._registrationNotice.text;
      panel.checkbox = checkbox; panel.choice = { version: policy.version, notice_sha256: digest };
      label.append(checkbox, text); node.replaceChildren(label);
    } catch (_) {}
  },
  registrationChoice() {
    const panel = this._registrationPanel;
    return this.registrationEnabled() && panel?.node.isConnected && panel.draft === App.signupDraft && panel.checkbox?.checked ? { ...panel.choice } : null;
  },
  async registrationMetadata(draft, check) {
    const meta = { name: draft.name }, choice = draft.registrationConsent;
    if (!this.registrationEnabled() || !choice || SupaAuth.uid()) return meta;
    try {
      const digest = await this.registrationHash(this._registrationNotice.text);
      check();
      if (choice.version !== this._registrationNotice.version || choice.notice_sha256 !== digest) return meta;
      const binding = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
      const identity = await this.registrationHash(binding + ":" + draft.email.trim().toLowerCase());
      check();
      const receipt = await this._registrationRequest("issue_registration_consent", {
        p_granted: true, p_version: choice.version, p_notice_sha256: digest, p_identity_hash: identity
      });
      check();
      if (receipt?.version === choice.version && receipt.notice_sha256 === digest && /^[a-f0-9]{64}$/.test(receipt.proof)
        && Number.isFinite(Date.parse(receipt.captured_at)) && Date.parse(receipt.expires_at) > Date.now()
        && Date.parse(receipt.expires_at) - Date.parse(receipt.captured_at) === 900000) {
        meta.registration_consent_proof = receipt.proof; meta.registration_consent_binding = binding;
      }
    } catch (_) { check(); }
    return meta;
  },
  init() {
    if (this._measurementEnabled() && typeof Measurement !== "undefined" && !this._measurement) {
      this._measurement = Measurement.create({ enabled: true, supabaseUrl: window.SUPABASE_URL,
        publishableKey: window.SUPABASE_ANON_KEY, permissions: this.registrationEnabled() ? {
          [this._registrationNotice.version]: { label: "QAT test measurement", description: this._registrationNotice.text,
            effectiveDate: "2026-09-09", reviewStatus: "pending", scopes: ["activation"] }
        } : window.MEASUREMENT_PERMISSIONS || {}, track: window.Track,
        userStore: localStorage,
        getSession: () => typeof SupaAuth !== "undefined" && SupaAuth.active() ? { owner: SupaAuth.uid(), jwt: SupaAuth.bearer(), generation: this.generation } : null });
    }
    if (typeof FormoraPush !== "undefined" && !this._push) this._push = FormoraPush.create({
      enabled: () => window.FORMORA_WEB_PUSH === true, onChange: () => this.renderPush() });
  },
  available() { return this._measurementEnabled() || window.FORMORA_WEB_PUSH === true || !!this._push?.getState().canRevokeDevice; },
  async resume() {
    this.init();
    const generation = this.generation;
    if (this._measurementEnabled() && this._measurement) {
      try { await SupaAuth.token(); if (generation === this.generation) await this._measurement.load(); } catch (_) {}
    }
    if (generation === this.generation && this._push) { try { await this._push.refresh(); } catch (_) {} }
  },
  reset() {
    this.generation++; this.close(); this._measurement?.reset();
    if (this._push) { try { Promise.resolve(this._push.suspendLocal()).catch(() => {}); } catch (_) {} }
  },
  beforeAccountChange() {
    if (this._push) { try { Promise.resolve(this._push.beforeAccountChange()).catch(() => {}); } catch (_) {} }
  },
  checkoutStarted(tier, rail, owner, generation) {
    if (window.SERVER_MEASUREMENT !== true || generation !== this.generation) return false;
    return this._measurement?.checkoutStarted({ tier, rail, owner, generation,
      source: rail === "upi" ? "razorpay_order_sdk_ready" : "authenticated_hosted_checkout" }) === true;
  },
  prepareWorkoutFinalization(workoutDate) {
    if (window.SERVER_MEASUREMENT !== true || !this._measurement) return null;
    const requestId = crypto.randomUUID();
    return this._measurement.scheduleWorkoutFinalization({ requestId, workoutDate }) ? requestId : null;
  },
  async accountSaved(acknowledgement) {
    if (window.SERVER_MEASUREMENT !== true || !this._measurement || acknowledgement.generation !== this.generation) return [];
    return this._measurement.flushWorkoutFinalizations(acknowledgement);
  },
  close() {
    this._unmount?.(); this._unmount = null; this._panel = null;
    const card = document.getElementById("modal-card");
    if (card?.querySelector("#privacy-options")) card.replaceChildren();
  },
  open() {
    if (!this.available() || !SupaAuth.uid()) return;
    this.init(); App.closeModal();
    const card = document.getElementById("modal-card");
    card.innerHTML = `<div class="modal-head"><h2>Privacy &amp; notifications</h2><button class="icon-btn" aria-label="Close" onclick="App.closeModal()">${App.ic("close")}</button></div><div id="privacy-options"><div id="measurement-options"></div><div id="push-options"></div></div>`;
    document.getElementById("modal").classList.remove("hidden");
    this._panel = { owner: SupaAuth.uid(), generation: this.generation, node: document.getElementById("privacy-options") };
    if (this._measurementEnabled()) {
      if (this._measurement) this._unmount = this._measurement.mountSettings(document.getElementById("measurement-options"));
      else document.getElementById("measurement-options").textContent = "Measurement settings unavailable.";
    }
    this.renderPush(); void this.resume();
    card.querySelector('button[aria-label="Close"]').focus();
  },
  renderPush() {
    const panel = this._panel;
    if (!panel || panel.owner !== SupaAuth.uid() || panel.generation !== this.generation || !panel.node.isConnected) return;
    const container = document.getElementById("push-options");
    if (!container) return;
    const state = this._push?.getState();
    container.replaceChildren();
    if (!state || (!window.FORMORA_WEB_PUSH && !state.canRevokeDevice && !state.canRetry)) return;
    const heading = document.createElement("h3"); heading.textContent = "Notifications";
    const message = document.createElement("p"); message.setAttribute("role", "status"); message.textContent = state.message;
    const commands = document.createElement("div"); commands.style.cssText = "display:flex;gap:8px;flex-wrap:wrap";
    const add = (label, icon, allowed, action) => {
      const button = document.createElement("button"); button.type = "button"; button.className = "btn ghost";
      button.innerHTML = App.ic(icon, { size: 16 }); button.append(document.createTextNode(label)); button.disabled = state.busy || !allowed;
      button.addEventListener("click", event => {
        if (panel.owner !== SupaAuth.uid() || panel.generation !== this.generation || !panel.node.isConnected) return;
        try { Promise.resolve(action(event)).catch(() => {}); } catch (_) {}
      });
      commands.append(button);
    };
    add("Enable notifications", "bell", state.canEnable, event => this._push.enableFromUserGesture(event));
    add("Turn off this browser", "close", state.canRevokeDevice, () => this._push.revokeDevice());
    add("Turn off all devices", "close", state.canRevokeAll, () => confirm("Turn off Formora notifications on all your devices?") ? this._push.revokeAll() : null);
    if (state.canRetry) add("Retry notification change", "undo", true, event => this._push.retryFromUserGesture(event));
    container.append(heading, message, commands);
  }
};