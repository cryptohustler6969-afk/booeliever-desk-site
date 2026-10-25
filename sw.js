// Caches only the public lock-screen shell. Encrypted files and anything else always come from the network;
// no plaintext app data is ever cached (decryption happens in memory, in the page).
const VERSION = "bd-lock-v1";
const SHELL = ["./", "index.html", "loader.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  const p = url.pathname, base = new URL(self.registration.scope).pathname;
  const rel = p.startsWith(base) ? p.slice(base.length) : null;
  if (rel === null || !(rel === "" || SHELL.includes(rel))) return; // network only (app.enc, data.enc, kdf.json, ...)
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const c2 = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, c2)); } return r; })
    .catch(() => caches.match(e.request)));
});
