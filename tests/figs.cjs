// ファイルの md の図の確認（Playwright）。ドライブ API はモック（GitHub は使わない）
// 使い方: node tests/figs.cjs [スクリーンショットの出力先]
// 確認すること: md と一緒に図を選ぶと、md の ![説明](images/fig1.png)・![[fig2.png]] に図が出る（ファイル名だけで合わせる）
// → ウェブの画像はそのまま出る → ない図は名前を書いた枠 → 本棚の「…」の「ファイルを足す・入れ替える」で図を足すと出る
// → ドライブにつないだ A で開くと images/ と book.json に図が置かれ、B でインポートすると図も出る
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const APP = path.resolve(__dirname, '..'), OUT = process.argv[2] || os.tmpdir();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8783);
let ok = true;
const check = (name, v, info) => { console.log(v ? '✓' : '✗', name, info === undefined ? '' : typeof info === 'string' ? info : JSON.stringify(info)); if (!v) ok = false; };
const { createDrive, GIS, FOLDER, connected } = require('./drive-mock.cjs');
const drv = createDrive(), { files, byPath } = drv;
const MD = '# 図のノート\n\n図 1 です。\n\n![図1](images/fig1.png)\n\n図 2 です。\n\n![[fig2.png]]\n\nウェブの図。\n\n![ウェブ](https://example.com/web.png)\n\nない図。\n\n![なし](nofig.png)\n\nおわり。\n';

(async () => {
  const b = await chromium.launch();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-figs-'));
  // 図を作る（大きさの違う 3 枚）
  const mk = await b.newPage();
  for (const [n, w, h, c] of [['fig1.png', 300, 200, 'red'], ['fig2.png', 240, 120, 'blue'], ['nofig.png', 200, 100, 'green'], ['web.png', 160, 80, 'orange']]) {
    await mk.setContent(`<body style="margin:0"><div style="width:${w}px;height:${h}px;background:${c}"></div></body>`);
    await mk.locator('div').screenshot({ path: path.join(dir, n) });
  }
  await mk.close();
  fs.writeFileSync(path.join(dir, 'figs.md'), MD);
  const errs = [];
  const device = async (on) => {
    const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1, hasTouch: true });
    await ctx.route('https://www.googleapis.com/**', drv.route);
    await ctx.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: GIS }));
    await ctx.route('https://example.com/web.png', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: fs.readFileSync(path.join(dir, 'web.png')) }));
    const p = await ctx.newPage(); p.ctx = ctx;
    p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404|401|ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(m.text()) && errs.push(m.text()));
    await p.goto('http://localhost:8783/');
    if (on) { await p.evaluate((kv) => { for (const k in kv) localStorage.setItem(k, kv[k]); }, connected()); await p.reload(); }
    await p.waitForTimeout(400);
    return p;
  };
  const title = (p, t) => p.waitForFunction((t) => document.getElementById('chap-t').textContent.includes(t), t, { timeout: 20000 });
  const figs = (p) => p.evaluate(() => [...document.querySelectorAll('#doc img')].map((im) => ({ k: im.dataset.img || im.getAttribute('src'), w: im.naturalWidth, miss: im.classList.contains('miss') })));
  const wait = async (fn, ms = 15000) => { for (let t = 0; t < ms && !await fn(); t += 200) await new Promise((r) => setTimeout(r, 200)); return fn(); };

  // ---- 1. md と図を一緒に選ぶ ----
  const L = await device(false);
  await L.setInputFiles('#empty .open-file', ['figs.md', 'fig1.png', 'fig2.png'].map((n) => path.join(dir, n)));
  await title(L, '図のノート'); await L.waitForTimeout(1200);
  let f = await figs(L);
  const by = (k) => f.find((x) => x.k === k) || {};
  check('md の ![](images/fig1.png) に図が出る（ファイル名で合わせる）', by('fig1.png').w === 300 && !by('fig1.png').miss, f);
  check('![[fig2.png]] にも図が出る', by('fig2.png').w === 240 && !by('fig2.png').miss);
  check('ウェブの図はそのまま', by('https://example.com/web.png').w === 160);
  check('ない図は名前を書いた枠', by('nofig.png').miss === true);
  await L.screenshot({ path: path.join(OUT, 'figs-md.png') });
  const books = await L.evaluate(() => new Promise((res) => { const r = indexedDB.open('ink-reader', 1); r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').get('books'); q.onsuccess = () => res(q.result); }; }));
  check('本は 1 冊（図は章にならない）', books.length === 1, books.map((x) => x.title));
  // 本棚の「…」から足りない図を足す
  await L.click('#books'); await L.waitForTimeout(300);
  await L.click('#shelf .bk .bk-m'); await L.waitForTimeout(200);
  const [fc] = await Promise.all([L.waitForEvent('filechooser'), L.click('#bk-add')]);
  await fc.setFiles(path.join(dir, 'nofig.png'));
  await L.waitForFunction(() => /図を1つ入れ/.test(document.getElementById('stat').textContent), null, { timeout: 10000 }).catch(() => {});
  await L.waitForTimeout(800);
  f = await figs(L);
  check('足した図が出る', by('nofig.png').w === 200 && !by('nofig.png').miss, [f, await L.textContent('#stat')]);
  await L.reload(); await L.waitForTimeout(1500);
  f = await figs(L);
  check('開き直しても図が出る', ['fig1.png', 'fig2.png', 'nofig.png'].every((k) => by(k).w > 0 && !by(k).miss), f);
  await L.ctx.close();

  // ---- 2. ドライブにつないだ 2 台 ----
  const A = await device(true);
  await A.setInputFiles('#empty .open-file', ['figs.md', 'fig1.png', 'fig2.png'].map((n) => path.join(dir, n)));
  await title(A, '図のノート'); await A.waitForTimeout(800);
  // 何か書くと本がドライブに置かれる
  const y = await A.evaluate(() => { const el = document.querySelectorAll('#doc > p')[1]; const r = el.getBoundingClientRect(); return r.top + r.height / 2; });
  await A.mouse.move(200, y); await A.mouse.down(); for (let i = 0; i < 15; i++) await A.mouse.move(200 + i * 6, y + (i % 2) * 2); await A.mouse.up();
  const root = () => Object.keys(files).find((k) => files[k].name === 'Ink Reader' && files[k].mimeType === FOLDER);
  const folders = () => Object.values(files).filter((x) => x.mimeType === FOLDER && !x.trashed && (x.parents || []).includes(root())).map((x) => x.name);
  const bdir = await wait(() => folders().find((x) => x.startsWith('図のノート')));
  await wait(() => byPath(`Ink Reader/${bdir}/images/fig2.png`) && byPath(`Ink Reader/${bdir}/book.json`));
  const bj = JSON.parse(byPath(`Ink Reader/${bdir}/book.json`).content);
  check('ドライブに図と大きさが置かれる', !!byPath(`Ink Reader/${bdir}/images/fig1.png`) && !!byPath(`Ink Reader/${bdir}/images/fig2.png`) && JSON.stringify(bj.images) === JSON.stringify({ 'fig1.png': [300, 200], 'fig2.png': [240, 120] }), bj.images);
  const B = await device(true);
  await B.click('#empty label.pick');
  await B.waitForFunction(() => document.querySelector('#op-dl li .back'), null, { timeout: 10000 });
  await B.click('#op-dl li:has-text("図のノート") .back');
  await title(B, '図のノート'); await B.waitForTimeout(2000);
  f = await figs(B);
  check('B でインポートすると図も出る', by('fig1.png').w === 300 && by('fig2.png').w === 240 && !by('fig1.png').miss, f);
  // A で図を足すと、B もアプリに戻ると取り込む
  await A.click('#books'); await A.waitForTimeout(300);
  await A.click('#shelf .bk .bk-m'); await A.waitForTimeout(200);
  const [fc2] = await Promise.all([A.waitForEvent('filechooser'), A.click('#bk-add')]);
  await fc2.setFiles(path.join(dir, 'nofig.png'));
  await wait(() => byPath(`Ink Reader/${bdir}/images/nofig.png`) && /nofig/.test(byPath(`Ink Reader/${bdir}/book.json`).content));
  await B.waitForTimeout(10500); await B.evaluate(() => dispatchEvent(new Event('focus')));
  await wait(async () => { f = await figs(B); return by('nofig.png').w === 200; }, 10000);
  check('A で足した図を B も取り込む', by('nofig.png').w === 200 && !by('nofig.png').miss, f);

  check('エラーなし', !errs.length, errs);
  await b.close(); srv.close(); process.exit(ok ? 0 : 1);
})();
