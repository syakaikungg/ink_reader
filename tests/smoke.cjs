// 手元確認用のスモークテスト（Playwright）。GitHub API をモックし、本は sakai_study のチェックアウトから読む。
// 使い方: node tests/smoke.cjs <sakai_study のパス> [スクリーンショットの出力先]
// 確認すること: 接続して本を取得 → 線を書く → 投げ縄で選ぶ → 「Claudeに聞く」の本文・画像・リンク → いつものセッションの保存
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http');
const REPO = path.resolve(process.argv[2] || '../sakai_study'), APP = path.resolve(__dirname, '..'), OUT = process.argv[3] || require('os').tmpdir();
const remote = {};   // path -> {content, sha}
let shaN = 1, putCount = 0;
const srv = http.createServer((q, r) => { const f = path.join(APP, decodeURIComponent(q.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(q.url.split('?')[0])); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } const ext = path.extname(f); r.writeHead(200, { 'content-type': { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }[ext] || 'application/octet-stream' }); r.end(b); }); }).listen(8767);
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ permissions: ['clipboard-read','clipboard-write'],  viewport: { width: 820, height: 1180 } });
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
  await p.fill('#cfg-token', 'test'); await p.click('#cfg-save');
  await p.waitForFunction(() => document.querySelectorAll('#doc > *').length > 20, null, { timeout: 60000 });
  await p.waitForTimeout(800);
  // find a paragraph with inline math, scroll to it
  const y = await p.evaluate(() => { const el = [...document.querySelectorAll('#doc > p')].find((e) => e.querySelector('.katex')); el.scrollIntoView({ block: 'center' }); el.style.outline = '1px solid #0a0'; return el.getBoundingClientRect().top; });
  const line = async (x, y) => { await p.mouse.move(x, y); await p.mouse.down(); for (let i = 0; i < 20; i++) await p.mouse.move(x + i * 5, y + (i % 2) * 3); await p.mouse.up(); };
  await line(200, y + 12);
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
  await p.reload(); await p.waitForTimeout(1500); console.log('saved', await p.evaluate(() => JSON.parse(localStorage.getItem('ink:cfg')).session));
  await p.screenshot({ path: path.join(OUT, 'smoke.png') });
  // lasso blank text only (no strokes)
  
  console.log('errs', errs); await b.close(); srv.close(); process.exit(errs.length ? 1 : 0);
})();
