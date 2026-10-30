// 本棚の確認（Playwright）。PDF 2冊（縦・横）と md 1冊を「ファイルから開く」で開く。GitHub とドライブは使わない
// 使い方: node tests/shelf.cjs [スクリーンショットの出力先]
// 確認すること: 表紙の格子（PDF は1ページ目の縮小画像、md は題名の札）→ 最近開いた順 → 今の本に印 → 押すと開く
// → 表紙のない PDF の本は開いたときに表紙を作る → 「…」から削除（2回押す）
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const APP = path.resolve(__dirname, '..'), OUT = process.argv[2] || os.tmpdir();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8772);
let ok = true;
const check = (name, v, info) => { console.log(v ? '✓' : '✗', name, info === undefined ? '' : info); if (!v) ok = false; };
(async () => {
  const b = await chromium.launch();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-shelf-'));
  const mkPdf = async (name, landscape, color) => {
    const mk = await b.newPage();
    await mk.setContent(`<style>body{margin:0;font:40px serif} section{height:100vh;page-break-after:always;padding:40px;box-sizing:border-box;background:${color}}</style>` +
      [1, 2, 3].map((i) => `<section><h1>${name} ${i}</h1></section>`).join(''));
    await mk.pdf({ path: path.join(dir, name + '.pdf'), format: 'A4', landscape, printBackground: true }); await mk.close();
  };
  await mkPdf('tate', false, '#fde2e2'); await mkPdf('yoko', true, '#dde8ff');   // ファイル名は英字にする（Playwright で日本語の名前のファイルを渡すと change が来ない）
  fs.writeFileSync(path.join(dir, 'note.md'), '# 線形代数ノート\n\n最初の段落。$x^2$\n\n二つ目の段落。\n');

  const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404/.test(m.text()) && errs.push(m.text()));
  await p.goto('http://localhost:8772/'); await p.waitForTimeout(300);
  const kv = (fn, arg) => p.evaluate(([fn, arg]) => new Promise((res) => { const r = indexedDB.open('ink-reader', 1); r.onsuccess = () => { const s = r.result.transaction('kv', fn === 'get' || fn === 'getAllKeys' ? 'readonly' : 'readwrite').objectStore('kv'); const q = s[fn](arg); q.onsuccess = () => res(q.result instanceof Blob ? q.result.size : q.result); }; }), [fn, arg]);
  const open = async (file, first) => {
    if (!first) await p.click('#books');
    await p.setInputFiles(first ? '#empty .open-file' : '#shelf .open-file', path.join(dir, file));
    await p.waitForFunction((t) => document.getElementById('chap-t').textContent.includes(t), file === 'note.md' ? '線形代数' : file.replace('.pdf', ''), { timeout: 30000 });
    await p.waitForTimeout(500);
  };
  await open('tate.pdf', true);
  await open('note.md');
  await open('yoko.pdf');
  const shelf = () => p.$$eval('#shelf-list .bk', (els) => els.map((el) => {
    const cv = el.querySelector('.cv'), r = cv.getBoundingClientRect(), im = cv.querySelector('img');
    return { name: el.querySelector('.nm').textContent, cur: cv.getAttribute('aria-current') === 'true', img: !!(im && im.complete && im.naturalWidth), card: cv.classList.contains('card') ? cv.textContent : '', w: Math.round(r.width), h: Math.round(r.height), menu: !!el.querySelector('.bk-m') };
  }));
  await p.click('#books'); await p.waitForTimeout(300);
  let s = await shelf();
  console.log(JSON.stringify(s));
  check('最近開いた順に並ぶ', s.map((x) => x.name).join() === 'yoko,線形代数ノート,tate');
  check('今開いている本に印', s[0].cur && !s[1].cur && !s[2].cur);
  check('PDF は1ページ目の縮小画像', s[0].img && s[2].img);
  check('md は題名の札', !s[1].img && /線形代数ノート/.test(s[1].card));
  check('横の PDF は横長、縦の PDF は縦長', s[0].w > s[0].h && s[2].h > s[2].w);
  check('ファイルから開いた本には「…」がある', s.every((x) => x.menu));
  const px = await p.evaluate(() => { const im = document.querySelector('#shelf-list .bk:nth-child(3) img'), c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; const g = c.getContext('2d'); g.drawImage(im, 0, 0); return [...g.getImageData(c.width - 5, c.height - 5, 1, 1).data]; });
  check('縮小画像にページの色が出ている', px[0] > 240 && px[1] < 240 && px[2] < 240, px);
  await p.screenshot({ path: path.join(OUT, 'shelf.png') });

  // 表紙を押すと開き、並びの先頭に来る
  await p.click('#shelf-list .bk:nth-child(3) .cv');
  await p.waitForFunction(() => document.getElementById('chap-t').textContent === 'tate', null, { timeout: 10000 });
  check('表紙を押すと開く', await p.isHidden('#shelf') || !(await p.evaluate(() => document.getElementById('shelf').open)));
  await p.click('#books'); await p.waitForTimeout(300);
  s = await shelf();
  check('開いた本が先頭', s[0].name === 'tate' && s[0].cur, s.map((x) => x.name).join());
  await p.click('#shelf button[value=cancel]');

  // 表紙のない PDF の本（前の版で開いたもの）は、開いたときに表紙を作る
  const books = await kv('get', 'books'), idOf = (t) => books.find((x) => x.title === t).id;
  await kv('delete', 'cover:' + idOf('yoko'));
  await p.click('#books'); await p.waitForTimeout(300);
  s = await shelf();
  check('表紙がまだなければ題名の札', !s.find((x) => x.name === 'yoko').img && /PDF/.test(s.find((x) => x.name === 'yoko').card));
  await p.click('#shelf-list .bk:nth-child(2) .cv');
  await p.waitForFunction(() => document.getElementById('chap-t').textContent === 'yoko', null, { timeout: 10000 });
  await p.waitForTimeout(3000);
  check('開いたときに表紙を作る', (await kv('get', 'cover:' + idOf('yoko'))) > 1000);

  // 「…」から削除（2回押す）。押すまでは消えない
  await p.click('#books'); await p.waitForTimeout(300);
  const at = (await shelf()).findIndex((x) => x.name === '線形代数ノート') + 1;
  await p.click(`#shelf-list .bk:nth-child(${at}) .bk-m`);
  check('「…」で削除の小窓', await p.isVisible('#bk-menu') && (await p.textContent('#bk-del')) === '削除');
  await p.click('#bk-del');
  check('1回目は確かめるだけ', (await p.textContent('#bk-del')) === 'もう一度押すと削除' && (await shelf()).length === 3);
  await p.click('#shelf h2');
  check('外を押すと小窓を閉じる', await p.isHidden('#bk-menu'));
  await p.click(`#shelf-list .bk:nth-child(${at}) .bk-m`); await p.click('#bk-del');
  check('開き直すと最初から', (await p.textContent('#bk-del')) === 'もう一度押すと削除' && (await shelf()).length === 3);
  await p.click('#bk-del'); await p.waitForTimeout(500);
  s = await shelf();
  check('2回押すと消える', s.length === 2 && !s.some((x) => x.name === '線形代数ノート'), s.map((x) => x.name).join());
  const keys = (await kv('getAllKeys')).filter((k) => k.includes(idOf('線形代数ノート')));
  check('端末から本文も消える', !keys.length, keys);
  check('開いている本はそのまま', (await p.textContent('#chap-t')) === 'yoko');

  // 開いている本を消すと、本のない画面に戻る（GitHub の本がないとき）
  for (let i = 0; i < 2; i++) { await p.click('#shelf-list .bk:first-child .bk-m'); await p.click('#bk-del'); await p.click('#bk-del'); await p.waitForTimeout(500); }
  check('全部消すと本のない画面', (await shelf()).length === 0 && await p.evaluate(() => !document.getElementById('empty').hidden));
  await p.click('#shelf button[value=cancel]');
  console.log('errs', errs); if (errs.length) ok = false;
  await b.close(); srv.close(); fs.rmSync(dir, { recursive: true, force: true });
  console.log(ok ? 'OK' : 'NG'); process.exit(ok ? 0 : 1);
})();
