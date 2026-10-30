// 本文が変わったときの書き込みの付け直しの確認（Playwright）。ドライブ API はモック（GitHub は使わない）
// 使い方: node tests/reanchor.cjs
// 確認すること: 直した md を同じファイル名で開き直すと、同じ本の新しい版になる（本は増えない）→ 前に段落を足し・消し・書き直しても、
// 書き込みとしおりは同じ字の段落に付いたまま → 本棚の「…」の「ファイルを足す・入れ替える」で章を足せる
// → ドライブにつないだ 2 台: A で新しい版にすると、ドライブの本文・book.json・書き込み（今の段落番号と hs）が置き直され、B もアプリに戻ると取り込んで同じ段落に出る
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const APP = path.resolve(__dirname, '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8782);
let ok = true;
const check = (name, v, info) => { console.log(v ? '✓' : '✗', name, info === undefined ? '' : typeof info === 'string' ? info : JSON.stringify(info)); if (!v) ok = false; };
const { createDrive, GIS, FOLDER, connected } = require('./drive-mock.cjs');
const drv = createDrive(), { files, byPath } = drv;
const para = (n, t) => `段落${n}の本文です。${t || `これは ${n} 番目の段落。`}`;
const v1 = (head) => `# ${head}\n\n` + [...Array(20)].map((_, i) => para(i + 1)).join('\n\n') + '\n';
const v2 = (head) => `---\ntitle: ${head}\n---\n\n# ${head}\n\n新しく足した段落 A。\n\n新しく足した段落 B。\n\n`
  + [...Array(20)].map((_, i) => i + 1).filter((n) => n !== 8).map((n) => n === 15 ? para(15, 'ここを書き直しました。') : para(n)).join('\n\n') + '\n';

(async () => {
  const b = await chromium.launch();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-reanchor-')), d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-reanchor2-'));
  const errs = [];
  const device = async (on) => {
    const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1, hasTouch: true });
    await ctx.route('https://www.googleapis.com/**', drv.route);
    await ctx.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: GIS }));
    const p = await ctx.newPage(); p.ctx = ctx;
    p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404|401|ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(m.text()) && errs.push(m.text()));
    await p.goto('http://localhost:8782/');
    if (on) { await p.evaluate((kv) => { for (const k in kv) localStorage.setItem(k, kv[k]); }, connected()); await p.reload(); }
    await p.waitForTimeout(400);
    p.cdp = await ctx.newCDPSession(p);
    return p;
  };
  const title = (p, t) => p.waitForFunction((t) => document.getElementById('chap-t').textContent.includes(t), t, { timeout: 20000 });
  const blockOf = (p, text) => p.evaluate((t) => [...document.querySelectorAll('#doc > *')].findIndex((el) => el.textContent.includes(t)), text);
  const line = async (p, text) => {
    const y = await p.evaluate((t) => { const el = [...document.querySelectorAll('#doc > *')].find((x) => x.textContent.includes(t)); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return r.top + r.height / 2; }, text);
    await p.mouse.move(200, y); await p.mouse.down(); for (let i = 0; i < 20; i++) await p.mouse.move(200 + i * 6, y + (i % 2) * 2); await p.mouse.up(); await p.waitForTimeout(300);
  };
  // 画面の線が、どの段落の上にあるか（段落の字の頭）
  const onWhich = (p) => p.evaluate(() => [...document.querySelectorAll('#ink path:not(.lasso)')].map((s) => {
    const r = s.getBoundingClientRect(), y = (r.top + r.bottom) / 2;
    const el = [...document.querySelectorAll('#doc > *')].find((x) => { const q = x.getBoundingClientRect(); return y >= q.top && y <= q.bottom; });
    return el ? el.textContent.slice(0, 5) : null;
  }).sort());
  const press = async (p, x, y) => { const t = (type, pts) => p.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) }); await t('touchStart', [[x, y]]); await p.waitForTimeout(700); await t('touchEnd', []); await p.waitForTimeout(200); };
  const wait = async (fn, ms = 15000) => { for (let t = 0; t < ms && !await fn(); t += 200) await new Promise((r) => setTimeout(r, 200)); return fn(); };

  // ---- 1. この端末だけ: 直した md を開き直す ----
  fs.writeFileSync(path.join(dir, 'note.md'), v1('付け直しノート'));
  const L = await device(false);
  await L.setInputFiles('#empty .open-file', path.join(dir, 'note.md'));
  await title(L, '付け直しノート'); await L.waitForTimeout(500);
  await line(L, '段落5の'); await line(L, '段落15の'); await line(L, '段落20の');
  // しおり（指で長押しのメニュー）
  const bm = await L.evaluate(() => { const el = [...document.querySelectorAll('#doc > *')].find((x) => x.textContent.includes('段落10の')); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + 200, y: r.top + r.height / 2 }; });
  await press(L, bm.x, bm.y); await L.click('#pm-bm'); await L.waitForTimeout(300);
  check('書いた線は段落 5・15・20 の上', JSON.stringify(await onWhich(L)) === JSON.stringify(['段落15の', '段落20の', '段落5の本']), await onWhich(L));
  const b5 = await blockOf(L, '段落5の');
  fs.writeFileSync(path.join(dir, 'note.md'), v2('付け直しノート'));
  await L.click('#books'); await L.waitForTimeout(300);
  await L.setInputFiles('#shelf .open-file', path.join(dir, 'note.md'));
  await L.waitForFunction(() => /新しい版/.test(document.getElementById('stat').textContent), null, { timeout: 10000 }).catch(() => {});
  await L.waitForTimeout(800);
  const books = await L.evaluate(() => new Promise((res) => { const r = indexedDB.open('ink-reader', 1); r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').get('books'); q.onsuccess = () => res(q.result); }; }));
  check('同じ本の新しい版になる（本は増えない）', books.length === 1, [books.length, await L.textContent('#stat')]);
  check('新しい本文が出る', await blockOf(L, '新しく足した段落 A') > 0 && await blockOf(L, '段落8の') < 0 && await blockOf(L, 'ここを書き直しました') > 0);
  check('段落の番号は変わった（前は ' + b5 + '）', await blockOf(L, '段落5の') === b5 + 2, await blockOf(L, '段落5の'));
  check('書き込みは同じ字の段落に付いたまま（書き直した段落 15 も）', JSON.stringify(await onWhich(L)) === JSON.stringify(['段落15の', '段落20の', '段落5の本']), await onWhich(L));
  const bmAt = await L.evaluate(() => { const el = document.querySelector('#doc > .bm'); return el && el.textContent.slice(0, 5); });
  check('しおりも同じ段落', bmAt === '段落10の', bmAt);
  const hs = () => L.evaluate(() => new Promise((res) => { const r = indexedDB.open('ink-reader', 1); r.onsuccess = () => { const s = r.result.transaction('kv').objectStore('kv'); const q = s.getAllKeys(); q.onsuccess = () => { const k = q.result.find((x) => /^ink:local:/.test(x)); const g = s.get(k); g.onsuccess = () => res(g.result.hs); }; }; }));
  const now = () => L.evaluate(() => [...document.querySelectorAll('#doc > *')].map((el) => { let h = 5381; const t = el.textContent.slice(0, 300); for (let i = 0; i < t.length; i++) h = (h * 33 + t.charCodeAt(i)) >>> 0; return h.toString(36); }));
  const h1 = await hs(), h2 = await now();
  check('記録の hs は今の段落', JSON.stringify(h1.slice(1)) === JSON.stringify(h2.slice(1)), h1 && h1.map((x, i) => x === h2[i] ? '' : i + ':' + x + '/' + h2[i]).filter(Boolean));
  await L.reload(); await L.waitForTimeout(1200);
  check('開き直しても付け直さない', !/付け直しました/.test(await L.textContent('#stat')), await L.textContent('#stat'));
  check('開き直しても同じ', JSON.stringify(await onWhich(L)) === JSON.stringify(['段落15の', '段落20の', '段落5の本']), await onWhich(L));
  // 本棚の「…」から章を足す
  fs.writeFileSync(path.join(dir, 'extra.md'), '# 足した章\n\n足した章の本文。\n');
  await L.click('#books'); await L.waitForTimeout(300);
  await L.click('#shelf .bk .bk-m'); await L.waitForTimeout(200);
  check('「…」に「ファイルを足す・入れ替える」', await L.isVisible('#bk-add'));
  const [fc] = await Promise.all([L.waitForEvent('filechooser'), L.click('#bk-add')]);
  await fc.setFiles(path.join(dir, 'extra.md'));
  await L.waitForFunction(() => /足しました/.test(document.getElementById('stat').textContent), null, { timeout: 10000 }).catch(() => {});
  const nch = await L.evaluate(() => new Promise((res) => { const r = indexedDB.open('ink-reader', 1); r.onsuccess = () => { const s = r.result.transaction('kv').objectStore('kv'); const q = s.getAllKeys(); q.onsuccess = () => { const k = q.result.find((x) => /^book:local:/.test(x)); const g = s.get(k); g.onsuccess = () => res(g.result.chapters.map((c) => c.label)); }; }; }));
  check('章が足される', nch.length === 2 && nch[1] === '足した章', [nch, await L.textContent('#stat')]);
  await L.ctx.close();

  // ---- 2. ドライブにつないだ 2 台 ----
  fs.writeFileSync(path.join(d2, 'sync.md'), v1('二台ノート'));
  const A = await device(true);
  await A.setInputFiles('#empty .open-file', path.join(d2, 'sync.md'));
  await title(A, '二台ノート'); await A.waitForTimeout(600);
  await line(A, '段落5の');
  const root = () => Object.keys(files).find((k) => files[k].name === 'Ink Reader' && files[k].mimeType === FOLDER);
  const folders = () => Object.values(files).filter((f) => f.mimeType === FOLDER && !f.trashed && (f.parents || []).includes(root())).map((f) => f.name);
  const bdir = await wait(() => folders().find((x) => x.startsWith('二台ノート')));
  const inkJ = () => { const f = bdir && byPath(`Ink Reader/${bdir}/ink/c1.json`); return f ? JSON.parse(f.content) : null; };
  await wait(() => inkJ() && Object.keys(inkJ().blocks).length === 1);
  const j1 = inkJ();
  check('ドライブの書き込みに段落のハッシュ（hs）が入る', j1 && Array.isArray(j1.hs) && j1.hs.length > 20 && Object.keys(j1.blocks)[0] === String(b5), j1 && Object.keys(j1.blocks));
  const B = await device(true);
  await B.click('#empty label.pick');
  await B.waitForFunction(() => document.querySelector('#op-dl li .back'), null, { timeout: 10000 });
  await B.click('#op-dl li:has-text("二台ノート") .back');
  await title(B, '二台ノート'); await B.waitForTimeout(2000);
  check('B にも A の線（段落 5）', JSON.stringify(await onWhich(B)) === JSON.stringify(['段落5の本']), await onWhich(B));

  // A で新しい版にする
  const fp0 = JSON.parse(byPath(`Ink Reader/${bdir}/book.json`).content).fp;
  fs.writeFileSync(path.join(d2, 'sync.md'), v2('二台ノート'));
  await A.click('#books'); await A.waitForTimeout(300);
  await A.setInputFiles('#shelf .open-file', path.join(d2, 'sync.md'));
  await A.waitForTimeout(1500);
  check('A でも線は段落 5', JSON.stringify(await onWhich(A)) === JSON.stringify(['段落5の本']), await onWhich(A));
  await wait(() => { const j = inkJ(); return j && Object.keys(j.blocks)[0] === String(b5 + 2); });
  const bj = JSON.parse(byPath(`Ink Reader/${bdir}/book.json`).content), md = byPath(`Ink Reader/${bdir}/chapters/c1.md`).content;
  check('ドライブの book.json の指紋と本文が新しくなる', bj.fp && bj.fp !== fp0 && /新しく足した段落 A/.test(md) && bj.chapters[0].name === 'sync.md', [bj.fp, fp0, bj.chapters[0]]);
  check('ドライブの書き込みも今の段落番号', Object.keys(inkJ().blocks)[0] === String(b5 + 2), Object.keys(inkJ().blocks));
  // B はアプリに戻ると取り込む（本の確認は 10 秒に 1 回まで）
  await B.waitForTimeout(10500); await B.evaluate(() => dispatchEvent(new Event('focus')));
  await wait(async () => await blockOf(B, '新しく足した段落 A') > 0, 10000);
  await B.waitForTimeout(1500);
  check('B も新しい本文を取り込む', await blockOf(B, '新しく足した段落 A') > 0, await B.textContent('#stat'));
  check('B でも線は段落 5', JSON.stringify(await onWhich(B)) === JSON.stringify(['段落5の本']), await onWhich(B));
  // B が書くと、A にも同じ段落で届く
  await line(B, '段落12の');
  await wait(() => Object.keys(inkJ().blocks).length === 2);
  await A.waitForTimeout(5200); await A.evaluate(() => dispatchEvent(new Event('focus'))); await A.waitForTimeout(1500);
  check('B の線も A の同じ段落に出る', JSON.stringify(await onWhich(A)) === JSON.stringify(['段落12の', '段落5の本']), await onWhich(A));

  check('エラーなし', !errs.length, errs);
  await b.close(); srv.close(); process.exit(ok ? 0 : 1);
})();
