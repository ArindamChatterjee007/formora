'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('a delayed private-message prefill cannot enter another account or a replacement edit', () => {
  const callbacks = [], cleared = [], input = { value: '', focus() {}, setSelectionRange() {} };
  const overlays = new Map(['story-preview', 'story-viewer'].map(id => [id, { remove() { overlays.delete(id); } }]));
  const context = vm.createContext({
    window: {}, console, setTimeout: callback => { callbacks.push(callback); return callbacks.length; },
    clearTimeout: timer => cleared.push(timer), document: { getElementById: id => id === 'dm-edit' ? input : overlays.get(id) || null }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'js/mod/social.js'), 'utf8') + '\nglobalThis.subject = Social;', context);
  const social = context.subject;
  social.render = () => {};
  social._dmWith = 'peer-A';
  social._dmMsgs = [{ id: 'message-A', body: 'Private A text' }];
  social.editMsg('message-A');
  social.resetSession();
  assert.equal(overlays.size, 0, 'The real reset removes both Story overlays');
  assert.equal(social._editMsg, null);
  assert.ok(cleared.includes(1));
  social._dmWith = 'peer-B';
  social._dmMsgs = [{ id: 'message-B', body: 'B draft' }];
  social.editMsg('message-B');
  callbacks[0]();
  assert.equal(input.value, '');
  callbacks[1]();
  assert.equal(input.value, 'B draft');
  social.cancelEdit();
  input.value = 'New composition';
  callbacks[1]();
  assert.equal(input.value, 'New composition');
});

test('stopping an old feed read allows the new account to poll immediately', async () => {
  const context = vm.createContext({ window: {}, console, AbortController, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(fs.readFileSync(path.join(root, 'js/cloud.js'), 'utf8') + '\nglobalThis.subject = Cloud;', context);
  const cloud = context.subject, first = deferred(), second = deferred(), seen = [];
  let oldSignal, calls = 0;
  cloud._get = controller => {
    calls++;
    if (calls === 1) { oldSignal = controller.signal; return first.promise; }
    return second.promise;
  };
  cloud.me = 'account-A'; cloud._paused = false; cloud._cb = result => seen.push(result);
  const oldPoll = cloud._tick();
  cloud.stop();
  assert.equal(oldSignal.aborted, true);
  cloud.me = 'account-B'; cloud._paused = false; cloud._cb = result => seen.push(result);
  const newPoll = cloud._tick();
  assert.equal(calls, 2);
  first.resolve('A private feed'); await oldPoll;
  assert.equal(cloud._busy, true, 'An old finally must not release the new account poll');
  second.resolve('B feed'); await newPoll;
  assert.deepEqual(seen, ['B feed']);
  assert.equal(cloud._busy, false);
});

test('feed fetch and response body are bounded by one abort deadline', async () => {
  const timers = [], bodyStarted = deferred();
  const context = vm.createContext({
    window: {}, console, AbortController,
    setTimeout: (callback, milliseconds) => { assert.equal(milliseconds, 10000); timers.push(callback); return 1; }, clearTimeout() {},
    fetch: async (url, options) => ({ ok: true, json: () => {
      bodyStarted.resolve();
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    } })
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'js/cloud.js'), 'utf8') + '\nglobalThis.subject = Cloud;', context);
  const loading = context.subject._get();
  await bodyStarted.promise;
  timers[0]();
  assert.equal(await loading, null);
});