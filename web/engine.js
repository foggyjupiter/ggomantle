/*
    꼬맨틀 오프라인 — 유사도 계산 워커.
    서버(원본 semantle.py)가 하던 일을 기기 안에서 한다.

    Forked from 꼬맨틀 (NewsJelly/semantle-ko), Semantlich (gaetjen/semantle-de)
    and Semantle (David Turner). Licensed under the GNU GPL v3.
*/
'use strict';

const DATA_CACHE = 'ggo-data';
const NEAREST_COUNT = 1000;

let meta = null;
let words = null;      // string[]
let index = null;      // Map<string, number>
let vectors = null;    // Int8Array, count * dim
let norms = null;      // Float32Array
const nearestCache = new Map();  // puzzle -> {ranks: Map<idx, rank>, list, story}

async function openCache() {
    try {
        return self.caches ? await caches.open(DATA_CACHE) : null;
    } catch (e) {
        return null;
    }
}

async function fetchWithTimeout(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        return await fetch(url, {cache: 'no-cache', signal: ctrl.signal});
    } finally {
        clearTimeout(timer);
    }
}

// meta.json은 온라인이면 새로 받고(업데이트 확인), 아니면 저장본을 쓴다.
async function loadMeta(cache) {
    const url = 'data/meta.json';
    try {
        const res = await fetchWithTimeout(url, 4000);
        if (!res.ok) throw new Error(res.status);
        if (cache) await cache.put(url, res.clone());
        return await res.json();
    } catch (e) {
        const saved = cache && await cache.match(url);
        if (!saved) throw new Error('offline-first-run');
        return await saved.json();
    }
}

// 큰 파일은 처음 한 번만 받아 Cache API에 저장한다.
async function loadFile(cache, url, onProgress) {
    let res = cache && await cache.match(url);
    if (res) return await res.arrayBuffer();

    res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        onProgress(loaded, total);
    }
    const blob = new Blob(chunks);
    if (cache) await cache.put(url, new Response(blob));
    return await blob.arrayBuffer();
}

// 데이터가 업데이트되면 이전 버전 파일을 지운다.
async function removeOldData(cache, keepUrls) {
    if (!cache) return;
    const keep = new Set(keepUrls.map(u => new URL(u, self.location.href).href));
    for (const req of await cache.keys()) {
        if (!req.url.endsWith('/meta.json') && !keep.has(req.url)) await cache.delete(req);
    }
}

// opts.cache: false면 저장하지 않는다 (안드로이드 앱은 데이터가 APK 안에 있음)
async function init(opts) {
    if (opts.files) return setup(opts.files.meta, opts.files.words, opts.files.vectors);
    const cache = opts.cache === false ? null : await openCache();
    meta = await loadMeta(cache);
    const wordsUrl = `data/words.txt?v=${meta.version}`;
    const vecUrl = `data/vectors.bin?v=${meta.version}`;
    const expected = meta.count * meta.dim;

    const progress = {words: [0, 0], vectors: [0, expected]};
    const report = () => postMessage({
        type: 'progress',
        loaded: progress.words[0] + progress.vectors[0],
        total: progress.words[1] + progress.vectors[1],
    });
    const [wordsBuf, vecBuf] = await Promise.all([
        loadFile(cache, wordsUrl, (l, t) => { progress.words = [l, t]; report(); }),
        loadFile(cache, vecUrl, (l, t) => { progress.vectors = [l, t || expected]; report(); }),
    ]);
    await removeOldData(cache, [wordsUrl, vecUrl]);
    try {
        return setup(meta, wordsBuf, vecBuf);
    } catch (e) {
        if (cache) {
            await cache.delete(vecUrl);
            await cache.delete(wordsUrl);
        }
        throw e;
    }
}

// 안드로이드 앱에서는 화면 쪽이 파일을 읽어 넘겨준다 (WebView가 워커의 요청을 못 가로채는 기기가 있음)
function setup(metaData, wordsBuf, vecBuf) {
    meta = metaData;
    words = new TextDecoder().decode(wordsBuf).split('\n');
    vectors = new Int8Array(vecBuf);
    if (words.length !== meta.count || vectors.length !== meta.count * meta.dim) throw new Error('corrupt-data');
    index = new Map();
    for (let i = 0; i < words.length; i++) index.set(words[i], i);

    const dim = meta.dim;
    norms = new Float32Array(meta.count);
    for (let i = 0; i < meta.count; i++) {
        let s = 0;
        for (let j = i * dim, end = j + dim; j < end; j++) s += vectors[j] * vectors[j];
        norms[i] = Math.sqrt(s);
    }
    return {puzzleCount: meta.secrets.length, firstDay: meta.firstDay, version: meta.version};
}

function similarity(a, b) {
    const dim = meta.dim;
    let s = 0;
    for (let i = a * dim, j = b * dim, end = i + dim; i < end; i++, j++) s += vectors[i] * vectors[j];
    return s / (norms[a] * norms[b]);
}

function secretIndex(puzzle) {
    return meta.secrets[((puzzle % meta.secrets.length) + meta.secrets.length) % meta.secrets.length];
}

// 원본 process_similar.py와 같이: 순위 대상 단어 중 정답과 가장 가까운 1000개 (정답 자신 제외)
function nearest(puzzle) {
    if (nearestCache.has(puzzle)) return nearestCache.get(puzzle);
    const secret = secretIndex(puzzle);
    const n = meta.rankable;
    const sims = new Float32Array(n);
    for (let i = 0; i < n; i++) sims[i] = similarity(secret, i);
    if (secret < n) sims[secret] = -Infinity;  // 정답은 순위 목록에서 뺀다

    // 1000번째 값을 기준으로 거른 뒤 그것만 정렬
    const cutoff = Float32Array.from(sims).sort()[Math.max(0, n - NEAREST_COUNT)];
    const top = [];
    for (let i = 0; i < n; i++) if (sims[i] >= cutoff) top.push(i);
    top.sort((a, b) => sims[b] - sims[a]);
    top.length = Math.min(top.length, NEAREST_COUNT);

    const ranks = new Map();
    const list = top.map((i, r) => {
        ranks.set(i, r + 1);
        return {word: words[i], rank: r + 1, sim: sims[i]};
    });
    const result = {
        ranks,
        list,
        story: {top: list[0].sim, top10: list[9].sim, rest: list[list.length - 1].sim},
    };
    nearestCache.set(puzzle, result);
    if (nearestCache.size > 4) nearestCache.delete(nearestCache.keys().next().value);
    return result;
}

function guess(puzzle, word) {
    word = word.normalize('NFC');
    const i = index.get(word);
    if (i === undefined) return {error: 'unknown', guess: word};
    const secret = secretIndex(puzzle);
    if (i === secret) return {guess: word, sim: 1, rank: '정답!'};
    const near = nearest(puzzle);
    return {guess: word, sim: similarity(secret, i), rank: near.ranks.get(i) ?? '1000위 이상'};
}

const handlers = {
    init,
    story: ({puzzle}) => nearest(puzzle).story,
    guess: ({puzzle, word}) => guess(puzzle, word),
    nearest: ({puzzle}) => ({secret: words[secretIndex(puzzle)], list: nearest(puzzle).list}),
    secret: ({puzzle}) => words[secretIndex(puzzle)],
};

let ready = null;
self.onmessage = async (event) => {
    const {id, type, args} = event.data;
    try {
        if (type === 'init') {
            ready = ready || init(args || {});
            postMessage({id, result: await ready});
            return;
        }
        await ready;
        postMessage({id, result: handlers[type](args || {})});
    } catch (e) {
        if (type === 'init') ready = null;
        postMessage({id, error: String(e && e.message || e)});
    }
};
