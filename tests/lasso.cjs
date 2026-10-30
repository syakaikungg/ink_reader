// 投げ縄で選んだ線の複製・大きさ・回転の確認（Playwright）。md を「ファイルから開く」で開いて書き、投げ縄で選んで動かす。GitHub は使わない。
// 使い方: node tests/lasso.cjs [スクリーンショットの出力先]
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const APP = path.resolve(__dirname, '..'), OUT = process.argv[2] || os.tmpdir();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8772);
let bad = 0;
const ok = (name, cond, info = '') => { if (!cond) bad++; console.log(cond ? '✓' : '✗', name, info); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
(async () => {
  const b = await chromium.launch();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-lasso-'));
  fs.writeFileSync(path.join(dir, 'lasso.md'), '# 投げ縄のテスト\n\n' + [...Array(12)].map((_, i) => `段落${i + 1}。$x^${i}$ の式を含む本文です。`.repeat(3)).join('\n\n'));
  const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404/.test(m.text()) && errs.push(m.text()));
  await p.goto('http://localhost:8772/'); await p.waitForTimeout(300);
  await p.setInputFiles('#empty .open-file', path.join(dir, 'lasso.md'));
  await p.waitForFunction(() => document.querySelectorAll('#doc > p').length > 10); await p.waitForTimeout(500);
  await p.evaluate(() => { document.querySelectorAll('#doc > p')[2].scrollIntoView(); scrollBy(0, -300); });

  const k = await p.evaluate(() => document.querySelector('#page').getBoundingClientRect().width / 680);
  const toScr = (x, y) => p.evaluate(([x, y]) => { const r = document.getElementById('page').getBoundingClientRect(), s = r.width / 680; return [r.left + x * s, r.top + y * s]; }, [x, y]);
  const draw = async (pts) => { await p.mouse.move(...pts[0]); await p.mouse.down(); for (const q of pts) await p.mouse.move(q[0], q[1]); await p.mouse.up(); await p.waitForTimeout(100); };
  const lasso = async (x0, y0, x1, y1) => { await p.click('#t-ls'); await draw([[x0, y0], ...[[x1, y0], [x1, y1], [x0, y1], [x0, y0 + 2]].flatMap((q) => [...Array(5)].map(() => q))]); await p.waitForTimeout(150); };
  const nStrokes = () => p.evaluate(() => document.querySelectorAll('#ink path:not(.lasso)').length);
  // 線全部を囲む枠（画面の px）
  const inkBox = () => p.evaluate(() => { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const e of document.querySelectorAll('#ink path:not(.lasso)')) { const r = e.getBoundingClientRect(); a = Math.min(a, r.left); b = Math.min(b, r.top); c = Math.max(c, r.right); d = Math.max(d, r.bottom); } return [a, b, c, d].map(Math.round); });
  // 選んだ枠のつまみ（画面の px）: 0〜3 角、4 回転
  const grips = () => p.evaluate(() => [...document.querySelectorAll('#ink .grip rect, #ink .grip circle')].map((e) => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }));
  const saved = () => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('ink-reader', 1); r.onsuccess = () => { const s = r.result.transaction('kv').objectStore('kv'); const q = s.getAllKeys(); q.onsuccess = () => { const k = q.result.filter((x) => /^ink:local:/.test(x)).pop(); const g = s.get(k); g.onsuccess = () => res(Object.values(g.result.blocks).flatMap((x) => Object.values(x.strokes))); }; }; }));
  const pull = async (from, to, n = 12) => { await p.mouse.move(...from); await p.mouse.down(); for (let i = 1; i <= n; i++) await p.mouse.move(from[0] + (to[0] - from[0]) * i / n, from[1] + (to[1] - from[1]) * i / n); await p.mouse.up(); await p.waitForTimeout(200); };

  // 書く: ペン2本とマーカー1本（はじめはペンを選んでいる。選んでいるペンを押すと小窓が開くので押さない）
  const top = await p.evaluate(() => document.querySelectorAll('#doc > p')[2].getBoundingClientRect().top);
  await draw([...Array(25)].map((_, i) => [200 + i * 8, top + 30 + (i % 2) * 3]));
  await draw([...Array(20)].map((_, i) => [220 + i * 6, top + 70 + i * 3]));
  await p.click('#t-hl');
  await draw([...Array(20)].map((_, i) => [210 + i * 9, top + 130]));
  ok('3画書いた', await nStrokes() === 3);

  // 囲むとメニューに「複製」、枠の角と上につまみ
  await lasso(170, top + 5, 440, top + 160);
  const g0 = await grips();
  ok('選んだ', (await p.textContent('#sel-n')) === '3画', await p.textContent('#stat'));
  ok('複製が出る', await p.isVisible('#sel-dup'));
  ok('つまみ 4角＋回転', g0.length === 5);
  const menu = await p.evaluate(() => { const r = document.querySelector('#selmenu').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; });
  const barB = await p.evaluate(() => document.querySelector('#bar').getBoundingClientRect().bottom);
  ok('メニューは枠の上で、つまみに重ならず、ツールバーに隠れない', menu[3] < g0[4][1] - 7 * k && menu[1] >= barB && !g0.some(([x, y]) => x > menu[0] - 8 && x < menu[2] + 8 && y > menu[1] - 8 && y < menu[3] + 8), JSON.stringify({ menu: menu.map(Math.round), turn: g0[4].map(Math.round), barB }));
  await p.screenshot({ path: path.join(OUT, 'lasso-select.png'), clip: { x: 0, y: Math.max(0, menu[1] - 20), width: 820, height: 320 } });

  // 複製: 3画増え、写した方が選ばれる。戻す・進む
  const box0 = await inkBox();
  await p.click('#sel-dup'); await p.waitForTimeout(150);
  const boxD = await inkBox();
  ok('複製で 6画', await nStrokes() === 6, await p.textContent('#stat'));
  ok('写した方を選んでいる', (await p.textContent('#sel-n')) === '3画' && near((await grips())[0][0] - g0[0][0], 24, 2), JSON.stringify((await grips())[0]));
  ok('少し右下にずれる', boxD[2] - box0[2] >= 20 && boxD[3] - box0[3] >= 20, JSON.stringify([box0, boxD]));
  await p.click('#undo'); await p.waitForTimeout(100); const nU = await nStrokes();
  await p.click('#redo'); await p.waitForTimeout(100);
  ok('戻す 3画・進む 6画', nU === 3 && await nStrokes() === 6);
  await p.click('#undo'); await p.waitForTimeout(100);

  // 大きさ: 右下の角を外へ引くと、左上を止めたまま大きくなり、ペンの太さも同じだけ太る（マーカーの太さは変わらない）
  await lasso(170, top + 5, 440, top + 160);
  const s0 = await saved(), g1 = await grips(), b1 = await inkBox();
  const fr = [g1[2][0], g1[2][1]], to = [g1[0][0] + (g1[2][0] - g1[0][0]) * 1.5, g1[0][1] + (g1[2][1] - g1[0][1]) * 1.5];
  await p.mouse.move(...fr); await p.mouse.down(); for (let i = 1; i <= 12; i++) await p.mouse.move(fr[0] + (to[0] - fr[0]) * i / 12, fr[1] + (to[1] - fr[1]) * i / 12);
  await p.waitForTimeout(100);
  const live = await p.textContent('#stat'), menuHidden = await p.isHidden('#selmenu');
  await p.screenshot({ path: path.join(OUT, 'lasso-size-live.png'), clip: { x: 0, y: Math.max(0, g1[0][1] - 60), width: 820, height: 420 } });
  await p.mouse.up(); await p.waitForTimeout(200);
  const b2 = await inkBox(), s1 = await saved();
  ok('引いている間は大きさを出し、メニューを隠す', /大きさ 1[45]\d%/.test(live) && menuHidden, live);
  ok('1.5 倍の大きさ', near((b2[2] - b2[0]) / (b1[2] - b1[0]), 1.5, .06) && near((b2[3] - b2[1]) / (b1[3] - b1[1]), 1.5, .08), JSON.stringify([b1, b2]));
  ok('左上は動かない', near(b2[0], b1[0], 6) && near(b2[1], b1[1], 6));
  const w = (ss, t) => ss.filter((x) => x.t === t).map((x) => x.s).sort((x, y) => x - y);
  ok('ペンの太さも 1.5 倍、マーカーはそのまま', w(s1, 'pen').every((v, i) => near(v / w(s0, 'pen')[i], 1.5, .03)) && w(s1, 'hl')[0] === w(s0, 'hl')[0], JSON.stringify([w(s0, 'pen'), w(s1, 'pen'), w(s0, 'hl'), w(s1, 'hl')]));
  ok('離すとメニューが戻る', await p.isVisible('#selmenu'), await p.textContent('#stat'));

  // 回転: 上の丸を枠のまん中のまわりに 90 度回すと、縦と横が入れ替わる（0・90 度の近くではそろう）
  const g2 = await grips(), c2 = [(g2[0][0] + g2[2][0]) / 2, (g2[0][1] + g2[2][1]) / 2], R = Math.hypot(g2[4][0] - c2[0], g2[4][1] - c2[1]);
  await p.mouse.move(...g2[4]); await p.mouse.down();
  for (let i = 1; i <= 18; i++) { const t = -Math.PI / 2 + (Math.PI / 2 + 2 * Math.PI / 180) * i / 18; await p.mouse.move(c2[0] + R * Math.cos(t), c2[1] + R * Math.sin(t)); }
  await p.waitForTimeout(100); const turnLive = await p.textContent('#stat'); await p.mouse.up(); await p.waitForTimeout(200);
  const b3 = await inkBox();
  ok('92 度まで回しても 90 度にそろう', turnLive === '向き 90°', turnLive);
  ok('縦と横が入れ替わる', near(b3[2] - b3[0], b2[3] - b2[1], 14) && near(b3[3] - b3[1], b2[2] - b2[0], 14), JSON.stringify([b2, b3]));
  await p.screenshot({ path: path.join(OUT, 'lasso-turned.png'), clip: { x: 0, y: Math.max(0, b3[1] - 120), width: 820, height: 520 } });
  // 触っただけなら何も変わらない
  const nu0 = await p.evaluate(() => document.querySelector('#undo').disabled);
  const g3 = await grips(); await p.mouse.move(...g3[1]); await p.mouse.down(); await p.mouse.up(); await p.waitForTimeout(100);
  ok('つまみを触っただけでは変わらない', JSON.stringify(await inkBox()) === JSON.stringify(b3) && await p.isVisible('#selmenu'));
  // 戻すを2回で元の大きさ・向き
  await p.click('#undo'); await p.waitForTimeout(100); await p.click('#undo'); await p.waitForTimeout(100);
  ok('戻すで元どおり', JSON.stringify(await inkBox()) === JSON.stringify(b1), JSON.stringify([b1, await inkBox()]));
  await p.click('#redo'); await p.click('#redo'); await p.waitForTimeout(100);
  ok('進むで回した形', JSON.stringify(await inkBox()) === JSON.stringify(b3));

  // 図形: 円を書いて投げ縄で1つ選ぶと、円のつまみと枠のつまみの両方が出る。枠の角で大きくすると、円のまま半径が変わる
  await p.click('#t-pen');
  const cy = top + 520, circ = []; for (let i = 0; i <= 40; i++) { const t = i / 40 * 2 * Math.PI; circ.push([400 + 50 * Math.cos(t), cy + 50 * Math.sin(t)]); }
  await p.mouse.move(...circ[0]); await p.mouse.down(); for (const q of circ) await p.mouse.move(q[0], q[1]); await p.waitForTimeout(650); await p.mouse.up(); await p.waitForTimeout(150);
  ok('円に直した', /円/.test(await p.textContent('#stat')), await p.textContent('#stat'));
  await lasso(320, cy - 80, 480, cy + 80);
  const hd = await p.evaluate(() => document.querySelectorAll('#ink .hd circle').length), gc = await grips();
  ok('円のつまみと枠のつまみ', hd === 1 && gc.length === 5, `${hd} ${gc.length}`);
  const cb0 = await inkBox();
  await pull(gc[2], [gc[2][0] + 40, gc[2][1] + 40]);
  const shapes = (await saved()).filter((x) => x.g);
  ok('円のまま大きくなる', shapes.length === 1 && shapes[0].g.k === 'circle' && shapes[0].g.v[2] > 500 + 40, JSON.stringify(shapes.map((x) => x.g)));
  // 回すと、円の中心は動かない
  const gr = await grips(); const cc = [(gr[0][0] + gr[2][0]) / 2, (gr[0][1] + gr[2][1]) / 2], RR = Math.hypot(gr[4][0] - cc[0], gr[4][1] - cc[1]);
  await p.mouse.move(...gr[4]); await p.mouse.down(); for (let i = 1; i <= 10; i++) { const t = -Math.PI / 2 + Math.PI / 4 * i / 10; await p.mouse.move(cc[0] + RR * Math.cos(t), cc[1] + RR * Math.sin(t)); } await p.mouse.up(); await p.waitForTimeout(200);
  const after = (await saved()).filter((x) => x.g)[0].g;
  ok('回しても円の中心はそのまま', near(after.v[0], shapes[0].g.v[0], 2) && near(after.v[1], shapes[0].g.v[1], 2) && after.v[2] === shapes[0].g.v[2], JSON.stringify([shapes[0].g.v, after.v, after.a]));
  // 円のつまみを動かすと、円の半径が変わる（枠のつまみより円のつまみに近い所を押した）
  const hc = await p.evaluate(() => { const c = document.querySelector('#ink .hd circle'), r = c.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  await pull(hc, [hc[0] + 20, hc[1]], 6);
  ok('円のつまみも使える', /円の形を変えました/.test(await p.textContent('#stat')), await p.textContent('#stat'));
  await p.click('#sel-x');

  // 枠が画面の上の端に近いと、メニューはツールバーに隠れないよう枠の下に出る
  await p.evaluate(() => scrollBy(0, 230)); await p.waitForTimeout(100);
  const tt = await p.evaluate(() => document.querySelectorAll('#doc > p')[2].getBoundingClientRect().top);
  await lasso(170, tt + 5, 440, tt + 160);
  const m2 = await p.evaluate(() => { const r = document.querySelector('#selmenu').getBoundingClientRect(); return [r.top, r.bottom]; }), g4 = await grips();
  ok('上が詰まっていれば枠の下に出る', m2[0] > g4[2][1], JSON.stringify({ menu: m2.map(Math.round), bottom: Math.round(g4[2][1]) }));
  await p.click('#sel-x');

  // 再読み込みしても残る
  const nAll = await nStrokes();
  await p.reload(); await p.waitForTimeout(1200);
  ok('再読み込みしても残る', await nStrokes() === nAll, `${nAll} -> ${await nStrokes()}`);
  ok('エラーなし', !errs.length, errs.join(' | '));
  console.log(bad ? `✗ ${bad} 件` : 'すべて ✓', '画像:', OUT);
  await b.close(); srv.close(); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
