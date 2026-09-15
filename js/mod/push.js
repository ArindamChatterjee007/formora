(function (root) {
  "use strict";

  const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  const HASH = /^[a-f0-9]{64}$/;
  const ENDPOINT = /^https:\/\/(?:fcm\.googleapis\.com\/(?:fcm\/send|wp)\/[A-Za-z0-9_:-]{16,1800}|updates\.push\.services\.mozilla\.com\/wpush\/v2\/[A-Za-z0-9_-]{16,1800}|web\.push\.apple\.com\/[A-Za-z0-9_-]{16,1800})$/;
  const MESSAGES = Object.freeze({
    disabled: "Push notifications are off.", unsupported: "Web Push is unavailable in this browser.",
    native_unsupported: "Native push is not included.", unprepared: "Check notification availability.",
    ready: "Notifications are off on this browser.", registered: "This browser is registered for generic Formora updates. Delivery is not connected.",
    permission_denied: "Notifications are blocked in browser settings.", permission_dismissed: "Notifications were not enabled.",
    explicit_command_required: "Use the Enable notifications control.", refresh_required: "Refresh notification status before enabling.",
    sign_in_required: "Sign in to manage notifications.", account_changed: "The account changed. Notifications were not enabled.",
    previous_account_required: "Sign in to the previous account to finish server removal. This browser cannot be rebound yet.",
    local_state_invalid: "Notification recovery data is unavailable. Local cleanup and previous-account revocation are required.",
    unmanaged_subscription: "An existing browser subscription must be removed before enabling notifications.",
    configuration_required: "Push registration is not configured.", configuration_changed: "Push configuration changed. Revoke this browser before enabling again.",
    worker_conflict: "Another worker occupies the push scope. No worker was replaced.", worker_unavailable: "Local notification setup is unavailable.",
    local_storage_unavailable: "Notification recovery data could not be saved. No success was recorded.",
    invalid_subscription: "This browser returned an unsupported push subscription.", invalid_response: "The server acknowledgement could not be verified.",
    server_disabled: "Push registration is disabled on the server.", conflict: "Notification state changed. Retry removal or refresh status.",
    quota: "The notification device or request limit was reached. Removal is still available.",
    timeout: "Notification confirmation timed out. Retry to confirm the result.", network: "Notification confirmation is unavailable. Retry to confirm the result.",
    request_rejected: "The notification request was rejected.", busy: "A notification operation is still running.",
    revocation_pending: "Server removal is not confirmed. Notifications are muted locally where possible.",
    local_cleanup_pending: "Server removal is confirmed. Browser cleanup still needs a retry.",
    off: "Notifications are off on this browser.", local_only: "Local cleanup completed. Server removal is not confirmed.",
    not_subscribed: "Notifications were not enabled on this browser."
  });

  function failure(code) { return Object.assign(new Error(MESSAGES[code] || MESSAGES.network), { code }); }
  function keyBytes(value, length) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 90) throw failure("invalid_subscription");
    let binary;
    try { binary = root.atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4)); }
    catch (_) { throw failure("invalid_subscription"); }
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    if (bytes.length !== length || (length === 65 && bytes[0] !== 4)
      || root.btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_") !== value) throw failure("invalid_subscription");
    return bytes;
  }
  function withTimeout(promise, milliseconds, code = "timeout", abort) {
    let timer;
    return Promise.race([Promise.resolve(promise), new Promise((resolve, reject) => {
      timer = setTimeout(() => { abort?.(); reject(failure(code)); }, milliseconds);
    })]).finally(() => clearTimeout(timer));
  }

  function create(options = {}) {
    const base = new URL(options.appBaseURL || "./", root.location.href);
    if (base.origin !== root.location.origin || base.username || base.password || base.search || base.hash || !base.pathname.endsWith("/")
      || /[%\\]/.test(base.pathname)) throw failure("configuration_required");
    const workerURL = new URL("push-worker.js", base).href;
    const scope = new URL("__push__/", base).href;
    const storageKey = "formora_push_v1:" + scope;
    const lockName = "formora-push:" + scope;
    const timeout = Math.min(15000, Math.max(25, Number(options.timeoutMs) || 8000));
    const permissionTimeout = Math.min(120000, Math.max(25, Number(options.permissionTimeoutMs) || 60000));
    const accountDeadline = Math.min(20000, Math.max(50, Number(options.accountChangeDeadlineMs) || Math.max(250, timeout * 2)));
    const localReserve = Math.min(accountDeadline, timeout);
    const enabled = () => typeof options.enabled === "function" ? options.enabled() === true
      : options.enabled === undefined ? root.FORMORA_WEB_PUSH === true : options.enabled === true;
    const publicKey = () => typeof options.vapidPublicKey === "function" ? options.vapidPublicKey()
      : options.vapidPublicKey || root.FORMORA_PUSH_VAPID_PUBLIC_KEY || "";
    const auth = () => options.auth || (typeof SupaAuth !== "undefined" ? SupaAuth : null);
    let journal = null, prepared = null, busy = false, generation = 0, disposed = false;
    let status = enabled() ? "unprepared" : "disabled";
    let serverAcknowledged = false, localCleanup = null, pendingBrowserOperation = false, delivery = "unknown";
    let deadlineAt = 0, totalDeadlineAt = 0;

    // Every internal wait also respects the active phase and whole-call deadlines, so chained steps,
    // nested phases and post-failure compensation cannot add up beyond the whole-call budget.
    function bounded(promise, milliseconds, code = "timeout", abort) {
      let limit = milliseconds;
      for (const at of [deadlineAt, totalDeadlineAt]) if (at) limit = Math.min(limit, at - Date.now());
      return withTimeout(promise, Math.max(1, limit), code, abort);
    }
    async function withDeadline(milliseconds, work) {
      const previous = deadlineAt;
      deadlineAt = Date.now() + milliseconds;
      try { return await work(); } finally { deadlineAt = previous; }
    }
    async function withTotalDeadline(milliseconds, work) {
      const previous = totalDeadlineAt;
      totalDeadlineAt = Math.min(Date.now() + milliseconds, previous || Infinity);
      try { return await work(); } finally { totalDeadlineAt = previous; }
    }

    function owner() {
      try { const provider = auth(); const value = provider?.active() ? provider.uid() : ""; return UUID.test(value) ? value : ""; }
      catch (_) { return ""; }
    }
    function capability() {
      if (root.Capacitor && (typeof root.Capacitor.isNativePlatform !== "function" || root.Capacitor.isNativePlatform())) return "native_unsupported";
      return root.isSecureContext === true && ["https:", "http:"].includes(base.protocol)
        && root.Notification && typeof root.Notification.requestPermission === "function" && root.PushManager
        && root.navigator?.serviceWorker?.register && root.navigator.serviceWorker.getRegistrations
        && root.navigator.locks?.request && root.crypto?.subtle && root.crypto.randomUUID
        && root.indexedDB?.open && root.MessageChannel ? "" : "unsupported";
    }
    function pendingOperation() {
      if (!journal?.owner_id || journal.phase === "idle" || journal.phase === "registered") return null;
      if (journal.phase === "register_pending") return "register";
      return journal.last_action === "revoke_all" || journal.intent?.operation === "revoke_all" ? "revoke_all" : "revoke_device";
    }
    function getState() {
      const current = owner();
      const mismatch = !!journal?.owner_id && journal.owner_id !== current;
      const reason = capability();
      const currentStatus = mismatch ? "previous_account_required" : status;
      return Object.freeze({ status: currentStatus, message: MESSAGES[currentStatus] || MESSAGES.network,
        supported: !reason, capabilityReason: reason || null, permission: root.Notification?.permission || "unavailable",
        defaultOff: true, delivery, busy, registered: currentStatus === "registered",
        serverAcknowledged, localCleanup, localDeliveryStopped: localCleanup === true, requiresPreviousAccount: mismatch,
        pendingOperation: pendingOperation(),
        canEnable: !busy && !mismatch && enabled() && !reason && status === "ready" && !!prepared,
        canRevokeDevice: !busy && !mismatch && !reason && !!current && !!journal?.owner_id,
        canRevokeAll: !busy && !mismatch && !reason && !!current,
        canRetry: !busy && !mismatch && !reason && !!current && !!journal && journal.phase !== "idle" && journal.phase !== "registered" });
    }
    function publish(code) {
      status = code;
      const state = getState();
      try { options.onChange?.(state); } catch (_) {}
      return state;
    }
    function result(ok, code = status) { return { ok, code, serverAcknowledged, localCleanup,
      localDeliveryStopped: localCleanup === true, state: getState() }; }
    function readJournal() {
      let raw;
      try { raw = root.localStorage.getItem(storageKey); } catch (_) { throw failure("local_storage_unavailable"); }
      if (!raw) { journal = null; return null; }
      try {
        const value = JSON.parse(raw);
        if (raw.length > 4096 || value.v !== 1 || !UUID.test(value.device_id)
          || (value.owner_id !== null && !UUID.test(value.owner_id))
          || !["idle", "register_pending", "registered", "revocation_pending", "local_cleanup_pending"].includes(value.phase)
          || (value.pending && (!UUID.test(value.pending.request_id) || !Number.isInteger(value.pending.revision)
            || value.pending.revision < 0 || !["register", "revoke_device", "revoke_all"].includes(value.pending.operation)))
          || (value.intent && (!UUID.test(value.intent.request_id)
            || !["revoke_device", "revoke_all"].includes(value.intent.operation)))
          || (value.fingerprint && !HASH.test(value.fingerprint))
          || (value.phase === "idle" && (value.owner_id !== null || value.pending || value.intent))
          || (value.phase !== "idle" && !UUID.test(value.owner_id))
          || (value.phase === "registered" && (!HASH.test(value.fingerprint) || !UUID.test(value.binding_id)
            || !Number.isFinite(Date.parse(value.expires_at)) || value.pending))
          || (value.phase === "register_pending" && value.pending?.operation !== "register")) throw new Error();
        journal = value;
        return value;
      } catch (_) { throw failure("local_state_invalid"); }
    }
    function save(value) {
      try {
        const serialized = JSON.stringify(value);
        if (serialized.length > 4096) throw new Error();
        root.localStorage.setItem(storageKey, serialized);
        if (root.localStorage.getItem(storageKey) !== serialized) throw new Error();
        journal = value;
      } catch (_) { throw failure("local_storage_unavailable"); }
    }
    function initialJournal() { return { v: 1, device_id: root.crypto.randomUUID(), owner_id: null, phase: "idle", pending: null }; }
    function check(ticket) {
      if (disposed || ticket.generation !== generation || ticket.owner !== owner()) throw failure("account_changed");
    }
    function boundOwner(ticket) {
      check(ticket);
      if (journal?.owner_id && journal.owner_id !== ticket.owner) throw failure("previous_account_required");
    }
    async function jsonRequest(url, token, body) {
      const controller = new root.AbortController();
      const request = (async () => {
        const response = await root.fetch(url, { method: body === undefined ? "GET" : "POST",
          headers: { apikey: root.SUPABASE_ANON_KEY, Authorization: "Bearer " + token, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
          cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
        if (!response.ok) {
          try { await response.body?.cancel(); } catch (_) {}
          throw failure(({ 401: "sign_in_required", 403: "server_disabled", 409: "conflict", 429: "quota" })[response.status] || "request_rejected");
        }
        if (!response.body?.getReader) throw failure("invalid_response");
        const reader = response.body.getReader();
        const decoder = new root.TextDecoder();
        let text = "", bytes = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 16384) { controller.abort(); throw failure("invalid_response"); }
            text += decoder.decode(chunk.value, { stream: true });
          }
          return JSON.parse(text + decoder.decode());
        } catch (error) { if (error.code) throw error; throw failure("invalid_response"); }
        finally { reader.releaseLock(); }
      })();
      try { return await bounded(request, timeout, "timeout", () => controller.abort()); }
      catch (error) { if (error.code && MESSAGES[error.code]) throw error; throw failure("network"); }
    }
    function serverURL() {
      try {
        const url = new URL(root.SUPABASE_URL);
        if (url.protocol !== "https:" || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname)
          || url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/"
          || typeof root.SUPABASE_ANON_KEY !== "string" || !root.SUPABASE_ANON_KEY) throw new Error();
        return url.origin;
      } catch (_) { throw failure("configuration_required"); }
    }
    async function credentials(ticket) {
      boundOwner(ticket);
      if (!ticket.owner) throw failure("sign_in_required");
      const url = serverURL();
      const token = await bounded(auth().token(), timeout);
      check(ticket);
      if (typeof token !== "string" || token.length < 20 || token === root.SUPABASE_ANON_KEY) throw failure("sign_in_required");
      const verified = await jsonRequest(url + "/auth/v1/user", token);
      check(ticket);
      if (verified?.id !== ticket.owner) throw failure("sign_in_required");
      return { url, token };
    }
    async function rpc(ticket, credential, name, body) {
      check(ticket);
      const response = await jsonRequest(credential.url + "/rest/v1/rpc/" + name, credential.token, body);
      check(ticket);
      if (!response || response.owner_id !== ticket.owner || !Number.isInteger(response.revision) || response.revision < 0) throw failure("invalid_response");
      return response;
    }
    async function serverState(ticket, credential) {
      const response = await rpc(ticket, credential, "get_push_subscription_state", { p_device_id: journal.device_id });
      if (typeof response.device_registered !== "boolean" || typeof response.registration_enabled !== "boolean"
        || response.delivery_implemented !== true || typeof response.delivery_enabled !== "boolean"
        || !Number.isInteger(response.registered_devices)
        || response.registered_devices < 0 || response.registered_devices > 5
        || (response.device_registered && (!UUID.test(response.binding_id) || !HASH.test(response.fingerprint)
          || !Number.isFinite(Date.parse(response.expires_at))))) throw failure("invalid_response");
      delivery = response.delivery_enabled ? "enabled_provider_unverified" : "implemented_disabled";
      return response;
    }
    async function configuration(server) {
      if (!enabled()) throw failure("disabled");
      if (!server.registration_enabled) throw failure("server_disabled");
      if (server.consent_version !== "push-generic-v1" || server.vapid_public_key !== publicKey()) throw failure("configuration_changed");
      let bytes;
      try {
        bytes = keyBytes(publicKey(), 65);
        await root.crypto.subtle.importKey("raw", bytes, { name: "ECDH", namedCurve: "P-256" }, false, []);
      } catch (_) { throw failure("configuration_required"); }
      return bytes;
    }
    async function registration(createNew = false) {
      const registrations = await bounded(root.navigator.serviceWorker.getRegistrations(), timeout, "worker_unavailable");
      let found = registrations.find(candidate => candidate.scope === scope);
      if (found && [found.active, found.waiting, found.installing].some(worker => worker && worker.scriptURL !== workerURL)) throw failure("worker_conflict");
      if (!found && createNew) found = await bounded(root.navigator.serviceWorker.register(workerURL, { scope, updateViaCache: "none" }), timeout, "worker_unavailable");
      if (!found) return null;
      if (found.scope !== scope) throw failure("worker_conflict");
      if (found.active?.state !== "activated") {
        const worker = found.installing || found.waiting || found.active;
        if (!worker || worker.scriptURL !== workerURL) throw failure("worker_unavailable");
        await bounded(new Promise((resolve, reject) => {
          const changed = () => {
            if (worker.state === "activated" || worker.state === "redundant") {
              worker.removeEventListener("statechange", changed);
              if (worker.state === "activated") resolve(); else reject(failure("worker_unavailable"));
            }
          };
          worker.addEventListener("statechange", changed);
          changed();
        }), timeout, "worker_unavailable");
      }
      if (found.active?.scriptURL !== workerURL) throw failure("worker_conflict");
      return found;
    }
    async function control(found, type, binding, ticket) {
      if (!found) return true;
      const channel = new root.MessageChannel();
      const request = root.crypto.randomUUID();
      try {
        await bounded(new Promise((resolve, reject) => {
          channel.port1.onmessage = event => {
            if (event.data?.request_id !== request || event.data?.type !== type || event.data.ok !== true) reject(failure("worker_unavailable"));
            else resolve();
          };
          if (ticket) check(ticket);
          found.active.postMessage({ type, request_id: request, binding }, [channel.port2]);
        }), timeout, "worker_unavailable");
        return true;
      } finally { channel.port1.close(); channel.port2.close(); }
    }
    async function subscriptionData(subscription) {
      let data;
      try {
        data = subscription.toJSON();
        const parsed = new URL(data.endpoint);
        if (data.endpoint.length > 2048 || !ENDPOINT.test(data.endpoint) || parsed.href !== data.endpoint
          || (data.expirationTime != null && (!Number.isFinite(data.expirationTime) || data.expirationTime <= Date.now()))) throw new Error();
        const bytes = keyBytes(data.keys.p256dh, 65);
        keyBytes(data.keys.auth, 16);
        await root.crypto.subtle.importKey("raw", bytes, { name: "ECDH", namedCurve: "P-256" }, false, []);
        const expected = keyBytes(publicKey(), 65);
        const actual = new Uint8Array(subscription.options.applicationServerKey);
        if (subscription.options.userVisibleOnly !== true || actual.length !== expected.length
          || actual.some((value, index) => value !== expected[index])) throw new Error();
      } catch (_) { throw failure("invalid_subscription"); }
      const digest = await root.crypto.subtle.digest("SHA-256", new root.TextEncoder().encode(data.endpoint + "\n" + data.keys.p256dh + "\n" + data.keys.auth));
      const fingerprint = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
      return { endpoint: data.endpoint, p256dh: data.keys.p256dh, auth: data.keys.auth, fingerprint, expirationTime: data.expirationTime };
    }
    // Tri-state: the registration, null only when this scope is verifiably empty, undefined when it could not be read.
    async function scopeRegistration() {
      if (!root.navigator?.serviceWorker?.getRegistrations) return null;
      try { return await registration() || null; } catch (_) { return undefined; }
    }
    async function localStop(unsubscribe) {
      let found;
      try { found = await registration(); } catch (_) { localCleanup = false; return false; }
      let muted = false, removed = !unsubscribe;
      try { muted = await control(found, "formora-push:mute"); } catch (_) {}
      if (unsubscribe) {
        try {
          const subscription = found && await bounded(found.pushManager.getSubscription(), timeout);
          if (subscription) await bounded(subscription.unsubscribe(), timeout);
          removed = !found || !await bounded(found.pushManager.getSubscription(), timeout);
        } catch (_) { removed = false; }
      }
      localCleanup = muted && removed && !pendingBrowserOperation;
      return localCleanup;
    }
    function run(work, prepareCommand) {
      if (busy || disposed) return Promise.resolve(result(false, "busy"));
      if (!root.navigator?.locks?.request) { publish("unsupported"); return Promise.resolve(result(false)); }
      busy = true;
      serverAcknowledged = false;
      localCleanup = null;
      const ticket = { generation, owner: owner() };
      let command;
      try { command = prepareCommand?.(); } catch (error) { busy = false; publish(error.code || "permission_dismissed"); return Promise.resolve(result(false)); }
      command?.catch?.(() => {});
      const perform = async lock => {
        if (!lock) throw failure("busy");
        return work(ticket, command);
      };
      const pending = root.navigator?.locks?.request
        ? root.navigator.locks.request(lockName, { ifAvailable: true }, perform) : perform(null);
      return Promise.resolve(pending).catch(async error => {
        if (error.code === "account_changed" || ticket.generation !== generation || ticket.owner !== owner()) {
          await localStop(true);
          publish("account_changed");
          return result(false, "account_changed");
        }
        if (journal?.owner_id) await localStop(false);
        publish(error.code && MESSAGES[error.code] ? error.code : "network");
        return result(false);
      }).finally(() => { busy = false; publish(status); }).then(outcome => ({ ...outcome, state: getState() }));
    }
    function gesture(event) {
      return event instanceof root.Event && event.isTrusted === true && ["click", "keydown"].includes(event.type)
        && (!root.navigator.userActivation || root.navigator.userActivation.isActive === true);
    }

    function refresh() {
      if (!enabled()) {
        prepared = null;
        serverAcknowledged = false;
        try { readJournal(); } catch (error) { publish(error.code); return Promise.resolve(result(false)); }
        if (journal?.owner_id) return suspendLocal();
        publish("disabled");
        return Promise.resolve(result(false));
      }
      const reason = capability();
      if (reason) { publish(reason); return Promise.resolve(result(false)); }
      return run(async ticket => {
        readJournal();
        boundOwner(ticket);
        if (!journal) save(initialJournal());
        const credential = await credentials(ticket);
        const server = await serverState(ticket, credential);
        const key = await configuration(server);
        check(ticket);
        const found = await registration();
        const subscription = found && await bounded(found.pushManager.getSubscription(), timeout);
        check(ticket);
        prepared = { owner: ticket.owner, revision: server.revision, key, at: Date.now() };
        if (journal.phase === "registered" && server.device_registered && subscription && root.Notification.permission === "granted") {
          const data = await subscriptionData(subscription);
          check(ticket);
          if (data.fingerprint !== journal.fingerprint || data.fingerprint !== server.fingerprint || journal.binding_id !== server.binding_id) throw failure("configuration_changed");
          await control(found, "formora-push:bind", { binding_id: server.binding_id, expires_at: Math.min(Date.parse(server.expires_at), data.expirationTime || Infinity) }, ticket);
          check(ticket);
          serverAcknowledged = true;
          publish("registered");
          return result(true);
        }
        if (journal.phase !== "idle") {
          await localStop(false);
          publish(journal.phase === "local_cleanup_pending" ? "local_cleanup_pending" : "revocation_pending");
          return result(false);
        }
        if (subscription || server.device_registered) throw failure("unmanaged_subscription");
        publish(root.Notification.permission === "denied" ? "permission_denied" : "ready");
        return result(true);
      });
    }

    async function enable(ticket, permission, retry) {
      const granted = await bounded(permission, permissionTimeout);
      check(ticket);
      if (granted !== "granted") { publish(granted === "denied" ? "permission_denied" : "permission_dismissed"); return result(false); }
      readJournal();
      boundOwner(ticket);
      const credential = await credentials(ticket);
      const server = await serverState(ticket, credential);
      const key = await configuration(server);
      check(ticket);
      if (!retry && (journal.phase !== "idle" || server.device_registered || prepared.revision !== server.revision)) throw failure("refresh_required");
      if (retry && journal.pending?.operation !== "register") throw failure("refresh_required");
      if (!retry) {
        const existing = await registration();
        if (existing && await bounded(existing.pushManager.getSubscription(), timeout)) throw failure("unmanaged_subscription");
        check(ticket);
      }
      if (!retry) save({ ...journal, owner_id: ticket.owner, phase: "register_pending", server_revoked: false,
        pending: { operation: "register", request_id: root.crypto.randomUUID(), revision: server.revision } });
      serverAcknowledged = false;
      const found = await registration(true);
      check(ticket);
      await control(found, "formora-push:mute");
      let subscription = await bounded(found.pushManager.getSubscription(), timeout);
      check(ticket);
      if (subscription && !retry) throw failure("unmanaged_subscription");
      if (!subscription) {
        if (journal.fingerprint) throw failure("revocation_pending");
        pendingBrowserOperation = true;
        const subscribing = Promise.resolve().then(() => found.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
        let timedOut = false;
        subscribing.then(async value => {
          pendingBrowserOperation = false;
          if (timedOut || ticket.generation !== generation || ticket.owner !== owner()) {
            try { await value.unsubscribe(); } catch (_) {}
          }
        }, () => { pendingBrowserOperation = false; });
        try { subscription = await bounded(subscribing, timeout); }
        catch (error) { timedOut = true; throw error; }
      }
      check(ticket);
      const data = await subscriptionData(subscription);
      check(ticket);
      if (journal.fingerprint && journal.fingerprint !== data.fingerprint) throw failure("revocation_pending");
      save({ ...journal, fingerprint: data.fingerprint });
      const pending = journal.pending;
      const receipt = await rpc(ticket, credential, "register_push_subscription", {
        p_request_id: pending.request_id, p_device_id: journal.device_id, p_expected_revision: pending.revision,
        p_endpoint: data.endpoint, p_p256dh: data.p256dh, p_auth: data.auth,
        p_vapid_public_key: publicKey(), p_consent_version: "push-generic-v1"
      });
      if (receipt.ok !== true || receipt.operation !== "register" || receipt.request_id !== pending.request_id
        || receipt.device_id !== journal.device_id || receipt.revision !== pending.revision + 1
        || receipt.fingerprint !== data.fingerprint || !UUID.test(receipt.binding_id)
        || !(Date.parse(receipt.expires_at) > Date.now()) || receipt.delivery_implemented !== true) throw failure("invalid_response");
      serverAcknowledged = true;
      await control(found, "formora-push:bind", { binding_id: receipt.binding_id, expires_at: Math.min(Date.parse(receipt.expires_at), data.expirationTime || Infinity) }, ticket);
      check(ticket);
      save({ ...journal, phase: "registered", pending: null, binding_id: receipt.binding_id, expires_at: receipt.expires_at });
      prepared = null;
      localCleanup = false;
      publish("registered");
      return result(true);
    }
    function enableFromUserGesture(event) {
      if (!gesture(event)) return Promise.resolve(result(false, "explicit_command_required"));
      if (!enabled() || capability()) return Promise.resolve(result(false, enabled() ? capability() : "disabled"));
      if (!prepared || prepared.owner !== owner() || Date.now() - prepared.at > 60000 || status !== "ready") return Promise.resolve(result(false, "refresh_required"));
      return run((ticket, permission) => enable(ticket, permission, false), () => root.Notification.permission === "default"
        ? root.Notification.requestPermission() : Promise.resolve(root.Notification.permission));
    }
    async function revoke(ticket, all) {
      readJournal();
      boundOwner(ticket);
      if (!ticket.owner) throw failure("sign_in_required");
      if (!journal) save(initialJournal());
      const operation = all ? "revoke_all" : "revoke_device";
      // Scope and request identity are durable before any network call, so a suspension or logout in between
      // cannot silently downgrade an all-device opt-out to this device or start a second server request.
      const intent = journal.intent?.operation === operation ? journal.intent
        : { operation, request_id: root.crypto.randomUUID() };
      save({ ...journal, owner_id: ticket.owner, phase: "revocation_pending", last_action: operation, intent, server_revoked: false });
      prepared = null;
      await localStop(false);
      check(ticket);
      const credential = await credentials(ticket);
      const server = await serverState(ticket, credential);
      const pending = journal.pending?.operation === operation ? journal.pending
        : { operation, request_id: intent.request_id, revision: server.revision };
      save({ ...journal, owner_id: ticket.owner, phase: "revocation_pending", pending, last_action: operation, intent, server_revoked: false });
      let receipt;
      try {
        receipt = await rpc(ticket, credential, "revoke_push_subscriptions", {
          p_request_id: pending.request_id, p_device_id: all ? null : journal.device_id,
          p_expected_revision: pending.revision, p_all: all
        });
      } catch (error) {
        if (error.code === "conflict") save({ ...journal, pending: null, intent: null });
        throw error;
      }
      if (receipt.ok !== true || receipt.operation !== operation || receipt.request_id !== pending.request_id
        || receipt.device_id !== (all ? null : journal.device_id) || receipt.revision !== pending.revision + 1
        || !Number.isInteger(receipt.revoked_count) || receipt.revoked_count < 0 || receipt.revoked_count > 5) throw failure("invalid_response");
      serverAcknowledged = true;
      save({ ...journal, phase: "local_cleanup_pending", server_revoked: true, pending: null, intent: null });
      const cleaned = await localStop(true);
      check(ticket);
      if (!cleaned) { publish("local_cleanup_pending"); return result(false); }
      save({ v: 1, device_id: journal.device_id, owner_id: null, phase: "idle", pending: null });
      publish("off");
      return result(true);
    }
    function revokeDevice() { return run(ticket => revoke(ticket, false)); }
    function revokeAll() { return run(ticket => revoke(ticket, true)); }
    function retryFromUserGesture(event) {
      if (!gesture(event)) return Promise.resolve(result(false, "explicit_command_required"));
      try { readJournal(); } catch (error) { publish(error.code); return Promise.resolve(result(false)); }
      if (journal?.phase === "register_pending" && journal.pending?.operation === "register") {
        if (!enabled() || capability() || root.Notification.permission !== "granted" || pendingBrowserOperation) return Promise.resolve(result(false, "refresh_required"));
        return run(ticket => enable(ticket, Promise.resolve("granted"), true));
      }
      return pendingOperation() === "revoke_all" ? revokeAll() : revokeDevice();
    }
    async function suspendLocal() {
      ++generation;
      prepared = null;
      serverAcknowledged = false;
      try {
        readJournal();
        if (journal?.owner_id) {
          // Suspension records nothing new: it keeps the recorded scope, the pending request identity and the
          // acknowledged-cleanup phase so a later retry cannot re-scope or re-request what was already asked for.
          const pending = journal.pending?.operation === "register" ? null : journal.pending || null;
          save({ ...journal, phase: journal.phase === "local_cleanup_pending" ? "local_cleanup_pending" : "revocation_pending",
            pending, last_action: journal.last_action || pending?.operation || journal.intent?.operation || "revoke_device" });
        }
      } catch (_) {}
      const cleaned = await withDeadline(localReserve, () => localStop(true));
      publish(cleaned ? "local_only" : "revocation_pending");
      return result(false);
    }
    function beforeAccountChange() {
      // The parent must never wait on the network to log out: every branch, including the compensation that
      // follows a failed or abandoned step, shares one absolute accountDeadline + localReserve budget.
      return withTotalDeadline(accountDeadline + localReserve, () => {
        if (busy || pendingBrowserOperation) return suspendLocal();
        if (!root.navigator?.locks?.request || !root.navigator?.serviceWorker?.getRegistrations) {
          return withDeadline(accountDeadline, async () => {
            serverAcknowledged = false;
            let recovered = "unknown";
            try { readJournal(); recovered = journal?.owner_id || null; } catch (_) {}
            const found = await scopeRegistration();
            if (recovered === null && found === null) {
              localCleanup = true;
              publish("not_subscribed");
              return result(true);
            }
            await withDeadline(localReserve, () => localStop(true));
            publish(localCleanup === true ? "local_only" : "revocation_pending");
            return result(false);
          });
        }
        return run(async ticket => {
          const outcome = await withDeadline(accountDeadline, async () => {
            readJournal();
            if (!journal?.owner_id) {
              const found = await registration();
              const subscription = found && await bounded(found.pushManager.getSubscription(), timeout);
              check(ticket);
              localCleanup = await control(found, "formora-push:mute");
              if (!subscription) {
                publish("not_subscribed");
                return result(true);
              }
              throw failure("unmanaged_subscription");
            }
            // The recorded scope decides the request: a logout can never downgrade a pending all-device opt-out.
            return revoke(ticket, pendingOperation() === "revoke_all");
          }).catch(error => error);
          if (!(outcome instanceof Error)) return outcome;
          if (outcome.code === "account_changed" || !journal?.owner_id) throw outcome;
          await withDeadline(localReserve, () => localStop(true));
          check(ticket);
          ++generation;
          publish("revocation_pending");
          return result(false);
        });
      });
    }
    function sessionChanged() {
      try { readJournal(); } catch (_) { void suspendLocal(); return; }
      if ((journal?.owner_id && journal.owner_id !== owner()) || (prepared && prepared.owner !== owner())) void suspendLocal();
    }
    function storageChanged(event) {
      if (event.key === auth()?.KEY || event.key === null) {
        try { auth()?.load?.(); } catch (_) {}
        sessionChanged();
      } else if (event.key === storageKey) {
        ++generation;
        prepared = null;
        try { readJournal(); } catch (_) { void suspendLocal(); return; }
        if (journal?.owner_id && journal.owner_id !== owner()) void suspendLocal();
        else publish("unprepared");
      }
    }
    function subscriptionChanged(event) {
      if (event.source?.scriptURL === workerURL && event.data?.type === "formora-push:subscription-change") void suspendLocal();
    }
    root.addEventListener?.("formora:sessionchange", sessionChanged);
    root.addEventListener?.("storage", storageChanged);
    root.navigator?.serviceWorker?.addEventListener?.("message", subscriptionChanged);

    async function dispose() {
      await suspendLocal();
      disposed = true;
      root.removeEventListener?.("formora:sessionchange", sessionChanged);
      root.removeEventListener?.("storage", storageChanged);
      root.navigator?.serviceWorker?.removeEventListener?.("message", subscriptionChanged);
    }
    return Object.freeze({ getState, refresh, enableFromUserGesture, retryFromUserGesture,
      revokeDevice, revokeAll, beforeAccountChange, suspendLocal, dispose });
  }

  root.FormoraPush = Object.freeze({ create });
})(typeof window !== "undefined" ? window : globalThis);