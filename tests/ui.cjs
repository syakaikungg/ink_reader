// 画面を Claude と分けたときの使い勝手の確認（Playwright。ドライブも GitHub も使わない）
// 使い方: node tests/ui.cjs
// 確認すること: 幅 590px（iPad を半分ずつ）でもツールバーが1行で、拡大率・指で書く・設定は「…」の中 → 2本指で軽くたたくと戻す・3本指で進む
// （動かした・ゆっくりだったときは何もしない、拡大率も変えない）→ 目次・検索で飛ぶと左下に「‹ 〜に戻る」が出て、押すと元の所へ
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const APP = path.resolve(__dirname, '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8772);
let ok = true;
const check = (name, v) => { console.log(v ? '✓' : '✗', name); if (!v) ok = false; };

(async () => {
  const b = await chromium.launch();
  const mdPath = path.join(os.tmpdir(), 'ink-ui.md');
  const para = (i) => `段落${i}の本文です。` + 'ことばを足して長くする。'.repeat(8);
  fs.writeFileSync(mdPath, '# 使い勝手\n\n' + [...Array(60)].map((_, i) => i === 40 ? '## 遠くの節' : i === 10 ? '## 近くの節' : para(i + 2)).join('\n\n') + '\n');
  const ctx = await b.newContext({ viewport: { width: 590, height: 1000 }, deviceScaleFactor: 2, hasTouch: true });
  await ctx.route('https://**', (r) => r.fulfill({ status: 404, body: '{}' }));
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404/.test(m.text()) && errs.push(m.text()));
  await p.goto('http://localhost:8772/');
  await p.evaluate(() => localStorage.setItem('ink:hint', '0')); await p.reload();
  await p.setInputFiles('#empty .open-file', mdPath);
  await p.waitForFunction(() => document.querySelectorAll('#doc > p').length > 50, null, { timeout: 15000 });
  await p.waitForTimeout(500);

  // ツールバー: 1行（下の知らせの行を入れて 2 行分）。拡大率・指で書く・設定は「…」の中
  const bar = await p.evaluate(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); return { h: document.getElementById('bar').offsetHeight, pen: r('#t-pen').top, ls: r('#t-ls').top, more: r('#more').top, books: r('#books').top, gear: r('#gear').width }; });
  console.log('bar', bar);
  check('幅 590px でもツールは1行', bar.h <= 80 && bar.pen === bar.ls && bar.pen === bar.books && Math.abs(bar.more - bar.pen) < 4);
  check('設定などは隠れている', bar.gear === 0);
  await p.click('#more');
  check('「…」を押すと拡大率・指で書く・設定', await p.isVisible('#gear') && await p.isVisible('#finger') && await p.isVisible('#zoomv'));
  await p.click('#finger');
  check('選ぶと閉じる（指で書くはオン）', !(await p.isVisible('#gear')) && await p.getAttribute('#finger', 'aria-pressed') === 'true');
  await p.click('#more'); await p.click('#finger');   // 元に戻す
  await p.click('#more'); await p.click('#stat');
  check('外を触ると閉じる', !(await p.isVisible('#gear')));
  const wide = await b.newPage({ viewport: { width: 1180, height: 800 } });
  await wide.goto('http://localhost:8772/'); await wide.waitForTimeout(300);
  check('広い画面では「…」は出さず、そのまま並べる', !(await wide.isVisible('#more')) && await wide.isVisible('#gear'));
  await wide.close();

  // 2本指・3本指でたたく（CDP で指を置く）
  const cdp = await ctx.newCDPSession(p);
  const touch = async (pts, ms = 80, move = 0) => {
    const tp = (d) => pts.map(([x, y], i) => ({ x: x + d, y, id: i + 1, radiusX: 4, radiusY: 4, force: 1 }));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(0) });
    if (move) for (let k = 1; k <= 5; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(move * k / 5) }); await p.waitForTimeout(10); }
    await p.waitForTimeout(ms);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await p.waitForTimeout(150);
  };
  const line = async (x, y) => { await p.mouse.move(x, y); await p.mouse.down(); for (let i = 0; i < 20; i++) await p.mouse.move(x + i * 5, y + (i % 2) * 3); await p.mouse.up(); };
  const n = () => p.evaluate(() => document.querySelectorAll('#ink path').length);
  const zoom = () => p.evaluate(() => document.getElementById('page').style.transform);
  await line(150, 400); await line(150, 460); await p.waitForTimeout(200);
  const z0 = await zoom();
  check('2本書いた', await n() === 2);
  await touch([[200, 600], [320, 620]]);
  check('2本指でたたくと戻す', await n() === 1 && /戻しました/.test(await p.textContent('#stat')));
  await touch([[200, 600], [320, 620], [260, 700]]);
  check('3本指でたたくと進む', await n() === 2 && /進めました/.test(await p.textContent('#stat')));
  check('たたいても拡大率は変わらない', await zoom() === z0);
  await touch([[200, 600], [320, 620]], 500);
  check('ゆっくり（0.5 秒）なら戻さない', await n() === 2);
  await touch([[200, 600], [320, 620]], 60, 40);
  check('指を動かしたら（スクロール・ピンチ）戻さない', await n() === 2);
  await touch([[200, 600]]);
  check('1本指でたたいても戻さない', await n() === 2);

  // 目次で遠くの節へ飛ぶ → 左下に「‹ 近くの節に戻る」→ 押すと元の所
  await p.evaluate(() => { const h = [...document.querySelectorAll('#doc h2')].find((x) => x.textContent === '近くの節'); scrollTo(0, h.getBoundingClientRect().top + scrollY - 200); });
  await p.waitForTimeout(200);
  const y0 = await p.evaluate(() => scrollY);
  check('飛ぶ前は札がない', await p.isHidden('#back'));
  await p.click('#chap'); await p.waitForTimeout(200);
  await p.click('#toc-list button.h2 >> text=遠くの節'); await p.waitForTimeout(300);
  const y1 = await p.evaluate(() => scrollY);
  console.log('scroll', y0, '->', y1, await p.textContent('#back'));
  check('目次で飛ぶと「‹ 近くの節に戻る」', y1 > y0 + 1000 && await p.isVisible('#back') && /‹ 近くの節に戻る/.test(await p.textContent('#back')));
  await p.click('#back-go'); await p.waitForTimeout(200);
  check('押すと元の所へ戻り、札は消える', Math.abs(await p.evaluate(() => scrollY) - y0) < 2 && await p.isHidden('#back'));
  // 検索で飛んで、× で消す
  await p.click('#chap'); await p.waitForTimeout(200);
  await p.fill('#toc-q', '段落55の'); await p.waitForTimeout(600);
  await p.click('#toc-hits button'); await p.waitForTimeout(300);
  check('検索で飛んでも札が出る', await p.isVisible('#back'));
  await p.click('#back-x');
  check('× で消える（その場に残る）', await p.isHidden('#back') && await p.evaluate(() => scrollY) > y0 + 1000);
  // 同じ画面の中の見出しへ動いただけなら出さない
  await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(100);
  await p.click('#chap'); await p.waitForTimeout(200);
  await p.click('#toc-list button.cur'); await p.waitForTimeout(200);
  check('ほとんど動かないときは出さない', await p.isHidden('#back'));
  check('エラーなし', !errs.length); if (errs.length) console.log(errs);
  await b.close(); srv.close();
  console.log(ok ? 'OK' : 'NG'); process.exit(ok ? 0 : 1);
})();
