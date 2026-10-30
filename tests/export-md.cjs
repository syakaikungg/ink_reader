// md の本の書き出しの確認（Playwright + pypdf + pdftoppm）。2章の md の本（数式・図・太字・長い章・字体にない字）に書き込んで書き出す。GitHub は使わない。
// 使い方: node tests/export-md.cjs [スクリーンショットの出力先]   （python3 と pypdf、pdftoppm（poppler）が要る）
// 確認すること: 目次に「書き出す」→ 章を選ぶ（1章・すべて）→「PDF にする」→ 共有される PDF
// → 文字は文字のまま（取り出せる・字体が埋め込まれている）→ 章ごとに新しいページ・長い章は複数ページ → 書き込みが同じ位置に出る（開いていない章も）→ 余白は開いて出す
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os'), { execFileSync } = require('child_process');
const APP = path.resolve(__dirname, '..'), OUT = process.argv[2] || os.tmpdir(), DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-export-md-'));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8776);
let bad = 0;
const ok = (name, cond, info = '') => { if (!cond) bad++; console.log(cond ? '✓' : '✗', name, info); };
const py = (code, ...args) => execFileSync('python3', ['-c', code, ...args], { encoding: 'utf8' }).trim();

(async () => {
  // 1章: 見出し・太字・数式（分数・根号・上付き）・図（SVG と画像）・字体にない字（𠮷・丂）。2章: 長い（4ページほど）
  fs.writeFileSync(path.join(DIR, 'a1.md'), [
    '# 第1章 ベクトル', '', 'ベクトル $\\vec{v} = (v_1, v_2)$ の **長さ** は次の式で表す。Vector length.', '',
    '$$|\\vec{v}| = \\sqrt{v_1^2 + v_2^2} = \\frac{a}{b}$$', '',
    '<figure><svg viewBox="0 0 200 100" width="200" height="100"><rect x="10" y="10" width="180" height="80" fill="none" stroke="var(--accent)" stroke-width="4"/></svg></figure>', '', '![](fig.png)', '',
    '𠮷野家の𠮷と丂は字体にない字。', '', '最後の段落。'].join('\n'));
  fs.writeFileSync(path.join(DIR, 'a2.md'), ['# 第2章 行列', ''].concat([...Array(60)].map((_, i) => `段落${i + 1}。行列 $A_{${i}}$ の性質を順に確かめていく。これは長い章で、ページをいくつかに分けて書き出す。`)).join('\n\n'));

  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true });
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
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404/.test(m.text()) && errs.push(m.text()));
  await p.goto('http://localhost:8776/'); await p.evaluate(() => localStorage.setItem('ink:zoom', '1')); await p.reload(); await p.waitForTimeout(300);
  await p.setInputFiles('#empty .open-file', [path.join(DIR, 'a1.md'), path.join(DIR, 'a2.md')]);
  await p.waitForFunction(() => document.getElementById('chap-t').textContent.includes('第1章'), null, { timeout: 20000 });
  await p.waitForTimeout(800);

  // 書き込み: 1章の最後の段落の上に横線（ペン）、数式の上にマーカー。2章は段落10に横線を引いてから1章に戻る（開いていない章の書き込み）
  const line = async (x0, x1, y) => { await p.mouse.move(x0, y); await p.mouse.down(); for (let x = x0; x <= x1; x += 20) await p.mouse.move(x, y + (x % 40 ? 1 : 0)); await p.mouse.up(); await p.waitForTimeout(250); };
  const block = (sel) => p.evaluate((sel) => { const el = document.querySelector(sel); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(), pr = document.getElementById('page').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, py: r.top - pr.top, px: r.left - pr.left }; }, sel);
  let r = await block('#doc > p:last-child');
  await line(r.x + 20, r.x + 300, r.y + r.h / 2);
  const pen1 = { x: r.px + 160, y: r.py + r.h / 2 };   // 紙の px
  await p.click('#t-hl');
  r = await block('#doc > .katex-display');
  await line(r.x + 200, r.x + 420, r.y + r.h / 2);
  await p.click('#t-pen');
  await p.click('#next2'); await p.waitForFunction(() => document.getElementById('chap-t').textContent.includes('第2章'));
  await p.waitForTimeout(600);
  r = await block('#doc > p:nth-child(12)');
  await line(r.x + 20, r.x + 300, r.y + r.h / 2);
  const pen2x = [r.px + 40, r.px + 280];
  await p.click('#prev2'); await p.waitForFunction(() => document.getElementById('chap-t').textContent.includes('第1章'));
  await p.waitForTimeout(600);
  const strokes1 = await p.$$eval('#ink path.k, #ink path.hl', (els) => els.length);
  ok('書き込みが2本（ペンとマーカー）', strokes1 === 2, strokes1);
  // 位置を測っておく（紙の px）: マーカーの真ん中、図の枠
  const hlAt = await p.evaluate(() => { const el = document.querySelector('#ink path.hl'), bb = el.getBBox(), t = +(el.getAttribute('transform').match(/translate\(0 ([-\d.]+)/) || [0, 0])[1]; return { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 + t, w: bb.width }; });
  const box = await p.evaluate(() => { const r = document.querySelector('#doc figure svg').getBoundingClientRect(), pr = document.getElementById('page').getBoundingClientRect(); return { x: r.left - pr.left, y: r.top - pr.top }; });
  const pic = await p.evaluate(() => { const r = document.querySelector('#doc img[data-img]').getBoundingClientRect(), pr = document.getElementById('page').getBoundingClientRect(); return { x: r.left - pr.left, y: r.top - pr.top, w: r.width, h: r.height }; });
  // 字体（書き出し用の日本語の字体）にない字「丂」の位置
  const rare = await p.evaluate(() => {
    const n = [...document.querySelectorAll('#doc p')].find((e) => e.textContent.includes('丂')).firstChild, i = n.data.indexOf('丂'), q = document.createRange();
    q.setStart(n, i); q.setEnd(n, i + 1); const r = q.getBoundingClientRect(), pr = document.getElementById('page').getBoundingClientRect();
    return { x: r.left - pr.left, y: r.top - pr.top, w: r.width, h: r.height };
  });
  // 1章の最初の段落（2番目の段落）の下に余白（書き込み JSON の gap）を入れて、たたんでおく → 書き出しでは開くので、下のものは GAP だけ下に出る
  // （投げ縄の操作は gap.cjs で確かめているので、ここでは保存した書き込みを書き換えて開き直す）
  const GAP = 60;
  await p.waitForTimeout(500);
  await p.evaluate(async (GAP) => {
    const db = await new Promise((res) => { const r = indexedDB.open('ink-reader', 1); r.onsuccess = () => res(r.result); });
    const get = (k) => new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); });
    const id = (await get('books'))[0].id, key = 'ink:' + id + ':c1', v = await get(key);
    v.blocks[2] = { ...(v.blocks[2] || { strokes: {} }), gap: GAP, fold: 1 };
    // 本の図（赤い画像）も入れておく
    const cv = document.createElement('canvas'); cv.width = 40; cv.height = 30; const g = cv.getContext('2d'); g.fillStyle = '#e00000'; g.fillRect(0, 0, 40, 30);
    const png = await new Promise((ok) => cv.toBlob(ok, 'image/png')), bk = await get('book:' + id);
    await new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, key); t.objectStore('kv').put(png, 'img:' + bk.imageDir + '/fig.png'); t.oncomplete = res; });
  }, GAP);
  await p.reload(); await p.waitForFunction(() => document.getElementById('chap-t').textContent.includes('第1章')); await p.waitForTimeout(800);
  ok('余白はたたんである（画面）', await p.evaluate(() => document.querySelectorAll('#doc > *')[2].style.paddingBottom !== '') , await p.evaluate(() => document.querySelectorAll('#doc > *')[2].style.paddingBottom));

  // 目次に「書き出す」。押すと章を選ぶ一覧
  await p.click('#chap'); await p.waitForTimeout(400);
  ok('md の本の目次に「エクスポート」（タブは出さない）', await p.isVisible('#ex-on') && await p.isHidden('#toc-tabs'));
  await p.click('#ex-on');
  const rows = await p.$$eval('#toc-list .ck', (els) => els.map((e) => e.textContent));
  ok('章だけの一覧になる（検索は隠れる）', rows.length === 2 && /第1章/.test(rows[0]) && await p.isHidden('#toc-q'), rows);
  ok('最初は何も選んでいない', (await p.textContent('#ex-n')) === '0章' && await p.isDisabled('#ex-go'));
  await p.click('#toc-list li:nth-child(2) .ck');
  ok('押すと印', (await p.textContent('#ex-n')) === '1章' && await p.$eval('#toc-list li:nth-child(2) .ck', (e) => e.classList.contains('on')));
  await p.screenshot({ path: path.join(OUT, 'export-md-pick.png') });

  const share = async () => {
    const n0 = await p.evaluate(() => window.__shared.length), t0 = Date.now();
    await p.click('#ex-go');
    await p.waitForFunction((n) => window.__shared.length > n, n0, { timeout: 90000 });
    const x = await p.evaluate(() => window.__shared[window.__shared.length - 1]);
    const f = path.join(DIR, 'out-' + n0 + '.pdf'); fs.writeFileSync(f, Buffer.from(x.b64, 'base64'));
    return { f, name: x.name, ms: Date.now() - t0, size: fs.statSync(f).size };
  };
  // 2章だけ（開いていない章）
  const one = await share();
  console.log('  2章だけ', one.name, Math.round(one.size / 1024) + 'KB', one.ms + 'ms', await p.textContent('#ex-msg'));
  const info1 = JSON.parse(py(`import sys, json
from pypdf import PdfReader
r = PdfReader(sys.argv[1])
print(json.dumps({'n': len(r.pages), 'size': [float(r.pages[0].mediabox.width), float(r.pages[0].mediabox.height)], 'text': r.pages[0].extract_text()}))`, one.f));
  ok('名前に章の名前', /（書き込み 第2章 行列）\.pdf$/.test(one.name), one.name);
  ok('A4 で、長い章は何ページかに分かれる', info1.n >= 3 && info1.n <= 6 && Math.abs(info1.size[0] - 595.28) < .5 && Math.abs(info1.size[1] - 841.89) < .5, info1.n);
  ok('文字は文字のまま取り出せる', /第2章\s*行列/.test(info1.text) && /段落1。行列/.test(info1.text), info1.text.slice(0, 60));

  // すべて選ぶ
  await p.click('#ex-all');
  ok('すべて選択', (await p.textContent('#ex-n')) === '2章' && (await p.textContent('#ex-all')) === '選択を解除');
  const all = await share();
  console.log('  すべて', all.name, Math.round(all.size / 1024) + 'KB', all.ms + 'ms');
  ok('すべてのときの名前', /（書き込み）\.pdf$/.test(all.name), all.name);
  const info = JSON.parse(py(`import sys, json
from pypdf import PdfReader
r = PdfReader(sys.argv[1])
fonts = set()
for pg in r.pages:
    res = pg.get('/Resources') or {}
    for k, f in (res.get('/Font') or {}).items():
        f = f.get_object(); fonts.add(str(f.get('/BaseFont')))
print(json.dumps({'n': len(r.pages), 'texts': [p.extract_text() for p in r.pages], 'fonts': sorted(fonts)}))`, all.f));
  console.log('  fonts', info.fonts.join(' '));
  ok('章ごとに新しいページ（1章は1ページ、2章はその次から）', info.n === info1.n + 1 && /第1章/.test(info.texts[0]) && !/第2章/.test(info.texts[0]) && /第2章/.test(info.texts[1]), info.n);
  ok('日本語・英字・数式の字体が埋め込まれている', ['NotoSerifJP', 'SourceSerif4', 'KaTeX_Main', 'KaTeX_Math'].every((n) => info.fonts.some((f) => f.includes(n))), info.fonts);
  ok('英語の語の間があく', /Vector length\./.test(info.texts[0].replace(/\s+/g, ' ')), (info.texts[0].match(/Vec.{0,14}/) || [])[0]);

  // 描いて確かめる: ペンの線（濃い色）とマーカー（黄色）、図の枠（青）、字体にない字（絵になって出る）
  execFileSync('pdftoppm', ['-r', '72', '-png', '-f', '1', '-l', '2', all.f, path.join(DIR, 'pg')]);
  const pngs = fs.readdirSync(DIR).filter((f) => /^pg-\d+\.png$/.test(f)).sort();
  fs.copyFileSync(path.join(DIR, pngs[0]), path.join(OUT, 'export-md-p1.png'));
  const K = 595.28 / 680;
  const px = (f, pts) => JSON.parse(py(`import sys, json, zlib, struct
# PNG を読む（pypdf と一緒に入っている PIL があれば使う）
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
print(json.dumps([list(im.getpixel((int(x), int(y)))) for x, y in json.loads(sys.argv[2])]))`, path.join(DIR, f), JSON.stringify(pts)));
  const [c1, c0] = px(pngs[0], [[pen1.x * K, (pen1.y + GAP) * K], [pen1.x * K, pen1.y * K]]);
  ok('ペンの線が同じ位置に出る（余白は開いて、その分下に）', c1[0] < 90 && c1[1] < 90 && c1[2] < 90 && c0[0] > 200, [c1, c0]);
  // マーカーは数式の字と重なるので、横に何か所か見て、半分より多くが黄色ならよい
  const hs = px(pngs[0], [...Array(9)].map((_, i) => [(hlAt.x + (i - 4) / 10 * hlAt.w) * K, (hlAt.y + GAP) * K]));
  ok('マーカーが出る（黄色）', hs.filter((c) => c[0] > 200 && c[1] > 170 && c[0] - c[2] > 60).length > 4, hs);
  const [c3] = px(pngs[0], [[(box.x + 12) * K, (box.y + GAP + 50) * K]]);
  ok('図（SVG）が出る（青い枠）', c3[2] > 150 && c3[0] < 120, c3);
  const [c4] = px(pngs[0], [[(pic.x + pic.w / 2) * K, (pic.y + GAP + pic.h / 2) * K]]);
  ok('本の図（画像）が出る（赤）', c4[0] > 180 && c4[1] < 80 && c4[2] < 80, c4);
  // 2章（開いていない章）の横線: どこかのページに、その幅の濃い横線がある
  execFileSync('pdftoppm', ['-r', '72', '-png', one.f, path.join(DIR, 'one')]);
  const found = JSON.parse(py(`import sys, json, glob
from PIL import Image
x0, x1 = [int(v) for v in json.loads(sys.argv[2])]
hits = []
for f in sorted(glob.glob(sys.argv[1] + '-*.png')):
    im = Image.open(f).convert('L'); w, h = im.size
    for y in range(h):
        if all(im.getpixel((x, y)) < 110 for x in range(x0, x1, 3)): hits.append(f[-6:]); break
print(json.dumps(hits))`, path.join(DIR, 'one'), JSON.stringify(pen2x.map((v) => v * K))));
  ok('開いていない章の書き込みも出る（2章）', found.length === 1, found);
  const dark = JSON.parse(py(`import sys, json
from PIL import Image
im = Image.open(sys.argv[1]).convert('L'); x, y, w, h = json.loads(sys.argv[2])
print(json.dumps(sum(1 for i in range(int(x), int(x + w)) for j in range(int(y), int(y + h)) if im.getpixel((i, j)) < 128)))`, path.join(DIR, pngs[0]), JSON.stringify([rare.x * K, (rare.y + GAP) * K, rare.w * K, rare.h * K])));
  ok('字体にない字は画面の字を絵にして出す（丂）', /野家の/.test(info.texts[0]) && dark > 3, dark);

  // やめると目次に戻る
  await p.click('#ex-x');
  ok('やめると目次に戻る', await p.isVisible('#toc-q') && (await p.$$('#toc-list .ck')).length === 0);
  await p.click('#toc button[value=cancel]');
  console.log('errs', errs); if (errs.length) bad++;
  await b.close(); srv.close(); fs.rmSync(DIR, { recursive: true, force: true });
  console.log(bad ? `✗ ${bad}件` : '✓ すべて通りました'); process.exit(bad ? 1 : 0);
})();
