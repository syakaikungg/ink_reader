// 長押しで余白を入れる・長押しのメニューの確認（Playwright）。md と PDF を「ファイルから開く」で開き、
// ペンで横線を引いてその線をペンで長押し（離さずに上下で高さ・上まで縮めるとやめる・戻す1回で戻る）、
// 指で長押しして出るメニュー（しおり・ここに余白・方眼・余白を消す・白紙）、たたんだ余白の札を確かめる。GitHub は使わない。
// 使い方: node tests/hold.cjs [スクリーンショットの出力先]
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const APP = path.resolve(__dirname, '..'), OUT = process.argv[2] || os.tmpdir();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8779);
(async () => {
  const b = await chromium.launch();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-hold-'));
  fs.writeFileSync(path.join(dir, 'hold.md'), '# 長押しのテスト\n\n' + [...Array(12)].map((_, i) => `段落${i + 1}。$x^${i}$ の式を含む本文です。`.repeat(3)).join('\n\n'));
  const mk = await b.newPage();
  await mk.setContent('<style>body{margin:0;font:28px serif} section{height:100vh;page-break-after:always;padding:40px;box-sizing:border-box} p{margin:0 0 30px}</style>' + [1, 2, 3].map((i) => `<section>${[...Array(12)].map((_, j) => `<p>page ${i} line ${j + 1}</p>`).join('')}</section>`).join(''));
  await mk.pdf({ path: path.join(dir, 'hold.pdf'), format: 'A4' }); await mk.close();

  const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true, colorScheme: process.env.DARK ? 'dark' : 'light' });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404/.test(m.text()) && errs.push(m.text()));
  await p.goto('http://localhost:8779/'); await p.waitForTimeout(300);
  const cdp = await ctx.newCDPSession(p);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  const press = async (x, y, ms = 700) => { await touch('touchStart', [[x, y]]); await p.waitForTimeout(ms); await touch('touchEnd', []); await p.waitForTimeout(200); };
  const menu = () => p.evaluate(() => document.querySelector('#pmenu').hidden ? null : [...document.querySelectorAll('#pmenu button')].filter((x) => !x.hidden).map((x) => x.textContent));
  const hline = async (x0, x1, y) => { await p.click('#t-pen'); await p.mouse.move(x0, y); await p.mouse.down(); for (let i = 1; i <= 20; i++) await p.mouse.move(x0 + (x1 - x0) * i / 20, y + (i % 3) - 1); await p.mouse.up(); await p.waitForTimeout(200); };
  // ペンで押さえて ms 待ち、dy だけ動かして離す
  const hold = async (x, y, ms, dy = 0) => { await p.mouse.move(x, y); await p.mouse.down(); await p.waitForTimeout(ms); for (let i = 1; i <= 10; i++) await p.mouse.move(x, y + dy * i / 10); await p.mouse.up(); await p.waitForTimeout(300); };
  const top = (sel) => p.evaluate((s) => Math.round(document.querySelector(s).getBoundingClientRect().top), sel);
  const nInk = () => p.evaluate(() => document.querySelectorAll('#ink path:not(.lasso)').length);
  const handle = (fold) => p.evaluate((f) => { const k = document.querySelector('#sps .sph' + (f ? '.fold' : ':not(.fold)')); if (!k) return null; const r = k.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2), k.textContent, k.getAttribute('aria-label')]; }, fold);
  const saved = () => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('ink-reader', 1); r.onsuccess = () => { const s = r.result.transaction('kv').objectStore('kv'); const q = s.getAllKeys(); q.onsuccess = () => { const k = q.result.filter((x) => /^ink:local:/.test(x)).pop(); if (!k) return res([]); const g = s.get(k); g.onsuccess = () => res(Object.values(g.result.blocks).filter((x) => x.gap || x.sp || x.gr).map((x) => ({ b: x.b, gap: x.gap, sp: x.sp, gr: x.gr, n: Object.keys(x.strokes).length }))); }; }; }));
  const scale = () => p.evaluate(() => document.querySelector('#page').getBoundingClientRect().width / 680);
  const stat = () => p.textContent('#stat');

  // ---------- md ----------
  console.log('--- md');
  await p.setInputFiles('#empty .open-file', path.join(dir, 'hold.md'));
  await p.waitForFunction(() => document.querySelectorAll('#doc > p').length > 10); await p.waitForTimeout(600);
  const k = await scale(), A = '#doc > p:nth-of-type(3)', B = '#doc > p:nth-of-type(4)';
  await p.evaluate((s) => { document.querySelector(s).scrollIntoView(); scrollBy(0, -150); }, A);
  const a0 = await top(A), b0 = await top(B), ly = a0 + (b0 - a0) * .8;
  const moved = async () => Math.round((await top(B) - (await top(A)) - (b0 - a0)) / k);

  // 1. 横線を引いて、その線をペンで長押し → 線が消えて余白（離さずに下へ 100 動かすと 300）
  await hline(100, 600, ly);
  const n0 = await nInk();
  await hold(350, ly, 750, 100 * k);
  console.log('hold+drag', await stat(), 'next moved', await moved(), 'ink', n0, '->', await nInk(), JSON.stringify(await saved()));
  await p.screenshot({ path: path.join(OUT, 'hold-md.png') });
  await p.click('#undo'); await p.waitForTimeout(300);
  console.log('undo once', 'next moved', await moved(), 'ink', await nInk(), 'undo left', !(await p.isDisabled('#undo')));
  await p.click('#redo'); await p.waitForTimeout(300);
  console.log('redo', 'next moved', await moved(), 'ink', await nInk());
  await p.click('#undo'); await p.waitForTimeout(300);
  await p.click('#undo'); await p.waitForTimeout(300);   // 横線も消す
  console.log('cleared', 'ink', await nInk());
  // 2. 動かさずに離すと 200
  await hline(100, 600, ly); await hold(350, ly, 750);
  console.log('hold', 'next moved', await moved(), 'ink', await nInk());
  await p.click('#undo'); await p.waitForTimeout(300); await p.click('#undo'); await p.waitForTimeout(300);
  // 3. 押さえたまま上まで縮めると、やめて線が残る
  await hline(100, 600, ly); await hold(350, ly, 750, -300 * k);
  console.log('cancel', await stat(), 'next moved', await moved(), 'ink', await nInk(), 'undo stack ok', await p.evaluate(() => !document.querySelector('#undo').disabled));
  await p.click('#undo'); await p.waitForTimeout(300);
  // 4. 短く押さえただけ（点を書く）・最後の線が短いと入らない
  await hline(100, 600, ly); await hold(350, ly, 250);
  console.log('short', 'next moved', await moved(), 'ink', await nInk());
  await p.click('#undo'); await p.waitForTimeout(200);
  await hline(100, 300, ly - 60);   // 短い線（紙の 1/3 未満）が最後
  await hold(350, ly, 750);
  console.log('not last', 'next moved', await moved(), 'ink', await nInk());
  for (let i = 0; i < 3; i++) { await p.click('#undo'); await p.waitForTimeout(200); }
  console.log('cleared', 'ink', await nInk(), 'next moved', await moved());

  // 5. 指で長押し → メニュー → 「ここに余白を入れる」
  await press(400, ly);
  console.log('menu', JSON.stringify(await menu()));
  await p.screenshot({ path: path.join(OUT, 'hold-menu-md.png') });
  await p.click('#pm-gap'); await p.waitForTimeout(300);
  console.log('menu gap', await stat(), 'next moved', await moved(), 'menu closed', await menu() === null);
  // 余白の上で長押し → 方眼・余白を消す
  const h = await handle(false);
  await press(400, h[1] - 80 * k);
  console.log('menu on space', JSON.stringify(await menu()));
  await p.screenshot({ path: path.join(OUT, 'hold-menu-space.png') });
  await p.click('#pm-grid'); await p.waitForTimeout(300);
  console.log('grid', await stat(), JSON.stringify(await saved()));
  // たたむ → 札（上下の矢印）
  await p.mouse.click(h[0], h[1]); await p.waitForTimeout(300);
  const f = await handle(true);
  console.log('fold', JSON.stringify(f));
  await p.screenshot({ path: path.join(OUT, 'hold-fold.png'), clip: { x: 0, y: f[1] - 120, width: 820, height: 240 } });
  await p.mouse.click(f[0], f[1]); await p.waitForTimeout(300);
  console.log('open again', !!(await handle(false)));
  const h2 = await handle(false);
  await press(400, h2[1] - 80 * k);
  await p.click('#pm-del'); await p.waitForTimeout(300);
  console.log('del', await stat(), 'next moved', await moved(), JSON.stringify(await saved()));
  // しおり
  await press(400, a0 + 20);
  await p.click('#pm-bm'); await p.waitForTimeout(200);
  console.log('bookmark', await stat(), await p.evaluate(() => [...document.querySelectorAll('#doc > *')].findIndex((e) => e.classList.contains('bm'))));
  await press(400, a0 + 20);
  console.log('menu bm', JSON.stringify(await menu()));
  // メニューの外をペンで触って閉じても、点は書かない
  const n1 = await nInk();
  await p.click('#t-ls');
  console.log('closed by tool button', await menu() === null);
  await p.click('#t-pen'); await p.waitForTimeout(400);
  await press(400, a0 + 20);
  console.log('open', await menu() !== null);
  await p.mouse.click(300, a0 + 200); await p.waitForTimeout(200);
  console.log('close by pen', await menu() === null, 'ink', n1, '->', await nInk());
  // 指で書くがオンのときは出ない
  await p.evaluate(() => document.querySelector('#finger').click()); await p.waitForTimeout(100);
  await press(400, a0 + 20);
  console.log('finger mode menu', await menu());
  await p.evaluate(() => document.querySelector('#finger').click()); await p.waitForTimeout(100);
  await p.click('#books');

  // ---------- PDF ----------
  console.log('--- pdf');
  await p.setInputFiles('#shelf .open-file', path.join(dir, 'hold.pdf'));
  await p.waitForFunction(() => document.querySelector('#doc > .pg canvas')); await p.waitForTimeout(800);
  const P1 = '#doc > .pg[data-n="1"]', P2 = '#doc > .pg[data-n="2"]';
  await p.evaluate((s) => { document.querySelector(s).scrollIntoView(); scrollBy(0, -150); }, P1);
  const q0 = await top(P1), r0 = await top(P2);
  const pmoved = async () => Math.round((await top(P2) - (await top(P1)) - (r0 - q0)) / k);
  await hline(100, 600, q0 + 300 * k);
  await hold(350, q0 + 300 * k, 750, 50 * k);
  console.log('pdf hold+drag', await stat(), 'next moved', await pmoved(), 'ink', await nInk(), JSON.stringify(await saved()));
  await p.screenshot({ path: path.join(OUT, 'hold-pdf.png') });
  await press(400, q0 + 150 * k);
  console.log('pdf menu', JSON.stringify(await menu()));
  await p.click('#pm-blank'); await p.waitForTimeout(400);
  console.log('blank', await stat(), 'next moved', await pmoved(), JSON.stringify(await saved()));
  // 白紙の上で長押し
  const by = await p.evaluate((s) => { const r = document.querySelector(s + ' .blank').getBoundingClientRect(); scrollBy(0, r.top - 300); return 500; }, P1);
  await p.waitForTimeout(400);
  await press(400, by);
  console.log('pdf menu on blank', JSON.stringify(await menu()));
  await p.click('#pm-del'); await p.waitForTimeout(400);
  console.log('blank del', await stat(), 'next moved', await pmoved(), JSON.stringify(await saved()));
  await p.click('#books');
  await p.click('#shelf button[value=cancel]');
  console.log('errs', errs); await b.close(); srv.close(); process.exit(errs.length ? 1 : 0);
})();
