// 余白の確認（Playwright）。md を「ファイルから開く」で開き、投げ縄のメニューから余白を入れて書き、消す。GitHub は使わない。
// 使い方: node tests/gap.cjs [スクリーンショットの出力先]
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const APP = path.resolve(__dirname, '..'), OUT = process.argv[2] || os.tmpdir();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8769);
(async () => {
  const b = await chromium.launch();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-gap-'));
  fs.writeFileSync(path.join(dir, 'gap.md'), '# 余白のテスト\n\n' + [...Array(12)].map((_, i) => `段落${i + 1}。$x^${i}$ の式を含む本文です。`).join('\n\n'));
  const mk = await b.newPage();
  await mk.setContent('<style>body{margin:0;font:28px serif} section{height:100vh;page-break-after:always;padding:40px;box-sizing:border-box}</style>' + [1, 2, 3].map((i) => `<section>page ${i}</section>`).join(''));
  await mk.pdf({ path: path.join(dir, 'gap.pdf'), format: 'A4' }); await mk.close();

  const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404/.test(m.text()) && errs.push(m.text()));
  await p.goto('http://localhost:8769/'); await p.waitForTimeout(300);
  const lasso = async (x0, y0, x1, y1) => { await p.click('#t-ls'); await p.mouse.move(x0, y0); await p.mouse.down(); for (const q of [[x1, y0], [x1, y1], [x0, y1], [x0, y0 + 2]]) for (let k = 1; k <= 5; k++) await p.mouse.move(q[0], q[1]); await p.mouse.up(); };
  const line = async (x, y) => { await p.click('#t-pen'); await p.mouse.move(x, y); await p.mouse.down(); for (let i = 0; i < 20; i++) await p.mouse.move(x + i * 5, y + (i % 2) * 3); await p.mouse.up(); };
  const nStrokes = () => p.evaluate(() => document.querySelectorAll('#ink path:not(.lasso)').length);
  const rect = (sel) => p.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [Math.round(r.top), Math.round(r.bottom)]; }, sel);
  const savedGaps = () => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('ink-reader', 1); r.onsuccess = () => { const s = r.result.transaction('kv').objectStore('kv'); const q = s.getAllKeys(); q.onsuccess = () => { const k = q.result.filter((x) => /^ink:local:/.test(x)).pop(); const g = s.get(k); g.onsuccess = () => res(Object.values(g.result.blocks).filter((x) => x.gap).map((x) => [x.b, x.gap, Object.keys(x.strokes).length])); }; }; }));

  for (const [file, pg] of [['gap.md', false]]) {   // PDF の白紙はページの一覧から（tests/pdf.cjs）
    console.log('---', file);
    await p.setInputFiles(pg ? '#shelf .open-file' : '#empty .open-file', path.join(dir, file));
    if (pg) await p.waitForFunction(() => document.querySelector('#doc > .pg canvas')); else await p.waitForFunction(() => document.querySelectorAll('#doc > p').length > 10);
    await p.waitForTimeout(500);
    const A = pg ? '#doc > .pg[data-n="1"]' : '#doc > p:nth-of-type(3)', B = pg ? '#doc > .pg[data-n="2"]' : '#doc > p:nth-of-type(4)';
    await p.evaluate((s) => document.querySelector(s).scrollIntoView(), A); await p.evaluate(() => scrollBy(0, -150));
    const [aTop, aBot] = await rect(A), b0 = (await rect(B))[0];
    await lasso(120, aTop + 5, 700, Math.min(aBot - 5, aTop + 300));
    console.log('menu', await p.textContent('#sel-n'), 'gap', await p.isVisible('#sel-gap') && await p.textContent('#sel-gap'), 'ungap', await p.isVisible('#sel-ungap'));
    await p.click('#sel-gap'); await p.waitForTimeout(300);
    const b1 = (await rect(B))[0];
    console.log('insert', await p.textContent('#stat'), 'next moved', b1 - b0);
    // 余白（白紙）に書く。余白の真ん中を画面の真ん中に出す
    const mid = async () => { await p.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); scrollBy(0, r.top - 600); }, B); return 600 - Math.min(250, (b1 - b0) / 2 - 30); };
    const gy = await mid(); await p.waitForTimeout(400);
    await line(250, gy);
    await p.waitForTimeout(400);
    console.log('strokes', await nStrokes(), 'saved [段落, gap, 線]', JSON.stringify(await savedGaps()));
    await p.screenshot({ path: path.join(OUT, `gap-${pg ? 'pdf' : 'md'}.png`) });
    await p.reload(); await p.waitForTimeout(1500);
    await p.evaluate((s) => document.querySelector(s).scrollIntoView(), A); await p.evaluate(() => scrollBy(0, -150));
    console.log('reload: next moved', (await rect(B))[0] - (await rect(A))[0] - (b0 - aTop), 'strokes', await nStrokes());
    // 余白を囲むと「消す」が出る → 消すと書いた線も消え、戻すで戻る
    const gy2 = await mid(); await p.waitForTimeout(300);
    await lasso(120, gy2 - 60, 700, gy2 + 60);
    console.log('ungap shown', await p.isVisible('#sel-ungap'), await p.textContent('#sel-ungap'), await p.textContent('#sel-n'), await p.textContent('#stat'), gy2, await rect(A), await rect(B));
    await p.click('#sel-ungap'); await p.waitForTimeout(300);
    console.log('removed', await p.textContent('#stat'), 'strokes', await nStrokes(), 'gap', (await rect(B))[0] - (await rect(A))[0] - (b0 - aTop));
    await p.click('#undo'); await p.waitForTimeout(300);
    console.log('undo', 'strokes', await nStrokes(), 'gap', (await rect(B))[0] - (await rect(A))[0] - (b0 - aTop));
    await p.click('#sel-x').catch(() => {});
    await p.click('#books');
  }
  await p.click('#shelf button[value=cancel]');
  console.log('errs', errs); await b.close(); srv.close(); process.exit(errs.length ? 1 : 0);
})();
