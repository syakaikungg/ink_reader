// AI と勉強する机（段2）の確認（Playwright）。ドライブ API はモックする（sakai_study は要らない）
// 使い方: node tests/study.cjs
// 確認すること: 答えに「わかった」「まだ」を付ける → Q の見た目が変わり、ドライブの <本>/marks.json に入る（ほかの端末の分とまとめる）
// → 検索で Claude の答えも見つかり、押すとその段落へ飛んで答えが開く → 読んだ跡が <本>/log/<日付>.md に入る（1 分に 1 回まで）
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const APP = path.resolve(__dirname, '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8773);
let ok = true;
const check = (name, v) => { console.log(v ? '✓' : '✗', name); if (!v) ok = false; };
const { createDrive, GIS, connected } = require('./drive-mock.cjs');
const drv = createDrive(), { files, byPath } = drv;
const wait = async (p, f, ms = 6000) => { for (let i = 0; i < ms / 200 && !(await f()); i++) await p.waitForTimeout(200); return f(); };

(async () => {
  const b = await chromium.launch();
  const mdPath = path.join(os.tmpdir(), 'ink-study.md');
  fs.writeFileSync(mdPath, '# 勉強の章\n\n' + [...Array(40)].map((_, i) => `段落${i + 2}の本文です。` + 'ことばを足して長くする。'.repeat(6)).join('\n\n') + '\n');
  const ctx = await b.newContext({ viewport: { width: 820, height: 1000 }, deviceScaleFactor: 1, hasTouch: true });
  await ctx.route('https://www.googleapis.com/**', drv.route);
  await ctx.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: GIS }));
  await ctx.route('https://api.github.com/**', (r) => r.fulfill({ status: 404, body: '{}' }));
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404/.test(m.text()) && errs.push(m.text()));
  await p.goto('http://localhost:8773/');
  await p.evaluate((kv) => { for (const k in kv) localStorage.setItem(k, kv[k]); localStorage.setItem('ink:hint', '0'); }, connected());
  await p.reload(); await p.waitForTimeout(300);
  await p.setInputFiles('#empty .open-file', mdPath);
  await p.waitForFunction(() => document.querySelectorAll('#doc > p').length > 30, null, { timeout: 15000 });
  const top = await wait(p, () => Object.values(files).find((f) => /^勉強の章 \(/.test(f.name)));
  const dir = 'Ink Reader/' + top.name;
  await wait(p, () => byPath(dir + '/answers'));

  // Claude が 2 つ答えを置く → 開き直すと Q
  drv.add(dir + '/answers', 'c1-aa1111.md', '<!-- ink-answer id=aa1111 b=3 -->\n> 質問: ここは？\n\n固有値の重なりについての答えです。$\\lambda$\n');
  drv.add(dir + '/answers', 'c1-bb2222.md', '<!-- ink-answer id=bb2222 b=6 -->\n> 質問: これは？\n\n別の答えです。\n');
  await p.reload();
  await p.waitForSelector('#qs .qm[data-b="3"]:not(.wait)', { timeout: 8000 });
  const q3 = '#qs .qm[data-b="3"]';
  await p.click(q3); await p.waitForTimeout(200);
  check('答えの下に「わかった」「まだ」', await p.isVisible('.ans .mk button[data-m="ok"]') && await p.isVisible('.ans .mk button[data-m="no"]'));
  await p.click('.ans .mk button[data-m="ok"]'); await p.waitForTimeout(200);
  check('わかった: ボタンが押された形・Q は薄く「Q✓」', await p.getAttribute('.ans .mk button[data-m="ok"]', 'aria-pressed') === 'true' && await p.evaluate((s) => { const m = document.querySelector(s); return m.classList.contains('ok') && m.textContent === 'Q✓'; }, q3));
  const marks = () => { const f = byPath(dir + '/marks.json'); return f ? JSON.parse(f.content.toString()) : null; };
  await wait(p, () => marks() && marks()['c1-aa1111']);
  const m1 = marks();
  console.log('marks.json', JSON.stringify(m1));
  check('ドライブの marks.json に入る（章・段落・時刻つき）', m1 && m1['c1-aa1111'].m === 'ok' && m1['c1-aa1111'].c === 'c1' && m1['c1-aa1111'].b.join() === '3' && /^\d{4}-/.test(m1['c1-aa1111'].t));
  await p.click('.ans .mk button[data-m="no"]'); await p.waitForTimeout(200);
  check('まだ: Q の縁が赤', await p.evaluate((s) => document.querySelector(s).classList.contains('no'), q3) && await p.getAttribute('.ans .mk button[data-m="ok"]', 'aria-pressed') === 'false');
  await wait(p, () => marks()['c1-aa1111'].m === 'no');
  check('まだ もドライブに', marks()['c1-aa1111'].m === 'no');
  await p.click('.ans .mk button[data-m="no"]'); await p.waitForTimeout(200);
  await wait(p, () => marks()['c1-aa1111'].m === null);
  check('もう一度押すと外れる', marks()['c1-aa1111'].m === null && !(await p.evaluate((s) => document.querySelector(s).classList.contains('no'), q3)));
  // ほかの端末が別の答えに「わかった」を付けていた → 開き直すとまとめる（こちらの分も消えない）
  const f = byPath(dir + '/marks.json');
  f.content = Buffer.from(JSON.stringify({ ...marks(), 'c1-bb2222': { m: 'ok', t: '2099-01-01T00:00:00.000Z', c: 'c1', b: [6] } })); f.version++;
  await p.reload();
  await p.waitForSelector('#qs .qm[data-b="6"]', { timeout: 8000 });
  await wait(p, () => p.evaluate(() => document.querySelector('#qs .qm[data-b="6"]').classList.contains('ok')));
  check('ほかの端末の印も取り込む', await p.evaluate(() => document.querySelector('#qs .qm[data-b="6"]').classList.contains('ok')) && 'c1-aa1111' in marks());

  // 検索で答えも探す
  await p.click('#chap'); await p.waitForTimeout(200);
  await p.fill('#toc-q', '固有値の重なり'); await p.waitForTimeout(600);
  const hit = await p.textContent('#toc-hits');
  console.log('hits', hit);
  check('検索で Claude の答えが見つかる', /答え・勉強の章/.test(hit) && /固有値の重なり/.test(hit));
  await p.evaluate(() => scrollTo(0, 99999));
  await p.click('#toc-hits li.ans button, #toc-hits button.ans'); await p.waitForTimeout(400);
  check('押すとその段落へ飛んで答えが開く', await p.isVisible('.ans[data-b="3"]') && await p.evaluate(() => { const r = document.querySelector('#doc').children[3].getBoundingClientRect(); return r.top > 0 && r.top < innerHeight; }));

  // 読んだ跡
  const today = await p.evaluate(() => { const d = new Date(), z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; });
  const logf = () => byPath(`${dir}/log/${today}.md`), logt = () => (logf() ? logf().content.toString() : '');
  await p.mouse.move(150, 500); await p.mouse.down(); for (let i = 0; i < 20; i++) await p.mouse.move(150 + i * 5, 500 + (i % 2) * 3); await p.mouse.up();
  await wait(p, () => /書き込み/.test(logt()), 8000);
  console.log(logt());
  check('読んだ跡（時刻・章・段落・書いた段落）', new RegExp(`# ${today} の読んだ跡（「勉強の章」）`).test(logt()) && /- \d\d:\d\d〜\d\d:\d\d c1「勉強の章」 段落 \d+(〜\d+)?を見た。書き込み: \d+/.test(logt()));
  const v0 = logf().version;
  await p.evaluate(() => scrollBy(0, 1500)); await p.waitForTimeout(4000);
  check('読んだ跡は 1 分に 1 回まで', logf().version === v0);
  check('同じファイルを二つ作らない', !drv.twins());
  check('エラーなし', !errs.length); if (errs.length) console.log(errs);
  await b.close(); srv.close();
  console.log(ok ? 'OK' : 'NG'); process.exit(ok ? 0 : 1);
})();
