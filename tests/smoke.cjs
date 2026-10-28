// 手元確認用のスモークテスト（Playwright）。GitHub API をモックし、本は sakai_study のチェックアウトから読む。
// 使い方: node tests/smoke.cjs <sakai_study のパス> [スクリーンショットの出力先]
// 確認すること: 接続して本を取得 → 線を書く → ぐちゃぐちゃ消し → 投げ縄で選ぶ → 「Claudeに聞く」の本文・画像・リンク → いつものセッションの保存 → ピンチで拡大・縮小 → 目次・しおり → 本文の検索 → ペン（色・太さ・図形補正）
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

  // 数式だけの段落（横スクロールする）にしおりを付けても、印が見える
  const dm = await p.evaluate(() => { const el = document.querySelector('#doc > .katex-display'); if (!el) return null; el.scrollIntoView({ block: 'center' }); return el.getBoundingClientRect().top + 10; });
  if (dm) { await touch('touchStart', [[400, dm]]); await p.waitForTimeout(700); await touch('touchEnd', []);
    console.log('math bookmark mark', await p.evaluate(() => { const i = document.querySelector('#bms i'), el = document.querySelector('#doc > .katex-display.bm'); if (!i || !el) return null; const a = i.getBoundingClientRect(), b = el.getBoundingClientRect(); return [Math.round(a.top - b.top), a.width > 0, a.right < b.left]; }));
    await touch('touchStart', [[400, dm]]); await p.waitForTimeout(700); await touch('touchEnd', []); console.log('math unbookmark', await p.evaluate(() => document.querySelectorAll('#bms i').length)); }

  // 本文の検索: 目次の検索欄 → 別の章の段落も見つかる → 押すとその段落へ飛んで色が付く
  await p.click('#chap'); console.log('search focus', await p.evaluate(() => document.activeElement && document.activeElement.id));
  await p.fill('#toc-q', 'mc^2 + x_3'); await p.waitForTimeout(500);
  const hits = await p.$$eval('#toc-hits li', (o) => o.map((x) => x.textContent.slice(0, 40)));
  console.log('hits', hits.length, hits[0], hits[hits.length - 1]);
  await p.click('#toc-hits li:last-child button'); await p.waitForTimeout(500);
  console.log('jump hit', await p.textContent('#chap-t'), await p.evaluate(() => { const el = document.querySelector('#doc > .hit'); return el && [el.textContent.slice(0, 12), Math.round(el.getBoundingClientRect().top - document.getElementById('bar').getBoundingClientRect().bottom)]; }));
  await p.click('#chap'); await p.fill('#toc-q', 'ないことば'); await p.waitForTimeout(400); console.log('no hit', await p.textContent('#toc-hits'), 'main hidden', await p.isHidden('#toc-main'));
  await p.fill('#toc-q', ''); await p.waitForTimeout(400); console.log('cleared: main hidden', await p.isHidden('#toc-main'));
  await p.mouse.click(20, 1100); console.log('outside tap closes', !(await p.evaluate(() => document.getElementById('toc').open)));
  await p.click('#chap'); await p.click('#toc-main > h2'); console.log('inside tap keeps', await p.evaluate(() => document.getElementById('toc').open));
  await p.click('#toc-list li:first-child button'); await p.waitForTimeout(500);   // 後の確認のため第1章に戻す

  // ペン: 選んでいる色をもう一度押すと色の一覧 → 選んだ色で描ける。太さも同じ。ペンを止めて押さえると図形に直る
  await p.click('#t-pen'); await p.click('#colors button:nth-child(2)'); await p.click('#colors button:nth-child(2)');
  console.log('palette open', await p.isVisible('#pop-colors')); await p.screenshot({ path: path.join(OUT, 'palette.png'), clip: { x: 0, y: 0, width: 820, height: 260 } });
  await p.click('#pop-colors button:nth-child(4)');
  console.log('palette pick', await p.getAttribute('#colors button:nth-child(2)', 'data-c'), 'closed', await p.isHidden('#pop'));
  const py = await p.evaluate(() => { const el = document.querySelectorAll('#doc > p')[3]; el.scrollIntoView({ block: 'center' }); return el.getBoundingClientRect().top; });
  await line(150, py + 10); await p.waitForTimeout(200);
  console.log('custom color fill', await p.evaluate(() => { const ps = [...document.querySelectorAll('#ink path')]; return ps[ps.length - 1].style.fill; }));
  await p.click('#sizes button:nth-child(2)'); console.log('size pop', await p.isVisible('#pop-size'));
  await p.evaluate(() => { const r = document.querySelector('#pop-size input'); r.value = '8'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); });
  await p.mouse.click(400, 1150); console.log('size', await p.getAttribute('#sizes button:nth-child(2)', 'data-s'), 'closed', await p.isHidden('#pop'));
  await p.click('#sizes button:nth-child(1)'); await p.click('#colors button:nth-child(1)');
  const hold = async (pts) => { await p.mouse.move(...pts[0]); await p.mouse.down(); for (const q of pts) await p.mouse.move(q[0], q[1]); await p.waitForTimeout(650); const s = await p.textContent('#stat'); await p.mouse.up(); await p.waitForTimeout(100); return s; };
  // 直線: 書き始めに小さなはね、止めている間のぶれがあっても直線になる
  const wob = [[150, py + 206], [146, py + 203]]; for (let i = 0; i <= 30; i++) wob.push([150 + i * 10, py + 200 + (i % 3) * 2]);
  await p.mouse.move(...wob[0]); await p.mouse.down(); for (const q of wob) await p.mouse.move(q[0], q[1]);
  for (let i = 0; i < 12; i++) { await p.mouse.move(450 + (i % 2), py + 200 + (i % 3) * .8); await p.waitForTimeout(50); }
  console.log('shape line (jitter)', await p.textContent('#stat'));
  // 離さずに動かすと向きと長さが変わる
  for (let i = 1; i <= 10; i++) await p.mouse.move(450 - i * 10, py + 200 + i * 15);
  await p.mouse.up(); await p.waitForTimeout(150);
  const hd = () => p.evaluate(() => [...document.querySelectorAll('#ink .hd circle')].map((c) => [Math.round(+c.getAttribute('cx')), Math.round(+c.getAttribute('cy'))]));
  const toPg = (x, y) => p.evaluate(([x, y]) => { const r = document.getElementById('page').getBoundingClientRect(), s = r.width / 680; return [Math.round((x - r.left) / s), Math.round((y - r.top) / s)]; }, [x, y]);
  console.log('live adjust: handles', JSON.stringify(await hd()), 'pen end at', JSON.stringify(await toPg(350, py + 350)));
  // つまみを動かすと形が変わり、戻すで元に戻る
  const toScr = (x, y) => p.evaluate(([x, y]) => { const r = document.getElementById('page').getBoundingClientRect(), s = r.width / 680; return [r.left + x * s, r.top + y * s]; }, [x, y]);
  const h1 = (await hd())[1], s1 = await toScr(...h1);
  await p.mouse.move(...s1); await p.mouse.down(); for (let i = 1; i <= 8; i++) await p.mouse.move(s1[0] + i * 10, s1[1] - i * 3); await p.mouse.up(); await p.waitForTimeout(150);
  console.log('handle drag', await p.textContent('#stat'), JSON.stringify(await hd()));
  await p.click('#undo'); await p.waitForTimeout(100); console.log('undo shape edit: handles', (await hd()).length, 'paths', await p.evaluate(() => document.querySelectorAll('#ink path:not(.lasso)').length));
  await p.click('#redo'); await p.waitForTimeout(100);
  const circ = []; for (let i = 0; i <= 40; i++) { const t = i / 40 * 2 * Math.PI; circ.push([400 + 60 * Math.cos(t) + (i % 2) * 2, py + 330 + 60 * Math.sin(t)]); }
  console.log('shape circle', await hold(circ));
  const sq = []; for (const [x0, y0, x1, y1] of [[200, 0, 320, 3], [320, 3, 318, 120], [318, 120, 202, 118], [202, 118, 200, 2]]) for (let i = 0; i < 12; i++) sq.push([x0 + (x1 - x0) * i / 12, py + 420 + y0 + (y1 - y0) * i / 12]);
  sq.push([200, py + 422]); console.log('shape square', await hold(sq));
  const tri = []; for (const [x0, y0, x1, y1] of [[500, 120, 560, 0], [560, 0, 620, 120], [620, 120, 500, 118]]) for (let i = 0; i < 14; i++) tri.push([x0 + (x1 - x0) * i / 14, py + 420 + y0 + (y1 - y0) * i / 14]);
  tri.push([502, py + 540]); console.log('shape triangle', await hold(tri));
  const sq2 = sq.map(([x, y]) => [x, y + 160]); await p.mouse.move(...sq2[0]); await p.mouse.down(); for (const q of sq2) await p.mouse.move(q[0], q[1]); await p.mouse.up(); await p.waitForTimeout(100);
  console.log('no hold keeps freehand', await p.textContent('#stat'));
  await p.reload(); await p.waitForTimeout(1500);
  await p.click('#t-ls'); const lc = await toScr(400, 0); const cy0 = await p.evaluate(() => { const c = [...document.querySelectorAll('#ink path')]; return 0; });
  const circY = py + 330; const cp = [[320, circY - 80], [480, circY - 80], [480, circY + 80], [320, circY + 80], [320, circY - 78]];
  await p.mouse.move(...cp[0]); await p.mouse.down(); for (const q of cp) for (let k = 1; k <= 4; k++) await p.mouse.move(q[0], q[1]); await p.mouse.up(); await p.waitForTimeout(150);
  console.log('lasso shape after reload', await p.textContent('#sel-n'), 'handles', (await hd()).length); await p.click('#sel-x'); await p.click('#t-pen');
  console.log('pens after reload', await p.getAttribute('#colors button:nth-child(2)', 'data-c'), await p.getAttribute('#sizes button:nth-child(2)', 'data-s'), await p.evaluate(() => [...document.querySelectorAll('#ink path')].some((x) => x.style.fill === 'rgb(31, 138, 76)')));
  // 少し傾いて少し曲がった線も、水平な直線になる。傾いた四角形も水平・垂直にそろう
  const qy = await p.evaluate(() => { const el = document.querySelectorAll('#doc > p')[9]; el.scrollIntoView({ block: 'start' }); return el.getBoundingClientRect().top + 80; });
  const tl = []; for (let i = 0; i <= 30; i++) tl.push([150 + i * 10, qy + 60 + i * 10 * Math.tan(7 * Math.PI / 180) + 8 * Math.sin(i / 30 * Math.PI)]);
  console.log('tilted line', await hold(tl), 'handles', JSON.stringify(await hd()));
  const tq = sq.map(([x, y]) => { const dx = x - 260, dy = y - (py + 480), r = 9 * Math.PI / 180; return [260 + dx * Math.cos(r) - dy * Math.sin(r), qy + 260 + dx * Math.sin(r) + dy * Math.cos(r)]; });
  console.log('tilted square', await hold(tq), 'handles', JSON.stringify(await hd()));
  // 四角形の辺のつまみを動かすと、辺ごと平行に動く
  { const h = await hd(), m = await toScr(...h[4]); await p.mouse.move(...m); await p.mouse.down(); for (let i = 1; i <= 6; i++) await p.mouse.move(m[0] + i * 4, m[1] - i * 5); await p.mouse.up(); await p.waitForTimeout(150);
    console.log('edge drag', await p.textContent('#stat'), JSON.stringify((await hd()).slice(0, 4))); }
  // 斜めの線は、書き終わりにはねがあっても、その向きのまま直線になる
  const dg = []; for (let i = 0; i <= 25; i++) dg.push([200 + i * 8, qy + 300 + i * 8 * Math.tan(35 * Math.PI / 180) + 3 * Math.sin(i)]);
  for (let i = 1; i <= 4; i++) dg.push([400 - i * 4, qy + 440 + i * 3]);
  console.log('diagonal hooked', await hold(dg), 'handles', JSON.stringify(await hd()));
  const arc = []; for (let i = 0; i <= 30; i++) { const t = Math.PI * (.15 + .7 * i / 30); arc.push([400 - 150 * Math.cos(t), qy + 600 - 150 * Math.sin(t)]); }
  console.log('arc stays freehand', await hold(arc));
  // マーカーも止めると直線になる（円などにはならない）
  await p.click('#t-hl');
  const hl = []; for (let i = 0; i <= 30; i++) hl.push([150 + i * 10, qy + 380 + (i % 3) * 2 + i * .5]);
  console.log('marker line', await hold(hl), 'handles', JSON.stringify(await hd()));
  console.log('marker circle stays', await hold(circ.map(([x, y]) => [x, y - py + qy + 160])));
  await p.click('#t-pen');
  // 丸で囲んで長押し: 囲んだ線をペンで押さえると投げ縄になり、そのまま動かせる。外を押すとペンに戻る
  const ry = await p.evaluate(() => { const ps = document.querySelectorAll('#doc > p'), el = ps[ps.length - 3]; el.scrollIntoView({ block: 'start' }); return el.getBoundingClientRect().top + 120; });
  const npath = () => p.evaluate(() => document.querySelectorAll('#ink path:not(.lasso)').length);
  await line(380, ry + 60);
  const loop = []; for (let i = 0; i <= 40; i++) { const t = i / 40 * 2 * Math.PI; loop.push([420 + 110 * Math.cos(t), ry + 60 + 70 * Math.sin(t)]); }
  await p.mouse.move(...loop[0]); await p.mouse.down(); for (const q of loop) await p.mouse.move(q[0], q[1]); await p.mouse.up(); await p.waitForTimeout(100);
  const nl0 = await npath();
  await p.mouse.move(420, ry - 10); await p.mouse.down(); await p.waitForTimeout(650);
  console.log('circle to lasso', await p.textContent('#stat'), 'lasso tool', await p.getAttribute('#t-ls', 'aria-pressed'), 'paths', nl0, '->', await npath());
  for (let i = 1; i <= 5; i++) await p.mouse.move(420 + i * 6, ry - 10 + i * 4); await p.mouse.up(); await p.waitForTimeout(150);
  console.log('dragged', await p.textContent('#stat'));
  await p.mouse.click(150, ry + 400); await p.waitForTimeout(100);
  console.log('back to pen', await p.getAttribute('#t-pen', 'aria-pressed'), 'menu hidden', await p.isHidden('#selmenu'));
  // 押さえずに輪の上で書くと、ふつうに書ける
  await line(300, ry + 125); console.log('tap on loop draws', await p.getAttribute('#t-pen', 'aria-pressed'));
  // 消しゴム: もう一度押すと種類と大きさ。なぞった所だけ消すと、線が2つに分かれ、戻すで元に戻る
  await p.click('#t-er'); await p.click('#t-er'); console.log('eraser pop', await p.isVisible('#pop-er')); await p.screenshot({ path: path.join(OUT, 'eraser.png'), clip: { x: 0, y: 0, width: 820, height: 260 } });
  await p.click('#pop-er [data-m=part]'); console.log('eraser mode closed', await p.isHidden('#pop'));
  await p.click('#t-pen');
  const ly2 = ry + 250; await p.mouse.move(150, ly2); await p.mouse.down(); for (let i = 1; i <= 30; i++) await p.mouse.move(150 + i * 15, ly2); await p.mouse.up(); await p.waitForTimeout(100);
  const nl1 = await npath();
  await p.click('#t-er'); await p.mouse.move(375, ly2 - 40); await p.mouse.down(); for (let i = 1; i <= 8; i++) await p.mouse.move(375, ly2 - 40 + i * 10); await p.mouse.up(); await p.waitForTimeout(150);
  console.log('partial erase', nl1, '->', await npath());
  await p.click('#undo'); await p.waitForTimeout(100); console.log('undo partial', await npath());
  await p.click('#t-er'); await p.click('#pop-er [data-m=stroke]');
  await p.mouse.move(375, ly2 - 40); await p.mouse.down(); for (let i = 1; i <= 8; i++) await p.mouse.move(375, ly2 - 40 + i * 10); await p.mouse.up(); await p.waitForTimeout(150);
  console.log('stroke erase', await npath(), 'saved', await p.evaluate(() => Object.keys(localStorage).filter((k) => /eraser/.test(k)).map((k) => localStorage[k])));
  await p.click('#t-pen');

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
