// 最初の案内と見本の本の確認（Playwright）。GitHub とドライブは使わない
// 使い方: node tests/guide.cjs [スクリーンショットの出力先]
// 確認すること: 案内は3行と「見本の本を開く」→ 押すと見本の本（数式・図つき）が開き、案内は閉じる → 書き込みは開き直しても残る
// → 設定の「使い方」からも開ける → 消したあとにもう一度開くと作り直す
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const APP = path.resolve(__dirname, '..'), OUT = process.argv[2] || os.tmpdir();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8775);
let ok = true;
const check = (name, v, info) => { console.log(v ? '✓' : '✗', name, info === undefined ? '' : info); if (!v) ok = false; };
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404/.test(m.text()) && errs.push(m.text()));
  await p.goto('http://localhost:8775/'); await p.waitForTimeout(500);
  const kv = (fn, arg) => p.evaluate(([fn, arg]) => new Promise((res) => { const r = indexedDB.open('ink-reader', 1); r.onsuccess = () => { const s = r.result.transaction('kv', 'readonly').objectStore('kv'); const q = s[fn](arg); q.onsuccess = () => res(q.result); }; }), [fn, arg]);

  // 最初の案内
  const hint = await p.evaluate(() => { const h = document.getElementById('hint'); return { shown: !h.hidden, lines: h.querySelectorAll('li').length, h: Math.round(h.getBoundingClientRect().height), text: h.textContent.replace(/\s+/g, ' ').trim() }; });
  check('案内は3行', hint.shown && hint.lines === 3, hint.text);
  check('案内は短い（紙を押し出さない）', hint.h < 150, hint.h);
  check('「見本の本を開く」がある', await p.isVisible('#hint .open-sample'));
  await p.screenshot({ path: path.join(OUT, 'guide-hint.png') });

  // 見本の本を開く
  await p.click('#hint .open-sample');
  await p.waitForFunction(() => document.getElementById('chap-t').textContent.includes('見本'), null, { timeout: 10000 });
  await p.waitForTimeout(500);
  const docInfo = await p.evaluate(() => ({ title: document.getElementById('chap-t').textContent, katex: document.querySelectorAll('#doc .katex').length, fig: !!document.querySelector('#doc > figure svg'), figW: Math.round((document.querySelector('#doc > figure svg') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width), cap: !!document.querySelector('#doc > p.cap'), h2: document.querySelectorAll('#doc > h2').length }));
  check('見本の本が開く', /見本の本/.test(docInfo.title), docInfo.title);
  check('数式と図がある', docInfo.katex >= 8 && docInfo.fig && docInfo.figW > 200 && docInfo.cap, docInfo);
  check('案内は閉じて、覚えておく', await p.isHidden('#hint') && await p.evaluate(() => localStorage.getItem('ink:hint') === '0'));
  const books = await kv('get', 'books');
  check('本棚に入る', books.length === 1 && books[0].id === 'local:sample', books);
  await p.screenshot({ path: path.join(OUT, 'guide-sample.png') });

  // 書いてから開き直しても残る
  const box = await p.evaluate(() => { const r = document.querySelector('#doc > p:nth-of-type(2)').getBoundingClientRect(); return { x: r.left + 60, y: r.top + r.height / 2 }; });
  await p.mouse.move(box.x, box.y); await p.mouse.down();
  for (let i = 1; i <= 15; i++) await p.mouse.move(box.x + i * 6, box.y + Math.sin(i / 3) * 8, { steps: 2 });
  await p.mouse.up();
  await p.waitForTimeout(800);
  const n1 = await p.$$eval('#ink path.k', (els) => els.length);
  await p.reload(); await p.waitForTimeout(1000);
  const n2 = await p.$$eval('#ink path.k', (els) => els.length);
  check('書き込みは開き直しても残る', n1 === 1 && n2 === 1 && /見本の本/.test(await p.textContent('#chap-t')), [n1, n2]);
  check('開き直しても案内は出ない', await p.isHidden('#hint'));

  // 設定の「使い方」
  await p.click('#gear'); await p.waitForTimeout(300);
  check('設定に「使い方」（たたんである）', await p.isVisible('#help summary') && !(await p.evaluate(() => document.getElementById('help').open)));
  await p.click('#help summary');
  const help = await p.evaluate(() => ({ items: document.querySelectorAll('#help li').length, btn: !!document.querySelector('#help .open-sample') }));
  check('「使い方」に細かい説明と「見本の本を開く」', help.items >= 6 && help.btn, help);
  await p.screenshot({ path: path.join(OUT, 'guide-help.png') });

  // 見本の本を消してから、設定の「使い方」で開き直すと作り直す（書き込みはない）
  await p.click('#cfg button[value=cancel]');
  await p.click('#books'); await p.waitForTimeout(300);
  await p.evaluate(async () => {   // 本棚の削除（2回押す）
    const del = document.querySelector('#shelf .del, #shelf-list .bk-m');
    del.click(); await new Promise((r) => setTimeout(r, 100));
    const btn = document.getElementById('bk-del') || del; btn.click(); await new Promise((r) => setTimeout(r, 100)); btn.click();
  });
  await p.waitForTimeout(600);
  check('消すと本棚から消える', !((await kv('get', 'books')) || []).length && !(await kv('get', 'book:local:sample')));
  await p.click('#shelf button[value=cancel]');
  await p.click('#gear'); await p.waitForTimeout(200);
  if (!(await p.evaluate(() => document.getElementById('help').open))) await p.click('#help summary');
  await p.click('#help .open-sample');
  await p.waitForFunction(() => document.getElementById('chap-t').textContent.includes('見本'), null, { timeout: 10000 });
  await p.waitForTimeout(500);
  check('設定から開くと窓を閉じて開く', !(await p.evaluate(() => document.getElementById('cfg').open)));
  check('作り直した見本の本には書き込みがない', (await p.$$eval('#ink path.k', (els) => els.length)) === 0);

  // 通信なしでも開けるよう、アプリと一緒にキャッシュする
  const sw = fs.readFileSync(path.join(APP, 'sw.js'), 'utf8');
  check('sw.js のキャッシュに見本の本', /'sample\/guide\.md'/.test(sw));

  console.log('errs', errs); if (errs.length) ok = false;
  await b.close(); srv.close();
  console.log(ok ? 'OK' : 'NG'); process.exit(ok ? 0 : 1);
})();
