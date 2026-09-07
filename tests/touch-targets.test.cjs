'use strict';

async function measureTapTargetsInPage({ rootSelector, minTarget = 44, required = [] }) {
  const root = document.querySelector(rootSelector);
  if (!root) return { present: false, controls: [], overlaps: [], missingRequired: required };
  const round = value => Math.round(value * 100) / 100;
  const shown = element => element.isConnected
    && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
  const describe = element => {
    const parts = [];
    for (let node = element; node && node !== document.body && parts.length < 4; node = node.parentElement) {
      parts.unshift(node.tagName.toLowerCase() + (node.id ? '#' + node.id : '')
        + [...node.classList].slice(0, 2).map(name => '.' + name).join(''));
    }
    return parts.join(' > ');
  };
  const candidates = container => {
    const selector = 'button,a[href],input:not([type=hidden]),select,textarea,[role=button],[tabindex="0"],[onclick],label:has(input)';
    const elements = [...container.querySelectorAll(selector)].filter(shown)
      .filter(element => !element.closest('[inert]'))
      .filter(element => element.tagName !== 'LABEL' || element.querySelector('input[type=file],input[type=checkbox],input[type=radio]'))
      .map(element => element.matches('input[type=checkbox],input[type=radio],input[type=file]')
        ? [...element.labels || []].find(shown) || element : element);
    return [...new Set(elements)].filter(element => !elements.some(child => child !== element && element.contains(child)));
  };
  const targets = candidates(root);
  const missingRequired = required.filter(({ selector, count = 1 }) =>
    [...root.querySelectorAll(selector)].filter(shown).length < count);
  const scrollers = [document.scrollingElement, ...document.querySelectorAll('*')]
    .filter(element => element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth)
    .map(element => ({ element, top: element.scrollTop, left: element.scrollLeft }));
  const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const controls = [];
  try {
    for (const target of targets) {
      target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      await settle();
      const box = target.getBoundingClientRect();
      const center = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      const inset = Math.min(2, box.width / 4, box.height / 4);
      const points = [
        center, { x: box.left + inset, y: center.y }, { x: box.right - inset, y: center.y },
        { x: center.x, y: box.top + inset }, { x: center.x, y: box.bottom - inset },
      ].map(point => {
        const hit = document.elementFromPoint(point.x, point.y);
        return { x: round(point.x), y: round(point.y), hit: hit ? describe(hit) : null,
          passed: shown(target) && !!hit && (hit === target || target.contains(hit)) };
      });
      const meetsTarget = box.width >= minTarget - 0.01 && box.height >= minTarget - 0.01;
      let exception = null;
      if (!meetsTarget && target.matches('.about-legal a')
        && /^legal\.html#(?:terms|privacy|disclaimer)$/.test(target.getAttribute('href'))
        && target.getClientRects().length === 1) {
        const others = candidates(document.body).filter(other => other !== target && !other.contains(target) && !target.contains(other));
        const clearances = others.map(other => {
          const otherBox = other.getBoundingClientRect();
          const gapX = Math.max(otherBox.left - center.x, 0, center.x - otherBox.right);
          const gapY = Math.max(otherBox.top - center.y, 0, center.y - otherBox.bottom);
          const targetGap = Math.hypot(gapX, gapY) - 12;
          const circleGap = otherBox.width < 24 || otherBox.height < 24
            ? Math.hypot(otherBox.left + otherBox.width / 2 - center.x, otherBox.top + otherBox.height / 2 - center.y) - 24
            : Infinity;
          return { selector: describe(other), gap: Math.min(targetGap, circleGap) };
        }).sort((first, second) => first.gap - second.gap);
        exception = {
          standard: 'WCAG 2.2 SC 2.5.8 spacing (AA), not SC 2.5.5 44px enhanced (AAA)',
          method: 'A 24px-diameter circle centered on the link must not intersect any other target or the 24px circle of any undersized target.',
          diameter: 24, comparedTargets: others.length,
          nearest: clearances[0] ? { selector: clearances[0].selector, clearancePx: round(clearances[0].gap) } : null,
          validated: clearances.every(entry => entry.gap >= -0.01) && points.every(point => point.passed),
        };
      }
      controls.push({
        selector: describe(target),
        label: (target.getAttribute('aria-label') || target.getAttribute('title') || target.innerText || target.value || target.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 64),
        width: round(box.width), height: round(box.height), meetsTarget, exception,
        disabled: target.matches(':disabled') || target.getAttribute('aria-disabled') === 'true',
        hitTest: { passed: points.every(point => point.passed), points },
      });
    }
  } finally {
    for (const { element, top, left } of scrollers) element.scrollTo({ top, left, behavior: 'instant' });
    await settle();
  }
  const overlaps = [];
  for (let firstIndex = 0; firstIndex < targets.length; firstIndex++) {
    for (let secondIndex = firstIndex + 1; secondIndex < targets.length; secondIndex++) {
      const first = targets[firstIndex], second = targets[secondIndex];
      const firstBox = first.getBoundingClientRect(), secondBox = second.getBoundingClientRect();
      const width = Math.min(firstBox.right, secondBox.right) - Math.max(firstBox.left, secondBox.left);
      const height = Math.min(firstBox.bottom, secondBox.bottom) - Math.max(firstBox.top, secondBox.top);
      if (width > 0.5 && height > 0.5) overlaps.push({ first: describe(first), second: describe(second), width: round(width), height: round(height) });
    }
  }
  return { present: true, controls, overlaps, missingRequired };
}

module.exports = { measureTapTargetsInPage };

if (require.main === module) {
  const { test, before, after } = require('node:test');
  const assert = require('node:assert/strict');
  const { chromium } = require('playwright');
  let browser;
  before(async () => {
    browser = await chromium.launch({ headless: true, executablePath: process.env.OFFICE_BROWSER_EXECUTABLE || undefined,
      args: ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND'] });
  });
  after(async () => { if (browser) await browser.close(); });
  const fixture = async (testContext, markup) => {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 }, serviceWorkers: 'block' });
    testContext.after(() => context.close());
    await context.route('**/*', route => route.abort('blockedbyclient'));
    const page = await context.newPage();
    await page.setContent('<style>*{box-sizing:border-box}body{margin:8px}button{width:44px;height:44px}#fixture{display:grid;gap:16px}</style><main id="fixture">' + markup + '</main>');
    return { page, measure: required => page.evaluate(measureTapTargetsInPage, { rootSelector: '#fixture', required }) };
  };
  test('rendered geometry rejects 43.8px controls, excludes hidden controls and includes file labels', async testContext => {
    const { measure } = await fixture(testContext, '<button id="good">OK</button><button id="small" style="height:43.8px">Small</button><button id="hidden" hidden>Hidden</button><label id="upload" style="display:block;width:44px;height:44px">Photo<input type="file" hidden></label>');
    const result = await measure([{ selector: '#hidden' }]);
    assert.equal(result.controls.length, 3);
    assert.equal(result.controls[0].meetsTarget, true);
    assert.equal(result.controls[1].meetsTarget, false);
    assert.equal(result.controls[2].hitTest.passed, true);
    assert.deepEqual(result.missingRequired, [{ selector: '#hidden' }]);
  });
  test('a 44px box fails when an unrelated overlay intercepts its center', async testContext => {
    const { measure } = await fixture(testContext, '<button>OK</button><div style="position:fixed;left:28px;top:28px;width:8px;height:8px;background:red"></div>');
    const result = await measure();
    assert.equal(result.controls[0].meetsTarget, true);
    assert.equal(result.controls[0].hitTest.passed, false);
  });
  test('independent controls with overlapping hit boxes fail', async testContext => {
    const { measure } = await fixture(testContext, '<button style="position:absolute;left:8px;top:8px">One</button><button style="position:absolute;left:40px;top:8px">Two</button>');
    const result = await measure();
    assert.equal(result.overlaps.length, 1);
    assert.ok(result.controls.some(control => !control.hitTest.passed));
  });
  test('scrolling avoids false tabbar covers but genuine fixed obstruction still fails', async testContext => {
    const { measure } = await fixture(testContext, '<button id="scrollable" style="margin-top:1000px;margin-bottom:1000px">Go</button><button id="covered" style="position:fixed;bottom:10px">Stop</button><nav id="tabbar" style="position:fixed;bottom:0;left:0;right:0;height:64px;background:black"></nav>');
    const result = await measure();
    assert.equal(result.controls[0].hitTest.passed, true);
    assert.equal(result.controls[1].hitTest.passed, false);
  });
  test('only known legal links with measured 24px clearance qualify for the spacing exception', async testContext => {
    const { measure } = await fixture(testContext, '<div class="about-legal" style="display:flex;gap:24px"><a href="legal.html#terms">Terms</a><a href="legal.html#privacy">Privacy</a></div><a href="#command" style="height:15px">Ordinary command</a>');
    const result = await measure();
    assert.ok(result.controls.slice(0, 2).every(control => control.exception?.validated));
    assert.ok(result.controls[0].exception.comparedTargets >= 2);
    assert.equal(result.controls[2].exception, null);
  });
  test('crowded legal-link circles do not receive a spacing exception', async testContext => {
    const { measure } = await fixture(testContext, '<div class="about-legal" style="display:flex;gap:3px"><a style="width:20px;height:15px" href="legal.html#terms">T</a><a style="width:20px;height:15px" href="legal.html#privacy">P</a></div>');
    const result = await measure();
    assert.ok(result.controls.every(control => control.exception && !control.exception.validated));
    assert.ok(result.controls.every(control => control.exception.nearest.clearancePx < 0));
  });
}