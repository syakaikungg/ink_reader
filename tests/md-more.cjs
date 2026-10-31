// md の本の細かい所（Playwright）。ドライブ API はモック（GitHub は使わない）
// 使い方: node tests/md-more.cjs [スクリーンショットの出力先]
// 確認すること: いま.md に渡す本文は元の md のまま（リスト・リンク・強調が崩れない）→ 右下に章の中の位置（%）。押すと目次で今いる見出しを見せる。短い章では出さない
// → 段落から下にはみ出して書いた線に、答え（Q）が重ならない
// → 段落の途中に余白を入れられる（行の切れ目に入り、字の折り返しは変わらない。下の行の線も一緒に下がる。書ける・たたむ・開き直しても同じ所）
// → 最初の段落の上半分に横線を引くと、その段落の上に余白（出典の行には付けない）
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const APP = path.resolve(__dirname, '..'), OUT = process.argv[2] || os.tmpdir();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8785);
let ok = true;
const check = (name, v, info) => { console.log(v ? '✓' : '✗', name, info === undefined ? '' : typeof info === 'string' ? info : JSON.stringify(info)); if (!v) ok = false; };
const { createDrive, GIS, FOLDER, connected } = require('./drive-mock.cjs');
const drv = createDrive(), { files, byPath } = drv;
const filler = (n, tag) => [...Array(n)].map((_, i) => `${tag}の段落 ${i + 1}。本文の長さをそれらしくするための文です。関数 $f(x)=x^2$ を考えます。`).join('\n\n');
const MD = `# 細かい所\n\n## はじめ\n\n${filler(6, 'はじめ')}\n\nリストの段落:\n\n- 項目 1 と **強調**\n- 項目 2 と [次の章へ](short.md)\n  - 入れ子\n\nながい段落。${'行の切れ目に余白を入れるための長い段落で、式 $a_n = n^2$ もまじる。'.repeat(9)}\n\n## 中ほど\n\n${filler(30, '中ほど')}\n\n## おわり\n\n${filler(30, 'おわり')}\n`;
const SHORT = '# 短い章\n\n一つだけの段落。\n';

(async () => {
  const b = await chromium.launch();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-more-'));
  fs.writeFileSync(path.join(dir, 'more.md'), MD); fs.writeFileSync(path.join(dir, 'short.md'), SHORT);
  const errs = [];
  const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1, hasTouch: true });
  await ctx.route('https://www.googleapis.com/**', drv.route);
  await ctx.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: GIS }));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404|401|ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(m.text()) && errs.push(m.text()));
  await p.goto('http://localhost:8785/');
  await p.evaluate((kv) => { for (const k in kv) localStorage.setItem(k, kv[k]); }, connected()); await p.reload();
  await p.waitForTimeout(400);
  const wait = async (fn, ms = 15000) => { for (let t = 0; t < ms && !await fn(); t += 200) await new Promise((r) => setTimeout(r, 200)); return fn(); };
  const title = (t) => p.waitForFunction((t) => document.getElementById('chap-t').textContent.includes(t), t, { timeout: 20000 });
  await p.setInputFiles('#empty .open-file', ['more.md', 'short.md'].map((n) => path.join(dir, n)));
  await title('細かい所'); await p.waitForTimeout(800);

  // ---- いま.md に元の md ----
  await p.evaluate(() => document.querySelector('#doc ul').scrollIntoView({ block: 'center' }));
  await p.mouse.wheel(0, 10);
  const now = () => (byPath('Ink Reader/いま.md') ? byPath('Ink Reader/いま.md').content.toString() : '');
  await wait(() => /- 項目 1/.test(now()), 15000);
  const t = now();
  check('いま.md の本文は元の md（リスト・強調・リンク）', /- 項目 1 と \*\*強調\*\*\n- 項目 2 と \[次の章へ\]\(short\.md\)\n {2}- 入れ子/.test(t), t.split('## 画面に見えている所')[1]);
  check('数式は TeX のまま', /\$f\(x\)=x\^2\$/.test(t));

  // ---- 章の中の位置 ----
  const pg = () => p.evaluate(() => { const g = document.getElementById('pgno'); return { hidden: g.hidden, t: document.getElementById('pg-c').textContent, md: g.classList.contains('md') }; });
  await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(300);
  const g0 = await pg();
  await p.evaluate(() => { const h = [...document.querySelectorAll('#doc h2')].find((x) => x.textContent === '中ほど'); scrollTo(0, h.getBoundingClientRect().top + scrollY - 200); }); await p.waitForTimeout(300);
  const g1 = await pg();
  check('右下に章の中の位置（%）', !g0.hidden && g0.md && /^\d+%$/.test(g0.t) && /^\d+%$/.test(g1.t) && parseInt(g1.t) > parseInt(g0.t), [g0, g1]);
  await p.click('#pgno'); await p.waitForTimeout(400);
  const here = await p.evaluate(() => { const h = document.querySelector('#toc-list .here'); const r = h && h.getBoundingClientRect(), d = document.getElementById('toc').getBoundingClientRect(); return h && { t: h.textContent, seen: r.top >= d.top && r.bottom <= d.bottom, open: document.getElementById('toc').open }; });
  check('押すと目次を開き、今いる見出しを見せる', here && here.open && here.t === '中ほど' && here.seen, here);
  await p.screenshot({ path: path.join(OUT, 'more-toc.png') });
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  await p.click('#next2'); await title('短い章'); await p.waitForTimeout(500);
  check('短い章では出さない', (await pg()).hidden);
  await p.click('#prev2'); await title('細かい所'); await p.waitForTimeout(800);

  // ---- 答えと、下にはみ出した線 ----
  const k = await p.evaluate(() => { const el = [...document.querySelectorAll('#doc > p')].find((x) => x.textContent.startsWith('はじめの段落 3。')); el.scrollIntoView({ block: 'center' }); return [...document.getElementById('doc').children].indexOf(el); });
  await p.waitForTimeout(300);
  const r = await p.evaluate((k) => { const el = document.getElementById('doc').children[k], n = document.getElementById('doc').children[k + 1], a = el.getBoundingClientRect(); return { l: a.left, bot: a.bottom, next: n.getBoundingClientRect().top }; }, k);
  // 段落の下の隙間から書き始め、下へ 40px はみ出す線
  const y0 = r.bot + Math.max(2, (r.next - r.bot) / 2);
  await p.mouse.move(r.l + 40, y0); await p.mouse.down(); for (let i = 1; i <= 16; i++) await p.mouse.move(r.l + 40 + i * 8, y0 + i * 2.5); await p.mouse.up();
  await p.waitForTimeout(300);
  const root = () => Object.keys(files).find((x) => files[x].name === 'Ink Reader' && files[x].mimeType === FOLDER);
  const bdir = await wait(() => Object.values(files).filter((x) => x.mimeType === FOLDER && !x.trashed && (x.parents || []).includes(root())).map((x) => x.name).find((x) => x.startsWith('細かい所')));
  await wait(() => byPath(`Ink Reader/${bdir}/answers`));
  drv.add(`Ink Reader/${bdir}/answers`, `c1-qq1111.md`, `<!-- ink-answer id=qq1111 b=${k} -->\n> 質問: ここは？\n\n答えです。\n`);
  await p.reload(); await title('細かい所'); await p.waitForTimeout(500);
  await p.waitForSelector(`#qs .qm[data-b="${k}"]`, { timeout: 15000 });
  await p.evaluate((k) => document.querySelector(`#qs .qm[data-b="${k}"]`).scrollIntoView({ block: 'center' }), k);
  await p.click(`#qs .qm[data-b="${k}"]`); await p.waitForTimeout(500);
  const ov = await p.evaluate((k) => {
    const box = document.querySelector('#doc .ans'), el = document.getElementById('doc').children[k];
    const ink = [...document.querySelectorAll('#ink path')].map((x) => x.getBoundingClientRect()).filter((q) => q.width > 50).sort((a, b) => b.bottom - a.bottom)[0];
    return box && ink && { box: box.getBoundingClientRect().top, ink: ink.bottom, blk: el.getBoundingClientRect().bottom };
  }, k);
  check('下にはみ出した線に答えが重ならない', ov && ov.box >= ov.ink, ov);
  await p.screenshot({ path: path.join(OUT, 'more-answer.png') });

  // ---- 段落の途中の余白（位置は紙の px。答えの窓は閉じておく（#doc の子要素が増えるので）） ----
  await p.reload(); await title('細かい所'); await p.waitForTimeout(800);
  const K = await p.evaluate(() => document.getElementById('page').getBoundingClientRect().width / 680);
  const kids = (k) => `document.getElementById('doc').children[${k}]`;
  // 行ごとの字（数式の外）と、段落の上端からの行の上端
  const rows = (k) => p.evaluate((k) => {
    const el = document.getElementById('doc').children[k], out = [], rg = document.createRange(), top = el.getBoundingClientRect().top, K = document.getElementById('page').getBoundingClientRect().width / 680;
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n; (n = tw.nextNode());) {
      if (n.parentElement.closest('.katex')) continue;
      for (let i = 0; i < n.data.length; i++) {
        if (!n.data[i].trim()) continue;
        rg.setStart(n, i); rg.setEnd(n, i + 1); const r = rg.getClientRects()[0]; if (!r) continue;
        const y = Math.round((r.top - top) / K), last = out[out.length - 1];
        if (last && Math.abs(last.y - y) < 8) last.t += n.data[i]; else out.push({ y, t: n.data[i] });
      }
    }
    return out;
  }, k);
  const rect = (js) => p.evaluate((js) => { const r = eval(js).getBoundingClientRect(); return { top: r.top, left: r.left, bottom: r.bottom }; }, js);
  const inkTops = () => p.evaluate(() => { const K = document.getElementById('page').getBoundingClientRect().width / 680; return [...document.querySelectorAll('#ink path:not(.lasso)')].map((e) => e.style.display === 'none' ? 'hid' : Math.round(e.getBoundingClientRect().top / K)); });
  const pen = async (x, y) => { await p.click('#t-pen'); await p.mouse.move(x, y); await p.mouse.down(); for (let i = 1; i <= 15; i++) await p.mouse.move(x + i * 8, y + (i % 2) * 2); await p.mouse.up(); await p.waitForTimeout(300); };
  const hline = async (y) => { await p.click('#t-ls'); await p.mouse.move(120, y); await p.mouse.down(); for (let i = 1; i <= 20; i++) await p.mouse.move(120 + 25 * i, y + (i % 3) - 1); await p.mouse.up(); await p.waitForTimeout(400); };
  const savedSp = () => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('ink-reader', 1); r.onsuccess = () => { const s = r.result.transaction('kv').objectStore('kv'); const q = s.getAllKeys(); q.onsuccess = () => { const k = q.result.filter((x) => /^ink:local:.*:c1$/.test(x)).pop(); const g = s.get(k); g.onsuccess = () => res(Object.fromEntries(Object.values(g.result.blocks).filter((x) => x.sp || x.gap).map((x) => [x.b, { sp: x.sp, gap: x.gap, n: Object.keys(x.strokes).length }]))); }; }; }));
  const L = await p.evaluate(() => { const el = [...document.querySelectorAll('#doc > p')].find((x) => x.textContent.startsWith('ながい段落')); el.scrollIntoView({ block: 'center' }); return [...document.getElementById('doc').children].indexOf(el); });
  await p.waitForTimeout(300);
  const r0 = await rows(L), t0 = await rect(kids(L)), n0 = await rect(kids(L + 1));
  // 最後の行に線を書いておく（余白より下なので、一緒に下がる）
  await pen(t0.left + 60, t0.top + (r0[r0.length - 1].y + 10) * K);
  const i0 = await inkTops();
  await hline(t0.top + (r0[3].y - 4) * K);
  const st = await p.textContent('#stat');
  const r1 = await rows(L), t1 = await rect(kids(L)), n1 = await rect(kids(L + 1)), i1 = await inkTops();
  const ms = await p.evaluate((k) => [...document.getElementById('doc').children[k].querySelectorAll('.msp')].map((x) => x.offsetHeight), L);
  console.log('rows', r0.length, r0.map((x) => x.y).join(), '->', r1.map((x) => x.y).join(), 'msp', ms, st);
  check('段落の途中に余白が入る（行の切れ目に 1 つ）', /余白を入れました/.test(st) && ms.length === 1 && ms[0] === 200, [st, ms]);
  check('字の折り返しは変わらない', r0.length > 6 && r1.map((x) => x.t).join('|') === r0.map((x) => x.t).join('|'));
  check('余白より上の行はそのまま・下の行は余白の高さだけ下がる', r1[2].y === r0[2].y && Math.abs(r1[3].y - r0[3].y - 200) < 1.5 && Math.abs(r1[r1.length - 1].y - r0[r0.length - 1].y - 200) < 1.5 && Math.abs(t1.top - t0.top) < 1, [r0.slice(2, 4), r1.slice(2, 4)]);
  check('次の段落も余白の高さだけ下がる', Math.abs((n1.top - n0.top) / K - 200) < 1.5, [n0.top, n1.top]);
  check('下の行に書いた線も一緒に下がる', i1.length === i0.length && Math.abs(i1[i1.length - 1] - i0[i0.length - 1] - 200) < 1.5, [i0, i1]);
  // 余白に書く
  const m = await rect(`${kids(L)}.querySelector('.msp')`);
  await pen(t0.left + 80, m.top + 80);
  const sv = await savedSp();
  console.log('saved', JSON.stringify(sv));
  check('余白と、そこに書いた線を覚える（sp）', sv[L] && sv[L].sp && sv[L].sp.length === 1 && sv[L].sp[0][1] === 200 && sv[L].n === 2, sv[L]);
  await p.screenshot({ path: path.join(OUT, 'more-space.png') });
  // つまみを押すとたたむ
  const hd = async (fold) => p.evaluate((f) => { const k = document.querySelector('#sps .sph' + (f ? '.fold' : ':not(.fold)')); if (!k) return null; const r = k.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, fold);
  const tap = async (q) => { await p.mouse.move(q[0], q[1]); await p.mouse.down(); await p.mouse.up(); await p.waitForTimeout(300); };
  await tap(await hd(false));
  const n2 = await rect(kids(L + 1)), i2 = await inkTops(), ms2 = await p.evaluate((k) => [...document.getElementById('doc').children[k].querySelectorAll('.msp')].map((x) => x.offsetHeight), L);
  check('たたむと細くなり、中の線は隠れる', ms2[0] === 28 && Math.abs((n2.top - n0.top) / K - 28) < 1.5 && i2.includes('hid'), [ms2, n2.top - n0.top, i2]);
  await p.screenshot({ path: path.join(OUT, 'more-space-fold.png') });
  // 開き直しても同じ行の切れ目
  await p.reload(); await title('細かい所'); await p.waitForTimeout(1200);
  await p.evaluate((k) => document.getElementById('doc').children[k].scrollIntoView({ block: 'center' }), L); await p.waitForTimeout(300);
  const r3 = await rows(L), ms3 = await p.evaluate((k) => [...document.getElementById('doc').children[k].querySelectorAll('.msp')].map((x) => x.offsetHeight), L);
  check('開き直しても同じ行の切れ目に、たたんだまま', ms3.length === 1 && ms3[0] === 28 && r3[2].y === r0[2].y && Math.abs(r3[3].y - r0[3].y - 28) < 1.5 && r3.map((x) => x.t).join('|') === r0.map((x) => x.t).join('|'), [ms3, r3.slice(2, 4)]);
  await tap(await hd(true));
  const r4 = await rows(L), i4 = await inkTops(), m4 = await rect(`${kids(L)}.querySelector('.msp')`), t4 = await rect(kids(L));
  const inSp = await p.evaluate(([a, z]) => [...document.querySelectorAll('#ink path:not(.lasso)')].some((e) => { const r = e.getBoundingClientRect(); return e.style.display !== 'none' && r.top > a && r.bottom < z; }), [m4.top, m4.bottom]);
  check('開くと元の高さで、余白に書いた線は余白の中', Math.abs(r4[3].y - r0[3].y - 200) < 1.5 && !i4.includes('hid') && inSp, [r4[3].y - r0[3].y, i4]);

  // ---- 最初の段落の上の余白 ----
  await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(300);
  const h0 = await rect(kids(1)), s0 = await p.evaluate(() => document.getElementById('doc').children[0].offsetHeight);
  const hy = await p.evaluate(() => { const el = document.getElementById('doc').children[1], r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().top; });
  await hline(h0.top + (h0.bottom - h0.top) / 4);
  const st2 = await p.textContent('#stat');
  const hy2 = await p.evaluate(() => { const el = document.getElementById('doc').children[1], r = document.createRange(); r.selectNodeContents(el); return [...r.getClientRects()].filter((q) => q.height).pop().top; });
  const f1 = await p.evaluate(() => { const el = document.getElementById('doc').children[1]; return el.firstChild && el.firstChild.className; });
  const sv2 = await savedSp();
  check('最初の段落の上に余白（段落の頭に入る）', /余白を入れました/.test(st2) && f1 === 'msp' && Math.abs((hy2 - hy) / K - 200) < 1.5 && sv2[1] && sv2[1].sp && sv2[1].sp[0][0] === 0, [st2, f1, hy2 - hy, sv2[1]]);
  check('出典の行には付けない', !sv2[0] && await p.evaluate(() => document.getElementById('doc').children[0].offsetHeight) === s0);
  await p.screenshot({ path: path.join(OUT, 'more-space-top.png') });
  check('エラーなし', !errs.length, errs);
  await b.close(); srv.close(); process.exit(ok ? 0 : 1);
})();
