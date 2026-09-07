'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const setup = [], teardown = [];
const fixtureFile = path.join(__dirname, 'social-publishing.e2e.cjs');
const fixtures = vm.runInNewContext(fs.readFileSync(fixtureFile, 'utf8') + '\n;({openApp, owner, peer, members, deferred});', {
  require: name => name === 'node:test' ? { test() {}, before: callback => setup.push(callback), after: callback => teardown.push(callback) } : require(name),
  __dirname, console, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, structuredClone,
}, { filename: fixtureFile });
const { owner, peer, members, deferred } = fixtures;
const secret = 'LEGACY ALERT PRIVATE PROSE MUST NOT RENDER';
const row = (id, values = {}) => ({ id, uid: owner, actor: peer, type: 'message', post_id: null,
  read: false, ts: '2026-09-06T12:00:00.000Z', body: secret, ...values });

before(async () => { for (const callback of setup) await callback(); });
after(async () => { for (const callback of teardown) await callback(); });

async function alertsApp(testContext, viewport = { width: 1280, height: 900 }) {
  const cleanups = [];
  const fixture = await fixtures.openApp({ after: callback => cleanups.push(callback) }, viewport);
  const { page, context, state } = fixture;
  const notifications = {
    rows: new Map([['post-alert', row('post-alert', { type: 'comment', post_id: 'post-owner' })], ['message-alert', row('message-alert')]]),
    reads: [], writes: [], targets: [], gates: [], active: [], errors: [], rawRows: null, legacyBody: true,
  };
  notifications.hold = method => {
    const started = deferred(), released = deferred();
    const gate = { method, begin: started.resolve, started: started.promise, release: released.resolve, result: released.promise };
    notifications.gates.push(gate); notifications.active.push(gate); return gate;
  };
  const project = (record, columns) => Object.fromEntries(columns.split(',').map(column => [column, record[column]]));
  await context.route('**/rest/v1/**', async route => {
    try {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      const uid = [...members.values()].find(member => 'Bearer ' + member.token === request.headers().authorization)?.uid;
      const targetCheck = url.pathname.endsWith('/messages') && url.searchParams.get('select') === 'id,from_uid,to_uid';
      if (!url.pathname.endsWith('/notifications') && !targetCheck) return route.fallback();
      if (!uid) return route.fulfill({ status: 401, json: [] });
      const query = url.searchParams, columns = query.get('select');
      const record = { method, uid, url: url.toString(), body: request.postData() ? request.postDataJSON() : null };
      if (targetCheck) notifications.targets.push(record);
      else (method === 'GET' ? notifications.reads : notifications.writes).push(record);
      const gateIndex = notifications.gates.findIndex(gate => gate.method === (targetCheck ? 'target' : method));
      let mode;
      if (gateIndex >= 0) { const gate = notifications.gates.splice(gateIndex, 1)[0]; gate.begin(record); mode = await gate.result; }
      if (typeof mode === 'number') return route.fulfill({ status: mode, json: [] });
      if (targetCheck) {
        if (query.get('to_uid') !== 'eq.' + uid || query.get('limit') !== '1') return route.fulfill({ status: 403, json: [] });
        const rows = [...state.messages.values()].filter(message => message.to_uid === uid && query.get('from_uid') === 'eq.' + message.from_uid).slice(0, 1);
        return route.fulfill({ status: 200, json: rows.map(message => project(message, columns)) });
      }
      if (method === 'POST') {
        assert.equal(record.body.actor, uid);
        assert.equal(Object.hasOwn(record.body, 'body'), false);
        assert.equal(query.get('on_conflict'), 'id');
        assert.match(request.headers().prefer, /resolution=ignore-duplicates/);
        if (!notifications.rows.has(record.body.id)) notifications.rows.set(record.body.id, row(record.body.id, { ...record.body, body: undefined }));
        return mode === 'lost' ? route.abort('failed') : route.fulfill({ status: 201, body: '' });
      }
      if (query.get('uid') !== 'eq.' + uid) return route.fulfill({ status: 403, json: [] });
      if (method === 'GET') {
        assert.equal(columns, 'id,uid,actor,type,post_id,ts,read');
        assert.equal(query.get('order'), 'ts.desc,id.desc');
        assert.equal(query.get('limit'), '60');
        const rows = notifications.rawRows || [...notifications.rows.values()].filter(notification => notification.uid === uid)
          .sort((first, second) => Date.parse(second.ts) - Date.parse(first.ts) || second.id.localeCompare(first.id)).slice(0, 60);
        return route.fulfill({ status: 200, json: rows.map(notification => notifications.legacyBody ? notification : project(notification, columns)) });
      }
      assert.equal(method, 'PATCH');
      assert.equal(columns, 'id,uid,read');
      assert.equal(query.has('read'), false);
      assert.equal(request.headers().prefer, 'return=representation');
      assert.deepEqual(record.body, { read: true });
      const match = /^in\.\(([A-Za-z0-9_.:,-]+)\)$/.exec(query.get('id') || '');
      assert.ok(match, 'Only an exact opaque ID set is admitted');
      const ids = match[1].split(',');
      assert.ok(ids.length > 0 && ids.length <= 60 && new Set(ids).size === ids.length);
      record.ids = ids;
      let rows = ids.map(id => notifications.rows.get(id)).filter(notification => notification?.uid === uid);
      if (mode !== 'empty' && mode !== 'foreign') rows.forEach(notification => { notification.read = true; });
      if (mode === 'lost') return route.abort('failed');
      rows = rows.map(notification => project(notification, columns));
      if (mode === 'empty') rows = [];
      if (mode === 'foreign') rows = rows.map(notification => ({ ...notification, uid: uid === owner ? peer : owner, read: true }));
      return route.fulfill({ status: 200, json: rows });
    } catch (error) {
      if (!/closed|Target page/i.test(error.message)) notifications.errors.push(error.stack || error.message);
      await route.abort().catch(() => {});
    }
  });
  testContext.after(async () => {
    notifications.active.forEach(gate => gate.release(503));
    for (const callback of cleanups) await callback();
    assert.deepEqual(notifications.errors, []);
  });
  await page.evaluate(() => Cloud.setPaused(true));
  await page.locator('.tab[data-tab="alerts"]').click();
  await page.evaluate(() => App.pollNotifs());
  await page.locator('[data-notif-id="message-alert"]').waitFor();
  return { ...fixture, notifications };
}

async function privateState(page) {
  return page.evaluate(() => JSON.stringify({ rows: Social.cloud.notifs, html: document.getElementById('notif-list')?.innerHTML,
    local: { ...localStorage }, session: { ...sessionStorage } }));
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`Alerts ${viewport.width}px: explicit keyboard/button read, lost ACK retry and unread arrivals`, async testContext => {
    const { page, notifications } = await alertsApp(testContext, viewport);
    assert.equal(notifications.writes.length, 0);
    assert.equal(await page.locator('#tab-notif-badge').innerText(), '2');
    assert.equal((await privateState(page)).includes(secret), false);
    assert.equal(await page.locator('.notif-item[onclick],.notif-item[onkeydown]').count(), 0);
    const gate = notifications.hold('PATCH');
    const mark = page.getByRole('button', { name: 'Mark displayed read', exact: true });
    if (viewport.width > 600) { await mark.focus(); await mark.press('Enter'); } else await mark.tap();
    const request = await gate.started;
    const expected = ['message-alert', 'post-alert'];
    assert.equal(await page.locator('.notif-item.unread').count(), 2);
    assert.equal(await page.locator('#tab-notif-badge').innerText(), '2');
    notifications.rows.set('new-arrival', row('new-arrival', { ts: '2026-09-06T12:01:00.000Z' }));
    await page.evaluate(() => App.pollNotifs());
    assert.equal(await page.locator('.notif-item.unread').count(), 3);
    gate.release('lost');
    await page.getByRole('button', { name: 'Retry read', exact: true }).waitFor();
    assert.deepEqual(request.ids.slice().sort(), expected);
    assert.equal(await page.locator('#tab-notif-badge').innerText(), '3');
    assert.equal(await page.locator('.notif-item.unread').count(), 3);
    const retry = page.getByRole('button', { name: 'Retry read', exact: true });
    await retry.focus(); await retry.press('Space');
    await page.waitForFunction(() => !App._notifReadPending && !App._notifReadRetry);
    assert.deepEqual(notifications.writes.at(-1).ids.slice().sort(), expected);
    assert.equal(notifications.rows.get('new-arrival').read, false);
    assert.equal(await page.locator('.notif-item.unread').count(), 1);
    assert.equal(await page.locator('#tab-notif-badge').innerText(), '1');
    const bounds = await page.locator('#notif-list').evaluate(element => ({ scroll: element.scrollWidth, width: element.clientWidth }));
    assert.ok(bounds.scroll <= bounds.width + 1, JSON.stringify(bounds));
    const directory = path.join(root, 'dist/notification-lifecycle');
    fs.mkdirSync(directory, { recursive: true });
    await page.screenshot({ path: path.join(directory, `alerts-${viewport.width}.png`), fullPage: true });
  });
}

for (const key of ['Enter', 'Space']) {
  test(`message alert ${key}: checked participant DM opens before exact clicked-row ACK`, async testContext => {
    const { page, notifications } = await alertsApp(testContext);
    const gate = notifications.hold('PATCH');
    const item = page.locator('[data-notif-id="message-alert"]');
    await item.focus(); await item.press(key);
    await gate.started;
    assert.equal(await page.locator('#chat-thread .bubble').count(), 3);
    assert.equal(await page.evaluate(() => Social._dmWith), peer);
    assert.equal(notifications.targets.length, 1);
    assert.equal(await page.locator('#tab-notif-badge').innerText(), '2');
    gate.release();
    await page.waitForFunction(() => !App._notifReadPending);
    assert.deepEqual(notifications.writes[0].ids, ['message-alert']);
    assert.equal(notifications.rows.get('post-alert').read, false);
    assert.equal(await page.locator('#tab-notif-badge').innerText(), '1');
  });
}

test('a failed refresh and malformed hostile reference retain old rows and expose Retry', async testContext => {
  const { page, notifications } = await alertsApp(testContext);
  const gate = notifications.hold('GET');
  await page.getByRole('button', { name: 'Refresh alerts', exact: true }).click();
  await gate.started; gate.release(503);
  await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  assert.equal(await page.locator('.notif-item.unread').count(), 2);
  assert.equal(await page.locator('#tab-notif-badge').innerText(), '2');
  notifications.rawRows = [row("x' onclick='globalThis.alertXss=1", { actor: "actor'payload", type: '<img onerror=alertXss=1>' })];
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.waitForFunction(() => App._notifListError === true);
  assert.equal(await page.locator('.notif-item.unread').count(), 2);
  assert.equal(await page.evaluate(() => globalThis.alertXss), undefined);
  assert.equal((await privateState(page)).includes(secret), false);
  notifications.rawRows = null;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.waitForFunction(() => App._notifListError === false);
  assert.equal(notifications.writes.length, 0);
});

test('unavailable references never open another profile; an existing own post opens exactly', async testContext => {
  const { page, notifications } = await alertsApp(testContext);
  notifications.rows.get('post-alert').post_id = 'deleted-post';
  await page.evaluate(() => App.pollNotifs());
  await page.locator('[data-notif-id="post-alert"]').click();
  await page.locator('.toast').filter({ hasText: 'This activity is unavailable.' }).waitFor();
  assert.equal(await page.locator('#modal:not(.hidden)').count(), 0);
  assert.equal(notifications.writes.length, 0);
  notifications.rows.get('post-alert').post_id = 'post-owner';
  await page.evaluate(() => App.pollNotifs());
  await page.locator('[data-notif-id="post-alert"]').click();
  await page.locator('#view-feed .post-text').filter({ hasText: 'Owner post before publishing' }).waitFor();
  await page.waitForFunction(() => !App._notifReadPending);
  assert.deepEqual(notifications.writes[0].ids, ['post-alert']);
  assert.equal(await page.locator('#modal:not(.hidden)').count(), 0);
  assert.equal(await page.locator('[id="ci-post-owner"]').count(), 1, 'Post controls remain unique and usable');
  assert.equal(await page.evaluate(() => document.activeElement.querySelector('[data-saved-post]')?.dataset.savedPost), 'post-owner');
  assert.equal(notifications.rows.get('message-alert').read, false);
});

for (const mode of ['empty', 'foreign']) {
  test(`${mode} read ACK cannot clear the browser badge or prevent exact retry`, async testContext => {
    const { page, notifications } = await alertsApp(testContext);
    const gate = notifications.hold('PATCH');
    await page.getByRole('button', { name: 'Mark displayed read', exact: true }).click();
    await gate.started; gate.release(mode);
    await page.getByRole('button', { name: 'Retry read', exact: true }).waitFor();
    assert.equal(await page.locator('.notif-item.unread').count(), 2);
    assert.equal(await page.locator('#tab-notif-badge').innerText(), '2');
    await page.getByRole('button', { name: 'Retry read', exact: true }).click();
    await page.waitForFunction(() => !App._notifReadPending && !App._notifReadRetry);
    assert.equal(await page.locator('.notif-item.unread').count(), 0);
    assert.deepEqual(notifications.writes[0].ids, notifications.writes[1].ids);
  });
}

for (const phase of ['PATCH', 'target', 'GET']) {
  test(`account switch while ${phase} is pending ignores the old result and preserves new unread state`, async testContext => {
    const { page, notifications } = await alertsApp(testContext);
    notifications.rows.set('peer-alert', row('peer-alert', { uid: peer, actor: owner }));
    const gate = notifications.hold(phase);
    if (phase === 'PATCH') await page.getByRole('button', { name: 'Mark displayed read', exact: true }).click();
    else if (phase === 'target') await page.locator('[data-notif-id="message-alert"]').click();
    else await page.getByRole('button', { name: 'Refresh alerts', exact: true }).click();
    await gate.started;
    await page.locator('.tab[data-tab="profile"]').click();
    await page.locator('.ph-logout-ic').click();
    await page.locator('.sheet-wrap').getByRole('button', { name: 'Log out', exact: true }).click();
    await page.locator('#a-email').fill(members.get(peer).email);
    await page.locator('#a-pass').fill('FixtureOnly-2026');
    await page.locator('#a-pass').press('Enter');
    await page.waitForFunction(expected => Cloud.me === expected && App._notifSeeded, peer);
    await page.locator('.tab[data-tab="alerts"]').click();
    await page.locator('[data-notif-id="peer-alert"]').waitFor();
    gate.release(phase === 'PATCH' ? 'foreign' : undefined);
    await page.evaluate(() => App.pollNotifs());
    assert.deepEqual(await page.locator('.notif-item').evaluateAll(nodes => nodes.map(node => node.dataset.notifId)), ['peer-alert']);
    assert.equal(await page.locator('#tab-notif-badge').innerText(), '1');
    assert.equal(notifications.rows.get('peer-alert').read, false);
    assert.equal(await page.locator('#chat-thread').count(), 0);
    assert.equal(await page.locator('.toast').filter({ hasText: /Could not confirm read|This activity is unavailable/ }).count(), 0);
    assert.equal((await privateState(page)).includes(secret), false);
  });
}

test('the bounded page labels 60 alerts and an explicit read leaves undisplayed older history unread', async testContext => {
  const { page, notifications } = await alertsApp(testContext);
  notifications.rows.clear();
  for (let index = 0; index < 61; index++) notifications.rows.set('history-' + String(index).padStart(3, '0'), row('history-' + String(index).padStart(3, '0')));
  await page.evaluate(() => App.pollNotifs());
  assert.equal(await page.locator('.notif-item').count(), 60);
  await page.getByText('Latest 60 alerts', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Mark displayed read', exact: true }).click();
  await page.waitForFunction(() => !App._notifReadPending);
  assert.equal(notifications.writes[0].ids.length, 60);
  assert.equal(notifications.rows.get('history-000').read, false);
  assert.equal([...notifications.rows.values()].filter(notification => !notification.read).length, 1);
});