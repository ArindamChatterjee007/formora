'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../js/mod/support-receipts.js'), 'utf8');

function documentStub() {
  const nodes = new Map();
  const doc = {
    getElementById: id => nodes.get(id) || null,
    register(id) { nodes.set(id, makeElement(id)); return nodes.get(id); },
    node: id => nodes.get(id) || null
  };
  function makeElement(id) {
    const element = {
      id, textContent: '', value: '', disabled: false, _html: '',
      classList: { _set: new Set(['hidden']), add(name) { this._set.add(name); }, remove(name) { this._set.delete(name); }, contains(name) { return this._set.has(name); } },
      querySelector(selector) { return selector.split(',').some(part => element._html.includes('id="' + part.trim().slice(1) + '"')) ? makeElement('match') : null; },
      replaceChildren() { element.innerHTML = ''; }
    };
    Object.defineProperty(element, 'innerHTML', {
      get: () => element._html,
      set(html) {
        element._html = String(html);
        for (const match of element._html.matchAll(/id="([^"]+)"/g)) doc.register(match[1]);
        // A textarea's value comes from its markup, which is how the read-only copy of an unsent
        // reply is handed back; without this the stub would report every textarea as empty.
        for (const match of element._html.matchAll(/<textarea[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) {
          const node = doc.node(match[1]);
          if (node) node.value = match[2].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
        }
      }
    });
    return element;
  }
  doc.register('modal-card');
  doc.register('modal');
  return doc;
}

function fixture({ storage: sharedStorage, ...options } = {}) {
  const storage = sharedStorage instanceof Map ? sharedStorage : new Map(), requests = [], listeners = [], closed = { count: 0 };
  const state = {
    owner: 'owner-a', fail: false, status: 0, receipt: null, settings: { collection_enabled: true, response_expectation: null, contact_channel: null, staff: false },
    cases: [], thread: null, replyResult: null, ...options
  };
  const document = documentStub();
  const context = vm.createContext({
    window: { SUPPORT_RECEIPTS: true }, document, crypto: webcrypto, AbortController, setTimeout, clearTimeout,
    addEventListener: (type, handler) => listeners.push({ type, handler }),
    localStorage: {
      get length() { return storage.size; }, key: index => [...storage.keys()][index],
      getItem: key => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key)
    },
    SupaAuth: { active: () => true, uid: () => state.owner, token: async () => 'fresh' },
    Cloud: { base: 'https://fixture.invalid/rest/v1', key: 'fixture', _headers: extra => extra },
    App: { ic: () => '<svg></svg>', closeModal() { closed.count++; document.node('modal')?.classList.add('hidden'); } },
    fetch: async (url, init) => {
      const name = url.split('/rpc/')[1], body = JSON.parse(init.body);
      requests.push({ name, body, headers: init.options?.headers || init.headers });
      if (state.fail) throw Object.assign(new Error('network'), { name: 'TypeError' });
      if (state.status) return { ok: false, status: state.status };
      if (name === 'support_settings') return { ok: true, json: async () => state.settings };
      if (name === 'my_support_cases') return { ok: true, json: async () => state.cases };
      if (name === 'support_thread') return { ok: true, json: async () => state.thread };
      if (name === 'add_support_reply') return { ok: true, json: async () => state.replyResult || { id: body.p_case_id, status: 'in_progress', version: 3, duplicate: false } };
      state.receipt ||= { id: webcrypto.randomUUID(), request_id: body.p_request_id, status: 'open', version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), duplicate: false };
      return { ok: true, json: async () => state.receipt };
    }
  });
  vm.runInContext(source + '\nglobalThis.support = SupportReceipts;', context);
  return { support: context.support, context, state, storage, requests, listeners, closed, document };
}

function supportCase(overrides = {}) {
  return { id: webcrypto.randomUUID(), subject: 'Payment not unlocked', status: 'open', version: 1, message_count: 1,
    created_at: '2026-09-01T10:00:00.000Z', updated_at: '2026-09-01T10:00:00.000Z', ...overrides };
}

function message(overrides = {}) {
  return { id: webcrypto.randomUUID(), author_role: 'member', visibility: 'thread', body: 'I paid but Pro is missing.',
    evidence: [], created_at: '2026-09-01T10:00:00.000Z', author: null, ...overrides };
}

test('with the flag off nothing is sent, stored or rendered', async () => {
  const { support, context, storage, requests, document } = fixture();
  context.window.SUPPORT_RECEIPTS = false;
  assert.equal(await support.submit('Subject', 'Message'), null);
  assert.equal(await support.sendReply(webcrypto.randomUUID(), 'Message'), null);
  await support.open();
  await support.openCase(webcrypto.randomUUID());
  assert.equal(requests.length, 0);
  assert.equal(storage.size, 0);
  assert.equal(document.node('modal').classList.contains('hidden'), true);
  assert.equal(document.node('modal-card').innerHTML, '');
});

test('a lost acknowledgement keeps only an opaque request id and the retry returns the same receipt', async () => {
  const { support, state, storage, requests } = fixture();
  state.fail = true;
  assert.equal(await support.submit('Payment not unlocked', 'I paid but Pro is missing.', ['order-1']), null);
  assert.equal(storage.size, 1);
  assert.equal([...storage.keys()][0], 'fm_support_request_owner-a');
  const stored = JSON.parse([...storage.values()][0]);
  assert.ok(support.uuid(stored.id));
  assert.equal(stored.case, null);
  assert.ok(Number.isFinite(stored.at), 'the retry id carries the moment it was minted so it can age out');
  assert.doesNotMatch([...storage.entries()].join('|'), /Payment|paid|Pro is missing|order-1/);
  assert.match(support.errorFor(JSON.stringify(['owner-a', 'submit'])), /retry when online/i);

  state.fail = false;
  const receipt = await support.submit('Payment not unlocked', 'I paid but Pro is missing.', ['order-1']);
  assert.equal(receipt.id, state.receipt.id);
  assert.equal(receipt.status, 'open');
  assert.equal(requests[0].body.p_request_id, requests[1].body.p_request_id);
  assert.deepEqual(requests[1].body.p_evidence, ['order-1']);
  assert.equal('p_uid' in requests[1].body, false);
  assert.equal(storage.size, 0, 'an acknowledged request must not leave a retry id behind');
});

test('a deliberately changed request conflicts and waits for an explicit new action', async () => {
  const { support, state, storage, requests } = fixture();
  state.status = 409;
  assert.equal(await support.submit('Payment not unlocked', 'A different message.'), null);
  assert.equal(requests.length, 1, 'a conflict must not silently resend');
  assert.equal(storage.size, 0, 'the conflicting request id is released, not reused');
  assert.match(support.errorFor(JSON.stringify(['owner-a', 'submit'])), /already exists.*Your requests/i);

  state.status = 0;
  const receipt = await support.submit('Payment not unlocked', 'A different message.');
  assert.ok(support.uuid(receipt.id));
  assert.notEqual(requests[1].body.p_request_id, requests[0].body.p_request_id);
});

test('duplicate clicks while a submission is pending send exactly one request', async () => {
  const { support, context, requests } = fixture();
  const original = context.fetch;
  let release, started;
  const seen = new Promise(resolve => { started = resolve; });
  context.fetch = async (...args) => { await new Promise(resolve => { release = resolve; started(); }); return original(...args); };
  const first = support.submit('Subject', 'Message'), second = support.submit('Subject', 'Message');
  await seen;
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.id, b.id);
  assert.equal(requests.length, 1);
});

test('an account change or reset discards the in-flight result and clears pending request ids', async () => {
  const { support, context, state, storage } = fixture();
  const original = context.fetch;
  let release, started;
  const seen = new Promise(resolve => { started = resolve; });
  context.fetch = async (...args) => { await new Promise(resolve => { release = resolve; started(); }); return original(...args); };
  const pending = support.submit('Subject', 'Message');
  await seen;
  state.owner = 'owner-b';
  release();
  assert.equal(await pending, null);
  assert.equal(support._failures.size, 0, 'a stale account must not leave an error on the new account');

  const second = fixture();
  second.state.fail = true;
  await second.support.submit('Subject', 'Message');
  second.support._rows = [supportCase()]; second.support._rowOwner = 'owner-a';
  assert.equal(second.storage.size, 1);
  second.support.reset();
  assert.equal(second.storage.size, 0);
  assert.equal(second.support._rows.length, 0);
  assert.equal(second.support._rowOwner, null);
  assert.equal(second.support._failures.size, 0);
  assert.equal(storage.size, 1);
});

test('an acknowledgement that lands after a logout cannot delete a newer retry id', async () => {
  const { support, context, storage } = fixture();
  const original = context.fetch;
  let release, started;
  const seen = new Promise(resolve => { started = resolve; });
  context.fetch = async (...args) => { await new Promise(resolve => { release = resolve; started(); }); return original(...args); };
  const pending = support.submit('Subject', 'Message');
  await seen;
  support.reset();
  assert.equal(storage.size, 0);
  storage.set('fm_support_request_owner-a', webcrypto.randomUUID());
  release();
  assert.equal(await pending, null);
  assert.equal(storage.size, 1, 'the retry id stored by the newer attempt must survive');
});

test('closing the sheet drops the cached thread so private prose is not held in memory', async () => {
  const { support, state, document } = fixture();
  const record = supportCase();
  state.thread = { case: record, messages: [message({ body: 'PRIVATE-THREAD-PROSE' })] };
  await support.openCase(record.id);
  assert.equal(support._messages.length, 1);
  support.close();
  assert.equal(support._messages.length, 0);
  assert.equal(support._threadCase, null);
  assert.equal(document.node('modal-card').innerHTML.includes('PRIVATE-THREAD-PROSE'), false);
});

test('the request list escapes member content and only renders receipts the server returned', async () => {
  const { support, state, document } = fixture();
  const hostile = supportCase({ subject: '<img src=x onerror="alert(1)">', status: 'waiting_customer' });
  state.cases = [hostile];
  await support.open();
  const html = document.node('support-content').innerHTML;
  assert.equal(document.node('modal').classList.contains('hidden'), false);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, new RegExp('Reference ' + hostile.id));
  assert.match(html, /Waiting for your reply/);
  assert.equal(support._rows.length, 1);

  state.cases = [{ id: 'not-a-reference', subject: 'x', status: 'open', version: 1, message_count: 1, created_at: 'nope', updated_at: 'nope' }];
  await support.open();
  assert.match(document.node('support-content').innerHTML, /role="alert"/);
  assert.equal(support._rows.length, 0);
});

test('a member thread escapes staff content and never renders an internal note', async () => {
  const { support, state, document } = fixture();
  const record = supportCase({ status: 'waiting_customer', message_count: 3 });
  state.thread = { case: record, messages: [
    message({ body: '<b>my receipt</b>', evidence: ['order-<1>'] }),
    message({ author_role: 'staff', body: 'Could you send the payment id?' }),
    message({ author_role: 'staff', visibility: 'internal', body: 'INTERNAL-LEDGER-NOTE' })
  ] };
  await support.openCase(record.id);
  const html = document.node('support-content').innerHTML;
  assert.equal(html.includes('INTERNAL-LEDGER-NOTE'), false);
  assert.match(html, /&lt;b&gt;my receipt&lt;\/b&gt;/);
  assert.match(html, /References: order-&lt;1&gt;/);
  assert.match(html, /Could you send the payment id\?/);
  assert.match(html, /id="support-reply"/);

  state.thread = { case: supportCase({ id: record.id, status: 'closed' }), messages: [message()] };
  await support.openCase(record.id);
  const closed = document.node('support-content').innerHTML;
  assert.equal(closed.includes('id="support-reply"'), false);
  assert.match(closed, /closed\. Send a new request/);
});

test('a failed reply keeps the typed draft and reports the failure', async () => {
  const { support, state, document } = fixture();
  const record = supportCase({ status: 'waiting_customer' });
  state.thread = { case: record, messages: [message()] };
  await support.openCase(record.id);
  const editor = document.node('support-reply');
  editor.value = '  Here is the payment id 12345  ';

  state.fail = true;
  await support.submitReply(record.id);
  assert.equal(document.node('support-reply').value, '  Here is the payment id 12345  ');
  assert.equal(document.node('support-send').disabled, false);
  assert.match(document.node('support-error').textContent, /retry when online/i);

  state.fail = false;
  await support.submitReply(record.id);
  assert.equal(document.node('support-reply').value, '');
  assert.equal(support._threadCase, record.id);
});

test('no response time or contact is shown unless the server reports an approved one', async () => {
  const { support, state, document } = fixture();
  state.cases = [supportCase()];
  await support.open();
  assert.equal(document.node('support-content').innerHTML.includes('id="support-note"'), false);

  state.settings = { collection_enabled: true, response_expectation: 'Founder-operated; replies vary.', contact_channel: 'help@example.test <script>', staff: false };
  await support.open();
  const html = document.node('support-content').innerHTML;
  assert.match(html, /Founder-operated; replies vary\. · help@example\.test &lt;script&gt;/);
  assert.doesNotMatch(source, /within \d+\s*(hour|business|day|minute)|24\/7|guarantee|standing by|our support team is/i);
  assert.doesNotMatch(source, /support@formora|mailto:/i);
});

test('timeouts, denials and malformed acknowledgements never claim a saved request', async () => {
  for (const [mode, expected] of [['timeout', /retry when online/i], ['denied', /not being accepted/i], ['shape', /retry when online/i]]) {
    const { support, context, state, storage } = fixture();
    if (mode === 'timeout') context.fetch = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
    if (mode === 'denied') state.status = 503;
    if (mode === 'shape') context.fetch = async () => ({ ok: true, json: async () => ({ id: 'nope', status: 'open', version: 1 }) });
    assert.equal(await support.submit('Subject', 'Message'), null);
    assert.equal(support._pending.size, 0);
    if (mode !== 'shape') assert.match(support.errorFor(JSON.stringify(['owner-a', 'submit'])), expected);
    assert.equal(storage.size, mode === 'denied' ? 1 : 1, 'a request that was never acknowledged keeps its retry id');
  }
  const { support } = fixture();
  assert.equal(await support.submit('', 'Message'), null);
  assert.equal(await support.submit('Subject', '   '), null);
  assert.equal(await support.submit('x'.repeat(121), 'Message'), null);
  assert.equal(await support.submit('Subject', 'x'.repeat(2001)), null);
  assert.equal(await support.sendReply('not-a-uuid', 'Message'), null);
});

test('a lost reply acknowledgement is held per case, so replying to a second case cannot duplicate the first', async () => {
  const { support, state, storage, requests } = fixture();
  const caseA = webcrypto.randomUUID(), caseB = webcrypto.randomUUID();
  state.fail = true;
  assert.equal(await support.sendReply(caseA, 'Here is the payment id.'), null);
  const heldA = storage.get('fm_support_reply_owner-a_' + caseA);
  assert.ok(heldA, 'a reply retry id is stored under its own case, not a shared owner slot');
  assert.equal(JSON.parse(heldA).case, caseA);
  assert.ok(support.uuid(JSON.parse(heldA).id));
  assert.doesNotMatch([...storage.entries()].join('|'), /payment id/);

  state.fail = false;
  assert.equal((await support.sendReply(caseB, 'A different case entirely.')).id, caseB);
  assert.equal(storage.has('fm_support_reply_owner-a_' + caseB), false, 'an acknowledged reply releases only its own slot');
  assert.equal(storage.get('fm_support_reply_owner-a_' + caseA), heldA, "case A's retry id must survive a send to case B");

  assert.equal((await support.sendReply(caseA, 'Here is the payment id.')).id, caseA);
  const forA = requests.filter(entry => entry.name === 'add_support_reply' && entry.body.p_case_id === caseA);
  assert.equal(forA.length, 2);
  assert.equal(forA[0].body.p_request_id, forA[1].body.p_request_id,
    'the retry must reuse the id the server anchors idempotency on, or it commits a second copy');
  assert.equal(storage.size, 0);
});

test('the rendered close control clears the module before the app closes the modal, and the listeners bind only when enabled', async () => {
  const off = fixture();
  off.context.window.SUPPORT_RECEIPTS = false;
  off.support._observe();
  await off.support.open();
  await off.support.openCase(webcrypto.randomUUID());
  assert.deepEqual(off.listeners, [], 'loading the module with the flag off registers nothing');
  assert.equal(off.storage.size, 0);

  const { support, state, document, listeners, closed } = fixture();
  const record = supportCase();
  state.thread = { case: record, messages: [message({ body: 'PRIVATE-THREAD-PROSE' })] };
  await support.openCase(record.id);
  assert.match(document.node('modal-card').innerHTML, /onclick="SupportReceipts\.dismiss\(\)"/);
  assert.equal(document.node('modal-card').innerHTML.includes('App.closeModal()'), false);
  assert.deepEqual(listeners.map(entry => entry.type).sort(), ['formora:modalclose', 'formora:sessionchange', 'pagehide']);

  support.dismiss();
  assert.equal(closed.count, 1, 'the module still asks the app to close the modal');
  assert.equal(support._messages.length, 0);
  assert.equal(support._threadCase, null);
  assert.equal(document.node('modal-card').innerHTML.includes('PRIVATE-THREAD-PROSE'), false);
  assert.equal(document.node('modal').classList.contains('hidden'), true);

  // Standalone: a session change or a page leaving must drop the thread even before a parent
  // wires close()/reset() into its own closeModal and logout paths.
  support._rows = [record]; support._rowOwner = 'owner-a'; support._settings = { collection_enabled: true };
  listeners.find(entry => entry.type === 'formora:sessionchange').handler();
  assert.equal(support._rows.length, 0);
  assert.equal(support._rowOwner, null);
  assert.equal(support._settings, null);
  listeners.find(entry => entry.type === 'formora:modalclose').handler();
  listeners.find(entry => entry.type === 'pagehide').handler();
  assert.equal(support._messages.length, 0);
});

test('a paused intake reads as a read-only request instead of a reply box that only fails on send', async () => {
  const { support, state, document, requests } = fixture();
  const record = supportCase({ status: 'waiting_customer' });
  state.thread = { case: record, messages: [message()] };
  state.settings = { collection_enabled: false, response_expectation: null, contact_channel: null, staff: false };
  await support.openCase(record.id);
  const paused = document.node('support-content').innerHTML;
  assert.deepEqual(requests.map(entry => entry.name), ['support_settings', 'support_thread'],
    'settings are read fresh before the composer gate, including on a deep-linked case');
  assert.equal(paused.includes('id="support-reply"'), false);
  assert.equal(paused.includes('id="support-send"'), false);
  assert.match(paused, /Replies are paused right now/);
  assert.match(paused, new RegExp('Reference ' + record.id));
  assert.equal(support._threadCase, record.id, 'the thread still reads, it is only the composer that is gated');

  state.settings = { collection_enabled: true, response_expectation: null, contact_channel: null, staff: false };
  await support.openCase(record.id);
  assert.match(document.node('support-content').innerHTML, /id="support-reply"/);

  // A gate that closes while the member was typing states the change and hands the text back
  // to read and copy; it is never deleted without a word.
  document.node('support-reply').value = 'Typed while the intake was still open';
  state.settings = { collection_enabled: false, response_expectation: null, contact_channel: null, staff: false };
  await support.openCase(record.id);
  const kept = document.node('support-content').innerHTML;
  assert.match(kept, /Your unsent reply/);
  assert.match(kept, /Typed while the intake was still open/);
  assert.equal(kept.includes('id="support-send"'), false);
});

test('text typed while a reply is in flight survives the acknowledgement and the re-render', async () => {
  const { support, context, state, document } = fixture();
  const record = supportCase({ status: 'waiting_customer' });
  state.thread = { case: record, messages: [message()] };
  await support.openCase(record.id);
  const editor = document.node('support-reply');
  editor.value = 'Here is the payment id 12345';

  const original = context.fetch;
  let release, started;
  const seen = new Promise(resolve => { started = resolve; });
  context.fetch = async (url, init) => {
    if (url.endsWith('/add_support_reply')) await new Promise(resolve => { release = resolve; started(); });
    return original(url, init);
  };
  const sending = support.submitReply(record.id);
  await seen;
  const typed = 'Here is the payment id 12345 and one more thing I forgot';
  editor.value = typed;
  release();
  await sending;
  assert.equal(document.node('support-reply').value, typed, 'nothing typed during the send is discarded by the re-render');
  assert.equal(document.node('support-error').textContent, '');
  assert.equal(support._threadCase, record.id);

  // A load for a different case starts empty, so a late result cannot paste one member's
  // draft into another thread.
  const other = supportCase({ status: 'waiting_customer' });
  state.thread = { case: other, messages: [message()] };
  await support.openCase(other.id);
  assert.equal(document.node('support-reply').value, '');
});

test('a transport that ignores the abort signal still settles the call within the hard deadline', async () => {
  const { support, context } = fixture();
  const clock = [];
  context.setTimeout = (handler, delay) => { clock.push({ handler, delay }); return clock.length; };
  context.clearTimeout = () => {};
  context.fetch = () => new Promise(() => {});
  const pending = support.submit('Subject', 'Message');
  await new Promise(resolve => setTimeout(resolve, 0));
  const deadline = clock.find(entry => entry.delay === 10000);
  assert.ok(deadline, 'every call arms one overall deadline, not only an abort the transport may ignore');
  deadline.handler();
  assert.equal(await pending, null, 'a never-settling transport must not leave the promise pending for ever');
  assert.equal(support._pending.size, 0);
  assert.match(support.errorFor(JSON.stringify(['owner-a', 'submit'])), /retry when online/i);
});

// Two vm contexts over one storage map is the honest stand-in for a reload: the page and its RAM
// are gone, the device storage is not. It does not model a real browser's unload timing.
test('a page leaving keeps the opaque retry id, so the reload retries the same request instead of committing a second copy', async () => {
  const shared = new Map();
  const first = fixture({ storage: shared });
  first.state.fail = true;
  assert.equal(await first.support.submit('Payment not unlocked', 'I paid but Pro is missing.'), null);
  const held = JSON.parse(shared.get('fm_support_request_owner-a')).id;
  assert.ok(first.support.uuid(held));

  first.listeners.find(entry => entry.type === 'pagehide').handler();
  assert.equal(shared.size, 1, 'a page leaving is not an account change and must not drop the retry anchor');
  assert.equal(shared.get('fm_support_request_owner-a').includes(held), true);
  assert.equal(first.support._messages.length, 0, 'the private thread is still dropped from memory');
  assert.equal(first.support._threadCase, null);
  assert.equal(first.document.node('modal').classList.contains('hidden'), true);

  const reloaded = fixture({ storage: shared });
  const receipt = await reloaded.support.submit('Payment not unlocked', 'I paid but Pro is missing.');
  assert.equal(reloaded.requests.length, 1);
  assert.equal(reloaded.requests[0].body.p_request_id, held,
    'the reload must send the id the server anchors on, or the two attempts commit two cases instead of one');
  assert.ok(reloaded.support.uuid(receipt.id));
  assert.equal(shared.size, 0, 'an acknowledged request releases its id');

  // An account change is still a purge, and a retained id is still time bounded.
  const changed = fixture({ storage: shared });
  changed.state.fail = true;
  await changed.support.submit('Subject', 'Message');
  assert.equal(shared.size, 1);
  changed.support.reset();
  assert.equal(shared.size, 0);

  const aged = fixture({ storage: shared });
  aged.state.fail = true;
  await aged.support.submit('Subject', 'Message');
  const stale = JSON.parse(shared.get('fm_support_request_owner-a'));
  shared.set('fm_support_request_owner-a', JSON.stringify({ ...stale, at: Date.now() - 90000000 }));
  await aged.support.submit('Subject', 'Message');
  assert.notEqual(aged.requests[1].body.p_request_id, stale.id, 'a retry id past its window is not reused for ever');
});

test('a reply that is acknowledged but re-renders into an error still holds the unsent remainder for the retry', async () => {
  const { support, context, state, document } = fixture({ settingsFail: false });
  const record = supportCase({ status: 'waiting_customer' });
  state.thread = { case: record, messages: [message()] };
  await support.openCase(record.id);
  document.node('support-reply').value = 'Here is the payment id 12345';

  const original = context.fetch;
  let release, started;
  const seen = new Promise(resolve => { started = resolve; });
  context.fetch = async (url, init) => {
    if (url.endsWith('/add_support_reply')) await new Promise(resolve => { release = resolve; started(); });
    if (url.endsWith('/support_settings') && state.settingsFail) throw Object.assign(new Error('network'), { name: 'TypeError' });
    return original(url, init);
  };
  const sending = support.submitReply(record.id);
  await seen;
  const remainder = 'Here is the payment id 12345 and the refund reference too';
  document.node('support-reply').value = remainder;
  state.settingsFail = true;
  release();
  await sending;

  const errored = document.node('support-content').innerHTML;
  assert.match(errored, /role="alert"/, 'the re-render after the send failed, so the composer is gone');
  assert.equal(errored.includes(remainder), false, 'the error panel renders no field, so it must not carry the prose in markup');
  assert.equal(support.draftFor(record.id), remainder, 'the unsent remainder is held for the case, not left in a destroyed element');

  state.settingsFail = false;
  await support.openCase(record.id);
  assert.equal(document.node('support-reply').value, remainder,
    'the retry control passes no draft, so the value has to come back from the case it belongs to');
  assert.equal(document.node('support-error').textContent, '');
});

test('a paused thread keeps the unsent reply when older messages are loaded, and never lends it to another case', async () => {
  const { support, state, document } = fixture();
  const record = supportCase({ status: 'waiting_customer', message_count: 60 });
  state.thread = { case: record, messages: Array.from({ length: 50 }, () => message()) };
  await support.openCase(record.id);
  const written = 'Draft written while replies were still open';
  document.node('support-reply').value = written;

  state.settings = { collection_enabled: false, response_expectation: null, contact_channel: null, staff: false };
  await support.openCase(record.id);
  const paused = document.node('support-content').innerHTML;
  assert.match(paused, /id="support-draft"/);
  assert.match(paused, /Load more messages/);
  assert.equal(paused.includes('id="support-reply"'), false);
  assert.equal(document.node('support-draft').value, written);

  await support.openCase(record.id, true);
  assert.equal(document.node('support-draft').value, written,
    'loading older messages read only the composer id, so a paused thread silently lost the draft');
  assert.equal(support.draftFor(record.id), written);
  assert.equal(support._threadCase, record.id);

  const other = supportCase({ status: 'waiting_customer' });
  state.thread = { case: other, messages: [message()] };
  await support.openCase(other.id);
  assert.equal(document.node('support-content').innerHTML.includes(written), false, "another case must not inherit this case's draft");
  assert.equal(support.draftFor(other.id), '');
  assert.equal(support.draftFor(record.id), written, 'the draft stays with the case it was written for');

  support.close();
  assert.equal(support.draftFor(record.id), '', 'closing the sheet drops the unsent prose with the rest of the private state');
});
