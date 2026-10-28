// PDF の確認（Playwright）。300ページの PDF を Chromium で作り、「ファイルから開く」で開いて書き込む。GitHub は使わない。
// 使い方: node tests/pdf.cjs [スクリーンショットの出力先]
// 確認すること: 開く → ページが縦に並ぶ・ページ番号 → 描くのは近くのページだけ → 書く → ページ番号で飛ぶ → 再読み込みで残る
// → 目次（PDF のしおり）→ 投げ縄で「Claudeに聞く」の画像 → 拡大で描き直す（300% は見えている部分だけ細かく）→ 本文の検索 → 削除
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const APP = path.resolve(__dirname, '..'), OUT = process.argv[2] || os.tmpdir(), N = 300;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8768);
(async () => {
  const b = await chromium.launch();
  // PDF を作る（50ページごとに見出し → PDF のしおりになる）
  const pdfPath = path.join(os.tmpdir(), 'ink-test.pdf');
  const mk = await b.newPage();
  await mk.setContent(`<style>body{margin:0;font:28px serif} section{height:100vh;page-break-after:always;padding:40px;box-sizing:border-box} h1{font-size:40px}</style>` +
    [...Array(N)].map((_, i) => `<section>${i % 50 === 0 ? `<h1>Part ${i / 50 + 1}</h1>` : ''}<p>ページ ${i + 1} の本文。$E=mc^2$</p></section>`).join(''));
  await mk.pdf({ path: pdfPath, format: 'A4', outline: true, tagged: true }); await mk.close();
  console.log('pdf', Math.round(fs.statSync(pdfPath).size / 1024) + 'KB');

  const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404/.test(m.text()) && errs.push(m.text()));
  await p.goto('http://localhost:8768/'); await p.waitForTimeout(300);
  const t0 = Date.now();
  await p.setInputFiles('#empty .open-file', pdfPath);
  await p.waitForFunction((n) => document.querySelectorAll('#doc > .pg').length === n, N, { timeout: 60000 });
  await p.waitForFunction(() => document.querySelector('#doc > .pg canvas'), null, { timeout: 20000 });
  console.log('open', (Date.now() - t0) + 'ms', await p.textContent('#stat'), '|', await p.textContent('#chap-t'));
  const pg = () => p.evaluate(() => document.getElementById('pg-c').textContent + ' / ' + document.getElementById('pg-n').textContent);
  const canv = () => p.evaluate(() => [...document.querySelectorAll('#doc > .pg canvas:not(.hd)')].filter((c) => c.width).map((c) => +c.parentNode.dataset.n));
  await p.waitForTimeout(800);
  console.log('pgno', await pg(), 'visible', await p.isVisible('#pgno'), 'drawn', await canv(), 'foot hidden', await p.isHidden('#foot'));
  await p.screenshot({ path: path.join(OUT, 'pdf.png') });

  // 右下のページ番号を押すと、ページの一覧が開く。番号を入れて飛ぶ
  const jumpTo = async (n) => { await p.click('#pgno'); await p.fill('#pg-in', String(n)); await p.keyboard.press('Enter'); await p.waitForTimeout(1200); };
  const line = async (x, y) => { await p.mouse.move(x, y); await p.mouse.down(); for (let i = 0; i < 20; i++) await p.mouse.move(x + i * 5, y + (i % 2) * 3); await p.mouse.up(); };
  const y1 = await p.evaluate(() => document.querySelector('#doc > .pg[data-n="1"]').getBoundingClientRect().top + 200);
  await line(200, y1);
  // ページ番号を入れて飛ぶ
  await jumpTo(150);
  console.log('jump', await pg(), 'drawn', await canv());
  const y150 = await p.evaluate(() => document.querySelector('#doc > .pg[data-n="150"]').getBoundingClientRect().top + 300);
  await line(250, y150);
  await p.waitForTimeout(400);
  const saved = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('ink-reader', 1); r.onsuccess = () => { const s = r.result.transaction('kv').objectStore('kv'); const q = s.getAllKeys(); q.onsuccess = () => { const k = q.result.find((x) => /^ink:local:.*:pdf$/.test(x)); const g = s.get(k); g.onsuccess = () => res(Object.values(g.result.blocks).map((x) => [x.b, x.pt, Object.keys(x.strokes).length])); }; }; }));
  console.log('saved', JSON.stringify(saved));
  await p.reload(); await p.waitForTimeout(2000);
  console.log('reload', await pg(), 'strokes', await p.evaluate(() => document.querySelectorAll('#ink path').length), 'drawn', await canv());

  // 目次: PDF のしおり
  await p.click('#chap'); await p.waitForTimeout(300);
  console.log('toc', await p.$$eval('#toc-list button', (o) => o.map((x) => x.textContent.trim())), 'search hidden', await p.isHidden('#toc-q'));
  await p.click('#toc-list li:nth-child(4) button'); await p.waitForTimeout(1000); console.log('toc jump', await pg());
  await jumpTo(150);

  // しおり: ページを指で長押し
  const cdp = await ctx.newCDPSession(p);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  await touch('touchStart', [[400, 600]]); await p.waitForTimeout(700); await touch('touchEnd', []);
  console.log('bookmark', await p.textContent('#stat'), await p.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => /:bm:/.test(k))) || '[]')));

  // 投げ縄 → Claudeに聞く（PDF は囲んだ範囲の画像）
  await p.click('#t-ls');
  const ly = await p.evaluate(() => document.querySelector('#doc > .pg[data-n="150"]').getBoundingClientRect().top + 20);
  await p.mouse.move(120, ly); await p.mouse.down(); for (const q of [[700, ly], [700, ly + 300], [120, ly + 300], [120, ly + 2]]) for (let k = 1; k <= 5; k++) await p.mouse.move(q[0], q[1]); await p.mouse.up();
  console.log('lasso', await p.textContent('#stat'), await p.textContent('#sel-n'));
  await p.click('#sel-ask'); await p.waitForTimeout(200);
  console.log('ask', await p.textContent('#ask-pv'), 'img', await p.evaluate(() => { const i = document.getElementById('ask-img'); return !i.hidden && [i.naturalWidth, i.naturalHeight]; }),
    'share primary', await p.evaluate(() => document.getElementById('ask-share').classList.contains('primary')), 'code hidden', await p.isHidden('#ask-code'));
  // 画像に PDF の文字（黒）と書き込みが入っているか: 白でない画素の割合
  console.log('ask img ink', await p.evaluate(() => { const i = document.getElementById('ask-img'), c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight; const g = c.getContext('2d'); g.drawImage(i, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let k = 0; k < d.length; k += 4) if (d[k] < 200) n++; return n > 100; }));
  console.log('ask text', decodeURIComponent(await p.getAttribute('#ask-open', 'href')).slice(22, 80));
  await p.screenshot({ path: path.join(OUT, 'pdf-ask.png') });
  await p.click('#ask button[value=cancel]'); await p.click('#sel-x'); await p.click('#t-pen');

  // 拡大すると近くのページを細かく描き直す。描いているページ数は増えない
  const res = () => p.evaluate(() => { const c = [...document.querySelectorAll('#doc > .pg canvas')].find((x) => x.width); return c && c.width; });
  const r0 = await res();
  await p.selectOption('#zoomv', '2'); await p.waitForTimeout(2500);
  console.log('zoom', await p.textContent('#zoomv option:first-child'), 'canvas width', r0, '->', await res(), 'drawn', (await canv()).length);
  // 300% では、見えている部分だけを画面の画素どおりに細かく描いて重ねる（スクロールして止まると描き直す）
  const hdInfo = () => p.evaluate(() => [...document.querySelectorAll('#doc > .pg canvas.hd')].map((c) => [+c.parentNode.dataset.n, Math.round(c.width / parseFloat(c.style.width) * 100) / 100, c.width * c.height]));
  await p.selectOption('#zoomv', '3'); await p.waitForTimeout(2500);
  console.log('zoom 300 hd [page, 画素/紙px, 画素数]', JSON.stringify(await hdInfo()));
  await p.mouse.wheel(0, 2500); await p.waitForTimeout(2500);
  console.log('after scroll hd', JSON.stringify(await hdInfo()), await pg());
  await p.screenshot({ path: path.join(OUT, 'pdf-zoom.png') });
  await p.selectOption('#zoomv', 'fit'); await p.waitForTimeout(800);
  console.log('fit hd', (await hdInfo()).length);

  // ぐちゃぐちゃ消し・消しゴムは md と同じ
  const n0 = await p.evaluate(() => document.querySelectorAll('#ink path').length);
  const sy = await p.evaluate(() => { const el = document.querySelector('#doc > .pg[data-n="150"]'); el.scrollIntoView(); return el.getBoundingClientRect().top + 500; });
  const draw = async (pts) => { await p.mouse.move(...pts[0]); await p.mouse.down(); for (const q of pts) await p.mouse.move(q[0], q[1], { steps: 4 }); await p.mouse.up(); };
  await draw([[300, sy], [310, sy + 20], [318, sy + 5]]);
  await draw([...Array(13)].map((_, i) => [295 + i * 4, i % 2 ? sy + 24 : sy - 4]));
  console.log('scribble', n0, '->', await p.evaluate(() => document.querySelectorAll('#ink path').length), await p.textContent('#stat'));

  // 本文の検索: 目次の検索欄 → 見つかったページへ飛び、その文字に一瞬色が付く
  await p.click('#chap'); await p.fill('#toc-q', 'ページ 237 の'); await p.waitForTimeout(400);
  await p.waitForFunction(() => document.querySelector('#toc-hits button'), null, { timeout: 30000 });
  console.log('search', await p.$$eval('#toc-hits li', (o) => o.map((x) => x.textContent.slice(0, 40))));
  await p.click('#toc-hits li:first-child button'); await p.waitForTimeout(500);
  console.log('search jump', await pg(), 'hitbox', await p.evaluate(() => { const m = document.querySelector('.hitbox'); if (!m) return null; const r = m.getBoundingClientRect(); return [+m.parentNode.dataset.n, Math.round(r.top), Math.round(r.left), Math.round(r.width), r.top > 0 && r.bottom < innerHeight]; }));
  await p.screenshot({ path: path.join(OUT, 'pdf-search.png') });
  await p.click('#chap'); await p.fill('#toc-q', 'mc^2'); await p.waitForTimeout(600); console.log('search all', (await p.$$('#toc-hits li')).length, await p.textContent('#toc-hits li:last-child'));
  await p.click('#toc button[value=cancel]');

  // ページの一覧: 右下のページ番号から開く → 縮小画像は見えている分だけ → 「…」から白紙を入れる・消す（後ろのページが下がる・戻る）
  await jumpTo(150);
  await p.click('#pgno'); await p.waitForTimeout(1500);
  const thumbs = () => p.evaluate(() => ({ items: document.querySelectorAll('#pg-grid .th').length, drawn: document.querySelectorAll('#pg-grid canvas').length, cur: (document.querySelector('#pg-grid .cur') || {}).dataset?.n, blanks: document.querySelectorAll('#pg-grid .blank').length }));
  console.log('pages tab', await p.evaluate(() => [...document.querySelectorAll('#toc-tabs button')].map((b) => b.textContent + (b.getAttribute('aria-selected') === 'true' ? '*' : ''))), JSON.stringify(await thumbs()));
  await p.screenshot({ path: path.join(OUT, 'pdf-pages.png') });
  const p151 = () => p.evaluate(() => Math.round(document.querySelector('#doc > .pg[data-n="151"]').offsetTop));
  const t151 = await p151();
  await p.click('#pg-grid .th[data-n="150"] .th-m'); await p.click('#th-add'); await p.waitForTimeout(600);
  console.log('add blank', await p.textContent('#stat'), JSON.stringify(await thumbs()), 'page151 moved', await p151() - t151);
  // 白紙に書く → 一覧からその白紙へ飛べる → 白紙の前にもう1枚入れると、書いた線は後ろへずれる
  await p.click('#pg-grid .th.blank .im'); await p.waitForTimeout(500);
  const by = await p.evaluate(() => { const el = document.querySelector('#doc > .pg[data-n="150"] .blank'); const r = el.getBoundingClientRect(); return r.top + 300; });
  await line(250, by); await p.waitForTimeout(300);
  const lastY = () => p.evaluate(() => { const l = [...document.querySelectorAll('#ink path')].pop(); return Math.round(l.getBoundingClientRect().top + scrollY); });
  const ly0 = await lastY();
  await p.click('#pgno'); await p.waitForTimeout(500);
  await p.click('#pg-grid .th[data-n="150"]:not(.blank) .th-m'); await p.click('#th-add'); await p.waitForTimeout(600);
  console.log('insert before', JSON.stringify(await thumbs()), 'stroke moved', await lastY() - ly0);
  await p.click('#pg-grid .th.blank[data-i="1"] .th-m'); console.log('del shown', await p.isVisible('#th-del')); await p.click('#th-del'); await p.waitForTimeout(600);
  console.log('del blank 1', JSON.stringify(await thumbs()), 'stroke back', await lastY() - ly0, 'strokes', await p.evaluate(() => document.querySelectorAll('#ink path').length));
  await p.click('#pg-grid .th.blank[data-i="1"] .th-m'); await p.click('#th-del'); await p.waitForTimeout(600);
  console.log('del blank with ink', JSON.stringify(await thumbs()), 'strokes', await p.evaluate(() => document.querySelectorAll('#ink path').length), 'page151 back', await p151() - t151);
  await p.click('#toc button[value=cancel]');
  await p.click('#undo'); await p.waitForTimeout(400);
  console.log('undo', 'strokes', await p.evaluate(() => document.querySelectorAll('#ink path').length), 'page151', await p151() - t151);
  await p.reload(); await p.waitForTimeout(1500);
  console.log('reload page151', await p151() - t151);

  // 削除すると PDF も消える
  await p.click('#books'); await p.click('#shelf-list li:first-child .del'); await p.click('#shelf-list li:first-child .del'); await p.waitForTimeout(500);
  console.log('deleted', await p.isVisible('#empty'), 'pdf class', await p.evaluate(() => document.body.classList.contains('pdf')), 'pgno hidden', await p.isHidden('#pgno'),
    'kv', await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('ink-reader', 1); r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').getAllKeys(); q.onsuccess = () => res(q.result.filter((k) => /^pdf:/.test(k)).length); }; })));
  console.log('errs', errs); await b.close(); srv.close(); process.exit(errs.length ? 1 : 0);
})();
