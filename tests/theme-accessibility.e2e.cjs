'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const AxeBuilder = require('@axe-core/playwright').default;
const browserName = process.env.FORMORA_QA_BROWSER || 'chromium';
const browserType = require('playwright')[browserName];
const root = path.resolve(__dirname, '..');
const cssBudget = 102400;
const timeout = 8000;
const sources = new Map();
const results = [];
let browser, server, origin, directory;

const sha256 = body => createHash('sha256').update(body).digest('hex');
const mimeTypes = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.txt': 'text/plain', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
};

function publicAsset(rawPathname) {
  let pathname;
  try { pathname = decodeURIComponent(rawPathname); } catch { return null; }
  if (pathname === '/') pathname = '/index.html';
  if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(segment => segment.startsWith('.'))) return null;
  if (!/^\/(index\.html|legal\.html|version\.txt|manifest\.webmanifest|favicon\.ico)$/.test(pathname)
    && !/^\/(js\/[A-Za-z0-9_/-]+\.js|css\/[A-Za-z0-9_/-]+\.css)$/.test(pathname)
    && !/^\/(assets|icons)\/[A-Za-z0-9_/-]+\.(json|png|jpe?g|svg|webp|ico|woff2|mp4|mp3)$/.test(pathname)) return null;
  const filename = path.resolve(root, '.' + pathname);
  try {
    if (!filename.startsWith(root + path.sep) || !fs.statSync(filename).isFile() || fs.realpathSync(filename) !== filename) return null;
  } catch { return null; }
  return path.relative(root, filename);
}

function snapshot(relative) {
  const filename = path.join(root, relative);
  if (!fs.existsSync(filename)) return;
  if (fs.lstatSync(filename).isSymbolicLink()) return;
  if (fs.statSync(filename).isDirectory()) {
    for (const child of fs.readdirSync(filename).sort()) snapshot(path.join(relative, child));
  } else if (!sources.has(relative)) {
    sources.set(relative, fs.readFileSync(filename));
  }
}

function fixtureState(tier) {
  return {
    profile: {
      name: 'Theme Fixture', email: 'theme.fixture@example.test', username: 'theme_fixture',
      onboarded: true, gender: 'male', dob: '1995-03-28', heightCm: 178, startWeightKg: 80,
      targetWeightKg: 75, activityFactor: 1.55, physique: 'lean_aesthetic', physiqueChosen: true,
      unit: 'kg', diet: 'veg', tier, privacy: 'public', verified: true,
      bio: 'Local accessibility fixture.', following: [], autoFollowed: [],
      socials: { instagram: '', linkedin: '', facebook: '' },
    },
    weightLog: [], workoutLog: [], foodLog: [], restDays: [], updatedAt: 2,
  };
}

before(async () => {
  assert.ok(['chromium', 'firefox', 'webkit'].includes(browserName), 'Known Playwright engine required');
  const output = path.resolve(root, process.env.FORMORA_QA_THEME_AUDIT_OUTPUT || 'dist/theme');
  fs.mkdirSync(output, { recursive: true });
  directory = fs.mkdtempSync(path.join(output, browserName + '-'));
  for (const relative of ['index.html', 'legal.html', 'version.txt', 'manifest.webmanifest', 'js', 'css',
    'tests/theme-accessibility.e2e.cjs', 'tests/qa-ui-ux-probes.cjs', 'tests/remaining-screens.e2e.cjs',
    'tests/product-lifecycle.e2e.cjs', 'tests/touch-targets.test.cjs']) snapshot(relative);
  const config = sources.get('js/config.js').toString();
  const publicSettings = [...config.matchAll(/window\.(SUPABASE_URL|SUPABASE_ANON_KEY)\s*=\s*(["'])(.*?)\2/g)];
  assert.equal(publicSettings.length, 2, 'Both public backend settings must be masked in every served script');
  server = http.createServer((request, response) => {
    const relative = ['GET', 'HEAD'].includes(request.method)
      ? publicAsset(new URL(request.url, 'http://127.0.0.1').pathname) : null;
    if (!relative) { response.writeHead(404).end(); return; }
    snapshot(relative);
    let body = sources.get(relative);
    if (/\.(js|html)$/.test(relative)) {
      let text = body.toString();
      for (const setting of publicSettings) text = text.replaceAll(setting[3], setting[1] === 'SUPABASE_URL' ? origin : 'fixture-public-anon');
      if (relative === 'js/config.js') text += `\nObject.assign(window, {
        SUPABASE_URL: ${JSON.stringify(origin)}, SUPABASE_ANON_KEY: 'fixture-public-anon', USE_SUPABASE_AUTH: true,
        GOOGLE_CLIENT_ID: '', GOOGLE_IOS_CLIENT_ID: '', POSTHOG_KEY: '', EMAILJS_PUBLIC_KEY: '',
        EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAIL_FN_URL: '', SHEETS_API: '', SOCIAL_API: '',
        PEXELS_KEY: '', MOD_TOKEN: ''
      });
      if (window.Currency) Object.assign(window.Currency, { ready: true, cur: 'INR', rate: 83, country: 'IN' });\n`;
      body = Buffer.from(text);
    }
    response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(relative)] || 'application/octet-stream',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await browserType.launch({ headless: true,
    executablePath: browserName === 'chromium' ? process.env.OFFICE_BROWSER_EXECUTABLE || undefined : undefined,
    args: browserName === 'chromium' ? ['--disable-background-networking', '--disable-component-update',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'] : [],
  });
});

after(async () => {
  try { if (browser) await browser.close(); }
  finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
  if (!directory) return;
  const manifest = [...sources].map(([relative, body]) => {
    const current = fs.readFileSync(path.join(root, relative));
    const target = path.join(directory, 'source', relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    return { path: relative, bytes: body.length, sha256: sha256(body), currentSha256: sha256(current), unchanged: body.equals(current) };
  });
  const stylesheet = sources.get('css/styles.css');
  const sourceUnchanged = manifest.every(entry => entry.unchanged);
  const ownedSourcesUnchanged = manifest.filter(entry => ['css/styles.css', 'tests/theme-accessibility.e2e.cjs',
    'tests/remaining-screens.e2e.cjs'].includes(entry.path))
    .every(entry => entry.unchanged);
  const defects = Object.fromEntries(['DEF041', 'DEF042', 'DEF043'].map(defect => {
    const cases = results.filter(result => result.name.startsWith(defect));
    return [defect, { cases: cases.length, passed: cases.filter(result => result.result === 'passed').length,
      failed: cases.filter(result => result.result !== 'passed').length }];
  }));
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ browser: browserName,
    observedAt: new Date().toISOString(), cssBytes: stylesheet.length, cssBudget,
    sourceFingerprint: sha256(manifest.map(entry => entry.path + ':' + entry.sha256).join('\n')),
    sourceUnchanged, ownedSourcesUnchanged, source: manifest, defects, results,
    limits: ['Local fixture accounts only; every external request intercepted; no hosted or physical-device acceptance.',
      'Remote fonts are blocked. Existing font declarations are retained; production-font glyph metrics are unverified.',
      '200% text tests double each visible element computed font size, not body inheritance or full-page zoom.',
      'Accent-surface probes render real app screens and opaque computed gradient stops; plus symbols use the 3:1 non-text threshold.',
      'Story and camera editor probes use a marked local PNG; no camera hardware, capture or upload is exercised.',
      '44px is the product target, not a blanket WCAG AA claim; disabled text is contrast-exempt.'],
  }, null, 2) + '\n');
  console.log('Theme evidence: ' + path.relative(root, path.join(directory, 'report.json')));
  assert.ok(ownedSourcesUnchanged, 'The three owned source files must remain stable during measurement');
});

async function openApp(testContext, { tier = 'free', width = 390, height = 844, signedIn = false, withPeer = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 700,
    reducedMotion: 'reduce', serviceWorkers: 'block' });
  const record = { name: testContext.name, tier, width, pageErrors: [], blockedExternal: [], observations: [], screenshots: [] };
  results.push(record);
  const state = fixtureState(tier);
  const uid = 'a11y-0000-4000-8000-000000000001';
  await context.route('**/*', async route => {
    try {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        record.blockedExternal.push({ origin: url.origin, pathname: url.pathname });
        await route.abort('blockedbyclient'); return;
      }
      if (url.protocol === 'blob:') { await route.continue(); return; }
      if (url.pathname.startsWith('/auth/v1/')) {
        await route.fulfill({ json: { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600,
          user: { id: uid, email: state.profile.email, user_metadata: { name: state.profile.name } } } }); return;
      }
      if (url.pathname.startsWith('/rest/v1/')) {
        if (url.pathname.endsWith('/rpc/get_state')) {
          const peerUid = 'a11y-0000-4000-8000-000000000002';
          const users = withPeer ? { [peerUid]: { uid: peerUid, name: 'Theme Peer', username: 'theme_peer',
            privacy: 'public', tier, bio: 'Offline contrast fixture.', following: [] } } : {};
          await route.fulfill({ json: { users, posts: {}, requests: {}, comments: {}, stories: {} } }); return;
        }
        if (request.method() !== 'GET') { await route.fulfill({ status: 201, body: '' }); return; }
        const rows = url.pathname.endsWith('/entitlements')
          ? [{ uid, tier, status: 'active', current_period_end: '2099-01-01T00:00:00Z' }]
          : url.pathname.endsWith('/accounts') ? [{ uid, data: state }] : [];
        await route.fulfill({ json: rows }); return;
      }
      if (!publicAsset(url.pathname)) { await route.fulfill({ status: 404, body: '' }); return; }
      await route.continue();
    } catch (error) {
      if (!/closed|Target page/i.test(error.message)) throw error;
    }
  });
  await context.addInitScript(seed => {
    localStorage.setItem('fm_dl_x', '1');
    localStorage.setItem('fm_tier', seed.tier);
    if (!seed.signedIn) return;
    localStorage.setItem('formora_supa_session', JSON.stringify({ uid: seed.uid, email: seed.state.profile.email,
      access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600 }));
    localStorage.setItem('gymcoach_auth', JSON.stringify({ accounts: [{ id: 'theme-local', email: seed.state.profile.email,
      name: seed.state.profile.name, provider: 'supabase', emailVerified: true }], currentUserId: 'theme-local' }));
    localStorage.setItem('gymcoach_v1_theme-local', JSON.stringify(seed.state));
  }, { uid, tier, state, signedIn });
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  page.setDefaultNavigationTimeout(timeout);
  page.on('pageerror', error => record.pageErrors.push(error.message));
  testContext.after(async () => {
    await context.close();
    if (record.pageErrors.length) record.result = 'failed';
    assert.deepEqual(record.pageErrors, [], 'No uncaught application errors');
  });
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.locator(signedIn ? '#app-shell:not(.hidden)' : '#auth-card').waitFor();
  await page.locator('#launch').waitFor({ state: 'detached' });
  if (withPeer) await page.waitForFunction(() => Social.cloud.users.length === 1);
  await page.evaluate(tier => document.documentElement.setAttribute('data-tier', tier), tier);
  await steady(page);
  return { page, record };
}

async function steady(page) {
  await page.evaluate(() => document.getAnimations().forEach(animation => {
    if (animation.effect?.getComputedTiming().iterations !== Infinity) animation.finish();
  }));
}

function probe(name, options, run) {
  test(name, { timeout: 90000 }, async testContext => {
    const fixture = await openApp(testContext, options);
    try {
      await run(fixture.page, fixture.record);
      fixture.record.result = 'passed';
    } catch (error) {
      fixture.record.result = 'failed';
      fixture.record.error = error.message;
      throw error;
    }
  });
}

async function capture(page, record, suffix) {
  const filename = record.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '-' + suffix + '.png';
  const image = await page.screenshot({ path: path.join(directory, filename), fullPage: true, animations: 'disabled' });
  const pixels = await page.evaluate(async encoded => {
    const image = new Image();
    image.src = 'data:image/png;base64,' + encoded;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 128;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, 128, 128);
    const data = context.getImageData(0, 0, 128, 128).data;
    const colors = new Set();
    for (let offset = 0; offset < data.length; offset += 4) colors.add(data.slice(offset, offset + 4).join(','));
    return { width: image.naturalWidth, height: image.naturalHeight, distinctColors: colors.size };
  }, image.toString('base64'));
  record.screenshots.push({ path: filename, sha256: sha256(image), ...pixels });
  assert.ok(pixels.width >= 320 && pixels.height >= 640 && pixels.distinctColors > 32, 'Screenshot must contain rendered content');
}

function contrastInPage(element, role = 'text') {
  const style = getComputedStyle(element);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const rgba = color => {
    if (!CSS.supports('color', color)) throw new Error('Unsupported computed color: ' + color);
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
  };
  const composite = (foreground, background) => {
    const frontAlpha = foreground[3] / 255, backAlpha = background[3] / 255;
    const alpha = frontAlpha + backAlpha * (1 - frontAlpha);
    return foreground.slice(0, 3).map((channel, index) => alpha
      ? (channel * frontAlpha + background[index] * backAlpha * (1 - frontAlpha)) / alpha : 0).concat(alpha * 255);
  };
  const luminance = color => color.slice(0, 3).map(channel => channel / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const layers = [];
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const parentStyle = getComputedStyle(parent);
    layers.push({ background: rgba(parentStyle.backgroundColor), opacity: Number(parentStyle.opacity) });
  }
  const paint = color => {
    let painted = color.slice();
    painted[3] *= Number(style.opacity);
    for (const layer of layers) {
      painted = composite(painted, layer.background);
      painted[3] *= layer.opacity;
    }
    return composite(painted, [255, 255, 255, 255]);
  };
  const stops = style.backgroundImage === 'none' ? [style.backgroundColor]
    : style.backgroundImage.match(/(?:rgba?|hsla?|color)\([^)]*\)|#[\da-f]{3,8}\b/gi);
  if (!stops?.length) throw new Error('No resolved gradient stops: ' + style.backgroundImage);
  const foreground = rgba(style.color);
  const painted = stops.map(stop => {
    const background = composite(rgba(stop), rgba(style.backgroundColor));
    const ink = paint(composite(foreground, background)), paper = paint(background);
    const inkLuminance = luminance(ink), paperLuminance = luminance(paper);
    return { foreground: ink, background: paper,
      ratio: (Math.max(inkLuminance, paperLuminance) + 0.05) / (Math.min(inkLuminance, paperLuminance) + 0.05) };
  });
  const ratios = painted.map(sample => sample.ratio);
  const fontSize = parseFloat(style.fontSize);
  const fontWeight = parseInt(style.fontWeight, 10);
  return { text: element.textContent.trim(), color: style.color, foreground, background: style.backgroundImage,
    stops, ratios, painted, opacity: Number(style.opacity), fontSize, fontWeight, fontFamily: style.fontFamily,
    role, opaqueBackground: stops.every(stop => rgba(stop)[3] === 255),
    ancestorOpacity: layers.reduce((opacity, layer) => opacity * layer.opacity, 1),
    threshold: role === 'icon' || fontSize >= 24 || fontWeight >= 700 && fontSize >= 14 * 96 / 72 ? 3 : 4.5,
    disabled: element.matches(':disabled,[aria-disabled="true"]') };
}

async function renderMediaSurfaceInPage(surface) {
  const canvas = document.createElement('canvas');
  canvas.width = 360;
  canvas.height = 480;
  const context = canvas.getContext('2d');
  context.fillStyle = '#356859';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#dde7ef';
  context.fillRect(24, 80, 312, 320);
  context.fillStyle = '#17372e';
  context.font = 'bold 22px sans-serif';
  context.fillText('LOCAL FIXTURE', 48, 128);
  context.fillRect(48, 160, 100, 180);
  context.fillStyle = '#b04a65';
  context.fillRect(172, 160, 140, 180);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Local fixture PNG encoding failed');
  if (surface === 'story') {
    Social.onStoryFile({ target: { files: [new File([blob], 'contrast-fixture.png', { type: 'image/png' })] } });
  } else {
    await CameraLoader.ensure();
    Camera.target = 'post';
    Camera.buildUI();
    Camera.openEditor(blob, false);
  }
  const image = document.querySelector(surface === 'story' ? '#story-preview img.sv-media' : '#cam-edit-media');
  await image.decode();
  const bounds = image.getBoundingClientRect();
  return { naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
    width: bounds.width, height: bounds.height, protocol: new URL(image.currentSrc).protocol };
}

for (const tier of ['free', 'pro', 'elite']) {
  probe('DEF041 accent surfaces ' + tier, { tier, signedIn: true, withPeer: true }, async (page, record) => {
    const surfaces = [
      { id: 'story-plus', selector: '#view-feed .sr-plus', role: 'icon',
        open: () => page.evaluate(() => App.selectTab('home')) },
      { id: 'follow', selector: '#view-feed .btn.sm.follow', role: 'text',
        open: () => page.evaluate(() => App.selectTab('search')) },
      { id: 'meal-add', selector: '#view-nutrition .mi-add', role: 'icon',
        open: () => page.evaluate(() => App.goTab('nutrition')) },
      { id: 'send-message', selector: '#view-feed .send-ico', role: 'icon',
        open: () => page.evaluate(async () => { await Social.openDM('a11y-0000-4000-8000-000000000002'); }), close: () => page.evaluate(() => App.selectTab('home')) },
      { id: 'story-share', selector: '#story-preview .sp-share', role: 'text',
        open: () => page.evaluate(renderMediaSurfaceInPage, 'story'), close: () => page.evaluate(() => Social.cancelStory()) },
      { id: 'camera-share', selector: '#camera-ov .cam-share', role: 'text',
        open: () => page.evaluate(renderMediaSurfaceInPage, 'camera'), close: () => page.evaluate(() => Camera.close()) },
    ];
    for (const surface of surfaces) {
      const media = await surface.open();
      if (media) {
        record.observations.push({ surface: surface.id, media });
        assert.equal(media.protocol, 'blob:');
        assert.equal(media.naturalWidth, 360);
        assert.equal(media.naturalHeight, 480);
        assert.ok(media.width > 0 && media.height > 0, 'The real editor must display the local image');
      }
      const target = page.locator(surface.selector).first();
      await target.waitFor({ state: 'visible' });
      await target.evaluate((element, surface) => {
        element.dataset.contrastSurface = surface;
        element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      }, surface.id);
      for (const state of ['normal', 'hover', 'focus']) {
        await page.mouse.move(0, 0);
        await target.evaluate(element => (element.closest('button') || element).blur());
        if (state === 'hover') await target.hover();
        if (state === 'focus') await target.evaluate(element => (element.closest('button') || element).focus());
        await steady(page);
        const interaction = await target.evaluate(element => ({ hovered: element.matches(':hover'),
          focused: (element.closest('button') || element) === document.activeElement }));
        if (state === 'hover') assert.equal(interaction.hovered, true);
        if (state === 'focus') assert.equal(interaction.focused, true);
        const observed = await target.evaluate(contrastInPage, surface.role);
        record.observations.push({ surface: surface.id, selector: surface.selector, state, interaction, ...observed });
        assert.equal(observed.disabled, false);
        assert.match(observed.background, /^linear-gradient\(/);
        assert.equal(observed.stops.length, 2);
        assert.equal(observed.opaqueBackground, true, 'Use the actual opaque control gradient, not an averaged page background');
        assert.equal(observed.opacity * observed.ancestorOpacity, 1);
        assert.equal(observed.threshold, surface.role === 'icon' ? 3 : 4.5);
        assert.ok(observed.ratios.every(ratio => ratio >= observed.threshold), JSON.stringify({ surface: surface.id, state, ...observed }));
      }
      await capture(page, record, surface.id);
      if (surface.close) await surface.close();
    }
    assert.ok(sources.get('css/styles.css').length <= cssBudget);
  });
}

for (const tier of ['free', 'pro', 'elite']) {
  probe('DEF041 primary contrast ' + tier, { tier }, async (page, record) => {
    const observed = await page.locator('#auth-card .btn.wide').first().evaluate(contrastInPage);
    record.observations.push(observed);
    await capture(page, record, 'login');
    assert.equal(observed.fontSize, 15);
    assert.equal(observed.fontWeight, 700);
    assert.equal(observed.threshold, 4.5, '15px bold text is not large text');
    assert.equal(observed.stops.length, 2);
    assert.ok(observed.ratios.every(ratio => ratio >= 4.5), JSON.stringify(observed));
    assert.ok(sources.get('css/styles.css').length <= cssBudget, 'Existing CSS byte budget must not increase');
  });

  probe('DEF041 auth copy and button states ' + tier, { tier }, async (page, record) => {
    const failures = [];
    for (const screen of ['login', 'signup', 'forgot', 'reset', 'details']) {
      await page.evaluate(screen => App.showAuth(screen), screen);
      await steady(page);
      const button = page.locator('#auth-card .btn.wide').first();
      assert.ok(await button.isVisible(), screen + ' primary button is rendered');
      for (const state of ['normal', 'hover', 'focus']) {
        if (state === 'hover') await button.hover();
        if (state === 'focus') await button.focus();
        const observed = await button.evaluate(contrastInPage);
        assert.equal(observed.disabled, false, 'The primary action is enabled before its explicit disabled-state check');
        record.observations.push({ screen, state, ...observed });
        if (!observed.disabled && observed.ratios.some(ratio => ratio < observed.threshold)) failures.push({ screen, state, ...observed });
      }
      await button.evaluate(element => { element.disabled = true; });
      const disabled = await button.evaluate(contrastInPage);
      record.observations.push({ screen, state: 'disabled', exempt: true, ...disabled });
      assert.equal(await button.isDisabled(), true);
      assert.equal(disabled.disabled, true);
      await button.evaluate(element => { element.disabled = false; });
      const copy = page.locator('#auth-card .landing-sub,#auth-card .auth-tag,#auth-card .auth-or,#auth-card .auth-switch,'
        + '#auth-card .auth-legal,#auth-card .auth-note,#auth-card .inline-hint,#auth-card .field label');
      const count = await copy.count();
      assert.ok(count >= 2, screen + ' contains actual muted copy');
      for (let index = 0; index < count; index++) {
        const element = copy.nth(index);
        if (!await element.isVisible()) continue;
        const observed = await element.evaluate(contrastInPage);
        record.observations.push({ screen, state: 'copy', ...observed });
        if (observed.ratios.some(ratio => ratio < observed.threshold)) failures.push({ screen, state: 'copy', ...observed });
      }
      const audit = await new AxeBuilder({ page }).include('#auth-card').withRules(['color-contrast']).analyze();
      const violations = audit.violations.map(violation => ({ id: violation.id,
        nodes: violation.nodes.map(node => ({ target: node.target, summary: node.failureSummary,
          data: node.any.map(check => check.data) })) }));
      record.observations.push({ screen, axe: { violations, incomplete: audit.incomplete.map(result => result.id) } });
      if (violations.length) failures.push({ screen, violations });
    }
    await capture(page, record, 'auth-copy');
    assert.deepEqual(failures, [], 'Auth text contrast, including muted copy, must meet its text-size threshold');
  });
}

probe('WCAG color math resolves browser HSL and alpha fixtures', {}, async (page, record) => {
  const fixture = await page.evaluateHandle(() => {
    const button = document.createElement('button');
    button.textContent = 'Color fixture';
    button.style.cssText = 'color:hsl(0 0% 100%);background:linear-gradient(90deg,hsl(0 0% 0%),hsl(0 0% 0%));font:700 15px sans-serif';
    document.getElementById('auth-card').append(button);
    return button;
  });
  const whiteOnBlack = await fixture.evaluate(contrastInPage);
  record.observations.push(whiteOnBlack);
  assert.deepEqual(whiteOnBlack.ratios, [21, 21]);
  await fixture.evaluate(element => { element.style.color = 'hsl(0 0% 0%)'; });
  assert.deepEqual((await fixture.evaluate(contrastInPage)).ratios, [1, 1]);
  await fixture.evaluate(element => { element.style.color = 'hsl(0 0% 100% / .5)'; });
  const alpha = await fixture.evaluate(contrastInPage);
  record.observations.push(alpha);
  assert.ok(alpha.ratios.every(ratio => ratio > 5.2 && ratio < 5.4));
  await fixture.evaluate(element => {
    element.style.color = '#777';
    element.style.background = 'white';
  });
  const nearFail = await fixture.evaluate(contrastInPage);
  assert.ok(nearFail.ratios[0] < 4.5 && nearFail.ratios[0] > 4.47, 'Do not round a failing ratio up to 4.5');
  const nonText = await fixture.evaluate(contrastInPage, 'icon');
  assert.equal(nearFail.threshold, 4.5);
  assert.equal(nonText.threshold, 3, 'An icon uses non-text contrast, not the small-text threshold');
  assert.deepEqual(nonText.ratios, nearFail.ratios, 'Role changes the threshold, never the measured colors');
  await fixture.evaluate(element => element.remove());
});

probe('Fixture boundary denies private files and masks public backend settings', {}, async (page, record) => {
  assert.deepEqual(await page.evaluate(() => ({ backend: SUPABASE_URL, key: SUPABASE_ANON_KEY })),
    { backend: origin, key: 'fixture-public-anon' });
  for (const pathname of ['/office/board.json', '/backups/', '/package.json', '/tests/theme-accessibility.e2e.cjs',
    '/.git/config', '/%2e%2e/package.json', '/js/%2e%2e/package.json', '/js/%5cconfig.js']) {
    const response = await page.request.get(origin + pathname);
    assert.equal(response.status(), 404, pathname + ' must not be a public asset');
  }
  const originals = [...sources.get('js/config.js').toString().matchAll(/window\.(?:SUPABASE_URL|SUPABASE_ANON_KEY)\s*=\s*(["'])(.*?)\1/g)]
    .map(match => match[2]);
  let scripts = 0;
  for (const relative of sources.keys()) {
    if (!relative.startsWith('js/') || !relative.endsWith('.js')) continue;
    const response = await page.request.get(origin + '/' + relative);
    assert.equal(response.status(), 200);
    const body = await response.text();
    for (const original of originals) assert.equal(body.includes(original), false, 'Every served script masks real public backend settings');
    scripts++;
  }
  record.observations.push({ maskedScripts: scripts, deniedPaths: 8, externalTrafficAllowed: 0 });
  assert.ok(scripts >= 10);
  assert.ok((await page.locator('#auth-card').innerText()).length > 100);
});

async function measureTargets(page, selector) {
  const targets = page.locator(selector);
  const count = await targets.count();
  assert.ok(count > 0, 'Required controls exist: ' + selector);
  const controls = [];
  for (let index = 0; index < count; index++) {
    const target = targets.nth(index);
    assert.equal(await target.isVisible(), true, selector);
    await target.scrollIntoViewIfNeeded();
    await target.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
    await steady(page);
    controls.push(await target.evaluate(element => {
      const box = element.getBoundingClientRect();
      const center = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      const points = [center, { x: box.left + 2, y: center.y }, { x: box.right - 2, y: center.y },
        { x: center.x, y: box.top + 2 }, { x: center.x, y: box.bottom - 2 }];
      const interceptors = [];
      const hits = points.map(point => {
        const hit = document.elementFromPoint(point.x, point.y);
        if (!hit || hit !== element && !element.contains(hit)) interceptors.push(hit?.outerHTML.slice(0, 200) || 'outside viewport');
        return !!hit && (hit === element || element.contains(hit));
      });
      const input = element.parentElement.querySelector('input[autocomplete$="password"]');
      const inputStyle = input && getComputedStyle(input);
      const textClearance = input ? box.left - (input.getBoundingClientRect().right
        - parseFloat(inputStyle.paddingRight) - parseFloat(inputStyle.borderRightWidth)) : null;
      return { label: element.getAttribute('aria-label') || element.textContent.trim(),
        width: box.width, height: box.height, hits, interceptors, textClearance };
    }));
  }
  const overlaps = await targets.evaluateAll(elements => {
    const boxes = elements.map(element => element.getBoundingClientRect());
    const pairs = [];
    for (let first = 0; first < boxes.length; first++) {
      for (let second = first + 1; second < boxes.length; second++) {
        if (Math.min(boxes[first].right, boxes[second].right) - Math.max(boxes[first].left, boxes[second].left) > 0.5
          && Math.min(boxes[first].bottom, boxes[second].bottom) - Math.max(boxes[first].top, boxes[second].top) > 0.5) pairs.push([first, second]);
      }
    }
    return pairs;
  });
  controls.forEach((control, index) => { control.overlaps = overlaps.filter(pair => pair.includes(index)); });
  return controls;
}

function assertTargets(controls) {
  assert.deepEqual(controls.filter(control => control.width < 44 || control.height < 44
    || control.hits.some(hit => !hit) || control.overlaps.length || control.textClearance !== null && control.textClearance < 0), [],
  'Every scoped standalone control needs 44px, five reachable hit points, and no password-text intrusion');
}

for (const width of [320, 390, 1366]) {
  probe('DEF042 password targets ' + width, { width }, async (page, record) => {
    const controls = [];
    for (const screen of ['login', 'signup', 'reset']) {
      await page.evaluate(screen => App.showAuth(screen), screen);
      await steady(page);
      const selector = '#auth-card button[onclick^="App.togglePw"]';
      const measured = await measureTargets(page, selector);
      controls.push(...measured);
      record.observations.push({ screen, controls: measured });
      const toggles = page.locator(selector);
      for (let index = 0; index < await toggles.count(); index++) {
        const toggle = toggles.nth(index);
        const input = toggle.locator('..').locator('input');
        await input.fill('Fixture-Only-Password42!');
        await toggle.scrollIntoViewIfNeeded();
        const bounds = await toggle.boundingBox();
        const dispatch = async () => width < 700
          ? page.touchscreen.tap(bounds.x + 2, bounds.y + bounds.height / 2)
          : page.mouse.click(bounds.x + 2, bounds.y + bounds.height / 2);
        await dispatch();
        assert.equal(await input.getAttribute('type'), 'text');
        assert.equal(await toggle.getAttribute('aria-label'), 'Hide password');
        await dispatch();
        assert.equal(await input.getAttribute('type'), 'password');
        assert.equal(await input.inputValue(), 'Fixture-Only-Password42!');
      }
    }
    assert.equal(controls.length, 5, 'Login, signup and reset cover all five password controls');
    await capture(page, record, 'password');
    assertTargets(controls);
  });

  probe('DEF042 Coach and Today targets ' + width, { width, signedIn: true }, async (page, record) => {
    await page.evaluate(() => App.selectTab('coach'));
    await steady(page);
    const chips = await measureTargets(page, '#view-home .ask-chip');
    record.observations.push({ surface: 'coach', controls: chips });
    const firstChip = page.locator('#view-home .ask-chip').first();
    await firstChip.scrollIntoViewIfNeeded();
    const chipBounds = await firstChip.boundingBox();
    if (width < 700) await page.touchscreen.tap(chipBounds.x + 2, chipBounds.y + chipBounds.height / 2);
    else await page.mouse.click(chipBounds.x + 2, chipBounds.y + chipBounds.height / 2);
    assert.ok((await page.locator('#ask-answer').innerText()).length > 50, 'Edge tap produces a real Coach answer');
    await capture(page, record, 'coach');
    await page.evaluate(() => { App.renderCoach('today'); App.startSession('push'); });
    await steady(page);
    const sets = await measureTargets(page, '#view-today .add-set');
    record.observations.push({ surface: 'today', controls: sets });
    const addSet = page.locator('#view-today .add-set').first();
    await addSet.scrollIntoViewIfNeeded();
    const setBounds = await addSet.boundingBox();
    const previous = await page.evaluate(() => App.session.items[0].sets.length);
    if (width < 700) await page.touchscreen.tap(setBounds.x + 2, setBounds.y + setBounds.height / 2);
    else await page.mouse.click(setBounds.x + 2, setBounds.y + setBounds.height / 2);
    assert.equal(await page.evaluate(() => App.session.items[0].sets.length), previous + 1, 'Edge tap adds exactly one set');
    await capture(page, record, 'today');
    assertTargets([...chips, ...sets]);
  });

  for (const tier of ['free', 'pro', 'elite']) {
  probe('DEF043 Profile text enlargement ' + width + ' ' + tier, { width, signedIn: true, tier }, async (page, record) => {
    await page.evaluate(() => App.selectTab('profile'));
    // renderProfile paints a "Loading profile..." placeholder and resolves the real controls asynchronously,
    // so measuring immediately would enlarge an empty view and pass vacuously.
    await page.locator('#view-profile #p-name').waitFor();
    await steady(page);
    const before = await page.locator('#view-profile button').evaluateAll(elements => elements.filter(element => element.checkVisibility())
      .map(element => ({ label: element.textContent.trim(), fontSize: parseFloat(getComputedStyle(element).fontSize),
        height: element.getBoundingClientRect().height, width: element.getBoundingClientRect().width })));
    assert.ok(before.length > 0, 'The Profile screen must render its controls before enlargement is measured');
    await page.evaluate(() => {
      const sizes = [...document.querySelectorAll('#view-profile *')].filter(element => element.checkVisibility())
        .map(element => [element, parseFloat(getComputedStyle(element).fontSize)]);
      sizes.forEach(([element, size]) => element.style.setProperty('font-size', size * 2 + 'px', 'important'));
    });
    const geometry = await page.locator('#view-profile').evaluate(container => {
      const buttons = [...container.querySelectorAll('button')].filter(element => element.checkVisibility()).map(element => {
        const bounds = element.getBoundingClientRect();
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const text = [];
        while (walker.nextNode()) {
          if (!walker.currentNode.textContent.trim()) continue;
          const range = document.createRange();
          range.selectNode(walker.currentNode);
          for (const rect of range.getClientRects()) text.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
        }
        return { label: element.textContent.trim(), fontSize: parseFloat(getComputedStyle(element).fontSize),
          requestedFontSize: parseFloat(element.style.getPropertyValue('font-size')),
          width: bounds.width, height: bounds.height, textRects: text.length,
          horizontalClip: element.scrollWidth > element.clientWidth + 2,
          verticalClip: element.scrollHeight > element.clientHeight + 2,
          escapedText: text.filter(rect => rect.left < bounds.left - 1 || rect.right > bounds.right + 1
            || rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1) };
      });
      return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, buttons };
    });
    record.observations.push({ before, ...geometry });
    await capture(page, record, '200-percent');
    assert.ok(geometry.documentWidth <= width + 1, 'No page-level horizontal scrolling');
    assert.equal(geometry.buttons.length, before.length);
    geometry.buttons.forEach((button, index) => {
      assert.equal(button.requestedFontSize, before[index].fontSize * 2, 'Every explicit pixel font requests exactly 200%');
      assert.ok(Math.abs(button.fontSize - button.requestedFontSize) < 0.01, 'Only computed-font serialization rounding is tolerated');
    });
    assert.deepEqual(geometry.buttons.filter(button => button.textRects && (button.horizontalClip || button.verticalClip || button.escapedText.length)), [],
      'All button labels remain within their growing controls at 200%');
    const iconsBefore = before.filter(button => !button.label);
    const iconsAfter = geometry.buttons.filter(button => !button.label);
    assert.deepEqual(iconsAfter.map(button => [button.width, button.height]), iconsBefore.map(button => [button.width, button.height]),
      'Icon-only fixed-format controls do not resize with text');
  });
  }
}