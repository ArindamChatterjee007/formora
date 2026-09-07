"use strict";

const PUSH_BASE = new URL("./", self.location.href);
const PUSH_SCOPE = new URL("__push__/", PUSH_BASE).href;
const PUSH_TAG = "formora-app-update";
const PUSH_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
let pushWork = Promise.resolve();
let pushFence = 0;
let pushMuted = false;

function pushAppURL(value, allowQuery = false) {
  try {
    const url = new URL(value);
    return url.origin === PUSH_BASE.origin && !url.username && !url.password
      && [PUSH_BASE.pathname, new URL("index.html", PUSH_BASE).pathname].includes(url.pathname)
      && (allowQuery || (!url.search && !url.hash)) && url.href === value ? url.href : null;
  } catch (_) { return null; }
}

function pushStorage(write, value) {
  return new Promise((resolve, reject) => {
    let database;
    let transaction;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      database?.close();
      if (error) reject(new Error("Push local storage unavailable")); else resolve(result);
    };
    const timer = setTimeout(() => { transaction?.abort(); finish(true); }, 4000);
    try {
      const request = self.indexedDB.open("formora-push-v1", 1);
      request.onupgradeneeded = () => { request.result.createObjectStore("bindings"); };
      request.onerror = request.onblocked = () => finish(true);
      request.onsuccess = () => {
        database = request.result;
        if (settled) { database.close(); return; }
        database.onversionchange = () => database.close();
        transaction = database.transaction("bindings", write ? "readwrite" : "readonly");
        const store = transaction.objectStore("bindings");
        const operation = write ? (value ? store.put(value, PUSH_SCOPE) : store.delete(PUSH_SCOPE)) : store.get(PUSH_SCOPE);
        let result;
        operation.onsuccess = () => { result = operation.result; };
        transaction.oncomplete = () => finish(false, result || null);
        transaction.onerror = transaction.onabort = () => finish(true);
      };
    } catch (_) { finish(true); }
  });
}

function pushBinding(value) {
  return value && PUSH_UUID.test(value.binding_id) && Number.isFinite(value.expires_at)
    && value.expires_at > Date.now() && value.expires_at <= Date.now() + 31 * 86400000;
}

async function pushClose() {
  const notifications = await self.registration.getNotifications({ tag: PUSH_TAG });
  for (const notification of notifications) notification.close();
}

function pushQueue(work) {
  const pending = pushWork.then(work);
  pushWork = pending.catch(() => {});
  return pending;
}

self.addEventListener("message", event => {
  const message = event.data;
  const port = event.ports?.[0];
  if (self.registration.scope !== PUSH_SCOPE || !port || !event.source?.id
    || event.source.type !== "window" || !pushAppURL(event.source.url, true)
    || !message || !PUSH_UUID.test(message.request_id)
    || !["formora-push:bind", "formora-push:mute"].includes(message.type)) return;
  const fence = ++pushFence;
  pushMuted = true;
  event.waitUntil(pushQueue(async () => {
    try {
      if (message.type === "formora-push:bind") {
        if (!pushBinding(message.binding)) throw new Error("Invalid binding");
        await pushStorage(true, { binding_id: message.binding.binding_id, expires_at: message.binding.expires_at });
        if (fence !== pushFence) throw new Error("Superseded binding");
        pushMuted = false;
      } else {
        await pushStorage(true, null);
        await pushClose();
      }
      port.postMessage({ request_id: message.request_id, type: message.type, ok: true });
    } catch (_) {
      port.postMessage({ request_id: message.request_id, type: message.type, ok: false });
    } finally { port.close(); }
  }));
});

self.addEventListener("push", event => {
  event.waitUntil(pushQueue(async () => {
    if (self.registration.scope !== PUSH_SCOPE || pushMuted || !event.data) return;
    try {
      const text = event.data.text();
      if (typeof text !== "string" || text.length > 1024) return;
      const payload = JSON.parse(text);
      if (!payload || Array.isArray(payload) || Object.keys(payload).some(key => !["v", "kind", "binding_id", "url"].includes(key))
        || payload.v !== 1 || payload.kind !== "app_update" || !PUSH_UUID.test(payload.binding_id)) return;
      const target = payload.url === undefined ? PUSH_BASE.href : pushAppURL(payload.url);
      if (!target) return;
      const binding = await pushStorage(false);
      if (pushMuted || !pushBinding(binding) || binding.binding_id !== payload.binding_id) return;
      await self.registration.showNotification("Formora", {
        body: "Open Formora to see what's new.", tag: PUSH_TAG,
        icon: new URL("icons/icon-192.png", PUSH_BASE).href,
        renotify: false, requireInteraction: false, silent: true,
        data: { binding_id: binding.binding_id, url: target }
      });
    } catch (_) {}
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(pushQueue(async () => {
    try {
      const target = pushAppURL(event.notification.data?.url);
      if (pushMuted || !target || event.notification.tag !== PUSH_TAG) return;
      const binding = await pushStorage(false);
      if (!pushBinding(binding) || binding.binding_id !== event.notification.data?.binding_id) return;
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find(client => pushAppURL(client.url, true));
      if (existing) await existing.focus(); else await self.clients.openWindow(target);
    } catch (_) {}
  }));
});

self.addEventListener("pushsubscriptionchange", event => {
  pushMuted = true;
  ++pushFence;
  event.waitUntil(pushQueue(async () => {
    try { await pushStorage(true, null); await pushClose(); } catch (_) {}
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) if (pushAppURL(client.url, true)) client.postMessage({ type: "formora-push:subscription-change" });
  }));
});