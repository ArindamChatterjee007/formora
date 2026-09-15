'use strict';
const { webcrypto } = require('node:crypto');
const createStories = require('../../js/mod/stories.js');
const owner = '11111111-1111-4111-8111-111111111111';
const viewer = '22222222-2222-4222-8222-222222222222';
const storyId = '33333333-3333-4333-8333-333333333333';

function fixture(overrides = {}) {
  const storage = new Map(), requests = [], events = new EventTarget(), listeners = new Map();
  const host = {
    STORY_INTERACTIONS: true, crypto: webcrypto, performance, setTimeout, clearTimeout,
    addEventListener(name, handler) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler); events.addEventListener(name, handler);
    },
    removeEventListener(name, handler) { listeners.get(name)?.delete(handler); events.removeEventListener(name, handler); },
    dispatchEvent: event => events.dispatchEvent(event),
    localStorage: { get length() { return storage.size; }, key: index => [...storage.keys()][index] ?? null,
      getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    location: { origin: 'http://127.0.0.1:1234' }
  };
  const auth = { active: () => true, uid: () => viewer, token: async () => 'fresh-examplefixture-token', _generation: 0 };
  const cloud = { base: 'https://examplefixture.supabase.co/rest/v1', key: 'examplefixture-public-key', me: viewer };
  const fetch = async (url, init) => { requests.push({ url, ...init }); return Response.json({ items: [], next_cursor: null }); };
  const api = createStories({ host, auth, cloud, fetch, ...overrides });
  return { api, host, auth, cloud, storage, requests, listeners };
}

function story(overrides = {}) {
  return { id: storyId, author: owner, photo: `https://examplefixture.supabase.co/storage/v1/object/public/media/stories/${owner}/fixture.jpg`,
    kind: 'photo', audience: 'authenticated', ts: Date.now(), expires_at: new Date(Date.now() + 86400000).toISOString(),
    mine: false, seen: false, liked: false, view_count: null, like_count: null, ...overrides };
}

function fakeClock() {
  let stamp = 0, sequence = 0;
  const timers = new Map(), wall = Date.now();
  return { now: () => stamp, wallNow: () => wall + stamp, timers,
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: stamp + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(milliseconds) {
      const end = stamp + milliseconds;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((left, right) => left[1].at - right[1].at)[0];
        if (!next) break;
        stamp = next[1].at; timers.delete(next[0]); next[1].callback();
      }
      stamp = end;
    }
  };
}

function playback(kind = 'photo', mine = false) {
  const clock = fakeClock(), document = { hidden: false, hasFocus: () => true };
  const state = fixture({ clock, document });
  const row = story({ kind, mine, author: mine ? viewer : owner });
  const scope = state.api._scope();
  const media = { currentTime: 0, duration: 9, readyState: 4, paused: false, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } };
  const play = { row, scope, revision: state.api._revision, media, ready: true, waiting: false, pauses: new Set(),
    last: null, elapsed: 0, qualifiedMs: 0, viewAttempted: mine, progressSeen: false, mediaTime: 0, progressAt: 0, handlers: [] };
  state.api._play = play;
  let views = 0, advances = 0;
  state.api._recordQualified = active => { if (!active.viewAttempted) { views++; active.viewAttempted = true; } };
  state.api.next = async () => { advances++; };
  return { ...state, clock, document, play, views: () => views, advances: () => advances };
}

function renderedPlayback(background = {}, kind = 'photo') {
  const state = playback(kind), row = state.play.row;
  const media = Object.assign(new EventTarget(), state.play.media, {
    style: {}, getAttribute(name) { return this[name]; }, removeAttribute(name) { delete this[name]; }, remove() {}, load() {}
  });
  const elements = { header: {}, stage: { prepend() {} }, footer: {} };
  state.document.hidden = !!background.hidden;
  state.document.hasFocus = () => background.focused !== false;
  state.document.createElement = () => media;
  state.api._element = id => elements[id] || null;
  state.api._ids = [row.id]; state.api._index = 0;
  state.api.get = async () => row;
  state.api._render(row, state.play.scope, state.play.revision);
  return { ...state, play: state.api._play, media };
}

module.exports = { renderedPlayback };