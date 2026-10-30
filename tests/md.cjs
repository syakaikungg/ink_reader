// md のいろいろな書き方の確認（Playwright）。GitHub とドライブは使わない
// 使い方: node tests/md.cjs [スクリーンショットの出力先]
// 確認すること: md の中の HTML の動く部分は除く（Claude の答えも）→ コードの中の $・\( \)・\[ \]・前書き・脚注・==印==・囲み・[[章]] → 段落の分け方は前の版と同じ
// → リンクを指で押すと見出し・脚注・ほかの章・外のサイトへ（マウス（ペンと同じ）では動かない）→ 長い式は紙の幅に縮む
// → 区切り線・表に余白を入れても枠が伸びない → details はいつも開く → Shift_JIS の md も読める
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const APP = path.resolve(__dirname, '..'), OUT = process.argv[2] || os.tmpdir();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8781);
let ok = true;
const check = (name, v, info) => { console.log(v ? '✓' : '✗', name, info === undefined ? '' : typeof info === 'string' ? info : JSON.stringify(info)); if (!v) ok = false; };

// 動いてはいけない書き方（どれかが動くと window.__x が立つ）
const XSS = [
  '<img src="x" onerror="window.__x=1">',
  '<svg><script>window.__x=1</script></svg>',
  '<svg onload="window.__x=1"><circle r="3"/></svg>',
  '<a href="javascript:window.__x=1">押す</a>',
  '<a href="  JaVaScRiPt:window.__x=1">押す</a>',
  '<a href="java&#x09;script:window.__x=1">押す</a>',
  '<iframe src="javascript:window.__x=1"></iframe>',
  '<iframe srcdoc="<script>parent.__x=1</script>"></iframe>',
  '<object data="javascript:window.__x=1"></object>',
  '<embed src="javascript:window.__x=1">',
  '<svg></p><style><a id="</style><img src=1 onerror=window.__x=1>">',
  '<noscript><p title="</noscript><img src=x onerror=window.__x=1>">',
  '<form><button formaction="javascript:window.__x=1">押す</button></form>',
  '<details open ontoggle="window.__x=1">開く</details>',
  '<div style="position:fixed;inset:0;background:url(javascript:window.__x=1)">覆う</div>',
  '<input autofocus onfocus="window.__x=1">',
  '<video><source onerror="window.__x=1"></video>',
  '<svg><animate onbegin="window.__x=1" attributeName="x" dur="1s"/></svg>',
  '<svg><a xlink:href="javascript:window.__x=1"><text y="20">押す</text></a></svg>',
  '<style>@import "x"; body{display:none}</style>',
  '<base href="javascript:/">',
  '<meta http-equiv="refresh" content="0;url=javascript:window.__x=1">',
  '<img src="x" alt="$\\text{ onerror=window.__x=1 }$">',
  '[押す](javascript:window.__x=1)',
  '![x](x" onerror="window.__x=1)',
  '<p id="doc">id がアプリとぶつかる</p>',
  'おわり。',
  '<math><mtext><table><mglyph><style><img src=x onerror="window.__x=1">',   // 閉じていない math はあとを全部のみこむ（前の版も同じ）。最後に置く
].join('\n\n');

const VARIETY = `---
title: 前書きの題名
tags: [test]
---

# いろいろな md

コード \`echo $HOME と $PATH\` と \\$100 の値段。

| 記号 | 意味 |
|---|:---:|
| $\\alpha$ | 角度 |

\`\`\`bash
echo "$HOME and $PATH"
\`\`\`

\`\`\`python
def very_long_function_name_that_overflows_the_paper(argument_one, argument_two, argument_three, argument_four):
    return 1
\`\`\`

> これは引用です。

---

## 表のつづき

[見出しへ](#表のつづき) と [脚注の先へ](#脚注) と [二章へ](ch2.md) と [[ch2|二章の見出しへ]] と [外のサイト](https://example.com/x)。

\\[ \\int_0^1 x^2\\,dx = \\frac{1}{3} \\]

インラインの \\( e^{i\\pi} + 1 = 0 \\) と ==大事な所== と 文中の \\[1\\] は角かっこ。

> [!warning] 気をつける
> 囲みの本文。

$$
f(x) = a_0 + a_1 x + a_2 x^2 + a_3 x^3 + a_4 x^4 + a_5 x^5 + a_6 x^6 + a_7 x^7 + a_8 x^8 + a_9 x^9 + a_{10} x^{10} + a_{11} x^{11} + a_{12} x^{12}
$$

## 脚注

本文に脚注[^a]があります。

[^a]: これが脚注です。$x^2$ と \`code\`。

<details><summary>答えを見る</summary>

隠した答え。

</details>

${[...Array(30)].map((_, i) => `うしろの段落 ${i + 1}。`).join('\n\n')}
`;

(async () => {
  const b = await chromium.launch();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-md-'));
  fs.writeFileSync(path.join(dir, 'xss.md'), '# 危ない md\n\n' + XSS);
  fs.writeFileSync(path.join(dir, 'ch1.md'), VARIETY);
  fs.writeFileSync(path.join(dir, 'ch2.md'), '# 二章の見出し\n\n二章の本文。\n\n[一章へ戻る](./ch1.md#脚注)');
  fs.writeFileSync(path.join(dir, 'sjis.md'), Buffer.from(require('child_process').execSync(`python3 -c "import sys; sys.stdout.buffer.write('# シフトJISの題名\\n\\n本文です。'.encode('shift_jis'))"`)));

  const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404|ERR_|Refused|refused/.test(m.text()) && errs.push(m.text()));
  await p.addInitScript(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
  await p.goto('http://localhost:8781/'); await p.waitForTimeout(300);

  // 1. 危ない md
  await p.setInputFiles('#empty .open-file', path.join(dir, 'xss.md'));
  await p.waitForFunction(() => document.getElementById('chap-t').textContent.includes('危ない'));
  await p.waitForTimeout(1200);
  const x = await p.evaluate(() => {
    const d = document.getElementById('doc'), all = [...d.querySelectorAll('*')];
    return {
      ran: !!window.__x,
      on: all.filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name))).map((e) => e.outerHTML.slice(0, 80)),
      js: all.filter((e) => [...e.attributes].some((a) => /script:/i.test(a.value.replace(/\s/g, '')))).map((e) => e.outerHTML.slice(0, 80)),
      bad: all.filter((e) => /^(script|style|iframe|object|embed|form|button|base|meta|video|source|math|noscript)$/i.test(e.localName)).map((e) => e.localName),
      fixed: all.filter((e) => getComputedStyle(e).position === 'fixed').length,
      ids: all.filter((e) => e.id).map((e) => e.id),
      docs: document.querySelectorAll('#doc').length,
      title: document.title, end: d.textContent.includes('おわり'),
    };
  });
  check('危ない HTML が動かない', !x.ran && x.title === document_title(x.title), x.title);
  check('on〜 の属性がない', !x.on.length, x.on);
  check('javascript: のリンクがない', !x.js.length, x.js);
  check('script・iframe などがない', !x.bad.length, x.bad);
  check('画面に重ねる指定がない', !x.fixed, x.fixed);
  check('md の id は md- 付き', x.docs === 1 && x.ids.every((i) => i.startsWith('md-')), x.ids);
  check('危ない所のあとも読める', x.end);
  // Claude の答えも同じ掃除
  const ans = await p.evaluate(() => { const d = document.createElement('div'); d.innerHTML = renderMarkdown('答え <img src=x onerror="window.__y=1"> [押す](javascript:alert(1))', {}); document.body.append(d); return new Promise((ok) => setTimeout(() => ok({ ran: !!window.__y, html: d.innerHTML }), 300)); });
  check('答えの HTML も動かない', !ans.ran && !/onerror|javascript/i.test(ans.html), ans.html);

  // 2. いろいろな書き方（2 章の本）
  await p.click('#books'); await p.waitForTimeout(300);
  await p.setInputFiles('#shelf .open-file', [path.join(dir, 'ch1.md'), path.join(dir, 'ch2.md')]);
  await p.waitForFunction(() => document.getElementById('chap-t').textContent.includes('前書き'));
  await p.waitForTimeout(1500);
  const v = await p.evaluate(() => {
    const d = document.getElementById('doc'), q = (s) => d.querySelector(s);
    const ks = [...d.querySelectorAll('.katex-display')];
    return {
      chap: document.getElementById('chap-t').textContent,
      fm: d.textContent.includes('tags:'),
      code: q('pre code') && q('pre code').textContent, inline: q('p code') && q('p code').textContent,
      dollar: d.textContent.includes('$100'),
      paren: !!q('.katex[data-tex^="e^{i"]'), bracket: !!q('#doc > .katex-display .katex[data-tex^="\\\\int"]'), plain: d.textContent.includes('文中の [1] は角かっこ'),
      mark: q('mark') && q('mark').textContent,
      callout: q('.callout.c-warning .ct') && q('.callout.c-warning .ct').textContent,
      fn: q('sup.fnref a') && q('sup.fnref a').getAttribute('href'), fnText: q('.footnotes li') && q('.footnotes li').textContent, fnMath: !!q('.footnotes .katex'),
      wiki: q('a.wiki') && q('a.wiki').getAttribute('href'),
      details: q('details') && q('details').open,
      align: q('td[align="center"]') && getComputedStyle(q('td[align="center"]')).textAlign,
      fit: ks.map((k) => [k.scrollWidth, k.clientWidth, k.style.fontSize]),
      pre: [q('pre').scrollWidth, q('pre').clientWidth],
      wrapped: [...d.children].filter((e) => e.classList.contains('blk')).map((e) => e.firstElementChild.tagName),
    };
  });
  check('題名は前書きの title', v.chap === '前書きの題名', v.chap);
  check('前書きは本文に出ない', !v.fm);
  check('コードの中の $ はそのまま', v.code === 'echo "$HOME and $PATH"\n' && v.inline === 'echo $HOME と $PATH', [v.code, v.inline]);
  check('\\$ はただの $', v.dollar);
  check('\\( \\) と \\[ \\] は数式（文中の \\[1\\] はそのまま）', v.paren && v.bracket && v.plain, v);
  check('==印== は印', v.mark === '大事な所', v.mark);
  check('囲み（> [!warning]）', v.callout === '気をつける', v.callout);
  check('脚注は終わりにまとまる', v.fn === '#md-fn-a' && /これが脚注です/.test(v.fnText) && v.fnMath && /code/.test(v.fnText), [v.fn, v.fnText]);
  check('[[章]] はリンク', v.wiki === 'ch2', v.wiki);
  check('details は開いている', v.details === true);
  check('表のそろえ（中央）', v.align === 'center', v.align);
  check('長い式は紙の幅に収まる', v.fit.length >= 2 && v.fit.every(([s, c]) => s <= c + 1) && v.fit.some(([, , f]) => f), v.fit);
  check('長いコードは折り返す', v.pre[0] <= v.pre[1] + 1, v.pre);
  check('表・コード・引用・区切り線は包む', ['TABLE', 'PRE', 'BLOCKQUOTE', 'HR'].every((t) => v.wrapped.includes(t)), v.wrapped);
  await p.screenshot({ path: path.join(OUT, 'md-variety.png'), fullPage: false });

  // 区切り線・表・コードに余白（段落の下の高さ）を入れても、枠や背景は伸びない
  const g = await p.evaluate(() => {
    const out = {};
    for (const t of ['hr', 'table', 'pre', 'blockquote']) {
      const w = document.querySelector(`#doc > .blk > ${t}`).parentElement, el = w.firstElementChild, h0 = el.offsetHeight, b0 = w.offsetHeight;
      w.style.paddingBottom = '320px';
      out[t] = [el.offsetHeight - h0, w.offsetHeight - b0];
      w.style.paddingBottom = '';
    }
    return out;
  });
  check('余白を入れても枠は伸びない（中の高さの差, 包みの高さの差）', Object.values(g).every(([a, z]) => a === 0 && z === 320), g);

  // 3. リンク
  const blockOf = (sel) => p.evaluate((s) => { const el = document.querySelector(s), d = document.getElementById('doc'); return [...d.children].findIndex((x) => x === el || x.contains(el)); }, sel);
  const topOf = (sel) => p.evaluate((s) => Math.round(document.querySelector(s).getBoundingClientRect().top), sel);
  const find = (s) => document.querySelector(s) || [...document.querySelectorAll('#doc a')].find((a) => a.textContent === s);
  const tap = async (sel) => { await p.evaluate(([s, f]) => { const el = eval(f)(s), r = el.getBoundingClientRect(); if (r.top < 120 || r.bottom > innerHeight - 80) scrollBy(0, r.top - 400); }, [sel, find.toString()]); await p.waitForTimeout(150); const r = await p.evaluate(([s, f]) => { const q = eval(f)(s).getBoundingClientRect(); return { x: q.left + Math.min(8, q.width / 2), y: q.top + q.height / 2 }; }, [sel, find.toString()]); await p.touchscreen.tap(r.x, r.y); await p.waitForTimeout(700); };
  const url0 = p.url();
  await tap('脚注の先へ');
  const fnH = await p.evaluate(() => { const h = [...document.querySelectorAll('#doc > h2')].find((x) => x.textContent === '脚注'); return Math.round(h.getBoundingClientRect().top); });
  check('見出しへのリンクで、その見出しへ', fnH > 40 && fnH < 200 && p.url() === url0, fnH);
  check('「戻る」の札が出る', await p.isVisible('#back'));
  await tap('sup.fnref a');
  const fnTop = await topOf('#doc > .footnotes');
  check('脚注の番号で、脚注へ（章の終わりなので下の方）', fnTop > 40 && fnTop < 1100 && await p.evaluate(() => scrollY + innerHeight >= document.documentElement.scrollHeight - 2), fnTop);
  await tap('a[href="https://example.com/x"]');
  check('外のリンクはブラウザで開く（アプリは動かない）', (await p.evaluate(() => window.__opened)).join() === 'https://example.com/x' && p.url() === url0, await p.evaluate(() => window.__opened));
  // マウス（ペンと同じく書く）で押しても動かない
  const before = await p.evaluate(() => document.getElementById('chap-t').textContent);
  await p.evaluate(() => { const r = document.querySelector('a[href="ch2.md"]').getBoundingClientRect(); if (r.top < 120 || r.bottom > innerHeight - 80) scrollBy(0, r.top - 400); });
  const r2 = await p.evaluate(() => { const q = document.querySelector('a[href="ch2.md"]').getBoundingClientRect(); return { x: q.left + 6, y: q.top + q.height / 2 }; });
  await p.mouse.click(r2.x, r2.y); await p.waitForTimeout(600);
  check('ペン（マウス）で押しても章は変わらない', await p.evaluate(() => document.getElementById('chap-t').textContent) === before && p.url() === url0);
  await tap('a[href="ch2.md"]');
  check('ファイル名のリンクで、ほかの章へ', (await p.evaluate(() => document.getElementById('chap-t').textContent)) === '二章の見出し' && p.url() === url0);
  await tap('一章へ戻る');
  const back = await p.evaluate(() => { const h = [...document.querySelectorAll('#doc > h2')].find((x) => x.textContent === '脚注'); return [document.getElementById('chap-t').textContent, h && Math.round(h.getBoundingClientRect().top)]; });
  check('ほかの章の見出しへ（ch1.md#脚注）', back[0] === '前書きの題名' && back[1] > 40 && back[1] < 200, back);
  await tap('a.wiki');
  check('[[章|名前]] で、ほかの章へ', (await p.evaluate(() => document.getElementById('chap-t').textContent)) === '二章の見出し');
  await p.click('#prev2'); await p.waitForTimeout(800);
  await tap('details summary');
  check('details は押してもたたまない', await p.evaluate(() => document.querySelector('#doc details').open));

  // 4. 書いたあとも段落の位置が変わらない（長い式を縮めたあとに置く）
  const n0 = await p.evaluate(() => document.querySelectorAll('#ink path').length);
  const at = await p.evaluate(() => { const el = [...document.querySelectorAll('#doc > p')].find((x) => x.textContent.includes('うしろの段落 3。')); el.scrollIntoView(); scrollBy(0, -300); const r = el.getBoundingClientRect(); return { x: r.left + 120, y: r.top + r.height / 2 }; });
  await p.mouse.move(at.x, at.y); await p.mouse.down(); for (let i = 1; i <= 12; i++) await p.mouse.move(at.x + i * 8, at.y + (i % 2) * 4); await p.mouse.up(); await p.waitForTimeout(400);
  check('本文に書ける', (await p.evaluate(() => document.querySelectorAll('#ink path').length)) > n0);

  // 5. Shift_JIS の md
  await p.click('#books'); await p.waitForTimeout(300);
  await p.setInputFiles('#shelf .open-file', path.join(dir, 'sjis.md'));
  await p.waitForFunction(() => document.getElementById('chap-t').textContent.includes('シフト'), null, { timeout: 5000 }).catch(() => {});
  const sj = await p.evaluate(() => [document.getElementById('chap-t').textContent, document.getElementById('doc').textContent.includes('本文です。'), document.getElementById('stat').textContent, document.getElementById('shelf').open]);
  check('Shift_JIS の md も読める', sj[0] === 'シフトJISの題名' && sj[1], sj);

  check('エラーなし', !errs.length, errs);
  await b.close(); srv.close(); process.exit(ok ? 0 : 1);
})();
function document_title(t) { return /^XSS/.test(t) ? '' : t; }
