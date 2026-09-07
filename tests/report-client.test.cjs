'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../js/mod/reports.js'), 'utf8');
function fixture() {
  const storage = new Map(), requests = [], state = { owner: 'owner-a', fail: false, stored: null };
  const context = vm.createContext({ window: { MODERATION_RECEIPTS: true }, crypto: webcrypto, TextEncoder, AbortController, setTimeout, clearTimeout,
    localStorage: { get length() { return storage.size; }, key: index => [...storage.keys()][index], getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    SupaAuth: { active: () => true, uid: () => state.owner, token: async () => 'fresh' },
    Cloud: { base: 'https://fixture.invalid/rest/v1', key: 'fixture', _headers: extra => extra },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body); requests.push({ url, options, body });
      state.stored ||= { id: webcrypto.randomUUID(), request_id: body.p_request_id, kind: body.p_kind, status: 'received', version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      if (state.fail) throw new Error('lost response after commit');
      return { ok: true, json: async () => state.stored };
    } });
  vm.runInContext(source + '\nglobalThis.reports = Reports;', context);
  return { reports: context.reports, context, state, storage, requests };
}
test('lost acknowledgement retains request identity across reload and returns the same receipt on retry', async () => {
  const { reports, context, state, storage, requests } = fixture();
  state.fail = true; assert.equal(await reports.submit('post', 'post-1', 'Spam'), null);
  assert.equal(storage.size, 1);
  assert.doesNotMatch([...storage.keys()].join(''), /post-1|Spam/);
  assert.equal([...storage.keys()][0], 'fm_report_request_owner-a');
  assert.ok(reports.uuid([...storage.values()][0]));
  reports._pending.clear(); state.fail = false;
  const receipt = await reports.submit('post', 'post-1', 'Spam');
  assert.equal(receipt.id, state.stored.id);
  assert.equal(requests[0].body.p_request_id, requests[1].body.p_request_id);
  assert.equal(storage.size, 0); assert.equal(requests[1].options.headers.Authorization, 'Bearer fresh');
  assert.equal('p_reporter' in requests[1].body, false);
});
test('duplicate in-flight submissions share one request and stale-account results cannot succeed', async () => {
  const { reports, context, state, requests } = fixture();
  const original = context.fetch; let release, started;
  const seen = new Promise(resolve => { started = resolve; });
  context.fetch = async (...args) => { await new Promise(resolve => { release = resolve; started(); }); return original(...args); };
  const first = reports.submit('post', 'post-1', 'Spam'), duplicate = reports.submit('post', 'post-1', 'Spam');
  await seen;
  state.owner = 'owner-b'; release();
  assert.deepEqual(await Promise.all([first, duplicate]), [null,null]);
  assert.equal(requests.length, 1);
});
test('denial, malformed receipts and unavailable local persistence never claim success', async () => {
  for (const failure of ['denial','shape','storage']) {
    const { reports, context } = fixture();
    if (failure === 'denial') context.fetch = async () => ({ ok: false, status: 403 });
    if (failure === 'shape') context.fetch = async () => ({ ok: true, json: async () => ({ id: 'not-a-receipt' }) });
    if (failure === 'storage') context.localStorage.setItem = () => { throw new Error('quota'); };
    assert.equal(await reports.submit('post','post-1','Spam'), null);
    assert.equal(reports._pending.size, 0);
    if (failure === 'storage') assert.match(reports.errorFor('post','post-1','Spam'), /quota/);
  }
});

test('receipt enablement never falls back to the legacy write when the module is unavailable', async () => {
  const { context, requests } = fixture();
  context.window.SUPABASE_URL = 'https://fixture.invalid'; context.window.SUPABASE_ANON_KEY = 'key';
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/cloud.js'), 'utf8') + '\nglobalThis.cloud = Cloud;', context);
  context.cloud.base = 'https://fixture.invalid'; context.cloud.key = 'key'; context.cloud.me = 'owner-a';
  context.reports.enabled = () => false;
  assert.equal(await context.cloud.report('post','post-1','Spam'), false);
  assert.equal(requests.length, 0);
});

test('quota feedback survives the submission wrapper and private cached rows clear at reset', async () => {
  const { reports, context } = fixture();
  context.fetch = async () => ({ ok: false, status: 429 });
  await reports.submit('post','post-1','Spam');
  assert.match(reports.errorFor('post','post-1','Spam'), /limit reached/i);
  reports._rows = [{ reason: 'private' }]; reports._rowOwner = 'owner-a'; reports.reset();
  assert.equal(reports._rows.length, 0); assert.equal(reports._failures.size, 0); assert.equal(reports._rowOwner, null);
});

test('terminal rejections remove retry state while account invalidation clears failed drafts', async () => {
  for (const status of [400,404]) {
    const { reports, context, storage } = fixture();
    context.fetch = async () => ({ ok: false, status });
    assert.equal(await reports.submit('post','post-1','Spam'), null);
    assert.equal(storage.size, 0);
    assert.match(reports.errorFor('post','post-1','Spam'), status === 404 ? /no longer available/ : /not valid/);
  }
  const { reports, state, storage } = fixture();
  state.fail = true; await reports.submit('post','post-1','Spam');
  assert.equal(storage.size, 1); reports.reset(); assert.equal(storage.size, 0);
});

test('malformed cached UUID is replaced and missing cloud setup never sends a request', async () => {
  const { reports, state, storage, requests, context } = fixture();
  state.fail = true; await reports.submit('post','post-1','Spam');
  storage.set([...storage.keys()][0], '-'.repeat(36));
  await reports.submit('post','post-1','Spam');
  assert.ok(reports.uuid(requests[1].body.p_request_id));
  context.Cloud.base = null; const count = requests.length;
  await reports.submit('post','post-1','Spam'); assert.equal(requests.length, count);
});

test('different report payloads persist only random opaque IDs, with an explicit new attempt after conflict', async () => {
  const first = fixture(), second = fixture();
  first.state.fail = true; second.state.fail = true;
  await first.reports.submit('post','public-target-1','Spam');
  await second.reports.submit('user','public-target-2','Something else');
  assert.equal([...first.storage.keys()][0], [...second.storage.keys()][0]);
  assert.notEqual([...first.storage.values()][0], [...second.storage.values()][0]);
  assert.ok([...first.storage.values(),...second.storage.values()].every(value => first.reports.uuid(value)));
  first.context.fetch = async () => ({ok:false,status:409});
  assert.equal(await first.reports.submit('post','other-target','Another reason'),null);
  assert.equal(first.storage.size,0);
  assert.match(first.reports.errorFor('post','other-target','Another reason'),/earlier report was received.*submit this new report again/);
});