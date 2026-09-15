'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { chromium } = require('playwright');
const { root, sha256, writeJSON, freshEvidence, snapshot, snapshotSummary, observedChromium } = require('./product-lifecycle-independent.test.cjs');

function registerGeometryAcceptance() {
  const directory = freshEvidence('story-geometry');
  const images = path.join(directory, 'images');
  fs.mkdirSync(images);
  const sourceFile = 'tests/story-independent-review.test.cjs';
  const filename = path.join(root, sourceFile);
  const source = fs.readFileSync(filename, 'utf8');
  const exportAppendix = '\nmodule.exports = { viewerPage, measureFooter, auditGeometry };\n}\n';
  assert.match(source, /\n}\s*$/);
  const executedSource = source.replace(/\n}\s*$/, exportAppendix);
  const registrations = { tests: [], before: [], after: [] };
  const cases = [];
  let currentRecord;
  let sourceBefore;
  let chromiumVersion;
  const executable = process.env.OFFICE_BROWSER_EXECUTABLE || chromium.executablePath();
  const browserExecutableBefore = sha256(fs.readFileSync(executable));
  const namePattern = process.execArgv.find(argument => argument.startsWith('--test-name-pattern='))?.slice('--test-name-pattern='.length)
    || '^(Story footer controls fit|Account transition tears|Story preferences and Story activity report|Desktop hover pauses|Story geometry QA:)';
  const command = 'STORY_REVIEW_BROWSER=1 node --test --test-concurrency=1 --test-timeout=120000 --test-name-pattern='
    + JSON.stringify(namePattern) + ' tests/story-geometry-qa.test.cjs';
  const fixtureModule = new Module(filename, module);
  fixtureModule.filename = filename;
  fixtureModule.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = fixtureModule.require.bind(fixtureModule);
  fixtureModule.require = name => {
    if (name === 'node:test') return {
      test: (title, options, callback) => registrations.tests.push({ title,
        callback: typeof options === 'function' ? options : callback,
        options: typeof options === 'function' ? {} : options }),
      before: callback => registrations.before.push(callback),
      after: callback => registrations.after.push(callback),
    };
    if (name === 'playwright') return { chromium: { launch: async options => {
      const browser = await observedChromium(options, () => currentRecord, async (context, record) => {
        context.on('console', message => {
          if (message.type() === 'error') {
            record.consoleErrors ||= [];
            record.consoleErrors.push({ message: message.text(), url: message.location().url });
          }
        });
        context.on('requestfailed', request => {
          record.failedRequests ||= [];
          record.failedRequests.push({ url: request.url(), type: request.resourceType(), error: request.failure()?.errorText });
        });
        await context.routeWebSocket('**/*', socket => {
          record.websockets ||= [];
          record.websockets.push(socket.url());
          socket.close();
        });
      });
      chromiumVersion = browser.independentVersion;
      return browser;
    } } };
    return originalRequire(name);
  };
  fixtureModule._compile(executedSource, filename);
  const fixture = fixtureModule.exports;
  const selected = registrations.tests.filter(candidate => /^(Story footer controls fit|Account transition tears|Story preferences and Story activity report|Desktop hover pauses)/.test(candidate.title));
  assert.equal(selected.length, 4, 'Select exactly the four existing optional browser probes');
  assert.equal(typeof fixture.viewerPage, 'function', 'Use the existing optional browser fixture');
  writeJSON(path.join(directory, 'invocation.json'), { command, executable: process.execPath, cwd: root,
    execArgv: process.execArgv, argv: process.argv, environment: { STORY_REVIEW_BROWSER: process.env.STORY_REVIEW_BROWSER },
    fixture: sourceFile, sourceSha256: sha256(source), executedSha256: sha256(executedSource), appendedExports: exportAppendix,
    registration: 'Suppress registration in memory, re-register four unchanged existing test callbacks, reuse viewerPage for one additional geometry case',
    originalAssertionsPreserved: true, selectedTests: selected.map(candidate => candidate.title),
    requestedModel: 'GPT-6 Astra (copilot)', verifiedRuntimeModel: null });

  before(async () => {
    sourceBefore = snapshot(directory, 'source-before');
    assert.equal(sourceBefore.files[sourceFile].sha256, sha256(source));
    for (const callback of registrations.before) await callback();
  });
  after(async () => {
    try { for (const callback of registrations.after) await callback(); }
    finally {
      const sourceAfter = snapshot(directory, 'source-after');
      const browserExecutableAfter = sha256(fs.readFileSync(executable));
      const sourceUnchanged = sourceBefore.aggregate === sourceAfter.aggregate && browserExecutableBefore === browserExecutableAfter;
      writeJSON(path.join(directory, 'evidence.json'), { date: '2026-09-07', command, node: process.version,
        playwright: require('playwright/package.json').version, chromium: chromiumVersion, executable,
        browserExecutableBefore, browserExecutableAfter, sourceHashesBefore: snapshotSummary(sourceBefore),
        sourceHashesAfter: snapshotSummary(sourceAfter), sourceUnchanged, cases,
        network: 'One Chromium instance, sequential contexts; original fixture aborts external requests; new media is fulfilled from fresh in-memory PNG/WebM; non-loopback continue forbidden',
        outputDirectory: path.relative(root, directory),
        scope: 'Local component/UX acceptance only; no hosted backend, provider, multi-engine clock, physical-device or enablement approval' });
      console.log('Independent Story evidence: ' + path.relative(root, path.join(directory, 'evidence.json')));
      assert.equal(sourceUnchanged, true, 'Source, executed fixture and installed dependency trees remain unchanged in this window');
    }
  });

  for (const candidate of selected) {
    test(candidate.title, { ...candidate.options, timeout: 45000 }, async testContext => {
      currentRecord = { name: candidate.title, originalCallbackExecuted: true };
      cases.push(currentRecord);
      await candidate.callback(testContext);
      currentRecord.bodyPassed = true;
    });
  }

  test('Story geometry QA: decoded owner/viewer photo/video at four viewports with full bounds and pixel proof', { timeout: 60000 }, async () => {
    currentRecord = { name: 'Decoded media geometry and independent design inspection', measurements: [], problems: [] };
    cases.push(currentRecord);
    const variants = [
      { name: 'viewer-photo', mine: false, kind: 'photo' },
      { name: 'viewer-video', mine: false, kind: 'video' },
      { name: 'owner-photo-large-counts', mine: true, kind: 'photo', viewCount: 123456, likeCount: 98765 },
      { name: 'owner-video-large-counts', mine: true, kind: 'video', viewCount: 123456, likeCount: 98765 },
    ];
    let media;
    for (const [width, height] of [[740, 360], [320, 844], [390, 844], [1280, 844]]) {
      const { page, context, errors } = await fixture.viewerPage(width, height);
      try {
        await page.locator('#launch').waitFor({ state: 'hidden' });
        if (!media) {
          media = await generateMedia(page);
          fs.writeFileSync(path.join(directory, 'fixture-photo.png'), media.photo);
          fs.writeFileSync(path.join(directory, 'fixture-video.webm'), media.video);
          currentRecord.media = { photo: { bytes: media.photo.length, sha256: sha256(media.photo) },
            video: { bytes: media.video.length, sha256: sha256(media.video) },
            provenance: 'Fresh browser canvas PNG and actual MediaRecorder WebM; not a mocked media element or reused screenshot' };
        }
        await context.route('https://story-review-fixture.supabase.co/storage/v1/object/public/media/stories/**', route => {
          const video = route.request().url().endsWith('.webm');
          return route.fulfill({ status: 200, contentType: video ? 'video/webm' : 'image/png', body: video ? media.video : media.photo });
        });
        await page.bringToFront();
        for (const variant of variants) {
          await renderVariant(page, variant);
          await page.waitForFunction(() => Stories._play?.ready && document.getElementById('stories-media-status') === null);
          await page.waitForFunction(() => document.getElementById('stories-pause')?.textContent.trim() === 'Pause');
          await page.locator('#stories-pause').tap();
          await page.waitForFunction(() => document.getElementById('stories-pause')?.textContent.trim() === 'Play');
          const paused = await measure(page);
          const stem = width + 'x' + height + '-' + variant.name;
          const pausedImage = await capture(page, path.join(images, stem + '-play.png'), paused.stage);
          await page.locator('#stories-pause').tap();
          await page.waitForFunction(() => document.getElementById('stories-pause')?.textContent.trim() === 'Pause');
          const playing = await measure(page);
          const playingImage = await capture(page, path.join(images, stem + '-pause.png'), playing.stage);
          const measurement = { viewport: { width, height }, variant, paused, playing, images: { paused: pausedImage, playing: playingImage }, jitter: [] };
          currentRecord.measurements.push(measurement);
          for (const [state, sample] of [['paused', paused], ['playing', playing]]) {
            currentRecord.problems.push(...audit(stem + '-' + state, sample));
            assert.deepEqual(sample.viewport, { width, height }, 'Measure actual CSS viewport, not only the requested dimensions');
          }
          for (const control of paused.controls) {
            const counterpart = playing.controls.find(candidate => candidate.id === control.id);
            assert.ok(counterpart, control.id + ' survives a pause toggle');
            for (const dimension of ['left', 'top', 'width', 'height']) {
              const delta = counterpart[dimension] - control[dimension];
              measurement.jitter.push({ control: control.id, dimension, delta });
              if (delta !== 0) currentRecord.problems.push(stem + ': ' + control.id + ' changes ' + dimension + ' by ' + delta);
            }
          }
          assert.equal(paused.controls.find(control => control.id === 'stories-pause').label, 'Play');
          assert.equal(playing.controls.find(control => control.id === 'stories-pause').label, 'Pause');
          assert.equal(paused.controls.find(control => control.id === 'stories-pause').width, 96);
          assert.ok(paused.media.ready && playing.media.ready, 'Both measured states use decoded media');
          await page.evaluate(() => Stories.close(false));
        }
        assert.deepEqual(errors, [], 'No uncaught application error in the expanded geometry probe');
      } finally { await context.close(); }
    }
    writeJSON(path.join(directory, 'geometry.json'), { measurements: currentRecord.measurements, problems: currentRecord.problems });
    assert.deepEqual(currentRecord.problems, [], 'No overlap, out-of-view controls, clipped text, undersized targets or Play/Pause jitter');
    currentRecord.bodyPassed = true;
  });

  test('Story geometry QA discriminator: viewer header paints above the undismissed install banner', { timeout: 30000 }, async () => {
    currentRecord = { name: 'Install-banner paint overlap discriminator', reproductionExecuted: true };
    cases.push(currentRecord);
    const { page, context, errors } = await fixture.viewerPage(740, 360);
    try {
      await page.locator('#launch').waitFor({ state: 'hidden' });
      const media = await generateMedia(page);
      await context.route('https://story-review-fixture.supabase.co/storage/v1/object/public/media/stories/**', route =>
        route.fulfill({ status: 200, contentType: 'image/png', body: media.photo }));
      const open = async () => {
        await renderVariant(page, { mine: false, kind: 'photo' });
        await page.waitForFunction(() => Stories._play?.ready && document.getElementById('stories-media-status') === null);
        await page.locator('#stories-pause').tap();
        await page.waitForFunction(() => document.getElementById('stories-pause')?.textContent.trim() === 'Play');
      };
      const inspect = () => page.evaluate(() => {
        const box = element => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
        };
        const banner = document.getElementById('dl-banner');
        const viewer = document.getElementById('story-viewer');
        const bannerBox = box(banner);
        const header = box(document.getElementById('stories-header'));
        const close = box(document.getElementById('stories-close'));
        const bannerAbove = Number(getComputedStyle(banner).zIndex) > Number(getComputedStyle(viewer).zIndex);
        const overlap = target => Number(bannerAbove) * Math.max(0, Math.min(bannerBox.right, target.right) - Math.max(bannerBox.left, target.left))
          * Math.max(0, Math.min(bannerBox.bottom, target.bottom) - Math.max(bannerBox.top, target.top));
        return { banner: { ...bannerBox, hidden: banner.hidden, inert: banner.inert, ariaHidden: banner.getAttribute('aria-hidden'),
          zIndex: Number(getComputedStyle(banner).zIndex) }, viewerZIndex: Number(getComputedStyle(viewer).zIndex), header, close,
          headerCoveredPixels: overlap(header), closeCoveredPixels: overlap(close),
          closeCoveredFraction: overlap(close) / (close.width * close.height), dismissedStorage: localStorage.getItem('fm_dl_x') };
      });
      await open();
      currentRecord.beforeDismiss = await inspect();
      const beforeGeometry = await measure(page);
      currentRecord.beforeImage = await capture(page, path.join(images, '740x360-banner-present.png'), beforeGeometry.stage);
      assert.equal(currentRecord.beforeDismiss.banner.hidden, false);
      assert.equal(currentRecord.beforeDismiss.banner.inert, true);
      assert.equal(currentRecord.beforeDismiss.banner.ariaHidden, 'true');
      assert.ok(currentRecord.beforeDismiss.banner.zIndex < currentRecord.beforeDismiss.viewerZIndex);
      assert.equal(currentRecord.beforeDismiss.headerCoveredPixels, 0);
      assert.equal(currentRecord.beforeDismiss.closeCoveredPixels, 0);
      await page.evaluate(() => { document.getElementById('dl-banner').style.zIndex = '9999'; });
      currentRecord.oldStackingControl = await inspect();
      currentRecord.oldStackingImage = await capture(page, path.join(images, '740x360-old-banner-stacking.png'), beforeGeometry.stage);
      assert.ok(currentRecord.oldStackingControl.closeCoveredFraction > 0.5, 'Old stacking visibly covers over half of Close');
      assert.deepEqual(currentRecord.oldStackingControl.header, currentRecord.beforeDismiss.header);
      assert.deepEqual(currentRecord.oldStackingControl.close, currentRecord.beforeDismiss.close);
      await page.evaluate(() => { document.getElementById('dl-banner').style.removeProperty('z-index'); });
      await page.locator('#stories-close').tap();
      await page.locator('#story-viewer').waitFor({ state: 'detached' });
      assert.equal(await page.locator('#dl-banner').evaluate(element => element.inert), false);
      await page.locator('#dl-x').click();
      assert.equal(await page.evaluate(() => localStorage.getItem('fm_dl_x')), '1');
      await open();
      currentRecord.afterDismiss = await inspect();
      const afterGeometry = await measure(page);
      currentRecord.afterImage = await capture(page, path.join(images, '740x360-banner-dismissed.png'), afterGeometry.stage);
      assert.equal(currentRecord.afterDismiss.banner.hidden, true);
      assert.equal(currentRecord.afterDismiss.headerCoveredPixels, 0);
      assert.equal(currentRecord.afterDismiss.closeCoveredPixels, 0);
      assert.deepEqual(currentRecord.beforeDismiss.header, currentRecord.afterDismiss.header);
      assert.deepEqual(currentRecord.beforeDismiss.close, currentRecord.afterDismiss.close);
      assert.deepEqual(errors, []);
      currentRecord.result = 'accepted_local';
      currentRecord.bodyPassed = true;
      currentRecord.scope = 'Local stacking and Close/dismissal acceptance with an in-memory old-z-index omission control; no hosted, cross-engine or device approval.';
      writeJSON(path.join(directory, 'banner-discriminator.json'), currentRecord);
    } finally { await context.close(); }
  });
}

async function generateMedia(page) {
  const encoded = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 480;
    const context = canvas.getContext('2d');
    const paint = position => {
      context.fillStyle = '#15b9c6'; context.fillRect(0, 0, 320, 480);
      context.fillStyle = '#df3d40'; context.fillRect(0, 0, 160, 240);
      context.fillStyle = '#40ad68'; context.fillRect(160, 240, 160, 240);
      context.fillStyle = '#fff'; context.fillRect(position, 80, 24, 320);
      context.fillStyle = '#111'; context.font = 'bold 24px sans-serif'; context.fillText('QA MEDIA', 36, 42);
    };
    paint(128);
    const photo = canvas.toDataURL('image/png').split(',')[1];
    const stream = canvas.captureStream(20);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks = [];
    recorder.addEventListener('dataavailable', event => { if (event.data.size) chunks.push(event.data); });
    const stopped = new Promise(resolve => recorder.addEventListener('stop', resolve, { once: true }));
    recorder.start();
    try {
      for (let frame = 0; frame < 36; frame++) {
        paint(24 + frame * 6);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      recorder.stop();
      await stopped;
      const blob = new Blob(chunks, { type: 'video/webm' });
      const video = await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.readAsDataURL(blob);
      });
      return { photo, video };
    } finally { for (const track of stream.getTracks()) track.stop(); }
  });
  return { photo: Buffer.from(encoded.photo, 'base64'), video: Buffer.from(encoded.video, 'base64') };
}

async function renderVariant(page, variant) {
  return page.evaluate(variant => {
    const owner = '11111111-1111-4111-8111-111111111111';
    const author = variant.mine ? owner : '22222222-2222-4222-8222-222222222222';
    const row = Object.freeze({ id: '33333333-3333-4333-8333-333333333333', author, kind: variant.kind,
      audience: 'authenticated', photo: 'https://story-review-fixture.supabase.co/storage/v1/object/public/media/stories/' + author + '/fresh.' + (variant.kind === 'video' ? 'webm' : 'png'),
      ts: Date.now(), expires_at: new Date(Date.now() + 3600000).toISOString(), mine: variant.mine,
      seen: true, liked: false, view_count: variant.mine ? variant.viewCount : null, like_count: variant.mine ? variant.likeCount : null });
    Stories.close(false);
    const scope = Stories._scope();
    Stories._mount();
    Stories._ids = [row.id]; Stories._index = 0;
    Stories._render(row, scope, ++Stories._revision);
  }, variant);
}

async function measure(page) {
  return page.evaluate(() => {
    const rect = element => {
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    };
    const root = document.getElementById('story-viewer');
    const card = root.querySelector('.sv-card');
    const footer = document.getElementById('stories-footer');
    const stage = document.getElementById('stories-stage');
    const media = document.getElementById('stories-media');
    const controls = [...root.querySelectorAll('button,textarea')].map(control => {
      const box = rect(control);
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { id: control.id, ...box, label: control.textContent.trim(), ariaLabel: control.getAttribute('aria-label'),
        disabled: control.disabled, hit: hit?.id || hit?.tagName || null, hitInside: control === hit || control.contains(hit),
        clientWidth: control.clientWidth, scrollWidth: control.scrollWidth, clientHeight: control.clientHeight, scrollHeight: control.scrollHeight,
        inFooter: footer.contains(control), textFits: control.scrollWidth <= control.clientWidth + 1 && control.scrollHeight <= control.clientHeight + 1 };
    });
    return { viewport: { width: innerWidth, height: innerHeight }, root: rect(root), card: rect(card),
      header: rect(document.getElementById('stories-header')), stage: rect(stage), footer: rect(footer), controls,
      rootOverflow: root.scrollWidth > innerWidth + 1 || root.scrollHeight > innerHeight + 1,
      footerOverflow: footer.scrollWidth > footer.clientWidth + 1 || footer.scrollHeight > footer.clientHeight + 1,
      counts: document.getElementById('stories-counts') ? { text: document.getElementById('stories-counts').textContent,
        ...rect(document.getElementById('stories-counts')) } : null,
      media: { kind: media.tagName, ready: Stories._play.ready, naturalWidth: media.naturalWidth || media.videoWidth,
        naturalHeight: media.naturalHeight || media.videoHeight, readyState: media.readyState ?? null,
        duration: Number.isFinite(media.duration) ? media.duration : null, currentTime: media.currentTime ?? null,
        paused: media.paused ?? null, visible: getComputedStyle(media).visibility, ...rect(media) } };
  });
}

function audit(label, sample) {
  const problems = [];
  const escapes = (inner, outer) => inner.left < outer.left - 0.5 || inner.top < outer.top - 0.5 || inner.right > outer.right + 0.5 || inner.bottom > outer.bottom + 0.5;
  const overlap = (left, right) => Math.min(left.right, right.right) - Math.max(left.left, right.left) > 0.5
    && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 0.5;
  const viewport = { left: 0, top: 0, right: sample.viewport.width, bottom: sample.viewport.height };
  for (const key of ['card', 'header', 'stage', 'footer']) if (escapes(sample[key], viewport)) problems.push(label + ': ' + key + ' outside viewport');
  if (sample.rootOverflow || sample.footerOverflow) problems.push(label + ': viewer or footer overflows');
  if (sample.stage.height < 64) problems.push(label + ': media stage is too short for its navigation targets');
  if (overlap(sample.header, sample.stage) || overlap(sample.stage, sample.footer) || overlap(sample.header, sample.footer)) problems.push(label + ': header/media/footer overlap');
  for (const control of sample.controls) {
    if (control.width < 44 || control.height < 44) problems.push(label + ': ' + control.id + ' target below 44px');
    if (escapes(control, sample.card) || escapes(control, viewport)) problems.push(label + ': ' + control.id + ' out of view');
    if (control.inFooter && escapes(control, sample.footer)) problems.push(label + ': ' + control.id + ' escapes footer');
    if (!control.textFits) problems.push(label + ': ' + control.id + ' text clipped');
    if (!control.disabled && !control.hitInside) problems.push(label + ': ' + control.id + ' center is obstructed');
    if (sample.counts && overlap(control, sample.counts)) problems.push(label + ': ' + control.id + ' overlaps count text');
  }
  for (let index = 0; index < sample.controls.length; index++) for (const other of sample.controls.slice(index + 1)) {
    if (overlap(sample.controls[index], other)) problems.push(label + ': controls overlap: ' + sample.controls[index].id + ', ' + other.id);
  }
  return problems;
}

async function capture(page, filename, stage) {
  const image = await page.screenshot({ path: filename, animations: 'disabled' });
  const pixels = await page.evaluate(async ({ encoded, stage }) => {
    const image = new Image();
    image.src = 'data:image/png;base64,' + encoded;
    await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const left = Math.max(0, Math.ceil(stage.left)); const top = Math.max(0, Math.ceil(stage.top));
    const width = Math.min(Math.floor(stage.width), canvas.width - left); const height = Math.min(Math.floor(stage.height), canvas.height - top);
    const values = context.getImageData(left, top, width, height).data;
    let red = 0; let cyan = 0; let green = 0;
    for (let offset = 0; offset < values.length; offset += 4) {
      const [redValue, greenValue, blueValue] = values.subarray(offset, offset + 3);
      if (redValue > 170 && greenValue < 110 && blueValue < 120) red++;
      if (redValue < 100 && greenValue > 130 && blueValue > 140) cyan++;
      if (redValue < 120 && greenValue > 130 && blueValue < 150) green++;
    }
    return { width: image.naturalWidth, height: image.naturalHeight, sampledMediaPixels: width * height, red, cyan, green };
  }, { encoded: image.toString('base64'), stage });
  writeJSON(filename + '.pixels.json', { stage, pixels, imageSha256: sha256(image) });
  assert.ok(pixels.red > 50 && pixels.cyan > 50 && pixels.green > 50, 'Actual screenshot contains all three decoded media color regions');
  return { path: path.relative(root, filename), sha256: sha256(image), bytes: image.length, pixels };
}

if (process.env.STORY_REVIEW_BROWSER === '1' && require.main === module) registerGeometryAcceptance();