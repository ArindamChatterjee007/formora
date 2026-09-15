'use strict';
/*
  Independent review probes for the T-107 Chat/Story-context integration (2026-09-06).

  Scope: the implementation risks that the module-level acceptance suite does not cover -
  what an open DM thread COSTS in Story actions, what happens to messages outside the
  bounded scan window, how a failed marker batch labels the thread, and whether a late
  account change can paint into the wrong conversation.

  Read-only with respect to product source: this file loads the real js/mod/social.js in a
  VM over a minimal DOM shim plus a counting Stories stub. It adds no product behaviour.

  RED BY DESIGN. Two probes here currently FAIL. They are not characterisations of the
  status quo - they assert the behaviour the integration is supposed to have, and they pin a
  live defect: an open DM thread re-spends the server-side Story action budget on every
  12-second poll. scripts/run-functional-checks.cjs globs tests/*.test.cjs into the shared
  unit phase, so this file will keep the candidate run red until that defect is fixed.
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const owner = '11111111-1111-4111-8111-111111111111';
const peer = '22222222-2222-4222-8222-222222222222';
const storyId = '33333333-3333-4333-8333-333333333333';

// Server-side ceilings this integration spends against (supabase/story-interactions.sql).
const actorDay = Number(/actor_day integer NOT NULL DEFAULT (\d+)/.exec(read('supabase/story-interactions.sql'))[1]);
const pollSeconds = 12; // js/app.js initCloud -> Cloud.start(...) refreshes an open thread on every poll

function node(tag) {
  return {
    tagName: String(tag).toUpperCase(), attributes: new Map(), children: [], listeners: [],
    className: '', type: '', title: '', textContent: '', innerHTML: '', value: '',
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(name, handler) { this.listeners.push([name, handler]); },
    click() { for (const [name, handler] of this.listeners) if (name === 'click') handler({ stopPropagation() {} }); },
    text() { return String(this.textContent) + String(this.innerHTML) + this.children.map(child => child.text()).join(''); },
    dump() { return [...this.attributes].map(pair => pair.join('=')).join(' ') + ' ' + this.title + ' ' + this.text()
      + this.children.map(child => child.dump()).join(''); }
  };
}

function fixture({ messages = 4, references = id => id.startsWith('reply') } = {}) {
  const calls = { references: [], resolve: [], open: [] };
  const toasts = [], writes = [], slots = new Map();
  const state = { owner, session: 1, resolveResult: () => ({ available: true, story: { id: storyId, photo: 'https://media.example/private.jpg' } }) };
  const service = {
    enabled: () => true, owner: () => state.owner, reset() {},
    replyReferences: async batch => {
      calls.references.push([...batch]);
      if (batch.length > 50) throw Object.assign(new Error('One to fifty message ids required'), { status: 400 });
      return batch.filter(references);
    },
    resolveContext: async id => { calls.resolve.push(id); return state.resolveResult(id); },
    open: async id => { calls.open.push(id); return { id }; }
  };
  const composer = node('textarea');
  composer.value = 'a half typed reply';
  const document = {
    createElement: node,
    getElementById: id => (id === 'dm-text' ? composer : null),
    querySelectorAll: selector => (selector === '#chat-thread [data-story-context]' ? [...slots.values()] : [])
  };
  const context = vm.createContext({
    document, setTimeout, clearTimeout, console,
    window: { STORY_INTERACTIONS: true, USE_SUPABASE_AUTH: true },
    localStorage: { getItem: () => null, setItem: (key, value) => writes.push([key, value]), removeItem: () => {}, length: 0, key: () => null },
    esc: value => String(value == null ? '' : value).replace(/[&"<>']/g, character => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;', "'": '&#39;' }[character])),
    App: { toast: message => toasts.push(message), ic: name => '<svg data-ic="' + name + '"></svg>' },
    Cloud: { me: owner, _actionUid: () => owner, _publishingUid: () => owner },
    SupaAuth: { active: () => true, uid: () => state.owner },
    Stories: service
  });
  vm.runInContext(read('js/mod/social.js') + '\nglobalThis.social = Social;', context);
  const social = context.social;
  social.state = {}; social.sub = 'chat'; social._session = state.session;
  social.key = 'formora_social_' + owner;
  social._dmWith = peer;
  social.cloudActive = () => true;
  let renders = 0;
  social.render = () => { renders += 1; };
  social.scrollChat = () => {};

  function seed(ids) {
    slots.clear();
    social._dmMsgs = ids.map((id, index) => ({ id, from: index % 2 ? owner : peer, to: index % 2 ? peer : owner, body: 'Message ' + index, ts: index }));
    for (const id of ids) { const slot = node('span'); slot.setAttribute('data-story-context', id); slots.set(id, slot); }
  }
  const thread = length => Array.from({ length }, (value, index) => (index % 5 === 0 ? 'reply-' : 'ordinary-') + String(index).padStart(4, '0'));
  seed(thread(messages));

  return { social, calls, toasts, writes, state, service, context, seed, thread, composer,
    slotFor: id => slots.get(id),
    dump: () => [...slots.values()].map(slot => slot.dump()).join('|'),
    renders: () => renders };
}

test('the scan window and resolve fan-out stay at the reviewed bounds', () => {
  const kit = fixture();
  assert.equal(kit.social._storyContextScan, 50, 'the marker batch is capped at the SQL maximum');
  assert.equal(kit.social._storyContextResolve, 8, 'the per-pass resolve fan-out is capped');
  assert.ok(kit.social._storyContextScan <= 50, 'a larger batch would be rejected 22023 by story_reply_references');
});

test('a long thread asks about the newest 50 message ids only, once, and resolves at most 8', async () => {
  const kit = fixture();
  kit.seed(kit.thread(120));
  assert.equal(await kit.social._scanStoryContext(peer), true);
  assert.equal(kit.calls.references.length, 1, 'one marker batch per pass');
  const batch = kit.calls.references[0];
  assert.equal(batch.length, 50);
  assert.deepEqual(batch, kit.thread(120).slice(-50), 'the newest 50 ids, in thread order');
  assert.ok(kit.calls.resolve.length <= 8, 'resolve fan-out is bounded: ' + kit.calls.resolve.length);
  // Newest first, so the part of the thread the member is actually looking at settles first.
  assert.deepEqual(kit.calls.resolve, batch.filter(id => id.startsWith('reply')).reverse().slice(0, 8));
  // Everything older than the window is left blank rather than guessed at.
  assert.equal(kit.slotFor('reply-0000').children.length, 0, 'an out-of-window reply is never labelled');
  assert.equal(kit.dump().includes(storyId), false, 'no story id reaches the DOM');
  assert.equal(kit.dump().includes('media.example'), false, 'no media URL reaches the DOM');
  assert.deepEqual(kit.writes, [], 'nothing about the story is persisted');
});

test('an unchanged thread left open must not respend the Story action budget on every poll', async () => {
  const kit = fixture();
  kit.seed(kit.thread(60)); // 50-id window, 10 of them Story replies
  await kit.social._scanStoryContext(peer);
  const initialCost = kit.calls.references.length + kit.calls.resolve.length;
  const polls = 10;
  for (let pass = 0; pass < polls; pass += 1) await kit.social._scanStoryContext(peer);
  const spent = kit.calls.references.length + kit.calls.resolve.length - initialCost;
  assert.equal(spent, 0, 'unchanged passive polls add no Story RPCs after the initial checked render');
  const perPoll = spent / polls;
  const minutesToExhaustDailyBudget = actorDay / (perPoll * (60 / pollSeconds));
  // Every one of these RPCs charges one actor unit (_story_budget), and each resolve additionally
  // charges the story's target unit. A member who simply leaves one conversation open must not be
  // able to burn the whole day's Story allowance - that would 429 their real views, likes and replies.
  assert.ok(minutesToExhaustDailyBudget >= 240,
    'sitting in one unchanged thread costs ' + perPoll + ' Story actions per ' + pollSeconds
    + 's poll (' + spent + ' over ' + polls + ' passes), which exhausts the '
    + actorDay + '/day actor budget in ' + minutesToExhaustDailyBudget.toFixed(1)
    + ' minutes; re-validation needs a cache or a throttle');
});

test('a thread with no Story replies at all must not spend the Story budget on every poll', async () => {
  const kit = fixture({ references: () => false });
  kit.seed(Array.from({ length: 30 }, (value, index) => 'ordinary-' + index));
  const polls = 10;
  for (let pass = 0; pass < polls; pass += 1) await kit.social._scanStoryContext(peer);
  assert.deepEqual(kit.calls.resolve, [], 'an ordinary conversation never resolves a story');
  const perPoll = (kit.calls.references.length + kit.calls.resolve.length) / polls;
  const minutesToExhaustDailyBudget = actorDay / (perPoll * (60 / pollSeconds));
  // A conversation that has never contained a Story reply still charges one actor unit per poll.
  assert.ok(minutesToExhaustDailyBudget >= 240,
    'an ordinary DM thread costs ' + perPoll + ' Story actions per ' + pollSeconds
    + 's poll, exhausting the ' + actorDay + '/day actor budget in '
    + minutesToExhaustDailyBudget.toFixed(1) + ' minutes of plain chatting');
});

test('a failed marker batch keeps unknown messages blank and never asserts a tombstone', async () => {
  const kit = fixture();
  kit.seed(['ordinary-0000', 'reply-0001', 'reply-0002']);
  await kit.social._scanStoryContext(peer);
  assert.ok(kit.dump().includes('View story'));
  // Now the batch itself fails.
  kit.service.replyReferences = async batch => { kit.calls.references.push([...batch]); throw Object.assign(new Error('Stories are unavailable right now.'), { status: 503 }); };
  assert.equal(await kit.social._scanStoryContext(peer, true), false);
  assert.equal(kit.slotFor('ordinary-0000').children.length, 0, 'an unlabelled message is never turned into a Story reply');
  const dump = kit.dump();
  assert.equal(dump.includes('Story unavailable'), false, 'a tombstone is never asserted from an unchecked batch');
  assert.ok(dump.includes('Story could not be checked.'), 'known markers degrade to an honest retry');
  assert.ok(dump.includes('Retry'));
  assert.deepEqual(kit.calls.open, []);
});

test('a resolve that lands after the member switches account paints nothing and leaks nothing', async () => {
  const kit = fixture();
  kit.seed(['reply-0001']);
  let release;
  kit.service.resolveContext = async id => {
    kit.calls.resolve.push(id);
    await new Promise(resolve => { release = resolve; });
    return { available: false }; // a leak would overwrite the old cache with this answer
  };
  const scanning = kit.social._scanStoryContext(peer);
  await new Promise(resolve => setImmediate(resolve));
  const previousMap = kit.social._storyContextMap(peer);
  assert.equal(previousMap.get('reply-0001'), 'reference', 'the marker batch settled before the switch');
  // The account changes while the resolve is still in flight.
  kit.state.owner = '99999999-9999-4999-8999-999999999999';
  kit.context.Cloud.me = kit.state.owner;
  kit.social._session += 1;
  kit.social.key = 'formora_social_' + kit.state.owner;
  release();
  await scanning;
  assert.equal(previousMap.get('reply-0001'), 'reference', 'the late answer is dropped, not written into the old account cache');
  assert.equal(kit.social._storyContextMap(peer).size, 0, 'the new account starts from an empty context map');
  assert.equal(kit.dump().includes('Story unavailable'), false, 'nothing is painted into the new session');
  assert.deepEqual(kit.calls.open, []);
  assert.deepEqual(kit.writes, []);
});

test('activation always rechecks and never opens on a stale cached marker', async () => {
  const kit = fixture();
  kit.seed(['reply-0001']);
  await kit.social._scanStoryContext(peer);
  const button = kit.slotFor('reply-0001').children[0].children[0];
  assert.equal(button.getAttribute('aria-label'), 'View the story this reply is about');
  const before = kit.calls.resolve.length;
  // The owner deletes the story between the cached marker and the tap.
  kit.state.resolveResult = () => ({ available: false });
  kit.service.resolveContext = async id => { kit.calls.resolve.push(id); return { available: false }; };
  button.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(kit.calls.resolve.length, before + 1, 'activation re-resolves through the checked accessor');
  assert.deepEqual(kit.calls.open, [], 'no media is requested for a story that is gone');
  assert.deepEqual(kit.toasts, ['Story unavailable.']);
  assert.ok(kit.dump().includes('Story unavailable'), 'the affordance becomes a tombstone in place');
});

test('painting context never re-renders the thread, so a typed draft and scroll survive', async () => {
  const kit = fixture();
  kit.seed(['reply-0001', 'reply-0002', 'ordinary-0003']);
  const rendersBefore = kit.renders();
  await kit.social._scanStoryContext(peer);
  kit.social._paintStoryContext(peer);
  kit.social._paintStoryContext(peer);
  assert.equal(kit.renders(), rendersBefore, 'the context pass never calls render()');
  assert.equal(kit.composer.value, 'a half typed reply', 'the composer is untouched');
  // Repainting an unchanged status must be a no-op so listeners and focus are not rebuilt.
  const slot = kit.slotFor('reply-0001');
  const painted = slot.children[0];
  kit.social._paintStoryContext(peer);
  assert.equal(slot.children[0], painted, 'an unchanged slot keeps the exact node it already had');
});
