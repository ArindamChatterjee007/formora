'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/mod/review.js'), 'utf8');

// Hermetic harness: review.js is an IIFE over globals only, so a vm context with stubbed
// Store/Engine/App/document is enough to exercise build() and render() with no browser.
function setup(o) {
  o = o || {};
  const profile = Object.assign({ gender: 'male' }, o.profile || {});
  const stats = Object.assign(
    { weight: 80, tdee: 2600, calTarget: 2600, proteinG: 160, calAdj: 0, bodyFat: 20 },
    o.stats || {}
  );
  const comp = o.comp === null ? null
    : Object.assign({ bodyFat: stats.bodyFat, targetLo: 10, targetHi: 14 }, o.comp || {});
  const goalProgress = o.goalProgress === null ? null
    : Object.assign({ overall: 55, bfScore: 40, consistency: 70, wScore: 55 }, o.goalProgress || {});
  const card = { innerHTML: '' };
  const modal = { classList: { remove() { modal.shown = true; }, contains: () => false } };
  const win = {};
  const calls = { pricing: 0 };
  vm.createContext(win);
  Object.assign(win, {
    window: win,
    document: { getElementById: (id) => (id === 'modal-card' ? card : modal) },
    Entitlements: { isElite: () => o.elite !== false },
    App: { progressPhotos: () => (o.photos || []), openPricing() { calls.pricing++; } },
    Store: {
      state: { profile },
      latestWeight: () => ('latestWeight' in o ? o.latestWeight : 80)
    },
    Engine: {
      stats: () => stats,
      bodyComp: () => comp,
      getPhysique: () => (o.phys || { name: 'Athletic' }),
      experiencePlan: () => ({ freq: 4, tip: 'tip' in o ? o.tip : 'Add reps first.' }),
      weeklyFrequency: () => (o.freq == null ? 4 : o.freq),
      goalProgress: () => goalProgress
    }
  });
  vm.runInContext(source, win);
  return { review: win.EliteReview, card, modal, calls, context: win };
}

const sec = (data, title) => data.secs.find((s) => s.t === title);
const traj = (data) => sec(data, 'Trajectory').b;

test('Loss goal reports true weight progress, not the composite score', () => {
  // 90 -> 85 of a 90 -> 80 goal is exactly halfway, while the composite happens to read 88.
  const { review } = setup({
    profile: { startWeightKg: 90, targetWeightKg: 80 },
    latestWeight: 85,
    goalProgress: { overall: 88 }
  });
  const data = review.build();
  const t = traj(data);
  assert.match(t, /<b>50%<\/b> of the way from 90 to your 80 kg goal/);
  assert.match(t, /5 kg to go/);
  assert.doesNotMatch(t, /88/);
  // The composite is preserved separately and still labelled as an overall look score.
  assert.equal(data.overall, 88);
  assert.deepEqual({ ...data.weight }, { pct: 50, toGo: -5, start: 90, cur: 85, tgt: 80, hold: false });
});

test('Gain goal is measured in the gaining direction', () => {
  const { review } = setup({
    profile: { startWeightKg: 60, targetWeightKg: 70 },
    latestWeight: 66,
    goalProgress: { overall: 12 }
  });
  const t = traj(review.build());
  assert.match(t, /<b>60%<\/b> of the way from 60 to your 70 kg goal/);
  assert.match(t, /4 kg to go/);
});

test('Moving away from the goal clamps to 0% rather than going negative', () => {
  const { review } = setup({
    profile: { startWeightKg: 90, targetWeightKg: 80 },
    latestWeight: 95
  });
  const data = review.build();
  assert.equal(data.weight.pct, 0);
  assert.match(traj(data), /<b>0%<\/b> of the way/);
});

test('Reaching the goal reads as 100% with no remaining distance', () => {
  const { review } = setup({
    profile: { startWeightKg: 90, targetWeightKg: 80 },
    latestWeight: 80
  });
  const data = review.build();
  assert.equal(data.weight.pct, 100);
  assert.match(traj(data), /you're there/);
});

test('A hold goal (start === target) is described as a hold, not divided by zero', () => {
  const onIt = setup({ profile: { startWeightKg: 80, targetWeightKg: 80 }, latestWeight: 80 }).review.build();
  assert.equal(onIt.weight.hold, true);
  assert.equal(onIt.weight.pct, 100);
  assert.match(traj(onIt), /this is a hold/);
  assert.match(traj(onIt), /right on it/);

  const drifted = setup({ profile: { startWeightKg: 80, targetWeightKg: 80 }, latestWeight: 83 }).review.build();
  assert.equal(drifted.weight.pct, 0);
  assert.match(traj(drifted), /3 kg off/);
  assert.doesNotMatch(traj(drifted), /NaN|Infinity/);
});

test('Missing and non-finite weights fall back to a prompt instead of fake numbers', () => {
  const cases = [
    { profile: {}, latestWeight: 80 },
    { profile: { startWeightKg: 90 }, latestWeight: 85 },
    { profile: { startWeightKg: 90, targetWeightKg: 80 }, latestWeight: undefined },
    { profile: { startWeightKg: 90, targetWeightKg: 'soon' }, latestWeight: 85 },
    { profile: { startWeightKg: null, targetWeightKg: 80 }, latestWeight: 85 },
    { profile: { startWeightKg: 90, targetWeightKg: Infinity }, latestWeight: 85 }
  ];
  for (const c of cases) {
    const data = setup(c).review.build();
    const t = traj(data);
    assert.equal(data.weight, null, JSON.stringify(c.profile));
    assert.match(t, /Log a starting weight, a current weight and a target weight/);
    assert.doesNotMatch(t, /of the way/);
    assert.doesNotMatch(t, /NaN|Infinity|undefined|null/);
  }
});

test('The composite score is never substituted for the weight percentage', () => {
  // Same weights, wildly different composites: the weight sentence must not move.
  const shown = [10, 55, 99].map((overall) => traj(setup({
    profile: { startWeightKg: 100, targetWeightKg: 90 },
    latestWeight: 97,
    goalProgress: { overall }
  }).review.build()));
  assert.equal(new Set(shown).size, 1);
  assert.match(shown[0], /<b>30%<\/b> of the way from 100 to your 90 kg goal/);
});

test('Photo window reports logged weight only and never estimates fat from images', () => {
  const day = 86400000;
  const { review } = setup({
    profile: { startWeightKg: 90, targetWeightKg: 80 },
    latestWeight: 85,
    photos: [
      { id: 'a', ts: 1000 * day, url: 'data:,a', weightKg: 90, bodyFat: 24 },
      { id: 'b', ts: 1014 * day, url: 'data:,b', weightKg: 85, bodyFat: 19 }
    ]
  });
  const t = traj(review.build());
  assert.match(t, /Between your first and latest photo \(14 days\)/);
  assert.match(t, /<b>logged<\/b> weight went down 5 kg/);
  assert.match(t, /-2\.5 kg\/week/);
  assert.match(t, /none of these numbers are read from the images/);
  // The 24% -> 19% body-fat estimates stored alongside the photos must not be presented as
  // a photo-derived measurement of body composition.
  assert.doesNotMatch(t, /body fat/i);
  assert.doesNotMatch(t, /est\. body fat|5%/);
});

test('Photos without logged weights report nothing rather than guessing', () => {
  const day = 86400000;
  const t = traj(setup({
    profile: { startWeightKg: 90, targetWeightKg: 80 },
    latestWeight: 85,
    photos: [
      { id: 'a', ts: 1000 * day, url: 'data:,a' },
      { id: 'b', ts: 1010 * day, url: 'data:,b' }
    ]
  }).review.build());
  assert.match(t, /no rate of change to report/);
  assert.doesNotMatch(t, /NaN/);
});

test('With fewer than two photos, photos are described as lighting/side-by-side only', () => {
  const t = traj(setup({ profile: { startWeightKg: 90, targetWeightKg: 80 }, latestWeight: 85 }).review.build());
  assert.match(t, /side-by-side and a lighting check only/);
  assert.doesNotMatch(t, /measure your real/);
});

test('Over-range guidance is data-based, caveated, and not an aggressive prescription', () => {
  const { review } = setup({ stats: { bodyFat: 22, tdee: 2600, proteinG: 160, calAdj: 4 } });
  const data = review.build();
  const body = sec(data, 'Body composition').b;
  assert.match(body, /Estimated body fat ~<b>22%<\/b>/);
  assert.match(body, /BMI-based estimate, not a measurement/);
  assert.match(body, /protein near 160g\/day/);
  assert.match(body, /varies a lot between people/);
  assert.doesNotMatch(body, /without costing muscle/);
  assert.doesNotMatch(body, /the smart order|I'd run a short deficit/);

  const nutrition = data.acts.find((a) => /kcal/.test(a));
  assert.match(nutrition, /roughly <b>2210 kcal<\/b>/);          // ~15% under maintenance
  assert.match(nutrition, /roughly 15% under your estimated maintenance/);
  assert.match(nutrition, /estimates from your logged stats/);
  assert.doesNotMatch(nutrition, /2200 kcal/);                    // the old flat -400 deficit
});

test('Incomplete stats suppress calorie/protein numbers instead of printing NaN', () => {
  const data = setup({ stats: { tdee: NaN, proteinG: undefined, calTarget: NaN }, comp: null }).review.build();
  const nutrition = data.acts.find((a) => /protein/i.test(a));
  assert.match(nutrition, /Fill in your height, age and current weight/);
  assert.doesNotMatch(data.acts.join(' '), /NaN|undefined/);
});

test('Hostile stored values are escaped and never break out of markup', () => {
  const payload = '<img src=x onerror="alert(1)">';
  const { review, card } = setup({
    phys: { name: payload },
    profile: { startWeightKg: 90, targetWeightKg: 80 },
    latestWeight: 85,
    goalProgress: { overall: '80"><script>alert(1)</script>' }
  });
  const data = review.build();
  assert.match(sec(data, 'Body composition').b, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(data.secs.map((s) => s.b).join(''), /<img|<script/);

  review.open();
  assert.doesNotMatch(card.innerHTML, /<img src=x|<script/);
  assert.match(card.innerHTML, /&lt;img src=x/);
  // The composite feeds a style attribute, so it must survive only as a clamped integer.
  assert.match(card.innerHTML, /style="--p:80"/);
  assert.doesNotMatch(card.innerHTML, /--p:80"><script/);
});

test('A hostile experience tip cannot inject markup into the action list', () => {
  const { review, card } = setup({ tip: '</li><script>alert(1)</script>' });
  const data = review.build();
  assert.match(data.acts[0], /&lt;\/li&gt;&lt;script&gt;/);
  assert.doesNotMatch(data.acts[0], /<script/);
  review.open();
  assert.doesNotMatch(card.innerHTML, /<script/);
});

test('Render states the read is rules-based and carries the estimate disclaimer', () => {
  const { review, card } = setup({ profile: { startWeightKg: 90, targetWeightKg: 80 }, latestWeight: 85 });
  review.open();
  assert.match(card.innerHTML, /A rules-based read computed on your device/);
  assert.match(card.innerHTML, /photos are only checked for lighting consistency/);
  assert.match(card.innerHTML, /nothing is measured from the images/);
  assert.match(card.innerHTML, /estimates calculated from your logged stats/);
  assert.match(card.innerHTML, /not medical advice/);
  assert.match(card.innerHTML, /a blend of your body-fat estimate, training consistency and weight trend/);
});

test('Non-Elite members stay gated and render nothing', () => {
  const { review, card, calls } = setup({ elite: false });
  review.open();
  assert.equal(calls.pricing, 1);
  assert.equal(card.innerHTML, '');
});

test('Delayed lighting results cannot replace a new modal or another account review', async () => {
  for (const change of ['modal', 'account']) {
    const { review, card, context } = setup({ profile: { startWeightKg: 90, targetWeightKg: 80 }, photos: [
      { ts: 1000, weightKg: 90, url: 'data:image/png;base64,fixture-a' },
      { ts: 86401000, weightKg: 89, url: 'data:image/png;base64,fixture-b' }
    ] });
    const images = [];
    context.Image = class { constructor() { images.push(this); } };
    context.document.createElement = () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(40 * 56 * 4).fill(100) }) }) });
    context.Store.key = 'account-a'; review.open();
    if (change === 'modal') card.innerHTML = 'New modal content';
    else context.Store.key = 'account-b';
    const expected = card.innerHTML;
    for (const image of images) image.onload();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(card.innerHTML, expected, change);
  }
});

test('Lighting checks never request externally hosted images', async () => {
  const { review, context } = setup({ photos: [{ url: 'https://external.example.test/a.jpg' }, { url: 'https://external.example.test/b.jpg' }] });
  let created = 0; context.Image = class { constructor() { created++; } };
  review.open(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(created, 0);
});
