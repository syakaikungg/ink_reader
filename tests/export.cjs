// PDF の書き出しの確認（Playwright + pypdf）。色の帯の入った PDF を作り（3ページ目は横向き、4ページ目は切り抜き）、書き込み・余白・白紙を入れて書き出す。
// 書き出した PDF を PDF.js で描いて、線と元のページの位置を色で確かめ、pypdf でページの数・大きさ・目次を確かめる。GitHub は使わない。
// 使い方: node tests/export.cjs [スクリーンショットの出力先]   （python3 と pypdf が要る）
// 確認すること: すべて選んで書き出す（余白のあるページは縦に伸び、たたんだ余白も開く・白紙は別ページ・目次が残る・ページをまたぐ線）
// → クラウドの Claude が node で動かす export.js でも同じ PDF になる（線の輪郭・ページの向きと範囲）→ ページを選んで書き出す → 鍵のかかった PDF
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os'), { execFileSync } = require('child_process'), { pathToFileURL } = require('url');
const APP = path.resolve(__dirname, '..'), OUT = process.argv[2] || os.tmpdir(), DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-export-'));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json', '.pdf': 'application/pdf' };
// /__out/<名前> は書き出した PDF（DIR）
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = u.startsWith('/__out/') ? path.join(DIR, u.slice(7)) : path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8771);
let bad = 0;
const ok = (name, cond, info = '') => { if (!cond) bad++; console.log(cond ? '✓' : '✗', name, info); };
const py = (code, ...args) => execFileSync('python3', ['-c', code, ...args], { encoding: 'utf8' }).trim();
// 書き込み JSON の線（横線・縦線）。座標は紙の px（ページの上端から、余白をすべて開いたとき）
const hline = (y, c = 'k', t = 'pen') => ({ t, c, s: 4, pen: true, p: [100, 160, 220, 280, 340, 400, 460, 520, 580].flatMap((x) => [x * 10, y * 10, 50]) });
const vline = (x, y0, y1) => ({ t: 'pen', c: 'k', s: 4, pen: true, p: [...Array(9)].flatMap((_, i) => [x * 10, Math.round((y0 + (y1 - y0) * i / 8) * 10), 50]) });
// 曲がった線（筆圧も変わる。同じ点が続くところもある）。輪郭がアプリと export.js で同じになるか見る
const curve = (y, c, t = 'pen', s = 3.4) => ({ t, c, s, pen: true, p: [...Array(60)].flatMap((_, i) => [Math.round((90 + i * 8) * 10), Math.round((y + 30 * Math.sin(i / 5) + (i % 7 === 3 ? 0 : i % 3)) * 10), 30 + (i * 7) % 60]).concat([5590, y * 10, 50, 5590, y * 10, 50, 5591, y * 10 + 1, 50]) });
const shape = (y) => ({ t: 'pen', c: '#7a3cc8', s: 2.5, pen: true, p: [150, y, 400, y + 120, 260, y].flatMap((v, i) => i % 2 ? [] : [v * 10, [y, y + 120, y][i / 2] * 10, 50]), g: { k: 'poly', v: [1500, y * 10, 4000, (y + 120) * 10, 2600, y * 10], a: 0, p: 50 } });

(async () => {
  const b = await chromium.launch();
  // 8ページの A4。どのページにも赤い帯（上から 200〜240 CSS px = 紙の 171〜206px）と緑の帯（600〜640 = 514〜548px）
  const mk = await b.newPage();
  await mk.setContent('<style>body{margin:0} section{position:relative;height:100vh;page-break-after:always;overflow:hidden} .r,.g{position:absolute;left:0;right:0;height:40px} .r{top:200px;background:#e00} .g{top:600px;background:#0a0} h1{margin:0;padding:40px;font:40px serif}</style>' +
    [...Array(8)].map((_, i) => `<section><h1>page ${i + 1}</h1><div class="r"></div><div class="g"></div></section>`).join(''));
  const raw = path.join(DIR, 'raw.pdf');
  await mk.pdf({ path: raw, format: 'A4', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } }); await mk.close();
  // 3ページ目は横向き（/Rotate 90）、4ページ目は切り抜き（CropBox）。目次は 1・5・6 ページ。鍵（所有者パスワード）をかけた写しも作る
  py(`import sys
from pypdf import PdfReader, PdfWriter
w = PdfWriter(clone_from=PdfReader(sys.argv[1]))
w.pages[2].rotate(90)
w.pages[3].cropbox.lower_left = (50, 60); w.pages[3].cropbox.upper_right = (545, 800)
for n in (1, 5, 6): w.add_outline_item('part %d' % n, n - 1)
w.write(sys.argv[2])
w.encrypt(user_password='', owner_password='own', algorithm='AES-128')
w.write(sys.argv[3])`, raw, path.join(DIR, 'book.pdf'), path.join(DIR, 'locked.pdf'));

  const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true, acceptDownloads: true });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404/.test(m.text()) && errs.push(m.text()));
  await p.goto('http://localhost:8771/'); await p.waitForTimeout(300);

  // 本を開いて、書き込み・余白・白紙を IndexedDB に入れてから開き直す
  async function openBook(file, blocks, first) {
    await p.setInputFiles(first ? '#empty .open-file' : '#shelf .open-file', path.join(DIR, file));
    await p.waitForFunction((t) => document.getElementById('stat').textContent.includes(`「${t}」をこのiPadに保存しました`), file.replace('.pdf', ''), { timeout: 20000 });
    await p.evaluate(async (blocks) => {
      const db = await new Promise((res) => { const r = indexedDB.open('ink-reader', 1); r.onsuccess = () => res(r.result); });
      const get = (k) => new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); });
      const id = (await get('books'))[0].id;
      await new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put({ blocks, sha: null, pending: [] }, 'ink:' + id + ':pdf'); t.oncomplete = res; });
    }, blocks);
    await p.reload(); await p.waitForFunction(() => document.querySelector('#doc > .pg canvas'), null, { timeout: 20000 }); await p.waitForTimeout(500);
  }
  // iPad の共有シートの代わり: 渡されたファイルを覚えておく。__deny 回は「押した直後でない」と断る。__noShare のときは共有できない端末（ダウンロード）
  await ctx.addInitScript(() => {
    window.__shared = []; window.__deny = 0; window.__noShare = false;
    navigator.canShare = () => !window.__noShare;
    navigator.share = async (d) => {
      if (window.__deny > 0) { window.__deny--; throw new DOMException('not now', 'NotAllowedError'); }
      const f = d.files[0], u = new Uint8Array(await f.arrayBuffer()); let t = '';
      for (let i = 0; i < u.length; i += 0x8000) t += String.fromCharCode(...u.subarray(i, i + 0x8000));
      window.__shared.push({ name: f.name, b64: btoa(t) });
    };
  });
  // ページの一覧を開いて「書き出す」→ ページを選ぶ（keys: '<ページ>:<白紙>'、'all' はすべて選択）→「PDF にする」→ 共有されたファイル
  // how: 'share'（そのまま共有シート）・'deny'（時間がかかって断られ、「共有する」をもう一度押す）・'download'
  async function exportPdf(keys, name, how = 'share') {
    await p.click('#pgno'); await p.waitForTimeout(400);
    if (name === 'all.pdf') await p.screenshot({ path: path.join(OUT, 'export-pages.png') });
    await p.click('#ex-on');
    if (keys === 'all') await p.click('#ex-all');
    else for (const k of keys) { const [n, i] = k.split(':'); await p.click(`#pg-grid .th[data-n="${n}"][data-i="${i}"] .im`); }
    const sel = await p.textContent('#ex-n'), f = path.join(DIR, name), info = { sel };
    await p.screenshot({ path: path.join(OUT, 'export-' + name.replace('.pdf', '.png')) });
    await p.evaluate((h) => { window.__deny = h === 'deny' ? 1 : 0; window.__noShare = h === 'download'; }, how);
    if (how === 'download') {
      const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 60000 }), p.click('#ex-go')]);
      await dl.saveAs(f);
    } else {
      const n0 = await p.evaluate(() => window.__shared.length);
      await p.click('#ex-go');
      if (how === 'deny') {
        await p.waitForFunction(() => /もう一度|「共有する」を押して/.test(document.getElementById('ex-msg').textContent), null, { timeout: 60000 });
        info.denied = await p.textContent('#ex-msg');
        await p.click('#ex-go');
      }
      await p.waitForFunction((n) => window.__shared.length > n, n0, { timeout: 60000 });
      const x = await p.evaluate(() => window.__shared[window.__shared.length - 1]);
      fs.writeFileSync(f, Buffer.from(x.b64, 'base64')); info.file = x.name;
    }
    await p.waitForTimeout(300);
    Object.assign(info, { msg: await p.textContent('#ex-msg'), go: await p.textContent('#ex-go') });
    await p.click('#ex-x'); await p.click('#toc button[value=cancel]');
    return [f, info];
  }
  // 書き出した PDF の各ページを幅 680px で描いて、[x, y] の色を取る
  const colors = (name, pts) => p.evaluate(async ([name, pts]) => {
    const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    const d = await pdfjs.getDocument({ url: '/__out/' + name, standardFontDataUrl: '/vendor/pdfjs/standard_fonts/', cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true }).promise;
    const out = {};
    for (const [n, x, y] of pts) {
      const pg = await d.getPage(n), v1 = pg.getViewport({ scale: 1 }), v = pg.getViewport({ scale: 680 / v1.width }), cv = document.createElement('canvas');
      cv.width = Math.round(v.width); cv.height = Math.round(v.height);
      await pg.render({ canvas: cv, viewport: v }).promise;
      const c = cv.getContext('2d').getImageData(x, y, 1, 1).data;
      out[`${n}@${x},${y}`] = [c[0], c[1], c[2]];
    }
    return out;
  }, [name, pts]);
  const isK = ([r, g, bl]) => r < 90 && g < 90 && bl < 90, isW = ([r, g, bl]) => r > 235 && g > 235 && bl > 235;
  const isR = ([r, g, bl]) => r > 170 && g < 90 && bl < 90, isG = ([r, g, bl]) => g > 120 && r < 60 && bl < 60, isB = ([r, g, bl]) => bl > 150 && r < 90;
  const isHL = ([r, g, bl]) => r > 240 && g > 220 && bl < 225 && bl > 150;
  const pdfInfo = (f) => JSON.parse(py(`import sys, json
from pypdf import PdfReader
r = PdfReader(sys.argv[1])
pages = [[round(float(p.mediabox.width), 2), round(float(p.mediabox.height), 2), p.get('/Rotate', 0)] for p in r.pages]
ol = [[o.title, r.get_destination_page_number(o) + 1] for o in r.outline if not isinstance(o, list)]
print(json.dumps({'pages': pages, 'outline': ol, 'enc': r.is_encrypted}))`, f));

  // ---- すべて書き出す ----
  const ph = (w, h) => Math.round(680 * h / w);
  const P4 = ph(495, 740);   // 4ページ目（切り抜き）の紙の高さ
  const blocks = {
    1: { b: 1, strokes: { a: hline(300) } },
    // 2ページ目: 紙の 300px のところに高さ 200 の余白（たたんである）。余白の中に赤、余白より下（元の 450px）に青
    2: { b: 2, sp: [[300, 200, 1]], strokes: { a: hline(400, 'r'), b: hline(650, 'b') } },
    3: { b: 3, strokes: { a: hline(200) } },
    // 4ページ目: 後ろに白紙1枚。白紙の上から 150px に赤
    4: { b: 4, gap: P4 + 14, strokes: { a: hline(300), b: hline(P4 + 14 + 150, 'r') } },
    5: { b: 5, strokes: { a: hline(400, 'k', 'hl') } },
    // 6ページ目の下の端から 7ページ目へまたぐ縦線
    6: { b: 6, strokes: { a: vline(300, ph(595, 842) - 30, ph(595, 842) + 60) } },
    // 7ページ目: 筆圧のペン（pr）の線と、筆圧のペンで書いて図形に直した線（太さ一定）
    7: { b: 7, strokes: { a: { ...curve(400, 'k'), pr: 1 }, b: { ...curve(560, 'r', 'pen', 6), pr: 1 }, c: { ...shape(700), pr: 1 } } },
    8: { b: 8, strokes: { a: curve(500, 'k'), b: curve(600, 'r', 'pen', 6), c: curve(700, 'b', 'hl'), d: shape(820), e: curve(900, '#228844', 'pen', 1.2) } },
  };
  await openBook('book.pdf', blocks, true);
  ok('余白はたたんで開いた', await p.evaluate(() => !!document.querySelector('#sps .sph.fold')));
  const [f1, i1] = await exportPdf('all', 'all.pdf');
  ok('すべて選択', /9ページ/.test(i1.sel), i1.sel);
  ok('ファイル名', i1.file === 'book（書き込み）.pdf', i1.file);
  ok('できたあとは「共有する」（もう一度共有できる）', i1.go === '共有する' && /できました/.test(i1.msg), `${i1.go} / ${i1.msg}`);
  const a = pdfInfo(f1);
  console.log('  pages', JSON.stringify(a.pages), 'outline', JSON.stringify(a.outline), 'size', Math.round(fs.statSync(f1).size / 1024) + 'KB');
  ok('ページの数（8 + 白紙 1）', a.pages.length === 9);
  const tall = a.pages[0][1] + 200 * a.pages[0][0] / 680;
  ok('余白のあるページは縦に伸びる（200px 分）', a.pages[1][0] === a.pages[0][0] && Math.abs(a.pages[1][1] - tall) < .5, `${JSON.stringify(a.pages[1])} ${tall}`);
  ok('白紙は4ページ目と同じ大きさ（切り抜いた大きさ）', a.pages[4][0] === 495 && a.pages[4][1] === 740, JSON.stringify(a.pages[4]));
  ok('横向きのページはそのまま', a.pages[2][2] === 90, JSON.stringify(a.pages[2]));
  ok('目次が残り、白紙の分だけ後ろにずれる', JSON.stringify(a.outline) === JSON.stringify([['part 1', 1], ['part 5', 6], ['part 6', 7]]), JSON.stringify(a.outline));
  const c1 = await colors('all.pdf', [[1, 340, 300], [1, 340, 188], [1, 340, 530],
    [2, 340, 188], [2, 340, 400], [2, 340, 350], [2, 340, 650], [2, 340, 731], [2, 340, 530],
    [3, 340, 200], [4, 340, 300], [5, 340, 150], [5, 340, 300], [6, 340, 400], [6, 340, 300],
    [7, 300, ph(595, 842) - 10], [8, 300, 20], [8, 300, 80]]);
  console.log('  colors', JSON.stringify(c1));
  ok('1ページ目: 線と元のページの帯', isK(c1['1@340,300']) && isR(c1['1@340,188']) && isG(c1['1@340,530']));
  ok('2ページ目: 余白より上はそのまま', isR(c1['2@340,188']));
  ok('2ページ目: たたんだ余白も開いて、中の線を出す', isR(c1['2@340,400']) && isW(c1['2@340,350']));
  ok('2ページ目: 余白より下は余白の分だけ下がる（緑の帯 530 → 730）', isB(c1['2@340,650']) && isG(c1['2@340,731']) && isW(c1['2@340,530']));
  ok('3ページ目（横向き）の線', isK(c1['3@340,200']));
  ok('4ページ目（切り抜き）の線', isK(c1['4@340,300']));
  ok('白紙の線', isR(c1['5@340,150']) && isW(c1['5@340,300']));
  ok('マーカーは黄色く透ける', isHL(c1['6@340,400']) && isW(c1['6@340,300']), JSON.stringify(c1['6@340,400']));
  ok('ページをまたぐ線は両方のページに', isK(c1['7@300,' + (ph(595, 842) - 10)]) && isK(c1['8@300,20']) && isW(c1['8@300,80']));
  await p.screenshot({ path: path.join(OUT, 'export.png') });

  // ---- クラウドの Claude 用（node で export.js を動かす）でも同じになる ----
  // 本の情報（ドライブの book.json と同じ形）と書き込み JSON を置いて、node export.js で作る
  const meta = await p.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open('ink-reader', 1); r.onsuccess = () => res(r.result); });
    const get = (k) => new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); });
    return get('book:' + (await get('books'))[0].id);
  });
  fs.writeFileSync(path.join(DIR, 'book.json'), JSON.stringify({ title: meta.title, from: 'file', pdf: true, chapters: meta.chapters, sizes: meta.sizes }));
  fs.writeFileSync(path.join(DIR, 'pdf.json'), JSON.stringify({ chapter: 'pdf', blocks }));
  const ex = await import(pathToFileURL(path.join(APP, 'export.js')).href);
  const getStroke = new Function('window', fs.readFileSync(path.join(APP, 'vendor/perfect-freehand.js'), 'utf8') + '\nreturn window.getStroke;')({});
  const appD = (await p.$$eval('#ink path:not(.lasso)', (es) => es.map((e) => e.getAttribute('d')))).sort(), cliD = ex.readInk(blocks, getStroke).ink.map((x) => x.d).sort();
  ok('線の輪郭がアプリと同じ', appD.length === cliD.length && appD.every((d, i) => d === cliD[i]), `${appD.length} / ${cliD.length} 本、違う ${appD.filter((d, i) => d !== cliD[i]).length}`);
  { // 筆圧のペンは点の筆圧で太さが変わる（同じ点の太さ一定の線と輪郭が違う）。図形に直した線は太さ一定のまま
    const d = (st) => ex.readInk({ 1: { b: 1, strokes: { a: st } } }, getStroke).ink[0].d;
    ok('筆圧のペンは太さが変わり、図形は変わらない', d(curve(400, 'k')) !== d({ ...curve(400, 'k'), pr: 1 }) && d(shape(700)) === d({ ...shape(700), pr: 1 }));
  }
  // ページの向き・範囲（PDF.js の getViewport）を pdf-lib だけで出したものが同じ
  const L = await import(pathToFileURL(path.join(APP, 'vendor/pdf-lib/pdf-lib.esm.min.js')).href);
  const doc = await L.PDFDocument.load(fs.readFileSync(path.join(DIR, 'book.pdf')));
  const mine = doc.getPages().map((P) => ex.viewOf(L, P)), theirs = await p.evaluate(async () => {
    const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    const d = await pdfjs.getDocument({ url: '/__out/book.pdf' }).promise, out = [];
    for (let n = 1; n <= d.numPages; n++) out.push((await d.getPage(n)).getViewport({ scale: 1 }).transform);
    return out;
  });
  ok('ページの向き・範囲が PDF.js と同じ（横向き・切り抜きも）', mine.every((t, i) => t.every((v, j) => Math.abs(v - theirs[i][j]) < 1e-6)), JSON.stringify(mine.slice(2, 4)));
  const cli = (...a) => { try { return execFileSync('node', [path.join(APP, 'export.js'), ...a], { cwd: DIR, encoding: 'utf8', stdio: 'pipe' }).trim(); } catch (e) { return 'ERR ' + (e.stderr || e.message).trim(); } };
  const t0 = Date.now(), log = cli('--pdf', 'book.pdf', '--book', 'book.json', '--ink', 'pdf.json', '--out', 'cli-all.pdf');
  console.log('  ' + log.split('\n').pop(), Date.now() - t0 + 'ms');
  const same = fs.existsSync(path.join(DIR, 'cli-all.pdf')) && Buffer.compare(fs.readFileSync(path.join(DIR, 'cli-all.pdf')), fs.readFileSync(f1)) === 0;
  ok('node で作った PDF がアプリで作ったものとまったく同じ', same, same ? '' : log);
  if (!same && fs.existsSync(path.join(DIR, 'cli-all.pdf'))) {
    const pts = [[1, 340, 300], [2, 340, 400], [2, 340, 731], [3, 340, 200], [4, 340, 300], [5, 340, 150], [6, 340, 400], [8, 300, 20]];
    const [x, y] = [await colors('all.pdf', pts), await colors('cli-all.pdf', pts)];
    ok('  （色は同じ）', JSON.stringify(x) === JSON.stringify(y), JSON.stringify(y));
  }
  const log2 = cli('--pdf', 'book.pdf', '--book', 'book.json', '--ink', 'pdf.json', '--pages', '2,4');
  const nm = 'book（書き込み p2,4）.pdf', c = fs.existsSync(path.join(DIR, nm)) && pdfInfo(path.join(DIR, nm));
  ok('node で --pages 2,4（後ろの白紙も入る）', c && c.pages.length === 3 && Math.abs(c.pages[0][1] - tall) < .5 && c.pages[2][0] === 495, c ? JSON.stringify(c.pages) : log2);
  ok('node: 足りないときは使い方を出す', /使い方/.test(cli('--pdf', 'book.pdf')));

  // ---- ページを選んで書き出す（2ページ目・4ページ目の白紙・6ページ目） ----
  const [f2, i2] = await exportPdf(['2:0', '4:1', '6:0'], 'some.pdf', 'deny');
  const s = pdfInfo(f2);
  console.log('  pages', JSON.stringify(s.pages), 'size', Math.round(fs.statSync(f2).size / 1024) + 'KB', i2.file);
  ok('選んだ数', /3ページ/.test(i2.sel), i2.sel);
  ok('選んだページだけ', s.pages.length === 3 && s.pages[1][0] === 495 && Math.abs(s.pages[0][1] - tall) < .5);
  ok('ファイル名にページ', i2.file === 'book（書き込み p2,4,6）.pdf', i2.file);
  ok('時間がかかって共有シートが開けないときは「共有する」をもう一度押す', /「共有する」を押して/.test(i2.denied || ''), i2.denied);
  const c2 = await colors('some.pdf', [[1, 340, 400], [1, 340, 731], [2, 340, 150], [3, 300, ph(595, 842) - 10]]);
  ok('選んだページの線と余白', isR(c2['1@340,400']) && isG(c2['1@340,731']) && isR(c2['2@340,150']) && isK(c2['3@300,' + (ph(595, 842) - 10)]), JSON.stringify(c2));
  ok('選んだときはすべてより小さい', fs.statSync(f2).size < fs.statSync(f1).size);

  // 選び直すまでは「共有する」、選ぶのをやめると戻る
  await p.click('#pgno'); await p.waitForTimeout(300); await p.click('#ex-on');
  ok('選ぶ前は「PDF にする」が押せない', await p.isDisabled('#ex-go'));
  await p.click('#ex-all'); ok('すべて選ぶと「選択を解除」', (await p.textContent('#ex-all')) === '選択を解除');
  await p.click('#ex-all'); ok('解除すると 0', /^0ページ/.test(await p.textContent('#ex-n')));
  await p.click('#ex-x');
  ok('やめると番号の欄に戻る', await p.isVisible('#pg-go') && await p.isHidden('#ex-bar'));
  await p.click('#toc-tabs button[data-t="main"]');
  ok('目次のタブでは「書き出す」を出さない', await p.isHidden('#ex-on'));
  await p.click('#toc button[value=cancel]');

  // ---- 鍵のかかった PDF ----
  await p.click('#books'); await p.waitForTimeout(200);
  await openBook('locked.pdf', { 1: { b: 1, strokes: { a: hline(300) } } }, false);
  ok('鍵のかかった本を開いている', await p.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open('ink-reader', 1); r.onsuccess = () => res(r.result); });
    const bs = await new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get('books'); q.onsuccess = () => res(q.result); });
    return bs.length === 2 && bs[0].title === 'locked' && localStorage.getItem('ink:book') === bs[0].id;
  }));
  const [f3] = await exportPdf('all', 'locked-out.pdf', 'download');   // 共有できない端末はダウンロード
  const l = pdfInfo(f3);
  ok('鍵のかかった PDF も書き出せる', l.pages.length === 8 && !l.enc, JSON.stringify(l.pages.slice(0, 3)));
  const c3 = await colors('locked-out.pdf', [[1, 340, 300], [1, 340, 188]]);
  ok('鍵のかかった PDF の線と帯', isK(c3['1@340,300']) && isR(c3['1@340,188']), JSON.stringify(c3));
  fs.writeFileSync(path.join(DIR, 'one.json'), JSON.stringify({ blocks: { 1: { b: 1, strokes: { a: hline(300) } } } }));
  const log3 = cli('--pdf', 'locked.pdf', '--book', 'book.json', '--ink', 'one.json');
  ok('node: 鍵のかかった PDF は pdfjs-dist で外す（なければ入れ方を出す）', /pdfjs-dist/.test(log3) || /できました/.test(log3), log3.split('\n').pop());

  ok('エラーなし', !errs.length, JSON.stringify(errs));
  await b.close(); srv.close();
  console.log(bad ? `✗ ${bad} 件` : '✓ すべて通りました');
  process.exit(bad ? 1 : 0);
})();
