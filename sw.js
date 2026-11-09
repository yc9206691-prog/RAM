/* IRIS ATLAS — service worker (offline shell only).
   Strategy: network-first for the app page, cache fallback when offline.
   Nothing else is cached or intercepted: API calls, the Cloudflare Worker,
   Supabase and CDN assets always go straight to the network. */
'use strict';

var CACHE = 'iris-atlas-shell-v1';
var SHELL = ['./', './index.html', './manifest.json'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
      .catch(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;
  var isPage = req.mode === 'navigate' || /\/$|\/index\.html$/.test(url.pathname);
  if (!isPage) return;
  e.respondWith(
    fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { return c.put('./index.html', copy); }).catch(function () {});
      return res;
    }).catch(function () {
      return caches.match('./index.html').then(function (r) { return r || caches.match('./'); });
    })
  );
});
