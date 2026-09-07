'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderedPlayback } = require('./helpers/story-playback.cjs');

function video(duration) {
  const state = renderedPlayback({}, 'video');
  state.media.duration = duration;
  state.media.dispatchEvent(new Event('playing'));
  assert.equal(state.play.ready, true);
  assert.equal(state.api.getDuration(), duration);
  return state;
}

function advance(state, milliseconds) {
  for (let elapsed = 0; elapsed < milliseconds;) {
    const step = Math.min(100, milliseconds - elapsed);
    state.media.currentTime += step / 1000;
    state.clock.advance(step);
    elapsed += step;
  }
}

function end(state) {
  state.media.currentTime = state.media.duration;
  state.media.ended = true;
  state.media.paused = true;
  state.media.dispatchEvent(new Event('ended'));
}

test('qaux short clips end without qualifying and their running end control advances once', () => {
  for (const duration of [0.7, 1.5, 1.9]) {
    const state = video(duration);
    advance(state, duration * 1000);
    assert.equal(state.views(), 0, String(duration));
    assert.equal(state.advances(), 0);
    end(state);
    assert.equal(state.views(), 0);
    assert.equal(state.advances(), 1);
    state.api._cleanPlayback();
    state.media.dispatchEvent(new Event('ended'));
    assert.equal(state.advances(), 1, 'cleaned media cannot advance again');
    assert.equal(state.clock.timers.size, 0);
  }
});

test('qaux a short clip cannot advance through a pause or unusable foreground', () => {
  for (const reason of ['manual', 'hold', 'hover', 'editing', 'panel', 'hidden', 'blur']) {
    const state = video(1.9);
    advance(state, 1800);
    state.api.pause(reason, true);
    end(state);
    state.clock.advance(5000);
    assert.equal(state.views(), 0, reason);
    assert.equal(state.advances(), 0, reason);
    assert.equal(state.play.qualifiedMs, 0);
    state.api._cleanPlayback();
  }
  for (const condition of ['hidden', 'unfocused']) {
    const state = video(1.9);
    advance(state, 1800);
    if (condition === 'hidden') state.document.hidden = true;
    else state.document.hasFocus = () => false;
    end(state);
    assert.equal(state.advances(), 0, condition);
    state.clock.advance(1000);
    assert.equal(state.views(), 0);
    state.api._cleanPlayback();
  }
});

test('qaux exact video qualification is repeatable at 2000ms but absent at 1999ms', () => {
  for (let repetition = 0; repetition < 2; repetition++) {
    const state = video(3);
    advance(state, 1999);
    assert.equal(state.views(), 0);
    advance(state, 1);
    assert.equal(state.play.qualifiedMs, 2000);
    assert.equal(state.views(), 1);
    advance(state, 500);
    assert.equal(state.views(), 1, 'continuing playback cannot count twice');
    assert.equal(state.advances(), 0, 'video navigation follows ended, not a photo timer');
    state.api._cleanPlayback();
    assert.equal(state.clock.timers.size, 0);
  }
});