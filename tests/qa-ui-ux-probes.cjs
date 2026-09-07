'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AxeBuilder = require('@axe-core/playwright').default;

module.exports = ({ test, after, openApp, browserName, root }) => {
  const directory = path.resolve(root, process.env.FORMORA_QA_UX_OUTPUT || 'dist/qa-2026-09-06/ui-' + browserName);
  const results = [];
  fs.mkdirSync(directory, { recursive: true });
  after(() => fs.writeFileSync(path.join(directory, 'findings.json'), JSON.stringify({
    observedAt: new Date().toISOString(), browser: browserName,
    scope: 'Local rendered UI with fixture accounts and all external traffic intercepted; not physical-device or hosted acceptance',
    results
  }, null, 2) + '\n'));

  function probe(name, viewport, run) {
    test('QA UI: ' + name, { timeout: 90000 }, async testContext => {
      const record = { name, viewport, failures: [], screenshots: [], observations: {}, result: 'incomplete' };
      results.push(record);
      const check = (condition, expected, actual) => { if (!condition) record.failures.push({ expected, actual }); };
      try {
        const fixture = await openApp(testContext, { ...viewport, touch: viewport.width < 700 });
        assert.ok(fixture.readiness.ready, 'The real app fixture must be ready before UI assertions');
        await run(fixture.page, record, check);
        record.consoleErrors = fixture.pageErrors;
        check(fixture.pageErrors.length === 0, 'No uncaught application errors', fixture.pageErrors);
        record.result = record.failures.length ? 'failed' : 'passed';
        assert.deepEqual(record.failures, [], name);
      } catch (error) {
        if (record.result === 'incomplete') record.result = 'blocked';
        record.error = error.message;
        throw error;
      }
    });
  }

  async function capture(page, record, suffix) {
    const filename = record.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '-' + suffix + '.png';
    await page.screenshot({ path: path.join(directory, filename), fullPage: true, animations: 'disabled' });
    record.screenshots.push(path.relative(root, path.join(directory, filename)));
  }

  async function steady(page) {
    await page.evaluate(() => document.getAnimations().forEach(animation => {
      if (animation.effect?.getComputedTiming().iterations !== Infinity) {
        try { animation.finish(); } catch (_) {}
      }
    }));
  }

  async function signedOut(page) {
    await page.evaluate(() => App.logout());
    await page.waitForFunction(() => !SupaAuth.uid() && !Auth.currentUser());
    await page.locator('#auth-overlay:not(.hidden) #a-email').waitFor();
  }

  for (const viewport of [{ width: 320, height: 640 }, { width: 390, height: 844 }, { width: 1366, height: 900 }]) {
    for (const kind of ['pricing', 'support']) {
      probe(`${kind} modal keyboard and semantics ${viewport.width}`, viewport, async (page, record, check) => {
        await page.evaluate(() => App.selectTab('profile'));
        const opener = page.locator('#view-profile button[onclick="App.openSupport()"]').last();
        await opener.focus();
        if (kind === 'support') await opener.click();
        else await page.evaluate(() => App.openPricing());
        await steady(page);
        const modal = page.locator('#modal');
        await modal.locator('#modal-card').waitFor({ state: 'visible' });
        const initial = await modal.evaluate(element => ({ role: element.getAttribute('role'), ariaModal: element.getAttribute('aria-modal'),
          focusInside: element.contains(document.activeElement), active: document.activeElement?.outerHTML.slice(0, 180),
          appInert: document.getElementById('app-shell').inert }));
        record.observations.initial = initial;
        check(initial.role === 'dialog' && initial.ariaModal === 'true', 'Modal exposes dialog semantics', initial);
        check(initial.focusInside, 'Focus moves into the opened modal', initial.active);
        const close = modal.locator('.modal-head button[onclick="App.closeModal()"]').first();
        await close.focus();
        await page.keyboard.press('Shift+Tab');
        check(await modal.evaluate(element => element.contains(document.activeElement)), 'Shift+Tab stays within the modal', await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 180)));
        await capture(page, record, 'open');
        await page.keyboard.press('Escape');
        check(await modal.isHidden(), 'Escape closes the modal', 'Modal visible: ' + await modal.isVisible());
        if (await modal.isVisible()) await close.click();
        check(await opener.evaluate(element => element === document.activeElement), 'Closing returns focus to the opener', await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 180)));
      });
    }
  }

  probe('form labels and accessibility scan', { width: 390, height: 844 }, async (page, record, check) => {
    const screens = [
      { name: 'profile', root: '#view-profile', action: () => App.selectTab('profile'), ready: '#view-profile #p-name' },
      { name: 'support', root: '#modal-card', action: () => App.openSupport() },
      { name: 'login', root: '#auth-card', action: () => { App.closeModal(); App.showAuth('login'); } },
      { name: 'signup', root: '#auth-card', action: () => App.showAuth('signup') },
      { name: 'onboarding', root: '#auth-card', action: () => App.showAuth('details') }
    ];
    record.observations.screens = [];
    for (const screen of screens) {
      await page.evaluate(screen.action);
      if (screen.ready) await page.locator(screen.ready).waitFor();
      await steady(page);
      const controls = await page.locator(screen.root).evaluate(element => [...element.querySelectorAll('input:not([type=hidden]):not([type=file]),select,textarea')]
        .filter(control => control.checkVisibility()).length);
      const missing = await page.locator(screen.root).evaluate(element => [...element.querySelectorAll('input:not([type=hidden]):not([type=file]),select,textarea')]
        .filter(control => control.checkVisibility() && !control.labels?.length && !control.getAttribute('aria-label') && !control.getAttribute('aria-labelledby'))
        .map(control => ({ id: control.id, placeholder: control.placeholder || '', nearbyLabel: control.closest('.field')?.querySelector('label')?.textContent || '' })));
      const axe = await new AxeBuilder({ page }).include(screen.root).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      const violations = axe.violations.map(violation => ({ id: violation.id, impact: violation.impact, description: violation.description,
        helpUrl: violation.helpUrl, nodes: violation.nodes.map(node => ({ target: node.target, summary: node.failureSummary })) }));
      record.observations.screens.push({ name: screen.name, controls, missing, violations, incompleteRuleIds: axe.incomplete.map(item => item.id), passedRules: axe.passes.length });
      check(controls > 0, screen.name + ': the screen rendered form controls to check', controls);
      check(!missing.length, screen.name + ': visible fields have associated accessible labels', missing);
      check(!violations.length, screen.name + ': automated WCAG checks have no violations', violations);
      await capture(page, record, screen.name);
    }
  });

  for (const tier of ['free', 'pro', 'elite']) {
    probe('primary text contrast ' + tier, { width: 390, height: 844 }, async (page, record, check) => {
      await page.evaluate(tier => { App.showAuth('login'); document.documentElement.setAttribute('data-tier', tier); }, tier);
      const contrast = await page.locator('#auth-card .btn.wide').first().evaluate(element => {
        const style = getComputedStyle(element);
        const rgb = text => (text.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        const luminance = color => rgb(color).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
          .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
        const foreground = luminance(style.color);
        const stops = style.backgroundImage.match(/rgba?\([^)]+\)/g) || [style.backgroundColor];
        const ratios = stops.map(color => { const background = luminance(color); return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05); });
        const fontSize = parseFloat(style.fontSize), bold = parseInt(style.fontWeight) >= 700;
        return { label: element.textContent.trim(), color: style.color, background: style.backgroundImage, stops, ratios,
          fontSize, fontWeight: style.fontWeight, threshold: fontSize >= 24 || bold && fontSize >= 18.667 ? 3 : 4.5 };
      });
      record.observations.contrast = contrast;
      check(contrast.ratios.every(ratio => ratio >= contrast.threshold), 'Primary text meets the applicable contrast threshold at every gradient stop', contrast);
      await capture(page, record, tier);
    });
  }

  probe('auth coach and workout touch controls', { width: 320, height: 640 }, async (page, record, check) => {
    record.observations.controls = [];
    for (const surface of ['coach', 'workout', 'login']) {
      await page.evaluate(surface => {
        if (surface === 'coach') App.selectTab('coach');
        if (surface === 'workout') { App.renderCoach('today'); App.startSession('push'); }
        if (surface === 'login') { App.closeModal(); App.showAuth('login'); }
      }, surface);
      await steady(page);
      const selectors = { coach: '#view-home .ask-chip', workout: '.add-set', login: '#auth-card button[onclick*="togglePw"]' };
      const controls = await page.locator(selectors[surface]).evaluateAll(elements => elements.filter(element => element.checkVisibility()).map(element => {
        const box = element.getBoundingClientRect();
        return { label: element.getAttribute('aria-label') || element.textContent.trim(), width: box.width, height: box.height };
      }));
      record.observations.controls.push({ surface, controls });
      check(controls.length > 0, surface + ': required controls are present', controls);
      check(controls.every(control => control.width >= 44 && control.height >= 44), surface + ': standalone controls meet the product 44px target requirement', controls);
      await capture(page, record, surface);
    }
  });

  for (const width of [320, 390]) {
    probe('200 percent text reflow ' + width, { width, height: 844 }, async (page, record, check) => {
      await page.evaluate(() => App.selectTab('profile'));
      // The Profile view renders asynchronously behind a placeholder; enlarging it early measures nothing.
      await page.locator('#view-profile #p-name').waitFor();
      await page.evaluate(() => {
        const sizes = [...document.querySelectorAll('#view-profile *')].filter(element => element.checkVisibility())
          .map(element => [element, parseFloat(getComputedStyle(element).fontSize)]);
        sizes.forEach(([element, size]) => element.style.setProperty('font-size', size * 2 + 'px', 'important'));
      });
      const geometry = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
        measured: [...document.querySelectorAll('#view-profile input,#view-profile button')].filter(element => element.checkVisibility()).length,
        clipped: [...document.querySelectorAll('#view-profile input,#view-profile button,#view-profile .ph-info,#view-profile .ph-name')]
          .filter(element => element.checkVisibility() && element.scrollWidth > element.clientWidth + 2)
          .map(element => ({ tag: element.tagName, id: element.id, text: element.textContent.trim().slice(0, 80), width: element.clientWidth, contentWidth: element.scrollWidth })) }));
      record.observations.geometry = geometry;
      check(geometry.measured > 0, 'The enlarged Profile screen actually rendered the controls under test', geometry);
      check(geometry.documentWidth <= geometry.viewport + 1, 'Text-only 200% enlargement does not introduce page-level horizontal scrolling', geometry);
      check(!geometry.clipped.filter(item => item.tag === 'BUTTON').length, 'Button text stays readable at 200% text enlargement', geometry.clipped);
      await capture(page, record, 'text-200');
    });
  }

  probe('failed feed read is not an empty account', { width: 390, height: 844 }, async (page, record, check) => {
    let rejectedReads = 0;
    await page.route('**/rest/v1/rpc/get_state', async route => {
      rejectedReads++;
      await route.fulfill({ status: 503, json: { message: 'QA fixture unavailable' } });
    });
    const observed = await page.evaluate(async () => {
      Social.cloud.feed = [];
      const response = await Cloud._get();
      App.selectTab('home');
      Social.render();
      const feed = document.getElementById('view-feed');
      return { readFailed: response === null, text: feed.innerText,
        recoveryControl: [...feed.querySelectorAll('button,[role=alert],[role=status]')].some(element => /retry|could not|unavailable|loading/i.test(element.textContent)) };
    });
    record.observations.feed = { ...observed, rejectedReads };
    assert.ok(rejectedReads > 0 && observed.readFailed, 'The network failure must occur before judging its feedback');
    check(!observed.text.includes('No posts yet') && observed.recoveryControl, 'A failed initial feed read shows recovery feedback instead of claiming an empty account', observed);
    await capture(page, record, 'error');
  });

  probe('runtime metrics and repeated navigation', { width: 1366, height: 900 }, async (page, record, check) => {
    const result = await page.evaluate(() => {
      const started = performance.now();
      const initialNodes = document.getElementsByTagName('*').length;
      for (let iteration = 0; iteration < 20; iteration++) {
        for (const tab of ['home', 'search', 'flex', 'coach', 'alerts', 'profile']) App.selectTab(tab);
        App.openSupport();
        App.closeModal();
      }
      App.selectTab('home');
      const navigation = performance.getEntriesByType('navigation')[0];
      return { navigationActions: 160, durationMs: performance.now() - started, initialNodes,
        finalNodes: document.getElementsByTagName('*').length, modalNodes: document.querySelectorAll('#modal').length,
        visibleModal: !document.getElementById('modal').classList.contains('hidden'),
        firstContentfulPaintMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
        domInteractiveMs: navigation?.domInteractive ?? null, ttfbMs: navigation ? navigation.responseStart - navigation.requestStart : null,
        resourceRequests: performance.getEntriesByType('resource').length,
        heapBytes: performance.memory?.usedJSHeapSize ?? null };
    });
    record.observations.performance = result;
    record.observations.limits = 'Unthrottled local fixture timings, not a mid-tier physical phone, field Core Web Vitals or backend load test.';
    check(result.modalNodes === 1 && !result.visibleModal, 'Repeated navigation leaves exactly one closed modal', result);
    check(result.finalNodes <= result.initialNodes + 500, 'Repeated navigation does not accumulate hundreds of retained DOM nodes', result);
    await capture(page, record, 'after-navigation');
  });

  for (const width of [390, 1366]) {
    probe('conventions browser Back and selected navigation ' + width, { width, height: 900 }, async (page, record, check) => {
      await page.evaluate(() => history.replaceState({ qaSentinel: true }, '', '?qa-entry=1'));
      await page.goto(new URL('/index.html', page.url()).href, { waitUntil: 'domcontentloaded' });
      await page.locator('#app-shell:not(.hidden)').waitFor();
      await page.locator('#tabbar [data-tab="search"]').click();
      await page.locator('#member-search').waitFor();
      await page.locator('#tabbar [data-tab="profile"]').click();
      await page.locator('#p-name').waitFor();
      const selected = await page.locator('#tabbar .tab.active').evaluate(element => ({
        tab: element.dataset.tab, role: element.getAttribute('role'),
        ariaSelected: element.getAttribute('aria-selected'), ariaCurrent: element.getAttribute('aria-current'),
        href: element.getAttribute('href'), url: location.href
      }));
      record.observations.selectedNavigation = selected;
      check(selected.ariaSelected === 'true' || !!selected.ariaCurrent && selected.ariaCurrent !== 'false',
        'The selected navigation item is programmatically identified, not only colored', selected);
      await page.goBack({ waitUntil: 'domcontentloaded' });
      await page.locator('#app-shell:not(.hidden)').waitFor();
      const afterBack = await page.evaluate(() => ({ tab: App.curTab, url: location.href,
        searchVisible: document.getElementById('member-search')?.checkVisibility() || false }));
      record.observations.afterBack = afterBack;
      check(afterBack.tab === 'search' && afterBack.searchVisible,
        'Browser Back returns from Profile to the previously visited Search view', afterBack);
      await capture(page, record, 'after-back');
    });
  }

  probe('conventions Enter submits the login form', { width: 390, height: 844 }, async (page, record, check) => {
    await signedOut(page);
    const requests = [];
    await page.route('**/auth/v1/**', async route => {
      requests.push(new URL(route.request().url()).pathname);
      await route.fulfill({ status: 401, json: { error: 'QA fixture rejection' } });
    });
    await page.evaluate(() => App.showAuth('login'));
    await steady(page);
    await page.locator('#a-email').fill('qa.form@example.test');
    await page.locator('#a-pass').fill('Fixture-Only-Password42!');
    await page.locator('#a-pass').press('Enter');
    const afterEnter = await page.evaluate(() => ({ error: document.getElementById('auth-err').innerText,
      hasForm: !!document.getElementById('a-pass').form }));
    const enterRequestCount = requests.length;
    await capture(page, record, 'after-enter');
    await Promise.all([
      page.waitForResponse(response => response.url().includes('/auth/v1/token')),
      page.locator('#auth-card button[onclick="App.doLogin()"]').click()
    ]);
    await page.waitForFunction(() => document.getElementById('auth-err')?.textContent.trim());
    record.observations.submission = { afterEnter, enterRequestCount, requestsAfterClick: requests.length };
    check(enterRequestCount > 0 || !!afterEnter.error, 'Enter submits the login form or exposes validation just as clicking Log in does', record.observations.submission);
    await capture(page, record, 'after-click-control');
  });

  for (const invalid of [{ name: 'negative height', selector: '#p-h', value: '-1', field: 'heightCm' },
    { name: 'negative goal weight', selector: '#p-tw', value: '-5', field: 'targetWeightKg' },
    { name: 'future date of birth', selector: '#p-dob', value: '2099-01-01', field: 'dob' }]) {
    probe('conventions profile rejects ' + invalid.name, { width: 390, height: 844 }, async (page, record, check) => {
      await page.locator('#tabbar [data-tab="profile"]').click();
      const original = await page.evaluate(field => Store.state.profile[field], invalid.field);
      const dialogs = [];
      page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
      await page.locator(invalid.selector).fill(invalid.value);
      await page.locator('#view-profile button[onclick="App.saveProfile()"]').click();
      const saved = await page.evaluate(field => ({ memory: Store.state.profile[field],
        persisted: JSON.parse(localStorage.getItem(Store.key)).profile[field],
        errors: [...document.querySelectorAll('#view-profile [role=alert],#view-profile [aria-invalid=true]')].map(element => element.textContent) }), invalid.field);
      record.observations.validation = { field: invalid.field, entered: invalid.value, original, saved, dialogs };
      check(saved.memory === original && saved.persisted === original, 'Invalid profile input is rejected before changing the saved fitness profile', record.observations.validation);
      await capture(page, record, 'after-save');
    });
  }

  probe('conventions profile drafts survive leaving or get a warning', { width: 390, height: 844 }, async (page, record, check) => {
    await page.locator('#tabbar [data-tab="profile"]').click();
    const draft = 'Unsaved QA member name';
    const dialogs = [];
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    await page.locator('#p-name').fill(draft);
    await page.locator('#tabbar [data-tab="home"]').click();
    await page.locator('#tabbar [data-tab="profile"]').click();
    const current = await page.locator('#p-name').inputValue();
    record.observations.draft = { entered: draft, afterReturning: current, dialogs,
      confirmationSheet: await page.locator('[role=dialog]').count() };
    check(current === draft || dialogs.length > 0, 'Navigating away preserves unsaved profile input or offers a discard decision', record.observations.draft);
    await capture(page, record, 'returned');
  });

  probe('conventions actionable rows work with keyboard', { width: 1366, height: 900 }, async (page, record, check) => {
    record.observations.rows = [];
    for (const screen of ['alerts', 'home']) {
      await page.locator('#tabbar [data-tab="' + screen + '"]').click();
      const selector = screen === 'alerts' ? '#view-alerts .notif-item' : '#view-feed .post-author';
      await page.locator(selector).first().waitFor();
      const rows = await page.locator(selector).evaluateAll(elements => elements.filter(element => element.checkVisibility()).map(element => ({
        text: element.textContent.trim().slice(0, 90), tag: element.tagName, role: element.getAttribute('role'), tabIndex: element.tabIndex,
        keyboardHandler: !!element.onkeydown || !!element.onkeyup, clickHandler: element.getAttribute('onclick')
      })));
      const first = page.locator(selector).first();
      const focused = await first.evaluate(element => { element.focus(); return document.activeElement === element; });
      record.observations.rows.push({ screen, rows, firstCanReceiveFocus: focused });
      check(rows.every(row => row.tabIndex >= 0 && (['BUTTON', 'A'].includes(row.tag) || row.role === 'button')) && focused,
        screen + ': clickable content is keyboard-focusable and exposes an action role', rows);
      await capture(page, record, screen);
    }
  });

  for (const operation of ['send', 'edit', 'unsend']) {
    probe('conventions rejected message ' + operation + ' preserves retry state', { width: 390, height: 844 }, async (page, record, check) => {
      await page.evaluate(() => Social.openDM(Social.cloud.connections[0]));
      await page.locator('#chat-thread .bubble').first().waitFor();
      assert.equal(await page.locator('#view-feed #chat-thread').count(), 1, 'Retry-control scan must include the actual chat container');
      const previous = await page.evaluate(() => Social._dmMsgs.map(message => ({ ...message })));
      const target = await page.evaluate(() => Social._dmMsgs.find(message => message.from === Cloud.me));
      assert.ok(target, 'The fixture needs an owned message for edit and unsend checks');
      const requests = [];
      await page.route('**/rest/v1/messages*', async route => {
        const method = route.request().method();
        if (method === 'GET') { await route.fallback(); return; }
        requests.push({ method, body: route.request().postDataJSON() });
        await route.fulfill({ status: 503, json: { message: 'QA write rejected' } });
      });
      const response = page.waitForResponse(item => item.url().includes('/rest/v1/messages') && item.status() === 503);
      const draft = 'QA outgoing message content';
      if (operation === 'send') {
        await page.locator('#dm-text').fill(draft);
        await page.locator('.chat-input .send-ico').click();
      } else if (operation === 'edit') {
        await page.evaluate(id => Social.editMsg(id), target.id);
        await page.waitForFunction(text => document.getElementById('dm-edit')?.value === text, target.body);
        await page.locator('#dm-edit').fill(draft);
        await page.locator('.chat-input .send-ico').click();
      } else {
        page.once('dialog', async dialog => dialog.accept());
        await page.evaluate(id => Social.unsendMsg(id), target.id);
      }
      await response;
      const after = await page.evaluate(() => ({ messages: Social._dmMsgs.map(message => ({ ...message })),
        draft: document.getElementById('dm-edit')?.value || document.getElementById('dm-text')?.value || '',
        toast: document.getElementById('toast')?.textContent || '', text: document.getElementById('chat-thread').innerText,
        retryControls: [...document.querySelectorAll('#view-feed button')].filter(button => button.checkVisibility()
          && /retry|resend|send again/i.test(button.getAttribute('aria-label') || button.textContent)).map(button => button.outerHTML) }));
      record.observations.message = { operation, requests, previous, after };
      if (operation === 'send') check(after.draft === draft || after.retryControls.length > 0, 'Rejected send retains a draft or explicitly failed message with retry', after);
      if (operation === 'edit') check(after.draft === draft && after.messages.find(message => message.id === target.id)?.body === target.body,
        'Rejected edit retains original content and editable retry draft', after);
      if (operation === 'unsend') check(after.messages.some(message => message.id === target.id), 'Rejected unsend retains the original message', after);
      check(!/Message edited|Message unsent/.test(after.toast), 'Rejected message mutation does not announce success', after.toast);
      await capture(page, record, operation + '-503');
    });
  }

  probe('conventions rejected post preserves the composer draft', { width: 390, height: 844 }, async (page, record, check) => {
    const requests = [];
    await page.route('**/rest/v1/posts*', async route => {
      if (route.request().method() !== 'POST') { await route.fallback(); return; }
      requests.push(route.request().postDataJSON());
      await route.fulfill({ status: 503, json: { message: 'QA post rejected' } });
    });
    await page.locator('#tabbar [data-tab="home"]').click();
    const draft = 'QA post that must remain retryable';
    await page.locator('#post-text').fill(draft);
    await Promise.all([
      page.waitForResponse(response => response.url().includes('/rest/v1/posts') && response.status() === 503),
      page.locator('button[onclick="Social.publishPost()"]').click()
    ]);
    const observed = await page.evaluate(draft => ({ draft: document.getElementById('post-text')?.value || '',
      localPostVisible: Social.cloud.feed.some(post => post.text === draft), toast: document.getElementById('toast')?.textContent || '' }), draft);
    record.observations.post = { requests, observed };
    check(observed.draft === draft && !observed.localPostVisible && !/Posted to the feed/.test(observed.toast),
      'Rejected post preserves its draft and does not claim server publication', observed);
    await capture(page, record, 'post-503');
  });

  for (const status of [401, 503]) {
    probe('conventions failed login does not create an account ' + status, { width: 390, height: 844 }, async (page, record, check) => {
      await signedOut(page);
      assert.equal(await page.evaluate(() => !!Auth.findByEmail('unregistered.qa@example.test')), false, 'The login attempt must not target a legacy local account');
      const requests = [];
      await page.route('**/auth/v1/**', async route => {
        requests.push({ path: new URL(route.request().url()).pathname, method: route.request().method() });
        await route.fulfill({ status, json: { error: status === 401 ? 'Invalid credentials' : 'Service unavailable' } });
      });
      await page.evaluate(() => App.showAuth('login'));
      await page.locator('#a-email').fill('unregistered.qa@example.test');
      await page.locator('#a-pass').fill('Fixture-Only-Password42!');
      await page.locator('#auth-card button[onclick="App.doLogin()"]').click();
      await page.waitForFunction(() => document.getElementById('auth-err')?.textContent.trim());
      const error = await page.locator('#auth-err').innerText();
      record.observations.authentication = { responseStatus: status, requests, error };
      check(!requests.some(request => request.path.endsWith('/signup')), 'An explicit Log in attempt never silently requests account creation after failure', requests);
      if (status === 503) check(/unavailable|retry|try again|connection|network/i.test(error), 'Service outage feedback does not falsely blame the password', error);
      await capture(page, record, 'login-' + status);
    });
  }

  for (const accepted of [false, true]) {
    probe('conventions reset ' + (accepted ? 'confirmation completes without an exception' : 'cancel leaves logs unchanged'), { width: 390, height: 844 }, async (page, record, check) => {
      await page.locator('#tabbar [data-tab="profile"]').click();
      const previous = await page.evaluate(() => JSON.stringify({ weight: Store.state.weightLog, workouts: Store.state.workoutLog, food: Store.state.foodLog }));
      const dialogs = [];
      page.once('dialog', async dialog => {
        dialogs.push({ type: dialog.type(), message: dialog.message() });
        if (accepted) await dialog.accept();
        else await dialog.dismiss();
      });
      await page.locator('button[onclick="App.resetAll()"]').click();
      const result = await page.evaluate(() => ({ logs: { weight: Store.state.weightLog, workouts: Store.state.workoutLog, food: Store.state.foodLog },
        currentTab: App.curTab, profileInputName: document.getElementById('p-name')?.value,
        profileName: Store.state.profile.name, shellVisible: !document.getElementById('app-shell').classList.contains('hidden') }));
      record.observations.reset = { accepted, dialogs, previous: JSON.parse(previous), after: result };
      check(dialogs.length === 1 && dialogs[0].type === 'confirm', 'Destructive reset requires one explicit confirmation', dialogs);
      if (!accepted) check(JSON.stringify(result.logs) === previous, 'Cancel never mutates saved logs', result.logs);
      else check(!result.shellVisible || result.profileInputName === undefined || result.profileInputName === result.profileName,
        'Confirmed reset refreshes the visible screen consistently with the new state', result);
      await capture(page, record, accepted ? 'confirmed' : 'cancelled');
    });
  }

  probe('conventions valid profile values save successfully', { width: 390, height: 844 }, async (page, record, check) => {
    await page.locator('#tabbar [data-tab="profile"]').click();
    await page.locator('#p-name').fill('QA Valid Profile');
    await page.locator('#p-h').fill('180');
    await page.locator('#p-tw').fill('76');
    await page.locator('#view-profile button[onclick="App.saveProfile()"]').click();
    const saved = await page.evaluate(() => { const profile = JSON.parse(localStorage.getItem(Store.key)).profile;
      return { name: profile.name, height: profile.heightCm, goal: profile.targetWeightKg }; });
    record.observations.saved = saved;
    check(saved.name === 'QA Valid Profile' && saved.height === 180 && saved.goal === 76, 'Valid profile input remains saveable', saved);
    await capture(page, record, 'saved');
  });

  probe('conventions pending login prevents duplicate submission', { width: 390, height: 844 }, async (page, record, check) => {
    await signedOut(page);
    const requests = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/auth/v1/**', async route => {
      requests.push(new URL(route.request().url()).pathname);
      await gate;
      await route.fulfill({ status: 503, json: { error: 'Fixture login unavailable' } });
    });
    await page.evaluate(() => App.showAuth('login'));
    await page.locator('#a-email').fill('qa.pending@example.test');
    await page.locator('#a-pass').fill('Fixture-Only-Password42!');
    const submit = page.locator('#auth-card button[onclick="App.doLogin()"]');
    try {
      await Promise.all([page.waitForRequest(request => request.url().includes('/auth/v1/token')), submit.click()]);
      const first = await submit.evaluate(element => ({ disabled: element.disabled, ariaBusy: element.getAttribute('aria-busy'), text: element.textContent.trim() }));
      const duplicate = page.waitForRequest(request => request.url().includes('/auth/v1/token'), { timeout: 800 }).then(() => true, () => false);
      if (!first.disabled) await submit.click();
      const duplicateRequest = await duplicate;
      record.observations.pending = { control: first, duplicateRequest, requestsBeforeCompletion: [...requests] };
      check(first.disabled || first.ariaBusy === 'true' || /logging|signing|please wait/i.test(first.text),
        'Pending authentication gives visible/programmatic progress feedback', first);
      check(!duplicateRequest, 'Repeated activation cannot start a second concurrent login request', record.observations.pending);
      await capture(page, record, 'pending');
    } finally { release(); }
    await page.waitForFunction(() => document.getElementById('auth-err')?.textContent.trim());
  });

  probe('conventions saved-state buttons and toast announce their result', { width: 390, height: 844 }, async (page, record, check) => {
    await page.locator('#tabbar [data-tab="home"]').click();
    const saved = page.locator('#view-feed .post-actions button.save').first();
    await saved.click();
    const result = await page.evaluate(() => {
      const button = document.querySelector('#view-feed .post-actions button.save');
      const toast = document.getElementById('toast');
      const live = element => {
        for (let node = element; node; node = node.parentElement) {
          if (['status', 'alert', 'log'].includes(node.getAttribute('role')) || ['polite', 'assertive'].includes(node.getAttribute('aria-live'))) return true;
        }
        return false;
      };
      return { selectedClass: button.classList.contains('on'), pressed: button.getAttribute('aria-pressed'),
        checked: button.getAttribute('aria-checked'), label: button.getAttribute('aria-label') || button.getAttribute('title'),
        toastText: toast?.textContent || '', toastAnnounced: !!toast && live(toast) };
    });
    record.observations.saved = result;
    assert.ok(result.selectedClass && result.toastText, 'The save action must actually complete before checking feedback');
    check(result.pressed === 'true' || result.checked === 'true' || /unsave|remove from saved/i.test(result.label || ''),
      'The saved toggle state is exposed beyond a CSS class', result);
    check(result.toastAnnounced, 'Visible asynchronous confirmation is exposed as a live status message', result);
    await capture(page, record, 'saved');
  });

  probe('conventions invalid weight entry preserves existing log', { width: 390, height: 844 }, async (page, record, check) => {
    await page.evaluate(() => App.goTab('progress'));
    const previous = await page.evaluate(() => JSON.stringify(Store.state.weightLog));
    const dialogs = [];
    page.once('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    await page.locator('#w-input').fill('-5');
    await page.locator('#view-progress button[onclick="App.saveWeight()"]').click();
    const unchanged = await page.evaluate(previous => JSON.stringify(Store.state.weightLog) === previous, previous);
    record.observations.weight = { unchanged, dialogs };
    check(unchanged && dialogs.length === 1, 'Invalid weight is rejected without corrupting prior log entries', record.observations.weight);
    await capture(page, record, 'rejected');
  });
};