const Preferences = {
  generation: 0,
  _measurement: null,
  _push: null,
  _unmount: null,
  _panel: null,
  init() {
    if (window.SERVER_MEASUREMENT === true && typeof Measurement !== "undefined" && !this._measurement) {
      this._measurement = Measurement.create({ enabled: true, supabaseUrl: window.SUPABASE_URL,
        publishableKey: window.SUPABASE_ANON_KEY, permissions: window.MEASUREMENT_PERMISSIONS || {}, track: window.Track,
        userStore: localStorage,
        getSession: () => typeof SupaAuth !== "undefined" && SupaAuth.active() ? { owner: SupaAuth.uid(), jwt: SupaAuth.bearer(), generation: this.generation } : null });
    }
    if (typeof FormoraPush !== "undefined" && !this._push) this._push = FormoraPush.create({
      enabled: () => window.FORMORA_WEB_PUSH === true, onChange: () => this.renderPush() });
  },
  available() { return window.SERVER_MEASUREMENT === true || window.FORMORA_WEB_PUSH === true || !!this._push?.getState().canRevokeDevice; },
  async resume() {
    this.init();
    const generation = this.generation;
    if (window.SERVER_MEASUREMENT === true && this._measurement) {
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
    if (window.SERVER_MEASUREMENT === true) {
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