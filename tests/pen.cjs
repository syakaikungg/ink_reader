// 筆圧のペンの確認（Playwright）。md を「ファイルから開く」で開き、ペンの小窓で「筆圧」を選んで書く。GitHub は使わない。
// ペンの入力は Chrome の開発者向けの入力（CDP）で、pointerType が pen で筆圧（force）つきのものを送る。
// 使い方: node tests/pen.cjs [スクリーンショットの出力先]
// 確認すること: 小窓の「一定｜筆圧」と覚えること → 筆圧の取れないペン（ずっと 0.12）は書く速さで太さが変わる（ゆっくりは太く、速いと細い。拡大率によらない）
// → 筆圧の取れるペンは届いた筆圧をそのまま使う → 「一定」に戻すと太さ一定 → 投げ縄の「色・太さ」には出さない → 再読み込みしても同じ形
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const APP = path.resolve(__dirname, '..'), OUT = process.argv[2] || os.tmpdir();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8773);
let bad = 0;
const ok = (name, cond, info = '') => { if (!cond) bad++; console.log(cond ? '✓' : '✗', name, info); };
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
(async () => {
  const b = await chromium.launch();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-pen-'));
  fs.writeFileSync(path.join(dir, 'pen.md'), '# 筆圧のテスト\n\n' + [...Array(30)].map((_, i) => `段落${i + 1}。本文です。`.repeat(4)).join('\n\n'));
  const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404/.test(m.text()) && errs.push(m.text()));
  await p.goto('http://localhost:8773/'); await p.waitForTimeout(300);
  await p.setInputFiles('#empty .open-file', path.join(dir, 'pen.md'));
  await p.waitForFunction(() => document.querySelectorAll('#doc > p').length > 20); await p.waitForTimeout(500);
  const cdp = await ctx.newCDPSession(p);
  // ペンで書く。pts: [x, y, 筆圧]。ms ごとに1点（iPad の Pencil は 4ms ごと。ここではゆっくり送る）
  const pen = async (pts, ms = 16) => {
    const ev = (type, [x, y, force], extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'pen', force, ...extra });
    await ev('mousePressed', pts[0]);
    for (const q of pts.slice(1)) { await ev('mouseMoved', q); await new Promise((r) => setTimeout(r, ms)); }
    await ev('mouseReleased', pts[pts.length - 1]); await p.waitForTimeout(150);
  };
  // 横線: step（画面の px）ずつ n 点。筆圧は f(i)
  const hline = (x, y, step, n, f = () => .12) => [...Array(n)].map((_, i) => [x + i * step, y + Math.sin(i / 3) * .4, f(i)]);
  const saved = () => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('ink-reader', 1); r.onsuccess = () => { const s = r.result.transaction('kv').objectStore('kv'); const q = s.getAllKeys(); q.onsuccess = () => { const k = q.result.filter((x) => /^ink:local:/.test(x)).pop(); const g = s.get(k); g.onsuccess = () => res(Object.values(g.result.blocks).flatMap((x) => Object.values(x.strokes))); }; }; }));
  const press = (st) => st.p.filter((_, i) => i % 3 === 2).map((v) => v / 100);
  // 線の平均の太さ（紙の px）: 横線の輪郭の面積を横の長さで割る
  const widths = () => p.evaluate(() => [...document.querySelectorAll('#ink path:not(.lasso)')].map((e) => {
    const v = e.getAttribute('d').match(/-?[\d.]+/g).map(Number), q = []; for (let i = 0; i + 1 < v.length; i += 2) q.push(v.slice(i, i + 2));
    let a = 0; q.forEach(([x0, y0], i) => { const [x1, y1] = q[(i + 1) % q.length]; a += x0 * y1 - x1 * y0; });
    return +(Math.abs(a / 2) / e.getBBox().width).toFixed(2);
  }));
  const top = (n) => p.evaluate((n) => { const el = document.querySelectorAll('#doc > p')[n]; el.scrollIntoView({ block: 'start' }); scrollBy(0, -120); return el.getBoundingClientRect().top; }, n);

  // 小窓: 一番上に「一定｜筆圧」。はじめは一定
  await p.click('#t-pen');
  ok('小窓に一定｜筆圧', await p.isVisible('#pop-kind') && (await p.textContent('#pop-kind')) === '一定筆圧');
  ok('はじめは一定', await p.getAttribute('#pop-kind [data-k=even]', 'aria-pressed') === 'true');
  await p.click('#pop-kind [data-k=pr]');
  ok('筆圧を選ぶと覚える', await p.getAttribute('#pop-kind [data-k=pr]', 'aria-pressed') === 'true' && JSON.parse(await p.evaluate(() => localStorage.getItem('ink:pens'))).pr === 1);
  await p.screenshot({ path: path.join(OUT, 'pen-pop.png'), clip: { x: 0, y: 0, width: 820, height: 420 } });
  await p.mouse.click(5, 600);

  // 筆圧の取れないペン（ずっと 0.12）: ゆっくり書くと太く、速く書くと細い
  let y = await top(2);
  await pen(hline(150, y + 20, 2, 120));    // ゆっくり（16ms ごとに 2px、秒速 2.4cm ほど）
  await pen(hline(150, y + 70, 30, 16));    // 速い（16ms ごとに 30px、はらいくらい）
  let st = await saved();
  const slow = press(st[0]), fast = press(st[1]);
  console.log('  slow', avg(slow).toFixed(3), 'fast', avg(fast).toFixed(3), 'w', JSON.stringify(await widths()));
  ok('筆圧のペンの印', st.every((x) => x.pr === 1));
  ok('ゆっくりは太く、速いと細い（書く速さから筆圧を作る）', avg(slow) > .28 && avg(fast) < .2, `${avg(slow).toFixed(3)} ${avg(fast).toFixed(3)}`);
  const [w0, w1] = await widths();
  ok('線の太さも変わる（ペンの太さ 3.4）', w0 > 3.4 && w1 < 3 && w0 > w1 * 1.3, `${w0} ${w1}`);

  // 拡大しても、画面の上で同じ速さなら同じ筆圧
  await p.selectOption('#zoomv', '2'); await p.waitForTimeout(300);
  y = await top(8);
  await pen(hline(150, y + 20, 2, 120));
  const slow2 = press((await saved()).pop());
  ok('拡大率によらない', Math.abs(avg(slow2) - avg(slow)) < .03, `${avg(slow).toFixed(3)} ${avg(slow2).toFixed(3)}`);
  await p.selectOption('#zoomv', '1'); await p.waitForTimeout(300);

  // 筆圧の取れるペン: 届いた筆圧をそのまま使う（はじめの点も）
  y = await top(14);
  const real = hline(150, y + 20, 4, 60, (i) => .05 + .35 * Math.sin(i / 59 * Math.PI));
  await pen(real);
  const got = press((await saved()).pop());
  ok('届いた筆圧をそのまま入れる', got.length >= 50 && got.slice(0, 50).every((v, i) => Math.abs(v - Math.round(real[i][2] * 100) / 100) < .011), JSON.stringify(got.slice(0, 8)));

  // 一定に戻すと、太さ一定（印なし）
  await p.click('#t-pen'); await p.click('#pop-kind [data-k=even]'); await p.mouse.click(5, 600);
  y = await top(18);
  await pen(hline(150, y + 20, 2, 60)); await pen(hline(150, y + 70, 30, 16));
  st = await saved();
  const ws = await widths();
  ok('一定に戻すと印なし・太さ一定', !st[st.length - 1].pr && !st[st.length - 2].pr && Math.abs(ws[ws.length - 1] - ws[ws.length - 2]) < .3, JSON.stringify(ws.slice(-2)));

  // 投げ縄で選んだ線の「色・太さ」には出さない
  y = await top(2);
  await p.click('#t-ls'); await p.mouse.move(120, y - 10); await p.mouse.down(); for (const q of [[700, y - 10], [700, y + 100], [120, y + 100], [120, y - 8]]) for (let k = 1; k <= 5; k++) await p.mouse.move(q[0], q[1]); await p.mouse.up(); await p.waitForTimeout(150);
  await p.click('#sel-pen');
  ok('投げ縄の「色・太さ」には出さない', await p.isVisible('#pop-colors') && await p.isHidden('#pop-kind'));
  // 筆圧のペンの線の太さを変えても、筆圧のペンのまま
  await p.click('#pop-size .seg button:nth-child(3)'); await p.waitForTimeout(100);
  ok('太さを変えても筆圧のペンのまま', (await saved()).filter((x) => x.pr).length === 4);
  await p.click('#sel-x'); await p.click('#t-pen');

  // 再読み込みしても同じ形（保存するときに座標は 0.1px、筆圧は 0.01 に丸めるので、ほぼ同じ）
  const boxes = () => p.$$eval('#ink path:not(.lasso)', (es) => es.map((e) => { const r = e.getBBox(); return [r.x, r.y, r.width, r.height]; }).sort((a, b) => a[1] - b[1] || a[0] - b[0]));
  const d0 = await boxes();
  await p.reload(); await p.waitForTimeout(1200);
  const d1 = await boxes();
  ok('再読み込みしても同じ形', d0.length === d1.length && d0.every((r, i) => r.every((v, j) => Math.abs(v - d1[i][j]) < .3)), JSON.stringify([d0.slice(0, 2), d1.slice(0, 2)]));
  await p.click('#t-pen');
  ok('一定を覚えている', await p.getAttribute('#pop-kind [data-k=even]', 'aria-pressed') === 'true');
  // 見本の画像: 同じ動き（ゆっくり書き始めて、はらいで速くなる線）を、上は一定、下は筆圧のペンで
  const harai = (x, y) => { const out = []; let px = x, py = y; for (let i = 0; i < 70; i++) { const v = i < 40 ? 1.2 : 1.2 + (i - 40) * .5; px += v; py += v * (i < 40 ? .1 : .6); out.push([px, py, .12]); } return out; };
  const tate = (x, y) => [...Array(60)].map((_, i) => [x + Math.sin(i / 10) * 2, y + i * (i < 45 ? 1.5 : 1.5 + (i - 45) * .6), .12]);
  await p.mouse.click(5, 600); y = await top(24);
  for (const [k, dy] of [['even', 20], ['pr', 130]]) {
    await p.click('#t-pen'); await p.click(`#pop-kind [data-k=${k}]`); await p.mouse.click(5, 600);
    await pen(harai(160, y + dy)); await pen(tate(380, y + dy - 10)); await pen(harai(450, y + dy));
  }
  await p.screenshot({ path: path.join(OUT, 'pen-lines.png'), clip: { x: 0, y: Math.max(0, y - 20), width: 820, height: 260 } });
  ok('エラーなし', !errs.length, errs.join(' | '));
  console.log(bad ? `✗ ${bad} 件` : 'すべて ✓', '画像:', OUT);
  await b.close(); srv.close(); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
