// Copyright (C) 2026 syakaikungg. All rights reserved.
// md の本の書き出し（書き込みつき PDF）。app.js が書き出すときだけ読み込む（ふだんは重くしない）。
// 章の HTML を画面と同じ CSS で見えない所に並べ、文字の位置（Range の矩形）をそのまま PDF に写す。
// - 文字は字体を埋め込んで文字のまま（選べる・探せる）。日本語は Noto Serif JP、英数字は Source Serif 4、数式は KaTeX の字体。字体にない字は画面の字を絵にする
// - 分数の線などの罫線・背景は四角、根号などの SVG と図は絵、本の図（img）はその画像
// - 書き込みは export.js と同じ輪郭（書き込み JSON から作る）を線のまま重ねる。余白（gap）はたたんでいても開いて出す（方眼 gr なら方眼も）
// - 紙に貼った画像は、画面と同じく本文の上・線の下に入れる
// - ページは A4（紙の幅 680px を 595pt に）。段落の切れ目（長い段落は行の切れ目）で分け、章ごとに新しいページから始める
import { readInk, mul, INK, HL } from './export.js';

const W = 680, PW = 595.28, PH = 841.89, K = PW / W, PAGE = PH / K;   // 紙の幅（px）、A4（pt）、px -> pt、1ページの紙の高さ（px）
const MT = 40, MB = 44;   // ページの上下の余白（紙の px）。章の最初のページの上は、#doc の上の余白があるので足さない
const FONTS = { jp: 'vendor/fonts/pdf/NotoSerifJP-Regular.ttf', ss: 'vendor/fonts/pdf/SourceSerif4-Regular.ttf',
  ssb: 'vendor/fonts/pdf/SourceSerif4-Semibold.ttf', ssi: 'vendor/fonts/pdf/SourceSerif4-Italic.ttf' };
const KATEX = new Set(['AMS-Regular', 'Caligraphic-Bold', 'Caligraphic-Regular', 'Fraktur-Bold', 'Fraktur-Regular', 'Main-Bold', 'Main-BoldItalic',
  'Main-Italic', 'Main-Regular', 'Math-BoldItalic', 'Math-Italic', 'SansSerif-Bold', 'SansSerif-Italic', 'SansSerif-Regular', 'Script-Regular',
  'Size1-Regular', 'Size2-Regular', 'Size3-Regular', 'Size4-Regular', 'Typewriter-Regular'].map((n) => 'KaTeX_' + n));
const tick = () => new Promise((r) => setTimeout(r));

// 画面と同じ CSS で、見えない所（画面の外）に紙を1枚作る。色は明るい画面のもの
async function makeSheet() {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:-20000px;top:0;width:680px;pointer-events:none;contain:layout style';
  const root = box.attachShadow({ mode: 'open' }), wait = [];
  for (const s of document.querySelectorAll('style, link[rel="stylesheet"]')) {
    const c = s.cloneNode(true);
    if (c.localName === 'link') wait.push(new Promise((ok) => { c.onload = c.onerror = ok; }));   // KaTeX の CSS。読み終えてから並べる
    root.append(c);
  }
  let light = '';
  for (const sh of document.styleSheets) {
    let rules; try { rules = sh.cssRules; } catch { continue; }
    for (const r of rules) if (r.selectorText === ':root' && r.style && r.style.getPropertyValue('--fg')) light = r.style.cssText;
  }
  const st = document.createElement('style');
  st.textContent = `:host{${light};color-scheme:light} #page{position:relative;transform:none;box-shadow:none} #doc.loading{opacity:1}`;
  const page = document.createElement('div'), doc = document.createElement('article');
  page.id = 'page'; doc.id = 'doc';
  page.append(doc); root.append(st, page);
  document.body.append(box);
  await Promise.all(wait);
  return { box, page, doc };
}

const parseColor = (s) => {
  const m = (s || '').match(/[\d.]+/g);
  if (!m || m.length < 3) return { r: 0, g: 0, b: 0, a: 1 };
  return { r: +m[0] / 255, g: +m[1] / 255, b: +m[2] / 255, a: m[3] == null ? 1 : +m[3] };
};

// 章 c を紙に並べて、PDF に描くもの（文字・四角・絵・書き込み）と、ページを分けてよい位置を集める
async function layChapter(sheet, c, { getStroke, img, pic, src }) {
  const { page, doc } = sheet;
  doc.innerHTML = '';
  const s0 = document.createElement('p'); s0.className = 'src'; s0.textContent = src;
  doc.append(s0); doc.insertAdjacentHTML('beforeend', c.html);
  const blocks = [...doc.children];
  const { ink, gaps, pics, grs } = readInk(c.blocks || {}, getStroke);
  for (const b in gaps) if (blocks[b]) blocks[b].style.paddingBottom = gaps[b] + 'px';   // 余白は開いて出す
  void doc.offsetHeight;
  if (document.fonts) await document.fonts.ready;
  if (window.renderMarkdown && renderMarkdown.fit) renderMarkdown.fit(doc);   // 長い式は画面と同じく紙の幅に縮める
  const o = page.getBoundingClientRect(), at = (q) => ({ x: q.left - o.left, y: q.top - o.top, w: q.width, h: q.height });
  const tops = blocks.map((el) => at(el.getBoundingClientRect()).y);
  const items = [], cuts = new Set();
  // 文字（1字ずつの矩形。基線は字体の上端からの高さで決める）
  const cv = document.createElement('canvas').getContext('2d'), range = document.createRange(), asc = new Map();
  const tw = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
  for (let n; (n = tw.nextNode());) {
    const el = n.parentElement;
    if (!el || el.closest('.katex-mathml, svg, style')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible') continue;
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`, size = parseFloat(cs.fontSize);
    const fam = cs.fontFamily, k0 = fam.split(',')[0].replace(/["']/g, '').trim(), bold = +cs.fontWeight >= 600, it = cs.fontStyle !== 'normal';
    const t = n.data;
    for (let i = 0; i < t.length;) {
      const cp = t.codePointAt(i), ch = String.fromCodePoint(cp), len = ch.length;
      if (!/\s/.test(ch)) {
        range.setStart(n, i); range.setEnd(n, i + len);
        const q = range.getClientRects()[0];
        if (q && q.width) {
          const a = at(q), key = font + '|' + ch;
          if (!asc.has(key)) { cv.font = font; asc.set(key, cv.measureText(ch).fontBoundingBoxAscent || size * .88); }
          let f;
          if (/^KaTeX_/.test(k0)) {
            const v = [(bold ? 'Bold' : '') + (it ? 'Italic' : ''), it ? 'Italic' : '', 'Regular'].find((x) => x && KATEX.has(k0 + '-' + x));
            f = 'k:' + (v ? k0 + '-' + v : 'KaTeX_Main-Regular');
          } else f = cp < 0x2000 && /Source Serif/.test(fam) ? (it ? 'ssi' : bold ? 'ssb' : 'ss') : 'jp';
          items.push({ t: 'ch', ch, f, x: a.x, y: a.y, h: a.h, w: a.w, base: a.y + asc.get(key), size, color: cs.color, bold: bold && f === 'jp', font });
        }
      }
      i += len;
    }
  }
  // 罫線（分数の線・見出しの線など）と背景
  for (const el of doc.querySelectorAll('*')) {
    if (el.closest('svg, .katex-mathml')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible' || cs.display === 'none') continue;
    const bg = parseColor(cs.backgroundColor), sides = [['Top'], ['Right'], ['Bottom'], ['Left']].filter(([s]) => parseFloat(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== 'none' && cs[`border${s}Style`] !== 'hidden');
    if (!(bg.a > 0) && !sides.length) continue;
    for (const q of el.getClientRects()) {
      const a = at(q);
      if (!a.w && !a.h) continue;
      if (bg.a > 0) items.push({ t: 'rect', ...a, color: cs.backgroundColor, bg: true });
      for (const [s] of sides) {
        const bw = parseFloat(cs[`border${s}Width`]);
        const r = s === 'Top' ? { x: a.x, y: a.y, w: a.w, h: bw } : s === 'Bottom' ? { x: a.x, y: a.y + a.h - bw, w: a.w, h: bw }
          : s === 'Left' ? { x: a.x, y: a.y, w: bw, h: a.h } : { x: a.x + a.w - bw, y: a.y, w: bw, h: a.h };
        items.push({ t: 'rect', ...r, color: cs[`border${s}Color`] });
      }
    }
  }
  // SVG（根号・大きな括弧などの数式の部品と、md の中の図）は絵にする。色は画面で決まったものを書き込んでおく
  for (const s of doc.querySelectorAll('svg')) {
    if (s.parentElement.closest('svg')) continue;
    const q = s.getBoundingClientRect();
    if (!q.width || !q.height) continue;
    const c2 = s.cloneNode(true), src2 = [s, ...s.querySelectorAll('*')], dst = [c2, ...c2.querySelectorAll('*')];
    src2.forEach((e, i) => {
      const cs = getComputedStyle(e);
      dst[i].setAttribute('fill', cs.fill); dst[i].setAttribute('stroke', cs.stroke);
      if (cs.opacity !== '1') dst[i].setAttribute('opacity', cs.opacity);
      if (e instanceof SVGTextElement) { dst[i].setAttribute('font-family', cs.fontFamily); dst[i].setAttribute('font-size', cs.fontSize); dst[i].setAttribute('font-style', cs.fontStyle); }
    });
    c2.setAttribute('width', q.width); c2.setAttribute('height', q.height); c2.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    c2.removeAttribute('style'); c2.removeAttribute('class');
    items.push({ t: 'svg', ...at(q), svg: new XMLSerializer().serializeToString(c2) });
  }
  // 本の図
  for (const im of doc.querySelectorAll('img[data-img]')) {
    const q = im.getBoundingClientRect();
    if (q.width && q.height) items.push({ t: 'img', ...at(q), name: im.dataset.img });
  }
  // 方眼にした余白: 段落の下の余白に、紙の 16px ごとの目を背景として引く（画面と同じく左右 8px 内側から）
  for (const b of grs) {
    if (!gaps[b] || !blocks[b]) continue;
    const q = at(blocks[b].getBoundingClientRect()), y0 = q.y + q.h - gaps[b], line = { t: 'rect', color: 'rgb(176,191,219)', bg: true };
    for (let x = 8; x <= W - 8; x += 16) items.push({ ...line, x, y: y0, w: .6, h: gaps[b] });
    for (let y = 0; y <= gaps[b]; y += 16) items.push({ ...line, x: 8, y: y0 + y, w: W - 16, h: .6 });
  }
  // 書き込み（段落の上端から）
  const onTop = (s) => { const t = tops[Math.min(s.b, tops.length - 1)] || 0; return { ...s, top: t, y0: t + s.y0, y1: t + s.y1 }; };
  const strokes = ink.map(onTop), pics2 = pics.map(onTop);
  // ページを分けてよい位置: 段落の上端と、段落の中の行の切れ目
  for (let b = 1; b < blocks.length; b++) cuts.add(tops[b] - 2);
  const lines = new Map();
  for (const it of items) if (it.t === 'ch') { const k = Math.round(it.y); const l = lines.get(k); if (!l || it.y + it.h > l) lines.set(k, it.y + it.h); }
  const ls = [...lines].sort((a, z) => a[0] - z[0]);
  for (let i = 1; i < ls.length; i++) if (ls[i][0] >= ls[i - 1][1] - .5) cuts.add((ls[i][0] + ls[i - 1][1]) / 2);
  // 絵（図・式）と書き込みの途中では分けない（分けられる所がなければ、ページの下で切る）
  const solid = items.filter((it) => it.t === 'svg' || it.t === 'img').map((it) => [it.y, it.y + it.h]).concat(strokes.concat(pics2).map((s) => [s.y0, s.y1]));
  // 章の終わり: 最後の段落の下（#doc の下の余白は入れない）か、それより下の書き込み
  const end = Math.max(at(blocks[blocks.length - 1].getBoundingClientRect()).y + blocks[blocks.length - 1].getBoundingClientRect().height + 12, ...strokes.concat(pics2).map((s) => s.y1 + 10));
  return { items, strokes, pics: pics2, cuts: [...cuts].filter((y) => !solid.some(([a, z]) => y > a && y < z)).sort((a, z) => a - z), end, img, pic };
}

// 紙の [0, end) をページに分ける。返すもの: [[a, z, 上の余白]]
function paginate(cuts, end) {
  const pages = [];
  let a = 0, top = 0;
  while (a < end - 1) {
    const room = PAGE - top - MB;
    if (end - a <= room) { pages.push([a, end, top]); break; }
    const ok = cuts.filter((y) => y > a + room * .4 && y <= a + room);
    const z = ok.length ? ok[ok.length - 1] : a + room;
    pages.push([a, z, top]);
    a = z; top = MT;
  }
  return pages;
}

async function rasterSvg(it) {
  const im = new Image();
  im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(it.svg);
  await im.decode();
  const k = Math.min(4, 4096 / Math.max(it.w, it.h)), cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.ceil(it.w * k)); cv.height = Math.max(1, Math.ceil(it.h * k));
  cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
  return new Uint8Array(await (await new Promise((ok) => cv.toBlob(ok, 'image/png'))).arrayBuffer());
}
async function rasterImg(blob, it) {
  const bm = await createImageBitmap(blob), k = Math.min(3, 3000 / Math.max(it.w, it.h)), cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(it.w * k)); cv.height = Math.max(1, Math.round(it.h * k));
  const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(bm, 0, 0, cv.width, cv.height);
  return new Uint8Array(await (await new Promise((ok) => cv.toBlob(ok, 'image/jpeg', .9))).arrayBuffer());
}
// 字体にない字は、画面の字を絵にする
async function rasterChar(it) {
  const k = 4, cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.ceil(it.w * k)); cv.height = Math.max(1, Math.ceil(it.h * k));
  const g = cv.getContext('2d'); g.scale(k, k); g.font = it.font; g.fillStyle = it.color; g.textBaseline = 'alphabetic';
  g.fillText(it.ch, 0, it.base - it.y);
  return new Uint8Array(await (await new Promise((ok) => cv.toBlob(ok, 'image/png'))).arrayBuffer());
}

// L: pdf-lib、fontkit: @pdf-lib/fontkit、chapters: [{ id, label, html, blocks（書き込み JSON の blocks） }]、title / src: 本の題名・出典の行、
// getStroke: perfect-freehand、img(name): 本の図の Blob、pic(name): 紙に貼った画像の Blob、say: 途中の知らせ。返すもの: { bytes, name, count（ページの数） }
export async function exportMd({ L, fontkit, chapters, title, src = '', all = true, getStroke, img = async () => null, pic = async () => null, say = () => {} }) {
  if (!chapters.length) throw new Error('章を選んでください');
  const pdf = await L.PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(title || 'book');
  const fonts = new Map(), sets = new Map();
  const font = (f) => {
    if (!fonts.has(f)) fonts.set(f, (async () => {
      const r = await fetch(f.startsWith('k:') ? 'vendor/fonts/pdf/' + f.slice(2) + '.ttf' : FONTS[f]);
      if (!r.ok) throw new Error('字体を読めませんでした（通信できるときに、もう一度エクスポートしてください）');
      const ft = await pdf.embedFont(new Uint8Array(await r.arrayBuffer()), { subset: true });
      sets.set(f, new Set(ft.getCharacterSet()));
      return ft;
    })());
    return fonts.get(f);
  };
  say('字体を読んでいます');
  await font('jp');
  const sheet = await makeSheet();
  const pngs = new Map(), ims = new Map();   // ims: 貼った画像の名前 -> 埋め込んだ画像
  let count = 0;
  try {
    for (const [ci, c] of chapters.entries()) {
      say(`並べています ${ci + 1} / ${chapters.length}章`);
      await tick();
      const lay = await layChapter(sheet, c, { getStroke, img, pic, src });
      // 字体を決める（字体にない字は日本語の字体、それにもなければ絵）
      for (const it of lay.items) {
        if (it.t !== 'ch') continue;
        const cp = it.ch.codePointAt(0);
        await font(it.f);
        if (!sets.get(it.f).has(cp)) it.f = sets.get('jp').has(cp) ? 'jp' : null;
      }
      for (const [a, z, top] of paginate(lay.cuts, lay.end)) {
        const P = pdf.addPage([PW, PH]);
        count++;
        const Y = (y) => PH - (y - a + top) * K;   // 紙の y（px）-> PDF の y（pt）
        const hit = (y0, y1) => y1 > a && y0 < z;
        P.pushOperators(L.pushGraphicsState(), L.rectangle(0, Y(z), PW, (z - a) * K), L.clip(), L.endPath());
        // 背景 -> マーカー -> 罫線・絵 -> 文字 -> 貼った画像 -> 画像に重なるマーカー -> ペンの線
        const box = (it) => [it.x * K, Y(it.y + it.h), it.w * K, it.h * K];
        const picsHere = lay.pics.filter((s) => hit(s.y0, s.y1)), over = (s) => picsHere.some((q) => s.y1 > q.y0 && s.y0 < q.y1);
        for (const it of lay.items) if (it.t === 'rect' && it.bg && hit(it.y, it.y + it.h)) {
          const col = parseColor(it.color), [x, y, w, h] = box(it);
          P.drawRectangle({ x, y, width: w, height: h, color: L.rgb(col.r, col.g, col.b), opacity: col.a });
        }
        let gs = null;
        const ink = (hl, ok = () => true) => {
          for (const s of lay.strokes) {
            if (s.hl !== hl || !hit(s.y0, s.y1) || !ok(s)) continue;
            if (hl && !gs) gs = P.node.newExtGState('GS', pdf.context.obj({ Type: 'ExtGState', ca: .45, BM: 'Multiply' }));
            const x = INK[s.c] || (/^#[0-9a-f]{6}$/i.test(s.c) ? s.c : INK.k), col = L.rgb(...[1, 3, 5].map((i) => parseInt((hl ? HL : x).slice(i, i + 2), 16) / 255));
            // 線の輪郭は紙の px（段落の上端から）。drawSvgPath は上下を返して描くので、先に返しておく
            P.pushOperators(L.pushGraphicsState(), L.concatTransformationMatrix(K, 0, 0, K, 0, Y(s.top)),
              ...L.drawSvgPath(s.d, { x: 0, y: 0, color: col, graphicsState: hl ? gs : undefined }), L.popGraphicsState());
          }
        };
        ink(true, (s) => !over(s));
        for (const it of lay.items) {
          if (!hit(it.y, it.y + it.h)) continue;
          if (it.t === 'rect' && !it.bg) {
            const col = parseColor(it.color), [x, y, w, h] = box(it);
            P.drawRectangle({ x, y, width: w, height: Math.max(h, .3), color: L.rgb(col.r, col.g, col.b), opacity: col.a });
          } else if (it.t === 'svg' || it.t === 'img' || (it.t === 'ch' && !it.f)) {
            const key = it.t === 'svg' ? it.svg : it.t === 'img' ? 'img:' + it.name : 'ch:' + it.font + it.color + it.ch;
            if (!pngs.has(key)) {
              let e = null;
              try {
                if (it.t === 'svg') e = await pdf.embedPng(await rasterSvg(it));
                else if (it.t === 'img') { const bl = await lay.img(it.name); if (bl) e = await pdf.embedJpg(await rasterImg(bl, it)); }
                else e = await pdf.embedPng(await rasterChar(it));
              } catch {}
              pngs.set(key, e);
            }
            const e = pngs.get(key);
            if (e) { const [x, y, w, h] = box(it); P.drawImage(e, { x, y, width: w, height: h }); }
          }
        }
        // 文字: 同じ行・同じ字体の続きは1つにまとめ、1字ずつの位置は TJ の間隔で合わせる（PDF から文字を取り出したときに語がつながる）
        const chs = lay.items.filter((it) => it.t === 'ch' && it.f && hit(it.y, it.y + it.h));
        for (let i = 0; i < chs.length;) {
          const h0 = chs[i], ft = await font(h0.f), pt = h0.size * K;
          let j = i + 1;
          while (j < chs.length && chs[j].f === h0.f && chs[j].size === h0.size && chs[j].color === h0.color && chs[j].bold === h0.bold
            && Math.abs(chs[j].base - h0.base) < .5 && chs[j].x > chs[j - 1].x) j++;
          const arr = [];
          for (let m = i; m < j; m++) {
            arr.push(ft.encodeText(chs[m].ch));
            if (m + 1 < j) {
              const adv = ft.widthOfTextAtSize(chs[m].ch, pt), want = (chs[m + 1].x - chs[m].x) * K;
              const d = Math.round((adv - want) * 1000 / pt * 10) / 10;
              if (d) arr.push(d);
            }
          }
          const col = parseColor(h0.color), name = P.node.newFontDictionary(ft.name, ft.ref);
          P.pushOperators(L.beginText(), L.setFontAndSize(name, pt), L.setFillingRgbColor(col.r, col.g, col.b),
            // 太字は輪郭も塗って太らせる（描き方は BT〜ET の外にも残るので、毎回決める）
            L.setTextRenderingMode(h0.bold ? L.TextRenderingMode.FillAndOutline : L.TextRenderingMode.Fill),
            ...(h0.bold ? [L.setStrokingRgbColor(col.r, col.g, col.b), L.setLineWidth(pt * .03)] : []),
            L.setTextMatrix(1, 0, 0, 1, h0.x * K, Y(h0.base)), L.PDFOperator.of(L.PDFOperatorNames.ShowTextAdjusted, [pdf.context.obj(arr)]), L.endText());
          i = j;
        }
        for (const s of picsHere) {
          if (!ims.has(s.f)) ims.set(s.f, (async () => { const bl = await lay.pic(s.f), d = bl && new Uint8Array(await bl.arrayBuffer()); return d ? d[0] === 0x89 ? pdf.embedPng(d) : pdf.embedJpg(d) : null; })().catch(() => null));
          const im = await ims.get(s.f);
          if (!im) continue;
          // 画像の (0, 0)〜(1, 1)（左下が原点）を、紙の上の四隅（左下・右下・左上）に合わせる
          const [p0, p1, p3] = s.p;
          P.pushOperators(L.pushGraphicsState(), L.concatTransformationMatrix(...mul([p1[0] - p0[0], p1[1] - p0[1], p0[0] - p3[0], p0[1] - p3[1], p3[0], p3[1]], [K, 0, 0, -K, 0, Y(s.top)])),
            L.drawObject(P.node.newXObject('Im', im.ref)), L.popGraphicsState());
        }
        ink(true, over);
        ink(false);
        P.pushOperators(L.popGraphicsState());
        if (count % 5 === 0) { say(`作っています ${count}ページ`); await tick(); }
      }
    }
  } finally { sheet.box.remove(); }
  say('まとめています');
  await tick();
  const bytes = await pdf.save();
  const one = chapters.length === 1 ? chapters[0].label : `${chapters[0].label} ほか${chapters.length - 1}章`;
  const name = `${(title || 'book').replace(/[\\/:*?"<>|]/g, '_')}（書き込み${all ? '' : ' ' + one.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)}）.pdf`;
  return { bytes, name, count };
}
