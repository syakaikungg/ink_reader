// 「Claude と並べて勉強する」の確認（Playwright）。ドライブ API はモックする（sakai_study は要らない）
// 使い方: node tests/now.cjs
// 確認すること: ドライブにつないでいると、アプリが「Ink Reader/いま.md」に見えている段落の本文を書く → 書くと「最後に書いた所」と now.png・last.png
// → スクロールが止まると書き直す → 何もしていない間・書いている間は送らない → Claude が置いた答えは、Claude の側から戻ったとき（focus）に Q になる
// → PDF はページの絵の now.png → 設定の「Claude への指示をコピー」
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const APP = path.resolve(__dirname, '..'), N = 4;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8774);
let ok = true;
const check = (name, v) => { console.log(v ? '✓' : '✗', name); if (!v) ok = false; };
const { createDrive, GIS, connected } = require('./drive-mock.cjs');
const drv = createDrive(), { files, byPath, calls } = drv;
const now = () => byPath('Ink Reader/いま.md'), text = () => (now() ? now().content.toString() : '');
const dims = (bf) => [bf.readUInt32BE(16), bf.readUInt32BE(20)];

(async () => {
  const b = await chromium.launch();
  const mdPath = path.join(os.tmpdir(), 'ink-now.md'), pdfPath = path.join(os.tmpdir(), 'ink-now.pdf');
  fs.writeFileSync(mdPath, '# 並べる章\n\n' + [...Array(40)].map((_, i) => i === 3 ? '$$\\frac{a+b}{\\sqrt{2}} = \\int_0^1 f(x)\\,dx$$' : `段落${i + 2}の本文です。式 $x_{${i + 2}}^2$ を含みます。` + 'ことばを足して長くする。'.repeat(6)).join('\n\n') + '\n');
  const mk = await b.newPage();
  await mk.setContent(`<style>body{margin:0;font:28px serif} section{height:100vh;page-break-after:always;padding:40px;box-sizing:border-box}</style>` +
    [...Array(N)].map((_, i) => `<section><p>ページ ${i + 1} の本文。</p></section>`).join(''));
  await mk.pdf({ path: pdfPath, format: 'A4' }); await mk.close();

  const ctx = await b.newContext({ viewport: { width: 590, height: 1000 }, deviceScaleFactor: 2, hasTouch: true });   // iPad を Claude と半分ずつにした幅
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:8774' });
  await ctx.route('https://www.googleapis.com/**', drv.route);
  await ctx.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: GIS }));
  await ctx.route('https://api.github.com/**', (r) => r.fulfill({ status: 404, body: '{}' }));
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404/.test(m.text()) && errs.push(m.text()));
  await p.goto('http://localhost:8774/');
  await p.evaluate((kv) => { for (const k in kv) localStorage.setItem(k, kv[k]); }, connected());
  await p.reload(); await p.waitForTimeout(300);
  await p.setInputFiles('#empty .open-file', mdPath);
  await p.waitForFunction(() => document.querySelectorAll('#doc > p').length > 30, null, { timeout: 15000 });
  for (let i = 0; i < 30 && !now(); i++) await p.waitForTimeout(200);
  const t1 = text();
  console.log(t1.split('\n').slice(0, 16).join('\n'));
  check('開くと いま.md を書く（本・章・本文の場所）', /# いま Ink Reader で見ている所/.test(t1) && /本: 「並べる章」/.test(t1) && /chapters\/c1\.md/.test(t1));
  check('見えている段落の番号と本文（数式は TeX）', /段落 1〜\d+。/.test(t1) && /\*\*段落 2\*\*\n段落2の本文です。式 \$x_\{2\}\^2\$/.test(t1));
  check('見えている所に手書きがなければ now.png は置かない', !byPath('Ink Reader/now.png') && /手書きはありません/.test(t1));
  check('まだ書いていない', /（まだ書いていません）/.test(t1));
  const seen = (t) => (t.match(/段落 (\d+)〜(\d+)。/) || []).slice(1).map(Number);

  // 段落 3 に書く → 2 秒ほどで「最後に書いた所」と絵
  const line = async (x, y) => { await p.mouse.move(x, y); await p.mouse.down(); for (let i = 0; i < 20; i++) await p.mouse.move(x + i * 5, y + (i % 2) * 3); await p.mouse.up(); };
  const blockY = (n) => p.evaluate((n) => document.querySelector('#doc').children[n].getBoundingClientRect().top + 12, n);
  const v1 = now().version;
  await line(150, await blockY(3));
  await p.waitForTimeout(1000);
  check('ペンを離してすぐには送らない', now().version === v1);
  for (let i = 0; i < 20 && now().version === v1; i++) await p.waitForTimeout(200);
  const t2 = text();
  console.log(t2.split('## 最後に書いた所')[1]);
  check('最後に書いた所（段落と時刻と本文）', /\d\d:\d\d:\d\d に、段落 3に書きました（いま画面に見えています）/.test(t2) && /\*\*段落 3\*\*\n段落3の本文/.test(t2.split('## 最後に書いた所')[1] || ''));
  const np = byPath('Ink Reader/now.png'), lp = byPath('Ink Reader/last.png');
  check('now.png と last.png（PNG）', np && lp && np.content.slice(1, 4).toString() === 'PNG' && lp.content.slice(1, 4).toString() === 'PNG' && np.mimeType === 'image/png');
  if (process.env.DUMP) for (const [f, n] of [[np, 'now-md.png'], [lp, 'last-md.png']]) if (f) fs.writeFileSync(path.join(process.env.DUMP, n), f.content);   // 絵を見るとき: DUMP=<フォルダ>
  console.log('now.png', np && dims(np.content), np && Math.round(np.content.length / 1024) + 'KB', 'last.png', lp && dims(lp.content));
  check('絵は紙の幅の 1.5 倍', np && dims(np.content)[0] === 1020);
  check('いま.md は Markdown', now().mimeType === 'text/markdown');
  // 手書きと番号の札が絵に入っているか（暗い画素と青い画素）
  const px = await p.evaluate(async (b64) => {
    const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode();
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data; let dark = 0, blue = 0;
    for (let k = 0; k < d.length; k += 4) { if (d[k] < 80 && d[k + 1] < 80 && d[k + 2] < 80) dark++; if (d[k] < 80 && d[k + 2] > 170) blue++; }
    return { dark, blue };
  }, lp ? lp.content.toString('base64') : '');
  console.log('last.png px', px);
  check('last.png に手書きと段落番号の札', px.dark > 200 && px.blue > 200);

  // 何もしていない間は送らない
  const c0 = calls.length;
  await p.waitForTimeout(4000);
  check('眺めているだけの間は送らない', calls.length === c0);

  // スクロールが止まると書き直す（最後に書いた所はそのまま）
  const lv = byPath('Ink Reader/last.png').version, s0 = seen(text());
  await p.evaluate(() => scrollBy(0, 1500));
  await p.waitForTimeout(600); await p.evaluate(() => scrollBy(0, 300));
  await p.waitForTimeout(800);
  check('スクロールしている間は送らない', seen(text()).join() === s0.join());
  for (let i = 0; i < 20 && seen(text()).join() === s0.join(); i++) await p.waitForTimeout(200);
  const t3 = text(), s1 = seen(t3);
  console.log('見えている段落', s0, '->', s1);
  check('止まると見えている段落を書き直す', s1[0] > s0[1] - 2 && /段落 3に書きました。/.test(t3) && !/いま画面に見えています/.test(t3));
  check('last.png は書き直さない', byPath('Ink Reader/last.png').version === lv);

  // 書いている間（ペンを押さえている間）は送らない
  const v3 = now().version, y = await blockY(s1[0] + 1);
  await p.mouse.move(150, y); await p.mouse.down();
  for (let i = 0; i < 40; i++) { await p.mouse.move(150 + (i % 20) * 6, y + (i % 3)); await p.waitForTimeout(80); }
  check('書いている間は送らない', now().version === v3);
  await p.mouse.up();
  for (let i = 0; i < 40 && !new RegExp(`段落 ${s1[0] + 1}に書きました`).test(text()); i++) await p.waitForTimeout(200);
  check('離すと送る', new RegExp(`段落 ${s1[0] + 1}に書きました`).test(text()));

  // Claude が「段落に残して」で答えを置く → Claude の側から戻ったとき（focus）に Q
  const top = Object.values(files).find((f) => /^並べる章 \(/.test(f.name)), dir = 'Ink Reader/' + (top && top.name);
  drv.add(dir + '/answers', 'c1-ab12cd.md', '<!-- ink-answer id=ab12cd b=5 -->\n> 質問: ここは？\n\n答えです。\n');
  await p.waitForTimeout(5200);
  await p.evaluate(() => dispatchEvent(new Event('focus')));
  for (let i = 0; i < 20 && !(await p.$('#qs .qm[data-b="5"]')); i++) await p.waitForTimeout(200);
  check('Claude の側から戻ると答えが Q になる', !!(await p.$('#qs .qm[data-b="5"]:not(.wait)')));

  // PDF: ページの絵に手書きを重ねた now.png、番号はページ
  await p.click('#books'); await p.setInputFiles('#shelf .open-file', pdfPath);
  await p.waitForFunction((n) => document.querySelectorAll('#doc > .pg').length === n, N, { timeout: 30000 });
  for (let i = 0; i < 30 && !/PDF の本/.test(text()); i++) await p.waitForTimeout(200);
  const t4 = text();
  console.log(t4.split('\n').slice(0, 14).join('\n'));
  check('PDF はページ番号と元の PDF の場所', /\d+(〜\d+)?ページ。絵: Ink Reader\/now\.png/.test(t4) && /book\.pdf/.test(t4) && /別の本「並べる章」の段落/.test(t4));
  const pn = byPath('Ink Reader/now.png');
  if (process.env.DUMP) fs.writeFileSync(path.join(process.env.DUMP, 'now-pdf.png'), pn.content);
  const dark = await p.evaluate(async (b64) => {
    const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode();
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let k = 0; k < d.length; k += 4) if (d[k] < 120 && d[k + 1] < 120) n++;
    return n;
  }, pn.content.toString('base64'));
  check('PDF の now.png にページの文字が入る', dark > 300);
  await line(200, await p.evaluate(() => document.querySelector('#doc > .pg[data-n="1"]').getBoundingClientRect().top + 300));
  for (let i = 0; i < 25 && !/1ページに書きました/.test(text()); i++) await p.waitForTimeout(200);
  check('PDF は「1ページに書きました」', /1ページに書きました（いま画面に見えています）/.test(text()));

  // 設定: Claude への指示をコピー
  await p.click('#more'); await p.click('#gear'); await p.waitForTimeout(300);   // 幅 590px なので設定は「…」の中
  await p.click('#cfg-claude'); await p.waitForTimeout(300);
  const note = await p.evaluate(() => navigator.clipboard.readText());
  check('Claude への指示をコピーできる', /Ink Reader\/いま\.md/.test(note) && /コピーしました/.test(await p.textContent('#drv-msg')));
  await p.click('#cfg button[value=cancel]');
  check('README に いま.md の説明', /いま見ている所（いま\.md）/.test(byPath('Ink Reader/README.md').content.toString()));
  check('同じファイルを二つ作らない', !drv.twins());
  check('エラーなし', !errs.length); if (errs.length) console.log(errs);
  await b.close(); srv.close();
  console.log(ok ? 'OK' : 'NG'); process.exit(ok ? 0 : 1);
})();
