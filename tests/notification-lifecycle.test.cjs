'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const owner = '11111111-1111-4111-8111-111111111111';
const peer = '22222222-2222-4222-8222-222222222222';
const messageId = '33333333-3333-4333-8333-333333333333';
const timestamp = '2026-09-06T12:00:00.000Z';
const response = (rows, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => rows });
const flush = () => new Promise(resolve => setImmediate(resolve));

function cloudFixture(options = {}) {
  const state = { uid: owner, token: 'fresh-fixture-token', calls: [] };
  const context = vm.createContext({
    window: { SUPABASE_URL: 'https://fixture.invalid', SUPABASE_ANON_KEY: 'fixture-key', USE_SUPABASE_AUTH: true },
    SupaAuth: { active: () => true, uid: () => state.uid, token: async () => state.token, bearer: () => 'stale-fixture-token' },
    console, crypto: webcrypto, AbortController, URL, TextEncoder, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async (url, init) => { state.calls.push({ url, init }); return response([]); },
    ...options,
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'js/cloud.js'), 'utf8') + '\nglobalThis.subject = Cloud;', context);
  const cloud = context.subject;
  Object.assign(cloud, { me: owner, key: 'fixture-key', base: 'https://fixture.invalid/rest/v1' });
  return { context, cloud, state };
}

test('acknowledged message retries reuse a reference-only alert after a lost notification ACK', { timeout: 3000 }, async () => {
  const { context, cloud } = cloudFixture();
  const alerts = new Map(), notificationWrites = [];
  const written = [deferred(), deferred()];
  const message = { id: messageId, from_uid: owner, to_uid: peer, body: 'PRIVATE MESSAGE MUST NOT LEAK', ts: timestamp };
  context.fetch = async (url, init) => {
    if (new URL(url).pathname.endsWith('/messages')) return response([message]);
    const payload = JSON.parse(init.body);
    notificationWrites.push({ payload, url, init });
    if (!alerts.has(payload.id)) alerts.set(payload.id, { ...payload, read: false, ts: timestamp });
    written[notificationWrites.length - 1].resolve();
    if (notificationWrites.length === 1) throw new TypeError('Notification committed; ACK lost');
    return response([]);
  };
  assert.equal((await cloud.sendMessage(peer, message.body, messageId)).id, messageId);
  await written[0].promise;
  assert.equal((await cloud.sendMessage(peer, message.body, messageId)).id, messageId);
  await written[1].promise;
  assert.equal(alerts.size, 1, 'One acknowledged message must not fan out a new alert on retry');
  assert.equal(notificationWrites.length, 2);
  assert.equal(notificationWrites[0].payload.id, notificationWrites[1].payload.id);
  for (const write of notificationWrites) {
    assert.equal(Object.hasOwn(write.payload, 'body'), false);
    assert.equal(JSON.stringify(write).includes(message.body), false);
    assert.equal(new URL(write.url).searchParams.get('on_conflict'), 'id');
    assert.match(write.init.headers.Prefer, /resolution=ignore-duplicates/);
  }
});

test('an unacknowledged message never sends an alert', async () => {
  const { context, cloud, state } = cloudFixture();
  context.fetch = async (url, init) => { state.calls.push({ url, init }); return response([], 503); };
  assert.equal(await cloud.sendMessage(peer, 'Private failed message', messageId), false);
  await flush();
  assert.equal(state.calls.length, 1);
  assert.match(state.calls[0].url, /\/messages\?/);
});

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

const notification = (id = 'alert-1', extra = {}) => ({ id, uid: owner, actor: peer, type: 'message', post_id: null, ts: timestamp, read: false, ...extra });

test('listing selects and returns only owned references; empty and failure remain distinct', async () => {
  const { context, cloud, state } = cloudFixture();
  context.fetch = async (url, init) => { state.calls.push({ url, init }); return response([notification('old', { body: 'PRIVATE LEGACY PROSE', extra: { secret: 'PRIVATE' } })]); };
  const rows = await cloud.getNotifications();
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [notification('old')]);
  const url = new URL(state.calls[0].url);
  assert.equal(url.searchParams.get('select'), 'id,uid,actor,type,post_id,ts,read');
  assert.equal(url.searchParams.get('limit'), '60');
  assert.equal(url.searchParams.get('order'), 'ts.desc,id.desc');
  assert.equal(url.searchParams.get('uid'), 'eq.' + owner);
  assert.equal(state.calls[0].init.headers.Authorization, 'Bearer fresh-fixture-token');
  context.fetch = async () => response([]);
  assert.deepEqual(Array.from(await cloud.getNotifications()), []);
  for (const failure of [null, {}, [notification('foreign', { uid: peer })], [notification('bad', { read: 'false' })], [notification('bad', { actor: "actor'payload" })], [notification('bad', { ts: 'invalid' })], [notification(), notification()]]) {
    context.fetch = async () => response(failure);
    assert.equal(await cloud.getNotifications(), null);
  }
  context.fetch = async () => { throw new TypeError('offline'); };
  assert.equal(await cloud.getNotifications(), null);
});

test('exact reads require a fresh-token full owned ACK and retry already-read IDs without touching arrivals', async () => {
  const { context, cloud, state } = cloudFixture();
  const records = [notification('displayed-1'), notification('displayed-2'), notification('arrived-later')];
  context.fetch = async (url, init) => {
    state.calls.push({ url, init });
    const query = new URL(url).searchParams;
    assert.equal(query.get('uid'), 'eq.' + owner);
    assert.equal(query.get('id'), 'in.(displayed-1,displayed-2)');
    assert.equal(query.has('read'), false);
    assert.equal(query.get('select'), 'id,uid,read');
    assert.equal(init.headers.Authorization, 'Bearer fresh-fixture-token');
    assert.equal(init.headers.Prefer, 'return=representation');
    assert.deepEqual(JSON.parse(init.body), { read: true });
    records.slice(0, 2).forEach(row => { row.read = true; });
    if (state.calls.length === 1) throw new TypeError('Committed; ACK lost');
    return response(records.slice(0, 2).map(({ id, uid, read }) => ({ id, uid, read })));
  };
  assert.equal(await cloud.markNotifsRead(['displayed-1', 'displayed-2']), false);
  assert.equal(await cloud.markNotifsRead(['displayed-1', 'displayed-2']), true);
  assert.equal(records[2].read, false);
});

test('no empty, malformed, missing, duplicate, foreign or read-false receipt can acknowledge exact reads', async () => {
  const { context, cloud, state } = cloudFixture();
  for (const ids of [undefined, [], ['same', 'same'], ["id'payload"], Array.from({ length: 61 }, (_, index) => 'row-' + index)]) assert.equal(await cloud.markNotifsRead(ids), false);
  assert.equal(state.calls.length, 0);
  const good = { id: 'displayed', uid: owner, read: true };
  for (const receipt of [[], null, good, [{}], [{ ...good, uid: peer }], [{ ...good, read: false }], [{ ...good, read: 'true' }], [{ ...good, id: 'arrival' }], [good, good], [{ id: good.id, read: true }]]) {
    context.fetch = async () => response(receipt);
    assert.equal(await cloud.markNotifsRead(['displayed']), false, JSON.stringify(receipt));
  }
});

for (const phase of ['token', 'fetch', 'json']) {
  for (const action of ['list', 'read']) {
    test(`${action} has one hard deadline through ${phase}, even when abort is ignored`, async () => {
      const timers = [], waiting = deferred(), started = deferred();
      const { context, cloud, state } = cloudFixture({ setTimeout: (callback, milliseconds) => { assert.equal(milliseconds, 6000); timers.push(callback); return timers.length; }, clearTimeout() {} });
      if (phase === 'token') context.SupaAuth.token = () => { started.resolve(); return waiting.promise; };
      context.fetch = (url, init) => {
        state.calls.push({ url, init });
        if (phase === 'fetch') { started.resolve(); return waiting.promise; }
        return Promise.resolve({ ok: true, json: () => { started.resolve(); return waiting.promise; } });
      };
      const operation = action === 'read' ? cloud.markNotifsRead(['displayed']) : cloud.getNotifications();
      await started.promise;
      timers[0]();
      assert.equal(await operation, action === 'read' ? false : null);
      if (phase === 'token') { waiting.resolve('late-token'); await flush(); assert.equal(state.calls.length, 0); }
      else if (phase === 'fetch') waiting.resolve(response([notification('displayed', { read: true })]));
      else waiting.resolve([notification('displayed', { read: true })]);
      await flush();
      assert.equal(cloud._notificationControllers.size, 0);
    });
  }
}

for (const phase of ['token', 'json']) {
  test(`account/action generation fences a late ${phase} completion, including the same UID returning`, async () => {
    const { context, cloud, state } = cloudFixture();
    const waiting = deferred(), started = deferred();
    if (phase === 'token') context.SupaAuth.token = () => { started.resolve(); return waiting.promise; };
    context.fetch = async (url, init) => {
      state.calls.push({ url, init });
      return { ok: true, json: () => { started.resolve(); return waiting.promise; } };
    };
    const marking = cloud.markNotifsRead(['displayed']);
    await started.promise;
    cloud.resetNotifications();
    state.uid = peer; cloud.me = peer;
    state.uid = owner; cloud.me = owner;
    assert.equal(await marking, false);
    waiting.resolve(phase === 'token' ? 'late-token' : [{ id: 'displayed', uid: owner, read: true }]);
    await flush();
    if (phase === 'token') assert.equal(state.calls.length, 0);
    assert.equal(cloud._notificationControllers.size, 0);
  });
}

for (const type of ['comment', 'reply', 'mention', 'like']) {
  test(`${type} stable keys require a stored owned event and never copy prose`, async () => {
    const { context, cloud, state } = cloudFixture();
    let acknowledged = false;
    context.fetch = async (url, init) => {
      state.calls.push({ url, init });
      if (init.method === 'POST') return { ok: true };
      return response(acknowledged ? [type === 'like'
        ? { id: 'post-1', author: peer, likes: { [owner]: true } }
        : { id: 'event-1', author: owner, post_id: 'post-1', parent_id: 'parent-1' }] : []);
    };
    const event = type === 'like' ? 'post-1' : 'event-1';
    assert.equal(await cloud.notify(peer, type, 'post-1', 'PRIVATE COMMENT', event), false);
    assert.equal(state.calls.some(call => call.init.method === 'POST'), false);
    acknowledged = true;
    assert.equal(await cloud.notify(peer, type, 'post-1', 'PRIVATE COMMENT', event), true);
    assert.equal(await cloud.notify(peer, type, 'post-1', 'PRIVATE COMMENT', event), true);
    const writes = state.calls.filter(call => call.init.method === 'POST');
    assert.equal(JSON.parse(writes[0].init.body).id, JSON.parse(writes[1].init.body).id);
    assert.equal(JSON.stringify(writes).includes('PRIVATE COMMENT'), false);
  });
}

function appFixture() {
  const fixture = cloudFixture();
  const { context, cloud, state } = fixture;
  const elements = new Map(), storage = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', style: {}, dataset: {}, offsetWidth: 1,
      classList: { add() {}, remove() {}, contains: () => false }, querySelectorAll: () => [], remove() { elements.delete(id); } });
    return elements.get(id);
  };
  context.document = { addEventListener() {}, getElementById: element, querySelector: () => null, documentElement: { setAttribute() {} } };
  context.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  context.Store = { key: 'owner-store', state: { profile: {} } };
  context.Auth = { currentUser: () => ({ id: state.uid }) };
  vm.runInContext(fs.readFileSync(path.join(root, 'js/mod/social.js'), 'utf8') + '\nglobalThis.social = Social;', context);
  vm.runInContext(fs.readFileSync(path.join(root, 'js/app.js'), 'utf8') + '\nglobalThis.app = App;', context);
  const { app, social } = context;
  social.key = 'formora_social_owner';
  app._entry = 1; app.curTab = 'alerts'; app.ic = () => ''; app.emptyState = (_, title) => title;
  state.toasts = []; state.opened = []; state.pings = 0;
  app.toast = text => state.toasts.push(text);
  app.selectTab = tab => { app.curTab = tab; };
  social.cloudUser = uid => uid === peer ? { id: peer, name: '<Fixture Peer>', privacy: 'public' } : null;
  social.avatar = () => '<span>Avatar</span>'; social.timeAgo = () => 'now'; social.playPing = () => { state.pings++; };
  social.cloud.notifs = []; social.cloud.feed = []; social.state = { crew: [], posts: [] };
  social.postCard = post => '<article>' + post.id + '</article>';
  social._cloudPost = post => post;
  social.openDM = async actor => { state.opened.push(actor); social._dmWith = actor; social._dmReadError = false; social._dmThreadLoading = false; };
  social.viewProfile = actor => state.opened.push('profile:' + actor);
  return { ...fixture, app, social, elements, element, storage };
}

test('Alerts render and poll never mark automatically; failures retain reference-only rows and unread', async () => {
  const { context, cloud, app, social, element, state } = appFixture();
  context.fetch = async () => response([notification('shown', { body: 'SECRET LEGACY ALERT' })]);
  assert.equal(await app.pollNotifs(), true);
  app.renderAlerts();
  assert.equal(app._lastUnread, 1);
  assert.equal(JSON.stringify(social.cloud.notifs).includes('SECRET'), false);
  assert.equal(element('notif-list').innerHTML.includes('SECRET'), false);
  assert.match(element('notif-list').innerHTML, /Mark displayed read/);
  assert.doesNotMatch(element('notif-list').innerHTML, /onclick=|onkeydown=/);
  assert.match(element('notif-list').innerHTML, /&lt;Fixture Peer&gt;/);
  let marks = 0; cloud.markNotifsRead = async () => { marks++; return true; };
  context.fetch = async () => { throw new TypeError('offline'); };
  assert.equal(await app.pollNotifs(), false);
  assert.equal(social.cloud.notifs.length, 1);
  assert.equal(social.cloud.notifs[0].read, false);
  assert.equal(app._lastUnread, 1);
  assert.match(element('notif-list').innerHTML, /Retry/);
  assert.equal(marks, 0);
  assert.deepEqual(state.toasts, []);
  context.fetch = async () => response([]);
  assert.equal(await app.pollNotifs(), true);
  assert.equal(app._lastUnread, 0);
  assert.equal(social.cloud.notifs.length, 0);
});

test('explicit displayed-read waits for ACK, retry keeps its exact IDs, and arrivals stay unread', async () => {
  const { cloud, app, social, state, element } = appFixture();
  social.cloud.notifs = [notification('displayed')]; app.renderAlerts();
  const held = deferred(), written = [];
  cloud.markNotifsRead = ids => { written.push(Array.from(ids)); return held.promise; };
  const marking = app.markDisplayedNotifsRead();
  assert.equal(app._lastUnread, 1);
  assert.equal(social.cloud.notifs[0].read, false);
  assert.match(element('notif-list').innerHTML, /Confirming read/);
  assert.equal(await app.markDisplayedNotifsRead(), false);
  social.cloud.notifs.push(notification('arrival')); app.renderNotifPanel();
  held.resolve(false);
  assert.equal(await marking, false);
  assert.deepEqual(written, [['displayed']]);
  assert.match(element('notif-list').innerHTML, /Retry read/);
  assert.equal(social.cloud.notifs.every(row => !row.read), true);
  cloud.markNotifsRead = async ids => { written.push(Array.from(ids)); return true; };
  assert.equal(await app.retryNotifRead(), true);
  assert.deepEqual(written, [['displayed'], ['displayed']]);
  assert.equal(social.cloud.notifs[0].read, true);
  assert.equal(social.cloud.notifs[1].read, false);
  assert.equal(app._lastUnread, 1);
  assert.equal(state.toasts.length, 0, 'The visible retry status is sufficient inside Alerts');
});

test('a stale list cannot undo an exact read acknowledged while the list was pending', async () => {
  const { cloud, app, social } = appFixture();
  social.cloud.notifs = [notification('displayed')]; app.renderAlerts();
  const held = deferred(); cloud.getNotifications = () => held.promise;
  const polling = app.pollNotifs();
  cloud.markNotifsRead = async () => true;
  assert.equal(await app.markDisplayedNotifsRead(), true);
  held.resolve([notification('displayed'), notification('new')]);
  assert.equal(await polling, true);
  assert.equal(social.cloud.notifs[0].read, true);
  assert.equal(social.cloud.notifs[1].read, false);
  assert.equal(app._lastUnread, 1);
});

test('only a checked message participant opens, then only the clicked ID is read', async () => {
  const { cloud, context, app, social, state } = appFixture();
  social.cloud.notifs = [notification('clicked'), notification('other')]; app.renderAlerts();
  context.fetch = async (url, init) => {
    state.calls.push({ url, init });
    return response([{ id: messageId, from_uid: peer, to_uid: owner }]);
  };
  cloud.markNotifsRead = async ids => { assert.deepEqual(state.opened, [peer]); assert.deepEqual(Array.from(ids), ['clicked']); return true; };
  assert.equal(await app.openNotif('clicked'), true);
  assert.equal(social.cloud.notifs[0].read, true);
  assert.equal(social.cloud.notifs[1].read, false);
  const query = new URL(state.calls[0].url).searchParams;
  assert.equal(query.get('select'), 'id,from_uid,to_uid');
  assert.equal(query.get('from_uid'), 'eq.' + peer);
  assert.equal(query.get('to_uid'), 'eq.' + owner);
  context.fetch = async () => response([{ id: messageId, from_uid: peer, to_uid: peer }]);
  assert.equal(await app.openNotif('other'), false);
  assert.deepEqual(state.opened, [peer]);
  assert.equal(social.cloud.notifs[1].read, false);
});

test('post alerts open existing visible posts, never a wrong profile or invented deleted media', async () => {
  const { cloud, app, social, element, state } = appFixture();
  social.cloud.notifs = [notification('post-alert', { type: 'comment', post_id: 'post-1' })]; app.renderAlerts();
  let marks = 0; cloud.markNotifsRead = async () => { marks++; return true; };
  assert.equal(await app.openNotif('post-alert'), false);
  assert.equal(marks, 0);
  social.cloud.feed = [{ id: 'post-1', author: peer, text: 'Existing visible post' }];
  social._canSeePost = () => false;
  assert.equal(await app.openNotif('post-alert'), false);
  assert.equal(marks, 0);
  social._canSeePost = () => true;
  const target = { scrollIntoView() { state.scrolled = true; }, focus() { state.focused = true; } };
  element('view-feed').querySelectorAll = () => [{ dataset: { savedPost: 'post-1' }, closest: () => target }];
  assert.equal(await app.openNotif('post-alert'), true);
  assert.equal(state.scrolled, true);
  assert.equal(state.focused, true);
  assert.equal(app.curTab, 'home');
  assert.equal(element('modal-card').innerHTML, '');
  assert.deepEqual(state.opened, []);
  assert.equal(marks, 1);
});

test('account reset prevents late list, target and read results from changing or toasting another account', async () => {
  for (const action of ['list', 'target', 'read']) {
    const { cloud, app, social, state, element } = appFixture();
    const held = deferred();
    social.cloud.notifs = [notification('old')]; app.renderAlerts();
    if (action === 'list') cloud.getNotifications = () => held.promise;
    if (action === 'target') cloud.notificationMessageAvailable = () => held.promise;
    if (action === 'read') cloud.markNotifsRead = () => held.promise;
    const operation = action === 'list' ? app.pollNotifs() : action === 'target' ? app.openNotif('old') : app.markDisplayedNotifsRead();
    app.closeModal = () => {}; app.closeSheet = () => {};
    app._invalidateAccount();
    state.uid = peer; cloud.me = peer; app.curTab = 'alerts';
    social.cloud.notifs = [notification('new-account', { uid: peer, actor: owner })]; app.renderAlerts();
    held.resolve(action === 'list' ? [notification('old', { body: 'SECRET OLD PROSE' })] : true);
    assert.equal(await operation, false);
    assert.equal(social.cloud.notifs[0].id, 'new-account');
    assert.equal(social.cloud.notifs[0].read, false);
    assert.equal(element('notif-list').innerHTML.includes('SECRET'), false);
    assert.deepEqual(state.toasts, []);
    assert.deepEqual(state.opened, []);
  }
});

test('read and notification aliases fail closed without an unambiguous displayed row', async () => {
  const { cloud, app, social } = appFixture();
  let calls = 0; cloud.markNotifsRead = async () => { calls++; return true; };
  social.cloud.notifs = [notification('first'), notification('second')]; app.renderAlerts();
  assert.equal(await app.openNotif(peer, 'message'), false);
  assert.equal(await app._markNotifIds(['not-displayed']), false);
  assert.equal(calls, 0);
  social.cloud.notifs = [notification('first', { actor: "x' onclick='attack" })]; app.renderNotifPanel();
  assert.equal(social.cloud.notifs.length, 0);
  assert.equal(await app.markDisplayedNotifsRead(), false);
});

test('notification sounds seed once, skip already-read arrivals and respect account sound plus actor mute', async () => {
  const { cloud, app, social, storage, state } = appFixture();
  let rows = [notification('seed')];
  cloud.getNotifications = async () => rows;
  await app.pollNotifs();
  assert.equal(state.pings, 0);
  rows = rows.concat(notification('fresh'), notification('already-read', { read: true }));
  await app.pollNotifs();
  assert.equal(state.pings, 1);
  rows = rows.map(row => ({ ...row, read: false }));
  await app.pollNotifs();
  assert.equal(state.pings, 1, 'Read arrivals are seeded too, and cannot sound on a stale unread snapshot');
  storage.set(social._listKey('fm_msgsound'), 'off');
  rows = rows.concat(notification('sound-off')); await app.pollNotifs();
  assert.equal(state.pings, 1);
  storage.set(social._listKey('fm_msgsound'), 'on');
  social._setList('fm_muted', [peer]);
  rows = rows.concat(notification('actor-muted')); await app.pollNotifs();
  assert.equal(state.pings, 1);
  social._setList('fm_muted', []);
  social.sub = 'chat'; social._dmWith = peer;
  rows = rows.concat(notification('chat-open')); await app.pollNotifs();
  assert.equal(state.pings, 1);
  social.sub = 'feed';
  social.playPing = () => Promise.reject(new Error('Audio unavailable'));
  rows = rows.concat(notification('audio-failure'));
  assert.equal(await app.pollNotifs(), true);
  await flush();
});

test('message sound preserves legacy device silence until an explicit account choice and handles storage failure', () => {
  const { context, cloud, social, storage, state } = appFixture();
  social.chatDetails = () => {};
  storage.set('fm_msgsound', 'off');
  assert.equal(social.msgSoundOff(), true);
  assert.equal(social.toggleMsgSound(), true);
  assert.equal(storage.get('fm_msgsound_cloud_' + owner), 'on');
  assert.equal(social.toggleMsgSound(), true);
  assert.equal(storage.get('fm_msgsound_cloud_' + owner), 'off');
  assert.equal(storage.get('fm_msgsound'), 'off');
  state.uid = peer; cloud.me = peer;
  assert.equal(social.msgSoundOff(), true);
  assert.equal(social.toggleMsgSound(), true);
  assert.equal(storage.get('fm_msgsound_cloud_' + peer), 'on');
  assert.equal(social.toggleMsgSound(), true);
  assert.equal(storage.get('fm_msgsound_cloud_' + peer), 'off');
  state.uid = owner; cloud.me = owner;
  assert.equal(social.msgSoundOff(), true);
  context.localStorage.setItem = () => { throw new Error('quota'); };
  assert.equal(social.toggleMsgSound(), false);
  assert.equal(social.msgSoundOff(), true);
  assert.match(state.toasts.at(-1), /Could not update/);
});

test('like notification dispatch waits for write ACK and ignores stale account completion', async () => {
  for (const result of [true, false, 'account-change']) {
    const { cloud, social, state } = appFixture();
    const waiting = deferred(), calls = [];
    social.render = () => {}; social.haptic = () => {};
    social.cloud.feed = [{ id: 'like-post', author: peer, likes: {}, text: 'PRIVATE POST' }];
    cloud.likeCloud = () => waiting.promise;
    cloud.notify = (...args) => { calls.push(args); return Promise.resolve(true); };
    social.likePost('like-post');
    assert.equal(calls.length, 0);
    if (result === 'account-change') { state.uid = peer; cloud.me = peer; }
    waiting.resolve(result === false ? false : true); await flush();
    assert.deepEqual(calls, result === true ? [[peer, 'like', 'like-post', undefined, 'like-post']] : []);
  }
});

test('a lost message ACK dispatches nothing until reconciliation, then notification retries preserve one read row', { timeout: 3000 }, async () => {
  const { context, cloud } = cloudFixture();
  const message = { id: messageId, from_uid: owner, to_uid: peer, body: 'PRIVATE RECONCILED MESSAGE', ts: timestamp };
  let saved = false;
  const notifications = new Map(), writes = [];
  const written = [deferred(), deferred()];
  context.fetch = async (url, init) => {
    if (new URL(url).pathname.endsWith('/messages')) {
      if (init.method === 'GET') return response([message]);
      if (!saved) { saved = true; throw new TypeError('Message committed; ACK lost'); }
      return response([], 409);
    }
    const payload = JSON.parse(init.body); writes.push(payload);
    if (!notifications.has(payload.id)) notifications.set(payload.id, { ...payload, read: false });
    written[writes.length - 1].resolve();
    if (writes.length === 1) throw new TypeError('Notification committed; ACK lost');
    return { ok: true };
  };
  assert.equal(await cloud.sendMessage(peer, message.body, messageId), false);
  await flush();
  assert.equal(writes.length, 0);
  assert.equal((await cloud.sendMessage(peer, message.body, messageId)).id, messageId);
  await written[0].promise;
  assert.equal(notifications.size, 1);
  notifications.values().next().value.read = true;
  assert.equal((await cloud.sendMessage(peer, message.body, messageId)).id, messageId);
  await written[1].promise;
  assert.equal(writes.length, 2);
  assert.equal(notifications.size, 1);
  assert.equal(notifications.values().next().value.read, true);
  assert.equal(JSON.stringify(writes).includes(message.body), false);
});

test('a message acknowledgement cannot dispatch into a replacement notification generation', async () => {
  const { cloud } = cloudFixture();
  const waiting = deferred();
  let notified = false;
  cloud._writeAction = () => waiting.promise;
  cloud.notify = async () => { notified = true; };
  const sending = cloud.sendMessage(peer, 'Private', messageId);
  cloud.resetNotifications();
  waiting.resolve({ id: messageId, from_uid: owner, to_uid: peer, body: 'Private', ts: timestamp });
  await sending; await flush();
  assert.equal(notified, false);
});

test('a rejected AudioContext resume cannot escape as an unhandled notification rejection', async () => {
  const { context, social, storage } = appFixture();
  const audio = { state: 'suspended', resume: () => Promise.reject(new Error('Audio permission unavailable')),
    currentTime: 0, destination: {}, createOscillator: () => ({ frequency: {}, connect() {}, start() {}, stop() {} }),
    createGain: () => ({ gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }) };
  storage.set(social._listKey('fm_msgsound'), 'on');
  social._actx = audio; context.window.AudioContext = function AudioContext() {};
  const source = fs.readFileSync(path.join(root, 'js/mod/social.js'), 'utf8');
  const isolated = vm.createContext({ window: context.window, localStorage: context.localStorage, console });
  vm.runInContext(source + '\nglobalThis.playPing = Social.playPing;', isolated);
  isolated.playPing.call(social);
  await flush();
});

test('an accept notification cannot invent a connection or auto-follow an actor', async () => {
  const { cloud, app, social } = appFixture();
  social.cloud.connections = [];
  social.syncAutoFollow = () => { throw new Error('Notifications are not relationship receipts'); };
  cloud.getNotifications = async () => [notification('untrusted-accept', { type: 'accept' })];
  assert.equal(await app.pollNotifs(), true);
  assert.equal(social.cloud.connections.length, 0);
});