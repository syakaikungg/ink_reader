// 色・太さの札と「読むだけ」の確認（Playwright。GitHub とドライブは使わない）
// 使い方: node tests/rail.cjs [スクリーンショットの出力先]
// 確認すること: 広い画面でははじめから札が出ている → 色・太さを押すとペンが変わり、札は書いても閉じない → 選んでいるペンをもう一度押すとしまう・出す（覚える）
// → 4 つにない色を小窓で選ぶと、一番長く使っていない色の場所に入る → 消しゴムの札（消し方・大きさ 3 つ）→ マーカーでは出さない → 投げ縄の札（自由・四角）で四角に囲む
// → 長押しして右へ動かすと右の端に置き、開き直しても右 → 札の「…」で小窓が札の横に出る → 幅 590px では細く、はじめはしまっている、本文にかからない
// → 読むだけ: 書けない・札は隠れる・ツールを押すと戻る・指で書くと同時にはオンにならない → 幅 744px では「…」の中
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const APP = path.resolve(__dirname, '..'), OUT = process.argv[2] || os.tmpdir();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8777);
let ok = true;
const check = (name, v, info) => { console.log(v ? '✓' : '✗', name, info === undefined ? '' : JSON.stringify(info)); if (!v) ok = false; };

(async () => {
  const b = await chromium.launch();
  const open = async (w, h) => {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, hasTouch: true });
    await ctx.route('https://**', (r) => r.fulfill({ status: 404, body: '{}' }));
    const p = await ctx.newPage(); p.errs = []; p.on('pageerror', (e) => p.errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404/.test(m.text()) && p.errs.push(m.text()));
    await p.goto('http://localhost:8777/'); await p.waitForTimeout(400);
    await p.click('#hint .open-sample');
    await p.waitForFunction(() => document.getElementById('chap-t').textContent.includes('見本'), null, { timeout: 10000 });
    await p.waitForTimeout(400);
    return p;
  };
  const line = async (p, x, y) => { await p.mouse.move(x, y); await p.mouse.down(); for (let i = 0; i < 20; i++) await p.mouse.move(x + i * 5, y + (i % 2) * 3); await p.mouse.up(); await p.waitForTimeout(100); };
  const n = (p) => p.evaluate(() => document.querySelectorAll('#ink path').length);
  const pens = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('ink:pens') || '{}'));
  const rect = (p, s) => p.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; }, s);
  const fill = (p) => p.evaluate(() => { const ps = [...document.querySelectorAll('#ink path')]; const x = ps[ps.length - 1]; return x.getAttribute('class') + ' ' + x.style.fill; });

  // ---------- 広い画面（横向き） ----------
  const p = await open(1180, 820);
  check('広い画面でははじめから札が出ている（ペン）', await p.isVisible('#rail') && await p.isVisible('#rail-pen') && await p.isHidden('#rail-er'));
  const r0 = await rect(p, '#rail'), h0 = await rect(p, '#hist');
  check('札は戻す・進むの札の下・左の端', r0.l === h0.l && r0.t >= h0.b && r0.t - h0.b < 20, [r0, h0]);
  check('色 4 つ・太さ 3 つ', await p.$$eval('#rail .rc button', (x) => x.length) === 4 && await p.$$eval('#rail .rw button', (x) => x.length) === 3);
  await p.click('#rail .rc button:nth-child(2)');
  check('札の赤を押すとペンが赤', (await pens(p)).c === 'r' && await p.getAttribute('#rail .rc button:nth-child(2)', 'aria-pressed') === 'true');
  await line(p, 300, 400);
  check('赤で書ける・書いても札は閉じない', /\br\b/.test(await fill(p)) && await p.isVisible('#rail'));
  await p.click('#rail .rw button:nth-child(3)');
  check('太さを押すと太いペン', (await pens(p)).si === 2 && await p.getAttribute('#rail .rw button:nth-child(3)', 'aria-pressed') === 'true');
  await p.screenshot({ path: path.join(OUT, 'rail-pen.png') });
  await p.click('#t-pen');
  check('選んでいるペンをもう一度押すと札をしまう（小窓は出ない）', await p.isHidden('#rail') && await p.isHidden('#pop'));
  check('しまったことを覚える', JSON.parse(await p.evaluate(() => localStorage.getItem('ink:rail'))).on === false);
  await p.click('#t-pen');
  check('もう一度押すと出す', await p.isVisible('#rail'));

  // 「…」で小窓。札の横に出る
  await p.click('#rail-pen .rm');
  const pr = await rect(p, '#pop'), rr = await rect(p, '#rail');
  check('札の「…」で小窓（12 色・筆圧）が札の右に出る', await p.isVisible('#pop-colors') && await p.isVisible('#pop-kind') && pr.l >= rr.r, [pr, rr]);
  // 4 つにない色（紫）を選ぶと、一番長く使っていない場所（黒・青・緑のうち、まだ使っていない最初の黒）に入る
  await p.click('#pop-colors button:nth-child(6)');
  const pp = await pens(p);
  check('4 つにない色は、一番長く使っていない色の場所に入る', pp.c === '#7b3fc4' && pp.fav[0] === '#7b3fc4' && pp.fav[1] === 'r' && await p.getAttribute('#rail .rc button:nth-child(1)', 'aria-pressed') === 'true', pp.fav);
  await p.click('#rail-pen .rm');
  check('もう一度押すと小窓を閉じる', await p.isHidden('#pop'));

  // 消しゴム
  await p.click('#t-er');
  check('消しゴムでは消し方・大きさの札', await p.isVisible('#rail-er') && await p.isHidden('#rail-pen'));
  await p.click('#rail-er [data-m=part]');
  await p.click('#rail-er .rs button:nth-child(3)');
  const er = JSON.parse(await p.evaluate(() => localStorage.getItem('ink:eraser')));
  check('消し方と大きさを覚える', er.m === 'part' && er.ri === 2 && er.r === er.rs[2], er);
  await p.screenshot({ path: path.join(OUT, 'rail-er.png') });
  await p.click('#t-er');
  check('選んでいる消しゴムをもう一度押すと札をしまう', await p.isHidden('#rail'));
  await p.click('#t-er');
  await p.click('#t-hl');
  check('マーカーでは出さない', await p.isHidden('#rail'));
  await p.click('#t-ls');
  check('投げ縄では囲み方の札（はじめは自由）', await p.isVisible('#rail-ls') && await p.isHidden('#rail-pen') && await p.getAttribute('#rail-ls [data-k=free]', 'aria-pressed') === 'true');
  // 四角で囲む: ななめに引くと四角になり、中の線を選ぶ（横に平らに引いても余白は入らない）
  await p.click('#rail-ls [data-k=rect]');
  await p.mouse.move(280, 380); await p.mouse.down();
  for (let k = 1; k <= 8; k++) await p.mouse.move(280 + k * 25, 380 + k * 6);
  const lp = await p.evaluate(() => (document.querySelector('#ink .lasso')?.getAttribute('d') || '').split('L').length);
  await p.mouse.up(); await p.waitForTimeout(150);
  check('四角で囲むと 4 つの角の囲みになり、中の線を選ぶ', lp === 4 && /1画を選択/.test(await p.textContent('#stat')) && await p.isVisible('#selmenu'), [lp, await p.textContent('#stat')]);
  await p.click('#sel-x');
  const g0 = await p.evaluate(() => document.querySelectorAll('#sps .sp').length);
  await p.mouse.move(150, 600); await p.mouse.down(); for (let k = 1; k <= 10; k++) await p.mouse.move(150 + k * 60, 602); await p.mouse.up(); await p.waitForTimeout(150);
  check('四角のときは横に引いても余白を入れない', await p.evaluate(() => document.querySelectorAll('#sps .sp').length) === g0);
  check('囲み方を覚える', JSON.parse(await p.evaluate(() => localStorage.getItem('ink:rail'))).ls === 'rect');
  await p.click('#rail-ls [data-k=free]');
  await p.click('#t-pen');
  check('ペンに戻すと出る', await p.isVisible('#rail'));

  // 長押しして右へ動かす
  const c0 = await rect(p, '#rail .rw');
  await p.mouse.move(c0.l + 20, c0.t + 4); await p.mouse.down(); await p.waitForTimeout(500);
  for (let k = 1; k <= 10; k++) await p.mouse.move(c0.l + 20 + k * 100, c0.t + 4 + k * 10);
  await p.mouse.up(); await p.waitForTimeout(150);
  const r1 = await rect(p, '#rail');
  check('長押しして引っぱると右の端に置く', r1.r === 1180 - 12 && r1.t > r0.t, r1);
  check('動かしたときは太さを変えない', (await pens(p)).si === 2);
  await p.reload(); await p.waitForTimeout(800);
  const r2 = await rect(p, '#rail');
  check('開き直しても右の端・同じ高さ', r2.r === 1180 - 12 && Math.abs(r2.t - r1.t) < 2, r2);
  await p.screenshot({ path: path.join(OUT, 'rail-right.png') });

  // 上の端へ動かすと横向きになり、戻す・進むの札の右に並ぶ
  const drag = async (x0, y0, x1, y1) => { await p.mouse.move(x0, y0); await p.mouse.down(); await p.waitForTimeout(500); for (let k = 1; k <= 12; k++) await p.mouse.move(x0 + (x1 - x0) * k / 12, y0 + (y1 - y0) * k / 12); await p.mouse.up(); await p.waitForTimeout(150); };
  const c1 = await rect(p, '#rail .rw'), hb = await rect(p, '#bar');
  await drag(c1.l + 20, c1.t + 4, 600, hb.b + 20);
  const t1 = await rect(p, '#rail'), h1 = await rect(p, '#hist');
  check('上の端へ引っぱると横向きになる', await p.evaluate(() => document.getElementById('rail').classList.contains('t')) && t1.w > t1.h * 4 && await p.getAttribute('#rail', 'aria-orientation') === 'horizontal', t1);
  check('上の端では戻す・進むの札と同じ高さで、画面の真ん中', Math.abs(t1.t - h1.t) < 2 && Math.abs((t1.l + t1.r) / 2 - 1180 / 2) < 2, [t1, h1]);
  check('動かしたときは太さを変えない（上）', (await pens(p)).si === 2);
  const w1 = await rect(p, '#rail .rw button:nth-child(3)');
  await p.click('#rail .rw button:nth-child(1)');
  check('横向きでも太さを選べる', (await pens(p)).si === 0 && w1.t > t1.t && w1.b < t1.b);
  await p.click('#rail-pen .rm'); await p.waitForTimeout(100);
  const pp1 = await rect(p, '#pop');
  check('上の端の「…」の小窓は札の下に出る', await p.isVisible('#pop') && pp1.t >= t1.b, [pp1, t1]);
  await p.click('#rail-pen .rm');
  await p.reload(); await p.waitForTimeout(800);
  const t2 = await rect(p, '#rail');
  check('開き直しても上の端・同じ左右の位置', Math.abs(t2.l - t1.l) < 2 && Math.abs(t2.t - t1.t) < 2 && JSON.parse(await p.evaluate(() => localStorage.getItem('ink:rail'))).side === 't', [t2, t1]);
  await p.screenshot({ path: path.join(OUT, 'rail-top.png') });
  await p.click('#t-er');
  const e1 = await rect(p, '#rail');
  check('消しゴムの札も横向き', await p.isVisible('#rail-er') && e1.w > e1.h * 3 && Math.abs(e1.t - t1.t) < 2, e1);
  await p.click('#t-pen');
  // 左の端へ戻す
  const c2 = await rect(p, '#rail .rw');
  await drag(c2.l + 10, c2.t + 10, 40, 500);
  const t3 = await rect(p, '#rail');
  check('左の端へ戻すと縦向き', !await p.evaluate(() => document.getElementById('rail').classList.contains('t')) && t3.h > t3.w * 4 && t3.l === 12, t3);
  await drag(t3.l + 20, t3.t + 30, 1100, 400);
  check('右の端へも戻せる', (await rect(p, '#rail')).r === 1180 - 12);

  // 読むだけ
  await p.click('#readonly');
  const before = await n(p);
  await line(p, 300, 500);
  check('読むだけでは書けない', await n(p) === before && await p.getAttribute('#readonly', 'aria-pressed') === 'true');
  check('読むだけでは札を隠す', await p.isHidden('#rail'));
  await p.click('#t-pen');
  check('ペンを押すと書けるように戻る（札も戻る）', await p.getAttribute('#readonly', 'aria-pressed') === 'false' && await p.isVisible('#rail'));
  await line(p, 300, 520);
  check('戻ったら書ける', await n(p) === before + 1);
  await p.click('#finger'); await p.click('#readonly');
  check('読むだけにすると指で書くはオフ', await p.getAttribute('#finger', 'aria-pressed') === 'false' && await p.getAttribute('#readonly', 'aria-pressed') === 'true');
  await p.click('#finger');
  check('指で書くにすると読むだけはオフ', await p.getAttribute('#readonly', 'aria-pressed') === 'false' && await p.getAttribute('#finger', 'aria-pressed') === 'true');
  await p.click('#finger');
  check('エラーなし（広い画面）', !p.errs.length, p.errs);

  // ---------- 画面を半分（590px） ----------
  const q = await open(590, 820);
  check('幅 590px でははじめは札をしまっている', await q.isHidden('#rail'));
  await q.click('#t-pen');
  const s0 = await rect(q, '#rail'), text = await q.evaluate(() => { const pg = document.getElementById('page').getBoundingClientRect(); return Math.round(pg.left + 48 * pg.width / 680); });
  check('出すと細い札で、本文にかからない', await q.isVisible('#rail') && s0.w === 40 && s0.r <= text, [s0, text]);
  await q.screenshot({ path: path.join(OUT, 'rail-split.png') });
  {
    const c = await rect(q, '#rail .rw'), qb = await rect(q, '#bar');
    await q.mouse.move(c.l + 10, c.t + 4); await q.mouse.down(); await q.waitForTimeout(500);
    for (let k = 1; k <= 12; k++) await q.mouse.move(c.l + 10 + (560 - c.l - 10) * k / 12, c.t + 4 + (qb.b + 20 - c.t - 4) * k / 12);
    await q.mouse.up(); await q.waitForTimeout(150);
    const t = await rect(q, '#rail'), h = await rect(q, '#hist');
    check('幅 590px でも上の端の真ん中に置け、戻す・進むの札にかからない', t.w > t.h * 4 && t.l >= h.r + 8 && Math.abs((t.l + t.r) / 2 - 590 / 2) < 2 && Math.abs(t.h - h.h) < 2, [t, h]);
    await q.screenshot({ path: path.join(OUT, 'rail-top-split.png') });
  }
  check('エラーなし（590px）', !q.errs.length, q.errs);

  // ---------- iPad mini の縦（744px） ----------
  const m = await open(744, 1133);
  const bar = await m.evaluate(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); return { pen: r('#t-pen').top, more: r('#more').top, ro: r('#readonly').width }; });
  check('幅 744px では拡大率・指で書く・読むだけ・設定は「…」の中（ツールは1行）', Math.abs(bar.more - bar.pen) < 4 && bar.ro === 0, bar);
  await m.click('#more');
  check('「…」に読むだけがある', await m.isVisible('#readonly'));
  await m.click('#readonly');
  check('読むだけにすると「…」は閉じて青くなる', await m.isHidden('#readonly') && await m.evaluate(() => getComputedStyle(document.getElementById('more')).color) === 'rgb(39, 71, 201)');
  check('エラーなし（744px）', !m.errs.length, m.errs);

  await b.close(); srv.close();
  console.log(ok ? '\nすべて OK' : '\n失敗あり');
  process.exit(ok ? 0 : 1);
})();
