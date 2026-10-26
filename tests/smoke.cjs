// 手元確認用のスモークテスト（Playwright）。GitHub API をモックし、本は sakai_study のチェックアウトから読む。
// 使い方: node tests/smoke.cjs <sakai_study のパス> [スクリーンショットの出力先]
// 確認すること: 接続して本を取得 → 線を書く → ぐちゃぐちゃ消し → 投げ縄で選ぶ → 「Claudeに聞く」の本文・画像・リンク → いつものセッションの保存 → ピンチで拡大・縮小 → 目次・しおり
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http');
const REPO = path.resolve(process.argv[2] || '../sakai_study'), APP = path.resolve(__dirname, '..'), OUT = process.argv[3] || require('os').tmpdir();
const remote = {};   // path -> {content, sha}
let shaN = 1, putCount = 0;
const srv = http.createServer((q, r) => { const f = path.join(APP, decodeURIComponent(q.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(q.url.split('?')[0])); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } const ext = path.extname(f); r.writeHead(200, { 'content-type': { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }[ext] || 'application/octet-stream' }); r.end(b); }); }).listen(8767);
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ permissions: ['clipboard-read','clipboard-write'],  viewport: { width: 820, height: 1180 }, hasTouch: true });
  await ctx.route('https://api.github.com/**', async (route) => {
    const req = route.request(); const u = new URL(req.url()); const p = decodeURIComponent(u.pathname.replace('/repos/syakaikungg/sakai_study/contents/', ''));
    const raw = /raw/.test(req.headers()['accept']);
    if (req.method() === 'PUT') { putCount++; const body = JSON.parse(req.postData()); const cur = remote[p]; if ((cur && cur.sha) !== (body.sha || undefined) && !(cur == null && !body.sha)) return route.fulfill({ status: 409, body: '{}' });
      remote[p] = { content: Buffer.from(body.content, 'base64'), sha: 's' + shaN++ }; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: { sha: remote[p].sha } }) }); }
    if (remote[p]) return route.fulfill({ status: 200, contentType: 'application/json', body: raw ? remote[p].content : JSON.stringify({ sha: remote[p].sha, content: remote[p].content.toString('base64') }) });
    const fp = path.join(REPO, p);
    if (!fs.existsSync(fp)) return route.fulfill({ status: 404, body: '{}' });
    if (fs.statSync(fp).isDirectory()) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fs.readdirSync(fp).map((n) => ({ name: n, sha: 'f' + fs.statSync(path.join(fp, n)).size }))) });
    return route.fulfill({ status: 200, body: fs.readFileSync(fp) });
  });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404/.test(m.text()) && errs.push(m.text()));
  await p.goto('http://localhost:8767/'); await p.waitForTimeout(500);
  console.log('empty', await p.isVisible('#empty'));
  await p.click('#gear');
  await p.fill('#cfg-token', 'test'); await p.click('#cfg-save');
  await p.waitForFunction(() => document.querySelectorAll('#doc > *').length > 20, null, { timeout: 60000 });
  await p.waitForTimeout(800);
  // find a paragraph with inline math, scroll to it
  const y = await p.evaluate(() => { const el = [...document.querySelectorAll('#doc > p')].find((e) => e.querySelector('.katex')); el.scrollIntoView({ block: 'center' }); el.style.outline = '1px solid #0a0'; return el.getBoundingClientRect().top; });
  const line = async (x, y) => { await p.mouse.move(x, y); await p.mouse.down(); for (let i = 0; i < 20; i++) await p.mouse.move(x + i * 5, y + (i % 2) * 3); await p.mouse.up(); };
  await line(200, y + 12);
  // ぐちゃぐちゃ消し: 小さな字を3つ書き、縦のギザギザで塗りつぶす → 3画消える。m は消さない
  const draw = async (pts) => { await p.mouse.move(...pts[0]); await p.mouse.down(); for (const q of pts) await p.mouse.move(q[0], q[1], { steps: 4 }); await p.mouse.up(); };
  for (let i = 0; i < 3; i++) await draw([[300 + i * 25, y + 80], [310 + i * 25, y + 100], [318 + i * 25, y + 85]]);
  await draw([[300, y + 120], [300, y + 100], [309, y + 120], [309, y + 100], [318, y + 120]]);
  console.log('m', await p.textContent('#stat'));
  await draw([...Array(13)].map((_, i) => [295 + i * 7, i % 2 ? y + 104 : y + 76]));
  console.log('scribble', await p.textContent('#stat'));
  await p.click('#t-ls');
  const poly = [[90, y - 5], [700, y - 5], [700, y + 40], [90, y + 40], [90, y - 3]];
  await p.mouse.move(...poly[0]); await p.mouse.down(); for (const q of poly) for (let k = 1; k <= 5; k++) await p.mouse.move(q[0], q[1]); await p.mouse.up();
  console.log('stat', await p.textContent('#stat'), await p.textContent('#sel-n'));
  await p.click('#sel-ask'); await p.waitForTimeout(200);
  console.log('PV:\n' + await p.textContent('#ask-pv'));
  console.log('img', await p.evaluate(() => !document.getElementById('ask-img').hidden && document.getElementById('ask-img').naturalWidth));
  await p.fill('#ask-q', 'この式の意味は？');
  await ctx.route('https://claude.ai/**', (r) => r.fulfill({ status: 200, body: 'claude' }));
  await p.evaluate(() => { window.navs = []; document.addEventListener('click', (e) => { const a = e.target.closest('a'); if (a) { navs.push(a.href); e.preventDefault(); } }); });
  const go = async (sel) => { const h = await p.getAttribute(sel, 'href'); await p.evaluate((s) => document.querySelector(s).dispatchEvent(new MouseEvent('click', { cancelable: true, bubbles: true })), sel); await p.waitForTimeout(200); return decodeURIComponent(h).slice(0, 90) + ' | pages=' + ctx.pages().length; };
  console.log('btn', await p.textContent('#ask-code'), 'new hidden', await p.isHidden('#ask-new'));
  console.log('1', await go('#ask-code'), await p.textContent('#ask-msg'));
  await p.fill('#ask-sess', 'https://claude.ai/code/session_ABC123?x=1'); await p.dispatchEvent('#ask-sess', 'change');
  console.log('btn', await p.textContent('#ask-code'), 'new hidden', await p.isHidden('#ask-new'));
  console.log('2', await go('#ask-code'), await p.textContent('#ask-msg'));
  console.log('3', await go('#ask-new')); await p.fill('#ask-q', '別の質問'); console.log('upd', decodeURIComponent(await p.getAttribute('#ask-open','href')).slice(-12));
  const qid = decodeURIComponent(await p.getAttribute('#ask-new', 'href')).match(/質問ID:[+ ](\w+)/)[1];
  await p.reload(); await p.waitForTimeout(1500); console.log('saved', await p.evaluate(() => JSON.parse(localStorage.getItem('ink:cfg')).session));
  // Claude の答え: 送った質問は薄い「Q」→ answers/<章>.md に答えが入ると濃い「Q」→ 押すと段落の下に開き、下の書き込みも一緒に下がる
  const marks = () => p.$$eval('#qs .qm', (m) => m.map((x) => x.textContent + (x.classList.contains('wait') ? '(待ち)' : '') + '@' + x.dataset.b));
  console.log('ask marks', await marks());
  const qb = await p.evaluate(() => +document.querySelector('#qs .qm').dataset.b);
  remote['books/nishimori/answers/ch1.md'] = { sha: 'a1', content: Buffer.from(`# ch1 の答え\n\n<!-- ink-answer id=old b=${qb} -->\n> 質問: 前の質問\n\n前の答え\n\n<!-- ink-answer id=${qid} b=${qb},${qb + 1} -->\n> 質問: この式の意味は？\n\n$E=mc^2$ のことです。\n\n$$\\int_0^1 x\\,dx = \\tfrac12$$\n`) };
  await p.reload(); await p.waitForTimeout(1500);
  console.log('answer marks', await marks());
  const lastY = () => p.evaluate(() => { const l = [...document.querySelectorAll('#ink path:not(.lasso)')].pop(); return l ? Math.round(l.getBoundingClientRect().top) : null; });
  const n0b = await p.evaluate(() => document.querySelectorAll('#doc > *').length), y0 = await lastY();
  await p.evaluate(() => document.querySelector('#qs .qm').scrollIntoView({ block: 'center' }));
  await p.click('#qs .qm'); await p.waitForTimeout(300);
  console.log('open', await p.$$eval('#doc .ans .a', (a) => a.map((x) => x.textContent.slice(0, 30))), 'katex', await p.$$eval('#doc .ans .katex', (k) => k.length));
  await p.screenshot({ path: path.join(OUT, 'answer.png') });
  await p.click('#qs .qm'); await p.waitForTimeout(300);
  console.log('closed', await p.$$eval('#doc .ans', (a) => a.length), 'children', n0b, '->', await p.evaluate(() => document.querySelectorAll('#doc > *').length));
  await p.screenshot({ path: path.join(OUT, 'smoke.png') });
  // 2本指のピンチ: 指の間にあった紙の位置が、離したあとも指の間に残る。指で書いている途中の線は取りやめる
  const cdp = await ctx.newCDPSession(p);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  const pinchOut = async (cx, cy, d0, d1) => { await touch('touchStart', [[cx - d0, cy], [cx + d0, cy]]); for (let i = 1; i <= 8; i++) { const d = d0 + (d1 - d0) * i / 8; await touch('touchMove', [[cx - d, cy], [cx + d, cy]]); } await touch('touchEnd', []); await p.waitForTimeout(100); };
  const under = (x, y) => p.evaluate(([x, y]) => { const r = document.getElementById('page').getBoundingClientRect(), s = r.width / 680; return [(x - r.left) / s, (y - r.top) / s]; }, [x, y]);
  const before = await under(400, 600), z0 = await p.textContent('#zoomv option:first-child');
  await pinchOut(400, 600, 60, 120);
  const after = await under(400, 600);
  console.log('pinch', z0, '->', await p.textContent('#zoomv option:first-child'), 'drift', Math.round(Math.hypot(after[0] - before[0], after[1] - before[1])), 'scrollX', await p.evaluate(() => document.getElementById('wrap').scrollLeft > 0), 'bar', await p.evaluate(() => Math.round(document.getElementById('bar').getBoundingClientRect().width)));
  await p.screenshot({ path: path.join(OUT, 'pinch.png') });
  await p.selectOption('#zoomv', '1.5'); console.log('pick 150', await p.textContent('#zoomv option:first-child'), await p.inputValue('#zoomv'));
  await p.selectOption('#zoomv', 'fit'); console.log('fit', await p.textContent('#zoomv option:first-child'));
  await p.click('#t-pen'); await p.click('#finger'); const n0 = await p.evaluate(() => document.querySelectorAll('#ink path').length);
  await touch('touchStart', [[300, 500]]); await touch('touchMove', [[320, 510]]); await touch('touchStart', [[300, 500], [420, 520]]); await touch('touchMove', [[290, 500], [440, 520]]); await touch('touchEnd', []); await p.waitForTimeout(100);
  console.log('finger pinch: paths', n0, '->', await p.evaluate(() => document.querySelectorAll('#ink path').length), await p.textContent('#zoomv option:first-child'));

  // 目次・しおり: 段落を指で長押し → 印が付く → 目次に並ぶ → 別の章から押すと戻ってくる
  await p.click('#finger');
  const bmY = await p.evaluate(() => { const el = document.querySelectorAll('#doc > p')[8]; el.scrollIntoView({ block: 'center' }); return el.getBoundingClientRect().top + 10; });
  await touch('touchStart', [[400, bmY]]); await p.waitForTimeout(700); await touch('touchEnd', []);
  console.log('bookmark', await p.textContent('#stat'), await p.evaluate(() => [...document.querySelectorAll('#doc > *')].findIndex((e) => e.classList.contains('bm'))));
  await p.click('#chap'); console.log('toc bms', await p.$$eval('#toc-bms button', (o) => o.map((x) => x.textContent.slice(0, 30))), 'toc', await p.$$eval('#toc-list button', (o) => o.map((x) => x.className + ':' + x.textContent.slice(0, 12))));
  await p.screenshot({ path: path.join(OUT, 'toc.png') });
  const nCh = await p.$$eval('#toc-list button:not(.h2):not(.h3):not(.h4)', (o) => o.length);
  if (nCh > 1) { await p.click('#toc-list li:last-child button'); await p.waitForTimeout(500); console.log('jump chapter', await p.textContent('#chap-t')); await p.click('#chap'); }
  await p.click('#toc-bms button'); await p.waitForTimeout(500);
  console.log('back to bm', await p.textContent('#chap-t'), await p.evaluate(() => { const el = document.querySelector('#doc > .bm'); const r = el && el.getBoundingClientRect(); return r && Math.round(r.top - document.getElementById('bar').getBoundingClientRect().bottom); }));
  const hy = await p.evaluate(() => { const el = document.querySelector('#doc > .bm'); return el.getBoundingClientRect().top + 10; });
  await touch('touchStart', [[400, hy]]); await p.waitForTimeout(100); await touch('touchEnd', []);
  console.log('tap text (keeps)', await p.evaluate(() => document.querySelectorAll('#doc > .bm').length));
  await p.selectOption('#zoomv', 'fit'); await p.evaluate(() => document.querySelector('#doc > .bm').scrollIntoView({ block: 'center' }));
  const hy2 = await p.evaluate(() => document.querySelector('#doc > .bm').getBoundingClientRect().top + 10);
  const mx = await p.evaluate(() => { const el = document.querySelector('#doc > .bm'); return el.getBoundingClientRect().left - 24; });
  await touch('touchStart', [[mx, hy2]]); await p.waitForTimeout(100); await touch('touchEnd', []);
  console.log('tap mark', await p.textContent('#stat'), await p.evaluate(() => document.querySelectorAll('#doc > .bm').length));

  // ファイルから開く（GitHub なし）: 開く → 書く → 再読み込みで残る → GitHub の本に戻る
  const MD = process.env.MD_DIR;
  if (MD) {
    const puts = putCount;
    await p.click('#books'); await p.setInputFiles('#shelf .open-file', fs.readdirSync(MD).map((n) => path.join(MD, n)));
    await p.waitForFunction(() => document.querySelectorAll('#doc > *').length > 20, null, { timeout: 10000 });
    console.log('local', await p.textContent('#stat'), await p.textContent('#chap-t'));
    const ly = await p.evaluate(() => { const el = document.querySelectorAll('#doc > p')[5]; el.scrollIntoView({ block: 'center' }); return el.getBoundingClientRect().top; });
    await p.click('#t-pen'); await line(200, ly + 12); await p.waitForTimeout(500);
    await p.click('#t-ls'); await p.mouse.move(90, ly - 5); await p.mouse.down(); for (const q of [[700, ly - 5], [700, ly + 40], [90, ly + 40], [90, ly - 3]]) for (let k = 1; k <= 5; k++) await p.mouse.move(q[0], q[1]); await p.mouse.up();
    await p.click('#sel-ask'); await p.waitForTimeout(200);
    console.log('local ask: code hidden', await p.isHidden('#ask-code'), 'sess hidden', await p.isHidden('.sess'), 'open', decodeURIComponent(await p.getAttribute('#ask-open', 'href')).slice(0, 60));
    await p.click('#ask button[value=cancel]');
    await p.reload(); await p.waitForTimeout(1500);
    console.log('local after reload', await p.textContent('#chap-t'), 'strokes', await p.evaluate(() => document.querySelectorAll('#ink path:not(.lasso)').length), 'puts', putCount - puts);
    await p.click('#books'); console.log('shelf', await p.$$eval('#shelf-list .open', (o) => o.map((x) => x.textContent + (x.getAttribute('aria-current') === 'true' ? '*' : ''))));
    await p.click('#shelf-list li:first-child .open'); await p.waitForTimeout(1000);
    console.log('back to gh', await p.textContent('#chap-t'), 'strokes', await p.evaluate(() => document.querySelectorAll('#ink path:not(.lasso)').length));
    await p.click('#books'); await p.click('#shelf-list li:nth-child(2) .del'); await p.click('#shelf-list li:nth-child(2) .del'); await p.waitForTimeout(300);
    console.log('after delete', await p.$$eval('#shelf-list .open', (o) => o.map((x) => x.textContent)));
  }
  console.log('errs', errs); await b.close(); srv.close(); process.exit(errs.length ? 1 : 0);
})();
