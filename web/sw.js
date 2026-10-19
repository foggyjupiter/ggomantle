/*
    꼬맨틀 오프라인 — 서비스 워커.
    앱 화면 파일을 저장해 두고 오프라인에서도 열리게 한다.
    큰 단어 데이터(data/)는 engine.js가 직접 Cache API에 저장하므로 여기서는 건드리지 않는다.
*/
'use strict';

const SHELL_CACHE = 'ggo-shell-v2';
const DATA_CACHE = 'ggo-data';
const SHELL = [
    './',
    'index.html',
    'style.css',
    'app.js',
    'engine.js',
    'manifest.webmanifest',
    'icons/icon.svg',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'icons/apple-touch-icon.png',
    'icons/favicon.ico',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(SHELL_CACHE)
            .then(cache => cache.addAll(SHELL.map(u => new Request(u, {cache: 'reload'}))))
            .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== DATA_CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim()));
});

// 화면 파일: 저장본을 바로 보여 주고, 온라인이면 뒤에서 새 버전으로 갱신 (다음 실행에 반영)
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET' || url.origin !== location.origin) return;
    if (url.pathname.includes('/data/')) return;

    const key = event.request.mode === 'navigate' ? 'index.html' : event.request;
    event.respondWith(caches.open(SHELL_CACHE).then(async (cache) => {
        const cached = await cache.match(key, {ignoreSearch: event.request.mode === 'navigate'});
        const network = fetch(event.request).then((res) => {
            if (res.ok) cache.put(key, res.clone());
            return res;
        });
        if (cached) {
            event.waitUntil(network.catch(() => {}));
            return cached;
        }
        return network;
    }));
});
