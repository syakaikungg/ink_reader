// md の本文の字体（Playwright）。GitHub もドライブも使わない
// 使い方: node tests/font.cjs [スクリーンショットの出力先]
// 確認すること: md の本文の日本語は、アプリに入れた Noto Serif JP で描く（端末の明朝に頼らない）→ 英数字は Source Serif 4
// → アプリに入れた字にない字だけ端末の字 → 見出しも同じ字 → 字体はアプリと一緒に先にキャッシュする（sw.js）
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const APP = path.resolve(__dirname, '..'), OUT = process.argv[2] || os.tmpdir();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP, u === '/' ? 'index.html' : u); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); }); }).listen(8787);
let ok = true;
const check = (name, v, info) => { console.log(v ? '✓' : '✗', name, info === undefined ? '' : typeof info === 'string' ? info : JSON.stringify(info)); if (!v) ok = false; };
const MD = '# 字体の章\n\n本文の段落です。漢字とかな、カタカナ、「かぎ括弧」と句読点。\n\nLatin letters only here.\n\n中国語の们と这\n';

(async () => {
  const b = await chromium.launch();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-font-'));
  fs.writeFileSync(path.join(dir, 'font.md'), MD);
  const errs = [];
  const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1, hasTouch: true });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/404|ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(m.text()) && errs.push(m.text()));
  await p.goto('http://localhost:8787/'); await p.waitForTimeout(400);
  await p.setInputFiles('#empty .open-file', path.join(dir, 'font.md'));
  await p.waitForFunction(() => document.getElementById('chap-t').textContent.includes('字体の章') && !document.querySelector('#doc.loading'), null, { timeout: 20000 });
  await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(300);
  // 実際に描くのに使った字体（CDP の CSS.getPlatformFontsForNode。子の文字ごとの字体と字の数）
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const fontsOf = async (sel) => { const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel }); return (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts; };
  const jp = await fontsOf('#doc > p:nth-of-type(2)'), en = await fontsOf('#doc > p:nth-of-type(3)'), rare = await fontsOf('#doc > p:nth-of-type(4)'), h1 = await fontsOf('#doc > h1');
  console.log('jp', jp, 'en', en, 'rare', rare, 'h1', h1);
  check('本文の日本語はアプリに入れた Noto Serif JP', jp.length === 1 && jp[0].familyName === 'Noto Serif JP' && jp[0].isCustomFont, jp);
  check('英数字は Source Serif 4', en.every((f) => /Source Serif 4/.test(f.familyName) && f.isCustomFont), en);
  check('アプリに入れた字にない字（们・这）だけ端末の字', rare.some((f) => f.familyName === 'Noto Serif JP' && f.isCustomFont) && rare.some((f) => !f.isCustomFont), rare);
  check('見出しも同じ字', h1.some((f) => f.familyName === 'Noto Serif JP' && f.isCustomFont), h1);
  const sw = fs.readFileSync(path.join(APP, 'sw.js'), 'utf8'), woff = path.join(APP, 'vendor/fonts/NotoSerifJP-cp932.woff2');
  check('字体はアプリと一緒に先にキャッシュする', sw.includes("'vendor/fonts/NotoSerifJP-cp932.woff2'") && fs.existsSync(woff) && fs.statSync(woff).size < 1.6e6, fs.existsSync(woff) && fs.statSync(woff).size);
  await p.screenshot({ path: path.join(OUT, 'font.png') });
  check('エラーなし', !errs.length, errs);
  await b.close(); srv.close(); process.exit(ok ? 0 : 1);
})();
