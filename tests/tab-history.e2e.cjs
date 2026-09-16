'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const root = fs.realpathSync(path.resolve(__dirname, '..'));
const mimeTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const configOverride = `Object.assign(window,{SUPABASE_URL:'',SUPABASE_ANON_KEY:'',USE_SUPABASE_AUTH:false,GOOGLE_CLIENT_ID:'',GOOGLE_IOS_CLIENT_ID:'',POSTHOG_KEY:'',EMAILJS_PUBLIC_KEY:'',EMAILJS_SERVICE_ID:'',EMAILJS_TEMPLATE_ID:''});window.RAZORPAY=Object.assign({},window.RAZORPAY,{enabled:false});`;

function allowedFile(pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (relative.split('/').some(segment => !segment || segment.startsWith('.')) || relative.includes('\\')) return null;
  const extension = path.extname(relative);
  const allowed = relative === 'index.html' || (/^js\//.test(relative) && extension === '.js') || (/^css\//.test(relative) && extension === '.css')
    || (/^(assets|icons)\//.test(relative) && Object.hasOwn(mimeTypes, extension));
  const filename = path.resolve(root, relative);
  try { return allowed && filename.startsWith(root + path.sep) && fs.statSync(filename).isFile() ? filename : null; } catch { return null; }
}

// Offline app behind an explicit earlier document so the effect of browser Back is observable.
async function fixture(context) {
  const server = http.createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); } catch { response.writeHead(400).end(); return; }
    if (pathname === '/version.txt') { response.writeHead(200, { 'Content-Type': 'text/plain' }).end('0'); return; }
    if (pathname === '/sentinel.html') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>sentinel</title><p id="sentinel">before the app</p>'); return; }
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
  const browserContext = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await browserContext.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await browserContext.addInitScript(() => { localStorage.setItem('fm_dl_x', '1'); });
  const page = await browserContext.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource|Content Security Policy/.test(message.text())) errors.push(message.text()); });
  page.on('dialog', dialog => dialog.dismiss());
  await page.goto(origin + '/sentinel.html', { waitUntil: 'domcontentloaded' });
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof App !== 'undefined' && typeof Social !== 'undefined');
  await page.evaluate(() => {
    Auth.data = { accounts: [{ id: 'tab-history', email: 'history@example.test', name: 'History', provider: 'email', emailVerified: true }], currentUserId: 'tab-history' };
    Auth.save();
    Store.load('gymcoach_v1_tab-history');
    Object.assign(Store.state.profile, { name: 'History', weight: 74, height: 176, age: 30, gender: 'male', goal: 'muscle', level: 'intermediate', days: 4, onboarded: true });
    Store.save();
    Social.load('tab-history');
    App.enterApp();
  });
  await page.waitForSelector('#view-feed.active .composer');
  return { page, errors };
}

const state = page => page.evaluate(() => ({ tab: App.curTab, entry: history.state && history.state.fmTab, url: location.pathname + location.search + location.hash, sentinel: !!document.getElementById('sentinel') }));

test('Browser Back returns to the previous top-level tab before leaving the app (DEF-059)', async context => {
  const { page, errors } = await fixture(context);
  assert.deepEqual(await state(page), { tab: 'home', entry: 'home', url: '/', sentinel: false }, 'the first tab replaces the boot entry instead of adding one');
  await page.click('#tabbar .tab[data-tab="search"]');
  await page.click('#tabbar .tab[data-tab="profile"]');
  await page.waitForSelector('#view-profile #p-name');
  await page.evaluate(() => App.selectTab('profile'));
  assert.equal((await state(page)).entry, 'profile', 're-rendering the same tab adds no history entry');
  await page.goBack({ waitUntil: 'commit' });
  await page.waitForFunction(() => App.curTab === 'search');
  assert.deepEqual(await state(page), { tab: 'search', entry: 'search', url: '/', sentinel: false });
  await page.goBack({ waitUntil: 'commit' });
  await page.waitForFunction(() => App.curTab === 'home');
  assert.equal((await state(page)).entry, 'home');
  await page.goForward({ waitUntil: 'commit' });
  await page.waitForFunction(() => App.curTab === 'search');
  assert.equal(await page.evaluate(() => document.querySelector('#tabbar .tab[aria-current="page"]')?.dataset.tab), 'search', 'the tab bar follows history navigation');
  await page.goBack({ waitUntil: 'commit' });
  await page.waitForFunction(() => App.curTab === 'home');
  await page.goBack({ waitUntil: 'commit' });
  await page.waitForSelector('#sentinel');
  assert.deepEqual(errors, []);
});

test('Back first closes an open dialog or sheet and keeps the current tab', async context => {
  const { page, errors } = await fixture(context);
  await page.click('#tabbar .tab[data-tab="profile"]');
  await page.waitForSelector('#view-profile #p-name');
  await page.evaluate(() => App.openPricing());
  await page.waitForFunction(() => !document.getElementById('modal').classList.contains('hidden'));
  await page.goBack({ waitUntil: 'commit' });
  await page.waitForFunction(() => document.getElementById('modal').classList.contains('hidden'));
  assert.deepEqual(await state(page), { tab: 'profile', entry: 'profile', url: '/', sentinel: false }, 'the dialog closed and the profile entry was restored');
  await page.evaluate(() => App.confirmLogout());
  await page.waitForSelector('#sheet-wrap');
  await page.goBack({ waitUntil: 'commit' });
  await page.waitForFunction(() => !document.getElementById('sheet-wrap'));
  assert.equal(await page.evaluate(() => Auth.currentUser()?.id), 'tab-history', 'Back cancels the sheet without logging out');
  assert.equal((await state(page)).tab, 'profile');
  await page.goBack({ waitUntil: 'commit' });
  await page.waitForFunction(() => App.curTab === 'home');
  assert.deepEqual(errors, []);
});
