// 横線で入れる余白の確認（Playwright）。md と PDF を「ファイルから開く」で開き、投げ縄で横線を引いて余白を入れ、
// 書く・たたむ・開く・高さを変える・消す・戻す・再読み込みを確かめる。GitHub は使わない。
// 使い方: node tests/space.cjs [スクリーンショットの出力先]
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const APP = path.resolve(__dirname, '..'), OUT = process.argv[2] || os.tmpdir();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8770);
(async () => {
  const b = await chromium.launch();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-space-'));
  fs.writeFileSync(path.join(dir, 'sp.md'), '# 余白のテスト\n\n' + [...Array(12)].map((_, i) => `段落${i + 1}。$x^${i}$ の式を含む本文です。`.repeat(3)).join('\n\n'));
  const mk = await b.newPage();
  await mk.setContent('<style>body{margin:0;font:28px serif} section{height:100vh;page-break-after:always;padding:40px;box-sizing:border-box} p{margin:0 0 30px}</style>' + [1, 2, 3].map((i) => `<section>${[...Array(12)].map((_, j) => `<p>page ${i} line ${j + 1}</p>`).join('')}</section>`).join(''));
  await mk.pdf({ path: path.join(dir, 'sp.pdf'), format: 'A4' }); await mk.close();

  const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true, colorScheme: process.env.DARK ? 'dark' : 'light' });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404/.test(m.text()) && errs.push(m.text()));
  await p.goto('http://localhost:8770/'); await p.waitForTimeout(300);
  const tool = (t) => p.click(t);
  const hline = async (x0, x1, y) => { await tool('#t-ls'); await p.mouse.move(x0, y); await p.mouse.down(); for (let i = 1; i <= 20; i++) await p.mouse.move(x0 + (x1 - x0) * i / 20, y + (i % 3) - 1); await p.mouse.up(); await p.waitForTimeout(300); };
  const lasso = async (x0, y0, x1, y1) => { await tool('#t-ls'); await p.mouse.move(x0, y0); await p.mouse.down(); for (const q of [[x1, y0], [x1, y1], [x0, y1], [x0, y0 + 2]]) for (let k = 1; k <= 5; k++) await p.mouse.move(q[0], q[1]); await p.mouse.up(); await p.waitForTimeout(200); };
  const line = async (x, y) => { await tool('#t-pen'); await p.mouse.move(x, y); await p.mouse.down(); for (let i = 0; i < 20; i++) await p.mouse.move(x + i * 5, y + (i % 2) * 3); await p.mouse.up(); await p.waitForTimeout(200); };
  const top = (sel) => p.evaluate((s) => Math.round(document.querySelector(s).getBoundingClientRect().top), sel);
  // 線の上端（紙の px、ページ（md は #doc）の上端から）。隠れている線は 'hid'
  const ink = () => p.evaluate(() => { const r = document.querySelector('#page').getBoundingClientRect(), k = r.width / 680; return [...document.querySelectorAll('#ink path:not(.lasso)')].map((e) => e.style.display === 'none' ? 'hid' : Math.round((e.getBoundingClientRect().top - r.top) / k)); });
  const handle = (fold) => p.evaluate((f) => { const k = document.querySelector('#sps .sph' + (f ? '.fold' : ':not(.fold)')); if (!k) return null; const r = k.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2), k.textContent]; }, fold);
  const tap = async ([x, y]) => { await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.up(); await p.waitForTimeout(300); };
  const drag = async ([x, y], dy) => { await p.mouse.move(x, y); await p.mouse.down(); await p.waitForTimeout(450); for (let i = 1; i <= 10; i++) await p.mouse.move(x, y + dy * i / 10); await p.mouse.up(); await p.waitForTimeout(300); };
  const saved = () => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('ink-reader', 1); r.onsuccess = () => { const s = r.result.transaction('kv').objectStore('kv'); const q = s.getAllKeys(); q.onsuccess = () => { const k = q.result.filter((x) => /^ink:local:/.test(x)).pop(); const g = s.get(k); g.onsuccess = () => res(Object.values(g.result.blocks).filter((x) => x.gap || x.sp).map((x) => ({ b: x.b, gap: x.gap, fold: x.fold, sp: x.sp, n: Object.keys(x.strokes).length }))); }; }; }));
  const scale = () => p.evaluate(() => document.querySelector('#page').getBoundingClientRect().width / 680);

  for (const [file, pg] of [['sp.md', false], ['sp.pdf', true]]) {
    console.log('---', file);
    await p.setInputFiles(pg ? '#shelf .open-file' : '#empty .open-file', path.join(dir, file));
    if (pg) await p.waitForFunction(() => document.querySelector('#doc > .pg canvas')); else await p.waitForFunction(() => document.querySelectorAll('#doc > p').length > 10);
    await p.waitForTimeout(600);
    const k = await scale();
    const A = pg ? '#doc > .pg[data-n="1"]' : '#doc > p:nth-of-type(3)', B = pg ? '#doc > .pg[data-n="2"]' : '#doc > p:nth-of-type(4)';
    await p.evaluate((s) => { document.querySelector(s).scrollIntoView(); scrollBy(0, -150); }, A);
    const a0 = await top(A), b0 = await top(B);
    // PDF はページの下の方に先に書いておく（余白を入れると一緒に下がる）
    if (pg) await line(200, a0 + 700 * k);
    const ink0 = await ink();
    const ly = pg ? a0 + 300 * k : a0 + (b0 - a0) * .8;
    await hline(100, 600, ly);
    const b1 = await top(B), ink1 = await ink();
    console.log('line', await p.textContent('#stat'), 'next moved', Math.round((b1 - b0) / k), 'ink', ink0, '->', ink1, 'pieces', pg ? await p.evaluate(() => document.querySelectorAll('#doc > .pg[data-n="1"] canvas').length) : '-', 'sel', await p.isVisible('#selmenu'));
    // 余白に書く
    const h = await handle(false);
    await line(250, h[1] - 100 * k);
    console.log('wrote', JSON.stringify(await saved()));
    await p.screenshot({ path: path.join(OUT, `space-${pg ? 'pdf' : 'md'}.png`) });
    // つまみを押すとたたむ
    await tap(await handle(false));
    const f = await handle(true);
    console.log('fold', f && f[2], 'next moved', Math.round((await top(B) - b0) / k), 'ink', await ink(), JSON.stringify(await saved()));
    await p.screenshot({ path: path.join(OUT, `space-${pg ? 'pdf' : 'md'}-fold.png`) });
    // たたんだまま下に書いて、開いても位置が合っていること
    await line(250, f[1] + 60 * k);
    const inkF = await ink();
    await p.reload(); await p.waitForTimeout(pg ? 1500 : 1000);
    await p.evaluate((s) => { document.querySelector(s).scrollIntoView(); scrollBy(0, -150); }, A);
    console.log('reload', 'fold', !!(await handle(true)), 'next moved', Math.round((await top(B) - (await top(A)) - (b0 - a0)) / k), 'ink', inkF, '->', await ink());
    const f2 = await handle(true);
    await tap(f2);
    console.log('open', !!(await handle(false)), 'ink', await ink(), 'next moved', Math.round((await top(B) - (await top(A)) - (b0 - a0)) / k));
    // 長押しして下に動かすと高さが変わる
    const h2 = await handle(false), bb = await top(B);
    await drag(h2, 100 * k);
    console.log('resize', await p.textContent('#stat'), 'next moved', Math.round((await top(B) - bb) / k), 'ink', await ink(), JSON.stringify(await saved()));
    await p.click('#undo'); await p.waitForTimeout(300);
    console.log('undo', 'next moved', Math.round((await top(B) - bb) / k), 'ink', await ink());
    // 上まで縮めても、中の線より上には縮まない
    const h3 = await handle(false);
    await drag(h3, -400 * k);
    console.log('shrink', 'next moved', Math.round((await top(B) - bb) / k), JSON.stringify(await saved()));
    await p.click('#undo'); await p.waitForTimeout(300);
    // 投げ縄で余白を囲むと「余白を消す」
    const h4 = await handle(false);
    await lasso(120, h4[1] - 120 * k, 600, h4[1] - 30 * k);
    console.log('ungap', await p.isVisible('#sel-ungap'));
    await p.click('#sel-ungap'); await p.waitForTimeout(300);
    console.log('removed', 'next', Math.round((await top(B) - (await top(A)) - (b0 - a0)) / k), 'ink', await ink(), JSON.stringify(await saved()));
    await p.click('#undo'); await p.waitForTimeout(300);
    console.log('undo', 'next', Math.round((await top(B) - (await top(A)) - (b0 - a0)) / k), 'ink', await ink());
    await p.click('#sel-x').catch(() => {});
    if (pg) {   // 拡大したときの細かい絵（hd）も余白で切って並べる
      await p.selectOption('#zoomv', '3'); await p.waitForTimeout(300);
      await p.evaluate(() => { const r = document.querySelector('.sph').getBoundingClientRect(); scrollBy(0, r.top - 500); }); await p.waitForTimeout(2500);
      console.log('zoom hd', await p.evaluate(() => [...document.querySelectorAll('#doc > .pg[data-n="1"] canvas.hd')].map((c) => c.style.top + '/' + c.style.height)));
      await p.screenshot({ path: path.join(OUT, 'space-pdf-zoom.png') });
      // 線が細かい絵の下に隠れていないこと（線のある点で、いちばん上にあるもの）
      console.log('ink on top', await p.evaluate(() => { const ink = document.querySelector('#ink'); ink.style.pointerEvents = 'auto'; const out = [...ink.querySelectorAll('path:not(.lasso)')].map((e) => { const r = e.getBoundingClientRect(), y = r.top + r.height / 2, x = Math.max(5, Math.min(innerWidth - 5, r.left + r.width / 2)); if (y < 0 || y > innerHeight) return 'off'; return document.elementsFromPoint(x, y).slice(0, 2).map((t) => t.tagName.toLowerCase() + (t.classList.length ? '.' + t.classList[0] : '')).join(' > '); }); ink.style.pointerEvents = ''; return out; }));
      await p.selectOption('#zoomv', 'fit'); await p.waitForTimeout(300);
    }
    await p.click('#books');
  }
  await p.click('#shelf button[value=cancel]');
  console.log('errs', errs); await b.close(); srv.close(); process.exit(errs.length ? 1 : 0);
})();
