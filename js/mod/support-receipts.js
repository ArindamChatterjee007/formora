// T-110 support receipts (member side). Default off: the parent enables it with
// window.SUPPORT_RECEIPTS, and with the flag off nothing here renders, stores or sends.
// Staff work happens outside the app against the staff RPCs, so no staffing, response time
// or contact is claimed here — only the values the server reports as approved are shown.
const SupportReceipts = {
  _pending: new Map(),
  _failures: new Map(),
  _drafts: new Map(),
  _generation: 0,
  _requests: new Set(),
  _view: 0,
  _rows: [],
  _rowOwner: null,
  _settings: null,
  _bound: false,
  // A retry id is an opaque UUID with no prose in it, but it is still account state, so it is held
  // for a bounded window rather than for ever. This is a client-side bound only; it is not evidence
  // of any server-side idempotency window, which preflight still has to establish.
  _retryTtl: 86400000,
  _status: { open: "Open", in_progress: "In progress", waiting_customer: "Waiting for your reply", resolved: "Resolved", closed: "Closed" },
  _calls: ["support_settings", "submit_support_case", "my_support_cases", "support_thread", "add_support_reply"],

  enabled() { return typeof window !== "undefined" && !!window.SUPPORT_RECEIPTS; },
  owner() { return typeof SupaAuth !== "undefined" && SupaAuth.active() ? SupaAuth.uid() : ""; },
  uuid(value) { return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value); },
  text(value) { return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character])); },
  icon(name, fallback) { return typeof App !== "undefined" && App.ic ? App.ic(name) : fallback; },

  close() {
    this._view++; this._rows = []; this._rowOwner = null; this._settings = null;
    this._threadCase = null; this._messages = []; this._drafts.clear();
    const card = typeof document !== "undefined" ? document.getElementById("modal-card") : null;
    if (card?.querySelector("#support-content, #support-reply")) card.replaceChildren();
  },

  // The unsent reply for a case lives in ONE account-and-case keyed RAM map. Both textareas the
  // thread can render write back into it, the live composer and the read-only copy shown when the
  // intake is paused, so the map is the single canonical source instead of whichever element id
  // happens to exist. That matters in three places that each used to drop text: a re-render that
  // fails and is replaced by the error panel, a "load older messages" on a paused thread that only
  // ever read the composer id, and the retry control, which arrives with no draft argument. It is
  // never persisted, and it is keyed per case so one thread's text cannot surface in another.
  _draftKey(caseId) { return this.owner() + "|" + caseId; },
  draftFor(caseId) { return this._drafts.get(this._draftKey(caseId)) || ""; },
  _holdDraft(caseId, value) {
    const key = this._draftKey(caseId);
    if (typeof value === "string" && value.trim()) this._drafts.set(key, value);
    else this._drafts.delete(key);
  },
  _readDraft(caseId) {
    if (this._threadCase !== caseId || typeof document === "undefined") return this.draftFor(caseId);
    const live = document.getElementById("support-reply") || document.getElementById("support-draft");
    return live ? String(live.value ?? "") : this.draftFor(caseId);
  },
  // The close control this module renders drops the cached thread first and only then asks the
  // app to close the modal, so private prose never outlives the sheet even before a parent
  // wires close() into its own closeModal().
  dismiss() {
    this.close();
    if (typeof App !== "undefined" && typeof App.closeModal === "function") App.closeModal();
    else if (typeof document !== "undefined") document.getElementById("modal")?.classList.add("hidden");
  },
  // Bound lazily inside the enabled branch only, so loading the file with the flag off
  // registers nothing. formora:modalclose is a forward-declared parent hook: the module is
  // graceful standalone and nothing here depends on the parent ever dispatching it.
  _observe() {
    const root = typeof globalThis !== "undefined" ? globalThis : null;
    if (this._bound || !this.enabled() || typeof root?.addEventListener !== "function") return;
    this._bound = true;
    root.addEventListener("formora:sessionchange", () => this.reset());
    root.addEventListener("pagehide", () => this.reset({ keepRetryIds: true }));
    root.addEventListener("formora:modalclose", () => this.close());
  },
  // An account change purges everything this device holds for the old account, retry ids included.
  // A page leaving is NOT an account change. It drops the private prose in the DOM and in RAM and
  // abandons the in-flight generation, but it KEEPS the opaque retry ids, because a write whose
  // acknowledgement was lost exactly when the tab went away is the case those ids exist for.
  // Purging there sent a fresh id after the reload, missed the server's anchor and committed a
  // second copy of the same request. What is kept is a UUID and a timestamp, nothing else, and it
  // ages out on its own within _retryTtl.
  reset(options = {}) {
    this.close(); this._generation++; this._failures.clear(); this._pending.clear();
    this._requests.forEach(controller => controller.abort()); this._requests.clear();
    if (options && options.keepRetryIds) return;
    try {
      for (let index = localStorage.length - 1; index >= 0; index--) {
        const key = localStorage.key(index);
        if (key?.startsWith("fm_support_request_") || key?.startsWith("fm_support_reply_")) localStorage.removeItem(key);
      }
    } catch (_) {}
  },
  errorFor(key) { return this._failures.get(key) || "Couldn't confirm your request. Retry when signed in and online."; },

  // The stored value is only an opaque request id and the moment it was minted, never the subject,
  // message or reference text, so a lost acknowledgement can be retried after a reload without
  // keeping the draft, and the id ages out on its own. A reply id is keyed per case: one shared
  // owner slot let a send to a second case evict the first case's id, and the fresh UUID that
  // replaced it duplicated the message on retry.
  _request(scope, caseId) {
    const key = "fm_support_" + scope + "_" + this.owner() + (scope === "reply" ? "_" + caseId : "");
    try {
      const held = JSON.parse(localStorage.getItem(key) || "null");
      const age = held ? Date.now() - held.at : NaN;
      if (held && this.uuid(held.id) && held.case === caseId && Number.isFinite(age) && age < this._retryTtl) return { key, id: held.id };
      const id = crypto.randomUUID();
      localStorage.setItem(key, JSON.stringify({ case: caseId, id, at: Date.now() }));
      return { key, id };
    } catch (_) { return { key, id: crypto.randomUUID(), volatile: true }; }
  },
  _clear(key) { try { localStorage.removeItem(key); } catch (_) {} },
  // A result that arrives after a logout or account change must not delete a retry id that a
  // newer attempt has since stored under the same key; a stale replay is caught as a conflict.
  _settle(key, owner, generation) { if (owner === this.owner() && generation === this._generation) this._clear(key); },

  async call(name, body = {}) {
    if (!this.enabled() || !this._calls.includes(name)) throw new Error("Support requests are unavailable right now.");
    const generation = this._generation, owner = this.owner();
    const controller = new AbortController();
    let timer = null;
    // Aborting only settles a transport that honours the signal, and a body stream that never
    // ends is not covered by it at all, so every await races one hard overall deadline. This
    // call always settles even against a token, fetch or json() promise that never would.
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { controller.abort(); } catch (_) {}
        reject(Object.assign(new Error("Support request timed out."), { name: "AbortError" }));
      }, 10000);
    });
    const within = value => Promise.race([Promise.resolve(value), deadline]);
    this._requests.add(controller);
    try {
      const token = owner ? await within(SupaAuth.token()) : null;
      if (!token || owner !== this.owner() || generation !== this._generation || !Cloud.base || !Cloud.key) throw new Error("Sign in again to continue.");
      const response = await within(fetch(Cloud.base + "/rpc/" + name, { method: "POST", headers: Cloud._headers({ Authorization: "Bearer " + token }), body: JSON.stringify(body), signal: controller.signal }));
      if (!response || !response.ok) {
        const status = response ? response.status : 0;
        const error = new Error(status === 409 ? "This request already exists. Open Your requests before sending it again."
          : status === 429 ? "You've sent several requests. Try again later."
          : status === 503 ? "Support requests are not being accepted right now."
          : status === 403 ? "You do not have permission for this action."
          : status === 401 ? "Sign in again to continue."
          : status === 404 ? "This support request is no longer available."
          : status === 400 ? "This request isn't valid. Check your message and try again."
          : "Couldn't confirm your request. Retry when online.");
        error.status = status; throw error;
      }
      const data = await within(response.json());
      if (owner !== this.owner() || generation !== this._generation) throw new Error("Account changed");
      return data;
    } catch (error) {
      if (["AbortError", "TypeError", "SyntaxError"].includes(error?.name)) throw new Error("Couldn't confirm your request. Retry when online.");
      throw error;
    } finally { clearTimeout(timer); this._requests.delete(controller); }
  },

  validReceipt(row) {
    return !!row && this.uuid(row.id) && Object.hasOwn(this._status, row.status)
      && Number.isInteger(row.version) && row.version > 0 && Number.isFinite(Date.parse(row.created_at));
  },
  validCase(row) {
    return this.validReceipt(row) && typeof row.subject === "string" && row.subject.length <= 120
      && Number.isInteger(row.message_count) && row.message_count >= 0 && Number.isFinite(Date.parse(row.updated_at));
  },
  validMessage(row) {
    return !!row && this.uuid(row.id) && ["member", "staff"].includes(row.author_role)
      && ["thread", "internal"].includes(row.visibility) && typeof row.body === "string" && row.body.length <= 2000
      && Array.isArray(row.evidence) && row.evidence.every(item => typeof item === "string")
      && Number.isFinite(Date.parse(row.created_at));
  },

  // Resolves to a receipt only after the server acknowledges the atomic write; on every other
  // outcome it resolves to null and the caller keeps its draft.
  async submit(subject, body, evidence = []) {
    const owner = this.owner(), generation = this._generation;
    const clean = (Array.isArray(evidence) ? evidence : []).map(item => String(item).trim()).filter(Boolean).slice(0, 5);
    const key = JSON.stringify([owner, "submit"]);
    if (!this.enabled() || !owner || typeof subject !== "string" || !subject.trim() || subject.trim().length > 120
      || typeof body !== "string" || !body.trim() || body.trim().length > 2000
      || clean.some(item => item.length > 120)) return null;
    this._observe();
    this._failures.delete(key);
    if (this._pending.has(key)) return this._pending.get(key);
    const pending = (async () => {
      const held = this._request("request", null);
      try {
        const receipt = await this.call("submit_support_case", {
          p_request_id: held.id, p_subject: subject.trim(), p_body: body.trim(), p_evidence: clean.length ? clean : null });
        if (!this.validReceipt(receipt) || receipt.request_id !== held.id || owner !== this.owner() || generation !== this._generation) return null;
        this._settle(held.key, owner, generation);
        return receipt;
      } catch (error) {
        if ([400, 404, 409].includes(error.status)) this._settle(held.key, owner, generation);
        if (owner === this.owner() && generation === this._generation) this._failures.set(key, error.message || "Support request unavailable. Retry.");
        return null;
      }
    })();
    this._pending.set(key, pending);
    try { return await pending; }
    finally { if (this._pending.get(key) === pending) this._pending.delete(key); }
  },

  async sendReply(caseId, body) {
    const owner = this.owner(), generation = this._generation;
    const key = JSON.stringify([owner, "reply", caseId]);
    if (!this.enabled() || !owner || !this.uuid(caseId) || typeof body !== "string" || !body.trim() || body.trim().length > 2000) return null;
    this._observe();
    this._failures.delete(key);
    if (this._pending.has(key)) return this._pending.get(key);
    const pending = (async () => {
      const held = this._request("reply", caseId);
      try {
        const result = await this.call("add_support_reply", { p_case_id: caseId, p_request_id: held.id, p_body: body.trim(), p_evidence: null });
        if (!result || result.id !== caseId || !Object.hasOwn(this._status, result.status)
          || !Number.isInteger(result.version) || owner !== this.owner() || generation !== this._generation) return null;
        this._settle(held.key, owner, generation);
        return result;
      } catch (error) {
        if ([400, 404, 409].includes(error.status)) this._settle(held.key, owner, generation);
        if (owner === this.owner() && generation === this._generation) this._failures.set(key, error.message || "Couldn't send your reply. Retry.");
        return null;
      }
    })();
    this._pending.set(key, pending);
    try { return await pending; }
    finally { if (this._pending.get(key) === pending) this._pending.delete(key); }
  },

  _note() {
    const settings = this._settings;
    if (!settings) return "";
    const expectation = typeof settings.response_expectation === "string" && settings.response_expectation.trim() ? settings.response_expectation.trim() : "";
    const contact = typeof settings.contact_channel === "string" && settings.contact_channel.trim() ? settings.contact_channel.trim() : "";
    if (!expectation && !contact) return "";
    return `<p class="sub" id="support-note">${this.text([expectation, contact].filter(Boolean).join(" · "))}</p>`;
  },

  async open(more = false) {
    const owner = this.owner();
    if (!owner || !this.enabled()) return;
    this._observe();
    const view = ++this._view, generation = this._generation;
    const older = more && this._rowOwner === owner ? this._rows : [];
    this._rows = []; this._rowOwner = null;
    const last = older.at(-1);
    const card = document.getElementById("modal-card"), modal = document.getElementById("modal");
    card.innerHTML = `<div class="modal-head"><h2>Your support requests</h2><button class="icon-btn" aria-label="Close" onclick="SupportReceipts.dismiss()">${this.icon("close", "✕")}</button></div><div id="support-content" aria-live="polite">Loading your requests…</div>`;
    modal.classList.remove("hidden");
    const content = document.getElementById("support-content");
    const current = () => this._view === view && this._generation === generation && this.owner() === owner
      && document.getElementById("support-content") === content && !modal.classList.contains("hidden");
    try {
      const settings = await this.call("support_settings");
      if (!current()) return;
      this._settings = settings && typeof settings === "object" ? settings : null;
      const rows = await this.call("my_support_cases", last ? { p_before: last.created_at, p_before_id: last.id } : {});
      if (!current()) return;
      if (!Array.isArray(rows) || rows.length > 50 || !rows.every(row => this.validCase(row))
        || new Set([...older, ...rows].map(row => row.id)).size !== older.length + rows.length) throw new Error("Unexpected support response. Retry.");
      this._rows = [...older, ...rows]; this._rowOwner = owner;
      content.innerHTML = this._note()
        + (this._rows.length ? this._rows.map(row => `<section data-support-id="${this.text(row.id)}" style="padding:12px 0;border-top:1px solid var(--line);overflow-wrap:anywhere"><b>${this.text(row.subject)}</b><div class="sub">${this.text(this._status[row.status])} · ${this.text(new Date(row.created_at).toLocaleDateString())}</div><div class="sub">Reference ${this.text(row.id)}</div><button class="btn ghost" onclick="SupportReceipts.openCase('${this.text(row.id)}')">Open request</button></section>`).join("")
          : `<p>You haven't sent a support request yet.</p>`)
        + (rows.length === 50 ? `<button class="btn ghost wide" onclick="SupportReceipts.open(true)">Load older requests</button>` : "");
    } catch (error) {
      if (current()) content.innerHTML = `<p role="alert">${this.text(error.message || "Support requests unavailable")}</p><button class="btn" onclick="SupportReceipts.open()">Retry</button>`;
    }
  },

  async openCase(caseId, more = false, draft = null) {
    const owner = this.owner();
    if (!owner || !this.enabled() || !this.uuid(caseId)) return;
    this._observe();
    const view = ++this._view, generation = this._generation;
    const card = document.getElementById("modal-card"), modal = document.getElementById("modal");
    // Whatever is already typed for THIS case survives a re-render, including text added while a
    // send was in flight, a paused intake that only renders the read-only copy, and a settings or
    // thread call that fails and replaces the whole panel with the retry control. The value is held
    // in the canonical draft map before the first await, so the retry finds it even though the
    // element it was typed into no longer exists. A load for a different case starts empty.
    const typed = typeof draft === "string" ? draft : this._readDraft(caseId);
    this._holdDraft(caseId, typed);
    const older = more && this._threadCase === caseId ? this._messages || [] : [];
    this._threadCase = null; this._messages = [];
    card.innerHTML = `<div class="modal-head"><h2>Support request</h2><button class="icon-btn" aria-label="Close" onclick="SupportReceipts.dismiss()">${this.icon("close", "✕")}</button></div><div id="support-content" aria-live="polite">Loading this request…</div>`;
    modal.classList.remove("hidden");
    const content = document.getElementById("support-content");
    const current = () => this._view === view && this._generation === generation && this.owner() === owner
      && document.getElementById("support-content") === content && !modal.classList.contains("hidden");
    try {
      const last = older.at(-1);
      // Settings are read fresh before a composer is offered so a closed intake reads as
      // read-only instead of as a reply box that only fails on send. The view guard drops a
      // settings result that lands after the member moved to another case or closed the sheet.
      const settings = await this.call("support_settings");
      if (!current()) return;
      this._settings = settings && typeof settings === "object" ? settings : null;
      const data = await this.call("support_thread", last ? { p_case_id: caseId, p_before: last.created_at, p_before_id: last.id } : { p_case_id: caseId });
      if (!current()) return;
      const messages = data && Array.isArray(data.messages) ? data.messages : null;
      if (!data || !this.validCase(data.case) || data.case.id !== caseId || !messages || messages.length > 50
        || !messages.every(row => this.validMessage(row))) throw new Error("Unexpected support response. Retry.");
      // Belt and braces: the server never selects internal notes for a member, and the member
      // view drops anything that is not part of the shared thread even if one arrives.
      const visible = [...older, ...messages].filter(row => row.visibility === "thread");
      this._threadCase = caseId; this._messages = [...older, ...messages];
      const closed = data.case.status === "closed";
      const replyable = !closed && this._settings?.collection_enabled === true;
      content.innerHTML = `<b>${this.text(data.case.subject)}</b><div class="sub">${this.text(this._status[data.case.status])} · Reference ${this.text(caseId)}</div>`
        + this._note()
        + visible.map(row => `<section data-message-id="${this.text(row.id)}" style="padding:10px 0;border-top:1px solid var(--line);overflow-wrap:anywhere"><div class="sub">${row.author_role === "staff" ? "Support" : "You"} · ${this.text(new Date(row.created_at).toLocaleString())}</div><p>${this.text(row.body)}</p>${row.evidence.length ? `<div class="sub">References: ${this.text(row.evidence.join(", "))}</div>` : ""}</section>`).join("")
        + (messages.length === 50 ? `<button class="btn ghost wide" onclick="SupportReceipts.openCase('${this.text(caseId)}',true)">Load more messages</button>` : "")
        + (replyable ? `<div class="field" style="margin-top:12px"><label for="support-reply">Reply</label><textarea id="support-reply" maxlength="2000" rows="3"></textarea></div><p id="support-error" role="alert"></p><button id="support-send" class="btn wide" onclick="SupportReceipts.submitReply('${this.text(caseId)}')">Send reply</button>`
          // A gate that closes while the member was typing is stated, and the unsent text is
          // handed back to read and copy rather than deleted without a word.
          : `<p class="sub">${closed ? "This request is closed. Send a new request if you still need help."
            : "Replies are paused right now, so this request is read-only. Everything already sent stays here."}</p>`
            + (typed.trim() ? `<div class="field" style="margin-top:12px"><label for="support-draft">Your unsent reply</label><textarea id="support-draft" rows="3" readonly>${this.text(typed)}</textarea></div>` : ""))
        + `<button class="btn ghost wide" style="margin-top:6px" onclick="SupportReceipts.open()">Back to your requests</button>`;
      const editor = document.getElementById("support-reply");
      if (editor && typed) editor.value = typed;
    } catch (error) {
      if (current()) content.innerHTML = `<p role="alert">${this.text(error.message || "Support request unavailable")}</p><button class="btn" onclick="SupportReceipts.openCase('${this.text(caseId)}')">Retry</button>`;
    }
  },

  async submitReply(caseId) {
    const editor = document.getElementById("support-reply"), button = document.getElementById("support-send"), output = document.getElementById("support-error");
    const owner = this.owner(), generation = this._generation;
    const body = (editor?.value || "").trim();
    if (!editor || !body) { if (output) output.textContent = "Write a reply first."; return; }
    this._holdDraft(caseId, editor.value);
    if (button) button.disabled = true;
    if (output) output.textContent = "Sending…";
    const result = await this.sendReply(caseId, body);
    const live = document.getElementById("support-reply") === editor && owner === this.owner() && generation === this._generation;
    if (button && document.getElementById("support-send") === button) button.disabled = false;
    if (!live) return;
    // A failed send never clears what the member typed.
    if (!result) { if (output) output.textContent = this.errorFor(JSON.stringify([owner, "reply", caseId])); return; }
    // Only the text that was actually sent is cleared. Anything typed while the send was in
    // flight is carried into the re-render instead of being dropped by it.
    const residual = editor.value.trim() === body ? "" : editor.value;
    editor.value = residual;
    await this.openCase(caseId, false, residual);
  }
};
