// ドライブから本と書き込みをインポートする確認（Playwright）。ドライブ API はモックし、iPad ごとに新しいブラウザの環境を作る（GitHub は使わない）
// 使い方: node tests/restore.cjs
// 確認すること: iPad A で PDF と md を開いて書く（book.json に本の指紋）→ 同じファイルを開き直しても新しい本を作らない
// → 新しい iPad B で「ファイルから開く」→「ドライブの本」→「インポート」で本文と書き込みが入る（同じフォルダのまま。この端末にある本は「開く」）
// → iPad C で同じ PDF を「この端末のファイル」から開くとドライブの書き込みとつながる → 大きい PDF（book.pdf がない）は「ファイルを選ぶ」（違う PDF は断る）
// → 指紋のない前の版の book.json でも、PDF は題名とページの大きさ、md は題名と本文でつながる（指紋を足しておく）
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const APP = path.resolve(__dirname, '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8774);
let ok = true;
const check = (name, v, info) => { console.log(v ? '✓' : '✗', name, info === undefined ? '' : info); if (!v) ok = false; };
const { createDrive, GIS, FOLDER, connected } = require('./drive-mock.cjs');
const drv = createDrive(), { files, byPath } = drv;
(async () => {
  const b = await chromium.launch();
  // ファイル名は英字にする（Playwright で日本語の名前のファイルを渡すと change が来ない）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-restore-'));
  const mkPdf = async (name, n) => {
    const mk = await b.newPage();
    await mk.setContent(`<style>body{margin:0;font:32px serif} section{height:100vh;page-break-after:always;padding:40px;box-sizing:border-box}</style>` + [...Array(n)].map((_, i) => `<section><p>${name} ${i + 1}</p></section>`).join(''));
    await mk.pdf({ path: path.join(dir, name + '.pdf'), format: 'A4' }); await mk.close();
  };
  await mkPdf('lecture', 3); await mkPdf('other', 4);
  fs.writeFileSync(path.join(dir, 'note.md'), '# 線形代数ノート\n\n最初の段落。$x^2$\n\n二つ目の段落。\n\n三つ目の段落。\n');
  const errs = [];
  const iPad = async () => {
    const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true });
    await ctx.route('https://www.googleapis.com/**', drv.route);
    await ctx.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: GIS }));
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404|401/.test(m.text()) && errs.push(m.text()));
    await p.goto('http://localhost:8774/'); await p.evaluate((kv) => { for (const k in kv) localStorage.setItem(k, kv[k]); }, connected()); await p.reload(); await p.waitForTimeout(500);
    return p;
  };
  const strokes = (p) => p.evaluate(() => document.querySelectorAll('#ink path:not(.lasso)').length);
  const title = (p, t) => p.waitForFunction((t) => document.getElementById('chap-t').textContent.includes(t), t, { timeout: 20000 });
  const openFile = async (p, file, t) => {
    if (await p.isVisible('#empty')) await p.setInputFiles('#empty .open-file', path.join(dir, file));
    else { await p.click('#books'); await p.waitForFunction(() => document.getElementById('shelf').open); await p.setInputFiles('#shelf .open-file', path.join(dir, file)); }
    await title(p, t); await p.waitForTimeout(800);
  };
  const line = async (p, y) => { await p.mouse.move(200, y); await p.mouse.down(); for (let i = 0; i < 20; i++) await p.mouse.move(200 + i * 5, y + (i % 2) * 3); await p.mouse.up(); };
  const saved = (p) => p.waitForFunction(() => /ドライブに保存しました/.test(document.getElementById('stat').textContent), null, { timeout: 15000 }).catch(() => {});
  const books = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('ink-reader', 1); r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').get('books'); q.onsuccess = () => res(q.result || []); }; }));
  const folders = () => Object.values(files).filter((f) => f.mimeType === FOLDER && !f.trashed && (f.parents || []).includes(Object.keys(files).find((k) => files[k].name === 'Ink Reader'))).map((f) => f.name).sort();
  const json = (d) => JSON.parse(byPath('Ink Reader/' + d + '/book.json').content);
  // 「ファイルから開く」→ ドライブの本の一覧
  const opener = async (p) => {
    if (await p.isVisible('#empty')) await p.click('#empty label.pick');
    else { await p.click('#books'); await p.waitForFunction(() => document.getElementById('shelf').open); await p.click('#shelf label.pick'); }
    await p.waitForFunction(() => document.getElementById('opener').open && !/探して/.test(document.getElementById('op-msg').textContent), null, { timeout: 10000 });
    return p.$$eval('#op-dl li', (l) => l.map((x) => x.textContent));
  };

  // ---- iPad A: PDF と md を開いて書く ----
  const A = await iPad();
  await openFile(A, 'lecture.pdf', 'lecture');
  await line(A, await A.evaluate(() => document.querySelector('#doc > .pg[data-n="1"]').getBoundingClientRect().top + 200));
  await saved(A); await A.waitForTimeout(1500);
  await openFile(A, 'note.md', '線形代数');
  await line(A, await A.evaluate(() => { const el = document.querySelectorAll('#doc > *')[3]; el.scrollIntoView({ block: 'center' }); return el.getBoundingClientRect().top + 10; }));
  await saved(A); await A.waitForTimeout(1500);
  const dirs = folders(), pdfDir = dirs.find((d) => d.startsWith('lecture')), mdDir = dirs.find((d) => d.startsWith('線形代数'));
  console.log('folders', dirs);
  check('book.json に本の指紋', /^[0-9a-f]{24}$/.test(json(pdfDir).fp) && /^[0-9a-f]{24}$/.test(json(mdDir).fp));
  check('書き込みと PDF がドライブにある', !!byPath(`Ink Reader/${pdfDir}/ink/pdf.json`) && !!byPath(`Ink Reader/${pdfDir}/book.pdf`) && !!byPath(`Ink Reader/${mdDir}/ink/c1.json`));

  // 同じファイルを開き直しても、新しい本を作らない
  await openFile(A, 'lecture.pdf', 'lecture');
  check('同じ PDF を開き直すと前の本', (await books(A)).length === 2 && /前に開いた本/.test(await A.textContent('#stat')), await A.textContent('#stat'));
  check('書き込みもそのまま', await strokes(A) === 1);
  await openFile(A, 'note.md', '線形代数');
  check('同じ md を開き直すと前の本', (await books(A)).length === 2 && await strokes(A) === 1);
  const rowsA = await opener(A);
  check('この端末にある本は「開く」', rowsA.length === 2 && rowsA.every((t) => /開く$/.test(t)), rowsA);
  await A.click('#op-dl li:has-text("線形代数") .back'); await A.waitForTimeout(800);
  check('「開く」でその本に切り替わる', !(await A.evaluate(() => document.getElementById('opener').open || document.getElementById('shelf').open)) && /線形代数/.test(await A.textContent('#chap-t')));

  // ---- 新しい iPad B: 「ファイルから開く」→ ドライブの本 → インポート ----
  const B = await iPad();
  const rows = await opener(B);
  console.log('drive rows', rows);
  check('ドライブの本が出る', rows.length === 2 && rows.some((t) => /lecture（PDF・\d+KB）インポート/.test(t)) && rows.some((t) => /線形代数ノートインポート/.test(t)));
  check('この端末のファイルも選べる', await B.isVisible('#opener label.pick'));
  await B.click('#op-dl li:has-text("線形代数") .back');
  await title(B, '線形代数'); await B.waitForTimeout(2000);
  check('md をインポートすると書き込みも出る', await strokes(B) === 1 && /インポートしました/.test(await B.textContent('#stat')));
  check('md の本文も入る', /二つ目の段落/.test(await B.textContent('#doc')));
  const rows2 = await opener(B);
  check('インポートした本は「開く」になる', rows2.filter((t) => /開く$/.test(t)).length === 1 && rows2.some((t) => /lecture.*インポート$/.test(t)), rows2);
  await B.click('#op-dl li:has-text("lecture") .back');
  await title(B, 'lecture'); await B.waitForTimeout(2500);
  check('PDF をインポートすると書き込みも出る', await strokes(B) === 1 && await B.evaluate(() => document.querySelectorAll('#doc > .pg').length === 3));
  await line(B, await B.evaluate(() => { const el = document.querySelector('#doc > .pg[data-n="2"]'); el.scrollIntoView(); return el.getBoundingClientRect().top + 300; }));
  await saved(B); await B.waitForTimeout(1500);
  check('インポートした本に書くと、同じフォルダに送る', JSON.stringify(folders()) === JSON.stringify(dirs) && Object.keys(JSON.parse(byPath(`Ink Reader/${pdfDir}/ink/pdf.json`).content).blocks).sort().join() === '1,2');
  await B.waitForTimeout(2500);
  await B.click('#books'); await B.waitForTimeout(800);
  check('インポートした PDF にも表紙ができる', await B.evaluate(() => { const im = document.querySelector('#shelf-list .bk:first-child img'); return !!(im && im.naturalWidth); }));
  await B.click('#shelf button[value=cancel]');

  // ---- iPad C: 同じ PDF を「ファイルから開く」と、ドライブの書き込みとつながる ----
  const C = await iPad();
  await openFile(C, 'lecture.pdf', 'lecture'); await C.waitForTimeout(2000);
  check('ドライブの書き込みとつなぐ', /ドライブの書き込みとつなぎました/.test(await C.textContent('#stat')) || await strokes(C) === 2, await C.textContent('#stat'));
  check('書き込みが出る（A と B の分）', await strokes(C) === 2);
  check('新しいフォルダを作らない', JSON.stringify(folders()) === JSON.stringify(dirs) && !drv.twins());
  await openFile(C, 'other.pdf', 'other'); await C.waitForTimeout(2500);
  check('違う PDF は新しい本', await strokes(C) === 0 && folders().length === 3, folders());

  // ---- 大きい PDF（book.pdf を置いていない）: 「ファイルを選ぶ」。違う PDF は断る ----
  byPath(`Ink Reader/${pdfDir}/book.pdf`).trashed = true;
  const D = await iPad();
  await opener(D);
  const pick = '#op-dl li:has-text("lecture") .back';
  check('book.pdf がない PDF は「ファイルを選ぶ」', (await D.textContent(pick)) === 'ファイルを選ぶ');
  await D.setInputFiles(pick + ' input', path.join(dir, 'other.pdf')); await D.waitForTimeout(1500);
  check('違う PDF はインポートしない', /違う PDF/.test(await D.textContent('#op-msg')) && (await books(D)).length === 0, await D.textContent('#op-msg'));
  await D.setInputFiles(pick + ' input', path.join(dir, 'lecture.pdf'));
  await title(D, 'lecture'); await D.waitForTimeout(2500);
  check('元の PDF を選ぶと書き込みごと入る', await strokes(D) === 2);

  // ---- 指紋のない前の版の book.json でも、題名とページの大きさ・本文でつながる ----
  for (const d of [pdfDir, mdDir]) { const f = byPath(`Ink Reader/${d}/book.json`), j = JSON.parse(f.content); delete j.fp; f.content = Buffer.from(JSON.stringify(j)); f.version++; }
  const E = await iPad();
  await openFile(E, 'lecture.pdf', 'lecture'); await E.waitForTimeout(2000);
  check('前の版の PDF の本ともつながる', await strokes(E) === 2);
  await openFile(E, 'note.md', '線形代数'); await E.waitForTimeout(2000);
  check('前の版の md の本ともつながる', await strokes(E) === 1);
  check('つないだら book.json に指紋を足す', !!json(pdfDir).fp && !!json(mdDir).fp);
  check('最後まで新しいフォルダを作らない', folders().length === 3 && !drv.twins(), folders());

  console.log('errs', errs); if (errs.length) ok = false;
  await b.close(); srv.close(); fs.rmSync(dir, { recursive: true, force: true });
  console.log(ok ? 'OK' : 'NG'); process.exit(ok ? 0 : 1);
})();
