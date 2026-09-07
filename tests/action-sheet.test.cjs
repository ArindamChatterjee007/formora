'use strict';

// T-78 interaction accessibility: App.openSheet / App.closeSheet.
// Runs the real js/app.js inside a VM against a minimal DOM so the sheet's
// focus, keyboard and lifecycle behaviour is asserted on the shipped source.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeDocument() {
  const doc = {
    listeners: {},
    activeElement: null,
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const list = this.listeners[type] || [];
      const at = list.indexOf(fn);
      if (at !== -1) list.splice(at, 1);
    },
    createElement(tag) { return makeElement(doc, tag); },
    getElementById(id) {
      const walk = (node) => {
        for (const child of node.children) {
          if (child.id === id) return child;
          const hit = walk(child);
          if (hit) return hit;
        }
        return null;
      };
      return walk(doc.body);
    }
  };
  doc.body = makeElement(doc, 'body');
  doc.body.parentNode = doc;
  doc.activeElement = doc.body;
  return doc;
}

function makeElement(doc, tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    className: '',
    id: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    attrs: {},
    listeners: {},
    appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
    removeChild(child) {
      const at = el.children.indexOf(child);
      if (at !== -1) el.children.splice(at, 1);
      child.parentNode = null;
      return child;
    },
    setAttribute(name, value) { el.attrs[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(el.attrs, name) ? el.attrs[name] : null; },
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const list = el.listeners[type] || [];
      const at = list.indexOf(fn);
      if (at !== -1) list.splice(at, 1);
    },
    focus() { doc.activeElement = el; },
    fire(type, event) { (el.listeners[type] || []).slice().forEach((fn) => fn(event || {})); },
    classList: {
      add(...names) {
        const have = el.className.split(/\s+/).filter(Boolean);
        names.forEach((n) => { if (!have.includes(n)) have.push(n); });
        el.className = have.join(' ');
      },
      remove(...names) {
        el.className = el.className.split(/\s+/).filter(Boolean).filter((n) => !names.includes(n)).join(' ');
      },
      contains(name) { return el.className.split(/\s+/).filter(Boolean).includes(name); }
    }
  };
  Object.defineProperty(el, 'isConnected', {
    get() {
      let node = el;
      while (node) { if (node === doc.body) return true; node = node.parentNode; }
      return false;
    }
  });
  return el;
}

function harness({ deferFrame = false } = {}) {
  const document = makeDocument();
  const frames = [];
  const context = vm.createContext({
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: fn => deferFrame ? frames.push(fn) : setTimeout(fn, 0),
    document,
    navigator: {},
    location: { href: 'https://example.invalid/', origin: 'https://example.invalid', pathname: '/' }
  });
  context.window = context;
  vm.runInContext(appSource + '\nglobalThis.__app = App;', context);
  const App = context.__app;

  const trigger = document.createElement('button');
  trigger.id = 'trigger';
  document.body.appendChild(trigger);

  const key = (k, shiftKey) => {
    const event = { key: k, shiftKey: !!shiftKey, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    (document.listeners.keydown || []).slice().forEach((fn) => fn(event));
    return event;
  };
  const sheet = () => document.getElementById('sheet-wrap');
  const wraps = () => document.body.children.filter((c) => c.className.split(/\s+/).includes('sheet-wrap'));
  const options = () => {
    const wrap = sheet();
    if (!wrap) return [];
    const card = wrap.children[1];
    return card.children.filter((c) => c.className === 'sheet-opts')[0].children;
  };
  const buttons = () => options().filter((c) => c.tagName === 'BUTTON');
  const cancel = () => {
    const card = sheet().children[1];
    return card.children.filter((c) => c.className === 'sheet-cancel')[0];
  };
  const keyHandlers = () => (document.listeners.keydown || []).length;

  return { App, document, trigger, key, sheet, wraps, options, buttons, cancel, keyHandlers, frames };
}

test('sheet is an accessible modal dialog and takes focus on open', () => {
  const h = harness();
  h.trigger.focus();
  h.App.openSheet('Your post', [{ icon: 'copy', label: 'Copy link', fn() {} }]);

  const card = h.sheet().children[1];
  assert.equal(card.className, 'sheet');
  assert.equal(card.getAttribute('role'), 'dialog');
  assert.equal(card.getAttribute('aria-modal'), 'true');
  assert.equal(card.getAttribute('aria-labelledby'), 'sheet-title');
  assert.equal(card.children[0].textContent, 'Your post');
  assert.equal(h.document.activeElement, h.buttons()[0]);
});

test('a sheet without a title still exposes an accessible name', () => {
  const h = harness();
  h.App.openSheet('', [{ label: 'Only option', fn() {} }]);
  const card = h.sheet().children[1];
  assert.equal(card.getAttribute('aria-label'), 'Options');
  assert.equal(card.getAttribute('aria-labelledby'), null);
});

test('action order, separators, danger/on styling and labels are preserved', () => {
  const h = harness();
  h.App.openSheet('Your post', [
    { icon: 'copy', label: 'Copy link', fn() {} },
    { sep: true },
    { icon: 'ban', label: 'Block <b>@x</b>', danger: true, fn() {} },
    { icon: 'bookmark', label: 'Saved', on: true, fn() {} }
  ]);

  const rendered = h.options();
  assert.deepEqual(rendered.map((el) => el.className), ['sheet-opt', 'sheet-sep', 'sheet-opt danger', 'sheet-opt on']);
  const labels = h.buttons().map((el) => el.innerHTML);
  assert.ok(labels[0].endsWith('<span>Copy link</span>'));
  assert.ok(labels[1].includes('Block &lt;b&gt;@x&lt;/b&gt;'));
  assert.equal(h.cancel().textContent, 'Cancel');
});

test('replacing a sheet leaves exactly one sheet and one key handler', () => {
  const h = harness();
  h.App.openSheet('First', [{ label: 'One', fn() {} }]);
  h.App.openSheet('Second', [{ label: 'Two', fn() {} }]);

  assert.equal(h.wraps().length, 1);
  assert.equal(h.keyHandlers(), 1);
  assert.equal(h.sheet().children[1].children[0].textContent, 'Second');

  h.key('Escape');
  assert.equal(h.sheet(), null);
  assert.equal(h.keyHandlers(), 0);
});

test('Tab cycles forward and Shift+Tab backwards inside the sheet', () => {
  const h = harness();
  h.App.openSheet('Your post', [{ label: 'One', fn() {} }, { sep: true }, { label: 'Two', fn() {} }]);
  const [one, two] = h.buttons();
  const cancel = h.cancel();

  assert.equal(h.document.activeElement, one);
  assert.equal(h.key('Tab').defaultPrevented, true);
  assert.equal(h.document.activeElement, two);
  h.key('Tab');
  assert.equal(h.document.activeElement, cancel);
  h.key('Tab');
  assert.equal(h.document.activeElement, one, 'wraps to the first control');
  h.key('Tab', true);
  assert.equal(h.document.activeElement, cancel, 'shift+tab wraps backwards');
  h.key('Tab', true);
  assert.equal(h.document.activeElement, two);
});

test('Tab holds focus when the sheet has a single control', () => {
  const h = harness();
  h.App.openSheet('Log out of Formora?', []);
  const cancel = h.cancel();

  assert.equal(h.document.activeElement, cancel);
  assert.equal(h.key('Tab').defaultPrevented, true);
  assert.equal(h.document.activeElement, cancel);
  h.key('Tab', true);
  assert.equal(h.document.activeElement, cancel);
});

test('Tab skips disabled controls', () => {
  const h = harness();
  h.App.openSheet('Your post', [{ label: 'One', fn() {} }, { label: 'Two', fn() {} }]);
  const [one, two] = h.buttons();
  two.disabled = true;

  assert.equal(h.document.activeElement, one);
  h.key('Tab');
  assert.equal(h.document.activeElement, h.cancel());
  h.key('Tab');
  assert.equal(h.document.activeElement, one, 'disabled option is never focused');
  h.key('Tab', true);
  assert.equal(h.document.activeElement, h.cancel());
});

test('Escape, backdrop and Cancel all close and return focus to the trigger', async () => {
  for (const close of ['escape', 'backdrop', 'cancel']) {
    const h = harness();
    h.trigger.focus();
    h.App.openSheet('Your post', [{ label: 'One', fn() {} }]);
    assert.notEqual(h.document.activeElement, h.trigger);

    const wrap = h.sheet();
    if (close === 'escape') h.key('Escape');
    if (close === 'backdrop') wrap.children[0].fire('click');
    if (close === 'cancel') h.cancel().fire('click');

    assert.equal(h.sheet(), null, close + ' closes the sheet');
    assert.equal(h.keyHandlers(), 0, close + ' releases the key handler');
    assert.equal(h.document.activeElement, h.trigger, close + ' restores focus');
    await delay(220);
    assert.equal(h.wraps().length, 0, close + ' removes the node');
  }
});

test('choosing an action closes the sheet and still runs the callback', async () => {
  const h = harness();
  const seen = [];
  h.trigger.focus();
  h.App.openSheet('Your post', [{ label: 'Copy link', fn: () => seen.push('copy') }]);
  h.buttons()[0].fire('click');

  assert.equal(h.sheet(), null);
  assert.deepEqual(seen, [], 'callback stays deferred');
  await delay(30);
  assert.deepEqual(seen, ['copy']);
  assert.equal(h.document.activeElement, h.trigger);
});

test('an action that opens a dialog keeps focus in that dialog', async () => {
  const h = harness();
  const input = h.document.createElement('input');
  h.document.body.appendChild(input);
  h.trigger.focus();
  h.App.openSheet('Your post', [{ label: 'Edit caption', fn: () => input.focus() }]);
  h.buttons()[0].fire('click');
  await delay(30);

  assert.equal(h.document.activeElement, input, 'focus is not stolen back from the dialog');
});

test('a sheet opened from an action returns focus to the original trigger', async () => {
  const h = harness();
  h.trigger.focus();
  h.App.openSheet('Your post', [{
    label: 'Report post',
    fn: () => h.App.openSheet('Why are you reporting this?', [{ label: 'Spam', fn() {} }])
  }]);
  h.buttons()[0].fire('click');
  await delay(30);

  assert.equal(h.wraps().length, 1, 'no stale sheet is left behind');
  assert.equal(h.keyHandlers(), 1);
  assert.equal(h.sheet().children[1].children[0].textContent, 'Why are you reporting this?');

  h.key('Escape');
  assert.equal(h.document.activeElement, h.trigger);
});

test('a sheet that replaces a live sheet still returns focus to the original trigger', () => {
  const h = harness();
  h.trigger.focus();
  h.App.openSheet('Your post', [{ label: 'One', fn() {} }]);
  h.App.openSheet('Your comment', [{ label: 'Two', fn() {} }]);

  h.key('Escape');
  assert.equal(h.document.activeElement, h.trigger);
});

test('closing without an open sheet is harmless', () => {
  const h = harness();
  h.trigger.focus();
  h.App.closeSheet();
  assert.equal(h.sheet(), null);
  assert.equal(h.keyHandlers(), 0);
  assert.equal(h.document.activeElement, h.trigger);
});

test('backdrop focus falling to body is restored to the connected trigger', () => {
  const subject = harness();
  subject.trigger.focus();
  subject.App.openSheet('Options', [{ label: 'Action' }]);
  const wrapper = subject.sheet();
  subject.document.body.focus();
  wrapper.children[0].fire('click');
  assert.equal(subject.document.activeElement, subject.trigger);
  assert.equal(wrapper.inert, true);
  assert.equal(wrapper.getAttribute('aria-hidden'), 'true');
});

test('double activation cannot dispatch twice or close a replacement sheet', async () => {
  const subject = harness(), seen = [];
  subject.App.openSheet('Options', [{ label: 'Action', fn: () => seen.push('once') }]);
  const wrapper = subject.sheet(), button = subject.buttons()[0];
  button.fire('click');
  button.fire('click');
  subject.App.openSheet('Replacement', [{ label: 'New action' }]);
  const replacement = subject.sheet();
  button.fire('click');
  wrapper.children[0].fire('click');
  await delay(30);
  assert.deepEqual(seen, ['once']);
  assert.equal(subject.sheet(), replacement);
  assert.equal(subject.keyHandlers(), 1);
});

test('a queued opening frame cannot reactivate a closing or replaced sheet', () => {
  const subject = harness({ deferFrame: true });
  subject.App.openSheet('First', [{ label: 'Action' }]);
  const first = subject.sheet();
  subject.App.closeSheet();
  subject.App.openSheet('Second', [{ label: 'Action' }]);
  const second = subject.sheet();
  subject.frames[0]();
  assert.equal(first.classList.contains('in'), false);
  subject.frames[1]();
  assert.equal(second.classList.contains('in'), true);
  assert.equal(subject.keyHandlers(), 1);
});
