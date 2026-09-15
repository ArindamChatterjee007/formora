'use strict';
/*
  T-107 acceptance 3: the ordinary Chat thread renders a checked Story-reply context.
  Loads the REAL js/mod/social.js in a VM over a minimal DOM shim and a stubbed Stories
  service, so the reference marker, the checked resolve, the tombstone, the retry path
  and every scope fence are exercised without a browser.
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
const replyId = 'reply-message-0001';
const ordinaryId = 'ordinary-message-0001';

function element(tag) {
  return {
    tagName: String(tag).toUpperCase(), attributes: new Map(), children: [], listeners: [],
    className: '', type: '', title: '', textContent: '', innerHTML: '',
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(name, handler) { this.listeners.push([name, handler]); },
    click() { for (const [name, handler] of this.listeners) if (name === 'click') handler({ stopPropagation() {} }); },
    text() { return String(this.textContent) + String(this.innerHTML) + this.children.map(child => child.text()).join(''); },
    dump() { return [...this.attributes].map(pair => pair.join('=')).join(' ') + ' ' + this.title + ' ' + this.text()
      + this.children.map(child => child.dump()).join(''); },
  };
}

function fixture({ flag = true, ids = [ordinaryId, replyId] } = {}) {
  const calls = { references: [], resolve: [], open: [] };
  const toasts = [], writes = [], slots = new Map();
  const service = {
    enabled: () => flag, owner: () => state.owner, reset() { calls.reset = true; },
    replyReferences: async batch => { calls.references.push([...batch]); return batch.filter(id => id.startsWith('reply')); },
    resolveContext: async id => { calls.resolve.push(id); return { available: true, story: { id: storyId, photo: 'https://media.example/secret.jpg' } }; },
    open: async id => { calls.open.push(id); return { id }; },
  };
  const state = { owner, service };
  const document = {
    createElement: element,
    getElementById: () => null,
    querySelectorAll: selector => selector === '#chat-thread [data-story-context]' ? [...slots.values()] : [],
  };
  const context = vm.createContext({
    document, setTimeout, clearTimeout, console,
    window: { STORY_INTERACTIONS: flag, USE_SUPABASE_AUTH: true },
    localStorage: { getItem: () => null, setItem: (key, value) => writes.push([key, value]), removeItem: () => {}, length: 0, key: () => null },
    esc: value => String(value == null ? '' : value).replace(/[&"<>']/g, character => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;', "'": '&#39;' }[character])),
    App: { toast: message => toasts.push(message), ic: name => '<svg data-ic="' + name + '"></svg>' },
    Cloud: { me: owner, _actionUid: () => owner, _publishingUid: () => owner },
    Stories: service,
  });
  vm.runInContext(read('js/mod/social.js') + '\nglobalThis.social = Social;', context);
  const social = context.social;
  social.state = {}; social.sub = 'chat'; social._session = 1;
  social._dmWith = peer;
  social._actionScope = () => JSON.stringify([state.owner, social._session]);
  social.cloudActive = () => true;
  social.render = () => social._paintStoryContext();
  social.scrollChat = () => {};
  seed(ids);
  function seed(list) {
    slots.clear();
    social._dmMsgs = list.map((id, index) => ({ id, from: index % 2 ? owner : peer, to: index % 2 ? peer : owner, body: 'Message ' + index, ts: index }));
    for (const id of list) { const slot = element('span'); slot.setAttribute('data-story-context', id); slots.set(id, slot); }
  }
  const slotFor = id => slots.get(id);
  const dump = () => [...slots.values()].map(slot => slot.dump()).join('|');
  return { social, context, calls, toasts, writes, state, service, seed, slotFor, dump };
}

test('an ordinary thread renders no context, asks once and never resolves a story', async () => {
  const kit = fixture({ ids: [ordinaryId, 'ordinary-message-0002'] });
  assert.equal(await kit.social._scanStoryContext(peer), true, 'the pass completes; it simply finds nothing to show');
  assert.deepEqual(kit.calls.references, [[ordinaryId, 'ordinary-message-0002']]);
  assert.deepEqual(kit.calls.resolve, []);
  assert.equal(kit.slotFor(ordinaryId).children.length, 0);
  assert.equal(kit.dump().includes('View story'), false);
  assert.equal(kit.dump().includes('Story unavailable'), false);
  assert.deepEqual(kit.writes, []);
});

test('the flag-off build emits no context slot and starts no reference request', async () => {
  const kit = fixture({ flag: false });
  assert.equal(kit.social._storyContextSlot({ id: replyId }), '');
  assert.equal(await kit.social._scanStoryContext(peer), false);
  assert.deepEqual(kit.calls.references, []);
  const bubble = kit.social.dmBubble({ id: replyId, from: peer, to: owner, body: 'Nice set', ts: 1 }, owner);
  assert.equal(/data-story-context|Story/.test(bubble), false);
});

test('a confirmed reference renders one 44px affordance and opens the exact rechecked Story row', async () => {
  const kit = fixture();
  const bubble = kit.social.dmBubble(kit.social._dmMsgs[1], owner);
  assert.ok(bubble.includes('data-story-context="' + replyId + '"'), 'dmBubble emits a reference-only slot');
  assert.equal(bubble.includes(storyId), false, 'no story id in message markup');
  await kit.social._scanStoryContext(peer);
  assert.deepEqual(kit.calls.resolve, [replyId]);
  const button = kit.slotFor(replyId).children[0].children[0];
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.getAttribute('aria-label'), 'View the story this reply is about');
  assert.equal(button.title, 'View the story this reply is about');
  assert.match(button.getAttribute('style'), /min-width:44px;min-height:44px;border-radius:8px/);
  assert.ok(button.innerHTML.includes('data-ic="film"'));
  assert.equal(kit.slotFor(ordinaryId).children.length, 0);
  assert.equal(kit.dump().includes(storyId), false, 'the DOM never carries the story id');
  assert.equal(kit.dump().includes('media.example'), false, 'the DOM never carries a media URL');
  button.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(kit.calls.resolve, [replyId, replyId], 'activation rechecks before any media is opened');
  assert.deepEqual(kit.calls.open, [storyId]);
  assert.deepEqual(kit.writes, []);
});

test('owner deletion turns the affordance into a tombstone on refresh while the reply text survives', async () => {
  const kit = fixture();
  await kit.social._scanStoryContext(peer);
  assert.ok(kit.dump().includes('View story'));
  kit.service.resolveContext = async id => { kit.calls.resolve.push(id); return { available: false }; };
  await kit.social._scanStoryContext(peer, true);
  const note = kit.slotFor(replyId).children[0];
  assert.equal(note.children.length, 0);
  assert.ok(note.text().includes('Story unavailable'));
  assert.ok(note.innerHTML.includes('data-ic="info"'));
  assert.equal(kit.dump().includes('View story'), false);
  assert.deepEqual(kit.calls.open, [], 'a tombstone never opens media');
  assert.ok(kit.social.dmBubble(kit.social._dmMsgs[1], owner).includes('Message 1'), 'the reply body is untouched');
});

test('a transient resolve failure shows an actionable retry, never a tombstone, and recovers', async () => {
  const kit = fixture();
  const outage = Object.assign(new Error('Stories are unavailable right now.'), { status: 503 });
  kit.service.resolveContext = async id => { kit.calls.resolve.push(id); throw outage; };
  await kit.social._scanStoryContext(peer);
  const wrap = kit.slotFor(replyId).children[0];
  assert.ok(wrap.text().includes('Story could not be checked.'));
  assert.equal(wrap.text().includes('Story unavailable'), false);
  const retry = wrap.children.at(-1);
  assert.equal(retry.getAttribute('aria-label'), 'Retry the story this reply is about');
  assert.ok(retry.innerHTML.includes('Retry'));
  kit.service.resolveContext = async id => { kit.calls.resolve.push(id); return { available: true, story: { id: storyId } }; };
  retry.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(kit.calls.open, [storyId]);
  assert.ok(kit.dump().includes('View story'));
});

test('a 404 resolve is a tombstone but a failed marker batch claims nothing and keeps a known reference retryable', async () => {
  const gone = fixture();
  gone.service.resolveContext = async () => { throw Object.assign(new Error('Story unavailable.'), { status: 404 }); };
  await gone.social._scanStoryContext(peer);
  assert.ok(gone.dump().includes('Story unavailable'));

  const kit = fixture();
  await kit.social._scanStoryContext(peer);
  kit.service.replyReferences = async () => { throw Object.assign(new Error('Stories are unavailable right now.'), { status: 503 }); };
  assert.equal(await kit.social._scanStoryContext(peer, true), false);
  assert.ok(kit.slotFor(replyId).children[0].text().includes('Story could not be checked.'));
  assert.equal(kit.slotFor(ordinaryId).children.length, 0, 'an unmarked message is never labelled after a failed batch');
  assert.equal(kit.dump().includes('Story unavailable'), false);
});

test('scan batches cap at fifty newest ids and resolve at eight per pass', async () => {
  const many = Array.from({ length: 120 }, (_, index) => 'reply-' + String(index).padStart(4, '0'));
  const kit = fixture({ ids: many });
  await kit.social._scanStoryContext(peer);
  assert.equal(kit.calls.references.length, 1);
  assert.equal(kit.calls.references[0].length, 50);
  assert.deepEqual(kit.calls.references[0], many.slice(-50));
  assert.equal(kit.calls.resolve.length, 8);
  assert.deepEqual(kit.calls.resolve, many.slice(-8).reverse(), 'newest first');
  assert.equal([...Array(50).keys()].every(index => kit.slotFor(many.slice(-50)[index]).children.length === 1), true);
  assert.equal(kit.slotFor(many[0]).children.length, 0);
});

test('an unchanged thread is revalidated on explicit refresh, not on passive polls', async () => {
  const kit = fixture();
  await kit.social._scanStoryContext(peer);
  await kit.social._scanStoryContext(peer);
  assert.equal(kit.calls.references.length, 1);
  assert.deepEqual(kit.calls.resolve, [replyId]);
  await kit.social._scanStoryContext(peer, true);
  assert.equal(kit.calls.references.length, 2);
  assert.deepEqual(kit.calls.resolve, [replyId, replyId]);
});

test('an account switch, a thread switch or a newer pass discards a late reference result', async () => {
  for (const boundary of ['account', 'thread', 'newer-pass', 'left-chat']) {
    const kit = fixture();
    let release;
    kit.service.replyReferences = () => new Promise(resolve => { release = () => resolve([replyId]); });
    const scanning = kit.social._scanStoryContext(peer);
    await new Promise(resolve => setImmediate(resolve));
    if (boundary === 'account') kit.state.owner = peer;
    else if (boundary === 'thread') kit.social._dmWith = owner;
    else if (boundary === 'left-chat') kit.social.sub = 'feed';
    else kit.social._storyContextPass = {};
    release();
    assert.equal(await scanning, false, boundary);
    assert.deepEqual(kit.calls.resolve, [], boundary);
    assert.equal(kit.dump().includes('View story'), false, boundary);
  }
});

test('a late resolve after an account switch writes no status and paints nothing', async () => {
  const kit = fixture();
  let release;
  kit.service.resolveContext = id => new Promise(resolve => { release = () => resolve({ available: true, story: { id: storyId } }); });
  const scanning = kit.social._scanStoryContext(peer);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const scope = kit.social._actionScope();
  kit.state.owner = peer;
  release();
  await scanning;
  assert.deepEqual(kit.calls.open, []);
  assert.equal(kit.social._storyContext.get(scope + ':' + peer).get(replyId), 'reference', 'the marker stays; the late resolve is dropped');
});

test('activation rechecks a cached reference and refuses to open a revoked Story', async () => {
  const kit = fixture();
  await kit.social._scanStoryContext(peer);
  kit.service.resolveContext = async id => { kit.calls.resolve.push(id); return { available: false }; };
  assert.equal(await kit.social.openStoryContext(replyId), false);
  assert.deepEqual(kit.calls.open, []);
  assert.equal(kit.toasts.at(-1), 'Story unavailable.');
  assert.ok(kit.dump().includes('Story unavailable'));
});

test('a late Story open failure cannot toast in another account', async () => {
  const kit = fixture();
  let rejectOpen;
  kit.service.open = () => new Promise((resolve, reject) => { rejectOpen = reject; });
  const opening = kit.social.openStoryContext(replyId);
  await new Promise(resolve => setImmediate(resolve));
  kit.state.owner = peer;
  kit.social._session += 1;
  rejectOpen(new Error('Stories are unavailable right now.'));
  assert.equal(await opening, false);
  assert.deepEqual(kit.toasts, []);
});

test('a duplicate activation is ignored and a Stories failure toasts instead of rejecting', async () => {
  const kit = fixture();
  let release;
  kit.service.resolveContext = id => new Promise(resolve => { kit.calls.resolve.push(id); release = () => resolve({ available: true, story: { id: storyId } }); });
  const first = kit.social.openStoryContext(replyId);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await kit.social.openStoryContext(replyId), false);
  assert.equal(kit.calls.resolve.length, 1);
  release();
  assert.equal(await first, true);

  kit.service.resolveContext = async () => ({ available: true, story: { id: storyId } });
  kit.service.open = async () => { throw new Error('Stories are unavailable right now.'); };
  assert.equal(await kit.social.openStoryContext(replyId), false);
  assert.equal(kit.toasts.at(-1), 'Stories are unavailable right now.');
});

test('private context state is dropped when the session resets', async () => {
  const kit = fixture();
  kit.social.cancelStory = () => {};
  kit.social.closeStory = () => {};
  await kit.social._scanStoryContext(peer);
  assert.equal(kit.social._storyContext.size, 1);
  kit.social.resetSession();
  assert.equal(kit.social._storyContext.size, 0);
  assert.equal(kit.social._storyContextPass, null);
  assert.equal(kit.social._storyContextOpening, null);
  assert.equal(kit.calls.reset, true);
});

test('the thread context cache stays bounded across many conversations', async () => {
  const kit = fixture();
  for (let index = 0; index < 12; index++) {
    kit.social._dmWith = 'peer-' + index;
    kit.social._storyContextMap(kit.social._dmWith);
  }
  assert.equal(kit.social._storyContext.size, 8);
});
