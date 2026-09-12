(function (root) {
  "use strict";

  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const versionPattern = /^[a-z0-9-]{1,64}$/;
  const attachedTracks = new WeakMap();
  let nextControl = 0;

  function create(options = {}) {
    if (options.track && (attachedTracks.has(options.track) || typeof options.track._measurementAllowed !== "function")) {
      throw new TypeError("One controller per compatible Track instance is required");
    }
    const enabled = options.enabled === true;
    const listeners = new Set();
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(10, Math.min(30000, options.timeoutMs)) : 8000;
    let base = null;
    try {
      const address = new URL(options.supabaseUrl);
      if (address.protocol === "https:" && !address.username && !address.password && !address.search
        && !address.hash && ["", "/"].includes(address.pathname)) base = address.origin;
    } catch (_) {}
    let bound = null, choice = null, phase = enabled ? "signed_out" : "disabled";
    let error = null, epoch = 0, pending = null, deniedLocally = false, denialAcknowledgement = "none";
    const finalizations = new Map();
    let finalizationBinding = null, finalizationPending = null;
    let disposed = false;
    const originalGate = options.track?._measurementAllowed;

    function syncTrack(allowed) {
      try { options.track?.setMeasurementConsent(allowed === true); } catch (_) {}
    }

    function session() {
      try {
        const value = options.getSession();
        if (!value || !uuid.test(value.owner) || !Number.isSafeInteger(value.generation) || value.generation < 0
          || typeof value.jwt !== "string" || value.jwt.length > 16384 || !base) return null;
        const pieces = value.jwt.split(".");
        if (pieces.length !== 3 || !pieces.every(piece => /^[A-Za-z0-9_-]+$/.test(piece))) return null;
        const payload = pieces[1].replace(/-/g, "+").replace(/_/g, "/");
        const claims = JSON.parse(root.atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")));
        const now = Date.now() / 1000;
        if (claims.sub !== value.owner || claims.role !== "authenticated"
          || !(claims.aud === "authenticated" || (Array.isArray(claims.aud) && claims.aud.includes("authenticated")))
          || claims.iss !== base + "/auth/v1" || !Number.isFinite(claims.exp) || claims.exp <= now
          || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now))) return null;
        return { owner: value.owner, jwt: value.jwt, generation: value.generation };
      } catch (_) { return null; }
    }

    function same(left, right) {
      return !!left && !!right && left.owner === right.owner && left.jwt === right.jwt && left.generation === right.generation;
    }

    function invalidate(next = null) {
      epoch++;
      pending?.cancel();
      pending = null;
      finalizationPending?.cancel();
      finalizationPending = null;
      finalizations.clear();
      finalizationBinding = null;
      if (!next || !bound || next.owner !== bound.owner || next.generation !== bound.generation) {
        deniedLocally = false;
        denialAcknowledgement = "none";
      }
      bound = next;
      choice = null;
      error = null;
      phase = !enabled || disposed ? "disabled" : next ? "idle" : "signed_out";
      syncTrack(false);
    }

    function reconcile() {
      const current = enabled && !disposed ? session() : null;
      if (!same(bound, current) && (bound || current)) invalidate(current);
      return current;
    }

    function permission() {
      const policy = choice && options.permissions && Object.hasOwn(options.permissions, choice.version)
        ? options.permissions[choice.version] : null;
      if (!policy || typeof policy.label !== "string" || !policy.label.trim()
        || typeof policy.description !== "string" || !policy.description.trim()
        || !/^\d{4}-\d{2}-\d{2}$/.test(policy.effectiveDate || "")
        || !Number.isFinite(Date.parse(policy.effectiveDate + "T00:00:00Z"))
        || new Date(policy.effectiveDate + "T00:00:00Z").toISOString().slice(0, 10) !== policy.effectiveDate) return null;
      return {
        label: policy.label, description: policy.description, effectiveDate: policy.effectiveDate,
        reviewStatus: policy.reviewStatus === "approved" ? "approved" : "pending",
        scopes: Array.isArray(policy.scopes) ? policy.scopes.filter(scope =>
          ["billing", "checkout_started", "membership_synced", "activation"].includes(scope)) : [],
        providedBy: "parent_configuration"
      };
    }

    function approvedPermission(policy) {
      return !!policy && policy.reviewStatus === "approved" && policy.scopes.includes("billing")
        && Date.parse(policy.effectiveDate + "T00:00:00Z") <= Date.now();
    }

    function measurementGate(owner) {
      const policy = permission();
      return enabled && !disposed && phase === "ready" && !deniedLocally && choice?.consent_state === "granted"
        && approvedPermission(policy) && policy.scopes.includes("checkout_started") && policy.scopes.includes("membership_synced")
        && owner === bound?.owner && same(bound, session()) && originalGate.call(this, owner);
    }

    function descriptor() {
      reconcile();
      const policy = permission();
      const configured = !!base && typeof options.publishableKey === "string" && !!options.publishableKey.trim()
        && !/[\r\n]/.test(options.publishableKey);
      const available = enabled && !disposed && configured && !!bound;
      const approved = approvedPermission(policy);
      const busy = phase === "loading" || phase === "saving";
      const granted = available && approved && phase === "ready" && choice?.consent_state === "granted" && !deniedLocally;
      return {
        enabled: enabled && !disposed, phase, consentState: choice?.consent_state || null, version: choice?.version || null,
        choiceVersion: choice?.choice_version || null, permission: policy,
        granted: !!granted, busy, error, denialAcknowledgement,
        checked: !!(choice?.granted && phase === "ready" && !deniedLocally),
        canGrant: !!(available && approved && phase === "ready" && !busy),
        canDecline: !!(available && !busy),
        needsExplicitChoice: !!(phase === "ready" && ["unset", "stale_version"].includes(choice?.consent_state))
      };
    }

    function notify() {
      const state = descriptor();
      for (const listener of listeners) { try { listener(state); } catch (_) {} }
      return state;
    }

    function validChoice(value) {
      if (!value || Array.isArray(value) || typeof value !== "object"
        || !Object.keys(value).every(key => ["granted", "version", "choice_version", "consent_state", "revision", "captured_at"].includes(key))
        || typeof value.version !== "string" || !versionPattern.test(value.version) || typeof value.granted !== "boolean") return false;
      if (value.consent_state === "unset") return value.granted === false && value.choice_version === null
        && value.revision === null && value.captured_at === null;
      if (!uuid.test(value.revision) || typeof value.choice_version !== "string" || !versionPattern.test(value.choice_version)
        || typeof value.captured_at !== "string" || !/(Z|[+-]\d{2}:\d{2})$/.test(value.captured_at)
        || !Number.isFinite(Date.parse(value.captured_at))) return false;
      if (value.choice_version !== value.version) return value.consent_state === "stale_version" && value.granted === false;
      return value.consent_state === (value.granted ? "granted" : "declined");
    }

    function failure(code) { const result = new Error(code); result.code = code; return result; }

    function request(name, body, snapshot, requestEpoch, operation, validate = validChoice) {
      const controller = new AbortController();
      let rejectBoundary;
      const boundary = new Promise((resolve, reject) => { rejectBoundary = reject; });
      operation.cancel = () => { controller.abort(); rejectBoundary(failure("account_changed")); };
      const timer = setTimeout(() => { controller.abort(); rejectBoundary(failure("timeout")); }, timeoutMs);
      const work = (async () => {
        const response = await (options.fetch || root.fetch.bind(root))(base + "/rest/v1/rpc/" + name, {
          method: "POST", credentials: "omit", cache: "no-store", redirect: "error",
          headers: { "Content-Type": "application/json", apikey: options.publishableKey, Authorization: "Bearer " + snapshot.jwt },
          body: JSON.stringify(body), signal: controller.signal
        });
        if (!response.ok) throw failure(response.status === 401 || response.status === 403 ? "unauthorized" : "unavailable");
        const reader = response.body?.getReader();
        if (!reader) throw failure("invalid_response");
        const cancelBody = () => { try { void reader.cancel().catch(() => {}); } catch (_) {} };
        controller.signal.addEventListener("abort", cancelBody, { once: true });
        let result, received = 0, text = "";
        try {
          if (controller.signal.aborted) throw failure("invalid_response");
          const decoder = new TextDecoder("utf-8", { fatal: true });
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            received += chunk.value.byteLength;
            if (received > 8192) throw failure("invalid_response");
            text += decoder.decode(chunk.value, { stream: true });
          }
          result = JSON.parse(text + decoder.decode());
        } catch (_) {
          cancelBody();
          throw failure("invalid_response");
        } finally {
          controller.signal.removeEventListener("abort", cancelBody);
          reader.releaseLock();
        }
        if (epoch !== requestEpoch || !same(snapshot, session())) throw failure("account_changed");
        if (!validate(result)) throw failure("invalid_response");
        return result;
      })();
      return Promise.race([work, boundary]).finally(() => clearTimeout(timer));
    }

    function execute(granted) {
      reconcile();
      const state = descriptor();
      const saving = typeof granted === "boolean";
      if (saving && !granted) {
        deniedLocally = true;
        denialAcknowledgement = "unconfirmed";
        syncTrack(false);
        clearFinalizations();
      }
      if (pending) { notify(); return pending.promise; }
      if (!bound || !enabled || (saving ? (granted ? !state.canGrant : !state.canDecline)
        : !base || !options.publishableKey || /[\r\n]/.test(options.publishableKey))) return Promise.resolve(notify());
      finalizationPending?.cancel();
      if (saving && granted) { deniedLocally = false; denialAcknowledgement = "none"; }
      const snapshot = bound, requestEpoch = ++epoch;
      phase = saving ? "saving" : "loading";
      error = null;
      if (saving && !granted) denialAcknowledgement = "pending";
      syncTrack(false);
      const operation = { cancel() {}, promise: null };
      pending = operation;
      operation.promise = request(saving ? "set_billing_analytics_consent" : "get_billing_analytics_consent",
        saving ? { p_granted: granted, p_version: choice?.version || "" } : {}, snapshot, requestEpoch, operation)
        .then(result => {
          if (epoch !== requestEpoch || !same(snapshot, session())) return;
          if (saving && (result.granted !== granted || result.consent_state !== (granted ? "granted" : "declined"))) {
            throw failure("choice_not_acknowledged");
          }
          choice = result;
          phase = "ready";
          if ((saving && !granted) || (deniedLocally && result.consent_state === "declined")) {
            denialAcknowledgement = "confirmed";
          }
          const current = descriptor();
          syncTrack(current.granted && current.permission.scopes.includes("checkout_started")
            && current.permission.scopes.includes("membership_synced"));
          if (current.granted && current.permission.scopes.includes("activation")) restoreFinalizations();
          else clearFinalizations();
        })
        .catch(problem => {
          if (epoch !== requestEpoch) return;
          phase = "error";
          error = ["timeout", "unauthorized", "account_changed", "invalid_response", "choice_not_acknowledged"].includes(problem.code)
            ? problem.code : "unavailable";
          if (saving && !granted) denialAcknowledgement = "unconfirmed";
          syncTrack(false);
        })
        .finally(() => { if (pending === operation) pending = null; });
      operation.promise = operation.promise.then(() => notify());
      notify();
      return operation.promise;
    }

    function load() { return execute(undefined); }
    function setConsent(granted) {
      return typeof granted === "boolean" ? execute(granted) : Promise.resolve(descriptor());
    }

    function reset() {
      deniedLocally = false;
      denialAcknowledgement = "none";
      invalidate();
      return notify();
    }

    function dispose() {
      disposed = true;
      reset();
      listeners.clear();
      if (options.track && attachedTracks.get(options.track) === measurementGate) {
        if (options.track._measurementAllowed === measurementGate) options.track._measurementAllowed = originalGate;
        attachedTracks.delete(options.track);
      }
    }

    function checkoutStarted(attestation) {
      const state = descriptor();
      if (!state.granted || !state.permission.scopes.includes("checkout_started")
        || !state.permission.scopes.includes("membership_synced") || !attestation
        || attestation.owner !== bound?.owner || attestation.generation !== bound?.generation
        || !["pro", "elite"].includes(attestation.tier) || !["upi", "card"].includes(attestation.rail)
        || attestation.source !== (attestation.rail === "upi" ? "razorpay_order_sdk_ready" : "authenticated_hosted_checkout")
        || typeof options.track?.event !== "function") return false;
      syncTrack(true);
      try {
        options.track.event("checkout_started", { tier: attestation.tier, rail: attestation.rail });
        return true;
      } catch (_) { return false; }
    }

    function activationAllowed() {
      const state = descriptor();
      return state.granted && state.permission.scopes.includes("activation");
    }

    function finalizationKey() { return bound ? "fm_activation_pending_" + bound.owner : null; }

    function clearFinalizations() {
      finalizationPending?.cancel();
      finalizations.clear();
      finalizationBinding = null;
      const key = finalizationKey();
      if (key) { try { options.userStore?.removeItem(key); } catch (_) {} }
    }

    function persistFinalizations() {
      if (!finalizationBinding || !same(finalizationBinding.session, bound)) return;
      try {
        options.userStore?.setItem(finalizationKey(), JSON.stringify({
          format: 1, version: finalizationBinding.version, revision: finalizationBinding.revision,
          requests: [...finalizations.values()].map(entry => ({
            requestId: entry.requestId, attempts: entry.attempts, terminal: entry.terminal
          }))
        }));
      } catch (_) {}
    }

    function restoreFinalizations() {
      if (finalizationBinding && same(finalizationBinding.session, bound)
        && finalizationBinding.version === choice.version && finalizationBinding.revision === choice.revision) return;
      finalizations.clear();
      finalizationBinding = { session: bound, version: choice.version, revision: choice.revision };
      try {
        const raw = options.userStore?.getItem(finalizationKey());
        if (!raw) return;
        if (typeof raw !== "string" || raw.length > 4096) throw failure("invalid_queue");
        const saved = JSON.parse(raw);
        if (!saved || Object.keys(saved).sort().join() !== "format,requests,revision,version" || saved.format !== 1
          || saved.version !== choice.version || saved.revision !== choice.revision
          || !Array.isArray(saved.requests) || saved.requests.length > 8) throw failure("invalid_queue");
        for (const entry of saved.requests) {
          if (!entry || Object.keys(entry).sort().join() !== "attempts,requestId,terminal"
            || typeof entry.requestId !== "string" || !uuid.test(entry.requestId) || finalizations.has(entry.requestId)
            || !Number.isInteger(entry.attempts) || entry.attempts < 0 || entry.attempts > 3
            || typeof entry.terminal !== "boolean") throw failure("invalid_queue");
          finalizations.set(entry.requestId, { ...entry, workoutDate: null });
        }
      } catch (_) {
        finalizations.clear();
        try { options.userStore?.removeItem(finalizationKey()); } catch (_) {}
      }
    }

    function workoutDateValid(value) {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const timestamp = Date.parse(value + "T00:00:00Z");
      return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
    }

    function recentWorkoutDate(value) {
      if (!workoutDateValid(value)) return false;
      const day = new Date().toISOString().slice(0, 10);
      return Math.abs(Date.parse(value + "T00:00:00Z") - Date.parse(day + "T00:00:00Z")) <= 86400000;
    }

    function scheduleWorkoutFinalization(payload) {
      if (!activationAllowed() || !payload || typeof payload.requestId !== "string"
        || !uuid.test(payload.requestId) || !recentWorkoutDate(payload.workoutDate)) return false;
      restoreFinalizations();
      const existing = finalizations.get(payload.requestId);
      if (existing) return !existing.terminal && existing.attempts < 3
        && (!existing.workoutDate || existing.workoutDate === payload.workoutDate);
      if (finalizations.size >= 8) {
        for (const entry of finalizations.values()) {
          if (!entry.terminal || finalizationPending?.requestId === entry.requestId) continue;
          finalizations.delete(entry.requestId);
          break;
        }
      }
      if (finalizations.size >= 8) return false;
      finalizations.set(payload.requestId, { requestId: payload.requestId, workoutDate: payload.workoutDate,
        attempts: 0, terminal: false });
      persistFinalizations();
      return true;
    }

    function finalizationResult(requestId, status, queued = false) {
      return { request_id: typeof requestId === "string" && uuid.test(requestId) ? requestId : null,
        confirmed: false, status, recorded_at: null, queued };
    }

    function acknowledgedAccount(value) {
      return !!value && value.acknowledged === true && value.owner === bound?.owner
        && value.generation === bound?.generation && same(bound, session());
    }

    function validFinalization(value, requestId) {
      if (!value || Object.keys(value).sort().join() !== "confirmed,recorded_at,request_id,status"
        || value.request_id !== requestId || typeof value.confirmed !== "boolean") return false;
      if (value.confirmed) return value.status === "recorded" && typeof value.recorded_at === "string"
        && /(Z|[+-]\d{2}:\d{2})$/.test(value.recorded_at) && Number.isFinite(Date.parse(value.recorded_at))
        && Date.parse(value.recorded_at) <= Date.now() + 60000;
      return value.recorded_at === null && ["disabled", "consent_required", "not_enrolled", "already_recorded",
        "request_conflict", "incomplete_history", "not_candidate", "date_out_of_range", "not_ready"].includes(value.status);
    }

    function recordWorkoutFinalization(payload = {}, acknowledgement) {
      const requestId = payload?.requestId, workoutDate = payload?.workoutDate;
      if (!activationAllowed()) return Promise.resolve(finalizationResult(requestId, "not_permitted"));
      if (!acknowledgedAccount(acknowledgement)) return Promise.resolve(finalizationResult(requestId, "account_not_acknowledged"));
      if (typeof requestId !== "string" || !uuid.test(requestId) || !workoutDateValid(workoutDate)) {
        return Promise.resolve(finalizationResult(requestId, "invalid_request"));
      }
      restoreFinalizations();
      const entry = finalizations.get(requestId);
      if (!entry) return Promise.resolve(finalizationResult(requestId, "not_scheduled"));
      if (entry.workoutDate && entry.workoutDate !== workoutDate) return Promise.resolve(finalizationResult(requestId, "request_conflict"));
      if (entry.terminal) return Promise.resolve(entry.receipt || finalizationResult(requestId, "stopped"));
      if (entry.attempts >= 3) return Promise.resolve(finalizationResult(requestId, "retry_limit"));
      if (!recentWorkoutDate(workoutDate)) {
        entry.terminal = true;
        persistFinalizations();
        return Promise.resolve(finalizationResult(requestId, "date_out_of_range"));
      }
      if (finalizationPending) return finalizationPending.requestId === requestId ? finalizationPending.promise
        : Promise.resolve(finalizationResult(requestId, "busy", true));
      entry.workoutDate = workoutDate;
      entry.attempts++;
      persistFinalizations();
      const snapshot = bound, requestEpoch = epoch;
      const operation = { requestId, cancel() {}, promise: null };
      finalizationPending = operation;
      operation.promise = request("record_workout_finalization", { p_request_id: requestId, p_workout_date: workoutDate,
        p_consent_version: choice.version, p_consent_revision: choice.revision }, snapshot, requestEpoch, operation,
      result => validFinalization(result, requestId))
        .then(result => {
          if (epoch !== requestEpoch || !same(snapshot, session()) || !activationAllowed()) {
            return finalizationResult(requestId, "account_changed");
          }
          entry.terminal = result.status !== "not_ready";
          const receipt = { ...result, queued: !entry.terminal && entry.attempts < 3 };
          if (entry.terminal) entry.receipt = receipt;
          persistFinalizations();
          return receipt;
        })
        .catch(problem => {
          if (epoch !== requestEpoch || !same(snapshot, session()) || !activationAllowed()) {
            return finalizationResult(requestId, "account_changed");
          }
          const status = ["timeout", "unauthorized", "invalid_response"].includes(problem.code) ? problem.code : "unavailable";
          return finalizationResult(requestId, status, entry.attempts < 3);
        })
        .finally(() => { if (finalizationPending === operation) finalizationPending = null; });
      return operation.promise;
    }

    async function flushWorkoutFinalizations(acknowledgement) {
      if (!activationAllowed() || !acknowledgedAccount(acknowledgement)) return [];
      const saved = acknowledgement.snapshot;
      if (!saved || saved.draftSession !== null || !Array.isArray(saved.workoutLog) || !Array.isArray(saved.restDays)) return [];
      restoreFinalizations();
      const present = new Set(saved.workoutLog.map(logged => logged?.finalizationRequestId));
      let pruned = false;
      for (const entry of finalizations.values()) {
        if (present.has(entry.requestId) || finalizationPending?.requestId === entry.requestId) continue;
        finalizations.delete(entry.requestId);
        pruned = true;
      }
      if (pruned) persistFinalizations();
      const results = [];
      for (const entry of [...finalizations.values()]) {
        if (entry.terminal || entry.attempts >= 3) continue;
        const matches = saved.workoutLog.filter(logged => logged?.finalizationRequestId === entry.requestId);
        if (matches.length !== 1 || saved.restDays.includes(matches[0].date)) continue;
        results.push(await recordWorkoutFinalization({ requestId: entry.requestId, workoutDate: matches[0].date }, acknowledgement));
        if (!acknowledgedAccount(acknowledgement)) break;
      }
      return results;
    }

    function subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("Listener required");
      listeners.add(listener);
      listener(descriptor());
      return () => listeners.delete(listener);
    }

    function mountSettings(container) {
      const document = container.ownerDocument;
      const wrapper = document.createElement("div"), label = document.createElement("label");
      const checkbox = document.createElement("input"), title = document.createElement("span");
      const description = document.createElement("p"), status = document.createElement("p"), retry = document.createElement("button");
      const controlId = "measurement-choice-" + (++nextControl);
      checkbox.type = "checkbox";
      checkbox.id = controlId;
      checkbox.setAttribute("aria-describedby", controlId + "-description");
      label.htmlFor = controlId;
      label.style.cssText = "display:flex;align-items:center;gap:10px;min-height:44px;overflow-wrap:anywhere";
      checkbox.style.cssText = "width:20px;height:20px;flex:none;accent-color:var(--accent)";
      description.id = controlId + "-description";
      description.style.overflowWrap = "anywhere";
      description.className = "sub";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      retry.type = "button";
      retry.className = "btn ghost";
      label.append(checkbox, title);
      wrapper.append(label, description, status, retry);
      container.append(wrapper);
      const unsubscribe = subscribe(state => {
        title.textContent = state.permission?.label || "Optional measurement";
        description.textContent = state.permission ? state.permission.description + " Effective " + state.permission.effectiveDate + "."
          : "Permission details unavailable.";
        checkbox.checked = state.checked;
        checkbox.disabled = state.busy || !(state.checked ? state.canDecline : state.canGrant);
        wrapper.setAttribute("aria-busy", String(state.busy));
        status.textContent = state.busy ? (state.phase === "saving" ? "Saving choice..." : "Loading choice...")
          : state.denialAcknowledgement === "unconfirmed" ? "Off here. Server withdrawal is not confirmed."
          : state.error ? "Measurement is off here. Your server choice could not be confirmed."
          : !state.enabled ? "Measurement is disabled."
          : state.phase === "signed_out" ? "Sign in to view your choice."
          : !state.permission || state.permission.reviewStatus !== "approved" ? "Permission review pending."
          : state.consentState === "stale_version" ? "The permission version has changed. Measurement is off."
          : state.consentState === "declined" ? "Choice saved: off."
          : state.granted ? "Choice saved: on."
          : "Measurement is off.";
        retry.hidden = state.busy || (!state.error && state.denialAcknowledgement !== "unconfirmed" && state.phase !== "idle");
        retry.disabled = !state.enabled || state.phase === "signed_out";
        retry.textContent = state.denialAcknowledgement === "unconfirmed" ? "Retry withdrawal" : "Reload choice";
      });
      checkbox.addEventListener("change", () => { void setConsent(checkbox.checked); });
      retry.addEventListener("click", () => { void (deniedLocally ? setConsent(false) : load()); });
      return () => { unsubscribe(); wrapper.remove(); };
    }

    if (options.track) {
      options.track._measurementAllowed = measurementGate;
      attachedTracks.set(options.track, measurementGate);
    }
    syncTrack(false);
    return Object.freeze({ load, setConsent, descriptor, checkoutStarted, scheduleWorkoutFinalization,
      recordWorkoutFinalization, flushWorkoutFinalizations, reset, dispose, subscribe, mountSettings });
  }

  root.Measurement = Object.freeze({ create });
})(typeof window === "undefined" ? globalThis : window);