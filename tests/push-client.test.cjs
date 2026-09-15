'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID, webcrypto, createECDH, randomBytes } = require('node:crypto');
const workerSource = fs.readFileSync(path.join(__dirname, '../push-worker.js'), 'utf8');
const appURL = 'https://app.example.test/formora/';

function workerFixture(shared = new Map()) {
  const listeners = {}, shown = [], opened = [], notified = [], existing = [];
  let closed = 0, focused = 0;
  const indexedDB = {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = {
          close() {}, createObjectStore() {},
          transaction() {
            const transaction = { abort() { transaction.onabort?.(); } };
            transaction.objectStore = () => ({
              get: key => operation(() => shared.get(key)),
              put: (value, key) => operation(() => shared.set(key, value)),
              delete: key => operation(() => shared.delete(key))
            });
            function operation(work) {
              const result = {};
              queueMicrotask(() => { result.result = work(); result.onsuccess?.(); transaction.oncomplete?.(); });
              return result;
            }
            return transaction;
          }
        };
        request.onsuccess();
      });
      return request;
    }
  };
  const context = vm.createContext({ URL, Date, setTimeout, clearTimeout,
    self: { location: new URL('push-worker.js', appURL), indexedDB,
      addEventListener: (type, handler) => { listeners[type] = handler; },
      registration: { scope: new URL('__push__/', appURL).href,
        showNotification: async (title, options) => shown.push({ title, options }),
        getNotifications: async () => shown.map(() => ({ close: () => { closed++; } })) },
      clients: {
        matchAll: async () => existing,
        openWindow: async url => opened.push(url)
      } }
  });
  vm.runInContext(workerSource, context);
  async function dispatch(type, event = {}) {
    let pending;
    listeners[type]({ ...event, waitUntil: promise => { pending = promise; } });
    await pending;
  }
  async function control(type, binding, source = {}) {
    let acknowledgement;
    await dispatch('message', { data: { type, request_id: randomUUID(), binding },
      source: { id: 'app-tab', type: 'window', url: appURL, ...source },
      ports: [{ postMessage: value => { acknowledgement = value; }, close() {} }] });
    return acknowledgement;
  }
  const binding = { binding_id: randomUUID(), expires_at: Date.now() + 86400000 };
  const payload = { v: 1, kind: 'app_update', binding_id: binding.binding_id };
  return { context, shared, listeners, shown, opened, notified, existing, binding, payload, dispatch, control,
    get closed() { return closed; }, get focused() { return focused; },
    addWindow(url = appURL) { existing.push({ url, focus: async () => { focused++; }, postMessage: value => notified.push(value) }); },
    push(value = payload) { return dispatch('push', { data: value === null ? null : { text: () => typeof value === 'string' ? value : JSON.stringify(value) } }); },
    click(data, tag = 'formora-app-update') { return dispatch('notificationclick', { notification: { tag, data, close: () => { closed++; } } }); }
  };
}

test('push worker is push-only, leaves app uncontrolled, and has no cache, fetch, install or activation handler', async () => {
  const fixture = workerFixture();
  assert.deepEqual(Object.keys(fixture.listeners).sort(), ['message', 'notificationclick', 'push', 'pushsubscriptionchange']);
  assert.doesNotMatch(workerSource, /\b(?:fetch|caches|importScripts|skipWaiting)\s*[.(]|clients\.claim/);
  await fixture.push();
  assert.equal(fixture.shown.length, 0);
  assert.equal(fixture.shared.size, 0);
});

test('worker requires an acknowledged unexpired binding and only renders fixed generic app copy', async () => {
  const fixture = workerFixture();
  assert.equal((await fixture.control('formora-push:bind', fixture.binding)).ok, true);
  await fixture.push();
  assert.equal(fixture.shown.length, 1);
  const notification = fixture.shown[0];
  assert.equal(notification.title, 'Formora');
  assert.equal(notification.options.body, "Open Formora to see what's new.");
  assert.equal(notification.options.silent, true);
  assert.equal(notification.options.data.url, appURL);
  assert.doesNotMatch(JSON.stringify(notification), /owner_id|endpoint|p256dh|health|weight|message_preview|advert/);
  await fixture.control('formora-push:mute');
  await fixture.push();
  assert.equal(fixture.shown.length, 1);
  assert.equal(fixture.closed, 1);
});

test('payload validation rejects sensitive fields, unexpected categories, wrong owners, invalid or oversized JSON', async () => {
  const fixture = workerFixture();
  await fixture.control('formora-push:bind', fixture.binding);
  const badPayloads = [null, '{}', 'bad-json', 'a'.repeat(1025), [],
    { ...fixture.payload, title: 'Health preview' }, { ...fixture.payload, body: 'Private DM' },
    { ...fixture.payload, kind: 'advertisement' }, { ...fixture.payload, v: 2 },
    { ...fixture.payload, binding_id: randomUUID() }];
  for (const payload of badPayloads) await fixture.push(payload);
  assert.equal(fixture.shown.length, 0);
});

test('push and clicks allow only exact same-origin app entry URLs, never URLs with credentials, tracking or recovery data', async () => {
  const fixture = workerFixture();
  await fixture.control('formora-push:bind', fixture.binding);
  const badURLs = ['https://evil.test/', '//evil.test/', 'javascript:alert(1)',
    'https://app.example.test/other/', appURL + '?access_token=secret', appURL + '#recovery',
    'https://user:pass@app.example.test/formora/', appURL + '../formora/', appURL + 'legal.html'];
  for (const url of badURLs) {
    await fixture.push({ ...fixture.payload, url });
    await fixture.click({ binding_id: fixture.binding.binding_id, url });
  }
  assert.equal(fixture.shown.length, 0);
  assert.equal(fixture.opened.length, 0);
  await fixture.push({ ...fixture.payload, url: appURL + 'index.html' });
  await fixture.click(fixture.shown[0].options.data);
  assert.deepEqual(fixture.opened, [appURL + 'index.html']);
  fixture.addWindow(appURL + '?u=175');
  await fixture.click(fixture.shown[0].options.data);
  assert.equal(fixture.focused, 1);
  assert.equal(fixture.opened.length, 1);
  await fixture.control('formora-push:mute');
  await fixture.click(fixture.shown[0].options.data);
  assert.equal(fixture.focused, 1);
});

test('worker control messages reject foreign origins, sibling apps and non-window senders', async () => {
  const fixture = workerFixture();
  for (const source of [{ url: 'https://evil.test/' }, { url: 'https://app.example.test/other/' },
    { type: 'worker' }, { id: '' }]) {
    assert.equal(await fixture.control('formora-push:bind', fixture.binding, source), undefined);
  }
  assert.equal((await fixture.control('formora-push:bind', { ...fixture.binding, expires_at: Date.now() - 1 })).ok, false);
  assert.equal(fixture.shared.size, 0);
});

test('worker restart retains only the opaque binding; subscription changes mute without network or auto-resubscribe', async () => {
  const fixture = workerFixture();
  await fixture.control('formora-push:bind', fixture.binding);
  const restarted = workerFixture(fixture.shared);
  await restarted.push(fixture.payload);
  assert.equal(restarted.shown.length, 1);
  restarted.addWindow();
  await restarted.dispatch('pushsubscriptionchange');
  await restarted.push(fixture.payload);
  assert.equal(restarted.shown.length, 1);
  assert.equal(restarted.shared.size, 0);
  assert.equal(restarted.notified[0].type, 'formora-push:subscription-change');
});

const clientSource = fs.readFileSync(path.join(__dirname, '../js/mod/push.js'), 'utf8');
const firstOwner = '11111111-1111-4111-8111-111111111111';
const secondOwner = '22222222-2222-4222-8222-222222222222';

function testKey() {
  const key = createECDH('prime256v1');
  key.generateKeys();
  return key.getPublicKey().toString('base64url');
}

function clientFixture(options = {}) {
  const storage = options.storage || new Map(), requests = [], controls = [], listeners = {};
  const key = options.key || testKey();
  const runtime = { owner: firstOwner, permission: 'default', promptCount: 0, subscribed: 0, unsubscribed: 0,
    workerCreated: false, workerRegistered: 0, workerBound: null, browserSubscription: null,
    denyMute: false, denyBind: false, unsubscribeFails: false, ...options.runtime };
  const server = options.server || { revision: 0, rows: new Map(), receipts: new Map(), enabled: true };
  const subscriptionJSON = options.subscriptionJSON || { endpoint: 'https://fcm.googleapis.com/fcm/send/' + randomBytes(36).toString('base64url'),
    expirationTime: null, keys: { p256dh: testKey(), auth: randomBytes(16).toString('base64url') } };
  class TestEvent { constructor(type, trusted = true) { this.type = type; this.isTrusted = trusted; } }
  class TestChannel {
    constructor() {
      this.port1 = { close() {} };
      this.port2 = { close() {}, postMessage: value => queueMicrotask(() => this.port1.onmessage?.({ data: value })) };
    }
  }
  const subscription = { toJSON: () => subscriptionJSON,
    options: { userVisibleOnly: true, applicationServerKey: Uint8Array.from(Buffer.from(key, 'base64url')).buffer },
    unsubscribe: async () => { runtime.unsubscribed++; if (runtime.unsubscribeFails) return false; runtime.browserSubscription = null; return true; } };
  const registration = { scope: new URL('__push__/', appURL).href,
    active: { state: 'activated', scriptURL: new URL('push-worker.js', appURL).href,
      postMessage(message, ports) {
        controls.push(message);
        const ok = !(message.type.endsWith(':mute') ? runtime.denyMute : runtime.denyBind);
        if (ok) runtime.workerBound = message.type.endsWith(':bind') ? message.binding : null;
        ports[0].postMessage({ type: message.type, request_id: message.request_id, ok });
      } },
    pushManager: {
      getSubscription: async () => runtime.browserSubscription,
      subscribe: async () => { runtime.subscribed++; runtime.browserSubscription = subscription; return subscription; }
    } };
  function respond(value, status = 200) { return new Response(JSON.stringify(value), { status }); }
  const root = {
    location: new URL(appURL), isSecureContext: true, Event: TestEvent,
    crypto: webcrypto, TextEncoder, TextDecoder, AbortController, MessageChannel: TestChannel,
    atob: value => Buffer.from(value, 'base64').toString('binary'), btoa: value => Buffer.from(value, 'binary').toString('base64'),
    SUPABASE_URL: 'https://push-fixture.supabase.co', SUPABASE_ANON_KEY: 'public-fixture-anon',
    FORMORA_WEB_PUSH: options.enabled !== false, FORMORA_PUSH_VAPID_PUBLIC_KEY: key,
    Notification: { get permission() { return runtime.permission; }, requestPermission: () => { runtime.promptCount++; runtime.permission = runtime.permissionResult || 'granted'; return Promise.resolve(runtime.permission); } },
    PushManager: function () {}, indexedDB: { open() {} },
    localStorage: { getItem: name => storage.get(name) || null, setItem: (name, value) => storage.set(name, value) },
    addEventListener: (name, handler) => { (listeners[name] ||= []).push(handler); },
    removeEventListener() {},
    navigator: { userActivation: { isActive: true }, locks: { request: async (name, settings, callback) => callback(runtime.otherTabBusy ? null : {}) },
      serviceWorker: { getRegistrations: async () => runtime.workerCreated ? [registration] : [],
        register: async () => { runtime.workerRegistered++; runtime.workerCreated = true; return registration; },
        addEventListener: (name, handler) => { listeners['worker:' + name] = [handler]; }, removeEventListener() {} } },
    SupaAuth: { KEY: 'formora_supa_session', active: () => true, uid: () => runtime.owner,
      token: async () => 'verified-owner-jwt-fixture-token', load() {} },
    fetch: async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : null;
      requests.push({ url, init, body });
      if (runtime.fetchOverride) return runtime.fetchOverride(url, init, body);
      if (url.endsWith('/auth/v1/user')) return respond({ id: runtime.verifiedOwner || runtime.owner });
      const row = server.rows.get(body.p_device_id);
      if (url.endsWith('/get_push_subscription_state')) return respond({ owner_id: runtime.owner, revision: server.revision,
        registration_enabled: server.enabled, delivery_implemented: true, delivery_enabled: false,
        vapid_public_key: key, consent_version: 'push-generic-v1',
        device_registered: !!row, binding_id: row?.binding_id || null, fingerprint: row?.fingerprint || null,
        expires_at: row?.expires_at || null, registered_devices: server.rows.size });
      const previous = server.receipts.get(body.p_request_id);
      if (previous) return respond(previous);
      if (body.p_expected_revision !== server.revision) return respond({}, 409);
      let receipt;
      if (url.endsWith('/register_push_subscription')) {
        const fingerprint = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(body.p_endpoint + '\n' + body.p_p256dh + '\n' + body.p_auth))).toString('hex');
        receipt = { ok: true, operation: 'register', request_id: body.p_request_id, device_id: body.p_device_id,
          owner_id: runtime.owner, revision: ++server.revision, binding_id: randomUUID(), fingerprint,
          expires_at: new Date(Date.now() + 86400000).toISOString(), delivery_implemented: true };
        server.rows.set(body.p_device_id, receipt);
      } else {
        const removed = body.p_all ? server.rows.size : Number(server.rows.has(body.p_device_id));
        if (body.p_all) server.rows.clear(); else server.rows.delete(body.p_device_id);
        receipt = { ok: true, operation: body.p_all ? 'revoke_all' : 'revoke_device', request_id: body.p_request_id,
          owner_id: runtime.owner, device_id: body.p_device_id, revision: ++server.revision, revoked_count: removed };
      }
      server.receipts.set(body.p_request_id, receipt);
      if (runtime.loseAcknowledgement) throw new Error('lost after commit');
      return respond(runtime.malformedReceipt ? { ...receipt, ok: undefined } : receipt);
    }
  };
  const context = vm.createContext({ window: root, SupaAuth: root.SupaAuth, URL, Uint8Array, setTimeout, clearTimeout });
  vm.runInContext(clientSource, context);
  const controller = root.FormoraPush.create({ timeoutMs: 50, permissionTimeoutMs: 50, ...options.controller });
  return { root, context, runtime, server, storage, requests, controls, registration, subscription, subscriptionJSON, key, controller,
    event: (trusted = true) => new TestEvent('click', trusted),
    dispatch: (name, value = {}) => { for (const handler of listeners[name] || []) handler(value); },
    respond };
}

test('client is default-off and capability checks never request permission, subscribe or contact Supabase', async () => {
  const fixture = clientFixture({ enabled: false });
  assert.equal(fixture.controller.getState().status, 'disabled');
  await fixture.controller.refresh();
  await fixture.controller.enableFromUserGesture(fixture.event());
  assert.equal(fixture.runtime.promptCount, 0);
  assert.equal(fixture.runtime.workerRegistered, 0);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.storage.size, 0);
  fixture.root.FORMORA_WEB_PUSH = true;
  fixture.root.isSecureContext = false;
  assert.equal((await fixture.controller.refresh()).code, 'unsupported');
  assert.equal(fixture.requests.length, 0);
});

test('only an explicit trusted user command prompts; refresh verifies JWT ownership without prompting', async () => {
  const fixture = clientFixture();
  assert.equal((await fixture.controller.refresh()).ok, true);
  assert.equal(fixture.runtime.promptCount, 0);
  assert.equal((await fixture.controller.enableFromUserGesture(fixture.event(false))).code, 'explicit_command_required');
  assert.equal((await fixture.controller.enableFromUserGesture({ isTrusted: true, type: 'click' })).code, 'explicit_command_required');
  assert.equal((await fixture.controller.enableFromUserGesture(fixture.event())).ok, true);
  assert.equal(fixture.runtime.promptCount, 1);
  assert.equal(fixture.runtime.subscribed, 1);
  assert.equal(fixture.controller.getState().registered, true);
  assert.equal(fixture.controller.getState().delivery, 'implemented_disabled');
  const request = fixture.requests.find(value => value.url.endsWith('/register_push_subscription'));
  assert.equal(request.init.headers.Authorization, 'Bearer verified-owner-jwt-fixture-token');
  assert.equal(request.init.redirect, 'error');
  assert.equal('p_uid' in request.body, false);
  assert.equal('owner_id' in request.body, false);
  assert.doesNotMatch([...fixture.storage.values()].join(''), /fcm\.googleapis|p256dh|verified-owner-jwt|auth_secret/);
});

test('denied permission, missing identity and verified-owner mismatch never subscribe or fall back to anon', async () => {
  const denied = clientFixture({ runtime: { permissionResult: 'denied' } });
  await denied.controller.refresh();
  assert.equal((await denied.controller.enableFromUserGesture(denied.event())).code, 'permission_denied');
  assert.equal(denied.runtime.subscribed, 0);
  for (const runtime of [{ owner: '' }, { verifiedOwner: secondOwner }]) {
    const fixture = clientFixture({ runtime });
    assert.equal((await fixture.controller.refresh()).code, 'sign_in_required');
    assert.equal(fixture.runtime.promptCount, 0);
    assert.equal(fixture.requests.some(value => value.url.includes('/rpc/')), false);
  }
});

test('lost registration acknowledgement reuses the request across reload without duplicating browser subscription', async () => {
  const fixture = clientFixture();
  await fixture.controller.refresh();
  fixture.runtime.loseAcknowledgement = true;
  assert.equal((await fixture.controller.enableFromUserGesture(fixture.event())).ok, false);
  assert.equal(fixture.runtime.workerBound, null);
  const previous = fixture.requests.find(value => value.url.endsWith('/register_push_subscription')).body;
  const reloaded = clientFixture({ storage: fixture.storage, server: fixture.server, key: fixture.key,
    subscriptionJSON: fixture.subscriptionJSON, runtime: { permission: 'granted', workerCreated: true, browserSubscription: fixture.subscription } });
  assert.equal((await reloaded.controller.retryFromUserGesture(reloaded.event())).ok, true);
  const retried = reloaded.requests.find(value => value.url.endsWith('/register_push_subscription')).body;
  assert.deepEqual(retried, previous);
  assert.equal(reloaded.runtime.promptCount, 0);
  assert.equal(reloaded.runtime.subscribed, 0);
});

test('revocation waits for server acknowledgement; failed browser cleanup is not success', async () => {
  const fixture = clientFixture();
  await fixture.controller.refresh();
  await fixture.controller.enableFromUserGesture(fixture.event());
  fixture.runtime.loseAcknowledgement = true;
  assert.equal((await fixture.controller.revokeAll()).ok, false);
  assert.equal(fixture.runtime.unsubscribed, 0);
  assert.equal(fixture.runtime.workerBound, null);
  fixture.runtime.loseAcknowledgement = false;
  fixture.runtime.unsubscribeFails = true;
  const partial = await fixture.controller.retryFromUserGesture(fixture.event());
  assert.equal(partial.ok, false);
  assert.equal(partial.serverAcknowledged, true);
  assert.equal(partial.localCleanup, false);
  assert.equal(partial.code, 'local_cleanup_pending');
  fixture.runtime.unsubscribeFails = false;
  assert.equal((await fixture.controller.retryFromUserGesture(fixture.event())).ok, true);
  assert.equal(fixture.controller.getState().status, 'off');
});

test('revoke-before-account-change permits a fresh account only after acknowledged local and server cleanup', async () => {
  const fixture = clientFixture();
  await fixture.controller.refresh();
  await fixture.controller.enableFromUserGesture(fixture.event());
  const removed = await fixture.controller.beforeAccountChange();
  assert.equal(removed.ok, true);
  assert.equal(removed.serverAcknowledged, true);
  assert.equal(removed.localCleanup, true);
  fixture.runtime.owner = secondOwner;
  fixture.dispatch('formora:sessionchange');
  await fixture.controller.refresh();
  assert.equal((await fixture.controller.enableFromUserGesture(fixture.event())).ok, true);
  assert.equal(fixture.runtime.promptCount, 1);
  assert.equal(fixture.server.rows.size, 1);
});

test('stale registration response cannot bind after logout or enable notifications for the next account', async () => {
  const fixture = clientFixture();
  await fixture.controller.refresh();
  const originalFetch = fixture.root.fetch;
  let release, committed;
  const waiting = new Promise(resolve => { committed = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  fixture.root.fetch = async (url, init) => {
    const response = await originalFetch(url, init);
    if (url.endsWith('/register_push_subscription')) { committed(); await gate; }
    return response;
  };
  const enabling = fixture.controller.enableFromUserGesture(fixture.event());
  await waiting;
  fixture.runtime.owner = secondOwner;
  fixture.dispatch('formora:sessionchange');
  release();
  assert.equal((await enabling).ok, false);
  assert.equal(fixture.runtime.workerBound, null);
  assert.equal(fixture.controller.getState().requiresPreviousAccount, true);
  assert.equal((await fixture.controller.refresh()).ok, false);
  assert.equal((await fixture.controller.enableFromUserGesture(fixture.event())).ok, false);
  assert.equal(fixture.runtime.promptCount, 1);
});

test('an opt-out attempted offline stays pending and a later refresh cannot re-arm the worker', async () => {
  const fixture = clientFixture();
  await fixture.controller.refresh();
  await fixture.controller.enableFromUserGesture(fixture.event());
  fixture.runtime.fetchOverride = async () => { throw new Error('offline'); };
  const outcome = await fixture.controller.revokeDevice();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.serverAcknowledged, false);
  fixture.runtime.fetchOverride = null;
  await fixture.controller.refresh();
  assert.equal(fixture.runtime.workerBound, null);
  assert.notEqual(fixture.controller.getState().status, 'registered');
  assert.equal(JSON.parse([...fixture.storage.values()][0]).phase, 'revocation_pending');
});

test('disabling the feature after opt-in stops locally but never claims server revocation', async () => {
  const fixture = clientFixture();
  await fixture.controller.refresh();
  await fixture.controller.enableFromUserGesture(fixture.event());
  fixture.root.FORMORA_WEB_PUSH = false;
  const requestCount = fixture.requests.length;
  const outcome = await fixture.controller.refresh();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.serverAcknowledged, false);
  assert.equal(fixture.runtime.workerBound, null);
  assert.equal(fixture.requests.length, requestCount);
  assert.equal(fixture.server.rows.size, 1);
});

test('a cold controller still mutes a previous binding on session invalidation before refresh', async () => {
  const fixture = clientFixture();
  await fixture.controller.refresh();
  await fixture.controller.enableFromUserGesture(fixture.event());
  const reloaded = clientFixture({ storage: fixture.storage, key: fixture.key,
    runtime: { workerCreated: true, workerBound: fixture.runtime.workerBound, browserSubscription: fixture.subscription } });
  reloaded.runtime.owner = '';
  reloaded.dispatch('formora:sessionchange');
  await new Promise(setImmediate);
  assert.equal(reloaded.runtime.workerBound, null);
  assert.equal(reloaded.controller.getState().requiresPreviousAccount, true);
  assert.equal(reloaded.requests.length, 0);
});

test('a subscription appearing after preparation is not adopted or rebound by a fresh enable command', async () => {
  const fixture = clientFixture();
  await fixture.controller.refresh();
  fixture.runtime.workerCreated = true;
  fixture.runtime.browserSubscription = fixture.subscription;
  const outcome = await fixture.controller.enableFromUserGesture(fixture.event());
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'unmanaged_subscription');
  assert.equal(fixture.server.rows.size, 0);
});

test('bounded RPC response-body timeout keeps ambiguous registration retryable without a worker binding', async () => {
  const fixture = clientFixture();
  await fixture.controller.refresh();
  const originalFetch = fixture.root.fetch;
  let aborted = false;
  fixture.root.fetch = async (url, init) => {
    const response = await originalFetch(url, init);
    if (!url.endsWith('/register_push_subscription')) return response;
    init.signal.addEventListener('abort', () => { aborted = true; });
    return new Response(new ReadableStream({ start() {} }));
  };
  const outcome = await fixture.controller.enableFromUserGesture(fixture.event());
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'timeout');
  assert.equal(aborted, true);
  assert.equal(fixture.runtime.workerBound, null);
  assert.equal(JSON.parse([...fixture.storage.values()][0]).pending.operation, 'register');
});

test('malformed, oversized and wrong-owner acknowledgement bodies cannot mark a subscription enabled', async () => {
  for (const kind of ['json', 'oversized', 'owner', 'receipt']) {
    const fixture = clientFixture();
    await fixture.controller.refresh();
    const originalFetch = fixture.root.fetch;
    fixture.root.fetch = async (url, init) => {
      const response = await originalFetch(url, init);
      if (!url.endsWith('/register_push_subscription')) return response;
      if (kind === 'json') return new Response('{');
      if (kind === 'oversized') return new Response('a'.repeat(16385));
      const receipt = await response.json();
      return fixture.respond(kind === 'owner' ? { ...receipt, owner_id: secondOwner } : { ...receipt, request_id: randomUUID() });
    };
    assert.equal((await fixture.controller.enableFromUserGesture(fixture.event())).code, 'invalid_response');
    assert.equal(fixture.runtime.workerBound, null);
  }
});

test('client rejects provider URL aliases, arbitrary hosts and noncanonical or invalid curve keys before RPC registration', async () => {
  const endpoint = 'https://fcm.googleapis.com/fcm/send/' + 'a'.repeat(32);
  for (const malformed of [
    { endpoint: 'https://127.0.0.1/' + 'a'.repeat(32) },
    { endpoint: endpoint + '?redirect=https://evil.test' },
    { endpoint: endpoint.replace('fcm.googleapis.com', 'fcm.googleapis.com:443') },
    { endpoint: endpoint.replace('fcm.googleapis.com', 'FCM.GOOGLEAPIS.COM') },
    { endpoint: endpoint + '\n' },
    { keys: { p256dh: testKey(), auth: Buffer.alloc(16).toString('base64url').slice(0, -1) + 'B' } },
    { keys: { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url'), auth: randomBytes(16).toString('base64url') } }
  ]) {
    const fixture = clientFixture({ subscriptionJSON: { endpoint, expirationTime: null,
      keys: { p256dh: testKey(), auth: randomBytes(16).toString('base64url') }, ...malformed } });
    await fixture.controller.refresh();
    assert.equal((await fixture.controller.enableFromUserGesture(fixture.event())).code, 'invalid_subscription');
    assert.equal(fixture.requests.some(value => value.url.endsWith('/register_push_subscription')), false);
  }
});

test('unavailable or corrupt durable storage fails closed without permission or network', async () => {
  for (const mode of ['write', 'corrupt']) {
    const fixture = clientFixture();
    if (mode === 'write') fixture.root.localStorage.setItem = () => { throw new Error('quota exceeded'); };
    else fixture.storage.set('formora_push_v1:' + new URL('__push__/', appURL).href, '{broken');
    assert.equal((await fixture.controller.refresh()).ok, false);
    assert.equal(fixture.runtime.promptCount, 0);
    assert.equal(fixture.requests.length, 0);
  }
});

test('conflicting worker scopes are never replaced, and an existing app worker remains untouched', async () => {
  const conflicting = clientFixture({ runtime: { workerCreated: true } });
  conflicting.registration.active.scriptURL = new URL('other-worker.js', appURL).href;
  assert.equal((await conflicting.controller.refresh()).code, 'worker_conflict');
  assert.equal(conflicting.runtime.workerRegistered, 0);
  const fixture = clientFixture();
  const oldWorker = { scope: appURL, active: { scriptURL: appURL + 'existing-worker.js' } };
  fixture.root.navigator.serviceWorker.getRegistrations = async () => [oldWorker, ...(fixture.runtime.workerCreated ? [fixture.registration] : [])];
  await fixture.controller.refresh();
  assert.equal((await fixture.controller.enableFromUserGesture(fixture.event())).ok, true);
  assert.equal(oldWorker.active.scriptURL, appURL + 'existing-worker.js');
});

test('unsupported capabilities and native shells are explicit and never reported as APNs or FCM acceptance', async () => {
  for (const field of ['PushManager', 'indexedDB', 'MessageChannel']) {
    const fixture = clientFixture();
    fixture.root[field] = undefined;
    assert.equal((await fixture.controller.refresh()).code, 'unsupported');
    assert.equal(fixture.requests.length, 0);
  }
  const native = clientFixture();
  native.root.Capacitor = { isNativePlatform: () => true };
  assert.equal((await native.controller.refresh()).code, 'native_unsupported');
  assert.equal(native.runtime.promptCount, 0);
});

test('completed command results contain settled controls, and duplicate in-flight commands do not prompt twice', async () => {
  const fixture = clientFixture();
  const refreshed = await fixture.controller.refresh();
  assert.equal(refreshed.state.busy, false);
  assert.equal(refreshed.state.canEnable, true);
  const first = fixture.controller.enableFromUserGesture(fixture.event());
  const duplicate = fixture.controller.enableFromUserGesture(fixture.event());
  assert.equal((await duplicate).code, 'busy');
  assert.equal((await first).state.busy, false);
  assert.equal(fixture.runtime.promptCount, 1);
});

test('an unacknowledged revocation still stops this browser so logout is never blocked', async () => {
  const fixture = clientFixture();
  await fixture.controller.refresh();
  await fixture.controller.enableFromUserGesture(fixture.event());
  assert.equal(fixture.controller.getState().registered, true);
  fixture.runtime.fetchOverride = async () => { throw new Error('offline during logout'); };
  const outcome = await fixture.controller.beforeAccountChange();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.serverAcknowledged, false);
  assert.equal(outcome.localDeliveryStopped, true);
  assert.equal(fixture.runtime.unsubscribed, 1);
  assert.equal(fixture.runtime.browserSubscription, null);
  assert.equal(fixture.runtime.workerBound, null);
  assert.equal(fixture.server.rows.size, 1);
  fixture.runtime.owner = secondOwner;
  fixture.dispatch('formora:sessionchange');
  fixture.runtime.fetchOverride = null;
  const next = await fixture.controller.refresh();
  assert.equal(next.state.requiresPreviousAccount, true);
  assert.equal(next.state.canEnable, false);
  assert.equal((await fixture.controller.enableFromUserGesture(fixture.event())).ok, false);
  assert.equal(fixture.runtime.subscribed, 1);
});

test('a browser that cannot finish cleanup still reports its state instead of holding the account', async () => {
  const fixture = clientFixture();
  await fixture.controller.refresh();
  await fixture.controller.enableFromUserGesture(fixture.event());
  fixture.runtime.fetchOverride = async () => { throw new Error('offline during logout'); };
  fixture.runtime.unsubscribeFails = true;
  const outcome = await fixture.controller.beforeAccountChange();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.localDeliveryStopped, false);
  assert.equal(outcome.state.status, 'revocation_pending');
  assert.equal(fixture.controller.getState().canRetry, true);
  const unmanaged = clientFixture();
  unmanaged.runtime.browserSubscription = unmanaged.subscription;
  unmanaged.runtime.workerCreated = true;
  const foreign = await unmanaged.controller.beforeAccountChange();
  assert.equal(foreign.ok, false);
  assert.equal(foreign.code, 'unmanaged_subscription');
  assert.equal(foreign.localDeliveryStopped, true);
  assert.equal(unmanaged.runtime.unsubscribed, 0);
});

test('unused default-off foundation does not block account changes or require Supabase configuration', async () => {
  const fixture = clientFixture({ enabled: false });
  fixture.root.SUPABASE_URL = '';
  const outcome = await fixture.controller.beforeAccountChange();
  assert.equal(outcome.ok, true);
  assert.equal(outcome.code, 'not_subscribed');
  assert.equal(outcome.serverAcknowledged, false);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.runtime.promptCount, 0);
});

test('unsupported browsers with no prior push state can leave the account without enabling broken controls', async () => {
  const fixture = clientFixture({ enabled: false });
  fixture.root.navigator.locks = undefined;
  fixture.root.navigator.serviceWorker = undefined;
  assert.equal(fixture.controller.getState().canRevokeAll, false);
  assert.equal((await fixture.controller.revokeAll()).code, 'unsupported');
  assert.equal((await fixture.controller.beforeAccountChange()).ok, true);
  assert.equal(fixture.requests.length, 0);
});

test('local owner/binding corruption is not treated as permission to adopt a browser subscription', async () => {
  const fixture = clientFixture();
  fixture.storage.set('formora_push_v1:' + new URL('__push__/', appURL).href, JSON.stringify({
    v: 1, device_id: randomUUID(), owner_id: null, phase: 'registered', pending: null
  }));
  assert.equal((await fixture.controller.refresh()).code, 'local_state_invalid');
  assert.equal(fixture.requests.length, 0);
});

test('an offline all-device opt-out keeps its scope and request identity through suspension and logout', async () => {
  const fixture = clientFixture();
  await fixture.controller.refresh();
  await fixture.controller.enableFromUserGesture(fixture.event());
  const otherBrowser = randomUUID();
  fixture.server.rows.set(otherBrowser, { device_id: otherBrowser });
  fixture.runtime.fetchOverride = async () => { throw new Error('offline'); };
  const attempt = await fixture.controller.revokeAll();
  assert.equal(attempt.ok, false);
  assert.equal(attempt.serverAcknowledged, false);
  const journal = () => JSON.parse([...fixture.storage.values()][0]);
  const requested = journal().intent.request_id;
  assert.deepEqual(Object.keys(journal().intent).sort(), ['operation', 'request_id']);
  assert.equal(journal().intent.operation, 'revoke_all');
  assert.equal(journal().server_revoked, false);
  assert.equal(attempt.state.pendingOperation, 'revoke_all');
  fixture.root.FORMORA_WEB_PUSH = false;
  await fixture.controller.refresh();
  await fixture.controller.suspendLocal();
  fixture.dispatch('formora:sessionchange');
  await new Promise(setImmediate);
  assert.equal(journal().last_action, 'revoke_all');
  assert.equal(journal().intent.request_id, requested);
  assert.equal(journal().server_revoked, false);
  assert.equal(fixture.controller.getState().pendingOperation, 'revoke_all');
  assert.doesNotMatch(JSON.stringify(journal()), /fcm\.googleapis|verified-owner-jwt|p256dh|auth_secret/);
  fixture.root.FORMORA_WEB_PUSH = true;
  fixture.runtime.fetchOverride = null;
  const retried = await fixture.controller.retryFromUserGesture(fixture.event());
  const sent = fixture.requests.filter(value => value.url.endsWith('/revoke_push_subscriptions')).pop().body;
  assert.deepEqual({ all: sent.p_all, device: sent.p_device_id, request: sent.p_request_id },
    { all: true, device: null, request: requested });
  assert.equal(retried.ok, true);
  assert.equal(retried.serverAcknowledged, true);
  assert.equal(fixture.server.rows.size, 0);
  assert.equal(fixture.controller.getState().pendingOperation, null);
});

test('a logout during a pending all-device opt-out still retries as all devices with the original request', async () => {
  const fixture = clientFixture();
  await fixture.controller.refresh();
  await fixture.controller.enableFromUserGesture(fixture.event());
  const otherBrowser = randomUUID();
  fixture.server.rows.set(otherBrowser, { device_id: otherBrowser });
  fixture.runtime.fetchOverride = async () => { throw new Error('offline'); };
  assert.equal((await fixture.controller.revokeAll()).ok, false);
  const journal = () => JSON.parse([...fixture.storage.values()][0]);
  const requested = journal().intent.request_id;
  const changing = await fixture.controller.beforeAccountChange();
  assert.equal(changing.ok, false);
  assert.equal(changing.serverAcknowledged, false);
  assert.equal(journal().intent.operation, 'revoke_all');
  assert.equal(journal().intent.request_id, requested);
  assert.equal(journal().server_revoked, false);
  assert.equal(fixture.controller.getState().pendingOperation, 'revoke_all');
  fixture.runtime.fetchOverride = null;
  const retried = await fixture.controller.retryFromUserGesture(fixture.event());
  const sent = fixture.requests.filter(value => value.url.endsWith('/revoke_push_subscriptions')).pop().body;
  assert.deepEqual({ all: sent.p_all, device: sent.p_device_id, request: sent.p_request_id },
    { all: true, device: null, request: requested });
  assert.equal(retried.ok, true);
  assert.equal(retried.serverAcknowledged, true);
  assert.equal(fixture.server.rows.size, 0);
  assert.equal(fixture.controller.getState().pendingOperation, null);
});

test('an account change abandoned mid-request cannot outlive the budget through error compensation', async () => {
  const fixture = clientFixture({ controller: { timeoutMs: 60, accountChangeDeadlineMs: 60 } });
  await fixture.controller.refresh();
  await fixture.controller.enableFromUserGesture(fixture.event());
  fixture.runtime.fetchOverride = () => { fixture.runtime.owner = secondOwner; return new Promise(() => {}); };
  fixture.registration.active.postMessage = () => {};
  fixture.registration.pushManager.getSubscription = () => new Promise(() => {});
  const started = Date.now();
  const outcome = await fixture.controller.beforeAccountChange();
  const elapsed = Date.now() - started;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.serverAcknowledged, false);
  assert.equal(outcome.localCleanup, false);
  assert.equal(outcome.localDeliveryStopped, false);
  assert.equal(outcome.state.requiresPreviousAccount, true);
  assert.ok(elapsed < 180, 'compensation after the deadline escaped the whole-call budget: ' + elapsed + 'ms');
  assert.equal(JSON.parse([...fixture.storage.values()][0]).server_revoked, false);
});

test('a push scope that cannot be enumerated is never reported as never subscribed', async () => {
  const fixture = clientFixture();
  fixture.runtime.workerCreated = true;
  fixture.runtime.browserSubscription = fixture.subscription;
  fixture.root.navigator.locks = undefined;
  fixture.root.navigator.serviceWorker.getRegistrations = async () => { throw new Error('enumeration unavailable'); };
  const outcome = await fixture.controller.beforeAccountChange();
  assert.equal(outcome.ok, false);
  assert.notEqual(outcome.code, 'not_subscribed');
  assert.equal(outcome.localCleanup, false);
  assert.equal(outcome.localDeliveryStopped, false);
  assert.equal(outcome.serverAcknowledged, false);
  assert.equal(fixture.runtime.browserSubscription, fixture.subscription);
  assert.equal(fixture.runtime.unsubscribed, 0);
  assert.equal(fixture.requests.length, 0);
});

test('account-change cleanup obeys one whole-operation deadline instead of a bound per chained step', async () => {
  const fixture = clientFixture({ controller: { timeoutMs: 80, accountChangeDeadlineMs: 60 } });
  await fixture.controller.refresh();
  await fixture.controller.enableFromUserGesture(fixture.event());
  fixture.runtime.fetchOverride = () => new Promise(() => {});
  fixture.registration.active.postMessage = () => {};
  fixture.registration.pushManager.getSubscription = () => new Promise(() => {});
  const started = Date.now();
  const outcome = await fixture.controller.beforeAccountChange();
  const elapsed = Date.now() - started;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.serverAcknowledged, false);
  assert.equal(outcome.localCleanup, false);
  assert.equal(outcome.localDeliveryStopped, false);
  assert.equal(outcome.state.status, 'revocation_pending');
  assert.equal(outcome.state.canRetry, true);
  assert.ok(elapsed < 220, 'individually bounded chained steps would exceed this: ' + elapsed + 'ms');
  assert.equal(JSON.parse([...fixture.storage.values()][0]).server_revoked, false);
  assert.doesNotMatch([...fixture.storage.values()].join(''), /verified-owner-jwt|fcm\.googleapis|p256dh/);
});

test('a logout during an in-flight command compensates locally instead of reporting a busy refusal', async () => {
  const fixture = clientFixture();
  await fixture.controller.refresh();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const originalFetch = fixture.root.fetch;
  fixture.root.fetch = async (url, init) => {
    if (url.endsWith('/register_push_subscription')) { reached(); await gate; }
    return originalFetch(url, init);
  };
  const enabling = fixture.controller.enableFromUserGesture(fixture.event());
  await waiting;
  const outcome = await fixture.controller.beforeAccountChange();
  assert.equal(outcome.ok, false);
  assert.notEqual(outcome.code, 'busy');
  assert.equal(outcome.serverAcknowledged, false);
  assert.equal(fixture.runtime.unsubscribed, 1);
  release();
  assert.equal((await enabling).ok, false);
  assert.equal(fixture.runtime.workerBound, null);
  assert.equal(fixture.controller.getState().registered, false);
});

test('a suspension between acknowledgement and worker binding cannot re-arm this browser', async () => {
  const fixture = clientFixture();
  await fixture.controller.refresh();
  let acknowledged = false, suspended = false, suspensions = 0;
  const uuid = webcrypto.randomUUID.bind(webcrypto);
  fixture.root.crypto = { subtle: webcrypto.subtle, getRandomValues: values => webcrypto.getRandomValues(values),
    randomUUID: () => {
      if (acknowledged && !suspended) {
        suspended = true;
        suspensions++;
        fixture.runtime.owner = secondOwner;
        fixture.dispatch('formora:sessionchange');
      }
      return uuid();
    } };
  const originalFetch = fixture.root.fetch;
  fixture.root.fetch = async (url, init) => {
    const response = await originalFetch(url, init);
    if (url.endsWith('/register_push_subscription')) acknowledged = true;
    return response;
  };
  const outcome = await fixture.controller.enableFromUserGesture(fixture.event());
  await new Promise(setImmediate);
  assert.equal(outcome.ok, false);
  assert.equal(suspensions, 1);
  assert.equal(fixture.controls.some(message => message.type === 'formora-push:bind'), false);
  assert.equal(fixture.runtime.workerBound, null);
  assert.equal(fixture.controller.getState().registered, false);
  assert.equal(fixture.controller.getState().requiresPreviousAccount, true);
});

test('the composite onChange handler eventually reports a muted browser and no binding for the next owner', async () => {
  const seen = [];
  const fixture = clientFixture({ controller: { onChange: state => { seen.push(state); if (seen.length === 1) throw new Error('render failed'); } } });
  await fixture.controller.refresh();
  await fixture.controller.enableFromUserGesture(fixture.event());
  assert.equal(seen.some(state => state.registered), true);
  fixture.runtime.owner = secondOwner;
  fixture.dispatch('formora:sessionchange');
  await new Promise(setImmediate);
  const latest = seen[seen.length - 1];
  assert.equal(latest.requiresPreviousAccount, true);
  assert.equal(latest.registered, false);
  assert.equal(latest.canEnable, false);
  assert.equal(latest.localDeliveryStopped, true);
  assert.equal(latest.pendingOperation, 'revoke_device');
  assert.equal(fixture.runtime.workerBound, null);
  assert.equal(fixture.runtime.browserSubscription, null);
  assert.equal(fixture.requests.some(value => value.url.endsWith('/revoke_push_subscriptions')), false);
});

test('worker mute supersedes a queued binding and persistent storage failure is never acknowledged', async () => {
  const fixture = workerFixture();
  const binding = fixture.control('formora-push:bind', fixture.binding);
  const muting = fixture.control('formora-push:mute');
  assert.equal((await binding).ok, false);
  assert.equal((await muting).ok, true);
  await fixture.push();
  assert.equal(fixture.shown.length, 0);
  fixture.context.self.indexedDB.open = () => { throw new Error('storage unavailable'); };
  assert.equal((await fixture.control('formora-push:bind', fixture.binding)).ok, false);
  assert.equal((await fixture.control('formora-push:mute')).ok, false);
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test('loopback Chromium verifies current CSP and push-only worker lifecycle at ' + viewport.width + 'px', async context => {
    const http = require('node:http');
    const { chromium } = require('playwright');
    const csp = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8')
      .match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
    const localServer = http.createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      if (request.url === '/formora/' || request.url === '/formora/index.html') {
        response.setHeader('Content-Type', 'text/html');
        response.setHeader('Content-Security-Policy', csp);
        response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><button id="enable">Enable notifications</button><script src="js/mod/push.js"></script></body></html>');
      } else if (request.url === '/formora/js/mod/push.js' || request.url === '/formora/push-worker.js') {
        response.setHeader('Content-Type', 'application/javascript');
        response.end(request.url.endsWith('push-worker.js') ? workerSource : clientSource);
      } else { response.writeHead(404); response.end(); }
    });
    await new Promise(resolve => localServer.listen(0, '127.0.0.1', resolve));
    context.after(() => new Promise(resolve => localServer.close(resolve)));
    const origin = 'http://127.0.0.1:' + localServer.address().port;
    const browser = await chromium.launch({ headless: true });
    context.after(() => browser.close());
    const browserContext = await browser.newContext({ viewport, serviceWorkers: 'allow', hasTouch: viewport.width < 500 });
    const unexpected = [], errors = [];
    const fixture = clientFixture();
    await browserContext.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === origin) return route.continue();
      if (url.origin !== 'https://push-fixture.supabase.co') { unexpected.push(url.origin); return route.abort(); }
      const headers = { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'apikey,authorization,content-type', 'content-type': 'application/json' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers, body: '' });
      const response = await fixture.root.fetch(request.url(), { method: request.method(), headers: request.headers(), body: request.postData() || undefined });
      return route.fulfill({ status: response.status, headers, body: await response.text() });
    });
    await browserContext.addInitScript(({ key, subscriptionJSON, firstOwner }) => {
      window.SUPABASE_URL = 'https://push-fixture.supabase.co';
      window.SUPABASE_ANON_KEY = 'public-fixture-anon';
      window.FORMORA_WEB_PUSH = true;
      window.FORMORA_PUSH_VAPID_PUBLIC_KEY = key;
      window.SupaAuth = { KEY: 'formora_supa_session', active: () => true, uid: () => firstOwner,
        token: async () => 'verified-owner-jwt-fixture-token' };
      window.pushTest = { prompts: 0, subscriptions: 0, gesture: false, violations: [] };
      addEventListener('securitypolicyviolation', event => pushTest.violations.push(event.effectiveDirective));
      let permission = 'default', subscription = null;
      Object.defineProperty(Notification, 'permission', { get: () => permission });
      Notification.requestPermission = () => {
        pushTest.prompts++;
        pushTest.gesture = navigator.userActivation.isActive;
        permission = 'granted';
        return Promise.resolve('granted');
      };
      PushManager.prototype.getSubscription = async () => subscription;
      PushManager.prototype.subscribe = async options => {
        pushTest.subscriptions++;
        subscription = { options, toJSON: () => subscriptionJSON,
          unsubscribe: async () => { subscription = null; return true; } };
        return subscription;
      };
    }, { key: fixture.key, subscriptionJSON: fixture.subscriptionJSON, firstOwner });
    const page = await browserContext.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/formora/');
    const initial = await page.evaluate(async () => {
      window.pushController = FormoraPush.create();
      document.getElementById('enable').addEventListener('click', async event => {
        window.pushOutcome = await pushController.enableFromUserGesture(event);
      });
      const refreshed = await pushController.refresh();
      return { refreshed, prompts: pushTest.prompts, workerCount: (await navigator.serviceWorker.getRegistrations()).length };
    });
    assert.equal(initial.refreshed.ok, true);
    assert.equal(initial.prompts, 0);
    assert.equal(initial.workerCount, 0);
    await page.locator('#enable').click();
    await page.waitForFunction(() => window.pushOutcome);
    const registered = await page.evaluate(async () => ({ outcome: pushOutcome,
      prompts: pushTest.prompts, gesture: pushTest.gesture, subscriptions: pushTest.subscriptions,
      controller: navigator.serviceWorker.controller?.scriptURL || null,
      workers: (await navigator.serviceWorker.getRegistrations()).map(registration => ({ scope: registration.scope, url: registration.active?.scriptURL })),
      caches: await caches.keys(), violations: pushTest.violations }));
    assert.equal(registered.outcome.ok, true, JSON.stringify(registered.outcome));
    assert.equal(registered.prompts, 1);
    assert.equal(registered.gesture, true);
    assert.equal(registered.subscriptions, 1);
    assert.equal(registered.controller, null);
    assert.deepEqual(registered.workers, [{ scope: origin + '/formora/__push__/', url: origin + '/formora/push-worker.js' }]);
    assert.deepEqual(registered.caches, []);
    assert.deepEqual(registered.violations, []);
    const revoked = await page.evaluate(() => pushController.beforeAccountChange());
    assert.equal(revoked.ok, true);
    assert.equal(revoked.serverAcknowledged, true);
    assert.equal(revoked.localCleanup, true);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    await browserContext.close();
  });
}