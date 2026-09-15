'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const root = fs.realpathSync(path.resolve(__dirname, '..'));
const mimeTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json' };
const configOverride = `Object.assign(window,{SUPABASE_URL:'',SUPABASE_ANON_KEY:'',USE_SUPABASE_AUTH:false,GOOGLE_CLIENT_ID:'',GOOGLE_IOS_CLIENT_ID:'',POSTHOG_KEY:'',EMAILJS_PUBLIC_KEY:'',EMAILJS_SERVICE_ID:'',EMAILJS_TEMPLATE_ID:'',EMAIL_FN_URL:'',SHEETS_API:'',SOCIAL_API:'',PEXELS_KEY:''});`;

function allowedFile(pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (relative.split('/').some(segment => !segment || segment.startsWith('.')) || relative.includes('\\')) return null;
  const extension = path.extname(relative);
  const allowed = relative === 'index.html' || (/^js\//.test(relative) && extension === '.js') || (/^css\//.test(relative) && extension === '.css')
    || (/^(assets|icons)\//.test(relative) && Object.hasOwn(mimeTypes, extension));
  const filename = path.resolve(root, relative);
  try { return allowed && filename.startsWith(root + path.sep) && fs.statSync(filename).isFile() ? filename : null; } catch { return null; }
}

// Offline app with a seeded, onboarded local account; every non-loopback request is blocked.
async function fixture(context, { reducedMotion = 'no-preference' } = {}) {
  const server = http.createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); } catch { response.writeHead(400).end(); return; }
    if (pathname === '/version.txt') { response.writeHead(200, { 'Content-Type': 'text/plain' }).end('0'); return; }
    const filename = allowedFile(pathname);
    if (!filename || request.method !== 'GET') { response.writeHead(404).end(); return; }
    let body = fs.readFileSync(filename);
    if (filename === path.join(root, 'js', 'config.js')) body = Buffer.from(body.toString() + configOverride);
    response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filename)], 'Cache-Control': 'no-store' }).end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, timeout: 15000, executablePath: process.env.OFFICE_BROWSER_EXECUTABLE || undefined });
  context.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const browserContext = await browser.newContext({ serviceWorkers: 'block', reducedMotion, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await browserContext.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await browserContext.addInitScript(() => { localStorage.setItem('fm_dl_x', '1'); });
  const page = await browserContext.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource|Content Security Policy/.test(message.text())) errors.push(message.text()); });
  page.on('dialog', dialog => dialog.dismiss());
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof App !== 'undefined' && typeof Social !== 'undefined');
  await page.evaluate(() => {
    Auth.data = { accounts: [{ id: 'launch-ui', email: 'launch@example.test', name: 'Launch', provider: 'email', emailVerified: true }], currentUserId: 'launch-ui' };
    Auth.save();
    Store.load('gymcoach_v1_launch-ui');
    Object.assign(Store.state.profile, { name: 'Launch', weight: 74, height: 176, age: 30, gender: 'male', goal: 'muscle', level: 'intermediate', days: 4, onboarded: true });
    Store.save();
    Social.load('launch-ui');
    App.enterApp();
  });
  await page.waitForSelector('#view-feed.active .composer');
  return { page, errors };
}

const paneState = page => page.evaluate(() => {
  const panes = ['view-home', 'view-today', 'view-progress', 'view-nutrition'];
  const shown = panes.filter(id => document.getElementById(id).style.display !== 'none');
  const element = document.getElementById(shown[0]);
  return { shown, sub: App.coachSub, classes: [...element.classList].filter(name => name.startsWith('pane-in')), animation: getComputedStyle(element).animationName,
    firstCardAnimation: element.firstElementChild ? getComputedStyle(element.firstElementChild).animationName : null,
    active: document.querySelector('#coach-subnav .ssub.active')?.textContent.trim(), scrollY: window.scrollY };
});

test('Coach sub-tabs slide in the direction of travel, reset scroll and stay still on re-render', async context => {
  const { page, errors } = await fixture(context);
  await page.evaluate(() => App.selectTab('coach'));
  await page.waitForSelector('#view-coach.active');
  let state = await paneState(page);
  assert.deepEqual(state.shown, ['view-home']);
  assert.deepEqual(state.classes, [], 'entering Coach plays only the tab slide');
  await page.locator('#coach-subnav .ssub', { hasText: 'Today' }).click();
  state = await paneState(page);
  assert.deepEqual([state.shown, state.classes, state.animation, state.active], [['view-today'], ['pane-in-r'], 'viewInR', 'Today']);
  assert.equal(state.firstCardAnimation, 'cardIn', 'cards inside the pane stagger in');
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.locator('#coach-subnav .ssub', { hasText: 'Nutrition' }).click();
  state = await paneState(page);
  assert.deepEqual([state.shown, state.classes, state.animation, state.active, state.scrollY], [['view-nutrition'], ['pane-in-r'], 'viewInR', 'Nutrition', 0]);
  assert.ok(await page.locator('#view-nutrition .card').count() >= 3, 'Nutrition renders its cards');
  assert.equal(await page.evaluate(() => document.getElementById('modal')?.classList.contains('hidden') ?? true), true, 'opening Nutrition does not open a dialog');
  await page.locator('#coach-subnav .ssub', { hasText: 'Overview' }).click();
  state = await paneState(page);
  assert.deepEqual([state.shown, state.classes, state.animation], [['view-home'], ['pane-in-l'], 'viewInL']);
  await page.evaluate(() => App.renderCoach('overview'));
  state = await paneState(page);
  assert.deepEqual(state.classes, [], 're-rendering the current pane does not replay the slide');
  await page.evaluate(() => { App.selectTab('home'); App.goTab('nutrition'); });
  state = await paneState(page);
  assert.deepEqual([state.shown, state.classes], [['view-nutrition'], []], 'a deep link into Coach shows the target pane with the single tab slide');
  assert.equal(await page.evaluate(() => App.curTab), 'coach');
  assert.deepEqual(errors, []);
});

test('Reduced motion disables the Coach pane slide', async context => {
  const { page } = await fixture(context, { reducedMotion: 'reduce' });
  await page.evaluate(() => App.selectTab('coach'));
  await page.locator('#coach-subnav .ssub', { hasText: 'Progress' }).click();
  const state = await paneState(page);
  assert.deepEqual([state.classes, state.animation, state.firstCardAnimation], [['pane-in-r'], 'none', 'none']);
});

test('Music is offered as an add-on after a photo or Flex is attached and post text is readable', async context => {
  const { page, errors } = await fixture(context);
  const actions = () => page.evaluate(() => [...document.querySelectorAll('#view-feed .composer-actions button')].map(button => button.textContent.trim()));
  assert.deepEqual(await actions(), ['Photo', 'Flex', 'Post'], 'no standalone Music option before media is attached');
  assert.equal(await page.locator('.composer-ask').count(), 0);
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
    canvas.getContext('2d').fillStyle = '#f36'; canvas.getContext('2d').fillRect(0, 0, 64, 64);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
    await Social.postPhoto({ target: { files: [new File([blob], 'flex.jpg', { type: 'image/jpeg' })] } });
  });
  await page.waitForSelector('.composer-ask');
  assert.match(await page.locator('.composer-ask span').textContent(), /Add music to this photo\?/);
  assert.deepEqual(await actions(), ['Photo', 'Flex', 'Post'], 'the offer replaces the extra action while it is open');
  await page.locator('.composer-ask button', { hasText: 'No music' }).click();
  assert.equal(await page.locator('.composer-ask').count(), 0);
  assert.deepEqual(await actions(), ['Photo', 'Flex', 'Add music', 'Post'], 'music stays reachable after declining');
  await page.locator('.composer-photos .cp-x').click();
  assert.deepEqual(await actions(), ['Photo', 'Flex', 'Post'], 'removing the photo removes the add-on');
  await page.evaluate(() => { Social.pendingVideo = 'https://media.example.test/flex.mp4'; Social.render(); });
  assert.match(await page.locator('.composer-ask span').textContent(), /Add music to this Flex\?/);
  await page.evaluate(() => { Social.pendingMusic = { id: 'track', title: 'Synthetic Track', artist: 'Fixture' }; Social.render(); });
  assert.equal(await page.locator('.composer-ask').count(), 0);
  assert.deepEqual(await actions(), ['Photo', 'Flex', 'Music', 'Post']);
  assert.match(await page.locator('.composer-music').textContent(), /Synthetic Track/);
  await page.evaluate(() => { Social.pendingVideo = null; Social.pendingMusic = null; Social.render(); });
  const fontSize = await page.evaluate(() => { const post = document.querySelector('#view-feed .post-text'); return post ? parseFloat(getComputedStyle(post).fontSize) : null; });
  assert.ok(fontSize >= 16, `post text is ${fontSize}px`);
  assert.deepEqual(errors, []);
});
