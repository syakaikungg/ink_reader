// 複数の端末で同じドライブを使う確認（Playwright）。ドライブ API はモックし、端末ごとに新しいブラウザの環境を作る（GitHub は使わない）
// 使い方: node tests/sync.cjs
// 確認すること: 2台が同じ段落に書いても（片方が送る前でも）両方の線が残る → 片方で消した線は、もう片方の線を残したまま消える
// → 本棚の「…」で「この端末だけ」にすると何も送らない（雲の印が消える）。同期に戻すと、その間に書いた分を送る
// → ドライブにつなぐ前に開いた本は、つないだときに同じ本のフォルダにつなぐ（フォルダを増やさない）
// → 読んだ跡は端末ごとのファイル、いま.md に端末名
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const APP = path.resolve(__dirname, '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8779);
let ok = true;
const check = (name, v, info) => { console.log(v ? '✓' : '✗', name, info === undefined ? '' : info); if (!v) ok = false; };
const { createDrive, GIS, FOLDER, connected } = require('./drive-mock.cjs');
const drv = createDrive(), { files, byPath } = drv;
(async () => {
  const b = await chromium.launch();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-sync-'));
  fs.writeFileSync(path.join(dir, 'note.md'), '# 同期ノート\n\n最初の段落。$x^2$\n\n二つ目の段落。\n\n三つ目の段落。\n\n四つ目の段落。\n');
  const errs = [];
  const device = async (on = true) => {
    const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1, hasTouch: true });
    await ctx.route('https://www.googleapis.com/**', drv.route);
    await ctx.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: GIS }));
    const p = await ctx.newPage(); p.ctx = ctx;
    p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404|401|ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(m.text()) && errs.push(m.text()));
    await p.goto('http://localhost:8779/');
    if (on) { await p.evaluate((kv) => { for (const k in kv) localStorage.setItem(k, kv[k]); }, connected()); await p.reload(); }
    await p.waitForTimeout(400);
    return p;
  };
  const title = (p, t) => p.waitForFunction((t) => document.getElementById('chap-t').textContent.includes(t), t, { timeout: 20000 });
  const strokes = (p) => p.evaluate(() => document.querySelectorAll('#ink path:not(.lasso)').length);
  // 段落 n（#doc の子要素の番号）に横線を 1 本書く。k をずらすと別の高さ
  const line = async (p, n, k = 0) => {
    const y = await p.evaluate(([n, k]) => { const el = document.querySelectorAll('#doc > *')[n]; el.scrollIntoView({ block: 'center' }); return el.getBoundingClientRect().top + 4 + k * 6; }, [n, k]);
    await p.mouse.move(150, y); await p.mouse.down(); for (let i = 0; i < 20; i++) await p.mouse.move(150 + i * 6, y + (i % 2) * 2); await p.mouse.up();
  };
  const wait = async (fn, ms = 15000) => { for (let t = 0; t < ms && !fn(); t += 200) await new Promise((r) => setTimeout(r, 200)); return fn(); };
  const root = () => Object.keys(files).find((k) => files[k].name === 'Ink Reader' && files[k].mimeType === FOLDER);
  const folders = () => Object.values(files).filter((f) => f.mimeType === FOLDER && !f.trashed && (f.parents || []).includes(root())).map((f) => f.name).sort();
  let bdir = null;
  const ink = () => { const f = bdir && byPath(`Ink Reader/${bdir}/ink/c1.json`); return f ? JSON.parse(f.content).blocks : {}; };
  const ids = (n) => Object.keys((ink()[n] || {}).strokes || {}).sort();
  const inkV = () => { const f = byPath(`Ink Reader/${bdir}/ink/c1.json`); return f && f.version; };
  const pend = (p) => p.evaluate(() => /未送信|オフライン/.test(document.getElementById('stat').textContent));
  const back = async (p) => { await p.waitForTimeout(5200); await p.evaluate(() => dispatchEvent(new Event('focus'))); await p.waitForTimeout(1500); };   // アプリに戻った（5 秒に 1 回まで取り込む）

  // ---- 端末 A: md を開いて段落 3 に書く ----
  const A = await device();
  await A.setInputFiles('#empty .open-file', path.join(dir, 'note.md'));
  await title(A, '同期ノート'); await A.waitForTimeout(600);
  await line(A, 3);
  bdir = await wait(() => folders().find((d) => d.startsWith('同期ノート'))) || null;
  await wait(() => ids(3).length === 1);
  check('A の線がドライブに届く', ids(3).length === 1, bdir);
  const a1 = ids(3)[0];

  // ---- 端末 B: 「ファイルから開く」→ ドライブの本 → インポート ----
  const B = await device();
  await B.click('#empty label.pick');
  await B.waitForFunction(() => document.querySelector('#op-dl li .back'), null, { timeout: 10000 });
  await B.click('#op-dl li:has-text("同期ノート") .back');
  await title(B, '同期ノート'); await B.waitForTimeout(2000);
  check('B にも A の線が出る', await strokes(B) === 1);

  // ---- 同じ段落に、A が送る前に B も書く ----
  await A.ctx.setOffline(true);
  await line(A, 3, 2);
  await A.waitForTimeout(500);
  await line(B, 3, 4);
  await wait(() => ids(3).length === 2);
  check('B の線がドライブに届く（A の分はまだ）', ids(3).length === 2);
  await A.ctx.setOffline(false);
  await wait(() => ids(3).length === 3);
  await A.waitForTimeout(1500);
  check('A がつながると、同じ段落の線が3本とも残る', ids(3).length === 3 && ids(3).includes(a1), ids(3));
  check('A の画面にも3本', await strokes(A) === 3);
  await back(B);
  check('B もアプリに戻ると3本', await strokes(B) === 3);

  // ---- 片方で消した線は消え、もう片方が足した線は残る ----
  await line(A, 3, 6);
  await wait(() => ids(3).length === 4); await A.waitForTimeout(800);
  const before = ids(3);
  await A.ctx.setOffline(true);
  await A.click('#undo'); await A.waitForTimeout(400);   // A が最後の線を消す（まだ送れない）
  await back(B);
  await line(B, 3, 8);
  await wait(() => ids(3).length === 5);
  await A.ctx.setOffline(false);
  await wait(() => ids(3).length === 4, 15000); await A.waitForTimeout(1500);
  const now = ids(3), aIds = await A.evaluate(() => [...document.querySelectorAll('#ink path:not(.lasso)')].length);
  check('A が消した線は消え、B の新しい線は残る', now.length === 4 && before.filter((x) => !now.includes(x)).length === 1 && aIds === 4, [before, now]);

  // ---- 「この端末だけ」にすると何も送らない ----
  await A.click('#books'); await A.waitForFunction(() => document.getElementById('shelf').open);
  check('同期している本には雲の印', !!(await A.$('#shelf-list .bk .sy')));
  await A.click('#shelf-list .bk-m'); await A.waitForTimeout(200);
  check('「…」に「この端末だけにする」', (await A.textContent('#bk-sync')).trim() === 'この端末だけにする' && await A.isVisible('#bk-sync'));
  await A.click('#bk-sync'); await A.waitForTimeout(300);
  check('雲の印が消える', !(await A.$('#shelf-list .bk .sy')) && /この端末だけにしました/.test(await A.textContent('#shelf-msg')));
  await A.click('#shelf button[value=cancel]');
  const v0 = inkV(), nowF = byPath('Ink Reader/いま.md'), nv0 = nowF && nowF.version;
  await line(A, 4); await A.waitForTimeout(6000);
  check('この端末だけの本は送らない（未送信とも出さない）', inkV() === v0 && !await pend(A) && !ink()[4]);
  check('いま.md も書かない', (byPath('Ink Reader/いま.md') || {}).version === nv0);
  await A.click('#books'); await A.waitForFunction(() => document.getElementById('shelf').open);
  await A.click('#shelf-list .bk-m'); await A.waitForTimeout(200);
  check('戻すときは「ドライブと同期する」', (await A.textContent('#bk-sync')).trim() === 'ドライブと同期する');
  await A.click('#bk-sync'); await A.waitForTimeout(200);
  await A.click('#shelf button[value=cancel]');
  await wait(() => ids(4).length === 1);
  check('同期に戻すと、その間に書いた分を送る', ids(4).length === 1 && ids(3).length === 4);

  // ---- ドライブにつなぐ前に開いた本は、つないだら同じ本のフォルダにつなぐ ----
  const C = await device(false);
  await C.setInputFiles('#empty .open-file', path.join(dir, 'note.md'));
  await title(C, '同期ノート'); await C.waitForTimeout(600);
  await line(C, 2);
  await C.waitForTimeout(500);
  const fs0 = folders();
  await C.evaluate((kv) => { for (const k in kv) localStorage.setItem(k, kv[k]); }, connected()); await C.reload();
  await title(C, '同期ノート');
  await wait(() => ids(2).length === 1, 20000); await C.waitForTimeout(2000);
  check('フォルダを増やさない（同じ本のフォルダにつなぐ）', JSON.stringify(folders()) === JSON.stringify(fs0) && !drv.twins(), folders());
  check('C の線も、前からある線もドライブに残る', ids(2).length === 1 && ids(3).length === 4 && ids(4).length === 1);
  check('C の画面にも全部', await strokes(C) === 6);
  await C.click('#books'); await C.waitForFunction(() => document.getElementById('shelf').open); await C.click('#shelf label.pick');
  await C.waitForFunction(() => document.querySelector('#op-dl li .back'), null, { timeout: 10000 });
  check('ドライブの本の一覧では「開く」', /開く$/.test(await C.textContent('#op-dl li')));
  await C.click('#opener button[value=cancel]'); await C.click('#shelf button[value=cancel]');

  // ---- 読んだ跡は端末ごと、いま.md に端末名 ----
  for (const p of [A, B, C]) { await p.evaluate(() => scrollBy(0, 40)); await p.waitForTimeout(2600); }
  const logDir = Object.keys(files).find((k) => files[k].name === 'log' && (files[k].parents || []).includes(Object.keys(files).find((j) => files[j].name === bdir)));
  const logs = Object.values(files).filter((f) => (f.parents || []).includes(logDir) && !f.trashed).map((f) => f.name);
  const devs = await Promise.all([A, B, C].map((p) => p.evaluate(() => localStorage.getItem('ink:dev'))));
  console.log('logs', logs, devs);
  check('読んだ跡は端末ごとのファイル', new Set(devs).size === 3 && devs.every((d) => logs.some((n) => n.endsWith('_' + d + '.md'))));
  const nowT = (byPath('Ink Reader/いま.md') || { content: '' }).content.toString();
  check('いま.md に最後に使った端末の名前', nowT.includes('- 端末: ' + devs[2]));

  console.log('errs', errs); if (errs.length) ok = false;
  await b.close(); srv.close(); fs.rmSync(dir, { recursive: true, force: true });
  console.log(ok ? 'OK' : 'NG'); process.exit(ok ? 0 : 1);
})();
