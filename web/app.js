/*
    꼬맨틀 오프라인 — 화면과 게임 진행.

    Forked from 꼬맨틀 (NewsJelly/semantle-ko), Semantlich (gaetjen/semantle-de)
    and Semantle (David Turner). Licensed under the GNU GPL v3.
*/
'use strict';

const $ = (id) => document.getElementById(id);
const FIRST_DAY = Date.parse('2022-04-01T00:00:00+09:00');  // 한국 시간 자정 기준
const DAY = 86400000;

const store = {
    get(key, fallback) {
        try {
            const v = localStorage.getItem('ggo:' + key);
            return v === null ? fallback : JSON.parse(v);
        } catch (e) {
            return fallback;
        }
    },
    set(key, value) {
        try { localStorage.setItem('ggo:' + key, JSON.stringify(value)); } catch (e) {}
    },
};

// ---- 워커 호출 ----
const worker = new Worker('engine.js');
let callId = 0;
const pending = new Map();
let onProgress = () => {};
worker.onmessage = (event) => {
    const {id, type, result, error} = event.data;
    if (type === 'progress') return onProgress(event.data.loaded, event.data.total);
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    error ? p.reject(new Error(error)) : p.resolve(result);
};
function call(type, args) {
    return new Promise((resolve, reject) => {
        const id = ++callId;
        pending.set(id, {resolve, reject});
        worker.postMessage({id, type, args});
    });
}

// ---- 상태 ----
let puzzleCount = 4650;
let today = 0;        // 오늘 문제 번호
let puzzle = 0;       // 지금 풀고 있는 문제 번호
let game = null;      // {guesses: [[sim, word, rank, n]], status, start, end}
let story = null;
let latestWord = '';
let sortMode = 'sim';
const settings = Object.assign({shareGuesses: true, shareTime: true, shareTop: true}, store.get('settings', {}));

function todayPuzzle() {
    return Math.floor((Date.now() - FIRST_DAY) / DAY) % puzzleCount;
}

function loadGame(n) {
    return store.get('game:' + n, null) || {guesses: [], status: 'playing', start: null, end: null};
}

function saveGame() {
    store.set('game:' + puzzle, game);
}

function isOver() {
    return game.status !== 'playing';
}

// ---- 통계 (오늘 문제만 집계) ----
function getStats() {
    return Object.assign({
        firstPlay: null, lastPlayed: null, played: 0, wins: 0, giveups: 0,
        totalGuesses: 0, streak: 0, maxStreak: 0, lastWin: null,
    }, store.get('stats', {}));
}

function countGuess() {
    if (puzzle !== today) return;
    const s = getStats();
    if (s.firstPlay === null) s.firstPlay = today;
    if (s.lastPlayed !== today) {
        s.played += 1;
        s.lastPlayed = today;
    }
    s.totalGuesses += 1;
    store.set('stats', s);
}

function countEnd(won) {
    if (puzzle !== today) return;
    const s = getStats();
    if (s.lastPlayed !== today) {
        s.played += 1;
        s.lastPlayed = today;
    }
    if (won) {
        s.wins += 1;
        s.streak = s.lastWin === today - 1 ? s.streak + 1 : 1;
        s.maxStreak = Math.max(s.maxStreak, s.streak);
        s.lastWin = today;
    } else {
        s.giveups += 1;
        s.streak = 0;
    }
    store.set('stats', s);
}

function currentStreak(s) {
    return s.lastWin !== null && s.lastWin >= today - 1 ? s.streak : 0;
}

// ---- 화면 그리기 ----
function fmtSim(sim) {
    return sim.toFixed(2);
}

function guessRow([sim, word, rank, n]) {
    const el = document.createElement('div');
    el.className = 'g';
    let rankHtml;
    if (typeof rank === 'number') {
        el.classList.add('hot');
        rankHtml = `<span class="rank">${rank}위</span><span class="meter"><i style="width:${(1001 - rank) / 10}%"></i></span>`;
    } else if (rank === '정답!' || rank === '정답') {
        el.classList.add('win');
        rankHtml = `<span class="rank">${rank}</span>`;
    } else if (story && sim >= story.rest * 100) {
        rankHtml = `<span class="rank weird" title="사전에는 없지만 1,000위 이내인 단어입니다.">????</span>`;
    } else {
        rankHtml = `<span class="rank">${rank}</span>`;
    }
    el.innerHTML = `<span class="n">${n}</span><span class="w"></span><span class="s">${fmtSim(sim)}</span><span class="r">${rankHtml}</span>`;
    el.querySelector('.w').textContent = word;
    return el;
}

function sortedGuesses() {
    const list = game.guesses.slice();
    if (sortMode === 'sim') list.sort((a, b) => b[0] - a[0]);
    else if (sortMode === 'time') list.sort((a, b) => b[3] - a[3]);
    else list.sort((a, b) => a[1].localeCompare(b[1], 'ko'));
    return list;
}

function showResult() {
    render();
    $('result').scrollIntoView({behavior: 'smooth', block: 'start'});
}

function render() {
    const latest = game.guesses.find(g => g[1] === latestWord);
    $('latest').replaceChildren(...(latest ? [guessRow(latest)] : []));
    $('guesses').replaceChildren(...sortedGuesses().filter(g => g !== latest).map(guessRow));
    $('list-head').hidden = game.guesses.length === 0;
    $('guess-count').textContent = game.guesses.filter(g => g[2] !== '정답').length;
    $('giveup-btn').hidden = isOver();
    renderResult();
}

function renderResult() {
    const box = $('result');
    if (!isOver()) {
        box.hidden = true;
        return;
    }
    const won = game.status === 'won';
    const count = game.guesses.length - (won ? 0 : 1);
    const next = puzzle === today
        ? `<p class="muted small">${today + 1}번째 꼬맨틀은 오늘 밤 자정(한국 시간)에 열립니다.</p>`
        : '';
    box.innerHTML = `
        <h2>${won ? '정답입니다! 🎉' : '포기했어요'}</h2>
        <p>${won ? `<b>${count}번째</b> 추측만에 정답을 맞혔습니다.` : `${count}번 추측한 뒤 포기했습니다.`}
           정답 단어는 <b id="answer"></b>입니다.</p>
        <div class="actions">
            <button class="btn primary" id="share-btn">기록 공유하기</button>
            <button class="btn" id="top-btn">상위 1,000개 단어</button>
        </div>
        ${puzzle < today ? '<div class="actions" style="margin-top:8px"><button class="btn" id="next-btn">다음 문제</button></div>' : ''}
        ${next}`;
    box.querySelector('#answer').textContent = `“${game.guesses.find(g => g[0] === 100)?.[1] || ''}”`;
    box.hidden = false;
    $('share-btn').onclick = share;
    $('top-btn').onclick = () => openNearest(puzzle);
    if ($('next-btn')) $('next-btn').onclick = () => goTo(puzzle + 1);
}

function renderStory() {
    $('story').innerHTML = story
        ? `<b>${puzzle}번째</b> 꼬맨틀의 정답 단어를 맞혀 보세요.<br>
           정답과 가장 유사한 단어의 유사도는 <b>${fmtSim(story.top * 100)}</b>,
           10번째는 ${fmtSim(story.top10 * 100)}, 1,000번째는 ${fmtSim(story.rest * 100)}입니다.`
        : `<b>${puzzle}번째</b> 꼬맨틀의 정답 단어를 맞혀 보세요.`;
    const chip = $('puzzle-chip');
    chip.textContent = puzzle === today ? `#${puzzle} 오늘` : `#${puzzle} 지난 문제`;
    chip.classList.toggle('past', puzzle !== today);
}

async function renderYesterday() {
    const el = $('yesterday');
    if (puzzle !== today || today === 0) {
        el.textContent = '';
        return;
    }
    const word = await call('secret', {puzzle: today - 1});
    el.innerHTML = `어제의 정답 단어는 <b></b>입니다. <a href="#" id="yesterday-top">상위 1,000개 보기</a>`;
    el.querySelector('b').textContent = `“${word}”`;
    $('yesterday-top').onclick = (e) => {
        e.preventDefault();
        openNearest(today - 1);
    };
}

function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---- 게임 진행 ----
function cleanGuess(text) {
    return text.trim().replace(/[!*/]/g, '').normalize('NFC');
}

async function submitGuess(event) {
    event.preventDefault();
    const input = $('guess');
    const word = cleanGuess(input.value);
    $('error').textContent = '';
    if (!word) return;
    input.value = '';
    // iOS 한글 입력기가 지운 글자를 다시 넣는 문제 방지 (원본과 같은 방법)
    $('dummy').focus();
    input.focus();

    const data = await call('guess', {puzzle, word});
    if (data.error) {
        $('error').textContent = `${word}은(는) 알 수 없는 단어입니다.`;
        return;
    }
    latestWord = data.guess;
    if (!game.guesses.some(g => g[1] === data.guess)) {
        if (!game.start) game.start = Date.now();
        const n = game.guesses.length + 1;
        game.guesses.push([data.sim * 100, data.guess, data.rank, n]);
        if (!isOver()) countGuess();
    }
    if (data.sim === 1 && !isOver()) {
        game.status = 'won';
        game.end = Date.now();
        countEnd(true);
        saveGame();
        showResult();
        return;
    }
    saveGame();
    render();
}

async function giveUp() {
    if (isOver() || !confirm('정말로 포기하시겠습니까?')) return;
    const secret = await call('secret', {puzzle});
    game.guesses.push([100, secret, '정답', game.guesses.length + 1]);
    game.status = 'gaveup';
    game.end = Date.now();
    if (!game.start) game.start = game.end;
    latestWord = secret;
    countEnd(false);
    saveGame();
    showResult();
}

function shareText() {
    const url = location.origin + location.pathname;
    const won = game.status === 'won';
    const count = game.guesses.length - (won ? 0 : 1);
    if (won && count === 1) return `이럴 수가! 첫 번째 추측에서 ${puzzle}번째 꼬맨틀 정답 단어를 맞혔습니다!\n${url}`;
    if (count === 0) return `${puzzle}번째 꼬맨틀을 시도하지 않고 바로 포기했어요.\n${url}`;

    let text = won ? `${puzzle}번째 꼬맨틀을 풀었습니다!\n` : `저런… ${puzzle}번째 꼬맨틀을 포기했어요..ㅠ\n`;
    if (settings.shareGuesses) text += `추측 횟수: ${count}\n`;
    if (settings.shareTime && game.start && game.end) {
        const sec = Math.round((game.end - game.start) / 1000);
        text += sec > 86400
            ? '소요 시간: 24시간 이상\n'
            : `소요 시간: ${Math.floor(sec / 3600)}시간${String(Math.floor(sec / 60) % 60).padStart(2, '0')}분${String(sec % 60).padStart(2, '0')}초\n`;
    }
    if (settings.shareTop) {
        const best = game.guesses.filter(g => g[0] < 100).sort((a, b) => b[0] - a[0])[0];
        if (best) text += `최대 유사도: ${fmtSim(best[0])}${typeof best[2] === 'number' ? ` (순위 ${best[2]})` : ''}\n`;
    }
    return text + url;
}

async function share() {
    const text = shareText();
    if (navigator.share) {
        try {
            await navigator.share({text});
            return;
        } catch (e) {
            if (e.name === 'AbortError') return;
        }
    }
    try {
        await navigator.clipboard.writeText(text);
        toast('클립보드에 복사했습니다.');
    } catch (e) {
        prompt('아래 내용을 복사하세요.', text);
    }
}

async function openNearest(n) {
    const dialog = $('nearest-dialog');
    $('nearest-list').innerHTML = '<p class="muted center">계산 중…</p>';
    dialog.showModal();
    const {secret, list} = await call('nearest', {puzzle: n});
    const mine = new Set(loadGame(n).guesses.map(g => g[1]));
    $('nearest-title').textContent = `“${secret}”와 가장 비슷한 1,000개`;
    const rows = list.map(({word, rank, sim}) =>
        `<tr${mine.has(word) ? ' class="mine"' : ''}><td>${rank}</td><td>${word}</td><td>${fmtSim(sim * 100)}</td></tr>`);
    $('nearest-list').innerHTML = `<table><thead><tr><th>순위</th><th>단어</th><th>유사도</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

async function goTo(n) {
    n = Math.max(0, Math.min(today, Math.floor(n)));
    if (Number.isNaN(n)) return;
    puzzle = n;
    history.replaceState(null, '', n === today ? location.pathname : `#${n}`);
    game = loadGame(puzzle);
    latestWord = '';
    $('error').textContent = '';
    story = null;
    renderStory();
    render();
    story = await call('story', {puzzle});
    renderStory();
    render();
    renderYesterday();
}

// ---- 메뉴/설정 ----
function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
}

function openMenu() {
    const s = getStats();
    const cells = [
        ['플레이', s.played], ['정답', s.wins], ['포기', s.giveups],
        ['연속 정답', currentStreak(s)], ['최장 연속', s.maxStreak], ['총 추측 수', s.totalGuesses],
    ];
    $('stats').innerHTML = cells.map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join('');
    $('menu-dialog').showModal();
}

function setupUi() {
    $('form').addEventListener('submit', submitGuess);
    $('giveup-btn').addEventListener('click', giveUp);
    $('help-btn').addEventListener('click', () => $('help-dialog').showModal());
    $('menu-btn').addEventListener('click', openMenu);
    $('puzzle-chip').addEventListener('click', () => {
        const input = $('puzzle-input');
        input.max = today;
        input.value = puzzle;
        $('puzzle-dialog').showModal();
    });
    $('puzzle-form').addEventListener('submit', (e) => {
        e.preventDefault();
        $('puzzle-dialog').close();
        goTo(Number($('puzzle-input').value));
    });
    $('today-btn').addEventListener('click', () => {
        $('puzzle-dialog').close();
        goTo(today);
    });
    $('random-btn').addEventListener('click', () => {
        $('puzzle-dialog').close();
        goTo(Math.floor(Math.random() * today));
    });
    document.querySelectorAll('.sort button').forEach(b => b.addEventListener('click', () => {
        sortMode = b.dataset.sort;
        document.querySelectorAll('.sort button').forEach(x => x.classList.toggle('on', x === b));
        render();
    }));
    // 바깥(배경)을 누르면 닫기
    document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', (e) => {
        if (e.target === d) d.close();
    }));

    const theme = $('theme');
    theme.value = document.documentElement.dataset.theme || 'auto';  // index.html에서 미리 적용됨
    theme.addEventListener('change', () => {
        try { localStorage.setItem('ggo:theme', theme.value); } catch (e) {}
        applyTheme(theme.value);
    });
    for (const [id, key] of [['share-guesses', 'shareGuesses'], ['share-time', 'shareTime'], ['share-top', 'shareTop']]) {
        $(id).checked = settings[key];
        $(id).addEventListener('change', () => {
            settings[key] = $(id).checked;
            store.set('settings', settings);
        });
    }

    // 자정이 지나 앱으로 돌아오면 새 문제로
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && todayPuzzle() !== today) {
            const wasToday = puzzle === today;
            today = todayPuzzle();
            if (wasToday) goTo(today);
        }
    });
    window.addEventListener('hashchange', () => {
        const n = parseInt(location.hash.slice(1), 10);
        goTo(Number.isNaN(n) ? today : n);
    });
}

async function start() {
    setupUi();
    if (store.get('seenHelp', false) === false) {
        $('help-dialog').showModal();
        store.set('seenHelp', true);
    }

    onProgress = (loaded, total) => {
        const pct = total ? Math.min(100, loaded / total * 100) : 0;
        $('loading-bar').style.width = pct + '%';
        $('loading-text').textContent = `단어 데이터를 내려받는 중… ${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)}MB`;
    };

    let info;
    try {
        info = await call('init');
    } catch (e) {
        $('loading-text').textContent = e.message === 'offline-first-run'
            ? '처음 한 번은 인터넷 연결이 필요해요. 연결한 뒤 다시 시도해 주세요.'
            : `데이터를 불러오지 못했어요. (${e.message})`;
        $('loading-sub').hidden = true;
        $('retry-btn').hidden = false;
        $('retry-btn').onclick = () => location.reload();
        return;
    }
    puzzleCount = info.puzzleCount;
    today = todayPuzzle();
    $('loading').hidden = true;
    $('game').hidden = false;

    let persisted = false;
    try { persisted = navigator.storage && await navigator.storage.persist(); } catch (e) {}
    $('storage-info').textContent = `오프라인 준비 완료 · 데이터 ${info.version}${persisted ? ' · 저장공간 보호됨' : ''}`;

    const fromHash = parseInt(location.hash.slice(1), 10);
    await goTo(Number.isNaN(fromHash) ? today : fromHash);
}

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

start();
