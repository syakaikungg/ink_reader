// ファイルから開いた本の書き込みと画像の確認（Playwright）。GitHub API とドライブ API はモックする（sakai_study は要らない）
// 使い方: node tests/files-sync.cjs
// 確認すること: GitHub のトークンがあっても GitHub には何も送らない（前は books/files/ に送っていた）→ ドライブにつなぐと、前に書いた分も送る
// （book.json・ink・書き込みのあるページの画像。画像に文字と手書きが入る）→ 書き足すとそのページの画像も送る → 「sakai_studyで聞く」は出さない
// → 答えのファイルが Q 印になる → たたんだ余白は開いて画像にする → md の本も本文ごと送る
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const APP = path.resolve(__dirname, '..'), N = 5;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8769);
let ok = true;
const check = (name, v) => { console.log(v ? '✓' : '✗', name); if (!v) ok = false; };
const { createDrive, GIS, connected } = require('./drive-mock.cjs');
const drv = createDrive(), { files, byPath } = drv;
(async () => {
  const b = await chromium.launch();
  const pdfPath = path.join(os.tmpdir(), 'ink-files.pdf'), mdPath = path.join(os.tmpdir(), 'ink-files.md');
  const mk = await b.newPage();
  await mk.setContent(`<style>body{margin:0;font:28px serif} section{height:100vh;page-break-after:always;padding:40px;box-sizing:border-box}</style>` +
    [...Array(N)].map((_, i) => `<section><p>ページ ${i + 1} の本文。</p></section>`).join(''));
  await mk.pdf({ path: pdfPath, format: 'A4' }); await mk.close();
  fs.writeFileSync(mdPath, '# 試しの章\n\n最初の段落。$x^2$\n\n二つ目の段落。\n\n三つ目の段落。\n');

  const gh = {}; let shaN = 1; const log = [];
  const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:8769' });
  await ctx.route('https://www.googleapis.com/**', drv.route);
  await ctx.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: GIS }));
  await ctx.route('https://api.github.com/**', async (route) => {
    const req = route.request(), u = new URL(req.url()), p = decodeURIComponent(u.pathname.replace('/repos/syakaikungg/sakai_study/contents/', ''));
    const raw = /raw/.test(req.headers().accept || '');
    log.push(req.method() + ' ' + p);
    if (req.method() === 'PUT') {
      const body = JSON.parse(req.postData()), cur = gh[p];
      if ((cur ? cur.sha : undefined) !== (body.sha || undefined)) return route.fulfill({ status: 409, body: '{}' });
      gh[p] = { content: Buffer.from(body.content, 'base64'), sha: 's' + shaN++ };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: { sha: gh[p].sha } }) });
    }
    if (req.method() === 'DELETE') { delete gh[p]; return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); }
    if (gh[p]) return route.fulfill({ status: 200, contentType: 'application/json', body: raw ? gh[p].content : JSON.stringify({ sha: gh[p].sha, content: gh[p].content.toString('base64') }) });
    return route.fulfill({ status: 404, body: '{}' });
  });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404/.test(m.text()) && errs.push(m.text()));
  await p.goto('http://localhost:8769/');
  await p.evaluate(() => localStorage.setItem('ink:cfg', JSON.stringify({ token: 'test' })));
  await p.reload(); await p.waitForTimeout(300);
  await p.setInputFiles('#empty .open-file', pdfPath);
  await p.waitForFunction((n) => document.querySelectorAll('#doc > .pg').length === n, N, { timeout: 30000 });
  await p.waitForTimeout(800);
  const line = async (x, y) => { await p.mouse.move(x, y); await p.mouse.down(); for (let i = 0; i < 20; i++) await p.mouse.move(x + i * 5, y + (i % 2) * 3); await p.mouse.up(); };
  const pageY = (n, d) => p.evaluate(([n, d]) => { const el = document.querySelector(`#doc > .pg[data-n="${n}"]`); el.scrollIntoView(); return el.getBoundingClientRect().top + d; }, [n, d]);
  await line(200, await pageY(1, 200));
  await p.waitForTimeout(5500);
  console.log('github', log.join(' / '));
  const sent = () => log.filter((x) => /^(PUT|DELETE)/.test(x)).length;
  check('トークンがあっても GitHub には送らない', sent() === 0);
  check('つないでいなければ「未送信」と出ない', !/未送信/.test(await p.textContent('#stat')));

  // ドライブにつないで開き直すと、前に書いた分を送る
  await p.evaluate((kv) => { for (const k in kv) localStorage.setItem(k, kv[k]); }, connected({ token: 'test' }));
  await p.reload(); await p.waitForTimeout(800);
  await p.waitForFunction(() => /ドライブに保存しました/.test(document.getElementById('stat').textContent), null, { timeout: 15000 }).catch(() => {});
  await p.waitForTimeout(1500);
  const top = Object.values(files).find((f) => /^ink-files \(/.test(f.name)), dir = top && 'Ink Reader/' + top.name;
  const remote = new Proxy({}, { get: (_, k) => byPath(k) });   // ドライブのファイルを、パスで引く
  console.log('dir', dir);
  check('book.json を送る', !!dir && !!remote[dir + '/book.json']);
  const meta = dir && JSON.parse(remote[dir + '/book.json'].content);
  check('book.json に題名・PDF・ページの大きさ', meta && meta.title === 'ink-files' && meta.from === 'file' && meta.pdf && meta.sizes.length === N);
  const ink = dir && remote[dir + '/ink/pdf.json'] && JSON.parse(remote[dir + '/ink/pdf.json'].content);
  check('前に書いた分（1ページ）の書き込みを送る', ink && Object.keys(ink.blocks).join() === '1');
  const png = dir && remote[dir + '/view/p1.png'];
  check('1ページの画像を送る（PNG）', png && png.content.slice(1, 4).toString() === 'PNG');
  const dims = (bf) => [bf.readUInt32BE(16), bf.readUInt32BE(20)];
  console.log('p1.png', png && dims(png.content), png && Math.round(png.content.length / 1024) + 'KB');
  check('画像は紙の幅の 2 倍', png && dims(png.content)[0] === 1360);
  check('GitHub には何も送らない', sent() === 0);

  // 画像にページの文字と手書きが入っているか（ページの絵の上に書いた線の色の画素があるか）
  const inkPx = await p.evaluate(async (b64) => {
    const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode();
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data; let dark = 0; for (let k = 0; k < d.length; k += 4) if (d[k] < 120 && d[k + 1] < 120) dark++;
    return dark;
  }, png ? png.content.toString('base64') : '');
  check('画像に文字と手書きが入っている', inkPx > 500);

  // 3ページに書き足すと、3ページの画像も送る（1ページの画像は作り直さない）
  const v1 = remote[dir + '/view/p1.png'].version;
  await line(250, await pageY(3, 300));
  await p.waitForTimeout(6000);
  check('書き足したページの画像を送る', !!remote[dir + '/view/p3.png'] && remote[dir + '/view/p1.png'].version === v1);

  // 「Claudeに聞く」: ファイルの本は sakai_study にないので、sakai_study で聞く方は出さない
  await p.click('#t-ls');
  const ly = await pageY(3, 150);
  await p.mouse.move(120, ly); await p.mouse.down(); for (const q of [[700, ly], [700, ly + 400], [120, ly + 400], [120, ly + 2]]) for (let k = 1; k <= 5; k++) await p.mouse.move(q[0], q[1]); await p.mouse.up();
  console.log('lasso', await p.textContent('#stat'));
  await p.click('#sel-ask'); await p.waitForTimeout(200);
  check('「sakai_studyで聞く」は出さない', await p.isHidden('#ask-code'));
  await p.click('#ask button[value=cancel]').catch(() => {}); await p.click('#sel-x').catch(() => {}); await p.click('#t-pen');

  // 答えのファイルを置くと、ページの右に Q
  drv.add(dir + '/answers', 'pdf-zz.md', '<!-- ink-answer id=zz b=3 -->\n> 質問: ためし\n\n答えです。$a=b$\n');
  await p.reload(); await p.waitForTimeout(2500);
  check('答えが Q 印になる', await p.evaluate(() => [...document.querySelectorAll('#qs .qm:not(.wait)')].map((m) => m.dataset.b).includes('3')));

  // ページの途中のたたんだ余白に書いた線も、画像では余白を開いて写す（画像の作り方の版が上がったら作り直す）
  const before = dims(remote[dir + '/view/p1.png'].content);
  await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('ink-reader', 1); r.onsuccess = () => {
    const st = r.result.transaction('kv', 'readwrite').objectStore('kv'), q = st.getAllKeys();
    q.onsuccess = () => {
      const k = q.result.find((x) => /^ink:local:.*:pdf$/.test(x)), vk = q.result.find((x) => /^viewv:/.test(x)), g = st.get(k);
      g.onsuccess = () => { const v = g.result, b1 = v.blocks[1];
        b1.sp = [[300, 400, 1]];
        b1.strokes.zz = { t: 'pen', c: 'r', s: 4, pen: true, p: [1000, 4000, 50, 5000, 4500, 50, 1000, 5000, 50, 5000, 6500, 50] };
        st.put(v, k); if (vk) st.delete(vk); st.transaction.oncomplete = res; };
    }; }; }));
  await p.reload(); await p.waitForTimeout(7000);
  const after = dims(remote[dir + '/view/p1.png'].content);
  console.log('p1.png', before, '->', after);
  check('たたんだ余白は開いて画像にする', after[1] >= before[1] + 790);
  const redPx = await p.evaluate(async (b64) => {
    const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode();
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let k = 0; k < d.length; k += 4) if (d[k] > 150 && d[k + 1] < 90) n++;
    return n;
  }, remote[dir + '/view/p1.png'].content.toString('base64'));
  check('余白に書いた線が画像に写る', redPx > 200);

  // md の本も本文ごと送る
  await p.click('#books'); await p.setInputFiles('#shelf .open-file', mdPath); await p.waitForTimeout(1500);
  await line(200, await p.evaluate(() => { const el = document.querySelector('#doc > p'); return el.getBoundingClientRect().top + 10; }));
  await p.waitForTimeout(6000);
  const mtop = Object.values(files).find((f) => /^試しの章 \(/.test(f.name)), mdir = mtop && 'Ink Reader/' + mtop.name;
  check('md の本文を送る', !!mdir && remote[mdir + '/chapters/c1.md'].content.toString().startsWith('# 試しの章'));
  check('md の書き込みを送る', !!mdir && !!remote[mdir + '/ink/c1.json']);
  check('md は画像を送らない', !!mdir && !remote[mdir + '/view']);
  check('最後まで GitHub には何も送らない', sent() === 0);
  check('同じフォルダ・ファイルを二つ作らない', !drv.twins());
  check('エラーなし', !errs.length); if (errs.length) console.log(errs);
  await b.close(); srv.close();
  console.log(ok ? 'OK' : 'NG'); process.exit(ok ? 0 : 1);
})();
