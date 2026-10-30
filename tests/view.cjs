// md の本の書き込みの絵（Playwright）。ドライブ API はモック（GitHub は使わない）
// 使い方: node tests/view.cjs [スクリーンショットの出力先]
// 確認すること: ドライブにつないで md に書くと、書いた段落の絵が <本>/view/<章>-b<段落>.png に置かれる（本文・SVG の図・画像の図・手書き入り）
// → now.png にも図が入る → 戻すで書き込みがなくなると段落の絵は消える → 前の版で書いた章（絵がない）は、開いたときに全部置く
// → 暗い画面の端末でも、図の色は白い紙の色で描く → README に段落の絵の説明
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const APP = path.resolve(__dirname, '..'), OUT = process.argv[2] || os.tmpdir();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8784);
let ok = true;
const check = (name, v, info) => { console.log(v ? '✓' : '✗', name, info === undefined ? '' : typeof info === 'string' ? info : JSON.stringify(info)); if (!v) ok = false; };
const { createDrive, GIS, FOLDER, connected } = require('./drive-mock.cjs');
const drv = createDrive(), { files, byPath } = drv;
// SVG の図: アクセントの色（var(--accent)）と字の色（currentColor）の大きな四角
const SVG = '<figure><svg viewBox="0 0 300 120" width="300" height="120"><rect x="10" y="10" width="280" height="50" fill="var(--accent)"/><rect x="10" y="66" width="280" height="44" fill="currentColor"/></svg></figure>';
const MD = `# 絵のノート\n\n一つ目の段落です。ここに書きます。\n\n${SVG}\n\n真ん中の段落。\n\n![赤い図](red.png)\n\n$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$\n\nおわり。\n`;

(async () => {
  const b = await chromium.launch();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-view-'));
  const mk = await b.newPage();
  await mk.setContent('<body style="margin:0"><div style="width:240px;height:100px;background:#e00000"></div></body>');
  await mk.locator('div').screenshot({ path: path.join(dir, 'red.png') });
  fs.writeFileSync(path.join(dir, 'view.md'), MD);
  const errs = [];
  const device = async (scheme = 'light') => {
    const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1, hasTouch: true, colorScheme: scheme });
    await ctx.route('https://www.googleapis.com/**', drv.route);
    await ctx.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: GIS }));
    const p = await ctx.newPage(); p.ctx = ctx;
    p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404|401|ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(m.text()) && errs.push(m.text()));
    await p.goto('http://localhost:8784/');
    await p.evaluate((kv) => { for (const k in kv) localStorage.setItem(k, kv[k]); }, connected()); await p.reload();
    await p.waitForTimeout(400);
    return p;
  };
  const wait = async (fn, ms = 15000) => { for (let t = 0; t < ms && !await fn(); t += 200) await new Promise((r) => setTimeout(r, 200)); return fn(); };
  const title = (p, t) => p.waitForFunction((t) => document.getElementById('chap-t').textContent.includes(t), t, { timeout: 20000 });
  // 段落の番号（#doc の何番目の子要素か）
  const blockOf = (p, sel) => p.evaluate((sel) => [...document.getElementById('doc').children].indexOf(document.querySelector(sel).closest('#doc > *')), sel);
  const scribble = async (p, sel) => {
    const r = await p.evaluate((sel) => { const el = document.querySelector(sel); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return [r.left + 30, r.top + r.height / 2]; }, sel);
    await p.waitForTimeout(200);
    await p.mouse.move(r[0], r[1]); await p.mouse.down(); for (let i = 0; i < 20; i++) await p.mouse.move(r[0] + i * 8, r[1] + (i % 2) * 6); await p.mouse.up();
  };
  // PNG の色を数える: blue（明るい画面のアクセント）、lblue（暗い画面のアクセント）、red（画像の図）、light（暗い画面の字の色 #e3e6ec）、dark（字・手書き）
  const colors = (p, buf) => p.evaluate(async (b64) => {
    const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode();
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data, n = { blue: 0, lblue: 0, red: 0, light: 0, dark: 0, w: im.width, h: im.height };
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gg = d[i + 1], bb = d[i + 2];
      if (Math.abs(r - 39) < 12 && Math.abs(gg - 71) < 12 && Math.abs(bb - 201) < 12) n.blue++;
      else if (Math.abs(r - 142) < 12 && Math.abs(gg - 164) < 12 && Math.abs(bb - 255) < 12) n.lblue++;
      else if (r > 200 && gg < 50 && bb < 50) n.red++;
      else if (Math.abs(r - 227) < 5 && Math.abs(gg - 230) < 5 && Math.abs(bb - 236) < 5) n.light++;
      else if (r < 60 && gg < 60 && bb < 60) n.dark++;
    }
    return n;
  }, buf.toString('base64'));
  const root = () => Object.keys(files).find((k) => files[k].name === 'Ink Reader' && files[k].mimeType === FOLDER);
  const folders = () => Object.values(files).filter((x) => x.mimeType === FOLDER && !x.trashed && (x.parents || []).includes(root())).map((x) => x.name);

  // ---- 1. 書いた段落の絵 ----
  const A = await device();
  await A.setInputFiles('#empty .open-file', ['view.md', 'red.png'].map((n) => path.join(dir, n)));
  await title(A, '絵のノート'); await A.waitForTimeout(800);
  const ch = 'c1';
  const bText = await blockOf(A, '#doc > p:nth-of-type(2)'), bFig = await blockOf(A, '#doc figure svg'), bImg = await blockOf(A, '#doc img');
  await scribble(A, '#doc > p:nth-of-type(2)');
  await scribble(A, '#doc figure svg');
  await scribble(A, '#doc img');
  const bdir = await wait(() => folders().find((x) => x.startsWith('絵のノート')));
  const vp = (n) => `Ink Reader/${bdir}/view/${ch}-b${n}.png`;
  await wait(() => byPath(vp(bText)) && byPath(vp(bFig)) && byPath(vp(bImg)), 20000);
  check('書いた段落ごとに絵が置かれる', !!(byPath(vp(bText)) && byPath(vp(bFig)) && byPath(vp(bImg))), { ch, bText, bFig, bImg, view: Object.values(files).filter((f) => /\.png$/.test(f.name || '') && !f.trashed).map((f) => f.name) });
  check('書いていない段落の絵はない', !Object.values(files).some((f) => !f.trashed && f.name === `${ch}-b${bText + 2}.png`));
  const cText = await colors(A, byPath(vp(bText)).content), cFig = await colors(A, byPath(vp(bFig)).content), cImg = await colors(A, byPath(vp(bImg)).content);
  console.log('text', cText, 'fig', cFig, 'img', cImg);
  check('段落の絵に本文と手書き（PNG）', byPath(vp(bText)).content.slice(1, 4).toString() === 'PNG' && cText.dark > 400 && cText.w > 600);
  check('SVG の図が色つきで入る（アクセント・字の色）', cFig.blue > 8000 && cFig.dark > 8000, cFig);
  check('画像の図が入る', cImg.red > 15000, cImg);
  fs.writeFileSync(path.join(OUT, 'view-fig.png'), byPath(vp(bFig)).content);
  // now.png にも図
  await A.evaluate(() => document.querySelector('#doc figure').scrollIntoView({ block: 'start' }));
  await A.mouse.wheel(0, -60);
  await wait(async () => { const np = byPath('Ink Reader/now.png'); if (!np) return false; const c = await colors(A, np.content); return c.blue > 8000 && c.red > 8000; }, 15000);
  const cNow = byPath('Ink Reader/now.png') ? await colors(A, byPath('Ink Reader/now.png').content) : null;
  check('now.png にも SVG の図と画像の図が入る', cNow && cNow.blue > 8000 && cNow.red > 8000, cNow);
  // 戻すで書き込みがなくなると、その段落の絵は消える
  await A.click('#undo'); await A.waitForTimeout(300);
  await wait(() => !byPath(vp(bImg)), 20000);
  check('書き込みがなくなった段落の絵は消える', !byPath(vp(bImg)) && !!byPath(vp(bText)) && !!byPath(vp(bFig)));
  const readme = byPath('Ink Reader/README.md');
  check('README に段落の絵の説明', readme && /view\/<章>-b<段落>\.png/.test(readme.content.toString()));
  await A.ctx.close();

  // ---- 2. 前の版で書いた章（絵がない）: 暗い画面の B でインポートして開くと、書き込みのある段落の絵を全部置く ----
  for (const f of Object.values(files)) if (/\.png$/.test(f.name || '') && /-b\d+\.png$/.test(f.name)) f.trashed = true;
  const B = await device('dark');
  await B.click('#empty label.pick');
  await B.waitForFunction(() => document.querySelector('#op-dl li .back'), null, { timeout: 10000 });
  await B.click('#op-dl li:has-text("絵のノート") .back');
  await title(B, '絵のノート');
  await wait(() => byPath(vp(bText)) && byPath(vp(bFig)), 20000);
  check('絵のない章は、開いたときに書き込みのある段落の絵を置く', !!(byPath(vp(bText)) && byPath(vp(bFig))) && !byPath(vp(bImg)));
  const dFig = byPath(vp(bFig)) ? await colors(B, byPath(vp(bFig)).content) : {};
  console.log('dark fig', dFig);
  check('暗い画面でも図は白い紙の色で描く', dFig.blue > 8000 && dFig.lblue < 500 && dFig.light < 3000 && dFig.dark > 8000, dFig);
  fs.writeFileSync(path.join(OUT, 'view-dark.png'), byPath(vp(bFig)).content);
  check('同じ名前のファイルが二つない', !drv.twins());
  check('エラーなし', !errs.length, errs);
  await b.close(); srv.close(); process.exit(ok ? 0 : 1);
})();
