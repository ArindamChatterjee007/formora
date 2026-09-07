const Reports = {
  _pending: new Map(),
  _failures: new Map(),
  _generation: 0,
  _requests: new Set(),
  _view: 0,
  _rows: [],
  _status: { received: "Received", under_review: "Under review", action_taken: "Action recorded", no_action: "No action", closed: "Closed" },
  _next: { received: ["under_review"], under_review: ["action_taken", "no_action"], action_taken: ["closed"], no_action: ["closed"], closed: ["under_review"] },
  enabled() { return !!window.MODERATION_RECEIPTS; },
  owner() { return typeof SupaAuth !== "undefined" && SupaAuth.active() ? SupaAuth.uid() : ""; },
  close() {
    this._view++; this._rows = []; this._rowOwner = null; this._rowModerator = false;
    const card = typeof document !== "undefined" ? document.getElementById("modal-card") : null;
    if (card?.querySelector("#report-content, #report-note")) card.replaceChildren();
  },
  reset() {
    this.close(); this._generation++; this._failures.clear(); this._pending.clear();
    this._requests.forEach(controller => controller.abort()); this._requests.clear();
    try {
      for (let index = localStorage.length - 1; index >= 0; index--) {
        const key = localStorage.key(index);
        if (key?.startsWith("fm_report_request_")) localStorage.removeItem(key);
      }
    } catch (_) {}
  },
  errorFor(kind, targetId, reason) { return this._failures.get(JSON.stringify([this.owner(), kind, targetId, reason.trim()])) || "Could not confirm the report. Retry when signed in and online."; },
  async call(name, body = {}) {
    if (!this.enabled() || !["submit_report", "my_report_receipts", "can_review_reports", "moderation_queue", "report_decision_history", "review_report"].includes(name)) throw new Error("Report service unavailable");
    const generation = this._generation, owner = this.owner(), token = owner ? await SupaAuth.token() : null;
    if (!token || owner !== this.owner() || generation !== this._generation || !Cloud.base || !Cloud.key) throw new Error("Sign in again to continue");
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
    this._requests.add(controller);
    try {
      const response = await fetch(Cloud.base + "/rpc/" + name, { method: "POST", headers: Cloud._headers({ Authorization: "Bearer " + token }), body: JSON.stringify(body), signal: controller.signal });
      if (!response.ok) {
        const error = new Error(response.status === 409 ? "This request changed. Refresh the case before deciding." : response.status === 429 ? "Report limit reached. Try again later." : response.status === 403 ? "You do not have permission for this action." : response.status === 401 ? "Sign in again to continue." : response.status === 404 ? "This content is no longer available." : response.status === 400 ? "This report or decision is not valid." : "Could not confirm the request. Retry when online.");
        error.status = response.status; throw error;
      }
      const data = await response.json();
      if (owner !== this.owner() || generation !== this._generation) throw new Error("Account changed");
      return data;
    } catch (error) {
      if (["AbortError", "TypeError", "SyntaxError"].includes(error.name)) throw new Error(name === "submit_report" ? "Could not confirm the report. Retry when online." : "Could not confirm the request. Retry when online.");
      throw error;
    } finally { clearTimeout(timer); this._requests.delete(controller); }
  },
  uuid(value) { return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value); },
  valid(row) {
    return row && this.uuid(row.id) && ["post", "comment", "user"].includes(row.kind)
      && Object.hasOwn(this._status, row.status) && Number.isInteger(row.version) && row.version > 0
      && Number.isFinite(Date.parse(row.created_at)) && Number.isFinite(Date.parse(row.updated_at));
  },
  async submit(kind, targetId, reason) {
    const owner = this.owner(), generation = this._generation;
    if (!owner || !["post", "comment", "user"].includes(kind) || typeof targetId !== "string" || !targetId || targetId.length > 255
      || typeof reason !== "string" || !reason.trim() || reason.trim().length > 512) return null;
    const errorKey = JSON.stringify([owner, kind, targetId, reason.trim()]);
    this._failures.delete(errorKey);
    if (this._pending.has(errorKey)) return this._pending.get(errorKey);
    if (this._pending.size) { this._failures.set(errorKey, "Another report is still sending. Retry shortly."); return null; }
    const storageKey = "fm_report_request_" + owner;
    const pending = (async () => {
      try {
        let requestId = localStorage.getItem(storageKey);
        if (!this.uuid(requestId)) {
          requestId = crypto.randomUUID();
          localStorage.setItem(storageKey, requestId);
        }
        const receipt = await this.call("submit_report", { p_request_id: requestId, p_kind: kind, p_target_id: targetId, p_reason: reason.trim() });
        if (!this.valid(receipt) || receipt.request_id !== requestId || receipt.kind !== kind || owner !== this.owner() || generation !== this._generation) return null;
        try { localStorage.removeItem(storageKey); } catch (_) {}
        return receipt;
      } catch (error) {
        if ([400, 404, 409].includes(error.status)) { try { localStorage.removeItem(storageKey); } catch (_) {} }
        if (owner === this.owner() && generation === this._generation) this._failures.set(errorKey, error.status === 409 ? "Your earlier report was received. Check Your reports, then submit this new report again." : error.message || "Report unavailable. Retry.");
        return null;
      }
    })();
    this._pending.set(errorKey, pending);
    try { return await pending; }
    finally { if (this._pending.get(errorKey) === pending) this._pending.delete(errorKey); }
  },
  async open(moderator = false, more = false) {
    const owner = this.owner();
    if (!owner || !this.enabled()) return;
    const view = ++this._view;
    const oldRows = more && this._rowOwner === owner && this._rowModerator === moderator ? this._rows : [];
    this._rows = []; this._rowOwner = null; this._rowModerator = false;
    const last = oldRows.at(-1);
    const cursor = last ? { p_before: last.created_at, p_before_id: last.id } : {};
    const card = document.getElementById("modal-card"), modal = document.getElementById("modal");
    card.innerHTML = `<div class="modal-head"><h2>${moderator ? "Moderation queue" : "Your reports"}</h2><button class="icon-btn" aria-label="Close" onclick="App.closeModal()">${App.ic("close")}</button></div><div id="report-content" aria-live="polite">Loading reports...</div>`;
    modal.classList.remove("hidden");
    const content = document.getElementById("report-content");
    const current = () => this._view === view && this.owner() === owner && document.getElementById("report-content") === content && !modal.classList.contains("hidden");
    try {
      const rows = await this.call(moderator ? "moderation_queue" : "my_report_receipts", cursor);
      if (!current()) return;
      if (!Array.isArray(rows) || rows.length > 50 || !rows.every(row => this.valid(row)) || new Set([...oldRows, ...rows].map(row => row.id)).size !== oldRows.length + rows.length) throw new Error("Unexpected report response. Retry.");
      const canReview = await this.call("can_review_reports");
      if (!current()) return;
      if (moderator && canReview !== true) throw new Error("You do not have permission for this action.");
      this._rows = [...oldRows, ...rows]; this._rowOwner = owner; this._rowModerator = moderator;
      content.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px"><button class="btn ghost" onclick="Reports.open(false)">Your reports</button>${canReview === true ? `<button class="btn ghost" onclick="Reports.open(true)">Moderation queue</button>` : ""}<button class="icon-btn" aria-label="Refresh reports" onclick="Reports.open(${moderator})">${App.ic("undo")}</button></div>`
        + (this._rows.length ? this._rows.map(row => `<section data-report-id="${row.id}" style="padding:12px 0;border-top:1px solid var(--line);overflow-wrap:anywhere"><b>${esc(this._status[row.status])}</b><div class="sub">${esc(row.kind)} report &middot; ${esc(new Date(row.created_at).toLocaleDateString())}</div><div class="sub">Receipt ${esc(row.id)}</div>${moderator ? `<p>${esc(row.reason)}</p><div class="sub">Target ${esc(row.target_id)}</div><button class="btn ghost" onclick="Reports.edit('${row.id}')">${App.ic("edit", { size: 16 })} Review case</button>` : ""}</section>`).join("") : `<p>No reports yet.</p>`)
        + (rows.length === 50 ? `<button class="btn ghost wide" onclick="Reports.open(${moderator},true)">Load more</button>` : "");
    } catch (error) {
      if (current()) content.innerHTML = `<p role="alert">${esc(error.message || "Reports unavailable")}</p><button class="btn" onclick="Reports.open(${moderator})">Retry</button>`;
    }
  },
  edit(id) {
    const row = this._rows.find(item => item.id === id);
    if (!row || this._rowOwner !== this.owner() || !this._rowModerator) return;
    const view = ++this._view;
    const owner = this.owner();
    const modal = document.getElementById("modal");
    const card = document.getElementById("modal-card");
    card.innerHTML = `<div class="modal-head"><h2>Review report</h2><button class="icon-btn" aria-label="Close" onclick="App.closeModal()">${App.ic("close")}</button></div><p style="overflow-wrap:anywhere">${esc(row.reason)}</p><div class="field"><label for="report-decision">Next status</label><select id="report-decision">${this._next[row.status].map(status => `<option value="${status}">${esc(this._status[status])}</option>`).join("")}</select></div><div class="field" style="margin:12px 0"><label for="report-note">Evidence and decision</label><textarea id="report-note" class="food-text" maxlength="2000" rows="4"></textarea></div><p id="report-error" role="alert"></p><button id="report-save" class="btn wide">Save decision</button><button class="btn ghost wide" onclick="Reports.open(true)">Back to queue</button><h3>Decision history</h3><div id="report-history" aria-live="polite">Loading decisions...</div>`;
    const button = document.getElementById("report-save"), note = document.getElementById("report-note"), choice = document.getElementById("report-decision"), output = document.getElementById("report-error");
    const history = document.getElementById("report-history");
    const current = () => view === this._view && owner === this.owner() && document.getElementById("report-note") === note && !modal.classList.contains("hidden");
    const loadHistory = async (oldRows = []) => {
      if (!current()) return;
      history.textContent = "Loading decisions...";
      try {
        const rows = await this.call("report_decision_history", { p_id: id, p_before_version: oldRows.at(-1)?.previous_version || null });
        if (!current()) return;
        if (!Array.isArray(rows) || rows.length > 50 || !rows.every(action => this.uuid(action.id) && this.uuid(action.actor)
          && Object.hasOwn(this._status, action.from_status) && Object.hasOwn(this._status, action.to_status)
          && Number.isInteger(action.previous_version) && action.previous_version > 0 && typeof action.note === "string" && action.note.length <= 2000
          && Number.isFinite(Date.parse(action.created_at)))) throw new Error("Unexpected decision history. Retry.");
        const actions = [...oldRows, ...rows];
        if (actions.some((action, index) => index > 0 && action.previous_version >= actions[index - 1].previous_version)) throw new Error("Unexpected decision order. Retry.");
        history.innerHTML = actions.length ? actions.map(action => `<section data-action-id="${action.id}" style="padding:12px 0;border-top:1px solid var(--line);overflow-wrap:anywhere"><b>${esc(this._status[action.to_status])}</b><p>${esc(action.note)}</p><div class="sub">Version ${action.previous_version + 1} &middot; ${esc(new Date(action.created_at).toLocaleString())}</div><div class="sub">Reviewer ${esc(action.actor)}</div></section>`).join("") : "<p>No decisions yet.</p>";
        if (rows.length === 50) {
          const more = document.createElement("button"); more.className = "btn ghost wide"; more.textContent = "Load earlier decisions";
          more.onclick = () => loadHistory(actions); history.append(more);
        }
      } catch (error) {
        if (!current()) return;
        if (error.status === 403) { this.reset(); card.innerHTML = `<p role="alert">${esc(error.message)}</p><button class="btn" onclick="App.closeModal()">Close</button>`; return; }
        history.innerHTML = `<p role="alert">${esc(error.message || "Decision history unavailable")}</p>`;
        const retry = document.createElement("button"); retry.className = "btn ghost"; retry.textContent = "Retry history"; retry.onclick = () => loadHistory(oldRows); history.append(retry);
      }
    };
    let previous = "", requestId = "", requiresRefresh = false;
    button.onclick = async () => {
      if (button.disabled || !current() || requiresRefresh) return;
      if (!note.value.trim()) { output.textContent = "Record the evidence and decision first."; return; }
      const payload = JSON.stringify([choice.value, note.value.trim()]);
      const requestedStatus = choice.value, requestedVersion = row.version;
      if (payload !== previous) { requestId = crypto.randomUUID(); previous = payload; }
      button.disabled = true; output.textContent = "Saving...";
      try {
        const result = await this.call("review_report", { p_id: id, p_version: requestedVersion, p_status: requestedStatus, p_note: note.value.trim(), p_request_id: requestId });
        if (result?.id !== id || result.version !== requestedVersion + 1 || result.status !== requestedStatus) throw new Error("Decision was not confirmed. Retry.");
        if (!current()) return;
        if (payload !== JSON.stringify([choice.value, note.value.trim()])) { requiresRefresh = true; output.textContent = "Earlier decision saved. Your newer note is retained; reopen the case before another decision."; loadHistory(); return; }
        await this.open(true);
      } catch (error) { if (current()) { requiresRefresh = error.status === 409; output.textContent = error.message || "Could not save. Your note is retained."; } }
      finally { button.disabled = requiresRefresh; }
    };
    loadHistory();
    note.focus();
  }
};