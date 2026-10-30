// 方眼と「前に白紙を入れる」の確認（Playwright。GitHub とドライブは使わない）
// 使い方: node tests/grid.cjs [スクリーンショットの出力先]
// 確認すること: md の余白の右上の「方眼」を押すと方眼になり（線の下）、書き込み JSON に gr、開き直しても方眼 → もう一度押すと無地
// → PDF の白紙も「方眼」で方眼（縮小画像も）→ ページの途中の余白も方眼 → ページの一覧の「…」の「前に白紙を入れる」（1ページ目は出さない）
// → 書き出した PDF の白紙に方眼の線が入る（pypdf があれば、白紙のページの線の数を数える）
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os'), { execFileSync } = require('child_process');
const APP = path.resolve(__dirname, '..'), OUT = process.argv[2] || os.tmpdir();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8778);
let ok = true;
const check = (name, v, info) => { console.log(v ? '✓' : '✗', name, info === undefined ? '' : JSON.stringify(info)); if (!v) ok = false; };

(async () => {
  const b = await chromium.launch();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-grid-'));
  fs.writeFileSync(path.join(dir, 'gr.md'), '# 方眼のテスト\n\n' + [...Array(10)].map((_, i) => `段落${i + 1}。$x^${i}$ の式を含む本文です。`.repeat(3)).join('\n\n'));
  const mk = await b.newPage();
  await mk.setContent('<style>body{margin:0;font:28px serif} section{height:100vh;page-break-after:always;padding:40px;box-sizing:border-box}</style>' + [1, 2, 3].map((i) => `<section>page ${i}</section>`).join(''));
  await mk.pdf({ path: path.join(dir, 'gr.pdf'), format: 'A4' }); await mk.close();

  const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true, acceptDownloads: true });
  await ctx.route('https://**', (r) => r.fulfill({ status: 404, body: '{}' }));
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404/.test(m.text()) && errs.push(m.text()));
  await p.goto('http://localhost:8778/'); await p.evaluate(() => localStorage.setItem('ink:hint', '0')); await p.reload(); await p.waitForTimeout(300);
  const saved = () => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('ink-reader', 1); r.onsuccess = () => { const s = r.result.transaction('kv').objectStore('kv'); const q = s.getAllKeys(); q.onsuccess = () => { const k = q.result.filter((x) => /^ink:local:/.test(x)).pop(); const g = s.get(k); g.onsuccess = () => res(Object.values(g.result.blocks).filter((x) => x.gap || x.sp || x.gr).map((x) => ({ b: x.b, gap: x.gap, sp: x.sp, gr: x.gr }))); }; }; }));
  const lasso = async (x0, y0, x1, y1) => { await p.click('#t-ls'); await p.mouse.move(x0, y0); await p.mouse.down(); for (const q of [[x1, y0], [x1, y1], [x0, y1], [x0, y0 + 2]]) for (let k = 1; k <= 5; k++) await p.mouse.move(q[0], q[1]); await p.mouse.up(); await p.waitForTimeout(200); };
  const hline = async (x0, x1, y) => { await p.click('#t-ls'); await p.mouse.move(x0, y); await p.mouse.down(); for (let i = 1; i <= 20; i++) await p.mouse.move(x0 + (x1 - x0) * i / 20, y + (i % 3) - 1); await p.mouse.up(); await p.waitForTimeout(300); };
  const line = async (x, y) => { await p.click('#t-hl'); await p.click('#t-pen'); await p.mouse.move(x, y); await p.mouse.down(); for (let i = 0; i < 20; i++) await p.mouse.move(x + i * 5, y + (i % 2) * 3); await p.mouse.up(); await p.waitForTimeout(200); };
  const chips = () => p.$$eval('#sps .spg', (es) => es.map((e) => e.getAttribute('aria-pressed')));

  // ---------- md: 段落の下の余白 ----------
  await p.setInputFiles('#empty .open-file', path.join(dir, 'gr.md'));
  await p.waitForFunction(() => document.querySelectorAll('#doc > p').length > 8); await p.waitForTimeout(500);
  const pr = await p.evaluate(() => { const r = document.querySelector('#doc > p:nth-of-type(3)').getBoundingClientRect(); return { t: r.top, b: r.bottom }; });
  await lasso(120, pr.t + 5, 700, pr.b - 5);
  await p.click('#sel-gap'); await p.waitForTimeout(300);
  check('md の余白の右上に「方眼」（はじめは無地）', JSON.stringify(await chips()) === '["false"]');
  await p.click('#sps .spg'); await p.waitForTimeout(300);
  const g1 = await p.evaluate(() => { const g = document.querySelector('#grs div'), sp = document.querySelector('#sps .sp'); return g && { img: getComputedStyle(g).backgroundImage.includes('gradient'), same: Math.abs(g.getBoundingClientRect().top - sp.getBoundingClientRect().top) < 1 && Math.abs(g.getBoundingClientRect().height - sp.getBoundingClientRect().height) < 1, z: +getComputedStyle(document.getElementById('grs')).zIndex < +getComputedStyle(document.getElementById('ink')).zIndex }; });
  check('押すと余白が方眼になる（線の下に敷く）', g1 && g1.img && g1.same && g1.z && JSON.stringify(await chips()) === '["true"]', g1);
  const gy = await p.evaluate(() => document.querySelector('#sps .sp').getBoundingClientRect().top);
  await line(200, gy + 80);
  await p.waitForTimeout(500);
  let sv = await saved();
  check('書き込み JSON に gr', sv.length === 1 && sv[0].gr === 1 && sv[0].gap > 0, sv);
  await p.screenshot({ path: path.join(OUT, 'grid-md.png') });
  await p.reload(); await p.waitForTimeout(1200);
  check('開き直しても方眼', await p.evaluate(() => document.querySelectorAll('#grs div').length) === 1 && JSON.stringify(await chips()) === '["true"]');
  await p.click('#sps .spg'); await p.waitForTimeout(400);
  sv = await saved();
  check('もう一度押すと無地に戻る', await p.evaluate(() => document.querySelectorAll('#grs div').length) === 0 && !sv[0].gr, sv);

  // ---------- PDF: 白紙・ページの途中の余白 ----------
  await p.click('#books'); await p.setInputFiles('#shelf .open-file', path.join(dir, 'gr.pdf'));
  await p.waitForFunction(() => document.querySelector('#doc > .pg canvas')); await p.waitForTimeout(600);
  // ページの一覧の「…」: 1ページ目は「前に白紙を入れる」を出さない。2ページ目の前に入れると、1ページ目の後ろの白紙になる
  await p.click('#pgno'); await p.waitForTimeout(400);
  await p.click('#pg-grid .th[data-n="1"] .th-m');
  check('1ページ目には「前に白紙を入れる」を出さない', await p.isHidden('#th-pre') && await p.isVisible('#th-add'));
  await p.click('#pg-grid'); await p.waitForTimeout(100);
  await p.click('#pg-grid .th[data-n="2"][data-i="0"] .th-m');
  check('2ページ目には「前に白紙を入れる」', await p.isVisible('#th-pre'));
  await p.click('#th-pre'); await p.waitForTimeout(400);
  const ths = await p.$$eval('#pg-grid .th', (es) => es.map((e) => e.dataset.n + ':' + e.dataset.i));
  check('2ページ目の前（1ページ目の後ろ）に白紙が入る', ths.join(',') === '1:0,1:1,2:0,3:0', ths);
  // 白紙の前に入れる: 1ページ目の後ろの白紙の前 → 1ページ目の後ろの白紙が 2 枚
  await p.click('#pg-grid .th[data-n="1"][data-i="1"] .th-m');
  await p.click('#th-pre'); await p.waitForTimeout(400);
  check('白紙の前にも入れられる', (await p.$$eval('#pg-grid .th', (es) => es.map((e) => e.dataset.n + ':' + e.dataset.i))).join(',') === '1:0,1:1,1:2,2:0,3:0');
  await p.click('#toc button[value=cancel]'); await p.waitForTimeout(300);
  // 白紙の「方眼」
  await p.evaluate(() => { document.querySelector('#doc > .pg[data-n="1"] .blank').scrollIntoView(); scrollBy(0, -200); }); await p.waitForTimeout(400);
  check('白紙ごとに「方眼」（2 枚）', JSON.stringify(await chips()) === '["false","false"]');
  await p.click('#sps .spg'); await p.waitForTimeout(400);
  const bl = await p.evaluate(() => [...document.querySelectorAll('#doc > .pg[data-n="1"] .blank')].map((e) => e.classList.contains('grid') && getComputedStyle(e).backgroundImage.includes('gradient')));
  check('押すとそのページの白紙が方眼', bl.length === 2 && bl.every(Boolean) && JSON.stringify(await chips()) === '["true","true"]', bl);
  const by = await p.evaluate(() => document.querySelector('#doc > .pg[data-n="1"] .blank').getBoundingClientRect().top);
  await line(200, by + 100);
  await p.screenshot({ path: path.join(OUT, 'grid-pdf.png') });
  // ページの途中の余白（2ページ目）も、そのページの方眼で
  await p.evaluate(() => { document.querySelector('#doc > .pg[data-n="2"]').scrollIntoView(); scrollBy(0, -150); }); await p.waitForTimeout(400);
  const p2 = await p.evaluate(() => document.querySelector('#doc > .pg[data-n="2"]').getBoundingClientRect().top);
  await hline(120, 700, p2 + 300);
  await p.click('#sps .spg:not([aria-pressed="true"])'); await p.waitForTimeout(400);
  check('ページの途中の余白も方眼にできる', await p.evaluate(() => document.querySelectorAll('#grs div').length) === 1);
  sv = await saved();
  check('PDF の書き込み JSON にも gr', sv.filter((x) => x.gr).map((x) => x.b).join(',') === '1,2', sv);
  // 縮小画像の白紙も方眼（白紙の真ん中あたりの横一列に、薄い青の点がある）
  await p.click('#pgno'); await p.waitForTimeout(1200);
  const thumb = await p.evaluate(() => { const c = document.querySelector('#pg-grid .th[data-n="1"][data-i="1"] canvas'); if (!c) return null; const d = c.getContext('2d').getImageData(0, Math.round(c.height / 2), c.width, 1).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 2] > d[i] + 8) n++; return n; });
  check('縮小画像の白紙も方眼', thumb > 10, thumb);
  // 書き出し: すべて選んで PDF に（白紙のページに方眼の線）
  await p.click('#ex-on'); await p.click('#ex-all');
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 60000 }).catch(() => null), p.click('#ex-go')]);
  let lines = null;
  if (dl) {
    const f = path.join(dir, 'out.pdf'); await dl.saveAs(f);
    try { lines = +execFileSync('python3', ['-c', `import pypdf,sys,re\nr=pypdf.PdfReader(sys.argv[1])\nprint(len(re.findall(rb' l\\b', r.pages[1].get_contents().get_data())))`, f]).toString().trim(); } catch (e) { lines = 'pypdf なし'; }
  }
  check('書き出した PDF の白紙に方眼の線', lines === 'pypdf なし' || lines > 40, lines);
  check('エラーなし', !errs.length, errs);
  await b.close(); srv.close();
  console.log(ok ? '\nすべて OK' : '\n失敗あり');
  process.exit(ok ? 0 : 1);
})();
