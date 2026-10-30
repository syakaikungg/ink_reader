// 長い md の章を軽くする（Playwright）。GitHub もドライブも使わない
// 使い方: node tests/lazy.cjs [スクリーンショットの出力先]
// 確認すること: 段落の多い章は、画面から遠い段落を描かない（.lz）→ 段落の位置は全部描いたときと同じ（ゆるいリスト・details・図・表がまじっても）
// → 2 回目は覚えた高さで開き、位置も同じ → 下の方の段落に書いた線が、開き直しても同じ所に出る → 短い章はそのまま
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const APP = path.resolve(__dirname, '..'), OUT = process.argv[2] || os.tmpdir();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8786);
let ok = true;
const check = (name, v, info) => { console.log(v ? '✓' : '✗', name, info === undefined ? '' : typeof info === 'string' ? info : JSON.stringify(info)); if (!v) ok = false; };
// いろいろな書き方をまぜた長い章（1 回分で 14 段落）
const part = (i) => `## 節 ${i}\n\n段落 ${i}-1。関数 $f(x)=x^{${i % 7}}$ と $\\int_0^1 f(x)\\,dx$ の性質を調べる。本文の長さをそれらしくするための文がもう少し続きます。\n\n$$\\sum_{k=1}^{${i}} k = \\frac{n(n+1)}{2}$$\n\n- ゆるいリスト ${i}\n\n- 二つ目\n\n  続きの段落\n\n| 記号 | 意味 |\n|---|---|\n| $\\alpha$ | 角 ${i} |\n\n> 引用 ${i}\n\n<details><summary>答え ${i}</summary>\n\n隠した答え。\n\n</details>\n\n\`\`\`\ncode ${i}\n\`\`\`\n\n<figure><svg viewBox="0 0 100 40" width="200" height="80"><rect width="100" height="40" fill="currentColor"/></svg></figure>\n\n段落 ${i}-2。**強調** と [リンク](#節-1)。\n\n1. 番号\n2. 番号\n\n---\n\n段落 ${i}-3。おわり。`;
const MD = '# 長い章\n\n' + [...Array(45)].map((_, i) => part(i + 1)).join('\n\n') + '\n';

(async () => {
  const b = await chromium.launch();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-lazy-'));
  fs.writeFileSync(path.join(dir, 'long.md'), MD); fs.writeFileSync(path.join(dir, 'short.md'), '# 短い章\n\n' + [...Array(40)].map((_, i) => `段落 ${i + 1}。`).join('\n\n') + '\n');
  const errs = [];
  const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1, hasTouch: true });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404|ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(m.text()) && errs.push(m.text()));
  await p.goto('http://localhost:8786/'); await p.waitForTimeout(400);
  const title = (t) => p.waitForFunction((t) => document.getElementById('chap-t').textContent.includes(t) && !document.querySelector('#doc.loading'), t, { timeout: 30000 });
  const tops = () => p.evaluate(() => [...document.getElementById('doc').children].map((e) => e.offsetTop));
  // 全部描いたとき（.lz の content-visibility を外す）と位置が同じか
  const same = () => p.evaluate(() => {
    const kids = [...document.getElementById('doc').children], a = kids.map((e) => e.offsetTop);
    for (const e of document.querySelectorAll('#doc > .lz')) e.style.contentVisibility = 'visible';
    const f = kids.map((e) => e.offsetTop);
    for (const e of document.querySelectorAll('#doc > .lz')) e.style.contentVisibility = '';
    const d = a.map((v, i) => [i, f[i] - v]).filter((x) => x[1]);
    return { ok: !d.length, d: d.slice(0, 5) };
  });
  await p.setInputFiles('#empty .open-file', ['long.md', 'short.md'].map((n) => path.join(dir, n)));
  await title('長い章');
  await p.waitForFunction(() => document.querySelectorAll('#doc > .lz').length > 0, null, { timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(1500);
  const n = await p.evaluate(() => ({ all: document.getElementById('doc').children.length, lz: document.querySelectorAll('#doc > .lz').length, kinds: [...new Set([...document.querySelectorAll('#doc > :not(.lz)')].map((e) => e.tagName + (e.className ? '.' + e.className : '')))] }));
  check('段落の多い章は、遠い段落を描かない', n.lz > n.all * .6, n);
  let s = await same();
  check('位置は全部描いたときと同じ（はじめて開いたとき）', s.ok, s.d);
  await p.evaluate(() => scrollTo(0, document.body.scrollHeight)); await p.waitForTimeout(500);
  s = await same();
  check('一番下まで動かしても同じ', s.ok, s.d);
  const t0 = await tops();
  // 下の方の段落に線を書く
  const target = await p.evaluate(() => { const el = [...document.querySelectorAll('#doc > p')].find((x) => x.textContent.startsWith('段落 40-2。')); el.scrollIntoView({ block: 'center' }); return [...document.getElementById('doc').children].indexOf(el); });
  await p.waitForTimeout(400);
  const r = await p.evaluate((k) => { const a = document.getElementById('doc').children[k].getBoundingClientRect(); return [a.left + 40, a.top + a.height / 2]; }, target);
  await p.mouse.move(r[0], r[1]); await p.mouse.down(); for (let i = 1; i <= 15; i++) await p.mouse.move(r[0] + i * 10, r[1] + (i % 2) * 4); await p.mouse.up();
  await p.waitForTimeout(800);
  const rel = (k) => p.evaluate((k) => { const el = document.getElementById('doc').children[k].getBoundingClientRect(), ink = [...document.querySelectorAll('#ink path')].map((x) => x.getBoundingClientRect()).find((q) => q.width > 100); return ink && [Math.round(ink.left - el.left), Math.round(ink.top - el.top)]; }, k);
  const before = await rel(target);
  // 開き直す（覚えた高さで開く）
  await p.reload(); await title('長い章');
  const quick = await p.evaluate(() => document.querySelectorAll('#doc > .lz').length);
  await p.waitForTimeout(800);
  const t1 = await tops();
  check('2 回目は覚えた高さで開く（すぐに .lz）', quick > n.all * .6, quick);
  check('2 回目も位置が同じ', t1.length === t0.length && t1.every((v, i) => v === t0[i]), t1.map((v, i) => [i, v - t0[i]]).filter((x) => x[1]).slice(0, 5));
  s = await same();
  check('2 回目も全部描いたときと同じ', s.ok, s.d);
  await p.evaluate((k) => document.getElementById('doc').children[k].scrollIntoView({ block: 'center' }), target); await p.waitForTimeout(400);
  const after = await rel(target);
  check('下の方に書いた線が、開き直しても同じ所', before && after && before[0] === after[0] && before[1] === after[1], [before, after]);
  await p.screenshot({ path: path.join(OUT, 'lazy.png') });
  // 短い章はそのまま
  await p.click('#next2'); await title('短い章'); await p.waitForTimeout(500);
  check('短い章はそのまま（.lz なし）', await p.evaluate(() => !document.querySelector('#doc > .lz')));
  check('エラーなし', !errs.length, errs);
  await b.close(); srv.close(); process.exit(ok ? 0 : 1);
})();
