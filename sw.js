// やること ver 3.1 — オフライン対応と Web Push 通知
const VERSION = "3.1";
const CACHE = "quick-todo-v" + VERSION;
const ASSETS = [
  "./",
  "index.html",
  "config.js",
  "manifest.webmanifest",
  "bg.jpg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ネットワーク優先、失敗したらキャッシュ。更新はすぐ反映される。
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req, { cache: "no-cache" })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match("index.html")))
  );
});

// サーバーからの通知を表示する（iOSは受信のたびに必ず表示する必要がある）
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : "" }; }
  const title = d.title || "やること";
  e.waitUntil(
    self.registration.showNotification(title, {
      body: d.body || "アラームの時間です",
      tag: d.tag || "qt-alarm",
      data: { id: d.id || null },
      icon: "icons/icon-192.png",
    })
  );
});

// 通知をタップしたら該当の付箋を開く
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.id;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          c.postMessage({ type: "open", id });
          return c.focus();
        }
      }
      return self.clients.openWindow(id ? "./#note=" + encodeURIComponent(id) : "./");
    })
  );
});
