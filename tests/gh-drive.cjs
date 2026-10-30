// GitHub の本（sakai_study）の書き込み・答えをドライブに置く確認（Playwright）。GitHub API とドライブ API はモックする（sakai_study は要らない）
// 使い方: node tests/gh-drive.cjs
// 確認すること: ドライブにつなぐ前は GitHub に書き込みを送らない → 設定からつなぐと、GitHub にあった書き込み（開いていない章も）と
// 答え（<章>.md を 1 問 1 ファイルに分けて）をドライブの「Ink Reader/<題名> (<本>)/」へ一度だけ写す（本文は写さない）
// → 「sakai_studyで聞く」の質問文（手書きの画像と答えはドライブ、理解度のまとめは CLAUDE.md の手順）→ 「Claude アプリで聞く」も同じ置き方
// → Claude がドライブに置いた答えが Q 印になる → 開き直しても写し直さない。GitHub には最後まで何も書かない
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http');
const APP = path.resolve(__dirname, '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8771);
let ok = true;
const check = (name, v) => { console.log(v ? '✓' : '✗', name); if (!v) ok = false; };
const { createDrive, GIS, FOLDER, connected } = require('./drive-mock.cjs');
const drv = createDrive(), { files, byPath } = drv;

// GitHub の本: books/testbook（2章）。ch1 の 3 段落目と、まだ iPad で開いていない ch2 に、前に送った書き込みがある。ch2 には答えが 2 つ
const B = 'books/testbook';
const stroke = (x, y) => ({ t: 'pen', c: 'k', s: 3.4, pen: true, p: [x * 10, y * 10, 50, (x + 40) * 10, (y + 6) * 10, 50, (x + 80) * 10, y * 10, 50] });
const md = (n, tag) => `# ${tag} の見出し\n\n` + [...Array(n)].map((_, i) => `${tag} の ${i + 1} 番目の段落。$x_${i}$ を考える。`).join('\n\n') + '\n';
const gh = {
  [B + '/book.json']: JSON.stringify({ title: '試しの本', chapters: [{ id: 'ch1', label: '第1章', file: 'chapters/ch1.md' }, { id: 'ch2', label: '第2章', file: 'chapters/ch2.md' }], images: {} }),
  [B + '/chapters/ch1.md']: md(24, '一章'),
  [B + '/chapters/ch2.md']: md(12, '二章'),
  [B + '/ink/ch1.json']: JSON.stringify({ chapter: 'ch1', blocks: { 3: { b: 3, strokes: { old1: stroke(100, 10) } } } }),
  [B + '/ink/ch2.json']: JSON.stringify({ chapter: 'ch2', blocks: { 2: { b: 2, strokes: { old2: stroke(120, 8) } }, 5: { b: 5, strokes: { old3: stroke(90, 12) } } } }),
  [B + '/answers/ch2.md']: '# ch2 の答え\n\n<!-- ink-answer id=q1 b=2 -->\n> 質問: 前の質問\n\n前の答え $a$\n\n<!-- ink-answer id=q2 b=5,6 -->\n> 質問: 次の質問\n\n次の答え\n',
};
const sha = (s) => 'h' + require('crypto').createHash('sha1').update(s).digest('hex').slice(0, 8);

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:8771' });
  await ctx.route('https://www.googleapis.com/**', drv.route);
  await ctx.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: GIS }));
  await ctx.route('https://claude.ai/**', (r) => r.fulfill({ status: 200, body: 'claude' }));
  const log = [];
  const ghRoute = async (route) => {
    const req = route.request(), u = new URL(req.url()), p = decodeURIComponent(u.pathname.replace('/repos/syakaikungg/sakai_study/contents/', ''));
    const raw = /raw/.test(req.headers().accept || '');
    log.push(req.method() + ' ' + p);
    if (req.method() !== 'GET') return route.fulfill({ status: 403, body: '{}' });
    if (gh[p] != null) return route.fulfill({ status: 200, contentType: 'application/json', body: raw ? gh[p] : JSON.stringify({ sha: sha(gh[p]), content: Buffer.from(gh[p]).toString('base64') }) });
    const kids = Object.keys(gh).filter((k) => k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/'));
    if (kids.length) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(kids.map((k) => ({ name: k.split('/').pop(), sha: sha(gh[k]) }))) });
    return route.fulfill({ status: 404, body: '{}' });
  };
  await ctx.route('https://api.github.com/**', ghRoute);
  const sent = () => log.filter((x) => !/^GET /.test(x));
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404|401|403/.test(m.text()) && errs.push(m.text()));
  await p.goto('http://localhost:8771/');
  await p.evaluate((B) => { localStorage.setItem('ink:cfg', JSON.stringify({ token: 'test', book: B })); }, B);
  await p.reload();
  await p.waitForFunction(() => document.querySelectorAll('#doc > *').length > 20, null, { timeout: 30000 });
  await p.waitForTimeout(1500);
  const paths = () => p.evaluate(() => document.querySelectorAll('#ink path:not(.lasso)').length);
  check('つなぐ前は GitHub の書き込みを読まない（つないだときにまとめる）', await paths() === 0);
  const blockY = (n, d = 10) => p.evaluate(([n, d]) => { const el = document.querySelectorAll('#doc > *')[n]; el.scrollIntoView({ block: 'center' }); return el.getBoundingClientRect().top + d; }, [n, d]);
  const line = async (x, y) => { await p.mouse.move(x, y); await p.mouse.down(); for (let i = 0; i < 20; i++) await p.mouse.move(x + i * 5, y + (i % 2) * 3); await p.mouse.up(); };
  await line(200, await blockY(8));
  await p.waitForTimeout(5500);
  check('ドライブにつなぐ前は GitHub に送らない', sent().length === 0);
  check('つないでいなければ「未送信」と出ない', !/未送信/.test(await p.textContent('#stat')));

  // 設定から「Google ドライブにつなぐ」→ GitHub の書き込みと答えをドライブへ写す
  await p.click('#gear'); await p.waitForTimeout(400);
  await p.click('#cfg-drive'); await p.waitForTimeout(400);
  console.log('drv-msg', await p.textContent('#drv-msg'));
  await p.click('#cfg button[value=cancel]');
  await p.waitForFunction(() => /ドライブに保存しました/.test(document.getElementById('stat').textContent), null, { timeout: 20000 }).catch(() => {});
  await p.waitForTimeout(6000);
  console.log('stat', await p.textContent('#stat'));
  const top = Object.values(files).find((f) => f.mimeType === FOLDER && /^試しの本 \(testbook\)$/.test(f.name)), dir = top && 'Ink Reader/' + top.name;
  console.log('dir', dir);
  check('本のフォルダは「<題名> (<本>)」', !!top);
  const meta = dir && byPath(dir + '/book.json') && JSON.parse(byPath(dir + '/book.json').content);
  check('book.json に本文の場所（GitHub のリポジトリとフォルダ）', meta && meta.from === 'github' && meta.repo === 'syakaikungg/sakai_study' && meta.path === B && meta.chapters.map((c) => c.file).join() === 'chapters/ch1.md,chapters/ch2.md');
  check('本文はドライブに写さない', dir && !byPath(dir + '/chapters'));
  const ink = (c) => { const f = dir && byPath(dir + '/ink/' + c + '.json'); return f && JSON.parse(f.content).blocks; };
  const ids = (bl) => bl ? Object.values(bl).flatMap((x) => Object.keys(x.strokes || {})).sort() : [];
  console.log('ch1', JSON.stringify(ids(ink('ch1'))), 'ch2', JSON.stringify(ids(ink('ch2'))));
  check('開いている章: GitHub の分と、つなぐ前に書いた分を送る', ids(ink('ch1')).length === 2 && ids(ink('ch1')).includes('old1') && !!(ink('ch1') || {})[8]);
  check('開いていない章の書き込みも写す', ids(ink('ch2')).join() === 'old2,old3');
  const a1 = dir && byPath(dir + '/answers/ch2-q1.md'), a2 = dir && byPath(dir + '/answers/ch2-q2.md');
  check('答えを 1 問 1 ファイルに分けて写す', a1 && a2 && a1.content.toString().startsWith('<!-- ink-answer id=q1 b=2 -->\n> 質問: 前の質問') && /次の答え/.test(a2.content.toString()) && !/前の答え/.test(a2.content.toString()));
  check('README.md に GitHub の本の説明', /from: "github"/.test((byPath('Ink Reader/README.md') || { content: '' }).content.toString()));
  check('GitHub には何も書かない', sent().length === 0);

  // 書き足すとドライブに送る
  const v0 = byPath(dir + '/ink/ch1.json').version;
  await line(200, await blockY(12));
  await p.waitForTimeout(6000);
  check('書き足すとドライブに送る', byPath(dir + '/ink/ch1.json').version > v0 && ids(ink('ch1')).length === 3);

  // 「sakai_studyで聞く」: 本文は GitHub、手書きの画像と答えはドライブ。理解度のまとめは CLAUDE.md の手順で
  await p.click('#t-ls');
  const ly = await blockY(8, -6);
  await p.mouse.move(60, ly); await p.mouse.down(); for (const q of [[760, ly], [760, ly + 60], [60, ly + 60], [60, ly + 2]]) for (let k = 1; k <= 5; k++) await p.mouse.move(q[0], q[1]); await p.mouse.up();
  console.log('lasso', await p.textContent('#stat'));
  await p.click('#sel-ask'); await p.waitForTimeout(200);
  check('「sakai_studyで聞く」が出る', await p.isVisible('#ask-code'));
  await p.evaluate(() => { for (const id of ['ask-code', 'ask-open']) document.getElementById(id).addEventListener('click', (e) => e.preventDefault()); });
  await p.click('#ask-code'); await p.waitForTimeout(2500);
  const q = await p.evaluate(() => navigator.clipboard.readText());
  console.log(q);
  const id = (q.match(/ink-answer id=(\w+)/) || [])[1];
  check('質問文: 本文は GitHub の場所', q.includes(`本文: ${B}/chapters/ch1.md`) && q.includes('段落番号: 8'));
  check('質問文: 手書きの画像と答えはドライブ', q.includes(`${dir}/asks/${id}.png`) && q.includes(`${dir}/answers」に新しいファイル「ch1-${id}.md」`));
  check('質問文: 理解度のまとめは CLAUDE.md の手順で', /CLAUDE\.md の手順で、理解度のまとめに記録/.test(q));
  check('質問文: git pull・ink_view.py は使わない', !/git pull|ink_view/.test(q));
  check('囲んだ範囲の手書きの画像をドライブに置く', !!byPath(dir + '/asks/' + id + '.png'));
  check('答え待ちの Q', await p.evaluate(() => document.querySelectorAll('#qs .qm.wait').length === 1));

  // 「Claude アプリで聞く」も同じ置き方（答えが Q に戻る）
  await p.click('#ask-open'); await p.waitForTimeout(1500);
  const q2 = await p.evaluate(() => navigator.clipboard.readText());
  check('Claude アプリへの質問文: 本文は GitHub、答えはドライブ', q2.includes(`本文は GitHub の syakaikungg/sakai_study の ${B}/chapters/ch1.md`) && q2.includes(`${dir}/answers」に新しいファイル「ch1-${id}.md」`) && q2.includes('Ink Reader/README.md'));
  await p.click('#ask button[value=cancel]').catch(() => {}); await p.click('#sel-x').catch(() => {}); await p.click('#t-pen');

  // Claude がドライブに答えを置く → アプリに戻ると Q 印
  drv.add(dir + '/answers', `ch1-${id}.md`, `<!-- ink-answer id=${id} b=8 -->\n> 質問: ためし\n\n答えです。$a=b$\n`);
  await p.reload(); await p.waitForTimeout(3500);
  check('答えが Q 印になる', await p.evaluate(() => [...document.querySelectorAll('#qs .qm:not(.wait)')].map((m) => m.dataset.b).join() === '8'));
  await p.click('#qs .qm'); await p.waitForTimeout(300);
  check('押すと答えが開く（数式つき）', await p.evaluate(() => /答えです/.test(document.querySelector('#doc .ans .a').textContent) && !!document.querySelector('#doc .ans .katex')));

  // 開いていない章の、写した答えも Q 印になる
  await p.click('#chap'); await p.click('#toc-list li:last-child button');   // 目次から第2章へ
  await p.waitForTimeout(3500);
  console.log('ch2 marks', await p.$$eval('#qs .qm', (m) => m.map((x) => x.textContent + '@' + x.dataset.b)));
  check('写した答えが Q 印になる（ch2）', await p.evaluate(() => [...document.querySelectorAll('#qs .qm:not(.wait)')].map((m) => m.dataset.b).sort().join() === '2,5'));
  check('写した書き込みが出る（ch2）', await paths() === 2);
  const n = Object.keys(files).length;
  await p.reload(); await p.waitForTimeout(4000);
  check('開き直しても写し直さない', Object.keys(files).length === n && !drv.twins());
  check('最後まで GitHub には何も書かない', sent().length === 0);

  // 新しい iPad: トークンとドライブだけ入れて開くと、ドライブの書き込みが出る（GitHub に残っている古い書き込みで上書きしない）
  // 写したあとに前の iPad で同じ段落（3）に書き足した分がドライブにある。GitHub の ink/ch1.json は写す前のまま
  { const f = byPath(dir + '/ink/ch1.json'), j = JSON.parse(f.content); j.blocks[3].strokes.newer = stroke(100, 40); f.content = Buffer.from(JSON.stringify(j)); f.version++; }
  const c1 = JSON.stringify(ink('ch1')), c2 = JSON.stringify(ink('ch2'));
  const ctx2 = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true });
  await ctx2.route('https://www.googleapis.com/**', drv.route);
  await ctx2.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: GIS }));
  await ctx2.route('https://api.github.com/**', ghRoute);
  const q2p = await ctx2.newPage(); q2p.on('pageerror', (e) => errs.push(e.message));
  await q2p.goto('http://localhost:8771/');
  await q2p.evaluate((kv) => { for (const k in kv) localStorage.setItem(k, kv[k]); }, connected({ token: 'test', book: B }));
  await q2p.reload();
  await q2p.waitForFunction(() => document.querySelectorAll('#doc > *').length > 20, null, { timeout: 30000 });
  await q2p.waitForTimeout(6000);
  check('新しい iPad: ドライブの書き込みが出る', await q2p.evaluate(() => document.querySelectorAll('#ink path:not(.lasso)').length) === 4);
  check('新しい iPad: GitHub の古い書き込みでドライブを上書きしない', JSON.stringify(ink('ch1')) === c1 && JSON.stringify(ink('ch2')) === c2);
  await q2p.click('#chap'); await q2p.click('#toc-list li:last-child button'); await q2p.waitForTimeout(3000);
  check('新しい iPad: 開いていない章もドライブの分', await q2p.evaluate(() => document.querySelectorAll('#ink path:not(.lasso)').length) === 2 && !drv.twins());
  check('エラーなし', !errs.length); if (errs.length) console.log(errs);
  await b.close(); srv.close();
  console.log(ok ? 'OK' : 'NG'); process.exit(ok ? 0 : 1);
})();
