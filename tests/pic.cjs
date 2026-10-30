// 紙に画像を貼る確認（Playwright + pypdf + pdftoppm）。ドライブ API はモックし、iPad ごとに新しいブラウザの環境を作る（GitHub は使わない）
// 使い方: node tests/pic.cjs [スクリーンショットの出力先]   （python3 と pypdf・PIL、pdftoppm が要る）
// 確認すること: ツールバーの「画像」（1行のまま）→ 写真を選ぶと見えている所のまん中に貼られ、投げ縄で選んだまま → 外を押すとペンに戻る
// → 画像の上に書ける・消しゴムでは消えない → 投げ縄でたたいて選ぶ・動かす・大きさ・向き・戻す・複製・削除 → 透ける画像は PNG のまま
// → ドライブの <本>/pics/ に置き、書き込み JSON に pics → 別の iPad で同じ md を開くと画像も出る → md の書き出しに画像が入る
// → PDF の本に貼って書き出す・ドライブのものだけで ink_export.mjs（--pics）でも同じ所に入る
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os'), { execFileSync } = require('child_process');
const APP = path.resolve(__dirname, '..'), OUT = process.argv[2] || os.tmpdir();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8777);
let bad = 0;
const check = (name, v, info) => { console.log(v ? '✓' : '✗', name, info === undefined ? '' : info); if (!v) bad++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const py = (code, ...args) => execFileSync('python3', ['-I', '-c', code, ...args], { encoding: 'utf8' }).trim();
const { createDrive, GIS, FOLDER, connected } = require('./drive-mock.cjs');
const drv = createDrive(), { files, byPath, twins } = drv;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-pic-'));
  // 写真の代わり: 左が赤・右が青（透けない PNG → JPEG にする）。透ける画像: 透明の上に緑の丸（PNG のまま）
  py(`import sys
from PIL import Image, ImageDraw
im = Image.new('RGB', (1200, 800), (208, 32, 32)); ImageDraw.Draw(im).rectangle([600, 0, 1199, 799], fill=(32, 64, 208)); im.save(sys.argv[1] + '/photo.png')
c = Image.new('RGBA', (400, 300), (0, 0, 0, 0)); ImageDraw.Draw(c).ellipse([50, 25, 350, 275], fill=(30, 160, 60, 255)); c.save(sys.argv[1] + '/clear.png')`, dir);
  fs.writeFileSync(path.join(dir, 'note.md'), '# 画像のテスト\n\n' + [...Array(14)].map((_, i) => `段落${i + 1}。$x^${i}$ の式を含む本文です。`.repeat(3)).join('\n\n'));
  const b = await chromium.launch();
  const mk = await b.newPage();
  await mk.setContent(`<style>body{margin:0;font:32px serif} section{height:100vh;page-break-after:always;padding:40px;box-sizing:border-box}</style>` + [1, 2].map((i) => `<section><p>slides ${i}</p></section>`).join(''));
  await mk.pdf({ path: path.join(dir, 'slides.pdf'), format: 'A4' }); await mk.close();

  const errs = [];
  const iPad = async (w = 820) => {
    const ctx = await b.newContext({ viewport: { width: w, height: 1180 }, deviceScaleFactor: 2, hasTouch: true });
    await ctx.route('https://www.googleapis.com/**', drv.route);
    await ctx.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: GIS }));
    // iPad の共有シートの代わり: 渡されたファイルを覚えておく
    await ctx.addInitScript(() => {
      window.__shared = [];
      navigator.canShare = () => true;
      navigator.share = async (d) => {
        const f = d.files[0], u = new Uint8Array(await f.arrayBuffer()); let t = '';
        for (let i = 0; i < u.length; i += 0x8000) t += String.fromCharCode(...u.subarray(i, i + 0x8000));
        window.__shared.push({ name: f.name, b64: btoa(t) });
      };
    });
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404|401/.test(m.text()) && errs.push(m.text()));
    await p.goto('http://localhost:8777/'); await p.evaluate((kv) => { for (const k in kv) localStorage.setItem(k, kv[k]); localStorage.setItem('ink:zoom', '1'); }, connected()); await p.reload(); await p.waitForTimeout(500);
    return p;
  };
  const openFile = async (p, file, t) => {
    if (await p.isVisible('#empty')) await p.setInputFiles('#empty .open-file', path.join(dir, file));
    else { await p.click('#books'); await p.waitForFunction(() => document.getElementById('shelf').open); await p.setInputFiles('#shelf .open-file', path.join(dir, file)); }
    await p.waitForFunction((t) => document.getElementById('chap-t').textContent.includes(t), t, { timeout: 20000 }); await p.waitForTimeout(800);
  };
  const draw = async (p, pts) => { await p.mouse.move(...pts[0]); await p.mouse.down(); for (const q of pts) await p.mouse.move(q[0], q[1]); await p.mouse.up(); await p.waitForTimeout(150); };
  const tap = async (p, x, y) => { await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.up(); await p.waitForTimeout(150); };
  const pull = async (p, from, to, n = 12) => { await p.mouse.move(...from); await p.mouse.down(); for (let i = 1; i <= n; i++) await p.mouse.move(from[0] + (to[0] - from[0]) * i / n, from[1] + (to[1] - from[1]) * i / n); await p.mouse.up(); await p.waitForTimeout(200); };
  const pics = (p) => p.evaluate(() => [...document.querySelectorAll('#ink .pic')].map((e) => { const r = e.lastChild.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, href: e.lastChild.getAttribute('href') || '', miss: e.classList.contains('miss') }; }));
  const grips = (p) => p.evaluate(() => [...document.querySelectorAll('#ink .grip rect, #ink .grip circle')].map((e) => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }));
  // IndexedDB の kv を読む: keys（re に合うキー）・savedPics（今の本の書き込みの pics）
  const kvAll = (p) => p.evaluate(() => new Promise((res, rej) => { const r = indexedDB.open('ink-reader', 1); r.onerror = rej; r.onsuccess = () => { const s = r.result.transaction('kv').objectStore('kv'), q = s.getAllKeys(); q.onsuccess = () => res(q.result.map(String)); }; }));
  const keys = async (p, re) => (await kvAll(p)).filter((k) => re.test(k));
  const savedPics = async (p) => {
    const k = (await keys(p, /^ink:local:/)).pop();
    return p.evaluate((k) => new Promise((res) => { const r = indexedDB.open('ink-reader', 1); r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get(k); g.onsuccess = () => res(Object.values((g.result || {}).blocks || {}).flatMap((x) => Object.values(x.pics || {}))); }; }), k);
  };
  const pressed = (p, id) => p.getAttribute(id, 'aria-pressed');
  const shared = async (p, name) => { await p.waitForFunction(() => window.__shared.length, null, { timeout: 60000 }); const x = await p.evaluate(() => window.__shared.pop()); const f = path.join(dir, name); fs.writeFileSync(f, Buffer.from(x.b64, 'base64')); return f; };
  // PDF の i ページ目を 72dpi で描き、赤・青・緑の点の数と、その点のまとまりの枠（pt）を数える
  const colorsOf = (f, i = 1) => JSON.parse(py(`import sys, json, subprocess
from PIL import Image
subprocess.run(['pdftoppm', '-r', '72', '-f', sys.argv[2], '-l', sys.argv[2], '-png', sys.argv[1], sys.argv[1] + '-r'], check=True)
import glob; im = Image.open(sorted(glob.glob(sys.argv[1] + '-r*.png'))[0]).convert('RGB'); W, H = im.size; px = im.load()
out = {}
for k, f in [('red', lambda r, g, b: r > 170 and g < 80 and b < 80), ('blue', lambda r, g, b: b > 170 and r < 80 and g < 110), ('green', lambda r, g, b: g > 130 and r < 80 and b < 100), ('black', lambda r, g, b: r < 40 and g < 40 and b < 40)]:
  n = 0; a = [W, H, 0, 0]
  for y in range(H):
    for x in range(W):
      if f(*px[x, y]): n += 1; a = [min(a[0], x), min(a[1], y), max(a[2], x), max(a[3], y)]
  out[k] = {'n': n, 'box': a}
print(json.dumps(out))`, f, String(i)));
  const imagesIn = (f) => JSON.parse(py(`import sys, json
from pypdf import PdfReader
r = PdfReader(sys.argv[1]); out = []
for p in r.pages:
  xo = p.get('/Resources', {}).get('/XObject', {}) or {}
  def walk(d):
    n = 0
    for k in d:
      o = d[k].get_object()
      if o.get('/Subtype') == '/Image': n += 1
      elif o.get('/Subtype') == '/Form': n += walk((o.get('/Resources') or {}).get('/XObject', {}) or {})
    return n
  out.append(walk(xo))
print(json.dumps(out))`, f));

  // ---- iPad A: md の本に画像を貼る ----
  const A = await iPad();
  await openFile(A, 'note.md', '画像のテスト');
  const row = await A.evaluate(() => ['#books', '#t-pen', '#t-ls', '#t-pic', '#gear'].map((s) => document.querySelector(s).getBoundingClientRect().top));
  check('ツールバーの「画像」は同じ1行', row.every((v) => near(v, row[0], 3)), JSON.stringify(row));
  await A.evaluate(() => { document.querySelectorAll('#doc > p')[3].scrollIntoView(); scrollBy(0, -200); });
  await A.waitForTimeout(300);
  await A.setInputFiles('#pic-file', path.join(dir, 'photo.png'));
  await A.waitForFunction(() => { const e = document.querySelector('#ink .pic image'); return e && e.getAttribute('href'); }, null, { timeout: 10000 });
  await A.waitForTimeout(300);
  let ps = await pics(A);
  const view = await A.evaluate(() => { const bar = document.getElementById('bar').getBoundingClientRect().bottom; return { mid: (bar + innerHeight) / 2, left: document.getElementById('page').getBoundingClientRect().left }; });
  check('写真を選ぶと1枚貼られる（紙の幅の 6 割、縦横の比はそのまま）', ps.length === 1 && near(ps[0].w, 408, 2) && near(ps[0].h, 272, 2), JSON.stringify(ps));
  check('見えている所のまん中に置く', near(ps[0].x + ps[0].w / 2, view.left + 340, 3) && near(ps[0].y + ps[0].h / 2, view.mid, 4), JSON.stringify({ ps, view }));
  check('貼った画像は投げ縄で選んだまま', await pressed(A, '#t-ls') === 'true' && (await A.textContent('#sel-n')) === '画像1枚' && (await grips(A)).length === 5, await A.textContent('#stat'));
  let sp = await savedPics(A);
  const photo = sp[0] && sp[0].f;
  check('書き込みに名前と位置（三隅）、画像は JPEG にして iPad に', sp.length === 1 && /^[0-9a-f]{24}\.jpg$/.test(photo) && sp[0].p.length === 6 && (await keys(A, /^pic:local:/)).some((k) => k.endsWith(':' + photo)), JSON.stringify(sp));
  await A.screenshot({ path: path.join(OUT, 'pic-pasted.png'), clip: { x: 0, y: Math.max(0, ps[0].y - 120), width: 820, height: 480 } });

  // 外を押すとペンに戻る。画像の上に書ける（線は画像の上に出る）。消しゴムでは画像は消えない
  await tap(A, view.left + 30, ps[0].y + ps[0].h + 60);
  check('外を押すと選択が外れてペンに戻る', await pressed(A, '#t-pen') === 'true' && await A.isHidden('#selmenu'));
  const cy = ps[0].y + ps[0].h / 2;
  await draw(A, [...Array(25)].map((_, i) => [ps[0].x + 40 + i * 12, cy + (i % 2) * 3]));
  check('画像の上に書ける（画像は線より下）', await A.evaluate(() => { const svg = document.getElementById('ink'), g = svg.firstElementChild; return g.querySelector('.pic') && svg.querySelectorAll(':scope > path').length === 1; }));
  await A.click('#t-er');
  await draw(A, [...Array(20)].map((_, i) => [ps[0].x + 30 + i * 10, ps[0].y + 30]));
  check('消しゴムでは画像は消えない', (await pics(A)).length === 1);

  // 投げ縄: 画像をたたいて選ぶ → 動かす → 大きさ → 向き → 戻す・進む → 複製・削除
  await A.click('#t-ls');
  await tap(A, ps[0].x + ps[0].w - 30, ps[0].y + 30);
  check('投げ縄で画像をたたくと選べる（上の線は選ばない）', (await A.textContent('#sel-n')) === '画像1枚', await A.textContent('#stat'));
  await pull(A, [ps[0].x + ps[0].w - 30, ps[0].y + 40], [ps[0].x + ps[0].w + 30, ps[0].y + 80]);
  const p1 = (await pics(A))[0];
  check('ドラッグで動く', near(p1.x - ps[0].x, 60, 2) && near(p1.y - ps[0].y, 40, 2) && (await A.textContent('#stat')).includes('画像1枚を移動'), JSON.stringify(p1));
  let g = await grips(A);
  await pull(A, g[2], [g[0][0] + (g[2][0] - g[0][0]) * 1.5, g[0][1] + (g[2][1] - g[0][1]) * 1.5]);
  const p2 = (await pics(A))[0];
  check('角のつまみで大きさ（縦横の比はそのまま、左上は止まる）', near(p2.w / p1.w, 1.5, .05) && near(p2.h / p1.h, 1.5, .05) && near(p2.x, p1.x, 6) && near(p2.y, p1.y, 6), JSON.stringify(p2));
  g = await grips(A);
  const mx = (g[0][0] + g[2][0]) / 2, my = (g[0][1] + g[2][1]) / 2;
  await pull(A, g[4], [mx + (my - g[4][1]), my]);
  sp = await savedPics(A);
  const v = sp[0].p;
  check('上の丸のつまみで向き（90 度）', near(v[2] - v[0], 0, 15) && v[3] - v[1] > 1000 && (await A.textContent('#stat')).includes('向きを変えました'), JSON.stringify(v));
  await A.screenshot({ path: path.join(OUT, 'pic-turned.png') });
  await A.click('#undo'); await A.waitForTimeout(150);
  const u = (await savedPics(A))[0].p;
  check('戻すと向きが戻る', near(u[3] - u[1], 0, 15) && u[2] - u[0] > 1000, JSON.stringify(u));
  await A.click('#redo'); await A.waitForTimeout(150);
  await tap(A, mx, my);
  if ((await A.textContent('#sel-n')) !== '画像1枚') await tap(A, mx, my);
  await A.click('#sel-dup'); await A.waitForTimeout(200);
  check('複製すると2枚（同じ画像）', (await pics(A)).length === 2 && (await savedPics(A)).every((x) => x.f === photo), await A.textContent('#stat'));
  await A.click('#sel-del'); await A.waitForTimeout(200);
  check('削除で1枚に', (await pics(A)).length === 1 && (await A.textContent('#stat')).includes('画像1枚を消しました'));

  // 指: 画像をたたくと選ぶ（ペンのままでも投げ縄に切り替わる）→ 選んだ枠の中を指で引くと動く（紙はスクロールしない）→ 枠の外をたたくと外れてペンに戻る
  const cdp = await A.context().newCDPSession(A);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const fingerDrag = async (from, to, n = 10) => { await touch('touchStart', ...from); for (let i = 1; i <= n; i++) await touch('touchMove', from[0] + (to[0] - from[0]) * i / n, from[1] + (to[1] - from[1]) * i / n); await touch('touchEnd'); await A.waitForTimeout(300); };
  await A.click('#t-pen');
  let q = (await pics(A))[0];
  await A.touchscreen.tap(q.x + q.w - 40, q.y + 40); await A.waitForTimeout(200);
  check('指でたたくと画像を選ぶ（ペンのままでも）', (await A.textContent('#sel-n')) === '画像1枚' && await pressed(A, '#t-ls') === 'true' && await A.isVisible('#selmenu'), await A.textContent('#stat'));
  const sy0 = await A.evaluate(() => scrollY);
  await fingerDrag([q.x + q.w - 40, q.y + 60], [q.x + q.w + 10, q.y + 90]);
  const q2 = (await pics(A))[0];
  check('選んだ枠の中を指で引くと動く（紙は動かない）', near(q2.x - q.x, 50, 2) && near(q2.y - q.y, 30, 2) && await A.evaluate(() => scrollY) === sy0 && (await A.textContent('#stat')).includes('移動しました'), JSON.stringify({ q, q2, sy0 }));
  await A.touchscreen.tap(view.left + 30, q2.y + q2.h + 40); await A.waitForTimeout(200);
  check('枠の外を指でたたくと外れてペンに戻る', await A.isHidden('#selmenu') && await pressed(A, '#t-pen') === 'true');
  await fingerDrag([q2.x + q2.w / 2, q2.y + q2.h / 2], [q2.x + q2.w / 2, q2.y + q2.h / 2 - 200]);
  check('選んでいないときは、画像の上でも指でスクロールする', await A.evaluate(() => scrollY) > sy0 + 100 && near((await pics(A))[0].x, q2.x, 1), await A.evaluate(() => scrollY));
  await A.evaluate((y) => scrollTo(0, y), sy0); await A.waitForTimeout(200);
  await A.click('#t-ls');

  // 透ける画像は PNG のまま
  await A.setInputFiles('#pic-file', path.join(dir, 'clear.png'));
  await A.waitForFunction(() => document.querySelectorAll('#ink .pic image[href]').length === 2, null, { timeout: 10000 });
  await A.waitForTimeout(400);
  sp = await savedPics(A);
  const clear = sp.map((x) => x.f).find((f) => f !== photo);
  check('透ける画像は PNG のまま', /^[0-9a-f]{24}\.png$/.test(clear || ''), JSON.stringify(sp.map((x) => x.f)));
  await tap(A, view.left + 30, 1100);

  // ドライブ: <本>/pics/ に画像、書き込み JSON に pics
  await A.waitForFunction(() => /ドライブに保存しました/.test(document.getElementById('stat').textContent), null, { timeout: 20000 }).catch(() => {});
  await A.waitForTimeout(1500);
  const bdir = 'Ink Reader/' + Object.values(files).find((f) => f.mimeType === FOLDER && /^画像のテスト \(/.test(f.name)).name;
  const ink = byPath(bdir + '/ink/ch1.json') || Object.values(files).find((f) => /\.json$/.test(f.name) && f.name !== 'book.json' && (f.parents || [])[0] === Object.keys(files).find((k) => files[k].name === 'ink'));
  const dPics = ink ? Object.values(JSON.parse(ink.content).blocks).flatMap((x) => Object.values(x.pics || {})) : [];
  const fPhoto = byPath(bdir + '/pics/' + photo), fClear = byPath(bdir + '/pics/' + clear);
  check('ドライブの書き込み JSON に pics', dPics.length === 2 && dPics.map((x) => x.f).sort().join() === [photo, clear].sort().join(), JSON.stringify(dPics));
  check('画像はドライブの <本>/pics/ に（JPEG・PNG）', fPhoto && fClear && fPhoto.content.slice(0, 2).toString('hex') === 'ffd8' && fClear.content.slice(0, 4).toString('hex') === '89504e47' && fPhoto.mimeType === 'image/jpeg', bdir);
  check('README に pics の説明', /pics\//.test(byPath('Ink Reader/README.md').content.toString()));
  check('同じフォルダ・ファイルを二つ作らない', !twins());
  const last = byPath('Ink Reader/last.png');
  check('いま.md の絵（last.png）を置く', !!last);

  // ---- iPad B: 同じ md を開くと、ドライブの書き込みと画像が出る ----
  const B = await iPad();
  await openFile(B, 'note.md', '画像のテスト');
  await B.waitForFunction(() => document.querySelectorAll('#ink .pic image[href]').length === 2, null, { timeout: 15000 }).catch(() => {});
  const bp = await pics(B);
  check('別の iPad でも画像が出る（ドライブから取って iPad に覚える）', bp.length === 2 && bp.every((x) => x.href && !x.miss) && (await keys(B, /^pic:local:/)).length === 2, JSON.stringify(bp.map((x) => [x.href.slice(0, 12), x.miss])));

  // ---- md の書き出し: 画像が入る ----
  await A.click('#chap'); await A.waitForTimeout(300);
  await A.click('#ex-on'); await A.click('#ex-all'); await A.click('#ex-go');
  const mdPdf = await shared(A, 'md.pdf');
  await A.click('#ex-x'); await A.click('#toc button[value=cancel]').catch(() => {});
  const mi = imagesIn(mdPdf), mc = colorsOf(mdPdf, mi.findIndex((n) => n > 0) + 1);
  check('md の書き出しに画像が入る（写真の赤と青・透ける画像の緑）', mc.red.n > 3000 && mc.blue.n > 3000 && mc.green.n > 2000 && Math.max(...mi) === 2, JSON.stringify({ red: mc.red, blue: mc.blue, green: mc.green, images: mi }));
  check('写真は 90 度回した向き（左の赤が上、右の青が下）', mc.red.box[3] < mc.blue.box[1] + 4 && near(mc.red.box[0], mc.blue.box[0], 2) && mc.blue.box[3] - mc.red.box[1] > (mc.red.box[2] - mc.red.box[0]) * 1.3, JSON.stringify([mc.red.box, mc.blue.box]));
  check('透ける所は透けたまま（緑の丸のまわりが黒くならない）', mc.black.n < 20000, JSON.stringify(mc.black));

  // ---- PDF の本に貼って書き出す ----
  await openFile(A, 'slides.pdf', 'slides');
  await A.waitForFunction(() => document.querySelectorAll('#doc > .pg').length === 2, null, { timeout: 30000 });
  await A.evaluate(() => scrollTo(0, 0)); await A.waitForTimeout(500);
  await A.setInputFiles('#pic-file', path.join(dir, 'photo.png'));
  await A.waitForFunction(() => document.querySelectorAll('#ink .pic image[href]').length === 1, null, { timeout: 10000 });
  const pp = (await pics(A))[0], pg1 = await A.evaluate(() => { const r = document.querySelector('#doc > .pg[data-n="1"]').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await tap(A, view.left + 30, 1150);
  await A.waitForTimeout(500);
  await A.click('#pgno'); await A.waitForTimeout(400);
  await A.click('#ex-on'); await A.click('#ex-all'); await A.click('#ex-go');
  const sPdf = await shared(A, 'slides-out.pdf');
  await A.click('#ex-x'); await A.click('#toc button[value=cancel]').catch(() => {});
  const sc = colorsOf(sPdf), k = 595.28 / pg1.w;   // 画面の px -> pt
  const want = [(pp.x - pg1.x) * k, (pp.y - pg1.y) * k, (pp.x - pg1.x + pp.w) * k, (pp.y - pg1.y + pp.h) * k];
  const got = [sc.red.box[0], Math.min(sc.red.box[1], sc.blue.box[1]), sc.blue.box[2], Math.max(sc.red.box[3], sc.blue.box[3])];
  check('PDF の書き出しで、画面と同じ所に画像が入る', got.every((x, i) => near(x, want[i], 4)), JSON.stringify({ want: want.map(Math.round), got }));

  // ドライブのものだけで ink_export.mjs（貼った画像は pics/ から）
  await A.waitForFunction(() => /ドライブに保存しました/.test(document.getElementById('stat').textContent), null, { timeout: 20000 }).catch(() => {});
  await A.waitForTimeout(1500);
  const sdir = 'Ink Reader/' + Object.values(files).find((f) => f.mimeType === FOLDER && /^slides \(/.test(f.name)).name;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-pic-cloud-'));
  fs.symlinkSync(path.join(APP, 'vendor'), path.join(work, 'vendor'));
  fs.mkdirSync(path.join(work, 'pics'));
  const need = [['Ink Reader/ink_export.mjs', 'ink_export.mjs'], [sdir + '/book.pdf', 'book.pdf'], [sdir + '/book.json', 'book.json'], [sdir + '/ink/pdf.json', 'pdf.json'], [sdir + '/pics/' + photo, 'pics/' + photo]];
  const miss = need.filter(([f]) => !byPath(f)).map(([f]) => f);
  check('PDF の本も画像をドライブに置く', !miss.length, miss.join(' '));
  if (!miss.length) {
    for (const [f, n] of need) fs.writeFileSync(path.join(work, n), byPath(f).content);
    let made = '';
    try { made = execFileSync('node', ['ink_export.mjs', '--pdf', 'book.pdf', '--book', 'book.json', '--ink', 'pdf.json', '--out', 'out.pdf'], { cwd: work, encoding: 'utf8' }); } catch (e) { made = String(e.stderr || e.message); }
    const cc = colorsOf(path.join(work, 'out.pdf')), got2 = [cc.red.box[0], Math.min(cc.red.box[1], cc.blue.box[1]), cc.blue.box[2], Math.max(cc.red.box[3], cc.blue.box[3])];
    check('ink_export.mjs でもアプリと同じ所に画像が入る', /できました/.test(made) && got2.every((x, i) => near(x, got[i], 1)), JSON.stringify({ got2, made: made.trim().split('\n').pop() }));
    fs.rmSync(path.join(work, 'pics'), { recursive: true });
    try { made = execFileSync('node', ['ink_export.mjs', '--pdf', 'book.pdf', '--book', 'book.json', '--ink', 'pdf.json', '--out', 'out2.pdf'], { cwd: work, encoding: 'utf8' }); } catch (e) { made = String(e.stderr || e.message); }
    check('画像がないときは入れずに知らせる', /画像 1 枚が見つからない/.test(made) && /できました/.test(made), made.trim());
  }

  // ---- 狭い幅（画面を半分ずつ）でもツールバーは1行 ----
  for (const w of [590, 744]) {
    const C = await (await b.newContext({ viewport: { width: w, height: 1000 }, deviceScaleFactor: 2, hasTouch: true })).newPage();
    await C.goto('http://localhost:8777/'); await C.waitForTimeout(300);
    const r = await C.evaluate(() => ['#books', '#t-pen', '#t-ls', '#t-pic', '#more', '#gear'].map((s) => document.querySelector(s)).filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect().top));
    check(`幅 ${w}px でも「画像」は同じ1行`, r.every((v) => near(v, r[0], 4)), JSON.stringify(r));
    await C.screenshot({ path: path.join(OUT, `pic-bar-${w}.png`), clip: { x: 0, y: 0, width: w, height: 90 } });
    await C.context().close();
  }

  check('エラーなし', !errs.length, errs.join(' | '));
  await b.close(); srv.close();
  console.log(bad ? `✗ ${bad} 件失敗` : '✓ すべて通りました');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
