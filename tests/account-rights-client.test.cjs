'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { webcrypto, randomUUID, createHash } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const source = fs.readFileSync(path.join(__dirname, '../js/mod/account-rights.js'), 'utf8');
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const scopes = { export: 'account_profile_logs_v1', erasure: 'account_erasure_review_v1' };
const clone = value => JSON.parse(JSON.stringify(value));
function response(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
function makeReceipt(uid, requestId, kind, scope = scopes[kind]) {
  return { id: randomUUID(), request_id: requestId, requester: uid, kind, scope, status: 'received', version: 1,
    created_at: '2026-09-06T10:00:00.123456+00:00', updated_at: '2026-09-06T10:00:00.123456+00:00', cancel_allowed: true,
    account_deleted: false, execution_allowed: false, snapshot_status: 'not_prepared', release_allowed: false, hold_status: 'clear', hold_version: 0 };
}
function fixture(overrides = {}) {
  const stored = overrides.stored || new Map(), requests = [];
  const state = { owner, token: 'mapped-token-a', receipts: new Map(), releases: new Map(), cachedBytes: new Map(), failAfterCommit: false, onRequest: null, ...overrides.state };
  const tokens = new Map([['mapped-token-a', owner], ['mapped-token-b', other]]);
  const storage = { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) };
  const fetch = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    const call = { url, options, body }; requests.push(call);
    if (state.onRequest) { const custom = await state.onRequest(call); if (custom) return custom; }
    const uid = tokens.get(options.headers.Authorization.replace('Bearer ', ''));
    if (!uid) return response({}, 401);
    if (url.endsWith('/auth/v1/user')) return response({ id: uid });
    const name = url.split('/').at(-1);
    if (name === 'submit_account_rights_request') {
      const key = uid + ':' + body.p_request_id;
      let row = state.receipts.get(key);
      if (row && (row.kind !== body.p_kind || row.scope !== body.p_payload.scope)) return response({}, 409);
      if (!row) { row = makeReceipt(uid, body.p_request_id, body.p_kind, body.p_payload.scope); state.receipts.set(key, row); }
      if (state.failAfterCommit) throw new TypeError('synthetic lost acknowledgement');
      return response(row);
    }
    const row = [...state.receipts.values()].find(item => item.id === body?.p_id && item.requester === uid);
    if (name === 'my_account_rights_request') return response(row || {}, row ? 200 : 404);
    if (name === 'my_account_rights_requests') return response({ requester: uid, items: [...state.receipts.values()].filter(item => item.requester === uid).slice(0, 25), has_more: false, next_cursor: null });
    if (name === 'cancel_account_rights_request' && row) {
      if (row.status !== 'cancelled') row.version++;
      row.status = 'cancelled'; row.cancel_allowed = false; row.release_allowed = false;
      if (row.snapshot_status === 'available') row.snapshot_status = 'released';
      if (state.failAfterCommit) throw new TypeError('synthetic lost cancellation acknowledgement');
      return response(row);
    }
    if (name === 'release_my_account_rights_export' && row) {
      let result = state.releases.get(body.p_operation_id);
      if (!result) {
        if (row.version !== body.p_version || row.snapshot_status !== 'available' || row.hold_status !== 'clear') return response({}, 409);
        row.version++; row.snapshot_status = 'released'; row.release_allowed = false; row.cancel_allowed = false;
        if (!['cancelled', 'superseded'].includes(row.status)) row.status = 'export_released';
        result = { schema_version: 1, operation_id: body.p_operation_id, operation_status: 'committed', action: 'release_export',
          scope: 'cached_export_only', request_ref: row.id, requester: uid, released_bytes: state.cachedBytes.get(row.id), source_data_deleted: false, receipt: clone(row) };
        state.releases.set(body.p_operation_id, result); state.cachedBytes.delete(row.id);
      }
      if (state.failAfterCommit) throw new TypeError('synthetic lost release acknowledgement');
      return response(result);
    }
    return response({}, 404);
  };
  const listeners = new Map();
  const context = vm.createContext({ crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, URL: overrides.dom?.URL || URL, Blob, Response,
    AbortController, setTimeout, clearTimeout, console, fetch, atob, document: overrides.dom?.document,
    addEventListener: (name, listener) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
    removeEventListener: (name, listener) => listeners.get(name)?.delete(listener), ...overrides.globals });
  context.globalThis = context; context.window = context;
  vm.runInContext(source, context);
  const options = { enabled: true, url: 'https://fixture.invalid', anonKey: 'public-fixture-key', storage,
    getAuth: () => ({ active: () => true, uid: () => state.owner, token: async () => state.token }), ...overrides.options };
  const api = context.AccountRights.create(options);
  return { api, context, state, stored, storage, requests, options, fetch, emit: name => { for (const listener of listeners.get(name) || []) listener(); } };
}

test('default-off factory has no collection or network activity and never falls back to anonymous writes', async () => {
  const { context, requests } = fixture();
  assert.equal(context.AccountRights.enabled(), false); assert.equal(requests.length, 0);
  await assert.rejects(context.AccountRights.requestExport(), { code: 'disabled' });
  assert.equal(requests.length, 0);
});

test('owner is server-confirmed before RPC; receipts are exact and contain no client-supplied actor/time', async () => {
  const { api, requests, stored } = fixture(); const row = await api.requestExport();
  assert.equal(row.requester, owner); assert.equal(row.status, 'received'); assert.equal(row.account_deleted, false);
  assert.ok(requests[0].url.endsWith('/auth/v1/user'));
  assert.deepEqual(Object.keys(requests[1].body).sort(), ['p_kind','p_payload','p_request_id']);
  assert.deepEqual(requests[1].body.p_payload, { schema_version: 1, scope: scopes.export });
  assert.equal(requests[1].options.headers.Authorization, 'Bearer mapped-token-a');
  assert.equal(requests[1].options.credentials, 'omit'); assert.equal(requests[1].options.cache, 'no-store');
  assert.equal(requests[1].options.redirect, 'error'); assert.equal(stored.size, 0);
});

test('v2 is opt-in with a distinct retained retry identity; default v1 submissions remain unchanged', async () => {
  const current = fixture(), expanded = 'account_server_personal_v2';
  current.state.failAfterCommit = true;
  await assert.rejects(current.api.requestExport());
  const legacy = current.requests.at(-1).body;
  await assert.rejects(current.api.requestExport(expanded));
  const next = current.requests.at(-1).body;
  assert.notEqual(next.p_request_id, legacy.p_request_id);
  assert.deepEqual(next.p_payload, { schema_version: 2, scope: expanded });
  assert.deepEqual(legacy.p_payload, { schema_version: 1, scope: scopes.export });
  assert.equal(current.stored.size, 2);
  current.state.failAfterCommit = false;
  assert.equal((await current.api.requestExport(expanded)).request_id, next.p_request_id);
  assert.equal((await current.api.requestExport()).request_id, legacy.p_request_id);
  assert.equal(current.stored.size, 0);
  const count = current.requests.length;
  for (const bad of ['account_all_data_v2', null, {}, 2]) await assert.rejects(current.api.requestExport(bad), { code: 'invalid_request' });
  assert.equal(current.requests.length, count);
  assert.equal(current.api.exportScopes[expanded].label, 'Known server personal records (v2)');
});

test('v2 scope cannot be substituted in submission acknowledgements or between immutable byte pages', async () => {
  const current = fixture();
  current.state.onRequest = call => call.url.endsWith('/submit_account_rights_request')
    ? response(makeReceipt(owner, call.body.p_request_id, 'export')) : null;
  await assert.rejects(current.api.requestExport('account_server_personal_v2'), { code: 'invalid_response' });
  assert.equal(current.stored.size, 1);
  const saved = [], download = fixture({ options: { saveArchive: archive => saved.push(archive) } });
  archiveFixture(download, page => { if (page.offset > 0) page.receipt.scope = 'account_server_personal_v2'; });
  const row = await download.api.requestExport();
  await assert.rejects(download.api.downloadExport(row.id), { code: 'invalid_response' });
  assert.equal(saved.length, 0);
});

test('lost acknowledgements retry the same UUID across factory recreation and store only opaque identifiers', async () => {
  const first = fixture(); first.state.failAfterCommit = true;
  await assert.rejects(first.api.requestExport(), { code: 'unavailable' });
  assert.equal(first.stored.size, 1);
  for (const value of first.stored.values()) assert.match(value, /^[a-f0-9-]{36}$/);
  const second = fixture({ stored: first.stored, state: { receipts: first.state.receipts } });
  const row = await second.api.requestExport();
  assert.equal(row.request_id, first.requests[1].body.p_request_id);
  assert.equal(second.requests[1].body.p_request_id, first.requests[1].body.p_request_id);
  assert.equal(second.state.receipts.size, 1); assert.equal(second.stored.size, 0);
});

test('explicit erasure confirmation is mandatory and parent reauthentication is independently verified', async () => {
  let authenticationCalls = 0;
  const { api, state, requests } = fixture({ options: { reauthenticate: async ({ requester }) => { assert.equal(requester, owner); authenticationCalls++; return true; } } });
  for (const confirmed of [undefined, false, 'true', 1]) await assert.rejects(api.requestErasure({ confirmed }), { code: 'confirmation_required' });
  assert.equal(requests.length, 0);
  assert.deepEqual(clone(await api.reauthenticate()), { requester: owner }); assert.equal(authenticationCalls, 1);
  const row = await api.requestErasure({ confirmed: true });
  assert.equal(row.kind, 'erasure'); assert.equal(row.account_deleted, false);
  assert.equal(requests.at(-1).body.p_payload.confirmed, true);
  state.owner = other; state.token = 'mapped-token-a';
  await assert.rejects(api.requestErasure({ confirmed: true }), { code: 'identity_mismatch' });
});

test('expired tokens, unavailable retry storage and wrong-owner server identities prevent all mutations', async () => {
  for (const kind of ['expired', 'owner', 'storage']) {
    const current = fixture();
    if (kind === 'expired') current.state.token = 'expired-mapped-token';
    if (kind === 'owner') current.state.owner = other;
    if (kind === 'storage') current.storage.setItem = () => { throw new Error('synthetic quota'); };
    await assert.rejects(current.api.requestExport());
    assert.equal(current.requests.filter(call => call.options.method === 'POST').length, 0, kind);
  }
});

test('duplicate in-flight clicks submit once; account changes and resets fence late acknowledgements', async () => {
  for (const change of ['owner', 'reset']) {
    const current = fixture(); let release, started;
    const seen = new Promise(resolve => { started = resolve; });
    current.state.onRequest = async call => {
      if (call.options.method === 'POST') await new Promise(resolve => { release = resolve; started(); });
    };
    const first = current.api.requestExport(), duplicate = current.api.requestExport();
    await seen;
    if (change === 'owner') { current.state.owner = other; current.state.token = 'mapped-token-b'; } else current.api.reset();
    release();
    const outcomes = await Promise.allSettled([first, duplicate]);
    assert.ok(outcomes.every(result => result.status === 'rejected' && result.reason.code === 'account_changed'));
    assert.equal(current.requests.filter(call => call.options.method === 'POST').length, 1);
    assert.equal(current.stored.size, 1);
  }
});

test('malformed, other-owner and oversized responses never confirm a request or discard its retry identity', async () => {
  for (const kind of ['shape', 'owner', 'oversize', 'prose', 'deletion']) {
    const current = fixture();
    current.state.onRequest = async call => {
      if (call.options.method !== 'POST') return;
      const row = makeReceipt(owner, call.body.p_request_id, 'export');
      if (kind === 'shape') delete row.id;
      if (kind === 'owner') row.requester = other;
      if (kind === 'prose') row.other_user_report = 'do-not-deliver';
      if (kind === 'deletion') row.account_deleted = true;
      return kind === 'oversize' ? response({ huge: 'x'.repeat(140000) }) : response(row);
    };
    await assert.rejects(current.api.requestExport(), { code: 'invalid_response' });
    assert.equal(current.stored.size, 1, kind);
  }
});

test('private history rejects leaked audit fields and pagination preserves the server microsecond cursor', async () => {
  const current = fixture(), row = await current.api.requestExport();
  const cursor = { id: randomUUID(), created_at: '2026-09-06T10:00:00.987654+00:00' };
  await current.api.listRequests(cursor);
  assert.equal(current.requests.at(-1).body.p_before, cursor.created_at);
  current.state.onRequest = call => {
    if (call.url.endsWith('/my_account_rights_history')) return response({ requester: owner, request_ref: row.id, items: [{
      id: randomUUID(), action: 'review', version: 2, from_status: 'received', to_status: 'under_review', created_at: row.created_at,
      actor_id: other, payload: { evidence_ref: randomUUID() } }], has_more: false, next_before_version: null });
  };
  await assert.rejects(current.api.history(row.id), { code: 'invalid_response' });
});

test('cancellation preserves its operation UUID after lost response and acknowledges no account deletion', async () => {
  const current = fixture(), row = await current.api.requestExport();
  current.state.failAfterCommit = true; await assert.rejects(current.api.cancel(row));
  const sent = current.requests.at(-1).body;
  current.state.failAfterCommit = false;
  const result = await current.api.cancel(row);
  assert.equal(current.requests.at(-1).body.p_operation_id, sent.p_operation_id);
  assert.equal(result.status, 'cancelled'); assert.equal(result.account_deleted, false);
  assert.equal(current.stored.size, 0);
});

test('a queued click cannot silently move to a new account before its first asynchronous step', async () => {
  const current = fixture(); const request = current.api.requestExport();
  current.state.owner = other; current.state.token = 'mapped-token-b';
  await assert.rejects(request, { code: 'account_changed' });
  assert.equal(current.requests.length, 0);
});

function archiveFixture(current, tamper = null, contentChange = null) {
  let bytes, header;
  current.state.onRequest = async call => {
    const row = [...current.state.receipts.values()].find(value => value.id === call.body?.p_id);
    if (call.url.endsWith('/prepare_account_rights_export')) {
      row.status = 'export_ready'; row.version = 2; row.snapshot_status = 'available'; row.release_allowed = true;
      const content = { schema: 'formora.account-rights', schema_version: 1, scope: scopes.export, request_ref: row.id,
        requester: owner, generated_at: row.created_at, provenance: { source: 'synthetic archive fixture' }, projection: {},
        exclusions: ['shared messages and report prose'], data: { identity: { id: owner }, profile: { bio: 'x'.repeat(70000) } },
        request_history: { requests: [row], actions: [] } };
      if (contentChange) contentChange(content, row);
      bytes = Buffer.from(JSON.stringify(content));
      header = { schema_version: 1, request_ref: row.id, requester: owner, generated_at: row.created_at,
        total_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), max_chunk_bytes: 32768,
        operation_id: call.body.p_operation_id, operation_status: 'committed' };
      current.state.cachedBytes.set(row.id, bytes.length);
      return response({ ...header, receipt: row });
    }
    if (call.url.endsWith('/read_account_rights_export')) {
      const start = call.body.p_offset, end = Math.min(bytes.length, start + call.body.p_limit);
      const page = { ...header, receipt: clone(row), offset: start, next_offset: end, complete: end === bytes.length, chunk_base64: bytes.subarray(start, end).toString('base64') };
      if (tamper) await tamper(page, current, call);
      return response(page);
    }
  };
}

test('download assembles all bounded byte pages, verifies digest and produces only a private JSON Blob', async () => {
  const saved = [], current = fixture({ options: { saveArchive: archive => saved.push(archive) } });
  archiveFixture(current); const row = await current.api.requestExport();
  const archive = await current.api.downloadExport(row.id);
  assert.equal(saved.length, 1); assert.equal(archive.blob.type, 'application/json');
  assert.equal(archive.blob.size, archive.total_bytes); assert.ok(archive.total_bytes > 65536);
  assert.equal(JSON.parse(await archive.blob.text()).requester, owner);
  assert.equal(current.requests.filter(call => call.url.endsWith('/read_account_rights_export')).length, 3);
  assert.ok(current.requests.every(call => !call.url.includes('/storage/')));
  assert.match(archive.filename, /^formora-account-[a-f0-9-]+\.json$/);
});

test('wrong owner, gaps, forged totals, truncated chunks and hash corruption never save partial archives', async () => {
  for (const kind of ['owner', 'gap', 'total', 'truncated', 'digest', 'base64', 'incomplete']) {
    const saved = [], current = fixture({ options: { saveArchive: archive => saved.push(archive) } });
    archiveFixture(current, page => {
      if (kind === 'owner') page.requester = other;
      if (kind === 'gap') page.next_offset++;
      if (kind === 'total') page.total_bytes = 8388609;
      if (kind === 'truncated') page.chunk_base64 = 'e30=';
      if (kind === 'digest') page.chunk_base64 = Buffer.alloc(page.next_offset - page.offset, 65).toString('base64');
      if (kind === 'base64') page.chunk_base64 = 'not base64';
      if (kind === 'incomplete') page.complete = !page.complete;
    });
    const row = await current.api.requestExport();
    await assert.rejects(current.api.downloadExport(row.id), { code: 'invalid_response' });
    assert.equal(saved.length, 0, kind);
  }
});

test('network interruption retries the immutable export and account invalidation prevents late download', async () => {
  for (const mode of ['interrupted', 'account']) {
    const saved = [], current = fixture({ options: { saveArchive: archive => saved.push(archive) } });
    let failed = false;
    archiveFixture(current, (page, fixture) => {
      if (page.offset === 32768 && !failed) {
        failed = true;
        if (mode === 'interrupted') throw new TypeError('synthetic disconnected page');
        fixture.api.reset(); fixture.state.owner = other; fixture.state.token = 'mapped-token-b';
      }
    });
    const row = await current.api.requestExport(); await assert.rejects(current.api.downloadExport(row.id));
    assert.equal(saved.length, 0);
    if (mode === 'interrupted') {
      const archive = await current.api.downloadExport(row.id);
      assert.equal(saved.length, 1); assert.equal(archive.requester, owner);
      assert.equal(current.requests.filter(call => call.url.endsWith('/prepare_account_rights_export')).length, 1);
    }
  }
});

test('VM DOM/client executes the actual PGlite SQL lifecycle with synthetic mapped tokens, not GoTrue', async context => {
  const db = new PGlite(); context.after(() => db.close());
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claims',true),'')::jsonb $$;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,created_at timestamptz DEFAULT clock_timestamp());
    CREATE TABLE accounts(uid text PRIMARY KEY,data jsonb,updated_at timestamptz DEFAULT clock_timestamp());
    CREATE TABLE profiles(uid text PRIMARY KEY,data jsonb);
    CREATE TABLE report_cases(id uuid PRIMARY KEY,reporter uuid,reported_uid text);
    CREATE TABLE report_evidence_holds(case_id uuid,hold_ref uuid);
    INSERT INTO auth.users(id,email) VALUES('${owner}','synthetic-a@example.test'),('${other}','synthetic-b@example.test');
    INSERT INTO profiles VALUES('${owner}','{"name":"Synthetic A"}'),('${other}','{"name":"Synthetic B"}');`);
  await db.exec(fs.readFileSync(path.join(__dirname, '../supabase/account-rights.sql'), 'utf8'));
  const logs = Array.from({ length: 1001 }, (value, index) => ({ date: '2026-09-01', kg: index + 50 }));
  await db.query('INSERT INTO accounts(uid,data) VALUES($1,$2),($3,$4)', [owner, JSON.stringify({ profile: { name: 'Synthetic A' }, weightLog: logs, messages: [{ from_uid: other, body: 'do-not-export-shared-prose' }] }), other, '{"profile":{"name":"Synthetic B"}}']);
  const originals = (await db.query('SELECT uid,data FROM accounts ORDER BY uid')).rows;
  const parameters = {
    submit_account_rights_request: ['p_request_id','p_kind','p_payload'], my_account_rights_request: ['p_id'],
    my_account_rights_requests: ['p_before','p_before_id','p_limit'], my_account_rights_history: ['p_id','p_before_version','p_limit'],
    cancel_account_rights_request: ['p_id','p_version','p_operation_id'], prepare_account_rights_export: ['p_id','p_version','p_operation_id'],
    read_account_rights_export: ['p_id','p_offset','p_limit'], release_my_account_rights_export: ['p_id','p_version','p_operation_id']
  };
  let losePreparation = true, fresh = true; const calls = [];
  const sqlFetch = async (url, options) => {
    calls.push({ url, options });
    const uid = options.headers.Authorization === 'Bearer mapped-token-a' ? owner : options.headers.Authorization === 'Bearer mapped-token-b' ? other : null;
    if (!uid) return response({}, 401);
    await db.exec('RESET ROLE');
    if (url.endsWith('/auth/v1/user')) return response((await db.query('SELECT id FROM auth.users WHERE id=$1', [uid])).rows[0]);
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [uid,
      JSON.stringify({ amr: [{ method: 'password', timestamp: Date.now() / 1000 - (fresh ? 0 : 600) }] })]);
    await db.exec('SET ROLE authenticated');
    const name = url.split('/').at(-1), body = JSON.parse(options.body), keys = parameters[name];
    assert.ok(keys); assert.deepEqual(Object.keys(body).sort(), [...keys].sort());
    try {
      const args = keys.map(key => objectValue(body[key]));
      const result = (await db.query('SELECT public.' + name + '(' + keys.map((key, index) => '$' + (index + 1)).join(',') + ') AS value', args)).rows[0].value;
      if (name === 'prepare_account_rights_export' && losePreparation) { losePreparation = false; throw new TypeError('synthetic acknowledgement lost after SQL commit'); }
      return response(result);
    } catch (error) {
      if (error instanceof TypeError) throw error;
      const status = /^PT\d{3}$/.test(error.code) ? Number(error.code.slice(2)) : error.code === '42501' ? 403 : 400;
      return response({ code: error.code }, status);
    }
  };
  function objectValue(value) { return value && typeof value === 'object' ? JSON.stringify(value) : value; }
  const saved = [], dom = domFixture(), current = fixture({ dom, options: { fetch: sqlFetch, saveArchive: archive => saved.push(archive), reauthenticate: async () => { fresh = true; return true; } } });
  await current.api.open(dom.host); await dom.button('Request export').click();
  const exportRequest = (await current.api.listRequests()).items[0];
  await assert.rejects(current.api.prepareExport(exportRequest.id), { code: 'unavailable' });
  assert.equal((await current.api.getRequest(exportRequest.id)).status, 'export_ready');
  await dom.button('Download export').click(); const result = saved[0];
  const content = JSON.parse(await result.blob.text());
  assert.deepEqual(content.data.account.state.weightLog, logs);
  assert.doesNotMatch(await result.blob.text(), new RegExp(other + '|do-not-export-shared-prose'));
  assert.equal(saved.length, 1); assert.ok(calls.filter(call => call.url.endsWith('/read_account_rights_export')).length > 1);
  await dom.button('Remove cached export').click(); await dom.button('Confirm cached export removal').click();
  assert.match(dom.host.textContent, /Cached server export removed/);
  assert.equal((await current.api.getRequest(exportRequest.id)).snapshot_status, 'released');
  fresh = false;
  await assert.rejects(current.api.requestErasure({ confirmed: true }), { status: 401 });
  await dom.button('Request erasure').click(); await dom.host.querySelectorAll('input')[0].click();
  await dom.button('Confirm erasure request').click();
  const erasure = (await current.api.listRequests()).items.find(row => row.kind === 'erasure');
  assert.match(dom.host.textContent, /Request received\. Account erasure has not been executed/);
  const erasureRow = dom.host.querySelectorAll('section').find(node => node.dataset.requestId === erasure.id);
  await erasureRow.querySelectorAll('button').find(node => node.textContent === 'Cancel request').click();
  const cancelled = await current.api.getRequest(erasure.id); assert.equal(cancelled.status, 'cancelled');
  assert.equal((await current.api.history(erasure.id)).items.length, 2);
  current.api.reset(); current.state.owner = other; current.state.token = 'mapped-token-b';
  assert.equal((await current.api.listRequests()).items.length, 0);
  await assert.rejects(current.api.getRequest(erasure.id), { status: 404 });
  await assert.rejects(current.api.downloadExport(exportRequest.id), { status: 404 });
  await db.exec('RESET ROLE');
  assert.deepEqual((await db.query('SELECT uid,data FROM accounts ORDER BY uid')).rows, originals);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM account_rights_exports')).rows[0].count, 0);
  current.api.destroy();
});

function domFixture() {
  class Node {
    constructor(document, tag) {
      this.ownerDocument = document; this.tagName = tag.toUpperCase(); this.nodeType = 1; this.children = []; this.parentNode = null;
      this.dataset = {}; this.style = {}; this.attributes = new Map(); this.listeners = new Map(); this.disabled = false; this.checked = false; this._text = '';
    }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    append(...children) { for (const child of children) { child.remove(); child.parentNode = this; this.children.push(child); } }
    replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this._text = ''; this.append(...children); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
    contains(target) { return this === target || this.children.some(child => child.contains(target)); }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) || null; }
    addEventListener(name, listener) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(listener); }
    querySelectorAll(selector) {
      const tags = selector.split(',').map(value => value.trim().toUpperCase()), found = [];
      const walk = node => { for (const child of node.children) { if (tags.includes(child.tagName)) found.push(child); walk(child); } };
      walk(this); return found;
    }
    focus() { this.ownerDocument.activeElement = this; }
    async dispatch(name) {
      const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      for (const listener of this.listeners.get(name) || []) await listener(event);
      return event;
    }
    async click() {
      if (this.disabled) return;
      if (this.tagName === 'INPUT' && this.type === 'checkbox') { this.checked = !this.checked; await this.dispatch('change'); }
      const event = await this.dispatch('click');
      if (this.tagName === 'A') this.ownerDocument.downloads.push({ url: this.href, filename: this.download });
      if (this.tagName === 'BUTTON' && this.type === 'submit' && !event.defaultPrevented) {
        let parent = this.parentNode; while (parent && parent.tagName !== 'FORM') parent = parent.parentNode;
        if (parent) await parent.dispatch('submit');
      }
    }
  }
  const document = { downloads: [], createElement(tag) { return new Node(document, tag); } };
  document.body = document.createElement('body'); const host = document.createElement('div'); document.body.append(host);
  const urls = new Map(), revoked = [];
  class LocalURL extends URL {
    static createObjectURL(blob) { const key = 'blob:fixture/' + randomUUID(); urls.set(key, blob); return key; }
    static revokeObjectURL(url) { revoked.push(url); urls.delete(url); }
  }
  const button = label => { const found = host.querySelectorAll('button').find(node => node.textContent === label); assert.ok(found, 'Button: ' + label); return found; };
  return { document, host, URL: LocalURL, urls, revoked, button };
}

test('VM DOM mount is optional/default-off and explicit open renders owner-only status without sending a request', async () => {
  const dom = domFixture(), current = fixture({ dom });
  assert.equal(current.context.AccountRights.mount(dom.host), false); assert.equal(dom.host.children.length, 0);
  assert.equal(current.api.mount(dom.host), true); assert.equal(current.requests.length, 0);
  assert.match(dom.host.textContent, /contact has not been configured/);
  await current.api.open(dom.host);
  assert.match(dom.host.textContent, /No requests yet/);
  assert.equal(current.requests.filter(call => call.url.endsWith('/submit_account_rights_request')).length, 0);
  assert.equal(dom.host.children[0].getAttribute('role'), 'region');
  current.api.destroy(); assert.equal(dom.host.children.length, 0);
});

test('VM DOM scope selector is explicit, defaults to v1 and locks while its selected v2 request is pending', async () => {
  const dom = domFixture(), current = fixture({ dom });
  await current.api.open(dom.host);
  const select = dom.host.querySelectorAll('select')[0];
  assert.equal(select.value, scopes.export);
  assert.equal(select.getAttribute('aria-label'), 'Export scope');
  assert.deepEqual(select.children.map(option => option.textContent), ['Saved profile and logs (v1)', 'Known server personal records (v2)']);
  select.value = 'account_server_personal_v2'; await select.dispatch('change');
  assert.match(dom.host.textContent, /availability recorded for each source/);
  assert.match(dom.host.textContent, /not an export of all personal data/);
  assert.match(dom.host.textContent, /canonical Auth UID only, not legacy aliases; alias ownership is not verified/);
  assert.match(dom.host.textContent, /Authorized shared conversations include other participants' messages and IDs/);
  assert.match(dom.host.textContent, /restricted third-party records outside those shared conversations are excluded/);
  let begin, release;
  const started = new Promise(resolve => { begin = resolve; });
  current.state.onRequest = async call => {
    if (call.url.endsWith('/submit_account_rights_request')) await new Promise(resolve => { release = resolve; begin(); });
  };
  const pending = dom.button('Request export').click(); await started;
  assert.equal(select.disabled, true); assert.equal(dom.button('Close').disabled, false);
  release(); await pending;
  assert.equal(select.disabled, false);
  const request = current.requests.find(call => call.url.endsWith('/submit_account_rights_request'));
  assert.deepEqual(request.body.p_payload, { schema_version: 2, scope: 'account_server_personal_v2' });
  assert.match(dom.host.textContent, /Known server personal records \(v2\)/);
  current.api.destroy();
});

test('VM DOM erasure requires reauthentication, an unchecked confirmation and an actual acknowledged submit', async () => {
  const dom = domFixture(); let reauth = 0, contact = 0;
  const current = fixture({ dom, options: { reauthenticate: async () => { reauth++; return true; }, openSupport: () => { contact++; } } });
  await current.api.open(dom.host); await dom.button('Request erasure').click();
  assert.equal(reauth, 1); const checkbox = dom.host.querySelectorAll('input')[0];
  assert.equal(checkbox.checked, false); assert.equal(dom.button('Confirm erasure request').disabled, true);
  await dom.button('Confirm erasure request').click();
  assert.equal(current.requests.filter(call => call.url.endsWith('/submit_account_rights_request')).length, 0);
  await checkbox.click(); await dom.button('Confirm erasure request').click();
  assert.equal(current.requests.filter(call => call.body?.p_kind === 'erasure').length, 1);
  assert.match(dom.host.textContent, /Request received\. Account erasure has not been executed/);
  assert.equal(dom.host.querySelectorAll('input').length, 0);
  assert.equal([...current.state.receipts.values()][0].status, 'received');
  await dom.button('Contact support').click(); assert.equal(contact, 1);
  await dom.button('Cancel request').click(); assert.match(dom.host.textContent, /Erasure: Cancelled/);
  current.api.destroy();
});

test('VM DOM lost erasure acknowledgement retains confirmation and retries without fabricating delivery', async () => {
  const dom = domFixture(), current = fixture({ dom, options: { reauthenticate: async () => true } });
  await current.api.open(dom.host); await dom.button('Request erasure').click();
  await dom.host.querySelectorAll('input')[0].click(); current.state.failAfterCommit = true;
  await dom.button('Confirm erasure request').click();
  assert.equal(dom.host.querySelectorAll('input')[0].checked, true);
  assert.match(dom.host.textContent, /did not confirm/);
  const requestId = current.requests.find(call => call.body?.p_kind === 'erasure').body.p_request_id;
  current.state.failAfterCommit = false; await dom.button('Confirm erasure request').click();
  const retries = current.requests.filter(call => call.body?.p_kind === 'erasure');
  assert.equal(retries.length, 2); assert.equal(retries[1].body.p_request_id, requestId);
  assert.equal(current.state.receipts.size, 1); current.api.destroy();
});

test('VM DOM private paging preserves raw cursors and history text cannot inject markup', async () => {
  const dom = domFixture(), current = fixture({ dom });
  const rows = Array.from({ length: 26 }, () => makeReceipt(owner, randomUUID(), 'export'));
  current.state.onRequest = call => {
    if (call.url.endsWith('/my_account_rights_requests')) {
      const second = !!call.body.p_before_id;
      return response({ requester: owner, items: second ? rows.slice(25) : rows.slice(0, 25), has_more: !second,
        next_cursor: second ? null : { created_at: rows[24].created_at, id: rows[24].id } });
    }
    if (call.url.endsWith('/my_account_rights_history')) return response({ requester: owner, request_ref: call.body.p_id, items: [{
      id: randomUUID(), action: '<img src=x onerror=attack()>', version: 1, from_status: null, to_status: 'received', created_at: rows[0].created_at
    }], has_more: false, next_before_version: null });
  };
  await current.api.open(dom.host);
  assert.equal(dom.host.querySelectorAll('section').filter(node => node.dataset.requestId).length, 25);
  await dom.button('Next requests').click();
  assert.equal(current.requests.at(-1).body.p_before, rows[24].created_at);
  assert.equal(dom.host.querySelectorAll('section').filter(node => node.dataset.requestId).length, 1);
  assert.equal(dom.button('Next requests').disabled, true);
  await dom.button('Previous requests').click(); assert.equal(current.requests.at(-1).body.p_before, null);
  await dom.button('History').click();
  assert.match(dom.host.textContent, /could not be verified/); assert.equal(dom.host.querySelectorAll('img').length, 0);
  assert.doesNotMatch(dom.host.textContent, /onerror/); current.api.destroy();
});

test('VM DOM close/account switch fences late views and never clears another parent modal', async () => {
  const dom = domFixture(), current = fixture({ dom }); let release, started;
  const seen = new Promise(resolve => { started = resolve; });
  current.state.onRequest = async call => { if (call.url.endsWith('/my_account_rights_requests')) await new Promise(resolve => { release = resolve; started(); }); };
  const opening = current.api.open(dom.host); await seen;
  const replacement = dom.document.createElement('div'); replacement.textContent = 'Parent replacement modal'; dom.host.replaceChildren(replacement);
  current.api.close(); release(); await opening;
  assert.equal(dom.host.children[0], replacement);
  current.state.onRequest = null; await current.api.open(dom.host); await dom.button('Request export').click();
  assert.match(dom.host.textContent, /Export: Request received/);
  current.state.owner = other; current.state.token = 'mapped-token-b'; current.emit('formora:sessionchange');
  assert.equal(dom.host.children.length, 0); current.api.destroy();
});

test('VM DOM download uses a local Blob URL, removes the anchor and revokes delivery on reset', async () => {
  const dom = domFixture(), current = fixture({ dom }); archiveFixture(current);
  await current.api.open(dom.host); await dom.button('Request export').click(); await dom.button('Download export').click();
  assert.equal(dom.document.downloads.length, 1); assert.match(dom.document.downloads[0].url, /^blob:fixture\//);
  assert.equal(dom.document.body.querySelectorAll('a').length, 0); assert.equal(dom.urls.size, 1);
  assert.match(dom.host.textContent, /Verified archive download started/);
  current.api.reset(); assert.equal(dom.urls.size, 0); assert.equal(dom.revoked.length, 1); current.api.destroy();
});

test('QA: detecting an account change clears the previous private view even without a parent session event', async () => {
  const dom = domFixture(), current = fixture({ dom });
  await current.api.open(dom.host); await dom.button('Request export').click();
  let release, started; const seen = new Promise(resolve => { started = resolve; });
  current.state.onRequest = async call => { if (call.url.endsWith('/my_account_rights_requests')) await new Promise(resolve => { release = resolve; started(); }); };
  const reading = current.api.listRequests(); await seen;
  current.state.owner = other; current.state.token = 'mapped-token-b'; release();
  await assert.rejects(reading, { code: 'account_changed' });
  assert.equal(dom.host.children.length, 0, 'Old owner receipts must be removed when the mismatch is detected');
  current.api.destroy();
});

test('QA: even an abort-ignoring transport cannot confirm a response after its timeout', async () => {
  const current = fixture({ options: { timeoutMs: 1 } });
  current.state.onRequest = call => {
    if (call.options.method !== 'POST') return;
    return new Promise(resolve => call.options.signal.addEventListener('abort', () => resolve(response(makeReceipt(owner, call.body.p_request_id, 'export'))), { once: true }));
  };
  await assert.rejects(current.api.requestExport(), { code: 'request_timeout' });
  assert.equal(current.stored.size, 1); current.api.destroy();
});

test('QA: failed or account-switching reauthentication sends no erasure request and preserves the parent view', async () => {
  for (const outcome of ['cancelled', 'changed']) {
    const dom = domFixture(); let current;
    current = fixture({ dom, options: { reauthenticate: async () => {
      if (outcome === 'cancelled') return false;
      current.state.owner = other; current.state.token = 'mapped-token-b'; current.api.reset(); return true;
    } } });
    await current.api.open(dom.host); await dom.button('Request erasure').click();
    assert.equal(current.requests.filter(call => call.body?.p_kind === 'erasure').length, 0);
    assert.equal(dom.host.querySelectorAll('form').length, 0);
    if (outcome === 'cancelled') assert.match(dom.host.textContent, /Authentication was not confirmed/);
    else assert.equal(dom.host.children.length, 0);
    current.api.destroy();
  }
});

async function probeSettlement(promise, timeout = 500) {
  let timer;
  try {
    return await Promise.race([promise.then(value => ({ state: 'fulfilled', value }), error => ({ state: 'rejected', error })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ state: 'pending' }), timeout); })]);
  } finally { clearTimeout(timer); }
}

test('R4: a never-settling token is bounded before any HTTP request starts', async () => {
  const current = fixture({ options: { operationTimeoutMs: 20,
    getAuth: () => ({ active: () => true, uid: () => owner, token: () => new Promise(() => {}) }) } });
  try {
    const outcome = await probeSettlement(current.api.requestExport());
    assert.equal(outcome.state, 'rejected'); assert.equal(outcome.error.code, 'operation_timeout');
    assert.equal(outcome.error.operation_status, 'unknown'); assert.equal(current.requests.length, 0);
  } finally { current.api.destroy(); }
});

test('R4: a transport that never settles or reacts to abort still has a settled request deadline', async () => {
  const current = fixture({ options: { timeoutMs: 15, operationTimeoutMs: 200 } });
  current.state.onRequest = call => call.options.method === 'POST' ? new Promise(() => {}) : undefined;
  try {
    const outcome = await probeSettlement(current.api.requestExport());
    assert.equal(outcome.state, 'rejected'); assert.equal(outcome.error.code, 'request_timeout');
    assert.equal(current.stored.size, 1); assert.equal(current.requests.at(-1).options.signal.aborted, true);
  } finally { current.api.destroy(); }
});

test('R4: Close stays enabled during a hung action and immediately settles and clears its owned view', async () => {
  const dom = domFixture(); let closed = 0, started;
  const seen = new Promise(resolve => { started = resolve; });
  const current = fixture({ dom, options: { onClose: () => { closed++; } } });
  current.state.onRequest = call => {
    if (call.url.endsWith('/submit_account_rights_request')) { started(); return new Promise(() => {}); }
  };
  current.api.mount(dom.host);
  const action = dom.button('Request export').click();
  try {
    await seen;
    assert.equal(dom.host.children[0].getAttribute('aria-busy'), 'true');
    assert.equal(dom.button('Close').dataset.persistent, 'true'); assert.equal(dom.button('Close').disabled, false);
    await dom.button('Close').click();
    assert.equal((await probeSettlement(action)).state, 'fulfilled');
    assert.equal(closed, 1); assert.equal(dom.host.children.length, 0); assert.equal(current.stored.size, 1);
    assert.equal(current.requests.at(-1).options.signal.aborted, true);
  } finally { current.api.destroy(); }
});

test('R5: blank and invalid origins produce a configured-service message, never a raw URL TypeError', async () => {
  for (const url of ['', '   ', 'not a URL', 'https://user:secret@fixture.invalid', 'https://fixture.invalid/path']) {
    const dom = domFixture(), current = fixture({ dom, options: { url } });
    try {
      await assert.rejects(current.api.requestExport(), { code: 'unavailable', message: 'Account-rights service is not configured.' });
      current.api.mount(dom.host); await dom.button('Request export').click();
      assert.match(dom.host.textContent, /Account-rights service is not configured\./);
      assert.doesNotMatch(dom.host.textContent, /TypeError|Invalid URL|ERR_INVALID_URL|secret/);
      assert.equal(current.requests.length, 0); assert.equal(dom.button('Close').disabled, false);
    } finally { current.api.destroy(); }
  }
});

test('R1: cached-export removal requires confirmation, keeps its retry ID after a lost ACK, and is not account erasure', async () => {
  const dom = domFixture(), current = fixture({ dom }); archiveFixture(current);
  try {
    await current.api.open(dom.host); await dom.button('Request export').click(); await dom.button('Download export').click();
    const row = await current.api.getRequest([...current.state.receipts.values()][0].id);
    for (const confirmed of [undefined, false, 'true', 1]) await assert.rejects(current.api.releaseExport(row, { confirmed }), { code: 'confirmation_required' });
    await dom.button('Remove cached export').click(); await dom.button('Keep cached export').click();
    assert.equal(current.requests.filter(call => call.url.endsWith('/release_my_account_rights_export')).length, 0);
    await dom.button('Remove cached export').click(); current.state.failAfterCommit = true;
    await dom.button('Confirm cached export removal').click();
    assert.match(dom.host.textContent, /did not confirm/); assert.equal(current.stored.size, 1);
    const attempted = current.requests.at(-1).body;
    assert.deepEqual(Object.keys(attempted).sort(), ['p_id', 'p_operation_id', 'p_version']);
    assert.equal(attempted.p_id, row.id); assert.equal(attempted.p_version, row.version);
    assert.equal(dom.button('Close').disabled, false);
    current.state.failAfterCommit = false; await dom.button('Confirm cached export removal').click();
    const sent = current.requests.filter(call => call.url.endsWith('/release_my_account_rights_export'));
    assert.equal(sent.length, 2); assert.equal(sent[1].body.p_operation_id, attempted.p_operation_id);
    assert.equal(current.stored.size, 0); assert.equal(current.state.cachedBytes.size, 0); assert.equal(current.state.releases.size, 1);
    assert.match(dom.host.textContent, /Your account data and downloaded files are unchanged/);
    assert.equal(dom.host.querySelectorAll('button').some(node => node.textContent === 'Remove cached export' || node.textContent === 'Download export'), false);
    assert.match(dom.host.textContent, /not an export of all personal data/);
    assert.match(dom.host.textContent, /support\/report records/);
    assert.equal(current.requests.some(call => /release_account_rights_export|review_account_rights_request/.test(call.url)), false);
  } finally { current.api.destroy(); }
});

test('R1: malformed or unknown release acknowledgements never claim removal or discard their retry identifier', async () => {
  const mutations = [value => { value.operation_id = randomUUID(); }, value => { value.operation_status = 'unknown'; },
    value => { value.action = 'delete_account'; }, value => { value.scope = 'account'; }, value => { value.source_data_deleted = true; },
    value => { value.requester = other; }, value => { value.request_ref = randomUUID(); }, value => { value.released_bytes = 0; },
    value => { value.released_bytes = 8388609; }, value => { value.receipt.version--; }, value => { value.receipt.hold_version = -1; },
    value => { delete value.receipt.snapshot_status; }, value => { value.receipt.release_allowed = true; },
    value => { value.receipt.account_deleted = true; }, value => { value.approval_ref = randomUUID(); }];
  for (const mutate of mutations) {
    const current = fixture(); archiveFixture(current);
    try {
      const requested = await current.api.requestExport(), prepared = await current.api.prepareExport(requested.id);
      current.state.onRequest = call => {
        if (!call.url.endsWith('/release_my_account_rights_export')) return;
        const value = { schema_version: 1, operation_id: call.body.p_operation_id, operation_status: 'committed', action: 'release_export',
          scope: 'cached_export_only', request_ref: prepared.request_ref, requester: owner, released_bytes: prepared.total_bytes,
          source_data_deleted: false, receipt: { ...clone(prepared.receipt), version: prepared.receipt.version + 1,
            status: 'export_released', snapshot_status: 'released', release_allowed: false, cancel_allowed: false } };
        mutate(value); return response(value);
      };
      await assert.rejects(current.api.releaseExport(prepared.receipt, { confirmed: true }), { code: 'invalid_response' });
      assert.equal(current.stored.size, 1); assert.ok([...current.stored.keys()][0].includes(':release:' + requested.id + ':2'));
      assert.ok([...current.stored.values()].every(value => /^[a-f0-9-]{36}$/.test(value)));
    } finally { current.api.destroy(); }
  }
});

test('R1: consistent unknown holds remain read-only and forged permission booleans fail closed on receipts', async () => {
  const dom = domFixture(), current = fixture({ dom });
  try {
    const requested = await current.api.requestExport();
    const stored = [...current.state.receipts.values()][0]; stored.hold_status = 'unknown'; stored.cancel_allowed = false;
    await current.api.open(dom.host);
    assert.match(dom.host.textContent, /Hold status is unverified/);
    assert.equal(dom.host.querySelectorAll('button').some(node => ['Download export', 'Remove cached export', 'Cancel request'].includes(node.textContent)), false);
    const unknown = await current.api.getRequest(requested.id), before = current.requests.length;
    await assert.rejects(current.api.cancel(unknown), { code: 'request_changed' });
    await assert.rejects(current.api.releaseExport(unknown, { confirmed: true }), { code: 'request_changed' });
    await assert.rejects(current.api.prepareExport(requested.id), { code: 'hold_unresolved' });
    assert.equal(current.requests.slice(before).some(call => /\/(cancel_account_rights_request|prepare_account_rights_export|release_my_account_rights_export)$/.test(call.url)), false);
    for (const mutate of [row => { delete row.snapshot_status; }, row => { row.hold_version = null; }, row => { row.hold_status = 'approved'; },
      row => { row.cancel_allowed = true; }, row => { row.release_allowed = true; }, row => { row.status = 'account_deleted'; },
      row => { row.snapshot_status = 'available'; }]) {
      current.state.onRequest = call => {
        if (!call.url.endsWith('/my_account_rights_request')) return;
        const invalid = clone(unknown); mutate(invalid); return response(invalid);
      };
      await assert.rejects(current.api.getRequest(requested.id), { code: 'invalid_response' });
    }
  } finally { current.api.destroy(); }
});

test('R4: every export page rejects mismatched operation, request version, snapshot and hold metadata', async () => {
  const mutations = [page => { page.operation_id = randomUUID(); }, page => { page.operation_status = 'unknown'; },
    page => { page.receipt.request_id = randomUUID(); }, page => { page.receipt.version++; }, page => { page.receipt.hold_version++; },
    page => { delete page.receipt.snapshot_status; }, page => { page.receipt.snapshot_status = 'released'; },
    page => { page.receipt.hold_status = 'unknown'; page.receipt.cancel_allowed = false; page.receipt.release_allowed = false; },
    page => { page.receipt.status = 'held'; page.receipt.hold_status = 'held'; page.receipt.cancel_allowed = false; page.receipt.release_allowed = false; },
    page => { page.receipt.requester = other; }, page => { page.receipt.execution_allowed = true; }];
  for (const mutate of mutations) {
    const saved = [], current = fixture({ options: { saveArchive: value => saved.push(value) } });
    archiveFixture(current, page => { if (page.offset === 32768) mutate(page); });
    try {
      const requested = await current.api.requestExport();
      await assert.rejects(current.api.downloadExport(requested.id), { code: 'invalid_response' });
      assert.equal(saved.length, 0);
      assert.equal(current.requests.filter(call => call.url.endsWith('/prepare_account_rights_export')).length, 1);
    } finally { current.api.destroy(); }
  }
});

test('R4: preparation metadata and archive history are validated before acknowledgement or delivery', async () => {
  for (const mode of ['operation', 'status', 'version', 'hold_version', 'history_action', 'history_version', 'history_status']) {
    const saved = [], current = fixture({ options: { saveArchive: value => saved.push(value) } });
    archiveFixture(current, null, (content, row) => {
      if (!mode.startsWith('history_')) return;
      const action = { request_ref: row.id, action: 'export_ready', version: 2, from_status: 'received', to_status: 'export_ready', created_at: row.created_at };
      if (mode === 'history_action') action.action = 'delete_everything';
      if (mode === 'history_version') action.version = 0;
      if (mode === 'history_status') action.to_status = 'deleted';
      content.request_history.actions.push(action);
    });
    const ordinary = current.state.onRequest;
    current.state.onRequest = async call => {
      const reply = await ordinary(call);
      if (!call.url.endsWith('/prepare_account_rights_export') || mode.startsWith('history_')) return reply;
      const value = await reply.json();
      if (mode === 'operation') value.operation_id = randomUUID();
      if (mode === 'status') value.operation_status = 'unknown';
      if (mode === 'version') value.receipt.version = 1;
      if (mode === 'hold_version') value.receipt.hold_version = 1;
      return response(value);
    };
    try {
      const requested = await current.api.requestExport();
      await assert.rejects(current.api.downloadExport(requested.id), { code: 'invalid_response' });
      assert.equal(saved.length, 0);
      assert.equal(current.stored.size, mode.startsWith('history_') ? 0 : 1);
    } finally { current.api.destroy(); }
  }
});

test('R4: a stalled real Response stream settles even if its cancellation promise also never settles', async () => {
  let cancelled = 0;
  const current = fixture({ options: { timeoutMs: 20, operationTimeoutMs: 200 } });
  current.state.onRequest = call => call.options.method !== 'POST' ? undefined : new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"unfinished":')); },
    cancel() { cancelled++; return new Promise(() => {}); }
  }), { headers: { 'content-type': 'application/json' } });
  try {
    const result = await probeSettlement(current.api.requestExport());
    assert.equal(result.state, 'rejected'); assert.equal(result.error.code, 'request_timeout');
    assert.equal(cancelled, 1); assert.equal(current.stored.size, 1);
  } finally { current.api.destroy(); }
});

test('R4: late pages after Close, account ABA or remount cannot create a Blob, save or overwrite the parent', async () => {
  for (const mode of ['close', 'aba', 'remount']) {
    const dom = domFixture(), saved = []; let created = 0, started, release;
    const seen = new Promise(resolve => { started = resolve; });
    class ObservedBlob extends Blob { constructor(...args) { super(...args); created++; } }
    const current = fixture({ dom, globals: { Blob: ObservedBlob }, options: { saveArchive: value => saved.push(value) } });
    archiveFixture(current, async page => { if (page.offset === 32768) await new Promise(resolve => { release = resolve; started(); }); });
    try {
      await current.api.open(dom.host); const requested = await current.api.requestExport();
      const downloading = current.api.downloadExport(requested.id); await seen;
      if (mode === 'close') await dom.button('Close').click();
      if (mode === 'aba') {
        current.state.owner = other; current.state.token = 'mapped-token-b'; current.emit('formora:sessionchange');
        current.state.owner = owner; current.state.token = 'mapped-token-a'; current.emit('formora:sessionchange');
      }
      if (mode === 'remount') current.api.mount(dom.host);
      const replacement = dom.document.createElement('div'); replacement.textContent = 'Parent content'; dom.host.replaceChildren(replacement);
      const outcome = await probeSettlement(downloading);
      assert.equal(outcome.state, 'rejected'); assert.equal(outcome.error.code, 'account_changed');
      const count = current.requests.length; release(); await new Promise(setImmediate);
      assert.equal(created, 0); assert.equal(saved.length, 0); assert.equal(dom.urls.size, 0);
      assert.equal(current.requests.length, count); assert.equal(dom.host.textContent, 'Parent content');
    } finally { current.api.destroy(); release?.(); }
  }
});

test('R4: late tokens and reauthentication cannot dispatch after their operation deadline', async () => {
  for (const mode of ['token', 'reauthentication']) {
    let release;
    const options = { operationTimeoutMs: 20 };
    if (mode === 'token') options.getAuth = () => ({ active: () => true, uid: () => owner, token: () => new Promise(resolve => { release = resolve; }) });
    else options.reauthenticate = () => new Promise(resolve => { release = resolve; });
    const current = fixture({ options });
    try {
      const outcome = await probeSettlement(mode === 'token' ? current.api.requestExport() : current.api.reauthenticate());
      assert.equal(outcome.state, 'rejected'); assert.equal(outcome.error.code, 'operation_timeout');
      release(mode === 'token' ? 'mapped-token-a' : true); await new Promise(setImmediate);
      assert.equal(current.requests.length, 0); assert.equal(current.stored.size, 0);
    } finally { current.api.destroy(); }
  }
});

test('R4: digest and trusted delivery callbacks share the operation budget, with a cancellable delivery signal', async () => {
  for (const mode of ['digest', 'delivery']) {
    let invoked = false, deliverySignal;
    const globals = mode === 'digest' ? { crypto: { randomUUID, subtle: { digest() { invoked = true; return new Promise(() => {}); } } } } : {};
    const current = fixture({ globals, options: { operationTimeoutMs: 80, saveArchive(value) {
      invoked = true; deliverySignal = value.signal; return new Promise(() => {});
    } } });
    archiveFixture(current);
    try {
      const requested = await current.api.requestExport();
      const outcome = await probeSettlement(current.api.downloadExport(requested.id));
      assert.equal(outcome.state, 'rejected'); assert.equal(outcome.error.code, 'operation_timeout'); assert.equal(invoked, true);
      if (mode === 'delivery') assert.equal(deliverySignal.aborted, true);
    } finally { current.api.destroy(); }
  }
});

test('R4: operation timeout configuration cannot exceed the 30 second technical ceiling', async () => {
  const timers = [];
  const current = fixture({ globals: { setTimeout(callback, milliseconds) { timers.push(milliseconds); return setTimeout(callback, milliseconds); } },
    options: { operationTimeoutMs: 999999, getAuth: () => ({ active: () => true, uid: () => owner, token: () => new Promise(() => {}) }) } });
  try {
    const request = current.api.requestExport();
    assert.equal(current.context.AccountRights.limits.operationMs, 30000); assert.deepEqual(timers, [30000]);
    current.api.close(); assert.equal((await probeSettlement(request)).state, 'rejected');
  } finally { current.api.destroy(); }
});

async function boundedHttpEvent(promise, label, timeout = 1000) {
  const outcome = await probeSettlement(promise, timeout);
  assert.equal(outcome.state, 'fulfilled', label);
  return outcome.value;
}

async function loopbackArchive(context, archiveBytes = 8388608) {
  const state = { row: null, bytes: null, header: null, preparations: 0, stallOffset: null, abortedStreams: 0,
    calls: [], nativeCalls: [], cancelledReaders: 0, pendingReads: 0, streamAborts: 0, openSockets: 0, sourceName: 'Original synthetic profile' };
  const startedStreaming = Promise.withResolvers(), observedNetwork = Promise.withResolvers(), settledClose = Promise.withResolvers();
  const settledSocketClose = Promise.withResolvers(), sockets = new Map();
  const server = http.createServer(async (request, reply) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer mapped-token-a');
      let text = '';
      for await (const chunk of request) { text += chunk; assert.ok(Buffer.byteLength(text) <= 2048); }
      const body = text ? JSON.parse(text) : null, route = request.url.split('/').at(-1);
      const call = { route, body }; state.calls.push(call); let result;
      const stalled = route === 'read_account_rights_export' && body.p_limit === 32768 && body.p_offset === state.stallOffset;
      reply.once('close', () => {
        if (!reply.writableFinished) state.abortedStreams++;
        if (stalled) settledClose.resolve({ call, writableFinished: reply.writableFinished });
      });
      if (request.url === '/auth/v1/user') result = { id: owner };
      else if (route === 'submit_account_rights_request') {
        state.row ||= makeReceipt(owner, body.p_request_id, body.p_kind); result = state.row;
      } else if (route === 'my_account_rights_request') { assert.equal(body.p_id, state.row.id); result = state.row; }
      else if (route === 'my_account_rights_requests') result = { requester: owner, items: state.row ? [state.row] : [], has_more: false, next_cursor: null };
      else if (route === 'prepare_account_rights_export') {
        assert.equal(body.p_id, state.row.id); assert.equal(state.preparations, 0, 'No duplicate snapshot preparation');
        state.preparations++; state.row.status = 'export_ready'; state.row.snapshot_status = 'available'; state.row.release_allowed = true; state.row.version++;
        const content = { schema: 'formora.account-rights', schema_version: 1, scope: scopes.export, request_ref: state.row.id, requester: owner,
          generated_at: state.row.created_at, provenance: { source: 'loopback HTTP synthetic source' }, projection: {},
          exclusions: ['shared messages and report prose'], data: { identity: { id: owner }, profile: { name: state.sourceName, bio: '' } },
          request_history: { requests: [state.row], actions: [] } };
        content.data.profile.bio = 'x'.repeat(archiveBytes - Buffer.byteLength(JSON.stringify(content)));
        state.bytes = Buffer.from(JSON.stringify(content)); assert.equal(state.bytes.length, archiveBytes);
        state.header = { schema_version: 1, request_ref: state.row.id, requester: owner, generated_at: state.row.created_at,
          total_bytes: state.bytes.length, sha256: createHash('sha256').update(state.bytes).digest('hex'), max_chunk_bytes: 32768,
          operation_id: body.p_operation_id, operation_status: 'committed' };
        result = { ...state.header, receipt: state.row };
      } else if (route === 'read_account_rights_export') {
        assert.equal(body.p_id, state.row.id);
        const offset = body.p_offset, next = Math.min(state.bytes.length, offset + body.p_limit);
        result = { ...state.header, receipt: state.row, offset, next_offset: next, complete: next === state.bytes.length,
          chunk_base64: state.bytes.subarray(offset, next).toString('base64') };
      } else { reply.writeHead(404); reply.end('{}'); return; }
      const serialized = JSON.stringify(result);
      reply.writeHead(200, { 'content-type': 'application/json' });
      if (stalled) {
        reply.socket.once('close', () => settledSocketClose.resolve(call));
        reply.write(serialized.slice(0, 128)); startedStreaming.resolve(call);
      } else reply.end(serialized);
    } catch (error) { state.error = error; reply.destroy(); }
  });
  server.on('connection', socket => {
    state.openSockets++;
    sockets.set(socket, new Promise(resolve => socket.once('close', () => { sockets.delete(socket); state.openSockets--; resolve(); })));
  });
  let stopping;
  function stop() {
    if (!stopping) stopping = (async () => {
      const drained = Promise.all(sockets.values());
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await boundedHttpEvent(Promise.all([closed, drained]), 'The fixture server and all accepted sockets must close');
      assert.equal(server.listening, false); assert.equal(state.openSockets, 0); assert.equal(sockets.size, 0);
    })();
    return stopping;
  }
  context.after(stop);
  await boundedHttpEvent(new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }), 'The fixture server must start');
  const origin = 'http://127.0.0.1:' + server.address().port;
  return { state, origin, stop, startedStreaming: startedStreaming.promise, observedNetwork: observedNetwork.promise,
    settledClose: settledClose.promise, settledSocketClose: settledSocketClose.promise,
    async fetch(url, options) {
      assert.equal(new URL(url).origin, origin);
      const route = new URL(url).pathname.split('/').at(-1), body = options.body ? JSON.parse(options.body) : null;
      const call = { route, body, signal: options.signal }; state.nativeCalls.push(call);
      const reply = await fetch(url, options);
      if (route === 'read_account_rights_export' && body.p_limit === 32768 && body.p_offset === state.stallOffset) {
        options.signal.addEventListener('abort', () => { state.streamAborts++; }, { once: true });
        const getReader = reply.body.getReader.bind(reply.body);
        reply.body.getReader = () => {
          const reader = getReader(), read = reader.read.bind(reader), cancel = reader.cancel.bind(reader);
          reader.read = async () => {
            state.pendingReads++;
            try {
              const chunk = await read();
              if (!chunk.done && chunk.value.byteLength) observedNetwork.resolve({ call, bytes: chunk.value.byteLength });
              return chunk;
            } finally { state.pendingReads--; }
          };
          reader.cancel = (...args) => { state.cancelledReaders++; return cancel(...args); };
          return reader;
        };
      }
      return reply;
    }
  };
}

test('R4 HTTP: an unfinished native-fetch chunk hits one deadline; retry reads the same immutable archive in 256 chunks', { timeout: 35000 }, async context => {
  const network = await loopbackArchive(context), { state, origin } = network, dom = domFixture(), progress = [], saved = [];
  const current = fixture({ dom, options: { url: origin, fetch: network.fetch,
    saveArchive(value) { saved.push(value); } } });
  context.after(() => current.api.destroy());
  await current.api.open(dom.host); await dom.button('Request export').click();
  await current.api.prepareExport(state.row.id);
  const retained = { row: clone(state.row), header: clone(state.header), bytes: state.bytes };
  state.stallOffset = 98304; current.options.timeoutMs = 1000; current.options.operationTimeoutMs = 250;
  let failed;
  const download = current.api.downloadExport;
  current.api.downloadExport = (id, delivery) => download(id, { ...delivery, onProgress(value) {
    progress.push(value); assert.equal(dom.button('Close').disabled, false);
    assert.match(dom.host.textContent, new RegExp('Downloading cached export: ' + value.percent + '%'));
  } }).catch(error => { failed = error; throw error; });
  const started = Date.now(), clicking = dom.button('Download export').click();
  const streaming = await boundedHttpEvent(network.startedStreaming, 'The selected export response must start streaming');
  const observed = await boundedHttpEvent(network.observedNetwork, 'The native reader must consume the unfinished response prefix');
  assert.deepEqual(streaming, { route: 'read_account_rights_export', body: { p_id: state.row.id, p_offset: 98304, p_limit: 32768 } });
  assert.deepEqual(observed.call.body, streaming.body); assert.ok(observed.bytes > 0);
  await boundedHttpEvent(clicking, 'The UI operation must settle without waiting for the unfinished body', 1500);
  assert.equal(failed?.code, 'operation_timeout'); assert.ok(Date.now() - started < 1500);
  assert.equal(saved.length, 0); assert.equal(dom.urls.size, 0); assert.match(dom.host.textContent, /server status is unknown/);
  assert.equal(dom.host.children[0].getAttribute('aria-busy'), 'false'); assert.equal(dom.button('Close').disabled, false);
  assert.ok(progress.some(value => value.percent > 0)); assert.ok(progress.at(-1).percent < 100);
  const firstChunks = state.calls.filter(call => call.route === 'read_account_rights_export' && call.body.p_limit === 32768);
  assert.deepEqual(firstChunks.map(call => call.body.p_offset), [0, 32768, 65536, 98304]);
  const [closed, socketCall] = await boundedHttpEvent(Promise.all([network.settledClose, network.settledSocketClose]), 'The timed-out export response and its socket must close before retry or fixture cleanup');
  assert.equal(closed.call, streaming); assert.equal(socketCall, streaming); assert.equal(closed.writableFinished, false);
  assert.ok(state.abortedStreams >= 1); assert.equal(state.cancelledReaders, 1); assert.equal(state.pendingReads, 0);
  assert.equal(state.streamAborts, 1); assert.equal(observed.call.signal.aborted, true); assert.equal(current.stored.size, 0);
  assert.equal(state.preparations, 1);
  const boundary = state.calls.length;
  state.stallOffset = null; state.sourceName = 'Changed source must not resnapshot';
  current.options.timeoutMs = 10000; current.options.operationTimeoutMs = 30000;
  const completed = [];
  const result = await boundedHttpEvent(download(state.row.id, { save: false, onProgress: value => completed.push(value) }), 'The full immutable retry must complete within the technical ceiling', 31000);
  assert.equal(result.total_bytes, 8388608); assert.equal(result.sha256, state.header.sha256);
  assert.equal(JSON.parse(await result.blob.text()).data.profile.name, 'Original synthetic profile');
  const retried = state.calls.slice(boundary).filter(call => call.route === 'read_account_rights_export' && call.body.p_limit === 32768);
  assert.equal(retried.length, 256); assert.equal(retried[0].body.p_offset, 0);
  assert.ok(retried.every((call, index) => call.body.p_id === state.row.id && call.body.p_offset === index * 32768));
  assert.equal(completed[0].percent, 0); assert.equal(completed.at(-1).percent, 100); assert.equal(state.preparations, 1);
  assert.deepEqual(state.row, retained.row); assert.deepEqual(state.header, retained.header); assert.equal(state.bytes, retained.bytes);
  assert.equal(state.calls.filter(call => call.route === 'submit_account_rights_request').length, 1);
  assert.equal(current.stored.size, 0); assert.equal(dom.document.downloads.length, 0);
  assert.equal(saved.length, 0); assert.equal(state.error, undefined); assert.ok(state.abortedStreams >= 1);
  current.api.destroy(); await network.stop();
});

test('R4 HTTP: Close cancels the exact observed unfinished export stream before server cleanup, without output or retry keys', { timeout: 5000 }, async context => {
  const network = await loopbackArchive(context, 65536), { state, origin } = network, dom = domFixture(), saved = [];
  let created = 0;
  class ObservedBlob extends Blob { constructor(...args) { super(...args); created++; } }
  const current = fixture({ dom, globals: { Blob: ObservedBlob }, options: { url: origin, fetch: network.fetch, saveArchive: value => saved.push(value) } });
  context.after(() => current.api.destroy());
  const requested = await current.api.requestExport(); await current.api.prepareExport(requested.id);
  const retained = { row: clone(state.row), header: clone(state.header), bytes: state.bytes };
  assert.equal(current.stored.size, 0); state.stallOffset = 0;
  const downloading = probeSettlement(current.api.downloadExport(requested.id), 1500);
  const streaming = await boundedHttpEvent(network.startedStreaming, 'The selected export response must start streaming');
  const observed = await boundedHttpEvent(network.observedNetwork, 'Close must follow actual native-reader bytes, not just response headers');
  assert.deepEqual(streaming, { route: 'read_account_rights_export', body: { p_id: requested.id, p_offset: 0, p_limit: 32768 } });
  assert.deepEqual(observed.call.body, streaming.body); assert.ok(observed.bytes > 0);
  assert.equal(observed.call.signal.aborted, false); assert.equal(state.abortedStreams, 0);
  const callsBeforeClose = state.calls.length, sendsBeforeClose = state.nativeCalls.length, started = Date.now();
  current.api.close();
  const outcome = await downloading;
  assert.equal(outcome.state, 'rejected'); assert.equal(outcome.error.code, 'account_changed');
  const [closed, socketCall] = await boundedHttpEvent(Promise.all([network.settledClose, network.settledSocketClose]), 'Client Close must close that unfinished response and socket without fixture intervention');
  assert.equal(closed.call, streaming); assert.equal(socketCall, streaming); assert.equal(closed.writableFinished, false);
  assert.ok(Date.now() - started < 1500); assert.ok(state.abortedStreams >= 1);
  assert.equal(observed.call.signal.aborted, true); assert.equal(state.streamAborts, 1); assert.equal(state.cancelledReaders, 1);
  assert.equal(state.pendingReads, 0); assert.equal(created, 0); assert.equal(saved.length, 0);
  assert.equal(dom.document.downloads.length, 0); assert.equal(dom.urls.size, 0); assert.equal(current.stored.size, 0);
  assert.deepEqual(state.row, retained.row); assert.deepEqual(state.header, retained.header); assert.equal(state.bytes, retained.bytes);
  assert.equal(state.preparations, 1); assert.equal(state.error, undefined);
  assert.equal(state.calls.length, callsBeforeClose); assert.equal(state.nativeCalls.length, sendsBeforeClose);
  current.api.destroy(); await network.stop();
  assert.equal(state.calls.length, callsBeforeClose); assert.equal(state.nativeCalls.length, sendsBeforeClose);
  assert.equal(state.openSockets, 0);
});

test('R1: cancellation and release cannot acknowledge an older observed hold version', async () => {
  for (const action of ['cancel', 'release']) {
    const current = fixture(); archiveFixture(current);
    try {
      const requested = await current.api.requestExport(); await current.api.prepareExport(requested.id);
      [...current.state.receipts.values()][0].hold_version = 2;
      const observed = await current.api.getRequest(requested.id);
      current.state.onRequest = call => {
        if (!call.url.endsWith(action === 'cancel' ? '/cancel_account_rights_request' : '/release_my_account_rights_export')) return;
        const row = { ...observed, version: observed.version + 1, hold_version: 1, status: action === 'cancel' ? 'cancelled' : 'export_released',
          snapshot_status: 'released', cancel_allowed: false, release_allowed: false };
        return response(action === 'cancel' ? row : { schema_version: 1, operation_id: call.body.p_operation_id, operation_status: 'committed',
          action: 'release_export', scope: 'cached_export_only', request_ref: observed.id, requester: owner, released_bytes: 70000,
          source_data_deleted: false, receipt: row });
      };
      await assert.rejects(action === 'cancel' ? current.api.cancel(observed) : current.api.releaseExport(observed, { confirmed: true }), { code: 'invalid_response' });
      assert.equal(current.stored.size, 1);
    } finally { current.api.destroy(); }
  }
});