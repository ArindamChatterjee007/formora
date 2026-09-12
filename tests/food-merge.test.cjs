'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const DATE = '2026-09-06';

// the real Store, loaded from source — no re-implementation of the merge under test
function storeFixture({ crypto: cryptoImpl = webcrypto, seed = null } = {}) {
  const storage = new Map(seed ? Object.entries(seed) : []);
  const sandbox = {
    structuredClone, setTimeout, clearTimeout, DEFAULT_PROFILE: {},
    localStorage: { getItem: key => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
  };
  if (cryptoImpl) sandbox.crypto = cryptoImpl;
  const context = vm.createContext(sandbox);
  vm.runInContext(source('js/storage.js') + '\nglobalThis.store = Store;', context);
  return { store: context.store, storage };
}

// values built inside the vm realm are compared as plain JSON, not by prototype identity
const plain = value => JSON.parse(JSON.stringify(value));
const rice = extra => Object.assign({ text: 'Rice', kcal: 250, protein: 5 }, extra);
const paneer = extra => Object.assign({ text: 'Paneer', kcal: 300, protein: 18 }, extra);
const state = (items, updatedAt, date = DATE) => ({ profile: { name: 'Member A' }, weightLog: [],
  workoutLog: [], restDays: [], foodLog: [{ date, items }], updatedAt });
const itemsOn = (result, date = DATE) => (result.foodLog.find(f => f.date === date) || { items: [] }).items;

// local is the newer copy on this device, cloud is the copy arriving from the account backup
function mergeDay(cloudItems, localItems) {
  const { store } = storeFixture();
  store.state = state(localItems, 2);
  return itemsOn(store.merge(state(cloudItems, 1)));
}

test('DEF038: an older cloud copy with one serving keeps both locally logged servings', () => {
  const merged = mergeDay([rice()], [rice(), rice()]);
  assert.equal(merged.length, 2, 'the second identical serving must survive the merge');
  assert.equal(merged.reduce((sum, item) => sum + item.kcal, 0), 500);
});

test('two identical legacy servings on both copies stay two, not four', () => {
  assert.equal(mergeDay([rice(), rice()], [rice(), rice()]).length, 2);
});

test('a cloud copy with more servings than local keeps the larger count', () => {
  assert.equal(mergeDay([rice(), rice()], [rice()]).length, 2);
});

test('different meals are never collapsed into one another', () => {
  const merged = mergeDay([rice()], [paneer()]);
  assert.deepEqual(plain(merged).map(item => item.text).sort(), ['Paneer', 'Rice']);
});

test('a legacy entry and its id-carrying mirror are one entry, and the id is kept', () => {
  const merged = mergeDay([rice()], [rice({ id: 'entry-1' })]);
  assert.equal(merged.length, 1, 'the same serving seen with and without an id must not duplicate');
  assert.equal(merged[0].id, 'entry-1');
});

test('two servings logged independently on two devices both survive', () => {
  const merged = mergeDay([rice({ id: 'cloud-1' })], [rice({ id: 'local-1' })]);
  assert.deepEqual(plain(merged).map(item => item.id).sort(), ['cloud-1', 'local-1']);
});

test('two stable ids with the same value on both copies stay two entries', () => {
  const both = [rice({ id: 'a' }), rice({ id: 'b' })];
  const merged = mergeDay(both.map(item => ({ ...item })), both.map(item => ({ ...item })));
  assert.deepEqual(plain(merged).map(item => item.id), ['a', 'b']);
});

test('a local edit of an entry wins over the cloud copy of the same id', () => {
  const merged = mergeDay([rice({ id: 'a' })], [rice({ id: 'a', kcal: 180, text: 'Rice (half)' })]);
  assert.equal(merged.length, 1);
  assert.deepEqual(plain(merged[0]), { text: 'Rice (half)', kcal: 180, protein: 5, id: 'a' });
});

test('an edited entry does not swallow a legacy serving that still matches its old value', () => {
  const merged = mergeDay([rice({ id: 'shared' })], [rice({ id: 'shared', kcal: 180 }), rice()]);
  assert.equal(merged.length, 2, 'the superseded cloud value must not consume the legacy serving');
  assert.equal(merged.reduce((sum, item) => sum + item.kcal, 0), 430);
  assert.deepEqual(plain(merged).map(item => [item.id || null, item.kcal]).sort(), [[null, 250], ['shared', 180]]);
});

test('re-merging that same older cloud copy still leaves two servings', () => {
  const { store } = storeFixture();
  const cloud = state([rice({ id: 'shared' })], 1);
  store.state = state([rice({ id: 'shared', kcal: 180 }), rice()], 2);
  const once = JSON.stringify(store.merge(structuredClone(cloud)).foodLog);
  assert.equal(JSON.parse(once)[0].items.length, 2);
  assert.equal(JSON.stringify(store.merge(structuredClone(cloud)).foodLog), once, 'merge must stay idempotent');
});

test('a legacy serving on the cloud side survives an entry edited on this device', () => {
  const merged = mergeDay([rice(), rice({ id: 'shared' })], [rice({ id: 'shared', kcal: 180 })]);
  assert.equal(merged.length, 2);
  assert.equal(merged.reduce((sum, item) => sum + item.kcal, 0), 430);
});

test('an extra legacy serving alongside an id-carrying one is still counted', () => {
  const merged = mergeDay([rice(), rice()], [rice({ id: 'a' }), rice(), rice()]);
  assert.equal(merged.length, 3);
  assert.equal(merged.filter(item => item.id === 'a').length, 1);
});

test('merging the same cloud copy again changes nothing', () => {
  const { store } = storeFixture();
  const cloud = state([rice(), rice({ id: 'a' })], 1);
  store.state = state([rice(), rice(), rice({ id: 'a' }), paneer()], 2);
  const once = store.merge(structuredClone(cloud));
  const first = JSON.stringify(once.foodLog);
  assert.equal(JSON.stringify(store.merge(structuredClone(cloud)).foodLog), first, 'merge must be idempotent');
});

test('with no edits the merge is order independent', () => {
  const cloud = [rice(), rice(), paneer({ id: 'p' })];
  const local = [rice(), paneer({ id: 'p' }), rice({ id: 'r' })];
  const forward = mergeDay(structuredClone(cloud), structuredClone(local));
  const backward = mergeDay(structuredClone(local), structuredClone(cloud));
  const canon = items => plain(items).map(item => JSON.stringify(item)).sort();
  assert.deepEqual(canon(forward), canon(backward));
});

test('no serving is lost: every id survives once and each day keeps at least the larger count', () => {
  const { store } = storeFixture();
  const cloud = { profile: {}, weightLog: [], workoutLog: [], restDays: [], updatedAt: 1, foodLog: [
    { date: '2026-09-04', items: [rice({ id: 'c1' }), rice()] },
    { date: '2026-09-05', items: [paneer(), paneer(), paneer()] }] };
  const local = { profile: {}, weightLog: [], workoutLog: [], restDays: [], updatedAt: 2, foodLog: [
    { date: '2026-09-05', items: [paneer()] },
    { date: '2026-09-06', items: [rice({ id: 'l1' }), paneer({ id: 'l2' })] }] };
  store.state = structuredClone(local);
  const merged = store.merge(structuredClone(cloud));
  const count = (log, date) => ((log.foodLog || []).find(f => f.date === date) || { items: [] }).items.length;
  for (const date of ['2026-09-04', '2026-09-05', '2026-09-06']) {
    assert.ok(count(merged, date) >= Math.max(count(cloud, date), count(local, date)), 'lost a serving on ' + date);
  }
  const ids = plain(merged.foodLog).flatMap(f => f.items.map(item => item.id).filter(Boolean));
  assert.deepEqual(ids.sort(), ['c1', 'l1', 'l2']);
  assert.equal(new Set(ids).size, ids.length, 'no id may appear twice');
});

test('merge does not mutate either source copy', () => {
  const { store } = storeFixture();
  const cloud = state([rice(), rice({ id: 'a' })], 1);
  const local = state([rice(), rice(), rice({ id: 'a' })], 2);
  const cloudBefore = JSON.stringify(cloud), localBefore = JSON.stringify(local);
  store.state = local;
  const merged = store.merge(cloud);
  merged.foodLog[0].items.forEach(item => { item.kcal = 0; });
  assert.equal(JSON.stringify(cloud), cloudBefore, 'the cloud copy must be left untouched');
  assert.equal(JSON.stringify(local), localBefore, 'the local copy must be left untouched');
});

test('logFood mints a stable unique id without touching the caller object', () => {
  const { store } = storeFixture();
  store.state = { profile: {}, weightLog: [], workoutLog: [], foodLog: [], restDays: [] };
  const caller = rice();
  store.logFood(caller, DATE);
  store.logFood(rice(), DATE);
  const items = store.foodOn(DATE).items;
  assert.equal(items.length, 2);
  assert.ok(items.every(item => typeof item.id === 'string' && item.id.length > 0));
  assert.notEqual(items[0].id, items[1].id);
  assert.deepEqual(caller, rice(), 'the caller object must not be mutated');
  assert.equal(items[0].text, 'Rice');
});

test('logFood keeps an id the caller already supplied', () => {
  const { store } = storeFixture();
  store.state = { profile: {}, weightLog: [], workoutLog: [], foodLog: [], restDays: [] };
  store.logFood(rice({ id: 'given' }), DATE);
  assert.equal(store.foodOn(DATE).items[0].id, 'given');
});

test('a runtime without crypto.randomUUID logs an id-less entry instead of throwing', () => {
  const { store } = storeFixture({ crypto: null });
  store.state = { profile: {}, weightLog: [], workoutLog: [], foodLog: [], restDays: [] };
  store.logFood(rice(), DATE);
  store.logFood(rice(), DATE);
  const items = store.foodOn(DATE).items;
  assert.equal(items.length, 2);
  assert.ok(items.every(item => item.id === undefined));
  assert.equal(mergeDay([items[0]], items).length, 2, 'id-less entries still merge by multiplicity');
});

test('load never back-fills ids onto existing entries', () => {
  const stored = { profile: { name: 'Member A', onboarded: true }, weightLog: [], workoutLog: [],
    restDays: [], foodLog: [{ date: DATE, items: [rice(), rice()] }] };
  const { store } = storeFixture({ seed: { 'gymcoach_v1_A': JSON.stringify(stored) } });
  const loaded = store.load('gymcoach_v1_A');
  assert.deepEqual(plain(loaded.foodLog[0].items), [rice(), rice()], 'migrating ids on load would split one entry per device');
});

test('the rest of the merge is untouched by the food change', () => {
  const { store } = storeFixture();
  store.state = { profile: { name: 'Local', onboarded: false }, weightLog: [{ date: '2026-09-05', kg: 80 }],
    workoutLog: [{ date: '2026-09-05', volume: 100 }], foodLog: [], restDays: ['2026-09-04'], updatedAt: 1 };
  const merged = store.merge({ profile: { name: 'Cloud', onboarded: true }, weightLog: [{ date: '2026-09-05', kg: 70 }, { date: '2026-09-03', kg: 71 }],
    workoutLog: [{ date: '2026-09-05', volume: 999, finalizationRequestId: 'r1' }], foodLog: [], restDays: ['2026-09-02'], updatedAt: 5 });
  assert.equal(merged.weightLog.find(w => w.date === '2026-09-05').kg, 80, 'local weight edit still wins per date');
  assert.equal(merged.weightLog.length, 2);
  assert.equal(merged.workoutLog[0].finalizationRequestId, 'r1', 'the finalized workout entry still wins');
  assert.deepEqual(plain(merged.restDays).sort(), ['2026-09-02', '2026-09-04']);
  assert.equal(merged.profile.name, 'Cloud');
  assert.equal(merged.profile.onboarded, true);
});
