'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const root = fs.realpathSync(path.resolve(__dirname, '..'));
const mimeTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2' };
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
  return { page, errors };
}

const enter = page => page.evaluate(() => {
  Auth.data = { accounts: [{ id: 'polish-ui', email: 'polish@example.test', name: 'Polish', provider: 'email', emailVerified: true }], currentUserId: 'polish-ui' };
  Auth.save();
  Store.load('gymcoach_v1_polish-ui');
  Object.assign(Store.state.profile, { name: 'Polish', weight: 74, height: 176, age: 30, gender: 'male', goal: 'muscle', level: 'intermediate', days: 4, onboarded: true });
  Store.save();
  Social.load('polish-ui');
  App.enterApp();
});

const motion = (page, selector) => page.evaluate(selector => {
  const elements = [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length);
  return elements.slice(0, 3).map(element => ({ name: getComputedStyle(element).animationName, delay: getComputedStyle(element).animationDelay,
    running: element.getAnimations().filter(animation => animation.playState === 'running').length }));
}, selector);

test('Auth views, lists and pickers get staggered entrance motion when they re-render', async context => {
  const { page, errors } = await fixture(context);
  // switching auth views recreates the card's children, which must animate in with a stagger
  await page.evaluate(() => App.showAuth('signup'));
  const authChildren = await motion(page, '#auth-card > *');
  assert.ok(authChildren.length >= 2 && authChildren.every(item => item.name === 'cardIn'), JSON.stringify(authChildren));
  assert.ok(authChildren.some(item => item.running > 0), 'auth view switch replays the entrance motion');
  assert.notEqual(authChildren[0].delay, authChildren[1].delay, 'children are staggered');
  await enter(page);
  await page.waitForSelector('#view-feed.active .composer');
  await page.evaluate(() => Social.feedTab('crew'));
  const crew = await motion(page, '#view-feed .crew-card');
  assert.ok(crew.length >= 2 && crew.every(item => item.name === 'cardIn'), JSON.stringify(crew));
  assert.deepEqual([crew[0].delay, crew[1].delay], ['0s', '0.04s']);
  await page.evaluate(() => { App.selectTab('coach'); App.renderCoach('nutrition'); });
  await page.evaluate(() => App.setMealSlot(MEAL_SLOTS[1]));
  const meals = await motion(page, '#view-nutrition .meal-idea');
  assert.ok(meals.length >= 1 && meals.every(item => item.name === 'cardIn'), JSON.stringify(meals));
  await page.evaluate(() => { Entitlements.ready = () => true; App.openPricing(); });
  await page.waitForSelector('#modal:not(.hidden) .ptier');
  const tiers = await motion(page, '#modal-card .ptier');
  assert.ok(tiers.length >= 3 && tiers.every(item => item.name === 'cardIn') && tiers[2].delay === '0.08s', JSON.stringify(tiers));
  await page.evaluate(() => App.closeModal());
  assert.deepEqual(errors, []);
});

test('Reduced motion disables the re-render entrance motion', async context => {
  const { page } = await fixture(context, { reducedMotion: 'reduce' });
  await page.evaluate(() => App.showAuth('signup'));
  const authChildren = await motion(page, '#auth-card > *');
  assert.ok(authChildren.length >= 2 && authChildren.every(item => item.name === 'none'), JSON.stringify(authChildren));
  await enter(page);
  await page.waitForSelector('#view-feed.active .composer');
  await page.evaluate(() => Social.feedTab('crew'));
  const crew = await motion(page, '#view-feed .crew-card');
  assert.ok(crew.length >= 1 && crew.every(item => item.name === 'none'), JSON.stringify(crew));
});

test('A last-confirmed paid membership stays visible with a stale hint while the re-check fails', async context => {
  const { page, errors } = await fixture(context);
  await enter(page);
  await page.waitForSelector('#view-feed.active .composer');
  const seed = error => page.evaluate(error => {
    Entitlements._identity = () => 'fixture-owner';
    Entitlements._owner = 'fixture-owner'; Entitlements._source = 'cache'; Entitlements.loading = false; Entitlements.error = error;
    Entitlements._e = { tier: 'elite', status: 'active', current_period_end: new Date(Date.now() + 20 * 86400000).toISOString() };
    App.selectTab('profile');
  }, error);
  await seed('membership_unavailable');
  await page.waitForSelector('#view-profile .member-card');
  const stale = await page.evaluate(() => ({ known: Entitlements.known(), stale: Entitlements.stale(), isElite: Entitlements.isElite(),
    upgrade: !!document.querySelector('#view-profile .upgrade-card'), card: document.querySelector('#view-profile .member-card')?.dataset.stale || null,
    status: document.querySelector('#view-profile .mc-status')?.textContent.trim() || '', hint: document.querySelector('#view-profile .mc-stale')?.textContent.trim() || '' }));
  assert.deepEqual([stale.known, stale.stale, stale.isElite, stale.upgrade, stale.card], [true, true, true, false, 'true'], JSON.stringify(stale));
  assert.match(stale.status, /^Last confirmed/);
  assert.match(stale.hint, /last confirmed status/);
  // once the re-check succeeds the same card renders without the hint
  await seed(null);
  await page.waitForSelector('#view-profile .member-card:not([data-stale])');
  const fresh = await page.evaluate(() => ({ hint: !!document.querySelector('#view-profile .mc-stale'), status: document.querySelector('#view-profile .mc-status')?.textContent.trim() || '' }));
  assert.equal(fresh.hint, false);
  assert.match(fresh.status, /^Active/);
  // a free member whose re-check fails still sees neither prompt nor card
  await page.evaluate(() => { Entitlements._e = { tier: 'free', status: 'inactive' }; Entitlements._source = 'server'; Entitlements.error = 'membership_unavailable'; App.selectTab('home'); App.selectTab('profile'); });
  await page.waitForSelector('#view-profile #p-name');
  const free = await page.evaluate(() => ({ upgrade: !!document.querySelector('#view-profile .upgrade-card'), card: !!document.querySelector('#view-profile .member-card') }));
  assert.deepEqual(free, { upgrade: false, card: false });
  assert.deepEqual(errors, []);
});
