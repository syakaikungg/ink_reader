// Google ドライブ連携の確認（Playwright）。Google のログインとドライブ API はモックする
// 使い方: node tests/drive-sync.cjs
// 確認すること: 設定から「Google ドライブにつなぐ」→ 前に書いた分も「Ink Reader/<本>/」に送る（README・book.json・ink・ページの画像）
// → PDF 本体（book.pdf）と書き出しの道具（ink_export.mjs）を置き、ドライブのものだけで書き込みつき PDF を作れる
// → 「Claudeに聞く」の質問文と、囲んだ範囲・ページの画像 → Claude が置いた答えのファイルが Q 印になる → 接続が切れたら下の表示を押してつなぎ直す
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os'), { execFileSync } = require('child_process');
const APP = path.resolve(__dirname, '..'), N = 4;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8770);
let ok = true;
const check = (name, v) => { console.log(v ? '✓' : '✗', name); if (!v) ok = false; };

const { createDrive, GIS, FOLDER } = require('./drive-mock.cjs');
const drv = createDrive(), { files, calls, byPath, twins } = drv;

(async () => {
  const b = await chromium.launch();
  const pdfPath = path.join(os.tmpdir(), 'ink-drive.pdf');
  const mk = await b.newPage();
  await mk.setContent(`<style>body{margin:0;font:28px serif} section{height:100vh;page-break-after:always;padding:40px;box-sizing:border-box}</style>` +
    [...Array(N)].map((_, i) => `<section><p>ページ ${i + 1} の本文。</p></section>`).join(''));
  await mk.pdf({ path: pdfPath, format: 'A4' }); await mk.close();

  const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:8770' });
  await ctx.route('https://www.googleapis.com/**', drv.route);
  await ctx.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: GIS }));
  await ctx.route('https://api.github.com/**', (r) => { calls.push('GITHUB ' + r.request().url()); r.fulfill({ status: 404, body: '{}' }); });
  await ctx.route('https://claude.ai/**', (r) => r.fulfill({ status: 200, body: 'claude' }));
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404|401/.test(m.text()) && errs.push(m.text()));
  await p.goto('http://localhost:8770/'); await p.waitForTimeout(300);
  await p.setInputFiles('#empty .open-file', pdfPath);
  await p.waitForFunction((n) => document.querySelectorAll('#doc > .pg').length === n, N, { timeout: 30000 });
  await p.waitForTimeout(800);
  const line = async (x, y) => { await p.mouse.move(x, y); await p.mouse.down(); for (let i = 0; i < 20; i++) await p.mouse.move(x + i * 5, y + (i % 2) * 3); await p.mouse.up(); };
  const pageY = (n, d) => p.evaluate(([n, d]) => { const el = document.querySelector(`#doc > .pg[data-n="${n}"]`); el.scrollIntoView(); return el.getBoundingClientRect().top + d; }, [n, d]);
  await line(200, await pageY(1, 200));
  await p.waitForTimeout(4500);
  check('つなぐ前は何も送らない', !calls.length && !/未送信/.test(await p.textContent('#stat')));

  // 設定から「Google ドライブにつなぐ」
  await p.click('#gear'); await p.waitForTimeout(500);
  check('クライアント ID の欄はない（アプリに入っている）', !(await p.$('#cfg-dcid')));
  check('ボタンは「Google ドライブにつなぐ」', (await p.textContent('#cfg-drive')).trim() === 'Google ドライブにつなぐ');
  await p.click('#cfg-drive'); await p.waitForTimeout(400);
  console.log('drv-msg', await p.textContent('#drv-msg'));
  check('つながった表示', /つながりました/.test(await p.textContent('#drv-msg')));
  check('アプリのクライアント ID でログインする', await p.evaluate(() => window.__cid) === '475510876028-4so1cqd8mfv7kbeq09fiapqe3vo8eetj.apps.googleusercontent.com');
  await p.click('#cfg button[value=cancel]');
  await p.waitForFunction(() => /ドライブに保存しました/.test(document.getElementById('stat').textContent), null, { timeout: 15000 }).catch(() => {});
  await p.waitForTimeout(1500);
  for (let i = 0; i < 40 && !Object.values(files).some((f) => f.name === 'pdf.json'); i++) await p.waitForTimeout(250);   // 重いときは送るのが遅れる
  const bookDir = Object.values(files).find((f) => f.mimeType === FOLDER && /^ink-drive \(/.test(f.name));
  const dir = 'Ink Reader/' + (bookDir && bookDir.name);
  console.log('dir', dir);
  check('README.md を置く', !!byPath('Ink Reader/README.md') && /answers/.test(byPath('Ink Reader/README.md').content));
  const meta = byPath(dir + '/book.json');
  check('book.json（題名・PDF・ページの大きさ）', meta && (() => { const j = JSON.parse(meta.content); return j.title === 'ink-drive' && j.pdf && j.sizes.length === N; })());
  const ink = byPath(dir + '/ink/pdf.json');
  check('前に書いた分を送る', ink && Object.keys(JSON.parse(ink.content).blocks).join() === '1');
  const png = byPath(dir + '/view/p1.png');
  check('1ページの画像（PNG）', png && png.content.slice(1, 4).toString() === 'PNG' && png.mimeType === 'image/png');
  // PDF 本体（10MB まで）と書き出しの道具を置く。クラウドの Claude がドライブのものだけで、書き込みつきの PDF を作れる
  const bpdf = byPath(dir + '/book.pdf'), tool = byPath('Ink Reader/ink_export.mjs');
  check('PDF 本体を一度だけ置く', bpdf && bpdf.mimeType === 'application/pdf' && Buffer.compare(bpdf.content, fs.readFileSync(pdfPath)) === 0 && Object.values(files).filter((f) => /\.pdf$/.test(f.name)).length === 1);
  check('書き出しの道具（export.js）と、その使い方を README に', tool && tool.mimeType === 'text/javascript' && tool.content.toString() === fs.readFileSync(path.join(APP, 'export.js'), 'utf8') && /node ink_export\.mjs/.test(byPath('Ink Reader/README.md').content));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-cloud-'));
  fs.symlinkSync(path.join(APP, 'vendor'), path.join(work, 'vendor'));   // npm i の代わりにアプリの pdf-lib・perfect-freehand を使う
  for (const [f, n] of [[tool, 'ink_export.mjs'], [bpdf, 'book.pdf'], [meta, 'book.json'], [ink, 'pdf.json']]) fs.writeFileSync(path.join(work, n), f.content);
  let made = '';
  try { made = execFileSync('node', ['ink_export.mjs', '--pdf', 'book.pdf', '--book', 'book.json', '--ink', 'pdf.json', '--pages', '1', '--out', 'out.pdf'], { cwd: work, encoding: 'utf8' }); } catch (e) { made = String(e.stderr || e.message); }
  console.log('  ' + made.trim().split('\n').pop());
  check('ドライブのものだけで、書き込みつきの PDF を作れる', /できました: out\.pdf（1枚/.test(made) && fs.readFileSync(path.join(work, 'out.pdf')).slice(0, 5).toString() === '%PDF-');
  check('GitHub には送らない', !calls.some((c) => /GITHUB/.test(c)));
  check('同じフォルダ・ファイルを二つ作らない', !twins());

  // 書き足すと上書き（版が上がる）
  const v0 = ink.version;
  await line(260, await pageY(1, 400));
  await p.waitForTimeout(6000);
  check('書き足すと上書きする', byPath(dir + '/ink/pdf.json').version > v0 && Object.keys(JSON.parse(byPath(dir + '/ink/pdf.json').content).blocks['1'].strokes).length === 2);
  // アプリを新しくしたら（版が変わったら）、README と道具を置き直す。PDF 本体は置き直さない
  const tv = byPath('Ink Reader/ink_export.mjs').version, pv = byPath(dir + '/book.pdf').version;
  await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('ink-reader', 1); r.onsuccess = () => { const t = r.result.transaction('kv', 'readwrite'); t.objectStore('kv').put('ink-reader-v1', 'tools:drive'); t.oncomplete = res; }; }));
  await p.reload(); await p.waitForTimeout(3000);
  check('版が変わると道具を置き直す（PDF 本体はそのまま）', byPath('Ink Reader/ink_export.mjs').version === tv + 1 && byPath(dir + '/book.pdf').version === pv && !twins());

  // Claudeに聞く: ドライブの場所と答えの置き方を書いた質問文。囲んだ範囲とページの画像を置く
  await p.click('#t-ls');
  const ly = await pageY(2, 150);
  await line(250, ly + 150); await p.click('#t-ls');
  await p.mouse.move(120, ly); await p.mouse.down(); for (const q of [[700, ly], [700, ly + 400], [120, ly + 400], [120, ly + 2]]) for (let k = 1; k <= 5; k++) await p.mouse.move(q[0], q[1]); await p.mouse.up();
  await p.click('#sel-ask'); await p.waitForTimeout(200);
  check('sakai_study の方は出さない', await p.isHidden('#ask-code'));
  check('「Claude を開く」が主', await p.evaluate(() => document.getElementById('ask-open').classList.contains('primary')));
  await p.evaluate(() => document.getElementById('ask-open').addEventListener('click', (e) => e.preventDefault()));
  await p.click('#ask-open'); await p.waitForTimeout(3000);
  const q = await p.evaluate(() => navigator.clipboard.readText());
  console.log(q);
  const id = (q.match(/ink-answer id=(\w+)/) || [])[1];
  check('質問文にドライブの場所と答えの置き方', q.includes(dir) && q.includes('Ink Reader/README.md') && q.includes(`pdf-${id}.md`) && q.includes(dir + '/view/p2.png'));
  check('聞いたページの画像を置く', !!byPath(dir + '/view/p2.png'));
  check('囲んだ範囲の画像を置く', !!byPath(dir + '/asks/' + id + '.png'));
  await p.click('#ask button[value=cancel]').catch(() => {}); await p.click('#sel-x').catch(() => {}); await p.click('#t-pen');
  check('答え待ちの Q', await p.evaluate(() => [...document.querySelectorAll('#qs .qm.wait')].length === 1));

  // Claude がドライブに答えのファイルを作る → アプリに戻ると Q 印
  const ans = byPath(dir + '/answers');
  check('答えのフォルダを作っておく', !!ans && ans.mimeType === FOLDER);
  drv.add(dir + '/answers', `pdf-${id}.md`, `<!-- ink-answer id=${id} b=2 -->\n> 質問: ためし\n\n答えです。$a=b$\n`);
  await p.reload(); await p.waitForTimeout(3000);
  check('答えが Q 印になる', await p.evaluate(() => [...document.querySelectorAll('#qs .qm:not(.wait)')].map((m) => m.dataset.b).includes('2')));

  // 接続が切れたら、次に画面に触れたとき（ペンを離したとき）に自動でつなぎ直す。2回目からは同意の画面なし・同じアカウントで
  const expire = () => p.evaluate(() => { const t = JSON.parse(localStorage.getItem('ink:dtok')); t.exp = Date.now() - 1000; localStorage.setItem('ink:dtok', JSON.stringify(t)); });
  check('アカウントを覚える', JSON.parse(await p.evaluate(() => localStorage.getItem('ink:dtok'))).who === 'me@example.com');
  await expire(); await p.reload(); await p.waitForTimeout(3800);
  const n0 = await p.evaluate(() => window.__logins || 0);
  await line(200, await pageY(3, 200));
  await p.waitForTimeout(6000);
  check('触れると自動でつなぎ直す', await p.evaluate(() => window.__logins || 0) === n0 + 1);
  check('同意の画面なし・同じアカウント', await p.evaluate(() => JSON.stringify(window.__last)) === JSON.stringify({ hint: 'me@example.com', prompt: '' }));
  check('つなぎ直して送る', !!JSON.parse(byPath(dir + '/ink/pdf.json').content).blocks['3']);

  // 自動でつなげなかったら（ポップアップを閉じた等）、下の表示を押してつなぎ直す
  await expire(); await p.reload(); await p.waitForTimeout(3800);
  await p.evaluate(() => { window.__fail = true; });
  await line(200, await pageY(4, 200));
  await p.waitForTimeout(5500);
  console.log('stat', await p.textContent('#stat'));
  check('切れたことを知らせる', /つなぎ直します/.test(await p.textContent('#stat')));
  const n1 = await p.evaluate(() => window.__logins);
  await line(220, await pageY(4, 260)); await p.waitForTimeout(500);
  check('失敗したらすぐには繰り返さない', await p.evaluate(() => window.__logins) === n1);
  await p.evaluate(() => { window.__fail = false; });
  await p.click('#stat'); await p.waitForTimeout(5000);
  check('押すとつなぎ直して送る', !!JSON.parse(byPath(dir + '/ink/pdf.json').content).blocks['4']);
  check('最後まで同じファイルを二つ作らない', !twins());
  check('エラーなし', !errs.length); if (errs.length) console.log(errs);
  await b.close(); srv.close();
  console.log(ok ? 'OK' : 'NG'); process.exit(ok ? 0 : 1);
})();
