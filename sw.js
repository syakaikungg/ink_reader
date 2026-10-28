// Copyright (C) 2026 syakaikungg. All rights reserved.
// アプリ本体をキャッシュして、通信なしでも起動できるようにする。
// 本文と書き込みは IndexedDB 側（app.js）。アプリを更新したら VERSION を上げる
const VERSION = 'ink-reader-v30';
const FILES = [
  './',
  'index.html',
  'app.js',
  'render.js',
  'manifest.webmanifest',
  'icon-180.png',
  'icon-512.png',
  'vendor/katex.min.css',
  'vendor/katex.min.js',
  'vendor/marked.min.js',
  'vendor/perfect-freehand.js',
  // PDF.js。cmaps・standard_fonts・wasm は使ったものだけ、初めて読んだときにキャッシュされる
  'vendor/pdfjs/pdf.min.mjs',
  'vendor/pdfjs/pdf.worker.min.mjs',
  'vendor/fonts/KaTeX_AMS-Regular.woff2',
  'vendor/fonts/KaTeX_Caligraphic-Bold.woff2',
  'vendor/fonts/KaTeX_Caligraphic-Regular.woff2',
  'vendor/fonts/KaTeX_Fraktur-Bold.woff2',
  'vendor/fonts/KaTeX_Fraktur-Regular.woff2',
  'vendor/fonts/KaTeX_Main-Bold.woff2',
  'vendor/fonts/KaTeX_Main-BoldItalic.woff2',
  'vendor/fonts/KaTeX_Main-Italic.woff2',
  'vendor/fonts/KaTeX_Main-Regular.woff2',
  'vendor/fonts/KaTeX_Math-BoldItalic.woff2',
  'vendor/fonts/KaTeX_Math-Italic.woff2',
  'vendor/fonts/KaTeX_SansSerif-Bold.woff2',
  'vendor/fonts/KaTeX_SansSerif-Italic.woff2',
  'vendor/fonts/KaTeX_SansSerif-Regular.woff2',
  'vendor/fonts/KaTeX_Script-Regular.woff2',
  'vendor/fonts/KaTeX_Size1-Regular.woff2',
  'vendor/fonts/KaTeX_Size2-Regular.woff2',
  'vendor/fonts/KaTeX_Size3-Regular.woff2',
  'vendor/fonts/KaTeX_Size4-Regular.woff2',
  'vendor/fonts/KaTeX_Typewriter-Regular.woff2',
  'vendor/fonts/SourceSerif4-latin-italic.woff2',
  'vendor/fonts/SourceSerif4-latin.woff2',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;   // GitHub API はそのまま通す
  // 通信できるときは新しい版を取り、できないときはキャッシュで起動。
  // ブラウザの HTTP キャッシュ（GitHub Pages は10分）に古い app.js が残ると index.html と版がずれるので、毎回サーバーに確かめる
  e.respondWith(fetch(e.request.url, { cache: 'no-cache' }).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))));
});
