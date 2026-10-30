// Copyright (C) 2026 syakaikungg. All rights reserved.
// 書き込みつき PDF の書き出し。アプリ（app.js が書き出すときだけ読み込む）と、クラウドの Claude（ドライブに「Ink Reader/ink_export.mjs」として置き、
// node で動かす。使い方は下の USAGE）で同じものを使う。
// 元のページはそのまま使い（文字は選べ、拡大してもぼやけない）、書き込みは画面と同じ輪郭を線のまま重ねる。
// - ページの途中の余白（sp）: そのページを縦に伸ばし、元のページを余白のところで切って並べる（view/p<ページ>.png と同じ並べ方）
// - 後ろの白紙（gap）: 直前のページと同じ大きさの別ページ。たたんだ余白も開いて出す（線の座標は余白をすべて開いたときの位置なので、そのまま描ける）
// - ページの境目をまたぐ線は、かかった紙それぞれに描く
// - 紙に貼った画像（書き込み JSON の pics）は、線より下に、画面と同じ位置・大きさ・向きで入れる
// すべて選んだときは元の PDF に手を入れて使い（目次・リンクが残る）、一部のときは選んだページだけを新しい PDF に写す
const W = 680, PAGE_GAP = 14, GRID = 16;   // app.js と同じ（紙の幅、ページの間の隙間、方眼の目）
export const INK = { k: '#15181f', r: '#d0302a', b: '#1d56d8' }, HL = '#ffd53d';   // 既定の3色（明るい画面のとき）とマーカー（export-md.js も使う）
const pageH = (sizes, n) => Math.round(W * sizes[n - 1][1] / sizes[n - 1][0]);
// 行列 [a b c d e f]（PDF の cm）。mul(m, n) は m をかけてから n をかける
export const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
const inv = ([a, b, c, d, e, f]) => { const k = a * d - b * c; return [d / k, -b / k, -c / k, a / k, (c * f - d * e) / k, (b * e - a * f) / k]; };

// 紙（ページと白紙）を、余白をすべて開いて縦に並べたときの位置（線の座標と同じ並び）: '<ページ>:<白紙の番号（0 はページそのもの）>' -> { n, i, y, h（紙の px） }
export function sheetsOf(sizes, gaps = {}, sps = {}) {
  const top0 = [], sheets = new Map();
  let Y = 0;
  for (let n = 1; n <= sizes.length; n++) {
    const ph = pageH(sizes, n), main = ph + (sps[n] || []).reduce((a, p) => a + p.h, 0), nb = Math.round((gaps[n] || 0) / (ph + PAGE_GAP));
    top0[n] = Y; sheets.set(n + ':0', { n, i: 0, y: Y, h: main });
    for (let i = 1; i <= nb; i++) sheets.set(n + ':' + i, { n, i, y: Y + main + PAGE_GAP + (i - 1) * (ph + PAGE_GAP), h: ph });
    Y += main + (gaps[n] || 0) + PAGE_GAP;
  }
  return { sheets, top0 };
}

// PDF.js の getViewport({ scale: 1 }).transform と同じもの（ページの座標 -> 画面で見る向きの、上から下への pt）。
// 見える範囲は CropBox と MediaBox の重なり、向きは Rotate（PDF.js 5.7 の Page.view / rotate / userUnit と PageViewport に合わせる）
export function viewOf(L, P) {
  const cx = P.doc.context, at = (k) => cx.lookup(P.node.getInheritableAttribute(L.PDFName.of(k)));
  const box = (k) => {
    const a = at(k);
    if (!(a instanceof L.PDFArray) || a.size() !== 4) return null;
    const v = a.asArray().map((x) => { x = cx.lookup(x); return x instanceof L.PDFNumber ? x.asNumber() : NaN; });
    if (v.some(isNaN)) return null;
    const r = [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
    return r[2] - r[0] > 0 && r[3] - r[1] > 0 ? r : null;
  };
  const media = box('MediaBox') || [0, 0, 612, 792], crop = box('CropBox') || media;
  let v = media;
  if (crop.some((x, i) => x !== media[i])) {
    const a = [Math.max(crop[0], media[0]), Math.max(crop[1], media[1]), Math.min(crop[2], media[2]), Math.min(crop[3], media[3])];
    if (a[2] - a[0] > 0 && a[3] - a[1] > 0) v = a;
  }
  const r0 = at('Rotate'), uu = cx.lookup(P.node.get(L.PDFName.of('UserUnit')));
  let rot = r0 instanceof L.PDFNumber ? r0.asNumber() : 0;
  rot = rot % 90 !== 0 ? 0 : ((rot % 360) + 360) % 360;
  const s = uu instanceof L.PDFNumber && uu.asNumber() > 0 ? uu.asNumber() : 1;
  const [a, b, c, d] = { 0: [1, 0, 0, -1], 90: [0, 1, 1, 0], 180: [-1, 0, 0, 1], 270: [0, -1, -1, 0] }[rot];
  const mx = (v[2] + v[0]) / 2, my = (v[3] + v[1]) / 2;
  const ox = a === 0 ? Math.abs(my - v[1]) * s : Math.abs(mx - v[0]) * s, oy = a === 0 ? Math.abs(mx - v[0]) * s : Math.abs(my - v[1]) * s;
  return [a * s, b * s, c * s, d * s, ox - a * s * mx - c * s * my, oy - b * s * mx - d * s * my];
}

// L: pdf-lib、pdf: 元の PDF（Uint8Array）、unlock: 鍵のかかった PDF のとき、その PDF を開いた PDF.js の文書を返す（なくてもよい）、sizes / title: 本の情報（book.json）、
// ink: 線 [{ b（ページ）, d（輪郭の SVG パス。紙の px、ページの上端から）, hl（マーカー）, c（色）, y0, y1（上下の端） }]、
// gaps / sps: 書き込み JSON の gap / sp（sps は { ページ: [{ at, h }] }）、grs: 足した余白・白紙を方眼にしたページの Set（gr）、keys: 書き出す紙の Set（'<ページ>:<白紙>'。null ならすべて）、
// viewT(n): ページ n の向き・範囲（なければ viewOf）、say: 途中の知らせ、
// pics: 貼った画像 [{ b（ページ）, f（名前）, p: [左上, 右上, 左下]（紙の px、ページの上端から）, y0, y1 }]、pic(f): 画像の中身（JPEG か PNG の Uint8Array。なければ null）。
// 返すもの: { bytes, name, count（紙の数） }
export async function exportPdf({ L, pdf, unlock, sizes, title, ink, gaps = {}, sps = {}, grs = new Set(), keys = null, viewT, say = () => {}, pics = [], pic = async () => null }) {
  const N = sizes.length, PN = (s) => L.PDFName.of(s);
  ink = ink.filter((s) => s.d).sort((x, y) => y.hl - x.hl);   // マーカーは下に描く
  const { sheets, top0 } = sheetsOf(sizes, gaps, sps);
  const sel = [...sheets].filter(([k]) => !keys || keys.has(k)).map(([, sh]) => sh), all = sel.length === sheets.size;
  if (!sel.length) throw new Error('ページを選んでください');
  say('PDF を読んでいます');
  const opt = { updateMetadata: false };
  let pd;
  try { pd = await L.PDFDocument.load(pdf, opt); }
  catch (e) {
    // 鍵のかかった PDF は pdf-lib では読めないので、PDF.js で写したものを使う。1つの PDF だけから写すと鍵もそのまま写るので、
    // 白い1ページの PDF も一緒に渡して（そのページは入れない）、鍵を外した形で写させる
    if (!unlock) throw e;
    const t = await L.PDFDocument.create();
    t.addPage([10, 10]);
    pd = await L.PDFDocument.load(await (await unlock()).extractPages([{ document: null }, { document: await t.save(), excludePages: [0] }]), opt);
  }
  if (pd.getPageCount() !== N) throw new Error('ページの数が合いません');
  const orig = pd.getPages(), src0 = pd;   // 手を入れる前の元のページ（向き・範囲を見る）
  viewT ||= async (n) => viewOf(L, orig[n - 1]);
  const out = [];   // [紙, 出す先のページ]
  if (all) {
    // すべて: 元の PDF に白紙を足していく。後ろのページから足すと、前のページの番号がずれない
    let added = false;
    for (let n = N; n >= 1; n--) {
      const bl = sel.filter((sh) => sh.n === n && sh.i);
      for (let j = bl.length - 1; j >= 0; j--) { out.push([bl[j], pd.insertPage(n, sizes[n - 1])]); added = true; }
      out.push([sheets.get(n + ':0'), orig[n - 1]]);
    }
    if (added) pd.catalog.delete(PN('PageLabels'));   // ページの呼び名（i, ii, 1, 2 …）は白紙の分ずれるので外す
  } else {
    // 一部: 選んだページだけを新しい PDF に写す。本の中へのリンクは飛び先のページまで写してしまう（重くなる）ので外す
    const mains = sel.filter((sh) => !sh.i).map((sh) => sh.n);
    for (const n of mains) {
      const nd = orig[n - 1].node, an = nd.Annots();
      if (an) nd.set(PN('Annots'), src0.context.obj(an.asArray().filter((r) => { const a = src0.context.lookup(r); return !(a instanceof L.PDFDict && a.get(PN('Subtype')) === PN('Link')); })));
    }
    pd = await L.PDFDocument.create();
    const cp = await pd.copyPages(src0, mains.map((n) => n - 1));
    let j = 0;
    for (const sh of sel) out.push([sh, sh.i ? pd.addPage(sizes[sh.n - 1]) : pd.addPage(cp[j++])]);
  }
  const hex = (c) => { const x = INK[c] || (/^#[0-9a-f]{6}$/i.test(c) ? c : INK.k); return L.rgb(...[1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16) / 255)); };
  const hl = hex(HL);
  const on = (sh) => (s) => top0[s.b] != null && top0[s.b] + s.y1 > sh.y && top0[s.b] + s.y0 < sh.y + sh.h;
  const hits = (sh) => ink.filter(on(sh)), picHits = (sh) => pics.filter(on(sh));
  const ims = new Map();   // 画像の名前 -> 埋め込んだ画像（同じ画像は1つだけ入れる）
  const embed = (f) => {
    if (!ims.has(f)) ims.set(f, (async () => { const d = await pic(f); return d ? d[0] === 0x89 ? pd.embedPng(d) : pd.embedJpg(d) : null; })().catch(() => null));
    return ims.get(f);
  };
  // 紙 sh にかかる画像と線を描く。U は紙の座標（pt、上から下へ）を出す先のページの座標に直す行列
  async function drawSheet(P, sh, U, k) {
    for (const s of picHits(sh)) {
      const im = await embed(s.f);
      if (!im) continue;
      // 画像の (0, 0)〜(1, 1)（左下が原点）を、紙の上の四隅（左下・右下・左上）に合わせる
      const [p0, p1, p3] = s.p, M = [p1[0] - p0[0], p1[1] - p0[1], p0[0] - p3[0], p0[1] - p3[1], p3[0], p3[1]];
      P.pushOperators(L.pushGraphicsState(), L.concatTransformationMatrix(...mul(mul(mul(M, [1, 0, 0, 1, 0, top0[s.b] - sh.y]), [k, 0, 0, k, 0, 0]), U)),
        L.drawObject(P.node.newXObject('Im', im.ref)), L.popGraphicsState());
    }
    let gs = null;
    for (const s of hits(sh)) {
      if (s.hl && !gs) gs = P.node.newExtGState('GS', pd.context.obj({ Type: 'ExtGState', ca: .45, BM: 'Multiply' }));
      // 線の輪郭は紙の px（段落の上端から）。drawSvgPath は上下を返して描くので、先に返しておく
      P.pushOperators(L.pushGraphicsState(), L.concatTransformationMatrix(...mul(mul([1, 0, 0, -1, 0, top0[s.b] - sh.y], [k, 0, 0, k, 0, 0]), U)),
        ...L.drawSvgPath(s.d, { x: 0, y: 0, color: s.hl ? hl : hex(s.c), graphicsState: s.hl ? gs : undefined }), L.popGraphicsState());
    }
  }
  // 方眼: 出す先のページの (x0, y0)〜(x1, y1)（pt、下から上）に、紙の 16px ごとの目を、左上からそろえて引く
  const gridC = L.rgb(.69, .75, .86);
  function grid(P, x0, y0, x1, y1, k) {
    const st = GRID * k, t = .5;
    for (let x = x0; x <= x1 + .01; x += st) P.drawLine({ start: { x, y: y0 }, end: { x, y: y1 }, thickness: t, color: gridC });
    for (let y = y1; y >= y0 - .01; y -= st) P.drawLine({ start: { x: x0, y }, end: { x: x1, y }, thickness: t, color: gridC });
  }
  // ページの途中に余白があるページ: 縦に伸ばした紙に作り直す。元のページを絵（XObject）にして、余白で切った切れ目ごとに並べる
  async function stretch(P, n, Hs) {
    const T = await viewT(n), [w, h] = sizes[n - 1], k = w / W, ph = pageH(sizes, n), mb = P.getMediaBox();
    const emb = P.node.Contents() && await pd.embedPage(P, { left: mb.x, bottom: mb.y, right: mb.x + mb.width, top: mb.y + mb.height }, [1, 0, 0, 1, 0, 0]);
    if (emb) await emb.embed();   // 今の中身を絵に写しておく（このあとページの中身を入れ替える）。中身のない白いページはそのまま
    const nd = P.node;
    nd.set(PN('Contents'), pd.context.obj([]));
    nd.set(PN('Resources'), pd.context.obj({ Font: {}, XObject: {}, ExtGState: {} }));
    for (const x of ['Annots', 'CropBox', 'BleedBox', 'TrimBox', 'ArtBox']) nd.delete(PN(x));   // 注釈は位置が合わなくなるので外す
    P.setMediaBox(0, 0, w, Hs); P.setRotation(L.degrees(0));
    if (!emb) return;
    const key = nd.newXObject('Pg', emb.ref);
    let c0 = 0, v = 0;
    for (const p of sps[n].concat({ at: ph, h: 0 })) {
      const a = c0 * k, z = p.at >= ph ? h : p.at * k, y = Hs - v * k;   // 元のページの [a, z)（上から pt）を、紙の上から v の位置に
      P.pushOperators(L.pushGraphicsState(), L.rectangle(0, y - (z - a), w, z - a), L.clip(), L.endPath(),
        L.concatTransformationMatrix(...mul(T, [1, 0, 0, -1, 0, y + a])), L.drawObject(key), L.popGraphicsState());
      if (p.h && grs.has(n)) { const y1 = Hs - (v + p.at - c0) * k; grid(P, 8 * k, y1 - p.h * k, w - 8 * k, y1, k); }
      v += p.at - c0 + p.h; c0 = p.at;
    }
  }
  let done = 0;
  for (const [sh, P] of out) {
    const n = sh.n, [w, h] = sizes[n - 1], k = w / W;
    if (sh.i) { if (grs.has(n)) grid(P, 0, 0, w, h, k); await drawSheet(P, sh, [1, 0, 0, -1, 0, h], k); }
    else if (sps[n]) { const Hs = h + sh.h * k - pageH(sizes, n) * k; await stretch(P, n, Hs); await drawSheet(P, sh, [1, 0, 0, -1, 0, Hs], k); }
    else if (hits(sh).length || picHits(sh).length) await drawSheet(P, sh, inv(await viewT(n)), k);
    if (++done % 10 === 0) { say(`作っています ${done} / ${out.length}`); await new Promise((r) => setTimeout(r)); }
  }
  say('まとめています');
  await new Promise((r) => setTimeout(r));
  const bytes = await pd.save();
  // 名前: <題名>（書き込み）.pdf。一部のときはページの範囲も（3-5,8）
  const rg = [];
  for (const n of new Set(sel.map((sh) => sh.n))) { const r = rg[rg.length - 1]; if (r && r[1] === n - 1) r[1] = n; else rg.push([n, n]); }
  const name = `${(title || 'book').replace(/[\\/:*?"<>|]/g, '_')}（書き込み${all ? '' : ' p' + rg.map(([a, z]) => a === z ? a : a + '-' + z).join(',')}）.pdf`;
  return { bytes, name, count: out.length };
}

// ---------- 書き込み JSON から線の輪郭を作る（node で動かすとき。アプリは画面に描いた輪郭をそのまま渡す） ----------
// app.js の PRESS / opts / pathD / trimTail / smooth / render / de と同じ（変えたら両方そろえる。tests/export.cjs が同じ輪郭になるか確かめる）
const PRESS = 2;   // 筆圧のペン（pr）の点の筆圧を、perfect-freehand の 0.5 を真ん中とした値に直す倍率
function opts(s, last) {
  if (s.tool === 'hl') return { size: 16, thinning: 0, smoothing: .5, streamline: .45, simulatePressure: false, last, start: { cap: false }, end: { cap: false } };
  return { size: s.s, thinning: s.pr && !s.g ? .65 : 0, smoothing: .55, streamline: .28, simulatePressure: false, last };
}
function pathD(outline) {
  const n = outline.length;
  if (n < 2) return '';
  const r = (v) => Math.round(v * 100) / 100;
  let d = `M${r(outline[0][0])},${r(outline[0][1])}Q`;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = outline[i], [x1, y1] = outline[(i + 1) % n];
    d += `${r(x0)},${r(y0)} ${r((x0 + x1) / 2)},${r((y0 + y1) / 2)} `;
  }
  return d + 'Z';
}
function trimTail(pts, r) {
  const n = pts.length, L = pts[n - 1];
  let k = n - 2;
  while (k > 0 && Math.hypot(pts[k][0] - L[0], pts[k][1] - L[1]) < r) k--;
  return k >= n - 2 ? pts : pts.slice(0, k + 1).concat([L]);
}
function smooth(pts, r) {
  const n = pts.length;
  if (n < 3) return pts;
  const c = [0];
  for (let i = 1; i < n; i++) c.push(c[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return pts.map((q, i) => {
    const h = Math.min(r, c[i], c[n - 1] - c[i]);
    if (h <= 0) return q;
    let x = 0, y = 0, k = 0;
    for (let j = i; j >= 0 && c[j] >= c[i] - h; j--) { x += pts[j][0]; y += pts[j][1]; k++; }
    for (let j = i + 1; j < n && c[j] <= c[i] + h; j++) { x += pts[j][0]; y += pts[j][1]; k++; }
    return [x / k, y / k, q[2]];
  });
}
// blocks: 書き込み JSON（ink/<章>.json）の blocks。getStroke: perfect-freehand。返すもの: exportPdf に渡す { ink, gaps, sps, pics, grs }
export function readInk(blocks, getStroke) {
  const ink = [], gaps = {}, sps = {}, pics = [], grs = new Set();
  for (const b in blocks) {
    const blk = blocks[b];
    if (blk.gap) gaps[b] = blk.gap;
    if (blk.sp && blk.sp.length) sps[b] = blk.sp.map(([at, h]) => ({ at, h }));
    if (blk.gr) grs.add(+b);
    // 貼った画像: 左上・右上・左下（×10）。右下は 右上 + 左下 - 左上
    for (const id in blk.pics || {}) {
      const d = blk.pics[id], v = d.p.map((x) => x / 10), ys = [v[1], v[3], v[5], v[3] + v[5] - v[1]];
      pics.push({ b: +b, f: d.f, p: [[v[0], v[1]], [v[2], v[3]], [v[4], v[5]]], y0: Math.min(...ys), y1: Math.max(...ys) });
    }
    for (const id in blk.strokes || {}) {
      const d = blk.strokes[id], pts = [], seen = [];
      for (let i = 0; i + 2 < d.p.length; i += 3) {
        const k = d.p[i] + ',' + d.p[i + 1];
        if (!d.g && seen.includes(k)) continue;
        seen.push(k); if (seen.length > 16) seen.shift();
        pts.push([d.p[i] / 10, d.p[i + 1] / 10, d.p[i + 2] / 100]);
      }
      if (!pts.length) continue;
      const s = { tool: d.t, s: d.s, pr: d.pr, g: d.g }, o = opts(s, true);
      let q = d.g ? pts : smooth(pts, Math.min(o.size * .75, 3));
      q = trimTail(q, Math.min(o.size, 3));
      const outl = getStroke(q.map(([x, y, pr]) => [x * 10, y * 10, Math.min(1, pr * PRESS)]), { ...o, size: o.size * 10 });
      const ys = pts.map((p) => p[1]);
      ink.push({ b: +b, d: pathD(outl.map(([x, y]) => [x / 10, y / 10])), hl: d.t === 'hl', c: d.c, y0: Math.min(...ys) - 10, y1: Math.max(...ys) + 10 });
    }
  }
  return { ink, gaps, sps, pics, grs };
}

// ---------- node で動かす（クラウドの Claude 用） ----------
const USAGE = `書き込みつき PDF を作ります（Ink Reader の「書き出す」と同じもの）。
使い方: node ink_export.mjs --pdf <book.pdf> --book <book.json> --ink <ink/pdf.json> [--pages 3-5,8] [--pics <フォルダ>] [--out <出す PDF>]
  --pages  書き出すページ（ページの後ろの白紙も一緒に入る）。省くとすべて
  --pics   紙に貼った画像のフォルダ（ドライブの <本>/pics/）。省くと、今のフォルダかインクの JSON の隣の pics/
  --out    出すファイル（省くと「<題名>（書き込み …）.pdf」）
先に、このファイルと同じフォルダか今のフォルダで npm i pdf-lib@1.17.1 perfect-freehand@1.2.2 をしておく。`;
async function main(args) {
  const fs = await import('node:fs'), path = await import('node:path'), { createRequire } = await import('node:module'), { pathToFileURL, fileURLToPath } = await import('node:url');
  const a = {};
  for (let i = 0; i < args.length; i++) if (/^--/.test(args[i])) a[args[i].slice(2)] = args[i + 1] && !/^--/.test(args[i + 1]) ? args[++i] : true;
  if (!a.pdf || !a.book || !a.ink) { console.error(USAGE); process.exit(1); }
  // pdf-lib と perfect-freehand: アプリの中にあればそれ（vendor/）、なければ npm で入れたもの
  const here = path.dirname(fileURLToPath(import.meta.url)), mine = (f) => fs.existsSync(path.join(here, f)) ? path.join(here, f) : null;
  const reqs = [createRequire(path.join(process.cwd(), 'x.js')), createRequire(path.join(here, 'x.js'))];
  const need = (m) => { for (const r of reqs) try { return r(m); } catch {} throw new Error(`${m} がありません。npm i pdf-lib@1.17.1 perfect-freehand@1.2.2 をしてから、もう一度動かしてください`); };
  const pl = mine('vendor/pdf-lib/pdf-lib.esm.min.js'), pf = mine('vendor/perfect-freehand.js');
  const L = pl ? await import(pathToFileURL(pl).href) : need('pdf-lib');
  const getStroke = pf ? new Function('window', fs.readFileSync(pf, 'utf8') + '\nreturn window.getStroke;')({}) : need('perfect-freehand').getStroke;
  const bk = JSON.parse(fs.readFileSync(a.book, 'utf8')), raw = JSON.parse(fs.readFileSync(a.ink, 'utf8'));
  if (!bk.pdf || !bk.sizes) throw new Error('PDF の本の book.json ではありません');
  const { ink, gaps, sps, pics, grs } = readInk(raw.blocks || {}, getStroke);
  // 貼った画像はファイルのフォルダから。見つからない画像は入れずに知らせる
  const picDir = typeof a.pics === 'string' ? a.pics : ['pics', path.join(path.dirname(a.ink), 'pics'), path.join(path.dirname(a.ink), '..', 'pics')].find((d) => fs.existsSync(d));
  const lost = new Set();
  const pic = async (f) => { const p = picDir && path.join(picDir, path.basename(f)); if (p && fs.existsSync(p)) return new Uint8Array(fs.readFileSync(p)); lost.add(f); return null; };
  let keys = null;
  if (typeof a.pages === 'string') {
    const want = new Set();
    for (const r of a.pages.split(',')) { const [x, y = x] = r.split('-').map(Number); for (let n = x; n <= y; n++) want.add(n); }
    keys = new Set([...sheetsOf(bk.sizes, gaps, sps).sheets.keys()].filter((k) => want.has(+k.split(':')[0])));
  }
  const pdf = new Uint8Array(fs.readFileSync(a.pdf));
  // 鍵のかかった PDF: pdfjs-dist があれば、それで鍵を外す
  const unlock = async () => {
    let pj;
    for (const r of reqs) try { pj = await import(pathToFileURL(r.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href); break; } catch {}
    if (!pj) throw new Error('鍵のかかった PDF です。npm i pdfjs-dist@5.7.284 をしてから、もう一度動かしてください');
    return pj.getDocument({ data: pdf.slice(), verbosity: 0 }).promise;
  };
  const t0 = Date.now(), r = await exportPdf({ L, pdf, unlock, sizes: bk.sizes, title: bk.title, ink, gaps, sps, grs, keys, pics, pic, say: (t) => console.log(t) });
  const out = typeof a.out === 'string' ? a.out : r.name;
  fs.writeFileSync(out, r.bytes);
  const z = r.bytes.length;
  if (lost.size) console.log(`貼った画像 ${lost.size} 枚が見つからないので、入れていません（ドライブの <本>/pics/ から取って --pics で指定してください）: ${[...lost].join(' ')}`);
  console.log(`できました: ${out}（${r.count}枚、${z < 1048576 ? Math.ceil(z / 1024) + 'KB' : (z / 1048576).toFixed(1) + 'MB'}、${((Date.now() - t0) / 1000).toFixed(1)}秒）`);
}
if (typeof process === 'object' && process.versions && process.versions.node && process.argv[1]) {
  import('node:url').then(({ pathToFileURL }) => {
    if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch((e) => { console.error(e && e.message || e); process.exit(1); });
  });
}
