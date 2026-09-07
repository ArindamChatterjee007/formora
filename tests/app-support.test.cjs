'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');

function setup() {
  const state = { uid: 'account-a', writes: [], closed: 0, messages: [] };
  const elements = { 'sp-subj': { value: 'My membership' }, 'sp-msg': { value: 'Payment is not showing.' }, 'sp-send': { disabled: false } };
  const context = vm.createContext({
    document: { addEventListener() {}, getElementById: id => elements[id] || null }, window: {},
    Auth: { currentUser: () => ({ id: state.uid, email: 'member@example.test' }) },
    SupaAuth: { active: () => true, uid: () => state.uid, token: async () => 'token', email: () => 'member@example.test' },
    Entitlements: { tier: () => 'pro' },
    Cloud: { me: 'stale-slug', active: () => true, _actionUid: () => state.uid, _writeAction: async (url, method, body) => { state.writes.push({ url, method, body }); return true; } },
    setTimeout, clearTimeout
  });
  vm.runInContext(source + '\nglobalThis.app = App;', context);
  context.app.closeModal = () => { state.closed++; };
  context.app.toast = message => state.messages.push(message);
  return { app: context.app, state, elements, context };
}

test('Support confirmation waits for an acknowledged owner-scoped write', async () => {
  const { app, state, context, elements } = setup(); let resolve, started;
  const requestSeen = new Promise(done => { started = done; });
  context.Cloud._writeAction = (url, method, body) => { state.writes.push({ url, method, body }); return new Promise(done => { resolve = done; started(); }); };
  const pending = app.submitTicket(); await requestSeen;
  assert.equal(state.closed, 0); assert.equal(elements['sp-send'].disabled, true);
  assert.equal(state.writes[0].body.uid, 'account-a');
  resolve(true); await pending;
  assert.equal(state.closed, 1); assert.match(state.messages.at(-1), /sent|saved/i);
});

test('Rejected and offline support writes preserve the draft and allow retry', async () => {
  for (const response of [async () => false, async () => { throw new Error('offline'); }]) {
    const { app, state, context, elements } = setup();
    context.Cloud._writeAction = response; await app.submitTicket();
    assert.equal(state.closed, 0); assert.equal(elements['sp-msg'].value, 'Payment is not showing.');
    assert.equal(elements['sp-send'].disabled, false);
    assert.match(state.messages.at(-1), /try again|retry/i);
    context.Cloud._writeAction = async () => true; await app.submitTicket(); assert.equal(state.closed, 1);
  }
});

test('Duplicate support clicks send once while acknowledgement is pending', async () => {
  const { app, state, context } = setup(); let resolve, started;
  const requestSeen = new Promise(done => { started = done; });
  context.Cloud._writeAction = () => { state.writes.push({}); return new Promise(done => { resolve = done; started(); }); };
  const first = app.submitTicket(), second = app.submitTicket(); await requestSeen;
  resolve(true); await Promise.all([first, second]); assert.equal(state.writes.length, 1);
});

test('Support completion cannot close another modal or affect a different account', async () => {
  for (const change of ['account', 'modal', 'draft']) {
    const { app, state, context, elements } = setup(); let resolve, started;
    const requestSeen = new Promise(done => { started = done; });
    context.Cloud._writeAction = () => new Promise(done => { resolve = done; started(); });
    const pending = app.submitTicket(); await requestSeen;
    if (change === 'account') state.uid = 'account-b';
    if (change === 'modal') elements['sp-msg'] = { value: 'Replacement editor' };
    if (change === 'draft') elements['sp-msg'].value = 'New typing while sending';
    resolve(true); await pending; assert.equal(state.closed, 0, change);
    if (change !== 'draft') assert.equal(state.messages.length, 0, change);
  }
});

test('Support rejects empty content and signed-out submissions without a write', async () => {
  const { app, state, elements } = setup(); elements['sp-msg'].value = ' ';
  await app.submitTicket(); assert.equal(state.writes.length, 0);
  elements['sp-msg'].value = 'Help'; state.uid = '';
  await app.submitTicket(); assert.equal(state.writes.length, 0); assert.equal(state.closed, 0);
});

test('Customer copy avoids invented trials, automatic renewal and unstaffed support guarantees', () => {
  assert.doesNotMatch(source, /5-day free trial|all 115 camera filters|Elite then renews|usually within a day|mailto:support@formora\.app/);
  assert.doesNotMatch(source, /AI plans, every filter/);
  assert.match(source, /access until/);
});

test('flag-on support never falls back to the legacy table on missing or failed receipts',async()=>{
  const {app,state,context,elements}=setup();context.window.SUPPORT_RECEIPTS=true;
  await app.submitTicket();assert.equal(state.writes.length,0);assert.equal(state.closed,0);
  context.SupportReceipts={submit:async()=>null,errorFor:()=> 'Retry your unconfirmed request.'};
  await app.submitTicket();assert.equal(state.writes.length,0);assert.equal(elements['sp-msg'].value,'Payment is not showing.');
  context.SupportReceipts.submit=async()=>({id:'receipt-fixture'});
  await app.submitTicket();assert.equal(state.writes.length,0);assert.equal(state.closed,1);assert.match(state.messages.at(-1),/Reference receipt-fixture/);
});