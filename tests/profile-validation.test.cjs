'use strict';
/* DEF-061 (Profile save persists negative measurements and future dates of birth) and
   DEF-062 (unsaved Profile drafts disappear when switching tabs).

   These run the real js/app.js source inside an isolated VM against a scripted profile
   form: no browser, no network, no member data. The browser-level reproductions live in
   tests/profile-workflows.e2e.cjs. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
const TODAY = '2026-09-06';

const SAVED_PROFILE = {
  name: 'Saved Member', dob: '1995-04-02', age: 31, heightCm: 178, targetWeightKg: 76,
  gender: 'male', activityFactor: 1.55, diet: 'veg', physique: 'lean_aesthetic', onboarded: true,
};
// The values the Profile form shows for an untouched, already-valid account.
const VALID_FORM = { 'p-name': 'Saved Member', 'p-dob': '1995-04-02', 'p-h': '178', 'p-tw': '76', 'p-gender': 'male', 'p-diet': 'veg', 'p-act': '1.55' };

function node(id, value, extra = {}) {
  return Object.assign({
    id, value: value === undefined ? '' : String(value), type: 'text', className: '', textContent: '',
    style: { cssText: '' }, attributes: {}, focused: false, parent: null,
    setAttribute(name, next) { this.attributes[name] = String(next); },
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; },
    removeAttribute(name) { delete this.attributes[name]; },
    focus() { this.focused = true; },
    closest() { return this.parent; },
    appendChild(child) { child.parent = this; return child; },
  }, extra);
}

function fixture(formValues = VALID_FORM, profile = SAVED_PROFILE) {
  const saves = [], toasts = [], notes = [], renders = [];
  const elements = new Map();
  for (const [id, value] of Object.entries(formValues)) {
    const field = node(id + '-field');
    const input = node(id, value);
    input.parent = field;
    elements.set(id, input);
  }
  const view = {
    contains: () => true,
    querySelectorAll: () => notes.slice(),
  };
  const document = {
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: id => (id === 'view-profile' ? view : elements.get(id) || null),
    createElement() {
      const created = node('');
      created.remove = () => { const at = notes.indexOf(created); if (at >= 0) notes.splice(at, 1); };
      notes.push(created);
      return created;
    },
  };
  const context = vm.createContext({
    window: {}, document, console, setTimeout, clearTimeout,
    todayISO: () => TODAY,
    daysBetween: (from, to) => (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000,
    PHYSIQUES: { male: [{ id: 'lean_aesthetic' }, { id: 'greek_classic' }], female: [{ id: 'toned_lean' }] },
    DIETS: { nonveg: 'Non-veg', egg: 'Egg', veg: 'Veg', vegan: 'Vegan' },
    Auth: { currentUser: () => ({ id: 'local-A', email: 'member@example.test' }) },
    Store: {
      key: 'gymcoach_v1_local-A',
      state: { profile: { ...profile } },
      save() { saves.push({ ...this.state.profile }); },
    },
  });
  vm.runInContext(appSource + '\nglobalThis.app = App;', context);
  const app = context.app;
  app._entry = 1;
  app.renderChips = () => {};
  app.renderProfile = () => { renders.push('profile'); app._restoreProfileDraft(); };
  app.toast = message => toasts.push(message);
  return { app, context, elements, notes, saves, toasts, renders, profile: context.Store.state.profile };
}

const errorNotes = notes => notes.filter(item => item.getAttribute('role') === 'alert').map(item => ({ describes: item.id, text: item.textContent }));

// ------------------------------------------------------------------ DEF-061

for (const invalid of [
  { name: 'a negative height', id: 'p-h', value: '-1', field: 'heightCm' },
  { name: 'an impossible height', id: 'p-h', value: '9000', field: 'heightCm' },
  { name: 'a negative target weight', id: 'p-tw', value: '-5', field: 'targetWeightKg' },
  { name: 'a target weight below the onboarding minimum', id: 'p-tw', value: '3', field: 'targetWeightKg' },
  { name: 'a future date of birth', id: 'p-dob', value: '2099-01-01', field: 'dob' },
  { name: 'a date of birth under 13', id: 'p-dob', value: '2020-01-01', field: 'dob' },
  { name: 'a cleared date of birth', id: 'p-dob', value: '', field: 'dob' },
  { name: 'a non-numeric height', id: 'p-h', value: 'tall', field: 'heightCm' },
]) {
  test(`DEF-061: saving ${invalid.name} never replaces the stored fitness profile`, () => {
    const { app, elements, notes, saves, toasts, profile } = fixture();
    const before = { ...profile };
    elements.get(invalid.id).value = invalid.value;

    const result = app.saveProfile();

    assert.equal(result, false, 'An invalid patch reports failure instead of a save');
    assert.deepEqual({ ...profile }, before, 'No field is mutated when any field is invalid');
    assert.deepEqual(saves, [], 'Nothing is written to storage');
    assert.equal(elements.get(invalid.id).getAttribute('aria-invalid'), 'true', 'The offending field is marked invalid');
    assert.equal(errorNotes(notes).length, 1, 'One actionable field message is shown');
    assert.ok(errorNotes(notes)[0].text.length > 10, 'The message explains the accepted range');
    assert.ok(elements.get(invalid.id).focused, 'Focus moves to the first field to correct');
    assert.equal(toasts.length, 1, 'The member is told nothing was saved');
    assert.match(toasts[0], /nothing was saved/i);
    for (const [id, value] of Object.entries(VALID_FORM)) {
      if (id === invalid.id) continue;
      assert.equal(elements.get(id).value, value, 'Every other typed value stays in the form: ' + id);
    }
    assert.equal(elements.get(invalid.id).value, invalid.value, 'The rejected entry stays visible so it can be corrected');
  });
}

test('DEF-061: one invalid field blocks the whole patch, including the valid fields beside it', () => {
  const { app, elements, saves, profile } = fixture();
  elements.get('p-name').value = 'Renamed Member';
  elements.get('p-h').value = '181';
  elements.get('p-tw').value = '-5';

  assert.equal(app.saveProfile(), false);
  assert.equal(profile.name, 'Saved Member', 'A partial update is never applied');
  assert.equal(profile.heightCm, 178);
  assert.equal(profile.targetWeightKg, 76);
  assert.deepEqual(saves, []);
});

test('DEF-061 control: valid Profile values still save, clear the errors and recalculate age', () => {
  const { app, elements, notes, saves, toasts, profile } = fixture();
  elements.get('p-h').value = '-1';
  app.saveProfile();
  assert.equal(errorNotes(notes).length, 1);

  elements.get('p-name').value = '  QA Valid Profile  ';
  elements.get('p-h').value = '180';
  elements.get('p-tw').value = '76.5';
  elements.get('p-dob').value = '2000-03-28';

  assert.equal(app.saveProfile(), true);
  assert.equal(profile.name, 'QA Valid Profile');
  assert.equal(profile.heightCm, 180);
  assert.equal(profile.targetWeightKg, 76.5);
  assert.equal(profile.dob, '2000-03-28');
  assert.equal(profile.age, 26, 'Age is derived from the accepted date of birth');
  assert.equal(saves.length, 1, 'Exactly one write for one accepted patch');
  assert.deepEqual(errorNotes(notes), [], 'Stale field errors are removed on success');
  assert.equal(elements.get('p-h').getAttribute('aria-invalid'), null);
  assert.match(toasts.at(-1), /saved/i);
});

test('DEF-061: a blank optional target weight keeps the saved goal instead of clearing it', () => {
  const { app, elements, saves, profile } = fixture();
  elements.get('p-tw').value = '';
  assert.equal(app.saveProfile(), true);
  assert.equal(profile.targetWeightKg, 76, 'An untouched optional goal is preserved');
  assert.equal(saves.length, 1);
});

test('DEF-061: legitimate adult dates of birth are accepted, not falsely aged out', () => {
  for (const dob of ['2013-09-06', '1975-01-01', '1950-12-31']) {
    const { app, elements, profile } = fixture();
    elements.get('p-dob').value = dob;
    assert.equal(app.saveProfile(), true, dob + ' is a legitimate date of birth');
    assert.equal(profile.dob, dob);
  }
});

test('DEF-061: changing gender to one without the saved physique falls back inside the new set', () => {
  const { app, elements, profile } = fixture();
  elements.get('p-gender').value = 'female';
  assert.equal(app.saveProfile(), true);
  assert.equal(profile.gender, 'female');
  assert.equal(profile.physique, 'toned_lean');
});

test('DEF-061: saveProfile is inert when the Profile form is not on screen', () => {
  const { app, context, saves } = fixture();
  context.document.getElementById = () => null;
  assert.equal(app.saveProfile(), false);
  assert.deepEqual(saves, []);
});

// ------------------------------------------------------------------ DEF-062

test('DEF-062: an unsaved Profile edit is restored after leaving and returning to the tab', () => {
  const { app, elements } = fixture();
  elements.get('p-name').value = 'Unsaved QA member name';
  elements.get('p-bio') /* absent in this fixture */;

  app.curTab = 'profile';
  app.selectTab = tab => { if (app.curTab === 'profile' && tab !== 'profile') app._captureProfileDraft(); app.curTab = tab; };
  app.selectTab('home');
  assert.ok(app._profileDraft, 'Leaving Profile captures the draft');

  elements.get('p-name').value = 'Saved Member';   // a re-render repaints the saved value
  app._restoreProfileDraft();
  assert.equal(elements.get('p-name').value, 'Unsaved QA member name');
});

test('DEF-062: a draft is never restored into another account, store key or entry', () => {
  for (const boundary of ['logout', 'another account', 'another store key']) {
    const { app, context, elements } = fixture();
    elements.get('p-name').value = 'Unsaved QA member name';
    app._captureProfileDraft();

    if (boundary === 'logout') app._entry++;
    else if (boundary === 'another account') context.Auth.currentUser = () => ({ id: 'local-B' });
    else context.Store.key = 'gymcoach_v1_local-B';

    elements.get('p-name').value = 'Other Member';
    app._restoreProfileDraft();
    assert.equal(elements.get('p-name').value, 'Other Member', boundary + ' must not inherit the draft');
    assert.equal(app._profileDraft, null, boundary + ' discards the stale draft');
  }
});

test('DEF-062: a valid save and an account invalidation both clear the draft', () => {
  const saved = fixture();
  saved.elements.get('p-name').value = 'Draft name';
  saved.app._captureProfileDraft();
  assert.equal(saved.app.saveProfile(), true);
  assert.equal(saved.app._profileDraft, null, 'The saved values are now the truth');
  assert.equal(saved.profile.name, 'Draft name');

  const invalidated = fixture();
  invalidated.elements.get('p-name').value = 'Draft name';
  invalidated.app._captureProfileDraft();
  assert.ok(invalidated.app._profileDraft);
  invalidated.app._profileDraft = null;   // _invalidateAccount clears it on logout/account switch
  invalidated.app._restoreProfileDraft();
  assert.equal(invalidated.elements.get('p-name').value, 'Draft name');
});

test('DEF-062: drafts stay in memory and are never written to device storage', () => {
  const { app, elements, context } = fixture();
  const writes = [];
  context.localStorage = { setItem: (key, value) => writes.push({ key, value }), getItem: () => null, removeItem: () => {} };
  elements.get('p-name').value = 'Unsaved QA member name';
  app._captureProfileDraft();
  assert.deepEqual(writes, [], 'Profile drafts are RAM only');
  assert.ok(app._profileDraft.values['p-name'] === 'Unsaved QA member name');
});
