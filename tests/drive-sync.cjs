// Google ドライブ連携の確認（Playwright）。Google のログインとドライブ API はモックする
// 使い方: node tests/drive-sync.cjs
// 確認すること: 設定から「Google ドライブにつなぐ」→ 前に書いた分も「Ink Reader/<本>/」に送る（README・book.json・ink・ページの画像）
// → 「Claudeに聞く」の質問文と、囲んだ範囲・ページの画像 → Claude が置いた答えのファイルが Q 印になる → 接続が切れたら下の表示を押してつなぎ直す
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const APP = path.resolve(__dirname, '..'), N = 4;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8770);
let ok = true;
const check = (name, v) => { console.log(v ? '✓' : '✗', name); if (!v) ok = false; };

// ドライブのモック: ファイルとフォルダ（id -> { name, parents, mimeType, version, content, trashed }）
const files = { root: { name: 'root', mimeType: 'folder' } }; let idN = 1; const calls = [];
const FOLDER = 'application/vnd.google-apps.folder';
const byPath = (p) => { let id = 'root'; for (const name of p.split('/')) { const hit = Object.entries(files).find(([, f]) => f.name === name && !f.trashed && (f.parents || []).includes(id)); if (!hit) return null; id = hit[0]; } return files[id]; };
async function driveRoute(route) {
  const req = route.request(), u = new URL(req.url()), m = req.method(), json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  calls.push(m + ' ' + u.pathname);
  if (req.headers().authorization !== 'Bearer tok-ok') return route.fulfill({ status: 401, body: '{}' });
  let mm;
  if (m === 'GET' && u.pathname === '/drive/v3/files') {
    const q = u.searchParams.get('q'), name = (q.match(/name='((?:[^'\\]|\\.)*)'/) || [])[1], pid = q.match(/'([^']+)' in parents/)[1], folder = /mimeType=/.test(q);
    const list = Object.entries(files).filter(([, f]) => !f.trashed && (f.parents || []).includes(pid) && (name == null || f.name === name.replace(/\\(.)/g, '$1')) && (!folder || f.mimeType === FOLDER));
    return json({ files: list.map(([id, f]) => ({ id, name: f.name, version: String(f.version) })) });
  }
  if (m === 'POST' && u.pathname === '/drive/v3/files') { const b = JSON.parse(req.postData()), id = 'f' + idN++; files[id] = { ...b, version: 1 }; return json({ id }); }
  if (m === 'POST' && u.pathname === '/upload/drive/v3/files') {
    const raw = req.postDataBuffer(), bd = '--' + req.headers()['content-type'].split('boundary=')[1], parts = [];
    let i = raw.indexOf(bd); while (i >= 0) { const j = raw.indexOf(bd, i + bd.length); if (j < 0) break; parts.push(raw.slice(i + bd.length, j)); i = j; }
    const body = (p) => p.slice(p.indexOf('\r\n\r\n') + 4, p.length - 2);
    const meta = JSON.parse(body(parts[0]).toString()), id = 'f' + idN++;
    files[id] = { ...meta, version: 1, content: body(parts[1]) };
    return json({ version: '1' });
  }
  if (m === 'PATCH' && (mm = u.pathname.match(/^\/upload\/drive\/v3\/files\/(\w+)$/))) { const f = files[mm[1]]; f.content = req.postDataBuffer(); f.version++; return json({ version: String(f.version) }); }
  if (m === 'PATCH' && (mm = u.pathname.match(/^\/drive\/v3\/files\/(\w+)$/))) { Object.assign(files[mm[1]], JSON.parse(req.postData())); return json({}); }
  if (m === 'GET' && (mm = u.pathname.match(/^\/drive\/v3\/files\/(\w+)$/))) return route.fulfill({ status: 200, body: files[mm[1]].content });
  return route.fulfill({ status: 404, body: '{}' });
}
// Google のログイン（GIS）のモック: 押すとすぐ tok-ok を返す
const GIS = `window.google = { accounts: { oauth2: { initTokenClient: (o) => ({ requestAccessToken: () => { window.__logins = (window.__logins || 0) + 1; setTimeout(() => o.callback({ access_token: 'tok-ok', expires_in: 3600 }), 10); } }) } } };`;

(async () => {
  const b = await chromium.launch();
  const pdfPath = path.join(os.tmpdir(), 'ink-drive.pdf');
  const mk = await b.newPage();
  await mk.setContent(`<style>body{margin:0;font:28px serif} section{height:100vh;page-break-after:always;padding:40px;box-sizing:border-box}</style>` +
    [...Array(N)].map((_, i) => `<section><p>ページ ${i + 1} の本文。</p></section>`).join(''));
  await mk.pdf({ path: pdfPath, format: 'A4' }); await mk.close();

  const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:8770' });
  await ctx.route('https://www.googleapis.com/**', driveRoute);
  await ctx.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: GIS }));
  await ctx.route('https://api.github.com/**', (r) => { calls.push('GITHUB ' + r.request().url()); r.fulfill({ status: 404, body: '{}' }); });
  await ctx.route('https://claude.ai/**', (r) => r.fulfill({ status: 200, body: 'claude' }));
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404|401/.test(m.text()) && errs.push(m.text()));
  // 試験ページで入れたクライアント ID（設定に最初から入る）
  await p.goto('http://localhost:8770/'); await p.evaluate(() => localStorage.setItem('ink-drive-test', JSON.stringify({ cid: 'cid-test.apps.googleusercontent.com' })));
  await p.reload(); await p.waitForTimeout(300);
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
  check('クライアント ID は試験ページのものが入る', await p.inputValue('#cfg-dcid') === 'cid-test.apps.googleusercontent.com');
  check('ボタンは「Google ドライブにつなぐ」', (await p.textContent('#cfg-drive')).trim() === 'Google ドライブにつなぐ');
  await p.click('#cfg-drive'); await p.waitForTimeout(400);
  console.log('drv-msg', await p.textContent('#drv-msg'));
  check('つながった表示', /つながりました/.test(await p.textContent('#drv-msg')));
  await p.click('#cfg button[value=cancel]');
  await p.waitForFunction(() => /ドライブに保存しました/.test(document.getElementById('stat').textContent), null, { timeout: 15000 }).catch(() => {});
  await p.waitForTimeout(1500);
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
  check('PDF 本体は送らない', !Object.values(files).some((f) => /\.pdf$/.test(f.name)));
  check('GitHub には送らない', !calls.some((c) => /GITHUB/.test(c)));
  const folders = Object.values(files).filter((f) => f.mimeType === FOLDER).map((f) => f.name);
  check('同じフォルダを二つ作らない', folders.length === new Set(folders).size);

  // 書き足すと上書き（版が上がる）
  const v0 = ink.version;
  await line(260, await pageY(1, 400));
  await p.waitForTimeout(6000);
  check('書き足すと上書きする', byPath(dir + '/ink/pdf.json').version > v0 && Object.keys(JSON.parse(byPath(dir + '/ink/pdf.json').content).blocks['1'].strokes).length === 2);

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
  const ansId = Object.keys(files).find((k) => files[k] === ans);
  files['f' + idN++] = { name: `pdf-${id}.md`, parents: [ansId], mimeType: 'text/markdown', version: 1, content: Buffer.from(`<!-- ink-answer id=${id} b=2 -->\n> 質問: ためし\n\n答えです。$a=b$\n`) };
  await p.reload(); await p.waitForTimeout(3000);
  check('答えが Q 印になる', await p.evaluate(() => [...document.querySelectorAll('#qs .qm:not(.wait)')].map((m) => m.dataset.b).includes('2')));

  // 接続が切れたら、下の表示を押してつなぎ直す
  await p.evaluate(() => { const t = JSON.parse(localStorage.getItem('ink:dtok')); t.exp = Date.now() - 1000; localStorage.setItem('ink:dtok', JSON.stringify(t)); });
  await p.reload(); await p.waitForTimeout(1500);
  await line(200, await pageY(3, 200));
  await p.waitForTimeout(5500);
  console.log('stat', await p.textContent('#stat'));
  check('切れたことを知らせる', /つなぎ直します/.test(await p.textContent('#stat')));
  await p.click('#stat'); await p.waitForTimeout(4000);
  check('押すとつなぎ直して送る', !!JSON.parse(byPath(dir + '/ink/pdf.json').content).blocks['3']);
  check('エラーなし', !errs.length); if (errs.length) console.log(errs);
  await b.close(); srv.close();
  console.log(ok ? 'OK' : 'NG'); process.exit(ok ? 0 : 1);
})();
