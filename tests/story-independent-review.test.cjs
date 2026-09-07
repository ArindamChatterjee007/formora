'use strict';
// Independent review probes for the default-off Stories slice (2026-09-06).
// Read-only with respect to product source: this file only observes js/mod/stories.js,
// js/mod/social.js, js/app.js and js/supaauth.js. It adds no product behaviour.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const storyId = '33333333-3333-4333-8333-333333333333';
const apiOrigin = 'https://story-review-fixture.supabase.co';

// ---------------------------------------------------------------- source probes

test('Chat resolves Story reply context through the checked accessors and can render a tombstone', () => {
  const stories = read('js/mod/stories.js');
  const social = read('js/mod/social.js');
  const app = read('js/app.js');
  assert.ok(/async resolveContext\(/.test(stories) && /async replyReferences\(/.test(stories),
    'both checked accessors exist in the Stories module');
  // Chat is a real caller now: one bounded reference batch, then per-message checked resolves.
  assert.match(social, /await Stories\.replyReferences\(batch\)/);
  assert.match(social, /await Stories\.resolveContext\(id\)/);
  assert.match(social, /Story unavailable<\/span>/, 'Chat renders an explicit tombstone');
  for (const helper of ['_scanStoryContext', '_paintStoryContext', '_checkStoryContext', 'openStoryContext']) {
    assert.ok(social.includes(helper), 'social.js owns ' + helper);
  }
  // Chat must go through the module, never straight at the RPC surface, and app.js must not grow a second path.
  assert.equal(/story_reply_references|resolve_story_reply_context/.test(social), false,
    'social.js never names a Story RPC directly');
  assert.equal(/resolveContext|replyReferences/.test(app), false, 'app.js owns no context resolution');
  // The bubble carries a reference marker only: the slot is keyed by the message id and starts empty.
  const bubble = /dmBubble\(m, meId\) \{[\s\S]*?\n  \},/.exec(social)[0];
  assert.match(bubble, /\$\{this\._storyContextSlot\(m\)\}/);
  const slot = /_storyContextSlot\(m\) \{[\s\S]*?\n  \},/.exec(social)[0];
  assert.match(slot, /data-story-context="\$\{esc\(m\.id\)\}"/);
  assert.equal(/photo|media|story_id|storyId/.test(slot), false, 'the slot carries no story id and no media URL');
  // Activation must re-check eligibility before any media is requested.
  const open = /async openStoryContext\(id\) \{[\s\S]*?\n  \},/.exec(social)[0];
  assert.ok(open.indexOf('_checkStoryContext') >= 0 && open.indexOf('_checkStoryContext') < open.indexOf('Stories.open('),
    'openStoryContext rechecks before opening the story');
});

test('Story preferences and Story activity consume their own rejection and report it to the member', () => {
  const app = read('js/app.js');
  const stories = read('js/mod/stories.js');
  const social = read('js/mod/social.js');
  for (const [name, call] of [['openStoryNotifications', 'openNotifications'], ['openStorySettings', 'openSettings']]) {
    const body = new RegExp(name + '\\(\\) \\{[\\s\\S]*?\\n  \\},').exec(app)[0];
    assert.match(body, new RegExp('return Stories\\.' + call + '\\(\\)\\.catch\\(error =>'),
      name + ' handles the rejection instead of leaking it out of an inline onclick');
    assert.match(body, /const entry = this\._entry;/, name + ' pins the account entry before awaiting');
    assert.match(body, /if \(this\._entry === entry\) this\.toast\(/,
      name + ' only reports while the same account is still bound');
  }
  assert.match(social, /onclick="App\.openStorySettings\(\)"/);
  assert.match(app, /onclick="App\.openStoryNotifications\(\)"/);
  // The module still opens the panel before entering its try, so the rejection is genuine; the App layer is the fence.
  assert.match(stories, /_openPanel\(title\) \{\n\s*const scope = this\._scope\(\);/);
  // The Story-ring path uses the same convention, so every entry point is consistent.
  assert.match(social, /Stories\.open\(authorUid\)\.catch\(error => App\.toast/);
});

test('The Stories identity fence rides on _authEpoch and its vestigial generation term cannot force a false 401', () => {
  const supaauth = read('js/supaauth.js');
  const stories = read('js/mod/stories.js');
  assert.match(stories, /const identity = JSON\.stringify\(\[owner, auth\(\)\?\._authEpoch, auth\(\)\?\._generation, cloud\(\)\?\.base\]\);/);
  assert.match(stories, /scope\.authEpoch === auth\(\)\?\._authEpoch/);
  assert.match(supaauth, /_authEpoch: 0,/);
  assert.match(supaauth, /_revision: 0,/);
  assert.match(supaauth, /this\._authEpoch\+\+;/, 'the epoch actually advances when the identity changes');
  // SupaAuth has no _generation, so the extra term is undefined on both sides of every comparison:
  // it can never invalidate a live scope. Cosmetic dead weight, not a fence, and not a defect to force.
  assert.equal(/_generation\s*[:=]/.test(supaauth), false, 'SupaAuth exposes _revision, never _generation');
  assert.match(stories, /scope\.authGeneration === auth\(\)\?\._generation/);
});

test('The Play/Pause control reserves one fixed width and both states share the same label wrapper', () => {
  const stories = read('js/mod/stories.js');
  assert.match(stories, /width:\$\{action === "pause" \? "96px" : text \? "auto" : "44px"\}/);
  assert.match(stories, /min-width:\$\{action === "pause" \? 96 : 44\}px/);
  assert.match(stories, /max-width:100%/);
  assert.match(stories, /flex-shrink:0/);
  // _updateActions must rebuild the label with the same wrapper _button used, or the control reflows.
  const update = /if \(pause\) \{[\s\S]*?\n      \}/.exec(stories)[0];
  assert.match(update, /const paused = play\.pauses\.size > 0;/,
    'every pause reason - hover, panel, editing, blur, hidden - is reflected in the control');
  assert.match(update, /this\._icon\("film"\) \+ '<span style="min-width:0;overflow-wrap:anywhere">' \+ \(paused \? "Play" : "Pause"\)/);
});

test('togglePause releases every member-releasable pause reason, including hover', () => {
  const stories = read('js/mod/stories.js');
  const body = /togglePause\(\) \{[\s\S]*?\n    \},/.exec(stories)[0];
  assert.match(body, /play\.pauses\.has\("hover"\)/, 'a resting cursor counts as a resumable pause');
  assert.match(body, /play\.pauses\.delete\("hover"\)/);
  assert.match(body, /play\.pauses\.delete\("autoplay"\)/);
  assert.match(body, /play\.pauses\.delete\("media"\)/);
  assert.match(body, /this\.pause\("manual", !resume\)/);
  // Reasons the member cannot honestly override must survive an explicit resume.
  assert.equal(/pauses\.delete\("(hidden|blur|panel|editing)"\)/.test(body), false,
    'togglePause must not resume a hidden, blurred, panelled or editing viewer');
});

// ---------------------------------------------------------------- browser probes
// scripts/run-functional-checks.cjs globs tests/*.test.cjs into the shared unit phase, which is
// node-only. These Chromium probes are therefore opt-in: run with STORY_REVIEW_BROWSER=1.

const browserProbes = process.env.STORY_REVIEW_BROWSER === '1';
let browser, server, origin;
const allowed = /^\/(index\.html)$|^\/(js|css|assets|icons)\/[a-zA-Z0-9_./-]+\.(js|css|png|jpe?g|webp|svg|ico|woff2?)$/;

if (browserProbes) {

before(async () => {
  server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(request.url.split('?')[0]) === '/' ? '/index.html' : decodeURIComponent(request.url.split('?')[0]);
    const filename = path.resolve(root, '.' + pathname);
    if (!allowed.test(pathname) || !filename.startsWith(root + path.sep) || !fs.existsSync(filename) || !fs.lstatSync(filename).isFile()) {
      response.writeHead(404).end(); return;
    }
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' }[path.extname(filename)] || 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    response.end(fs.readFileSync(filename));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, executablePath: process.env.OFFICE_BROWSER_EXECUTABLE || undefined });
});

after(async () => {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

async function viewerPage(width, height = 844) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', hasTouch: true, serviceWorkers: 'block' });
  const errors = [];
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    return route.abort('blockedbyclient');
  });
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof Stories !== 'undefined' && typeof App !== 'undefined' && typeof Social !== 'undefined');
  await page.evaluate(({ apiOrigin, owner }) => {
    window.STORY_INTERACTIONS = true;
    SupaAuth.active = () => true;
    SupaAuth.uid = () => owner;
    SupaAuth.token = async () => 'review-fixture-token';
    Cloud.me = owner;
    Cloud.base = apiOrigin + '/rest/v1';
    Cloud.key = 'review-fixture-anon-key';
    Social.me = () => ({ name: 'Story Owner', handle: 'story_owner', colors: ['#444', '#222'], avatar: null });
    Social.cloudUser = () => ({ name: 'Story Owner', handle: 'story_owner', colors: ['#444', '#222'], avatar: null });
  }, { apiOrigin, owner });
  return { page, context, errors };
}

// Renders the real footer through the module's own _render, with the real stylesheet and real App.ic()
// icons, then measures. This is a component-geometry probe, not a full-flow proof.
async function measureFooter(page, variant) {
  return page.evaluate(({ variant, apiOrigin, owner, other, storyId }) => {
    const mine = variant.mine;
    const extension = variant.kind === 'video' ? 'mp4' : 'jpg';
    const row = Object.freeze({
      id: storyId, author: mine ? owner : other, kind: variant.kind, audience: 'authenticated',
      photo: apiOrigin + '/storage/v1/object/public/media/stories/' + (mine ? owner : other) + '/review.' + extension,
      ts: Date.now(), expires_at: new Date(Date.now() + 3600000).toISOString(), mine,
      seen: true, liked: false,
      view_count: mine ? variant.viewCount : null, like_count: mine ? variant.likeCount : null
    });
    Stories.close(false);
    const scope = Stories._scope(); // must precede _mount: a first _scope() resets and would unmount
    Stories._mount();
    Stories._ids = [row.id];
    Stories._index = 0;
    Stories._render(row, scope, ++Stories._revision);
    const sample = () => {
      const card = document.querySelector('#story-viewer .sv-card').getBoundingClientRect();
      const footer = document.getElementById('stories-footer');
      const controls = [...document.querySelectorAll('#stories-footer button, #stories-footer textarea')].map(control => {
        const box = control.getBoundingClientRect();
        return { id: control.id, width: box.width, height: box.height, left: box.left, right: box.right,
          clientWidth: control.clientWidth, scrollWidth: control.scrollWidth,
          textFits: control.scrollWidth <= control.clientWidth + 1, label: (control.textContent || '').trim() };
      });
      return { card: { left: card.left, right: card.right }, viewport: innerWidth,
        footerOverflow: footer.scrollWidth > footer.clientWidth + 1,
        rootOverflow: document.getElementById('story-viewer').scrollWidth > innerWidth + 1, controls };
    };
    // paused ("Play" label) then playing ("Pause" label) through the module's own updater
    Stories._play.pauses.add('manual'); Stories._updateActions();
    const paused = sample();
    Stories._play.pauses.delete('manual'); Stories._updateActions();
    const playing = sample();
    Stories.close(false);
    return { paused, playing };
  }, { variant, apiOrigin, owner, other, storyId });
}

function auditGeometry(label, sample) {
  const problems = [];
  if (sample.footerOverflow) problems.push(label + ': footer scrolls horizontally');
  if (sample.rootOverflow) problems.push(label + ': viewer exceeds the viewport');
  for (const control of sample.controls) {
    if (control.width < 44 || control.height < 44) problems.push(label + ': ' + control.id + ' is ' + control.width.toFixed(1) + 'x' + control.height.toFixed(1));
    if (!control.textFits) problems.push(label + ': ' + control.id + ' content overflows (' + control.scrollWidth + '>' + control.clientWidth + ')');
    if (control.left < sample.card.left - 1 || control.right > sample.card.right + 1) problems.push(label + ': ' + control.id + ' escapes the card');
  }
  return problems;
}

test('Story footer controls fit at 320px, 1280px and short landscape with zero Play/Pause jitter', async () => {
  const variants = [
    { name: 'viewer-photo', mine: false, kind: 'photo' },
    { name: 'viewer-video', mine: false, kind: 'video' },
    { name: 'owner-photo-large-counts', mine: true, kind: 'photo', viewCount: 123456, likeCount: 98765 },
    { name: 'owner-video', mine: true, kind: 'video', viewCount: 7, likeCount: 3 }
  ];
  const problems = [];
  const observed = [];
  // 740x360 is the short-landscape case: a phone turned sideways, where the card is height-constrained.
  for (const [width, height] of [[320, 844], [1280, 844], [740, 360]]) {
    const { page, context, errors } = await viewerPage(width, height);
    const label = width + 'x' + height;
    try {
      for (const variant of variants) {
        const { paused, playing } = await measureFooter(page, variant);
        problems.push(...auditGeometry(label + ' ' + variant.name + ' paused', paused));
        problems.push(...auditGeometry(label + ' ' + variant.name + ' playing', playing));
        const pausedButton = paused.controls.find(control => control.id === 'stories-pause');
        const playingButton = playing.controls.find(control => control.id === 'stories-pause');
        assert.equal(pausedButton.label, 'Play');
        assert.equal(playingButton.label, 'Pause');
        // The control reserves a fixed 96px box, so toggling the label must move nothing at all.
        const jitter = Math.abs(pausedButton.width - playingButton.width);
        if (jitter !== 0) {
          problems.push(label + ' ' + variant.name + ': pause control resizes between states ('
            + pausedButton.width.toFixed(2) + ' -> ' + playingButton.width.toFixed(2) + ')');
        }
        for (const before of paused.controls) {
          const after = playing.controls.find(control => control.id === before.id);
          if (after && (after.left !== before.left || after.width !== before.width)) {
            problems.push(label + ' ' + variant.name + ': ' + before.id + ' shifts when the label toggles ('
              + before.left.toFixed(2) + ' -> ' + after.left.toFixed(2) + ')');
          }
        }
        observed.push({ viewport: label, variant: variant.name, playWidth: pausedButton.width,
          pauseWidth: playingButton.width, jitter, controls: playing.controls.map(control => control.id) });
      }
      assert.deepEqual(errors, [], 'no uncaught page errors while rendering the viewer');
    } finally { await context.close(); }
  }
  assert.deepEqual(problems, [], JSON.stringify(observed, null, 2));
});

test('Account transition tears the viewer down and purges only the previous owner request namespace', async () => {
  const { page, context, errors } = await viewerPage(390);
  try {
    const result = await page.evaluate(async ({ owner, other, storyId, apiOrigin }) => {
      const key = actor => 'fm_stories_request_' + actor + '_reply_' + storyId;
      // a third account's namespace must never be touched by this transition
      const foreign = 'fm_stories_request_44444444-4444-4444-8444-444444444444_reply_' + storyId;
      localStorage.setItem(foreign, JSON.stringify({ id: '55555555-5555-4555-8555-555555555555', at: Date.now() }));
      const scope = Stories._scope();
      const held = Stories._request('reply', storyId, JSON.stringify({ p_id: storyId, p_text: 'held draft' }), undefined, scope);
      Stories._mount();
      Stories._ids = [storyId]; Stories._index = 0;
      Stories._render(Object.freeze({ id: storyId, author: other, kind: 'photo', audience: 'authenticated',
        photo: apiOrigin + '/storage/v1/object/public/media/stories/' + other + '/review.jpg',
        ts: Date.now(), expires_at: new Date(Date.now() + 3600000).toISOString(),
        mine: false, seen: true, liked: false, view_count: null, like_count: null }), scope, ++Stories._revision);
      Stories._drafts.set(storyId, 'private reply prose');
      const before = {
        mounted: !!document.getElementById('story-viewer'),
        shellInert: document.getElementById('app-shell').inert,
        bodyOverflow: document.body.style.overflow,
        storedOwnerRequest: localStorage.getItem(key(owner)) !== null,
        heldId: held.id
      };
      // pagehide must keep the retry namespace (lost-acknowledgement recovery)
      window.dispatchEvent(new Event('pagehide'));
      const afterPagehide = { storedOwnerRequest: localStorage.getItem(key(owner)) !== null,
        mounted: !!document.getElementById('story-viewer'), drafts: Stories._drafts.size };
      // now switch accounts the way SupaAuth does
      SupaAuth.uid = () => other;
      Cloud.me = other;
      window.dispatchEvent(new Event('formora:sessionchange'));
      const afterSwitch = {
        storedOwnerRequest: localStorage.getItem(key(owner)) !== null,
        foreignRetained: localStorage.getItem(foreign) !== null,
        mounted: !!document.getElementById('story-viewer'),
        shellInert: document.getElementById('app-shell').inert,
        bodyOverflow: document.body.style.overflow,
        feed: Stories.storyFeed.length, drafts: Stories._drafts.size,
        intents: Stories._intents.size, pending: Stories.pending.size,
        error: Stories.error, ownerAfter: Stories.owner()
      };
      return { before, afterPagehide, afterSwitch };
    }, { owner, other, storyId, apiOrigin });

    assert.equal(result.before.mounted, true);
    assert.equal(result.before.shellInert, true, 'the viewer makes the app shell inert while open');
    assert.equal(result.before.bodyOverflow, 'hidden');
    assert.equal(result.before.storedOwnerRequest, true);
    // pagehide keeps the opaque retry id so a reload can reconcile instead of duplicating
    assert.equal(result.afterPagehide.storedOwnerRequest, true, 'pagehide must not purge retry ids');
    assert.equal(result.afterPagehide.mounted, false);
    assert.equal(result.afterPagehide.drafts, 0, 'reply prose is dropped from RAM on teardown');
    // account change purges only the previous owner
    assert.deepEqual({
      storedOwnerRequest: result.afterSwitch.storedOwnerRequest,
      foreignRetained: result.afterSwitch.foreignRetained,
      mounted: result.afterSwitch.mounted,
      shellInert: result.afterSwitch.shellInert,
      bodyOverflow: result.afterSwitch.bodyOverflow,
      feed: result.afterSwitch.feed, drafts: result.afterSwitch.drafts,
      intents: result.afterSwitch.intents, pending: result.afterSwitch.pending, error: result.afterSwitch.error
    }, { storedOwnerRequest: false, foreignRetained: true, mounted: false, shellInert: false,
      bodyOverflow: '', feed: 0, drafts: 0, intents: 0, pending: 0, error: null });
    assert.equal(result.afterSwitch.ownerAfter, other);
    assert.deepEqual(errors, [], 'no uncaught page errors during the account transition');
  } finally { await context.close(); }
});

test('Story preferences and Story activity report the failure and open no panel when no owner is bound', async () => {
  const { page, context, errors } = await viewerPage(390);
  try {
    const outcome = await page.evaluate(async () => {
      const rejections = [];
      const capture = event => { rejections.push(String(event.reason?.status ?? event.reason?.message ?? event.reason)); event.preventDefault(); };
      window.addEventListener('unhandledrejection', capture);
      // Cloud identity has not settled yet: Stories.owner() is empty, exactly as during initCloud.
      Cloud.me = '';
      const toasts = [];
      const realToast = App.toast; App.toast = message => { toasts.push(message); };
      const settings = App.openStorySettings();
      const notifications = App.openStoryNotifications();
      const statuses = [];
      for (const promise of [settings, notifications]) {
        try { await promise; statuses.push('settled'); }
        catch (error) { statuses.push('rejected:' + error.status); }
      }
      await new Promise(resolve => setTimeout(resolve, 60));
      App.toast = realToast;
      window.removeEventListener('unhandledrejection', capture);
      return { statuses, toasts, rejections,
        panel: !!document.getElementById('stories-panel'),
        viewer: !!document.getElementById('story-viewer') };
    });
    // Both controls must fail closed: settle, tell the member, leave no half-open surface behind.
    assert.deepEqual(outcome.statuses, ['settled', 'settled'], 'neither entry point leaks a rejection to the caller');
    assert.deepEqual(outcome.rejections, [], 'nothing reaches the unhandledrejection handler');
    assert.deepEqual(outcome.toasts, ['Sign in again to continue.', 'Sign in again to continue.'],
      'the member is told why the panel did not open');
    assert.equal(outcome.panel, false, 'no panel is left mounted');
    assert.equal(outcome.viewer, false, 'no viewer shell is left mounted over the app');
    assert.deepEqual(errors, [], 'nothing throws as a page error');
  } finally { await context.close(); }
});

test('Desktop hover pauses honestly and one press of the control genuinely resumes playback', async () => {
  const { page, context, errors } = await viewerPage(1280);
  try {
    const outcome = await page.evaluate(({ apiOrigin, other, storyId }) => {
      const row = expiry => Object.freeze({ id: storyId, author: other, kind: 'photo', audience: 'authenticated',
        photo: apiOrigin + '/storage/v1/object/public/media/stories/' + other + '/review.jpg',
        ts: Date.now(), expires_at: new Date(Date.now() + expiry).toISOString(),
        mine: false, seen: false, liked: false, view_count: null, like_count: null });
      Stories.close(false);
      const scope = Stories._scope();
      Stories._mount();
      Stories._ids = [storyId]; Stories._index = 0;
      Stories._render(row(3600000), scope, ++Stories._revision);
      const play = Stories._play;
      play.ready = true; play.qualifiedMs = 1500; // 1.5s of the 2s qualification already earned
      Stories._queueTick();
      const control = () => document.getElementById('stories-pause');
      const state = () => ({ pauses: [...Stories._play.pauses], ticking: Stories._tickTimer != null,
        pressed: control().getAttribute('aria-pressed'), label: control().textContent.trim(),
        ariaLabel: control().getAttribute('aria-label') });
      const running = { ...state(), qualifiedMs: play.qualifiedMs };
      const stage = document.getElementById('stories-stage');
      stage.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse', bubbles: true }));
      const hovered = { ...state(), qualifiedMs: play.qualifiedMs };
      Stories.togglePause(); // one press must resume, not fight a pause the member cannot see
      const afterResume = state();
      Stories.togglePause(); // and a second press pauses again
      const afterPause = state();
      // The cursor is still resting on the stage; whichever way the next story starts, the control must say so.
      Stories._render(row(3600000), Stories._scope(), ++Stories._revision);
      Stories._play.ready = true; Stories._updateActions();
      const nextStory = { ...state(), hoveredFlag: Stories._hovered };
      Stories.close(false);
      return { running, hovered, afterResume, afterPause, nextStory };
    }, { apiOrigin, other, storyId });

    assert.equal(outcome.running.ticking, true, 'the qualification clock runs before the pointer enters');
    assert.equal(outcome.running.pressed, 'false');
    assert.equal(outcome.running.label, 'Pause');
    // Hover is a real pause, so the control must report a real pause.
    assert.ok(outcome.hovered.pauses.includes('hover'));
    assert.equal(outcome.hovered.ticking, false, 'mouse hover stops the clock');
    assert.equal(outcome.hovered.pressed, 'true', 'the control reports the hover pause instead of claiming to play');
    assert.equal(outcome.hovered.label, 'Play');
    assert.equal(outcome.hovered.ariaLabel, 'Play story');
    // Qualification is defined as continuous foreground time, so discarding it on pause is correct.
    assert.equal(outcome.hovered.qualifiedMs, 0, 'a pause restarts the continuous qualification window');
    // One press recovers: hover is released and playback actually restarts.
    assert.deepEqual(outcome.afterResume.pauses, [], 'an explicit resume clears the hover pause');
    assert.equal(outcome.afterResume.ticking, true, 'the clock restarts on the same press');
    assert.equal(outcome.afterResume.label, 'Pause');
    assert.equal(outcome.afterResume.pressed, 'false');
    // A second press pauses again and says so.
    assert.deepEqual(outcome.afterPause.pauses, ['manual']);
    assert.equal(outcome.afterPause.ticking, false);
    assert.equal(outcome.afterPause.label, 'Play');
    assert.equal(outcome.afterPause.pressed, 'true');
    // Invariant across a story change with the cursor still down: paused state and label never disagree.
    assert.equal(outcome.nextStory.pressed, String(outcome.nextStory.pauses.length > 0),
      'the control state matches the real pause set on the next story');
    assert.equal(outcome.nextStory.label, outcome.nextStory.pauses.length ? 'Play' : 'Pause');
    // Observed here: _hovered survives an explicit resume, so with the cursor still on the stage the next
    // story starts paused ("Play"). Truthful, but it is reported as a separate usability finding.
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

}
