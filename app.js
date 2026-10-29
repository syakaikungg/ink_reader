// Copyright (C) 2026 syakaikungg. All rights reserved.
// Ink Reader: md の本を章ごとに表示し、Apple Pencil で書き込む。
// 本は iPad の「ファイル」から開くか、非公開リポジトリ（既定 syakaikungg/sakai_study）から取る。
// どちらも本・書き込みを IndexedDB に保存してオフラインで使う。書き込み・画像・Claude の答えは Google ドライブに置く（GitHub は本文だけ）
(() => {
  const W = 680;
  // アプリの版。sw.js の VERSION と同じにする（設定の見出しに小さく出し、開き直したあと新しい版か確かめられるようにする）
  const APP_VERSION = 'ink-reader-v64';
  const PREF = 'ink';
  const $ = (s) => document.querySelector(s);
  const page = $('#page'), sizer = $('#sizer'), wrap = $('#wrap'), doc = $('#doc'), svg = $('#ink'), stat = $('#stat');
  const NS = 'http://www.w3.org/2000/svg';
  let CH = null;   // 開いている章の id

  // ---------- state ----------
  let tool = 'pen', color = 'k', size = 3.4, finger = false;
  let scale = 1, zoomMode = 'fit';
  // 線は段落（#docの子要素）ごとに結びつけ、座標はその段落の上端からの相対値で持つ
  // {id,b,tool,c,s,pen,pts:[[x,yRel,p]],bbox,el}
  let strokes = [];
  const undoStack = [], redoStack = [];
  let blocks = [], tops = [], hashes = [];
  function initBlocks() {
    blocks = [...doc.children];
    tops = blocks.map(() => -1);
    hashes = blocks.map((el) => {
      let h = 5381; const t = el.textContent.slice(0, 300);
      for (let i = 0; i < t.length; i++) h = (h * 33 + t.charCodeAt(i)) >>> 0;
      return h.toString(36);
    });
  }

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // ---------- IndexedDB（本・図・書き込みの端末内保存） ----------
  const kv = (() => {
    let dbp;
    const open = () => dbp ||= new Promise((res, rej) => {
      const r = indexedDB.open('ink-reader', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const tx = async (mode, f) => {
      const d = await open();
      return new Promise((res, rej) => { const q = f(d.transaction('kv', mode).objectStore('kv')); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    };
    return {
      get: (k) => tx('readonly', (s) => s.get(k)),
      set: (k, v) => tx('readwrite', (s) => s.put(v, k)),
      del: (k) => tx('readwrite', (s) => s.delete(k)),
    };
  })();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // ---------- geometry ----------
  function opts(s, last) {
    if (s.tool === 'hl') return { size: 16, thinning: 0, smoothing: .5, streamline: .45, simulatePressure: false, last,
      start: { cap: false }, end: { cap: false } };
    // ペンは太さ一定（筆圧で太さを変えない）。点の筆圧は保存したままなので、筆圧で変わるペンを足すときに使える
    return { size: s.s, thinning: 0, smoothing: .55, streamline: .28, simulatePressure: false, last };
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
  // 線の上下の位置（段落の上端から）。書いている途中は書き始めの点
  const sy = (s) => s.bbox ? (s.bbox[1] + s.bbox[3]) / 2 : s.pts[0][1];
  // 線を置く位置。段落にたたんだ余白があれば、その下の線は見た目だけ上にずらす（余白の高さを変えている間は live の分もずらす）
  function top(s) {
    const b = Math.min(s.b, tops.length - 1), t = tops[b] || 0;
    if (!spans[b] && !live) return t;
    const y = sy(s), z = live && live.b === b && y >= live.e ? y + live.d : y;
    return t + z - y - foldOff(b, z);
  }
  function place(s) {
    s.el.setAttribute('transform', `translate(0 ${top(s)})`);
    const h = !!spans[s.b] && inFold(s.b, sy(s));   // たたんだ余白の中の線は隠す
    if (h !== !!s.hid) { s.hid = h; s.el.style.display = h ? 'none' : ''; }
  }
  // 線の終わりの細かいぶれ（離す瞬間のわずかな動き）は除いて描く。残すと終わりの丸が横を向き、線がくびれて途切れたように見える
  function trimTail(pts, r) {
    const n = pts.length, L = pts[n - 1];
    let k = n - 2;
    while (k > 0 && Math.hypot(pts[k][0] - L[0], pts[k][1] - L[1]) < r) k--;
    return k >= n - 2 ? pts : pts.slice(0, k + 1).concat([L]);
  }
  // 前後 r の長さ（線の太さに合わせる）の点の平均でならす。iPad のペンの位置は画面の 1px 刻みで、手のぶれも画面の上では同じ大きさなので、
  // 拡大して書くと線の太さに比べてぶれが目立ち、太さが波打つ。太さに合わせた長さでならすと、拡大率によらず同じ仕上がりになる
  function smooth(pts, r) {
    const n = pts.length;
    if (n < 3) return pts;
    const c = [0];
    for (let i = 1; i < n; i++) c.push(c[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    return pts.map((q, i) => {
      const h = Math.min(r, c[i], c[n - 1] - c[i]);   // 両端は動かさない
      if (h <= 0) return q;
      let x = 0, y = 0, k = 0;
      for (let j = i; j >= 0 && c[j] >= c[i] - h; j--) { x += pts[j][0]; y += pts[j][1]; k++; }
      for (let j = i + 1; j < n && c[j] <= c[i] + h; j++) { x += pts[j][0]; y += pts[j][1]; k++; }
      return [x / k, y / k, q[2]];
    });
  }
  function render(s, pts, last) {
    const o = opts(s, last), list = pts || s.pts;
    let q = s.g ? list : smooth(list, Math.min(o.size * .75, 3));   // 図形に直した線は角を丸めないよう、ならさない
    if (last) q = trimTail(q, Math.min(o.size, 3));   // 書いている途中に削ると、ペン先の手前が直線になる
    // perfect-freehand は線の終わりの長さ 3（座標の単位）を直線でつなぐ。紙の px のまま渡すと、拡大して書いたときに
    // ペン先の後ろについてくる短い棒に見えるので、10 倍して渡して戻す
    const out = getStroke(q.map(([x, y, pr]) => [x * 10, y * 10, pr]), { ...o, size: o.size * 10 });
    s.el.setAttribute('d', pathD(out.map(([x, y]) => [x / 10, y / 10])));
  }
  function bbox(s) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const [x, y] of s.pts) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }
    s.bbox = [a, b, c, d];
  }
  // 色は 'k'/'r'/'b'（画面の明暗で色が変わる既定の3色）か '#rrggbb'（自分で選んだ色）
  function paint(el, s) {
    const hex = s.tool !== 'hl' && /^#/.test(s.c);
    el.setAttribute('class', s.tool === 'hl' ? 'hl' : hex ? 'x' : s.c);
    if (hex) el.style.fill = s.c; else el.style.removeProperty('fill');
  }
  function mount(s) {
    if (!s.el) {
      s.el = document.createElementNS(NS, 'path'); paint(s.el, s);
      render(s, null, true);
    }
    place(s);
    if (s.tool === 'hl') svg.insertBefore(s.el, svg.firstChild); else svg.appendChild(s.el);
  }
  function blockAt(y) {
    let lo = 0, hi = tops.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tops[m] <= y) lo = m; else hi = m - 1; }
    return lo;
  }

  // ---------- serialize ----------
  const ser = (s) => ({ t: s.tool, c: s.c, s: s.s, pen: !!s.pen,
    p: s.pts.flatMap(([x, y, p]) => [Math.round(x * 10), Math.round(y * 10), Math.round(p * 100)]),
    // 図形に直した線は、あとで形を変えられるよう図形の形も残す（k: line・poly・ellipse・circle、v: 頂点か [中心, 半径]、a: 傾き）
    ...(s.g ? { g: { k: s.g.k, v: s.g.v.flatMap(([x, y]) => [Math.round(x * 10), Math.round(y * 10)]), a: Math.round((s.g.a || 0) * 1000), p: Math.round(s.g.p * 100) } } : {}) });
  function de(id, b, d) {
    // 前の版で重なって届いた点（少し前と同じ位置）がそのまま入っている線は、読み込むときに除く（線の途切れ・ねじれのもと）
    const pts = [], seen = [];
    for (let i = 0; i + 2 < d.p.length; i += 3) {
      const k = d.p[i] + ',' + d.p[i + 1];
      if (!d.g && seen.includes(k)) continue;
      seen.push(k); if (seen.length > 16) seen.shift();
      pts.push([d.p[i] / 10, d.p[i + 1] / 10, d.p[i + 2] / 100]);
    }
    const s = { id, b, tool: d.t, c: d.c, s: d.s, pen: d.pen, pts };
    if (d.g) { const v = []; for (let i = 0; i + 1 < d.g.v.length; i += 2) v.push([d.g.v[i] / 10, d.g.v[i + 1] / 10]); s.g = { k: d.g.k, v, a: d.g.a / 1000, p: d.g.p / 100 }; }
    bbox(s); return s;
  }
  // 今の章の書き込みを段落ごとの形にする（GitHub の ink/<章>.json と同じ形）
  function serialize() {
    const out = {};
    for (const s of strokes.concat([...new Set([...Object.keys(gaps), ...Object.keys(sps), ...folds])].map((b) => ({ b: +b })))) {
      // PDF は b がページ番号。ページの大きさ（pt）も残し、座標（幅 680 の紙の px）を PDF の座標に直せるようにする
      const blk = out[s.b] ||= isPdf() ? { b: s.b, pt: book.sizes[s.b - 1], strokes: {} }
        : { b: s.b, h: hashes[s.b], text: blocks[s.b] ? blocks[s.b].textContent.slice(0, 80) : '', strokes: {} };
      if (s.pts) blk.strokes[s.id] = ser(s);
      if (gaps[s.b]) blk.gap = gaps[s.b];
      if (folds.has(s.b)) blk.fold = 1;
      if (sps[s.b]) blk.sp = sps[s.b].map((p) => [p.at, p.h, p.c ? 1 : 0]);
    }
    return out;
  }
  function showBlocks(data) {
    clearSel();
    for (const s of strokes) s.el.remove();
    strokes = [];
    const was = [...new Set([...Object.keys(gaps), ...Object.keys(sps), ...folds])];
    gaps = {}; sps = {}; folds = new Set();
    for (const b of was) relay(+b);
    for (const b in data) {
      const d = data[b];
      if (d.gap) gaps[b] = d.gap;
      if (d.fold && d.gap) folds.add(+b);
      if (d.sp && d.sp.length) sps[b] = d.sp.map(([at, h, c]) => ({ at, h, c: !!c }));
      if (d.gap || d.sp) relay(+b);
      for (const id in d.strokes || {}) { const s = de(id, +b, d.strokes[id]); mount(s); strokes.push(s); }
    }
    showSps();
  }

  // ---------- 余白・白紙ページ ----------
  // 段落（PDF はページ）に高さを足して、書き込む場所を作る。新しい段落は作らないので、段落番号もページ番号もずれない。
  // 余白に書いた線はその段落に、段落の上端からの座標で結びつく。足した高さは書き込みの JSON の段落ごとの値（紙の px）に入れ、元の md・PDF は変えない。
  // - gap: 段落の下に足した高さ。md は段落の下の余白（fold: たたんでいる）、PDF は直前のページと同じ大きさの白紙（ページの間と同じ隙間を空けて並べる）
  // - sp: PDF のページの途中に入れた余白 [[at（元のページの上端からの位置）, 高さ, たたんでいるか], …]（上から順）。ページの絵は余白のところで切って並べる
  // 線の座標は、余白をすべて開いたときの位置で持つ。たたんだ余白の中の線は隠し、下の線は見た目だけ上にずらす（top）
  let gaps = {}, sps = {}, folds = new Set();
  let spans = {};   // 段落番号 -> 余白の範囲 [{ i（sps の番号。md は -1）, e0, e1（線の座標での上端・下端）, c（たたんでいる） }]
  let live = null;  // 余白の高さを変えている間: { b, e, d }（e より下の線を見た目だけ d ずらす）
  const GAP_MD = 320, PAGE_GAP = 14, FOLD = 28, SP_H = 200;
  const gapUnit = (b) => isPdf() ? pageH(b) + PAGE_GAP : GAP_MD;
  const padV = (b) => gaps[b] ? (folds.has(b) ? FOLD : gaps[b]) : 0;   // md: 段落の下の余白の見た目の高さ
  const spSum = (b) => (sps[b] || []).reduce((a, p) => a + p.h, 0);
  const sheet = (b) => pageH(b) + (sps[b] || []).reduce((a, p) => a + (p.c ? FOLD : p.h), 0);   // PDF: 余白を入れたページの紙の見た目の高さ
  // PDF のページの切れ目: 元のページの [c0, c1) を、ページの上端から v の位置に出す
  function segs(b) {
    const out = []; let c0 = 0, v = 0;
    for (const p of sps[b] || []) { out.push({ c0, c1: p.at, v }); v += p.at - c0 + (p.c ? FOLD : p.h); c0 = p.at; }
    out.push({ c0, c1: pageH(b), v });
    return out;
  }
  const cToV = (b, c) => { const s = segs(b).find((x) => c <= x.c1); return s ? s.v + c - s.c0 : c; };
  // 見た目の位置 v（ページの上端から）にある元のページの位置。余白の中なら、その直後の位置
  const vToC = (b, v) => { for (const s of segs(b)) if (v < s.v + s.c1 - s.c0) return s.c0 + Math.max(0, v - s.v); return pageH(b); };
  const foldOff = (b, y) => { let d = 0; for (const p of spans[b] || []) if (p.c && p.e1 <= y) d += p.e1 - p.e0 - FOLD; return d; };
  const inFold = (b, y) => (spans[b] || []).some((p) => p.c && y >= p.e0 && y < p.e1);
  // 見た目の位置（段落の上端から）-> 線の座標
  const toSto = (b, v) => { let d = 0; for (const p of spans[b] || []) if (p.c && v >= p.e0 - d + FOLD) d += p.e1 - p.e0 - FOLD; return v + d; };
  function respan(b) {
    const el = blocks[b], out = [];
    if (!el) { delete spans[b]; return; }
    if (!isPdf() && gaps[b]) { const e0 = el.offsetHeight - padV(b); out.push({ i: -1, e0, e1: e0 + gaps[b], c: folds.has(b) }); }
    let acc = 0;
    (sps[b] || []).forEach((p, i) => { out.push({ i, e0: p.at + acc, e1: p.at + acc + p.h, c: p.c }); acc += p.h; });
    if (out.length) spans[b] = out; else delete spans[b];
  }
  // 段落 b の見た目を、余白の状態に合わせて作り直す
  function relay(b) {
    const el = blocks[b];
    if (!gaps[b]) { delete gaps[b]; folds.delete(b); }
    if (sps[b] && !sps[b].length) delete sps[b];
    if (el && !isPdf()) el.style.paddingBottom = gaps[b] ? padV(b) + 'px' : '';
    if (el && isPdf()) {
      const ph = pageH(b), sh = sheet(b), px = gaps[b] || 0, n = Math.round(px / (ph + PAGE_GAP));
      el.style.height = sh + px + 'px'; el.style.setProperty('--ph', sh + 'px');
      for (const x of el.querySelectorAll('.blank')) x.remove();
      for (let i = 1; i <= n; i++) {
        const d = document.createElement('div'); d.className = 'blank';
        d.style.cssText = `top:${sh - ph + i * (ph + PAGE_GAP)}px;height:${ph}px`;
        el.append(d);
      }
      placePage(b);
    }
    respan(b);
    for (const s of strokes) if (s.b === b) place(s);
  }
  const spState = (b) => ({ g: gaps[b] || 0, f: folds.has(b), sp: sps[b] ? sps[b].map((p) => ({ ...p })) : null });
  function setState(b, st) {
    if (st.g) gaps[b] = st.g; else delete gaps[b];
    if (st.f) folds.add(b); else folds.delete(b);
    if (st.sp) sps[b] = st.sp.map((p) => ({ ...p })); else delete sps[b];
    relay(b); showSps();
  }
  // 段落 b の余白を変える（change）。線の座標で e より下の線は dy ずらし、rm の範囲 [上, 下) の線は消す（どれも戻すで戻る）
  function changeSpace(b, change, e, dy, rm) {
    const from = spState(b), del = [], old = [], moved = [];
    for (const x of strokes) {
      if (x.b !== b) continue;
      const y = sy(x);
      if (rm && y >= rm[0] && y < rm[1]) del.push(x);
      else if (dy && y >= e) {
        const m = { id: newId(), b, tool: x.tool, c: x.c, s: x.s, pen: x.pen, pts: x.pts.map(([px, py, pp]) => [px, py + dy, pp]) };
        if (x.g) m.g = moveG(x.g, 0, dy);
        bbox(m); old.push(x); moved.push(m);
      }
    }
    removeAll(del.concat(old)); change(); relay(b); addAll(moved); showSps();
    push({ type: 'gap', b, from, to: spState(b), list: del, mv: [old, moved] });   // 先に変えてから記録する（記録したときに保存される）
  }
  // md: 投げ縄のメニューの「下に余白」
  function addGap(b) { changeSpace(b, () => { gaps[b] = (gaps[b] || 0) + GAP_MD; folds.delete(b); }, 0, 0); }
  // 余白を消す。そこに書いた線も一緒に消す
  function removeSpace(b, i) {
    const p = (spans[b] || []).find((x) => x.i === i);
    if (!p) return;
    if (i < 0) changeSpace(b, () => { delete gaps[b]; }, 0, 0, [p.e0, Infinity]);
    else changeSpace(b, () => { sps[b].splice(i, 1); }, p.e1, p.e0 - p.e1, [p.e0, p.e1]);
  }
  // 投げ縄で横にまっすぐ線を引いたら、そこに余白を入れる（y は紙の上の位置）。md は近い方の段落の切れ目、PDF はページの途中にも入る
  const SP_OK = '余白を入れました（下の端のつまみ：押すとたたむ・長押しして上下に動かすと高さが変わる）', SP_IN = 'ここにはもう余白があります（下の端のつまみを長押しすると広げられます）';
  function lineSpace(y) {
    let b = Math.max(1, blockAt(y));
    const el = blocks[b];
    if (!el) return;
    const v = y - tops[b];
    if (!isPdf()) {
      const ch = el.offsetHeight - padV(b);
      if (v >= ch && gaps[b]) return SP_IN;
      if (v < ch / 2 && b > 1) b--;
      changeSpace(b, () => { gaps[b] = (gaps[b] || 0) + SP_H; folds.delete(b); }, 0, 0);
      return SP_OK;
    }
    const sh = sheet(b);
    if (v >= sh && v < el.offsetHeight) return '白紙には入れられません（白紙はページの一覧から）';
    if ((spans[b] || []).some((p) => { const d0 = p.e0 - foldOff(b, p.e0); return v >= d0 && v < d0 + (p.c ? FOLD : p.e1 - p.e0); })) return SP_IN;
    const at = Math.round(v >= sh ? pageH(b) : vToC(b, v)), list = sps[b] || [], i = list.filter((p) => p.at <= at).length;
    const e = at + list.slice(0, i).reduce((a, p) => a + p.h, 0);
    changeSpace(b, () => { (sps[b] ||= []).splice(i, 0, { at, h: SP_H, c: false }); }, e, SP_H);
    return SP_OK;
  }
  // 余白のたたむ・開く（戻すには入れない）
  function toggleFold(b, i) {
    if (i < 0) { if (folds.has(b)) folds.delete(b); else folds.add(b); }
    else sps[b][i].c = !sps[b][i].c;
    relay(b); showSps(); touch([{ b }]);
  }
  // 余白の見た目の範囲（紙の上）: [{ b, i, y0, h, c, n（中の線の数） }]
  function spaceRects() {
    const out = [];
    for (const b in spans) for (const p of spans[+b]) {
      const y0 = tops[+b] + p.e0 - foldOff(+b, p.e0);
      out.push({ b: +b, i: p.i, y0, h: p.c ? FOLD : p.e1 - p.e0, c: p.c, n: strokes.filter((s) => s.b === +b && sy(s) >= p.e0 && sy(s) < p.e1).length });
    }
    return out;
  }
  // 余白の印: 開いた余白は点線で囲み、下の端につまみを出す（押すとたたむ・長押しして上下に動かすと高さが変わる）。たたんだ余白は細い帯（押すと開く）
  const spLayer = $('#sps');
  function showSps() {
    const els = [];
    for (const r of spaceRects()) {
      const k = document.createElement('button'); k.type = 'button'; k.dataset.b = r.b; k.dataset.i = r.i;
      if (r.c) {
        k.className = 'sph fold'; k.style.top = r.y0 + 'px';
        const t = document.createElement('span'); t.textContent = `余白${r.n ? ` ${r.n}画` : ''} ▾`; k.append(t);
        k.setAttribute('aria-label', '余白を開く');
        els.push(k); continue;
      }
      const box = document.createElement('div'); box.className = 'sp'; box.style.cssText = `top:${r.y0}px;height:${r.h}px`;
      k.className = 'sph'; k.style.top = r.y0 + r.h + 'px'; k.setAttribute('aria-label', '余白をたたむ（長押しして上下に動かすと高さが変わる）');
      els.push(box, k);
    }
    spLayer.replaceChildren(...els);
  }
  let spd = null;   // 余白のつまみを押している: { b, i, id, y, p（範囲）, h0, min, h, on（高さを変えている）, t }
  spLayer.addEventListener('pointerdown', (e) => {
    const k = e.target.closest('.sph');
    if (!k || spd || curId !== null) return;
    e.preventDefault(); e.stopPropagation();
    k.setPointerCapture(e.pointerId);
    const b = +k.dataset.b, i = +k.dataset.i, p = spans[b].find((x) => x.i === i);
    // 中に書いた線より上には縮めない（線がなければ、上まで縮めると消える）
    const low = strokes.reduce((a, s) => s.b === b && sy(s) >= p.e0 && sy(s) < p.e1 ? Math.max(a, s.bbox[3] + (s.s || 8)) : a, -Infinity);
    spd = { b, i, id: e.pointerId, y: e.clientY, p, h0: p.e1 - p.e0, min: low > -Infinity ? low - p.e0 + 6 : 0, k, on: false };
    if (!p.c) spd.t = setTimeout(() => { if (!spd) return; spd.on = true; k.classList.add('on'); stat.textContent = '上下に動かすと余白の高さが変わります'; }, 350);
  });
  // 動かしている間につまみを作り直すので、動きと離したのは window で受ける
  addEventListener('pointermove', (e) => {
    if (!spd || e.pointerId !== spd.id) return;
    const dy = (e.clientY - spd.y) / scale;
    if (!spd.on) { if (Math.abs(dy) * scale > 8) { clearTimeout(spd.t); spd.moved = true; } return; }
    spd.h = Math.max(spd.min, spd.h0 + dy);
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (spd && spd.on) liveSpace(spd.h); });
  });
  // 動かしている間は、高さだけ変えて下の線を見た目だけずらす（離したときに線の座標を直して記録する）
  function liveSpace(h) {
    const { b, i, p } = spd;
    if (i < 0) gaps[b] = Math.max(1, h); else sps[b][i].h = Math.max(1, h);
    live = { b, e: p.e1, d: h - spd.h0 };
    relay(b); showSps();
    spLayer.querySelector(`.sph[data-b="${b}"][data-i="${i}"]`)?.classList.add('on');
  }
  function spUp(e) {
    if (!spd || e.pointerId !== spd.id) return;
    const s = spd; spd = null; clearTimeout(s.t);
    if (!s.on) { if (!s.moved && e.type === 'pointerup') toggleFold(s.b, s.i); return; }
    if (s.i < 0) gaps[s.b] = s.h0; else sps[s.b][s.i].h = s.h0;
    live = null; relay(s.b);
    const h = s.h ?? s.h0;
    if (h < 24 && !s.min) { removeSpace(s.b, s.i); stat.textContent = '余白を消しました'; return; }
    if (Math.abs(h - s.h0) < 1) { showSps(); return; }
    const nh = Math.round(h);
    changeSpace(s.b, () => { if (s.i < 0) gaps[s.b] = nh; else sps[s.b][s.i].h = nh; }, s.p.e1, nh - s.h0);
    stat.textContent = '余白の高さを変えました';
  }
  addEventListener('pointerup', spUp);
  addEventListener('pointercancel', spUp);

  // PDF の白紙: i 枚目（0 はページそのもの）の後ろに白紙を1枚入れる・i 枚目の白紙を消す。
  // 白紙はページの下に同じ間隔で並ぶので、後ろの白紙に書いた線はずらす（線は作り直して、戻すで戻る）
  function blankOp(n, i, add) {
    const u = gapUnit(n), to = (gaps[n] || 0) + (add ? u : -u), cut = spSum(n) + (i + 1) * u - PAGE_GAP / 2;
    if (to < 0) return;
    changeSpace(n, () => { gaps[n] = to; }, cut, add ? u : -u, add ? null : [cut - u, cut]);
  }

  // ---------- 設定 ----------
  const DEF = { token: '', repo: 'syakaikungg/sakai_study', branch: 'master', book: 'books/nishimori', session: '' };
  let cfg = { ...DEF };
  try { cfg = { ...DEF, ...JSON.parse(store.get(PREF + ':cfg') || '{}') }; } catch {}
  const online = () => navigator.onLine !== false;
  // 開いている本: 'gh'（設定の GitHub の本）か 'local:<id>'（ファイルから開いた本）
  let src = store.get(PREF + ':book') || 'gh';
  const isLocal = () => src !== 'gh';
  const canSync = () => !isLocal() && !!cfg.token && online();
  // 書き込みを送れるか。書き込み・画像・答えは、どの本もドライブにつないでいればドライブに置く（GitHub は本文だけ。AI が育てる文章の置き場所）
  const canPush = () => online() && hasRemote();

  // ---------- GitHub ----------
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  const b64 = { from(s) { const b = new TextEncoder().encode(s); let t = ''; for (let i = 0; i < b.length; i += 0x8000) t += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(t); },
    to(s) { return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), (c) => c.charCodeAt(0))); } };
  async function gh(path, { raw = false, blob = false, method = 'GET', body } = {}) {
    const url = `https://api.github.com/repos/${cfg.repo}/contents/${enc(path)}` + (method === 'GET' ? `?ref=${encodeURIComponent(cfg.branch)}` : '');
    const r = await fetch(url, { method, cache: 'no-store', headers: {
      Authorization: 'Bearer ' + cfg.token, 'X-GitHub-Api-Version': '2022-11-28',
      Accept: raw || blob ? 'application/vnd.github.raw' : 'application/vnd.github+json',
    }, body: body && JSON.stringify(body) });
    if (r.status === 404 && method === 'GET') return null;
    if (!r.ok) { const e = new Error('GitHub ' + r.status); e.status = r.status; throw e; }
    return blob ? r.blob() : raw ? r.text() : r.json();
  }

  // ---------- 置き場所（GitHub・Google ドライブ） ----------
  // どちらも get / sha / put / del / list を持つ。sha は版（GitHub は sha、ドライブは version）で、put は sha が今と違えば 409
  const hub = {
    name: 'GitHub',
    async get(path) { const m = await gh(path); return m && { sha: m.sha, text: m.content ? b64.to(m.content) : await gh(path, { raw: true }) }; },
    async sha(path) { const m = await gh(path); return m ? m.sha : null; },
    async put(path, body, sha, message) {
      const content = typeof body === 'string' ? b64.from(body) : await blobB64(body);
      return (await gh(path, { method: 'PUT', body: { message, branch: cfg.branch, content, ...(sha ? { sha } : {}) } })).content.sha;
    },
    async del(path, sha, message) { await gh(path, { method: 'DELETE', body: { message, branch: cfg.branch, sha } }); },
    async list(dir) { const l = await gh(dir); return Array.isArray(l) ? l.map((f) => ({ name: f.name, path: dir + '/' + f.name })) : []; },
  };
  // ドライブは、利用者のマイドライブの「Ink Reader」フォルダの下に置く（パスはその中から）。
  // ログインは Google のポップアップ（押した操作の中でしか開けない）。トークンは 1 時間で切れるので、切れる前後に画面に触れたとき、自動でつなぎ直す
  // OAuth のクライアント ID はアプリに入れておく（Google Cloud の Ink Reader のプロジェクトのもの）。どの人もこれで自分のドライブにつなぐ。
  // テスト中の間は、使う人のアドレスを Google Cloud の「テストユーザー」に足しておく
  const DRIVE_CID = '475510876028-4so1cqd8mfv7kbeq09fiapqe3vo8eetj.apps.googleusercontent.com';
  const drive = (() => {
    const API = 'https://www.googleapis.com/', ROOT = 'Ink Reader', FOLDER = 'application/vnd.google-apps.folder';
    let tok = null, exp = 0, gis = null, who = '';
    try { ({ tok, exp, who = '' } = JSON.parse(store.get(PREF + ':dtok')) || {}); } catch {}
    const prep = () => gis ||= new Promise((ok, ng) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.onload = ok;
      s.onerror = () => { gis = null; s.remove(); ng(new Error('Google に接続できません')); };
      document.head.append(s);
    });
    // ポップアップを止められないように、押した操作の中で（待たずに）呼ぶ。先に prep で読み込んでおく
    // again: 2回目からは同意の画面を出さず、同じアカウントで（一瞬開いて閉じるだけ）
    const login = (again) => new Promise((ok, ng) => {
      if (!window.google || !google.accounts) { prep(); return ng(new Error('準備中です。もう一度押してください')); }
      google.accounts.oauth2.initTokenClient({
        client_id: DRIVE_CID, scope: 'https://www.googleapis.com/auth/drive',
        ...(again && who ? { login_hint: who } : {}),
        callback: async (r) => {
          if (r.error) return ng(new Error(r.error));
          tok = r.access_token; exp = Date.now() + (r.expires_in - 60) * 1000;
          if (!who) try { who = (await (await api('drive/v3/about?fields=user(emailAddress)')).json()).user.emailAddress; } catch {}
          store.set(PREF + ':dtok', JSON.stringify({ tok, exp, who })); ok();
        },
        error_callback: (e) => ng(new Error(e.type === 'popup_closed' ? 'ログインを閉じました' : 'ログインできませんでした')),
      }).requestAccessToken(again ? { prompt: '' } : {});
    });
    async function api(path, opt = {}) {
      const no = () => { const e = new Error('ドライブにつながっていません'); e.status = 401; e.drive = true; return e; };
      if (!tok || Date.now() > exp) throw no();
      const r = await fetch(API + path, { ...opt, cache: 'no-store', headers: { Authorization: 'Bearer ' + tok, ...(opt.headers || {}) } });
      if (r.status === 401) { tok = null; throw no(); }
      if (!r.ok) { const e = new Error('ドライブ ' + r.status); e.status = r.status; throw e; }
      return r;
    }
    const qs = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    async function find(name, pid, folder) {
      const q = `name='${qs(name)}' and '${pid}' in parents and trashed=false` + (folder ? ` and mimeType='${FOLDER}'` : '');
      return (await (await api('drive/v3/files?' + new URLSearchParams({ q, fields: 'files(id,version)', pageSize: '5' }))).json()).files[0] || null;
    }
    const dirs = new Map();   // フォルダのパス -> id の Promise（同じフォルダを二つ作らないように）
    function folder(path, make) {
      if (dirs.has(path)) return dirs.get(path);
      const p = (async () => {
        const i = path.lastIndexOf('/'), pid = i < 0 ? 'root' : await folder(path.slice(0, i), make), name = path.slice(i + 1);
        if (!pid) return null;
        let f = await find(name, pid, true);
        if (!f && make) f = await (await api('drive/v3/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER, parents: [pid] }) })).json();
        return f ? f.id : null;
      })();
      dirs.set(path, p);
      p.then((id) => { if (!id) dirs.delete(path); }, () => dirs.delete(path));
      return p;
    }
    const split = (path) => { const full = ROOT + '/' + path, i = full.lastIndexOf('/'); return [full.slice(0, i), full.slice(i + 1)]; };
    async function file(path) { const [d, name] = split(path), pid = await folder(d, false); return pid ? find(name, pid) : null; }
    const texts = new Map();   // ファイルの id -> { v, text }（変わっていなければ取り直さない）
    return {
      name: 'ドライブ', prep, login, ok: () => !!tok && Date.now() < exp, soon: () => !tok || Date.now() > exp - 10 * 60000, mkdir: (path) => folder(ROOT + '/' + path, true),
      async get(path) {
        const f = await file(path);
        if (!f) return null;
        const c = texts.get(f.id);
        if (c && c.v === f.version) return { sha: f.version, text: c.text };
        const text = await (await api(`drive/v3/files/${f.id}?alt=media`)).text();
        texts.set(f.id, { v: f.version, text });
        return { sha: f.version, text };
      },
      async sha(path) { const f = await file(path); return f ? f.version : null; },
      async put(path, body, sha) {
        const [d, name] = split(path), pid = await folder(d, true), f = await find(name, pid);
        if ((f ? f.version : null) !== (sha || null)) { const e = new Error('ドライブ 409'); e.status = 409; throw e; }
        const type = typeof body === 'string' ? (/\.json$/.test(name) ? 'application/json' : /\.m?js$/.test(name) ? 'text/javascript' : 'text/markdown') : body.type;
        const blob = typeof body === 'string' ? new Blob([body], { type }) : body;
        if (f) return (await (await api(`upload/drive/v3/files/${f.id}?uploadType=media&fields=version`, { method: 'PATCH', headers: { 'Content-Type': type }, body: blob })).json()).version;
        const fd = new FormData();
        fd.append('metadata', new Blob([JSON.stringify({ name, parents: [pid], mimeType: type })], { type: 'application/json' }));
        fd.append('file', blob);
        return (await (await api('upload/drive/v3/files?uploadType=multipart&fields=version', { method: 'POST', body: fd })).json()).version;
      },
      async del(path) {
        const f = await file(path);
        if (f) await api(`drive/v3/files/${f.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
      },
      // フォルダの中の一覧（古い順）。答えは増えていくので、全部取れるまで続きを取る
      async list(dir) {
        const pid = await folder(ROOT + '/' + dir, false), out = [];
        if (!pid) return out;
        const q = `'${pid}' in parents and trashed=false`;
        let pageToken = '';
        do {
          const r = await (await api('drive/v3/files?' + new URLSearchParams({ q, fields: 'nextPageToken,files(id,name,version)', orderBy: 'modifiedTime', pageSize: '1000', ...(pageToken ? { pageToken } : {}) }))).json();
          for (const f of r.files) out.push({ name: f.name, path: dir + '/' + f.name, id: f.id, v: f.version });
          pageToken = r.nextPageToken;
        } while (pageToken);
        return out;
      },
      // list で取ったファイルの中身（一覧に id と版があるので、探し直さない）
      async read(f) {
        const c = texts.get(f.id);
        if (c && c.v === f.v) return c.text;
        const text = await (await api(`drive/v3/files/${f.id}?alt=media`)).text();
        texts.set(f.id, { v: f.v, text });
        return text;
      },
    };
  })();
  const driveOn = () => !!cfg.drive;
  // 書き込み・画像・答えの置き場所。ドライブにつないでいなければ置き場所はなく、iPad に貯めておいて、つないだら送る
  const where = () => driveOn() ? drive : null;
  const hasRemote = () => driveOn();
  // ドライブのトークンが切れる（10分前から）・切れた: 次に画面に触れたとき（ペンを離したときも）自動でつなぎ直す。
  // うまくいかなければ 2 分おいて、また触れたときに。下の表示を押してもつなぎ直せる
  let relogin = false, logging = false, nextTry = 0;
  function needLogin() {
    relogin = true; drive.prep().catch(() => {});
    stat.textContent = 'ドライブとの接続が切れました。ここを押すとつなぎ直します';
  }
  function reconnect(by) {
    if (logging) return;
    logging = true;
    drive.login(true).then(() => {
      if (relogin) stat.textContent = 'ドライブにつなぎ直しました';
      relogin = false; pushAll(); refreshChapter();
    }).catch((e) => { nextTry = Date.now() + 120000; if (by) stat.textContent = e.message; else if (!drive.ok()) needLogin(); })
      .finally(() => { logging = false; });
  }
  stat.addEventListener('click', () => { if (relogin) reconnect(true); });
  const autoLogin = () => {
    if (logging || !cfg.drive || !driveOn() || !online() || !drive.soon() || Date.now() < nextTry) return;
    if (!window.google || !google.accounts) { drive.prep().catch(() => {}); return; }
    reconnect(false);
  };
  for (const t of ['pointerup', 'touchend', 'click']) document.addEventListener(t, autoLogin, true);
  if (cfg.drive && driveOn()) setTimeout(() => drive.prep().catch(() => {}), 3000);   // 触れたときにすぐ開けるように、先に読み込んでおく
  // ドライブの「Ink Reader」フォルダに置く、AI（Claude などのドライブ連携）への説明
  const README = `# Ink Reader のフォルダ

iPad の手書きリーダー「Ink Reader」が置いているフォルダです。本ごとにフォルダがあります。

- \`<本>/book.json\`: 題名と章の一覧。PDF の本は \`pdf: true\` と各ページの大きさ。\`from: "github"\` の本は、本文が GitHub の \`repo\` の \`path\` にあり（章の md は \`path\` からの \`file\`）、このフォルダには書き込み・画像・答えだけを置く。
- \`<本>/book.pdf\`: PDF の本の元の PDF（10MB までの本だけ。それより大きい本は置かない）。
- \`<本>/chapters/<章>.md\`: md の本の本文（数式は TeX）。段落番号は、空行で区切った段落・見出し・数式のかたまりを上から 1, 2, … と数えたもの。
- \`<本>/view/p<ページ>.png\`: PDF の本の、書き込みのあるページ（と質問されたページ）の画像。ページの絵に手書きを重ねてある。
- \`<本>/asks/<質問ID>.png\`: 質問のときに囲んだ範囲の画像（手書き入り）。
- \`<本>/ink/<章>.json\`: 手書きの座標（アプリ用。人が読むものではない。書き込みつきの PDF を作るときに使う）。
- \`ink_export.mjs\`: 書き込みつきの PDF を作る道具（アプリの「書き出す」と同じもの。使い方は下）。

## 質問に答えるとき

アプリから届く質問文に、本のフォルダ・ページ（段落）番号・質問ID が書いてあります。画像と本文を読んで答えてください。

答えはチャットで返したうえで、\`<本>/answers/\` フォルダに **新しいファイル** \`<章>-<質問ID>.md\` を作って保存してください（既存のファイルは書き換えない）。
ファイルの1行目は \`<!-- ink-answer id=<質問ID> b=<ページか段落の番号,…> -->\`、2行目は \`> 質問: <質問>\`、その下に答えを書きます（数式は \`$…$\` / \`$$…$$\`）。
アプリはこのファイルを読んで、そのページ（段落）の右に「Q」を出します。

## 書き込みつきの PDF を作るとき（課題の提出など）

PDF の本は、アプリの「書き出す」と同じ PDF（元のページに手書きを重ね、ページの途中の余白・後ろの白紙も入れたもの）を作れます。コマンドを動かせる環境（Claude Code など）で:

1. ドライブから4つをダウンロードする: \`Ink Reader/ink_export.mjs\`、\`<本>/book.json\`、\`<本>/book.pdf\`、\`<本>/ink/pdf.json\`
2. 作業フォルダに \`ink_export.mjs\` を置き、そこで \`npm i pdf-lib@1.17.1 perfect-freehand@1.2.2\`（鍵のかかった PDF は \`pdfjs-dist@5.7.284\` も）
3. \`node ink_export.mjs --pdf <book.pdf> --book <book.json> --ink <pdf.json> --pages 3-5 --out <名前>.pdf\`
   - \`--pages\` は書き出すページ（そのページの後ろに入れた白紙も一緒に入る）。省くとすべて

\`book.pdf\` がない本（10MB より大きい）は作れないので、iPad のアプリで、右下のページ番号から開くページの一覧の「書き出す」で作ってもらってください。
iPad で書いた直後は、ドライブに届くまで少し待ってから（アプリの下に「ドライブに保存しました」と出る）ダウンロードしてください。
`;

  // ---------- 本のダウンロード（端末に保存） ----------
  let book = null;
  const isPdf = () => !!(book && book.pdf);
  const bookKey = () => isLocal() ? src : cfg.repo + '@' + cfg.branch + ':' + cfg.book;
  // 章の位置や最後に開いた章は本ごとに覚える（GitHub の本は前からのキーのまま）
  // 置き場所の上の本のフォルダ。ドライブでは「Ink Reader/<題名> (<id の末尾>)」
  // GitHub の本は「<題名> (<本のフォルダ名>)」。題名が変わってもフォルダが変わらないよう、最初に決めた名前を覚えておく
  const dirName = (title, tail) => (title || '本').replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 60) + ' (' + tail + ')';
  function bookDir() {
    if (isLocal()) return dirName(book && book.title, src.slice(-4));
    const k = PREF + ':ddir:' + bookKey(), tail = cfg.book.split('/').pop();
    let d = store.get(k);
    if (!d && book) store.set(k, d = dirName(book.title, tail));
    return d || dirName('', tail);
  }
  const memKey = (k) => PREF + ':' + k + (isLocal() ? ':' + src : '');
  async function loadBook() { book = await kv.get('book:' + bookKey()); return book; }
  // 変わったファイルだけ取り直す。図は一度取れば取り直さない
  async function syncBook(force) {
    if (!canSync()) return false;
    stat.textContent = '本を確認中…';
    const meta = JSON.parse(await gh(cfg.book + '/book.json', { raw: true }) || 'null');
    if (!meta) throw new Error('本が見つかりません（' + cfg.book + '/book.json）');
    const list = await gh(cfg.book + '/chapters') || [];
    const shas = Object.fromEntries(list.map((f) => [f.name, f.sha]));
    let i = 0;
    for (const c of meta.chapters) {
      i++;
      const name = c.file.split('/').pop(), key = 'md:' + bookKey() + ':' + c.id;
      const have = await kv.get(key);
      if (!force && have && have.sha === shas[name]) continue;
      stat.textContent = `本をダウンロード中 ${i}/${meta.chapters.length}`;
      const md = await gh(cfg.book + '/' + c.file, { raw: true });
      await kv.set(key, { sha: shas[name], md });
      await kv.del('html:' + bookKey() + ':' + c.id);
    }
    const names = Object.keys(meta.images || {});
    let j = 0;
    for (const f of names) {
      j++;
      const key = 'img:' + meta.imageDir + '/' + f;
      if (!force && await kv.get(key)) continue;
      stat.textContent = `図をダウンロード中 ${j}/${names.length}`;
      const bl = await gh(meta.imageDir + '/' + f, { blob: true });
      if (bl) await kv.set(key, bl);
    }
    await kv.set('book:' + bookKey(), meta);
    book = meta;
    stat.textContent = '本をこのiPadに保存しました（通信なしでも開けます）';
    return true;
  }
  const imgUrls = {};
  async function fillImages() {
    for (const el of doc.querySelectorAll('img[data-img]')) {
      const key = 'img:' + book.imageDir + '/' + el.dataset.img;
      if (!imgUrls[key]) { const bl = await kv.get(key); if (bl) imgUrls[key] = URL.createObjectURL(bl); }
      if (imgUrls[key]) el.src = imgUrls[key];
    }
  }
  async function chapterHtml(id) {
    const hk = 'html:' + bookKey() + ':' + id, src = await kv.get('md:' + bookKey() + ':' + id);
    if (!src) return null;
    const cached = await kv.get(hk);
    const v = renderMarkdown.version;
    if (cached && cached.sha === src.sha && cached.v === v) return cached.html;
    const html = renderMarkdown(src.md, book.images);
    kv.set(hk, { sha: src.sha, v, html }).catch(() => {});
    return html;
  }

  // ---------- 書き込みの保存と同期 ----------
  // 端末: kv 'ink:<本>:<章>' = { blocks, sha, pending:[段落番号], at:置き場所 }。置き場所: <本>/ink/<章>.json = { chapter, blocks }
  // pending の段落は端末側を正とし、それ以外は置き場所の側を正としてまとめる
  // 置き場所: どの本もドライブ（つないでいるとき）。前は GitHub の本は GitHub、ファイルの本もトークンがあれば GitHub に送っていた（at が無く sha があれば GitHub）
  let cs = null;   // 今の章の { blocks, sha, pending:Set, at }
  const inkKey = (id) => 'ink:' + bookKey() + ':' + id;
  const inkPath = (id, dir = bookDir()) => dir + '/ink/' + id + '.json';
  const tag = (R) => R === hub ? '' : 'drive:';   // 置き場所ごとに覚えること（送った本・画像）のキーの頭
  let saveT = 0;
  const saved = (st) => ({ blocks: st.blocks, sha: st.sha, pending: [...st.pending], at: st.at });
  function persist() {
    clearTimeout(saveT);
    const key = inkKey(CH), st = cs;
    st.blocks = serialize();
    saveT = setTimeout(() => kv.set(key, saved(st)).catch(() => {}), 150);
  }
  function touch(list) {
    if (!cs) return;
    for (const s of list) cs.pending.add(s.b);   // つないでいない間に書いた分も、つないだら送る
    persist(); schedulePush(); showPending();
  }
  function showPending() {
    if (!cs || !cs.pending.size || !hasRemote()) return;
    stat.textContent = online() ? `未送信 ${cs.pending.size}段落` : `オフライン: ${cs.pending.size}段落分をiPadに保存中`;
  }
  let pushT = 0;
  function schedulePush(ms = 4000) { clearTimeout(pushT); pushT = setTimeout(() => pushChapter(CH), ms); }
  function merge(st, remote) {   // remote: {b: block}
    const out = {};
    for (const b in remote || {}) if (!st.pending.has(+b)) out[b] = remote[b];
    for (const b of st.pending) if (st.blocks[b]) out[b] = st.blocks[b];
    return out;
  }
  async function pullInk(id, dir = bookDir(), R = where()) {
    const f = await R.get(inkPath(id, dir));
    return f ? { sha: f.sha, blocks: (JSON.parse(f.text || '{}').blocks) || {} } : { sha: null, blocks: {} };
  }
  // 置き場所を変えた（GitHub からドライブへ、など）章は、書き込みを全部送り直す
  const atOf = (st) => st.at || (st.sha ? hub.name : null);
  function moveTo(st, R) {
    const at = atOf(st);
    if (!R || at === R.name) return;
    st.sha = null; st.at = R.name;
    for (const b in st.blocks) st.pending.add(+b);
  }
  let pushing = false;
  async function pushChapter(id) {
    if (pushing || !canPush()) { showPending(); return; }
    if (!ghMoved()) { moveGhBook(); return; }
    const key = inkKey(id), dir = bookDir(), bk = bookKey(), meta = book, R = where();   // 送信中に本を切り替えても、元の本に保存する
    const st = id === CH ? cs : await kv.get(key).then((v) => v && { ...v, pending: new Set(v.pending) });
    if (!st) return;
    moveTo(st, R);
    if (!st.pending.size) return;
    pushing = true;
    let sent = null;
    try {
      await upBook(dir, bk, meta, R);
      for (let tryNo = 0; tryNo < 2; tryNo++) {
        sent = new Set(st.pending);
        if (id === CH) st.blocks = serialize();
        const body = JSON.stringify({ chapter: id, blocks: st.blocks }, null, 0);
        try {
          st.sha = await R.put(inkPath(id, dir), body, st.sha, `ink: ${dir.split('/').pop()} ${id}`);
          for (const b of sent) if (id !== CH || sameBlock(b, st.blocks[b])) st.pending.delete(b);
          break;
        } catch (e) {
          if (e.status !== 409 && e.status !== 422) throw e;
          // 他の端末が先に保存していた: 取り直してまとめ、もう一度
          const remote = await pullInk(id, dir, R);
          st.sha = remote.sha;
          st.blocks = merge(st, remote.blocks);
          if (id === CH) { showBlocks(st.blocks); undoStack.length = redoStack.length = 0; syncHist(); }
        }
      }
      await kv.set(key, saved(st));
      // PDF は座標だけでは AI に分からないので、書き込みを変えたページを画像にして送る
      if (meta && meta.pdf && id === CH && bk === bookKey()) { await upPages(dir, bk, [...sent], false, R); kv.set('viewv:' + tag(R) + bk, VIEWV).catch(() => {}); }
      if (id === CH && !st.pending.size) stat.textContent = R.name + 'に保存しました';
    } catch (e) {
      if (e.drive) needLogin();
      else stat.textContent = e.status === 401 || e.status === 403 ? R.name + 'に保存できません（設定を確かめてください）' : R.name + 'に送れませんでした（iPadには保存済み）';
    } finally {
      pushing = false;
      if (id === CH && cs && cs.pending.size && canPush()) schedulePush(8000);
    }
  }
  // 送信中に書き足された段落は送信済みにしない
  function sameBlock(b, sentBlock) {
    const now = strokes.filter((s) => s.b === b).map((s) => s.id).sort().join();
    return now === Object.keys((sentBlock && sentBlock.strokes) || {}).sort().join();
  }
  // 本の情報を、最初に一度だけ置く。ファイルの md の本は本文も置く（GitHub の本の本文は GitHub にあるので、場所だけ書く）。
  // ドライブには AI への説明（README.md）と道具も置く
  async function upBook(dir, bk, meta, R) {
    if (R === drive) await upTools().catch((e) => { if (e.drive) throw e; });
    if (!meta || await kv.get('up:' + tag(R) + bk)) return;
    const local = bk.startsWith('local:'), put = async (path, text) => { if (!await R.sha(path)) await R.put(path, text, null, `book: ${dir.split('/').pop()}`); };
    if (R === drive) await drive.mkdir(dir + '/answers');   // 答えを置くフォルダを先に作っておく
    const chapters = meta.chapters.map((c) => meta.pdf || !local ? { id: c.id, label: c.label, file: c.file } : { id: c.id, label: c.label, file: 'chapters/' + c.id + '.md' });
    for (const c of meta.pdf || !local ? [] : meta.chapters) {
      const v = await kv.get('md:' + bk + ':' + c.id);
      if (v) await put(dir + '/chapters/' + c.id + '.md', v.md);
    }
    const from = local ? { from: 'file' } : { from: 'github', repo: cfg.repo, branch: cfg.branch, path: cfg.book };
    await put(dir + '/book.json', JSON.stringify({ title: meta.title, ...from, pdf: !!meta.pdf, chapters, ...(meta.sizes ? { sizes: meta.sizes } : {}) }, null, 1));
    await kv.set('up:' + tag(R) + bk, true);
  }
  // GitHub の本をドライブにつないだとき、一度だけ: GitHub にある書き込み（iPad でまだ開いていない章も）と答えをドライブへ写す。
  // 書き込みは iPad の分とまとめて全部送り直し、答え（<章>.md に追記してきたもの）は 1 問ずつのファイルに分ける。以後 GitHub の ink・answers は使わない
  // 写し終わるまでは、GitHub の本の書き込みをドライブに送らない（写す前に送ると、GitHub にしかない段落が抜ける）
  const ghMoved = () => isLocal() || store.get(PREF + ':moved:' + bookKey()) === '1';
  let moving = false;
  async function moveGhBook() {
    if (ghMoved() || !book || !canPush() || !cfg.token || moving) return;
    const bk = bookKey(), dir = bookDir(), meta = book;
    moving = true;
    // 1 章ぶん: まだ写していなければ（途中で止まったときは、写し終えた章を飛ばす）GitHub の分とまとめ、全部を未送信にする
    const moveInk = async (id) => {
      const live = id === CH && cs, key = inkKey(id);
      const st = live || await kv.get(key).then((v) => v && { ...v, pending: new Set(v.pending) });
      if (st && atOf(st) === drive.name) return;
      const remote = await pullInk(id, cfg.book, hub), s = st || { blocks: {}, sha: null, pending: new Set() };
      if (live && (s !== cs || atOf(s) === drive.name)) return moveInk(id);   // 待っている間に章を開き直した
      if (s === cs) s.blocks = serialize();
      s.blocks = merge(s, remote.blocks);   // いつもの取り込みと同じ: iPad の未送信の段落はそのまま、ほかは GitHub の分
      s.sha = null; s.at = drive.name;
      for (const b in s.blocks) s.pending.add(+b);
      if (s === cs) { showBlocks(s.blocks); undoStack.length = redoStack.length = 0; syncHist(); persist(); }
      else if (Object.keys(s.blocks).length) await kv.set(key, saved(s));
    };
    try {
      for (const c of meta.chapters) {
        if (bk !== bookKey()) return;
        await moveInk(c.id);
        const md = await hub.get(cfg.book + '/answers/' + c.id + '.md');
        for (const a of splitAnswers(md && md.text)) {
          const path = dir + '/answers/' + c.id + '-' + a.id + '.md';
          if (!await drive.sha(path)) await drive.put(path, a.text, null);
        }
      }
      if (bk !== bookKey()) return;
      if (CH && cs) await moveInk(CH);   // 写している間に開いた章（開く前に端末から読んだ分には、GitHub の分が入っていない）
      store.set(PREF + ':moved:' + bk, '1');
      stat.textContent = 'GitHub の書き込みと答えをドライブに写しました';
      pushAll();
      if (CH) pullAnswers(CH);
    } catch (e) { if (e.drive) needLogin(); }
    finally { moving = false; }
  }
  // ドライブの「Ink Reader」の直下に、AI への説明（README.md）と、書き込みつきの PDF を作る道具（ink_export.mjs。中身は export.js）を置く。
  // アプリの版が変わったら置き直す。二つ同時に走って同じファイルを二つ作らないよう、走っている間は同じものを待つ
  let toolsUp = null;
  function upTools() {
    return toolsUp ||= (async () => {
      if (await kv.get('tools:drive') === APP_VERSION) return;
      const r = await fetch('export.js');
      if (!r.ok) throw new Error('export.js ' + r.status);
      for (const [path, text] of [['README.md', README], ['ink_export.mjs', await r.text()]]) await drive.put(path, text, await drive.sha(path));
      await kv.set('tools:drive', APP_VERSION);
    })().finally(() => { toolsUp = null; });
  }
  // PDF の本の元の PDF を、一度だけ <本>/book.pdf に置く（クラウドの Claude が ink_export.mjs で「書き出す」と同じ PDF を作れるように）。
  // ドライブ連携で Claude が読めるのは 10MB までなので、それより大きい本は置かない。GitHub には置かない
  const PDF_MAX = 10 * 1048576;
  let pdfUp = null;
  function upPdf() {
    if (!isPdf() || where() !== drive || pdfUp) return;
    const dir = bookDir(), bk = bookKey();
    pdfUp = (async () => {
      await upTools();
      if (await kv.get('pdfup:drive:' + bk)) return;
      const v = await kv.get('pdf:' + bk), f = v && new Blob([v], { type: 'application/pdf' });
      if (!f) return;
      if (f.size <= PDF_MAX && !await drive.sha(dir + '/book.pdf')) await drive.put(dir + '/book.pdf', f, null);
      await kv.set('pdfup:drive:' + bk, true);
    })().catch(() => {}).finally(() => { pdfUp = null; });   // つながっていないときは、次に章を開いたとき・アプリに戻ったときに
  }
  // PDF のページ n を、余白・白紙と書き込みごと画像にする（紙の幅 680px の 2 倍）。
  // たたんだ余白も開いた形にする（線の座標は余白をすべて開いたときの位置なので、そのまま描ける）
  async function pageImage(n) {
    const k = 2, pg = await pdfDoc.getPage(n), w1 = pg.getViewport({ scale: 1 }).width, pc = document.createElement('canvas');
    pc.width = W * k; pc.height = Math.ceil(pageH(n) * k);
    await pg.render({ canvas: pc, viewport: pg.getViewport({ scale: k * W / w1 }) }).promise;
    const list = strokes.filter((s) => s.b === n);
    let h = pageH(n) + spSum(n) + (gaps[n] || 0);
    for (const s of list) h = Math.max(h, s.bbox[3] + 20);
    const cv = document.createElement('canvas'), g = cv.getContext('2d');
    cv.width = W * k; cv.height = Math.ceil(h * k);
    g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    let c0 = 0, v = 0;
    for (const c1 of (sps[n] || []).map((p) => p.at).concat(pageH(n))) {
      g.drawImage(pc, 0, c0 * k, pc.width, (c1 - c0) * k, 0, v * k, cv.width, (c1 - c0) * k);
      const p = (sps[n] || []).find((x) => x.at === c1);
      v += c1 - c0 + (p ? p.h : 0); c0 = c1;
    }
    pc.width = pc.height = 0;
    g.scale(k, k); drawInk(g, list, () => 0);
    return cv;
  }
  const VIEWV = 2;   // ページの画像の作り方の版（変えたら上げる）
  const blobB64 = (bl) => new Promise((ok, ng) => { const r = new FileReader(); r.onload = () => ok(r.result.split(',')[1]); r.onerror = ng; r.readAsDataURL(bl); });
  const pngOf = (cv) => new Promise((r) => cv.toBlob(r, 'image/png'));
  // <本>/view/p<ページ>.png を作り直す。書き込みがなくなったページの画像は消す（all: 書き込みがなくても置く）
  // 同時に二つ走ると、どちらも「まだない」と見て同じ画像を二つ作るので、順番に一つずつ
  let pagesQ = Promise.resolve();
  function upPages(...a) { return pagesQ = pagesQ.then(() => upPages1(...a)).catch(() => {}); }
  async function upPages1(dir, bk, pages, all, R = where()) {
    const key = 'view:' + tag(R) + bk, shas = (await kv.get(key)) || {};
    for (const n of pages) {
      const path = dir + '/view/p' + n + '.png', msg = `ink: ${dir.split('/').pop()} p${n}`;
      try {
        if (!pdfDoc || bk !== bookKey() || !blocks[n]) break;
        if (!shas[n]) shas[n] = await R.sha(path);
        if (!all && !strokes.some((s) => s.b === n)) {
          if (shas[n]) { await R.del(path, shas[n], msg); delete shas[n]; }
          continue;
        }
        const cv = await pageImage(n), bl = await pngOf(cv);
        cv.width = cv.height = 0;
        shas[n] = await R.put(path, bl, shas[n], msg);
      } catch (e) { delete shas[n]; if (e.drive) { needLogin(); break; } }
    }
    await kv.set(key, shas);
  }
  async function pushAll() {
    if (!canPush() || !book) return;
    for (const c of book.chapters) await pushChapter(c.id);
  }
  async function refreshChapter() {   // 置き場所の書き込みと答えを取り込む（他の端末・Claude の変更）
    if (!canPush() || !cs) return;
    const id = CH, st = cs;
    pullAnswers(id); upPdf(); moveGhBook();
    if (atOf(st) !== where().name) return;   // まだ送っていない置き場所からは取らない
    try {
      const remote = await pullInk(id);
      if (id !== CH || remote.sha === st.sha) return;
      st.sha = remote.sha; st.blocks = merge(st, remote.blocks);
      showBlocks(st.blocks); undoStack.length = redoStack.length = 0; syncHist();
      persist();
      if (st.pending.size) schedulePush(500);
    } catch (e) { if (e.drive) needLogin(); }
  }
  addEventListener('online', () => { pushAll(); refreshChapter(); });
  addEventListener('offline', showPending);
  let lastPull = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (cs && cs.pending.size) pushChapter(CH); }
    // 答えを待っているときは、戻るたびに確かめる
    else if (Date.now() - lastPull > (asks.length ? 5000 : 60000)) { lastPull = Date.now(); refreshChapter(); }
  });

  // ---------- history ----------
  // op: {type:'add'|'erase', list} か {type:'replace', from, to}（投げ縄の移動・色変更）
  const opList = (op) => op.type === 'gap' ? op.list.concat(op.mv ? op.mv[0].concat(op.mv[1]) : [], { b: op.b }) : op.list || op.from.concat(op.to);
  function push(op) { undoStack.push(op); redoStack.length = 0; syncHist(); touch(opList(op)); }
  function addAll(list) { for (const s of list) { mount(s); strokes.push(s); } }
  function removeAll(list) { const set = new Set(list); strokes = strokes.filter((s) => !set.has(s)); for (const s of list) s.el.remove(); }
  function apply(op, inverse) {
    clearSel(); setEdit(null);
    if (op.type === 'replace') { removeAll(inverse ? op.to : op.from); addAll(inverse ? op.from : op.to); }
    else if (op.type === 'gap') {
      const [a, b] = op.mv || [[], []];
      removeAll(inverse ? b : op.list.concat(a)); setState(op.b, inverse ? op.from : op.to); addAll(inverse ? op.list.concat(a) : b);
    }
    else ((op.type === 'add') !== inverse) ? addAll(op.list) : removeAll(op.list);
    touch(opList(op));
  }
  function syncHist() { $('#undo').disabled = !undoStack.length; $('#redo').disabled = !redoStack.length; }
  $('#undo').onclick = () => { const op = undoStack.pop(); if (!op) return; apply(op, true); redoStack.push(op); syncHist(); };
  $('#redo').onclick = () => { const op = redoStack.pop(); if (!op) return; apply(op, false); undoStack.push(op); syncHist(); };

  // ---------- zoom / layout ----------
  function layout() {
    const h = page.offsetHeight;
    svg.setAttribute('height', h); svg.style.height = h + 'px';
    sizer.style.width = W * scale + 'px';
    sizer.style.height = h * scale + 'px';
    page.style.transform = `scale(${scale})`;
    zoomNow.textContent = Math.round(scale * 100) + '%';
    const next = blocks.map((el) => el.offsetTop);
    if (next.some((v, i) => v !== tops[i])) { tops = next; for (const b in spans) respan(+b); for (const s of strokes) place(s); placeMarks(); placeBm(); showHandles(); showSps(); }
    if (sel.length) showSel();
    if (pdfDoc) pdfPump();
  }
  function fitScale() {
    const avail = document.documentElement.clientWidth - 32;
    return Math.max(.5, Math.min(1.6, avail / W));
  }
  // at: 画面上の点 {x, y}。その点の下にある紙の位置（px, py。省略すると今その点にある位置）が、拡大後も x, y に来るようにする
  function setScale(next, mode, at) {
    const r0 = page.getBoundingClientRect();
    at = at || { x: innerWidth / 2, y: innerHeight / 2 };
    const px = at.px ?? (at.x - r0.left) / scale, py = at.py ?? (at.y - r0.top) / scale;
    scale = next; zoomMode = mode;
    layout();
    const r1 = page.getBoundingClientRect();
    wrap.scrollLeft += r1.left + px * scale - at.x;
    scrollBy(0, r1.top + py * scale - at.y);
    store.set(PREF + ':zoom', mode === 'fit' ? 'fit' : String(scale));
  }
  // 拡大率の一覧。先頭の隠れた項目に今の拡大率を出し、選んだあとはそこに戻す
  const zoomSel = $('#zoomv'), zoomNow = zoomSel.options[0];
  zoomSel.onchange = () => {
    const v = zoomSel.value;
    zoomSel.selectedIndex = 0;
    if (v === 'fit') setScale(fitScale(), 'fit'); else if (v) setScale(+v, 'manual');
  };

  // 2本指のピンチ。動かしている間は #sizer を transform で伸ばすだけにして（レイアウトし直さない）、指を離したときに拡大率を決める
  let pinch = null, pinchRaf = 0;
  const fingers = (e) => [...e.touches].filter((t) => t.touchType !== 'stylus' && !palms.has(t.identifier));
  const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2, d: Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) || 1 });
  const pinchK = () => Math.max(.5, Math.min(3, scale * pinch.m.d / pinch.m0.d)) / scale;
  function pinchDraw() {
    pinchRaf = 0;
    if (!pinch) return;
    const { m0, m, o } = pinch, k = pinchK();
    sizer.style.transformOrigin = `${o.x}px ${o.y}px`;
    sizer.style.transform = `translate(${m.x - m0.x}px, ${m.y - m0.y}px) scale(${k})`;
    zoomNow.textContent = Math.round(scale * k * 100) + '%';
  }
  function pinchEnd() {
    if (pinchRaf) cancelAnimationFrame(pinchRaf), pinchRaf = 0;
    const { m, r0 } = pinch, next = scale * pinchK(), fit = fitScale();
    const at = { x: m.x, y: m.y, px: (pinch.m0.x - r0.left) / scale, py: (pinch.m0.y - r0.top) / scale };
    pinch = null;
    sizer.classList.remove('pinching'); sizer.style.transform = ''; sizer.style.transformOrigin = '';
    // 画面幅の近くで離したら、画面幅にぴったり合わせる
    if (Math.abs(next - fit) / fit < .04) setScale(fit, 'fit', at); else setScale(next, 'manual', at);
  }
  document.addEventListener('touchstart', (e) => {
    const t = fingers(e);
    if (t.length !== 2 || pinch || (penDown && curType !== 'touch')) return;
    if (curId !== null) abortInput();   // 指で書いているときに2本目の指が来たら、書きかけの線はやめてピンチにする
    const r0 = page.getBoundingClientRect(), rs = sizer.getBoundingClientRect(), m0 = mid(t);
    pinch = { m0, m: m0, r0, o: { x: m0.x - rs.left, y: m0.y - rs.top } };
    sizer.classList.add('pinching');
    e.preventDefault();
  }, { passive: false });
  document.addEventListener('touchmove', (e) => {
    if (!pinch) return;
    e.preventDefault();
    const t = fingers(e);
    if (t.length < 2) return;
    pinch.m = mid(t);
    if (!pinchRaf) pinchRaf = requestAnimationFrame(pinchDraw);
  }, { passive: false });
  const pinchUp = (e) => { if (pinch && fingers(e).length < 2) pinchEnd(); };
  document.addEventListener('touchend', pinchUp);
  document.addEventListener('touchcancel', pinchUp);
  // Safari が画面全体を拡大しないようにする（ツールバーまで大きくなるため）
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  addEventListener('resize', () => { if (zoomMode === 'fit') setScale(fitScale(), 'fit'); });
  new ResizeObserver(layout).observe(doc);

  // ---------- toolbar ----------
  function press(group, btn) { for (const b of group) b.setAttribute('aria-pressed', String(b === btn)); }
  const toolBtns = [$('#t-pen'), $('#t-hl'), $('#t-er'), $('#t-ls')];
  toolBtns.forEach((b) => b.onclick = () => {
    const again = (b.id === 't-pen' && tool === 'pen') || (b.id === 't-er' && tool === 'er');
    loopBack = null;
    tool = { 't-pen': 'pen', 't-hl': 'hl', 't-er': 'er', 't-ls': 'ls' }[b.id]; press(toolBtns, b); setEdit(null);
    page.classList.toggle('erasing', tool === 'er');
    page.classList.toggle('lassoing', tool === 'ls');
    if (tool !== 'ls') clearSel();
    if (again && popFor !== b) openPop(b, tool === 'pen' ? 'p' : 'e'); else closePop();
  });
  // 戻す・進むの札は、ツールバーのすぐ下に置く（ツールバーは画面の幅で折り返して高さが変わる）
  const bar = $('#bar');
  new ResizeObserver(() => document.documentElement.style.setProperty('--bar-h', bar.offsetHeight + 'px')).observe(bar);
  // ペンの色と太さ: 選んでいる「ペン」をもう一度押すと小窓が出る。太さは3つから選び、つまみで選んでいる太さを変える（端末に覚える）。
  // 投げ縄で選んだ線は、メニューの「色・太さ」から同じ小窓で変える
  const PALETTE = ['k', 'r', 'b', '#1f8a4c', '#e07b00', '#7b3fc4', '#8a5a2b', '#0f8b8d', '#d6338a', '#6b7280', '#c9a100', '#0b2f6b'];
  const pop = $('#pop'), popPen = $('#pop-pen'), popColors = $('#pop-colors'), popEr = $('#pop-er'), erRange = popEr.querySelector('input');
  const sizeBtns = [...document.querySelectorAll('#pop-size .seg button')], popRange = $('#pop-size input'), selPen = $('#sel-pen');
  let popFor = null;
  const pens = (() => { try { return JSON.parse(store.get(PREF + ':pens')) || {}; } catch { return {}; } })();
  const widths = [2.2, 3.4, 5.5].map((v, i) => +(pens.s || [])[i] || v);
  let si = widths[pens.si] ? pens.si : 1;
  color = (Array.isArray(pens.c) ? pens.c[pens.ci] : pens.c) || 'k';   // 前の版はツールバーに色を3つ持っていた
  size = widths[si];
  const savePens = () => store.set(PREF + ':pens', JSON.stringify({ c: color, s: widths, si }));
  const ink = (c) => /^#/.test(c) ? c : `var(--ink-${c})`;
  const swatch = (el, c) => { el.className = 'sw'; el.style.background = ink(c); };
  const dotSize = (el, s) => { const w = Math.max(3, Math.min(16, s * 2)) + 'px'; el.style.width = el.style.height = w; };
  const penDot = $('#t-pen .dot');
  function showPen() { penDot.style.background = ink(color); dotSize(penDot, size); }
  showPen();
  // 小窓に出す今の色・太さ。投げ縄で選んだ線なら、その線のもの（ばらばらなら null）
  function penNow() {
    if (popFor !== selPen) return { c: color, s: size };
    const ss = sel.filter((s) => s.tool !== 'hl');
    if (!ss.length) return { c: null, s: null };
    return { c: ss.every((s) => s.c === ss[0].c) ? ss[0].c : null, s: ss.every((s) => s.s === ss[0].s) ? ss[0].s : null };
  }
  function showColors() {
    const now = penNow();
    popColors.replaceChildren(...PALETTE.map((c) => {
      const x = document.createElement('button'); x.type = 'button'; x.setAttribute('aria-pressed', String(c === now.c));
      const s = document.createElement('span'); swatch(s, c); x.append(s);
      x.onclick = () => pickColor(c);
      return x;
    }));
    // 一覧にない色は、iPad の色の選択画面から選ぶ
    const more = document.createElement('label'), inp = document.createElement('input');
    more.className = 'more'; more.title = 'ほかの色'; inp.type = 'color';
    inp.value = !now.c ? '#15181f' : /^#/.test(now.c) ? now.c : INK[now.c];
    inp.oninput = () => { if (popFor !== selPen) { color = inp.value; showPen(); showSizes(); } };
    inp.onchange = () => pickColor(inp.value);
    more.append(inp); popColors.append(more);
    if (/^#/.test(now.c) && !PALETTE.includes(now.c)) more.style.boxShadow = '0 0 0 2px var(--accent)';
  }
  function showSizes() {
    const now = penNow(), forSel = popFor === selPen;
    sizeBtns.forEach((b, i) => {
      b.setAttribute('aria-pressed', String(forSel ? now.s === widths[i] : i === si));
      const ln = b.firstElementChild; ln.style.background = ink(now.c || color); ln.style.height = Math.max(2, Math.min(16, widths[i] * 1.6)) + 'px';
    });
    popRange.value = now.s ?? size;
  }
  function pickColor(c) {
    if (popFor === selPen) restyle({ c }); else { color = c; showPen(); savePens(); }
    showColors(); showSizes();
  }
  sizeBtns.forEach((b, i) => b.onclick = () => {
    if (popFor === selPen) restyle({ s: widths[i] }); else { si = i; size = widths[i]; showPen(); savePens(); }
    showSizes();
  });
  popRange.oninput = () => { if (popFor !== selPen) { widths[si] = size = +popRange.value; showPen(); showSizes(); } };
  popRange.onchange = () => { if (popFor === selPen) { restyle({ s: +popRange.value }); showSizes(); } else savePens(); };
  selPen.onclick = () => { if (popFor === selPen) closePop(); else openPop(selPen, 'p'); };
  function closePop() { pop.hidden = true; popFor = null; }
  function openPop(btn, kind) {
    popFor = btn;
    popPen.hidden = kind !== 'p'; popEr.hidden = kind !== 'e';
    if (kind === 'e') { for (const x of popEr.querySelectorAll('[data-m]')) x.setAttribute('aria-pressed', String(x.dataset.m === eraser.m)); erRange.value = eraser.r; ringSize(eraser.r); armClear(false); }
    else { showColors(); showSizes(); }
    pop.hidden = false;
    const r = btn.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
    pop.style.top = (r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - 6 - h) : r.bottom + 6) + 'px';
  }
  const ringSize = (r) => { const el = popEr.querySelector('.ring'); el.style.width = el.style.height = r * 2 + 'px'; };
  const saveEraser = () => store.set(PREF + ':eraser', JSON.stringify(eraser));
  for (const x of popEr.querySelectorAll('[data-m]')) x.onclick = () => { eraser.m = x.dataset.m; saveEraser(); closePop(); };
  erRange.oninput = () => { eraser.r = +erRange.value; ringSize(eraser.r); };
  erRange.onchange = saveEraser;
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && e.target.closest('button') !== popFor) closePop(); }, true);
  // 全部消す（消しゴムの小窓の中。押し間違えないよう、もう一度押したときだけ消す。戻すで戻せる）
  const clearBtn = $('#clear');
  let armT = 0;
  function armClear(on) {
    clearTimeout(armT); clearBtn.classList.toggle('arm', on);
    clearBtn.textContent = on ? 'もう一度押すと全部消えます' : isPdf() ? 'この PDF の書き込みを全部消す' : 'この章の書き込みを全部消す';
    if (on) armT = setTimeout(() => armClear(false), 3000);
  }
  clearBtn.onclick = () => {
    if (!clearBtn.classList.contains('arm')) return armClear(true);
    armClear(false); closePop();
    if (!strokes.length) return;
    clearSel();
    const list = strokes.slice(); removeAll(list); push({ type: 'erase', list });
    stat.textContent = `${list.length}画を消しました（「戻す」で戻せます）`;
  };
  $('#finger').onclick = (e) => { finger = !finger; e.currentTarget.setAttribute('aria-pressed', String(finger)); page.classList.toggle('finger', finger); };
  $('#hint-x').onclick = () => { $('#hint').hidden = true; store.set(PREF + ':hint', '0'); };
  if (store.get(PREF + ':hint') === '0') $('#hint').hidden = true;

  // ---------- input ----------
  let penDown = false;
  const stylusGuard = (e) => {
    if (penDown) { e.preventDefault(); return; }
    for (const t of e.changedTouches) if (t.touchType === 'stylus' && page.contains(e.target)) { e.preventDefault(); return; }
    if (e.type === 'touchmove' && [...e.touches].some((t) => palms.has(t.identifier))) e.preventDefault();
  };
  // 手のひら・小指: ペンを使っている間と、ペンを離してから PALM_MS（0.3 秒）の間に触れた指は、離すまでスクロール・ピンチ・タップに使わない
  const palms = new Set(), PALM_MS = 300;
  let penAt = -1e9;
  // ペンより先に小指が触れたとき: 触れてから 1 秒以内に（指をつけたままペンを置くことはあまりないので長めでよい）ペンが来たら、その指も手のひらとみなし、指で動いた分の紙を元に戻す
  const touchAt = new Map();   // 指 → 触れた時刻と、そのときのスクロール位置
  const palmWatch = (e) => {
    const now = performance.now(), se = document.scrollingElement;
    for (const t of e.changedTouches) {
      if (t.touchType === 'stylus') penAt = now;
      else if (e.type === 'touchstart') {
        if (penDown || now - penAt < PALM_MS) palms.add(t.identifier);
        else touchAt.set(t.identifier, { t: now, x: wrap.scrollLeft, y: se.scrollTop });
      }
      else if (e.type !== 'touchmove') { palms.delete(t.identifier); touchAt.delete(t.identifier); if (!palms.size) pin = null; }
    }
  };
  function penLands() {
    const now = performance.now();
    let back = null;
    for (const [id, a] of touchAt) if (now - a.t < 1000) { palms.add(id); touchAt.delete(id); if (!back || a.t < back.t) back = a; }
    if (back) { pin = back; keepPin(); }
  }
  // 動き出したスクロールは止められないので、その指を離すまで、紙を戻した位置に留める
  let pin = null;
  function keepPin() {
    if (!pin) return;
    if (!palms.size) { pin = null; return; }
    if (wrap.scrollLeft !== pin.x) wrap.scrollLeft = pin.x;
    if (document.scrollingElement.scrollTop !== pin.y) document.scrollingElement.scrollTop = pin.y;
  }
  addEventListener('scroll', keepPin, { passive: true });
  wrap.addEventListener('scroll', keepPin, { passive: true });
  for (const ty of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) document.addEventListener(ty, palmWatch, { capture: true, passive: true });
  for (const ty of ['pointerdown', 'pointermove', 'pointerup']) document.addEventListener(ty, (e) => {
    if (e.pointerType !== 'pen') return;
    penAt = performance.now();
    if (e.type === 'pointerdown') penLands();
  }, { capture: true, passive: true });
  document.addEventListener('touchstart', stylusGuard, { passive: false });
  document.addEventListener('touchmove', stylusGuard, { passive: false });

  const accepts = (e) => e.pointerType === 'pen' || e.pointerType === 'mouse' || (finger && e.pointerType === 'touch');
  let hold = null, holdC = null, holdT = 0;   // ペンを止めた位置（紙と画面）と、図形に直すまでのタイマー
  // 丸で囲んで長押し: ペンで書いた最後の線が輪なら、その線の上でペンを止めて押さえると、線が消えて中が投げ縄で選ばれる。
  // 選び終わったら（外を押す・解除・削除）ペンに戻る
  let loopCand = null, loopT = 0, loopAt = null, loopBack = null;
  function isLoop(s) {
    if (s.tool !== 'pen' || s.g || s.pts.length < 10) return false;
    let len = 0, a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    s.pts.forEach((q, i) => { if (i) len += Math.hypot(q[0] - s.pts[i - 1][0], q[1] - s.pts[i - 1][1]); a = Math.min(a, q[0]); b = Math.min(b, q[1]); c = Math.max(c, q[0]); d = Math.max(d, q[1]); });
    const A = s.pts[0], B = s.pts[s.pts.length - 1];
    return Math.min(c - a, d - b) > 30 && Math.hypot(B[0] - A[0], B[1] - A[1]) < len * .2;
  }
  function onLoop(x, y) {
    const s = loopCand;
    if (!s || !strokes.includes(s)) return false;
    const ty = top(s), r = 16 / scale + s.s;
    return s.pts.some(([px, py]) => (px - x) ** 2 + (py + ty - y) ** 2 < r * r);
  }
  function loopToLasso() {
    loopT = 0;
    const s = loopCand; loopCand = null;
    if (!cur || !s || !strokes.includes(s)) return;
    cur.el.remove(); cur = null; pending = []; predicted = []; clearTimeout(holdT);
    const ty = top(s), poly = s.pts.map(([x, y]) => [x, y + ty]);
    removeAll([s]); push({ type: 'erase', list: [s] });
    toolBtns[3].click(); loopBack = 'pen';
    lasso = poly; finishLasso();
    // そのままペンを動かすと、選んだ線を動かせる
    if (sel.length) drag = { x: loopAt[0], y: loopAt[1], dx: 0, dy: 0 };
  }
  let cur = null, curId = null, curType = '', curTop = 0, erased = null, pending = [], predicted = [], raf = 0;
  let t0 = 0, samples = 0, frames = 0;

  function toPage(ev) {
    const r = page.getBoundingClientRect();
    const p = ev.pointerType === 'pen' ? (ev.pressure || .05) : .5;
    return [(ev.clientX - r.left) / scale, (ev.clientY - r.top) / scale, p];
  }
  const toRel = (ev) => { const q = toPage(ev); q[1] -= curTop; return q; };
  // 消しゴム: 「線ごと」は触れた線を丸ごと消す。「なぞった所だけ」は触れた部分だけ消し、残りを別々の線にする。
  // 丸の大きさ（画面の px の半径）と種類は、消しゴムをもう一度押すと変えられる（端末に覚える）
  const eraser = (() => { try { return { m: 'stroke', r: 9, ...JSON.parse(store.get(PREF + ':eraser')) }; } catch { return { m: 'stroke', r: 9 }; } })();
  const erRing = document.createElementNS(NS, 'circle'); erRing.setAttribute('class', 'er-ring');
  let pieces = null;   // なぞった所だけ消すときに、この操作で作った線
  function eraseAt([x, y]) {
    const rad = eraser.r / scale;
    erRing.setAttribute('cx', x); erRing.setAttribute('cy', y); erRing.setAttribute('r', rad);
    const hit = [];
    for (const s of strokes) {
      if (s.hid) continue;
      const ty = top(s), [a, b, c, d] = s.bbox, pad = rad + (s.tool === 'hl' ? 8 : s.s);
      if (x < a - pad || x > c + pad || y < b + ty - pad || y > d + ty + pad) continue;
      if (eraser.m === 'part') { cutAt(s, x, y - ty, pad); continue; }
      for (const [px, py] of s.pts) { if ((px - x) ** 2 + (py + ty - y) ** 2 < pad * pad) { hit.push(s); break; } }
    }
    if (hit.length) { removeAll(hit); erased.push(...hit); }
  }
  function cutAt(s, x, y, pad) {
    // 点の間が丸より広いと素通りするので、細かく点を足してから、丸の中の点を除く
    const step = Math.max(1, pad / 2), dense = [];
    s.pts.forEach((q, i) => {
      if (i) { const r = s.pts[i - 1], n = Math.ceil(Math.hypot(q[0] - r[0], q[1] - r[1]) / step); for (let k = 1; k < n; k++) dense.push([r[0] + (q[0] - r[0]) * k / n, r[1] + (q[1] - r[1]) * k / n, r[2] + (q[2] - r[2]) * k / n]); }
      dense.push(q);
    });
    const runs = []; let run = [], cut = false;
    for (const q of dense) { if ((q[0] - x) ** 2 + (q[1] - y) ** 2 < pad * pad) { cut = true; if (run.length) runs.push(run); run = []; } else run.push(q); }
    if (run.length) runs.push(run);
    if (!cut) return;
    removeAll([s]);
    if (pieces.has(s)) pieces.delete(s); else erased.push(s);
    for (const pts of runs) {
      if (pts.length < 2) continue;
      const n = { id: newId(), b: s.b, tool: s.tool, c: s.c, s: s.s, pen: s.pen, pts };
      bbox(n); addAll([n]); pieces.add(n);
    }
  }
  function endErase() {
    erRing.remove();
    if (pieces && (erased.length || pieces.size)) push({ type: 'replace', from: erased, to: [...pieces] });
    else if (erased.length) push({ type: 'erase', list: erased });
    erased = null; pieces = null;
  }
  // 往復の多い線（ぐちゃぐちゃ）なら、その線が囲む範囲に半分以上入る既存の線を返す。該当なしなら null
  // 折り返しは縦横それぞれで数える（横の往復・縦のギザギザ・くるくる、どれでも拾う）
  function turnsOn(pts, ax, minRun) {
    let turns = 0, dir = 0, anchor = pts[0][ax];
    for (const p of pts) {
      const dv = p[ax] - anchor;
      if (dir >= 0 && dv < -minRun) { if (dir > 0) turns++; dir = -1; anchor = p[ax]; }
      else if (dir <= 0 && dv > minRun) { if (dir < 0) turns++; dir = 1; anchor = p[ax]; }
      else if ((dir > 0 && dv > 0) || (dir < 0 && dv < 0)) anchor = p[ax];
    }
    return turns;
  }
  function convexHull(p) {
    p = p.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]), lo = [], up = [];
    for (const q of p) { while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (const q of p.reverse()) { while (up.length > 1 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }
  function segDist(x, y, [x0, y0], [x1, y1]) {
    const dx = x1 - x0, dy = y1 - y0, l = dx * dx + dy * dy, k = l ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / l)) : 0;
    return Math.hypot(x - x0 - k * dx, y - y0 - k * dy);
  }
  function scribbleTargets(s) {
    const pts = s.pts;
    if (pts.length < 12) return null;
    const ty = top(s);
    const [a, b0, c, d0] = s.bbox, b = b0 + ty, d = d0 + ty, w = c - a, h = d - b;
    // 決まった幅（px）は画面の px で考える。紙の px のままだと、拡大したときに周りの字まで巻き込む
    const u = 1 / scale;
    if (Math.max(w, h) < 8 * u) return null;
    const tx = turnsOn(pts, 0, Math.max(3 * u, w * .3)), tz = turnsOn(pts, 1, Math.max(3 * u, h * .3));
    // 5回以上折り返す（m・w は3回、続け書きの漢字もたいてい4回まで）。横長・縦長の範囲を長く往復するなら3回でよい
    const r = Math.max(w, h) / Math.max(1, Math.min(w, h)), long = w >= h ? tx : tz;
    if (Math.max(tx, tz) < 5 && !(r >= 2 && long >= 3)) return null;
    // 消すのは、ぐちゃぐちゃの線が囲む範囲（点の凸包）の中に半分以上ある線。凸包の外へは、ぐちゃぐちゃの太さの半分と画面 2px だけ広げる
    // 小さな線（画面 10px 未満か、ぐちゃぐちゃの幅の半分未満。添え字・濁点など）は、2割入っていれば消す
    // 範囲のすぐ外（画面 6px まで）にある小さな線（濁点・点・はね）は、消える字にくっついていれば一緒に消す
    const hull = convexHull(pts.map(([x, y]) => [x, y + ty])), m = s.s / 2 + 2 * u, m2 = m + 6 * u, hit = [], bits = [];
    const near = (x, y, r) => inPoly(x, y, hull) || hull.some((q, k) => segDist(x, y, q, hull[(k + 1) % hull.length]) < r);
    for (const o of strokes) {
      if (o.hid) continue;
      const oy = top(o), [oa, ob, oc, od] = o.bbox;
      if (oc < a - m2 || oa > c + m2 || od + oy < b - m2 || ob + oy > d + m2) continue;
      const small = Math.max(oc - oa, od - ob) < Math.max(10 * u, Math.min(w, h) * .5);
      let inside = 0;
      for (const [x, y] of o.pts) if (near(x, y + oy, m)) inside++;
      if (inside / o.pts.length >= (small ? .2 : .5)) hit.push(o);
      else if (small && o.pts.filter(([x, y]) => near(x, y + oy, m2)).length / o.pts.length >= .5) bits.push(o);
    }
    const g = 5 * u, touch = (o, v) => o.bbox[0] < v.bbox[2] + g && o.bbox[2] > v.bbox[0] - g && o.bbox[1] + top(o) < v.bbox[3] + top(v) + g && o.bbox[3] + top(o) > v.bbox[1] + top(v) - g;
    for (const o of bits) if (hit.some((v) => touch(o, v))) hit.push(o);
    return hit.length ? hit : null;
  }
  // ---------- 投げ縄 ----------
  // 囲んだ線を選び、ドラッグで移動・色や太さの変更・削除ができる。
  // 移動や変更は「元の線を消して新しい線を足す」操作として記録し、移動先の段落に付け直す
  let sel = [], picked = [], lassoBox = null, lasso = null, drag = null;   // picked: 囲んだ段落の番号
  const lassoEl = document.createElementNS(NS, 'path'); lassoEl.setAttribute('class', 'lasso');
  const selEl = document.createElementNS(NS, 'rect'); selEl.setAttribute('class', 'sel'); selEl.setAttribute('rx', 6);
  const selMenu = $('#selmenu');
  function inPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function selBox() {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const s of sel) { const ty = top(s), pad = s.tool === 'hl' ? 8 : s.s; a = Math.min(a, s.bbox[0] - pad); b = Math.min(b, s.bbox[1] + ty - pad); c = Math.max(c, s.bbox[2] + pad); d = Math.max(d, s.bbox[3] + ty + pad); }
    return [a - 6, b - 6, c + 6, d + 6];
  }
  function showSel(dx = 0, dy = 0) {
    if (!sel.length && !picked.length) { selEl.remove(); selMenu.hidden = true; return; }
    const [a, b, c, d] = sel.length ? selBox() : lassoBox;
    selEl.setAttribute('x', a + dx); selEl.setAttribute('y', b + dy);
    selEl.setAttribute('width', c - a); selEl.setAttribute('height', d - b);
    svg.appendChild(selEl);
    selMenu.hidden = false;
    selMenu.style.left = Math.max(0, (a + dx) * scale) + 'px';
    selMenu.style.top = Math.max(0, (b + dy) * scale - selMenu.offsetHeight - 8) + 'px';
    $('#sel-n').textContent = sel.length ? `${sel.length}画` : `${picked.length}${isPdf() ? 'ページ' : '段落'}`;
    $('#sel-del').hidden = !sel.length;
    selPen.hidden = !sel.some((s) => s.tool !== 'hl');
    // 余白・白紙: 囲んだ最後の段落（ページ）の下に足す。囲んだ範囲が足した部分にかかっていれば、消すこともできる
    const last = picked[picked.length - 1], box = sel.length ? selBox() : lassoBox;
    $('#sel-gap').hidden = isPdf() || sel.length > 0 || !last;
    $('#sel-ungap').hidden = !box || !spaceIn(box);
  }
  function clearSel() {
    sel = []; picked = []; drag = null; lassoEl.remove(); showSel(); if (tool === 'ls') setEdit(null);
    if (popFor === selPen) closePop();
    if (loopBack) { loopBack = null; toolBtns[0].click(); }   // 丸で囲んで選んだときは、選び終わったらペンに戻る
  }
  function finishLasso() {
    const poly = lasso; lasso = null; lassoEl.remove();
    if (poly.length < 3) return;
    if (lineGesture(poly)) return;
    sel = strokes.filter((s) => {
      if (s.hid) return false;
      const ty = top(s); let n = 0;
      for (const [x, y] of s.pts) if (inPoly(x, y + ty, poly)) n++;
      return n >= s.pts.length / 2;
    });
    // 囲んだ範囲にかかる段落と、選んだ線の段落（「Claudeに聞く」で渡す本文）
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const [x, y] of poly) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
    lassoBox = [a, b, c, d];
    const set = new Set(sel.map((s) => s.b));
    blocks.forEach((el, i) => { if (i > 0 && tops[i] < d && tops[i] + el.offsetHeight > b) set.add(i); });
    picked = [...set].sort((x, y) => x - y);
    showSel(); setEdit(sel.length === 1 ? sel[0] : null);
    stat.textContent = sel.length ? `${sel.length}画を選択（ドラッグで移動・「色・太さ」で変更）` : picked.length ? `${picked.length}${isPdf() ? 'ページ' : '段落'}を選択` : '囲んだ中に何もありません';
  }
  // 選んだ線を作り直す（移動量 dx,dy と、色・太さの変更 patch）
  function rebuild(dx, dy, patch) {
    const from = sel, to = from.map((s) => {
      const ty = top(s);
      const abs = s.pts.map(([x, y, p]) => [x + dx, y + ty + dy, p]);
      let minY = Infinity; for (const q of abs) minY = Math.min(minY, q[1]);
      const b = blockAt(minY), t = tops[b] - (toSto(b, minY - tops[b]) - (minY - tops[b]));   // たたんだ余白の下なら、開いたときの位置にする
      const n = { id: newId(), b, tool: s.tool, c: s.c, s: s.s, pen: s.pen, pts: abs.map(([x, y, p]) => [x, y - t, p]), ...patch };
      if (s.g) n.g = moveG(s.g, dx, ty + dy - t);
      bbox(n); return n;
    });
    removeAll(from); addAll(to);
    push({ type: 'replace', from, to });
    sel = to; showSel(); setEdit(sel.length === 1 ? sel[0] : null);
  }
  function restyle(patch) {
    const sub = patch.s != null ? { s: patch.s } : { c: patch.c };
    if (!sel.some((s) => s.tool !== 'hl')) return;
    const keep = sel.filter((s) => s.tool === 'hl');
    const all = sel; sel = all.filter((s) => s.tool !== 'hl');
    rebuild(0, 0, sub);
    sel = sel.concat(keep); showSel();
  }
  $('#sel-del').onclick = () => { if (!sel.length) return; const list = sel; removeAll(list); push({ type: 'erase', list }); clearSel(); stat.textContent = `${list.length}画を消しました`; };
  $('#sel-x').onclick = clearSel;
  $('#sel-gap').onclick = () => { const b = picked[picked.length - 1]; clearSel(); addGap(b); stat.textContent = '余白を入れました'; };
  $('#sel-ungap').onclick = () => { const r = spaceIn(sel.length ? selBox() : lassoBox); clearSel(); if (r) removeSpace(r.b, r.i); stat.textContent = '余白を消しました'; };
  // 囲んだ範囲にかかる余白（いちばん下のもの）
  const spaceIn = (box) => spaceRects().filter((r) => box[3] > r.y0 && box[1] < r.y0 + r.h).pop();
  // 横にまっすぐ引いた線（幅が紙の 1/3 以上、高さ 30px 以下、始めと終わりが離れている）なら、そこに余白を入れる
  function lineGesture(poly) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity, sum = 0;
    for (const [x, y] of poly) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); sum += y; }
    const [x0] = poly[0], [x1] = poly[poly.length - 1];
    if (c - a < W / 3 || d - b > 30 || Math.abs(x1 - x0) < (c - a) * .6) return false;
    clearSel();
    stat.textContent = lineSpace(sum / poly.length) ?? '';
    return true;
  }
  function lassoDown(e) {
    const [x, y] = toPage(e);
    if (sel.length) {
      const [a, b, c, d] = selBox();
      if (x >= a && x <= c && y >= b && y <= d) { drag = { x, y, dx: 0, dy: 0 }; selMenu.hidden = true; return; }
    }
    if (sel.length || picked.length) clearSel();
    if (tool !== 'ls') return;
    lasso = [[x, y]];
    lassoEl.setAttribute('d', ''); svg.appendChild(lassoEl);
  }
  function lassoMove(list) {
    const last = toPage(list[list.length - 1]);
    if (drag) {
      drag.dx = last[0] - drag.x; drag.dy = last[1] - drag.y;
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0; if (!drag) return;
        for (const s of sel) s.el.setAttribute('transform', `translate(${drag.dx} ${top(s) + drag.dy})`);
        showSel(drag.dx, drag.dy); selMenu.hidden = true;
      });
      return;
    }
    if (!lasso) return;
    for (const ev of list) { const [x, y] = toPage(ev); lasso.push([x, y]); }
    if (!raf) raf = requestAnimationFrame(() => {
      raf = 0; if (!lasso) return;
      lassoEl.setAttribute('d', 'M' + lasso.map(([x, y]) => `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`).join('L') + 'Z');
    });
  }
  function lassoUp() {
    if (drag) {
      const { dx, dy } = drag; drag = null;
      if (Math.hypot(dx, dy) < 2) { for (const s of sel) place(s); showSel(); return; }
      rebuild(dx, dy, {});
      picked = [...new Set([...picked, ...sel.map((s) => s.b)])].sort((x, y) => x - y);
      stat.textContent = `${sel.length}画を移動しました`;
      return;
    }
    if (lasso) finishLasso();
  }

  // ---------- Claudeに聞く ----------
  // 選んだ段落の本文（数式は TeX に戻す）と手書きの画像を、質問と一緒に Claude アプリへ渡す。
  // サブスクの範囲で使うため API は呼ばず、共有シート・クリップボード・claude.ai/new?q= を使う
  const INK = { k: '#15181f', r: '#d0302a', b: '#1d56d8' };
  function blockMd(el) {
    const c = el.cloneNode(true);
    for (const k of c.querySelectorAll('.katex-display')) { const t = k.querySelector('[data-tex]'); k.replaceWith(`\n$$${t ? t.dataset.tex : ''}$$\n`); }
    for (const k of c.querySelectorAll('.katex[data-tex]')) k.replaceWith(`$${k.dataset.tex}$`);
    for (const i of c.querySelectorAll('img')) i.replaceWith(`[${i.alt || '図'}]`);
    const t = c.textContent.trim();
    return /^H[1-6]$/.test(el.tagName) ? '#'.repeat(+el.tagName[1]) + ' ' + t : t;
  }
  const pagesText = () => picked[0] + (picked.length > 1 ? '〜' + picked[picked.length - 1] : '') + 'ページ';
  function passage() {
    if (isPdf()) return `${pagesText()}（囲んだ範囲を画像で送ります）`;
    const out = [];
    const first = picked[0];
    for (let i = first - 1; i > 0; i--) if (/^H[1-6]$/.test(blocks[i].tagName)) { out.push(blockMd(blocks[i])); if (i < first - 1) out.push('…'); break; }
    for (const i of picked) out.push(blockMd(blocks[i]));
    return out.join('\n\n');
  }
  function inkImage() {   // 選んだ段落の書き込み（なければ選んだ線）を白地の PNG に
    const list = strokes.filter((s) => !s.hid && (picked.includes(s.b) || sel.includes(s)));
    if (!list.length) return null;
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const s of list) { const ty = top(s); a = Math.min(a, s.bbox[0]); b = Math.min(b, s.bbox[1] + ty); c = Math.max(c, s.bbox[2]); d = Math.max(d, s.bbox[3] + ty); }
    const pad = 20, k = 2, cv = document.createElement('canvas');
    cv.width = Math.ceil((c - a + 2 * pad) * k); cv.height = Math.ceil((d - b + 2 * pad) * k);
    const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    g.scale(k, k); g.translate(pad - a, pad - b);
    drawInk(g, list);
    return cv;
  }
  function drawInk(g, list, ty = top) {
    for (const s of [...list].sort((x, y) => (y.tool === 'hl') - (x.tool === 'hl'))) {
      g.save(); g.translate(0, ty(s));
      g.fillStyle = s.tool === 'hl' ? 'rgba(255,213,61,.45)' : INK[s.c] || (/^#/.test(s.c) ? s.c : INK.k);
      g.fill(new Path2D(s.el.getAttribute('d')));
      g.restore();
    }
  }
  // PDF は本文の文字を取らず、囲んだ範囲をページの絵と書き込みごと画像にする
  function pdfImage() {
    let [a, b, c, d] = lassoBox;
    if (sel.length) { const q = selBox(); a = Math.min(a, q[0]); b = Math.min(b, q[1]); c = Math.max(c, q[2]); d = Math.max(d, q[3]); }
    a = Math.max(0, a); c = Math.min(W, c);
    if (c - a < 4 || d - b < 4) return null;
    const k = Math.min(3, Math.sqrt(4e6 / ((c - a) * (d - b)))), cv = document.createElement('canvas');
    cv.width = Math.ceil((c - a) * k); cv.height = Math.ceil((d - b) * k);
    const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    g.scale(k, k); g.translate(-a, -b);
    for (const n of picked) {
      const p = drawn.get(n), ky = p && p.cv.height / pageH(n);
      if (p && p.cv.width) for (const s of segs(n)) g.drawImage(p.cv, 0, s.c0 * ky, p.cv.width, (s.c1 - s.c0) * ky, 0, tops[n] + s.v, W, s.c1 - s.c0);
    }
    drawInk(g, strokes.filter((s) => { if (s.hid) return false; const ty = top(s); return s.bbox[2] > a && s.bbox[0] < c && s.bbox[3] + ty > b && s.bbox[1] + ty < d; }));
    return cv;
  }
  let askImg = null, askId = '';
  // ドライブにつないでいるとき: 書き込み・画像・答えはドライブにあるので、場所と答えの置き方を伝える（Claude のドライブ連携で読む）
  const viaDrive = () => driveOn();
  const driveDir = () => 'Ink Reader/' + bookDir();
  // 答えの置き方。Claude アプリでも sakai_study のセッションでも同じ
  const answerText = () => `答えはチャットで返したうえで、Google ドライブの「${driveDir()}/answers」に新しいファイル「${CH}-${askId}.md」を作って保存してください。1行目は <!-- ink-answer id=${askId} b=${picked.join(',')} --> にします。`;
  function driveText() {
    const ch = book && book.chapters.find((c) => c.id === CH), q = $('#ask-q').value.trim(), d = driveDir();
    return [
      `Ink Reader からの質問です。Google ドライブの「${d}」フォルダの本について聞きます（先に「Ink Reader/README.md」を読んでください）。`,
      isPdf() ? `PDF「${book.title || ''}」の ${pagesText()}。ページの画像（手書き入り）: ${picked.map((n) => d + '/view/p' + n + '.png').join(' ')}`
        : `本「${book.title || ''}」 ${ch ? ch.label : ''}（${isLocal() ? d + '/chapters/' + CH + '.md' : `本文は GitHub の ${cfg.repo} の ${cfg.book}/${ch ? ch.file : ''}`}） 段落番号: ${picked.join(', ')}`,
      askImg ? `囲んだ範囲の画像（手書き入り）: ${d}/asks/${askId}.png` : null,
      isPdf() ? null : '\n該当箇所:\n"""\n' + passage() + '\n"""',
      '', `質問: ${q || 'この箇所を分かりやすく説明してください'}`, '',
      answerText(),
    ].filter((v) => v != null).join('\n');
  }
  // 聞く前に、書き込みと画像をドライブに置く
  async function upAsk() {
    addAsk({ id: askId, b: picked.slice(), q: $('#ask-q').value.trim() });
    if (cs && cs.pending.size) pushChapter(CH);
    try {
      if (askImg) await drive.put(bookDir() + '/asks/' + askId + '.png', await pngOf(askImg), null);
      if (isPdf()) await upPages(bookDir(), bookKey(), picked.slice(), true, drive);
    } catch (e) { if (e.drive) needLogin(); }
  }
  function askText(withImg) {
    if (viaDrive()) return driveText();
    const ch = book && book.chapters.find((c) => c.id === CH);
    const q = $('#ask-q').value.trim();
    if (isPdf()) return [
      `PDF「${book.title}」の${pagesText()}を読んでいて質問があります。`, '',
      withImg ? '添付の画像は、その箇所を切り出したものです（私の手書きの書き込みも入っています）。' : '該当箇所の画像は別に貼り付けます。',
      `質問: ${q || '（この箇所を分かりやすく説明してください）'}`,
    ].join('\n');
    return [
      `「${book.title || book.source || ''}」${ch ? ' ' + ch.label : ''} を読んでいて質問があります。`,
      '', '該当箇所（Markdown、数式は TeX）:', '"""', passage(), '"""', '',
      withImg ? '添付の画像は、この箇所に私が手書きで書き込んだものです。' : null,
      `質問: ${q || '（この箇所を分かりやすく説明してください）'}`,
    ].filter((v) => v != null).join('\n');
  }
  $('#sel-ask').onclick = () => {
    if (!picked.length) return;
    askId = Math.random().toString(36).slice(2, 8);
    askImg = isPdf() ? pdfImage() : inkImage();
    $('#ask-pv').textContent = passage();
    $('#ask-img').hidden = !askImg;
    if (askImg) $('#ask-img').src = askImg.toDataURL('image/png');
    $('#ask-msg').textContent = '';
    $('#ask-sess').value = cfg.session || ''; syncSess();
    $('#ask').showModal();
    links();
  };
  async function copy(t) { try { await navigator.clipboard.writeText(t); return true; } catch { return false; } }
  // Claude を開くボタンは本物のリンク（新しいタブを使うと、iPad の Chrome に空のタブが残るため）。
  // href は質問を書き換えるたびに作り直し、押したときは質問文のコピーだけをする
  const newUrl = () => 'https://claude.ai/code/new?' + new URLSearchParams({ q: codeText(), repo: cfg.repo, branch: cfg.branch });
  function links() {
    if (!picked.length) return;
    $('#ask-open').href = 'https://claude.ai/new?q=' + encodeURIComponent(askText(false));
    $('#ask-code').href = sessUrl() || newUrl();
    $('#ask-new').href = newUrl();
  }
  $('#ask-q').addEventListener('input', links);
  $('#ask-open').onclick = async () => {
    const ok = await copy(askText(false));
    if (viaDrive()) { $('#ask-msg').textContent = (ok ? '質問文をコピーしました。' : '') + 'Claude でドライブの連携をオンにして聞いてください'; upAsk(); return; }
    $('#ask-msg').textContent = (ok ? '質問文をコピーしました。' : '') + (askImg ? '手書きの画像も送るときは「共有」を使ってください。' : '');
  };
  // sakai_study のリポジトリで Claude Code のセッションを開く。本文と書き込みはリポジトリにあるので、場所を伝える
  // いつものセッション（claude.ai/code/<id>）があればそれを開いて質問文を貼ってもらう。なければ新しいセッションを質問文つきで開く
  const sessUrl = () => { const v = (cfg.session || '').trim(), m = v.match(/\/code\/([\w-]+)/); const id = m ? m[1] : /^[\w-]+$/.test(v) ? v : ''; return id && id !== 'new' ? 'https://claude.ai/code/' + id : ''; };
  function syncSess() {
    $('#ask-code').textContent = sessUrl() ? 'いつものセッションで聞く' : 'sakai_studyで聞く（新しいセッション）';
    // ファイルから開いた本は sakai_study にないので、Claude アプリに渡す方だけ
    const noRepo = isLocal();
    $('#ask-new').hidden = !sessUrl() || noRepo;
    $('#ask-code').hidden = $('.sess').hidden = noRepo;
    // PDF は画像がないと伝わらないので、ドライブにつないでいなければ、画像を渡せる「共有」を主にする
    $('#ask-open').classList.toggle('primary', isLocal() && (driveOn() || !isPdf()));
    $('#ask-share').classList.toggle('primary', isLocal() && !driveOn() && isPdf());
  }
  $('#ask-sess').onchange = () => { cfg.session = $('#ask-sess').value.trim(); store.set(PREF + ':cfg', JSON.stringify(cfg)); syncSess(); links(); };
  // GitHub の本を sakai_study のセッションで聞く。本文はリポジトリ、手書きの画像と答えはドライブ。
  // 答えたあと、セッションは CLAUDE.md の手順で理解度のまとめ（GitHub）に記録する
  function codeText() {
    const ch = book.chapters.find((c) => c.id === CH), q = $('#ask-q').value.trim();
    return [
      `Ink Reader からの質問です（CLAUDE.md の「Ink Reader からの質問」を参照）。`,
      `本: ${cfg.book}（${book.title || ''}） 章: ${CH}「${ch ? ch.label : ''}」 本文: ${cfg.book}/${ch ? ch.file : ''}`,
      `段落番号: ${picked.join(', ')}`,
      viaDrive() && askImg ? `手書きの画像（Google ドライブ）: ${driveDir()}/asks/${askId}.png` : null,
      '', '該当箇所:', '"""', passage(), '"""', '',
      `質問: ${q || 'この箇所を分かりやすく説明してください'}`, '',
      viaDrive() ? answerText() + 'そのあと CLAUDE.md の手順で、理解度のまとめに記録して push してください。'
        : `答えはチャットで返してください（アプリがドライブにつながっていないので、手書きは届かず、答えもアプリには戻りません。質問ID: ${askId}）。`,
    ].filter((v) => v != null).join('\n');
  }
  async function askCode(fresh) {
    const t = codeText(), url = fresh ? '' : sessUrl();
    const ok = await copy(t);
    if (viaDrive()) upAsk();   // 手書きの画像と書き込みを先にドライブへ
    $('#ask-msg').textContent = (url ? (ok ? '質問文をコピーしました。セッションに貼り付けて送ってください。' : 'コピーできませんでした。') : (ok ? '質問文をコピーしました。' : '') + '開いたセッションのURLを下に入れておくと、次から同じセッションで聞けます。')
      + (viaDrive() ? '' : '（ドライブにつながっていないので、手書きと答えはアプリに戻りません）');
  }
  $('#ask-code').onclick = () => askCode(false);
  $('#ask-new').onclick = () => askCode(true);
  $('#ask-share').onclick = async () => {
    const t = askText(!!askImg);
    if (viaDrive()) upAsk();
    try {
      const files = askImg ? [new File([await new Promise((r) => askImg.toBlob(r, 'image/png'))], 'ink.png', { type: 'image/png' })] : [];
      const data = files.length && navigator.canShare && navigator.canShare({ files }) ? { text: t, files } : { text: t };
      await copy(t);
      await navigator.share(data);
      $('#ask-msg').textContent = '共有シートで Claude を選んでください（質問文はコピー済みです）';
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      $('#ask-msg').textContent = (await copy(t)) ? 'この端末では共有できないので、質問文をコピーしました' : '共有できませんでした';
    }
  };

  // ---------- Claude の答え ----------
  // 聞いた質問に、Claude がドライブの <本>/answers/<章>-<質問ID>.md を新しく作って答える（ドライブ連携は上書きできないので 1 問 1 ファイル）。
  // 前は GitHub の本の答えを sakai_study の <本>/answers/<章>.md に追記していた（moveGhBook が 1 問ずつに分けてドライブへ写す）。
  // 答えごとに `<!-- ink-answer id=<質問ID> b=<段落番号,…> -->` の行で始め、その下が答えの md（数式つき）。
  // 質問した段落の右余白に「Q」を出し（答え待ちは薄く）、押すと段落の下に答えを開く。答えの要素は blocks に入れない
  const ansKey = (id) => 'ans:' + bookKey() + ':' + id, askKey = (id) => 'asks:' + bookKey() + ':' + id;
  const qs = $('#qs');
  let answers = [], asks = [], ansMd = null, openQ = new Set();   // 今の章の答え [{id,b,md}]・答え待ち [{id,b,q}]・開いている段落
  function parseAnswers(md) {
    const out = []; let cur = null;
    for (const line of (md || '').split('\n')) {
      const m = line.match(/^<!--\s*ink-answer\s+(.*?)\s*-->\s*$/);
      if (m) {
        const a = Object.fromEntries([...m[1].matchAll(/(\w+)=(\S+)/g)].map((x) => [x[1], x[2]]));
        cur = { id: a.id || '', b: (a.b || '').split(',').map(Number).filter((n) => n > 0), lines: [] };
        if (cur.b.length) out.push(cur);
      } else if (cur) cur.lines.push(line);
    }
    return out.map((a) => ({ id: a.id, b: a.b, md: a.lines.join('\n').trim() })).reverse();   // 新しい順
  }
  // 追記してきた答えのファイルを、答えごとの { id, text } に分ける（text は区切りの行から）
  function splitAnswers(md) {
    const out = [];
    for (const line of (md || '').split('\n')) {
      const m = line.match(/^<!--\s*ink-answer\s+(.*?)\s*-->\s*$/);
      if (m) out.push({ id: ((m[1].match(/(?:^|\s)id=(\S+)/) || [])[1] || 'a' + out.length).replace(/[^\w-]/g, ''), lines: [line] });
      else if (out.length) out[out.length - 1].lines.push(line);
    }
    return out.map((a) => ({ id: a.id, text: a.lines.join('\n').trim() + '\n' }));
  }
  const anchor = (x) => Math.min(...x.b);   // 何段落かにまたがる質問は、最初の段落に付ける
  function setAnswers(md, list) {
    ansMd = md; answers = parseAnswers(md); asks = list || asks;
    const n = asks.length;
    asks = asks.filter((q) => !answers.some((a) => a.id === q.id));   // 答えが届いた質問は答え待ちから外す
    if (asks.length !== n) kv.set(askKey(CH), asks).catch(() => {});
    showMarks();
  }
  function addAsk(q) {
    if (!CH || !hasRemote() || asks.some((x) => x.id === q.id)) return;   // 答えが戻るのは、ドライブにつないでいるときだけ
    asks.push(q); kv.set(askKey(CH), asks).catch(() => {});
    showMarks();
  }
  function showMarks() {
    for (const el of doc.querySelectorAll('.ans')) el.remove();
    const g = new Map();
    for (const x of [...asks].reverse().concat(answers)) { const k = anchor(x); if (blocks[k]) g.set(k, (g.get(k) || 0) + 1); }
    qs.replaceChildren(...[...g].map(([k, n]) => {
      const m = document.createElement('button');
      m.type = 'button'; m.className = 'qm'; m.dataset.b = k; m.textContent = n > 1 ? 'Q' + n : 'Q';
      m.classList.toggle('wait', !answers.some((a) => anchor(a) === k));
      m.setAttribute('aria-expanded', String(openQ.has(k)));
      m.setAttribute('aria-label', 'Claudeの答え');
      return m;
    }));
    for (const k of openQ) if (g.has(k)) openAns(k);
    placeMarks();
  }
  function placeMarks() { for (const m of qs.children) m.style.top = (tops[+m.dataset.b] || 0) + 'px'; }
  function openAns(k) {
    const box = document.createElement('aside');
    box.className = 'ans'; box.dataset.b = k;
    for (const q of asks.filter((x) => anchor(x) === k).reverse()) {
      const d = document.createElement('div'); d.className = 'wait';
      d.textContent = `答えを待っています${q.q ? '：' + q.q : ''}`;
      const x = document.createElement('button'); x.type = 'button'; x.textContent = '取り消す';
      x.onclick = () => { asks = asks.filter((a) => a !== q); kv.set(askKey(CH), asks).catch(() => {}); showMarks(); };
      d.append(x); box.append(d);
    }
    for (const a of answers.filter((x) => anchor(x) === k)) {
      const d = document.createElement('div'); d.className = 'a';
      d.innerHTML = renderMarkdown(a.md, book && book.images);
      box.append(d);
    }
    blocks[k].after(box);
  }
  function toggleAns(k) {
    if (openQ.has(k)) openQ.delete(k); else openQ.add(k);
    showMarks();
  }
  // Pencil で押したときは click が来ない（書くために touchstart を止めている）ので pointerup で開閉する
  let qDown = null;
  qs.addEventListener('pointerdown', (e) => { qDown = e.target.closest('.qm'); });
  qs.addEventListener('pointerup', (e) => { const m = e.target.closest('.qm'); if (m && m === qDown) toggleAns(+m.dataset.b); qDown = null; });
  qs.addEventListener('click', (e) => { const m = e.target.closest('.qm'); if (m && e.detail === 0) toggleAns(+m.dataset.b); });   // キーボード
  // 答えは <本>/answers/<章>-<質問ID>.md。一覧は 1 回で取り、中身は前に読んだ版から変わったものだけ読む（端末に覚えておく）
  async function pullAnswers(id) {
    if (!canPush() || !ghMoved()) return;   // GitHub の本は、答えをドライブへ写し終えてから
    try {
      const R = where(), dir = bookDir(), fk = 'ansf:' + bookKey() + ':' + id, had = (await kv.get(fk)) || {}, now = {};
      let md = '';
      for (const f of await R.list(dir + '/answers')) {
        if (!f.name.startsWith(id + '-') || !/\.md$/.test(f.name)) continue;
        now[f.name] = had[f.name] && had[f.name].v === f.v ? had[f.name] : { v: f.v, text: await R.read(f) };
        md += '\n' + now[f.name].text;
      }
      kv.set(fk, now).catch(() => {});
      if (id !== CH || md === ansMd) return;
      kv.set(ansKey(id), md).catch(() => {});
      setAnswers(md);
      if (asks.length === 0 && answers.length) stat.textContent = 'Claudeの答えが届いています（右の「Q」）';
    } catch {}
  }

  function frame() {
    raf = 0; frames++;
    if (!cur) return;
    if (pending.length) { cur.pts.push(...pending); pending = []; }
    render(cur, predicted.length ? cur.pts.concat(predicted) : cur.pts, false);
  }

  // 図形（g）から線の点の列を作る。g = { k: 'line'|'poly'|'ellipse'|'circle', v, a（傾き）, p（筆圧） }
  // line・poly の v は頂点、ellipse・circle の v は [中心, [横の半径, 縦の半径]]。座標は線と同じ（段落の上端から）
  function genPts(g) {
    const p = g.p, out = [];
    if (g.k === 'line' || g.k === 'poly') {
      const list = g.v, closed = g.k === 'poly', n = closed ? list.length : list.length - 1;
      for (let i = 0; i < n; i++) {
        const [x0, y0] = list[i], [x1, y1] = list[(i + 1) % list.length], k = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 3));
        for (let j = 0; j < k; j++) out.push([x0 + (x1 - x0) * j / k, y0 + (y1 - y0) * j / k, p]);
      }
      const last = closed ? list[0] : list[list.length - 1]; out.push([last[0], last[1], p]);
      return out;
    }
    const [[cx, cy], [rx, ry]] = g.v, a = g.a || 0, ca = Math.cos(a), sa = Math.sin(a);
    for (let i = 0; i <= 72; i++) { const t = i / 72 * 2 * Math.PI, x = rx * Math.cos(t), y = ry * Math.sin(t); out.push([cx + x * ca - y * sa, cy + x * sa + y * ca, p]); }
    return out;
  }
  const NAMES = { line: '直線', poly: '多角形', ellipse: '楕円', circle: '円' };
  const moveG = (g, dx, dy) => ({ ...g, v: g.k === 'ellipse' || g.k === 'circle' ? [[g.v[0][0] + dx, g.v[0][1] + dy], g.v[1]] : g.v.map(([x, y]) => [x + dx, y + dy]) });
  // 水平・垂直に近い向き（10度まで）と斜め45度に近い向き（4度まで）はそろえる
  const DEG = Math.PI / 180;
  function snapAngle(a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], ang = Math.atan2(dy, dx), r = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
    const axis = Math.round(r / (Math.PI / 4)) % 2 === 0;
    if (Math.abs(ang - r) > (axis ? 10 : 4) * DEG) return b;
    const l = Math.hypot(dx, dy); return [a[0] + l * Math.cos(r), a[1] + l * Math.sin(r)];
  }
  // 傾きを、水平・垂直から tol 以内なら一番近い 90 度の倍数にそろえる
  const snapRot = (a, tol = 8 * DEG) => { const r = Math.round(a / (Math.PI / 2)) * (Math.PI / 2); return Math.abs(a - r) < tol ? r : a; };
  // 多角形の辺のどれかが水平・垂直に近ければ、重心のまわりに回してその辺をそろえる
  function axisPoly(v, tol = 8 * DEG) {
    let best = Infinity;
    v.forEach((q, i) => { const r = v[(i + 1) % v.length], a = Math.atan2(r[1] - q[1], r[0] - q[0]), d = snapRot(a, Infinity) - a; if (Math.abs(d) < Math.abs(best)) best = d; });
    if (!(Math.abs(best) < tol) || !best) return v;
    const c = v.reduce((m, [x, y]) => [m[0] + x / v.length, m[1] + y / v.length], [0, 0]), cr = Math.cos(best), sr = Math.sin(best);
    return v.map(([x, y]) => { const dx = x - c[0], dy = y - c[1]; return [c[0] + dx * cr - dy * sr, c[1] + dx * sr + dy * cr]; });
  }
  // 手書きの線を図形に直す。点の列 [[x,y,p]] から、直線・円（楕円）・三角形・四角形のどれかに近ければその図形 g を返す
  function fitShape(pts) {
    if (pts.length < 6) return null;
    // ペンを止めている間の細かいぶれで長さが増えないよう、2.5px より近い点は飛ばす
    const ds = [pts[0]]; for (const q of pts) { const l = ds[ds.length - 1]; if (Math.hypot(q[0] - l[0], q[1] - l[1]) >= 2.5) ds.push(q); }
    ds.push(pts[pts.length - 1]);
    let len = 0; for (let i = 1; i < ds.length; i++) len += Math.hypot(ds[i][0] - ds[i - 1][0], ds[i][1] - ds[i - 1][1]);
    if (len < 24) return null;
    const ps = pts.map((q) => q[2]).sort((x, y) => x - y), p = ps[ps.length >> 1];
    const A = pts[0], B = pts[pts.length - 1], chord = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const dist = (q, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return Math.abs((q[0] - a[0]) * dy - (q[1] - a[1]) * dx) / l; };
    // 直線: 書き始めと書き終わりのはね（長さの1割ずつ）を除いた点に線を当てはめ、そこから大きく外れなければ直線にする。
    // 向きは当てはめた線から決め、両端は始点・終点をその線に下ろした位置にする
    if (chord > len * .6) {
      const mid = []; let at = 0;
      for (let i = 0; i < ds.length; i++) { if (i) at += Math.hypot(ds[i][0] - ds[i - 1][0], ds[i][1] - ds[i - 1][1]); if (at >= len * .1 && at <= len * .9) mid.push(ds[i]); }
      if (mid.length >= 2) {
        let mx = 0, my = 0; for (const q of mid) { mx += q[0] / mid.length; my += q[1] / mid.length; }
        let sxx = 0, sxy = 0, syy = 0; for (const q of mid) { const dx = q[0] - mx, dy = q[1] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
        const th = Math.atan2(2 * sxy, sxx - syy) / 2, ux = Math.cos(th), uy = Math.sin(th);
        let dev = 0; for (const q of mid) dev = Math.max(dev, Math.abs((q[0] - mx) * uy - (q[1] - my) * ux));
        if (dev < Math.max(6, chord * .07)) {
          const on = (q) => { const t = (q[0] - mx) * ux + (q[1] - my) * uy; return [mx + t * ux, my + t * uy]; };
          const a0 = on(A); return { k: 'line', v: [a0, snapAngle(a0, on(B))], p };
        }
      }
      if (chord > len * .7) return null;
    }
    if (chord > len * .25) return null;   // 閉じていない曲線はそのまま
    // 閉じた形: 角を探す（ダグラス・ポイカー法）。3つなら三角形、4つなら四角形、角がなければ円
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const [x, y] of pts) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
    const size = Math.max(c - a, d - b);
    if (size < 12) return null;
    const simplify = (list, eps) => {
      let far = 0, at = 0;
      for (let i = 1; i < list.length - 1; i++) { const h = dist(list[i], list[0], list[list.length - 1]); if (h > far) { far = h; at = i; } }
      if (far <= eps) return [list[0], list[list.length - 1]];
      return simplify(list.slice(0, at + 1), eps).slice(0, -1).concat(simplify(list.slice(at), eps));
    };
    // 始点から一番遠い点で2つに分けてから角を探す（閉じた線のまま探すと始点と終点が重なって探せない）
    let fi = 0, fd = 0; ds.forEach((q, i) => { const h = Math.hypot(q[0] - A[0], q[1] - A[1]); if (h > fd) { fd = h; fi = i; } });
    const eps = size * .1;
    const corners = simplify(ds.slice(0, fi + 1), eps).slice(0, -1).concat(simplify(ds.slice(fi), eps).slice(0, -1));
    const cs = []; for (const q of corners) if (!cs.some((r) => Math.hypot(r[0] - q[0], r[1] - q[1]) < size * .2)) cs.push(q);   // 近すぎる角はまとめる
    if (cs.length === 3) return { k: 'poly', v: axisPoly(cs.map((q) => q.slice(0, 2)), 12 * DEG), p };
    if (cs.length === 4) {
      // 辺がほぼ水平・垂直なら、きれいな長方形にする
      const axis = cs.every((q, i) => { const r = cs[(i + 1) % 4], ang = Math.atan2(r[1] - q[1], r[0] - q[0]); return Math.min(Math.abs(Math.sin(ang)), Math.abs(Math.cos(ang))) < .26; });
      return { k: 'poly', v: axis ? [[a, b], [c, b], [c, d], [a, d]] : axisPoly(cs.map((q) => q.slice(0, 2)), 12 * DEG), p };
    }
    const cx = (a + c) / 2, cy = (b + d) / 2, rx = (c - a) / 2, ry = (d - b) / 2;
    let err = 0; for (const [x, y] of pts) err += Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1);
    if (err / pts.length > .14) return null;
    if (Math.abs(rx - ry) < Math.max(rx, ry) * .12) { const r = (rx + ry) / 2; return { k: 'circle', v: [[cx, cy], [r, r]], a: 0, p }; }
    return { k: 'ellipse', v: [[cx, cy], [rx, ry]], a: 0, p };
  }
  const shapeName = (g) => g.k === 'poly' ? (g.v.length === 3 ? '三角形' : '四角形') : NAMES[g.k];
  // 図形に直したあと、ペンを離さずに動かすと形が変わる。直線は終わりの点がペンについてくる。
  // ほかの図形は、中心から見たペンの向き・距離に合わせて回して大きさを変える
  function adjustLive(q) {
    const { g0, q0 } = cur.live, g = cur.g;
    if (g.k === 'line') g.v = [g0.v[0], snapAngle(g0.v[0], q)];
    else {
      const c = g.k === 'poly' ? g0.v.reduce((m, [x, y]) => [m[0] + x / g0.v.length, m[1] + y / g0.v.length], [0, 0]) : g0.v[0];
      const r0 = Math.hypot(q0[0] - c[0], q0[1] - c[1]);
      if (r0 < 6) return;
      const k = Math.max(.1, Math.hypot(q[0] - c[0], q[1] - c[1]) / r0), rot = g.k === 'circle' ? 0 : Math.atan2(q[1] - c[1], q[0] - c[0]) - Math.atan2(q0[1] - c[1], q0[0] - c[0]);
      if (g.k === 'poly') { const cr = Math.cos(rot), sr = Math.sin(rot); g.v = axisPoly(g0.v.map(([x, y]) => { const dx = (x - c[0]) * k, dy = (y - c[1]) * k; return [c[0] + dx * cr - dy * sr, c[1] + dx * sr + dy * cr]; })); }
      else { g.v = [c, [g0.v[1][0] * k, g0.v[1][1] * k]]; g.a = snapRot((g0.a || 0) + rot); }
    }
    cur.pts = genPts(g);
    if (!raf) raf = requestAnimationFrame(frame);
  }

  // ---------- 図形の形を変える ----------
  // 図形に直した線（g がある線）は、書いた直後か投げ縄で1本だけ選んだとき、頂点などに丸いつまみが出る。
  // つまみをペンや指で動かすと形が変わる（直線: 両端、多角形: 各頂点、楕円: 横と縦の半径と傾き、円: 半径）
  let edit = null, hdrag = null;
  const hdG = document.createElementNS(NS, 'g'); hdG.setAttribute('class', 'hd');
  function handlePts(s) {
    const g = s.g, ty = top(s);
    if (g.k === 'line') return g.v.map(([x, y]) => [x, y + ty]);
    // 四角形は頂点のあとに辺のまん中のつまみ（辺ごと平行に動かす）
    if (g.k === 'poly') return g.v.map(([x, y]) => [x, y + ty]).concat(g.v.length === 4 ? g.v.map((q, i) => { const r = g.v[(i + 1) % 4]; return [(q[0] + r[0]) / 2, (q[1] + r[1]) / 2 + ty]; }) : []);
    const [[cx, cy], [rx, ry]] = g.v, a = g.a || 0;
    const pts = [[cx + rx * Math.cos(a), cy + rx * Math.sin(a) + ty]];
    if (g.k === 'ellipse') pts.push([cx - ry * Math.sin(a), cy + ry * Math.cos(a) + ty]);
    return pts;
  }
  function showHandles() {
    if (!edit || !strokes.includes(edit)) { edit = null; hdG.remove(); return; }
    hdG.replaceChildren(...handlePts(edit).map(([x, y], i) => {
      const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', (i >= edit.g.v.length ? 5 : 7) / scale); return c;
    }));
    svg.appendChild(hdG);
  }
  function setEdit(s) { edit = s && s.g ? s : null; showHandles(); }
  function hitHandle(x, y) {
    if (!edit) return -1;
    const r = 18 / scale;
    return handlePts(edit).findIndex(([hx, hy]) => Math.hypot(hx - x, hy - y) < r);
  }
  function dragHandle(x, y) {   // x, y は紙の座標
    const s = edit, g = hdrag.g, ty = top(s), q = [x, y - ty];
    if (g.k === 'line') { g.v[hdrag.i] = snapAngle(g.v[1 - hdrag.i], q); }
    else if (g.k === 'poly' && hdrag.i >= g.v.length) {
      // 辺のつまみ: 辺の両端を、辺に垂直な向きにだけ動かす
      const k = hdrag.i - g.v.length, a = hdrag.g0.v[k], b = hdrag.g0.v[(k + 1) % 4];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = -(b[1] - a[1]) / l, ny = (b[0] - a[0]) / l;
      const t = (q[0] - (a[0] + b[0]) / 2) * nx + (q[1] - (a[1] + b[1]) / 2) * ny;
      g.v[k] = [a[0] + nx * t, a[1] + ny * t]; g.v[(k + 1) % 4] = [b[0] + nx * t, b[1] + ny * t];
    }
    else if (g.k === 'poly') {
      // となりの頂点との辺が水平・垂直に近ければそろえる
      const n = g.v.length;
      for (const j of [(hdrag.i + n - 1) % n, (hdrag.i + 1) % n]) {
        const r = g.v[j], a = Math.atan2(q[1] - r[1], q[0] - r[0]), d = Math.abs(snapRot(a, Infinity) - a);
        if (d < 8 * DEG) { if (Math.abs(Math.cos(a)) > .7) q[1] = r[1]; else q[0] = r[0]; }
      }
      g.v[hdrag.i] = q;
    }
    else {
      const [c, [rx, ry]] = g.v, dx = q[0] - c[0], dy = q[1] - c[1], l = Math.max(2, Math.hypot(dx, dy));
      if (g.k === 'circle') g.v = [c, [l, l]];
      else if (hdrag.i === 0) { g.v = [c, [l, ry]]; g.a = snapRot(Math.atan2(dy, dx)); }
      else g.v = [c, [rx, l]];
    }
    s.g = g; s.pts = genPts(g);
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (!hdrag) return; render(s, null, true); showHandles(); });
  }
  function endHandle() {
    const s = edit, { g0, pts0 } = hdrag; hdrag = null;
    if (JSON.stringify(s.g) === JSON.stringify(g0)) { s.g = g0; s.pts = pts0; render(s, null, true); showHandles(); return; }   // 触っただけ
    const n = { id: newId(), b: s.b, tool: s.tool, c: s.c, s: s.s, pen: s.pen, g: s.g, pts: s.pts };
    s.g = g0; s.pts = pts0; render(s, null, true);
    bbox(n); removeAll([s]); addAll([n]); push({ type: 'replace', from: [s], to: [n] });
    if (sel.includes(s)) { sel = [n]; showSel(); }
    setEdit(n);
    stat.textContent = shapeName(n.g) + 'の形を変えました';
  }
  const cloneG = (g) => ({ ...g, v: g.v.map((q) => q.slice()) });

  page.addEventListener('pointerdown', (e) => {
    if (!accepts(e) || curId !== null || pinch || e.target.closest('.qm, .ans, .sph')) return;   // 「Q」と答え・余白のつまみの上には書かない
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    page.setPointerCapture(e.pointerId);
    curId = e.pointerId; curType = e.pointerType; penDown = true; seen = [e.clientX + ',' + e.clientY];
    t0 = e.timeStamp; samples = 1; frames = 0;
    if (edit && tool !== 'er') {
      const [x, y] = toPage(e), i = hitHandle(x, y);
      if (i >= 0) { hdrag = { i, g: cloneG(edit.g), g0: edit.g, pts0: edit.pts }; selMenu.hidden = true; return; }
      if (tool !== 'ls') setEdit(null);
    }
    if (tool === 'er') { erased = []; pieces = eraser.m === 'part' ? new Set() : null; svg.appendChild(erRing); eraseAt(toPage(e)); return; }
    if (tool === 'ls') { lassoDown(e); return; }
    const y = toPage(e)[1], b = blockAt(y);
    curTop = tops[b] - (toSto(b, y - tops[b]) - (y - tops[b]));   // たたんだ余白の下では、開いたときの位置で持つ
    cur = { id: newId(), b, tool, c: color, s: size, pen: e.pointerType === 'pen', pts: [toRel(e)] };
    cur.el = document.createElementNS(NS, 'path'); paint(cur.el, cur);
    hold = null; holdC = null; holdT = 0;
    mount(cur); render(cur, null, false);
    clearTimeout(loopT); loopT = 0;
    if (tool === 'pen' && loopCand) { loopAt = toPage(e); if (onLoop(...loopAt)) loopT = setTimeout(loopToLasso, 450); }
  });
  let seen = [];   // 最近受け取った点の位置（重なって届いた点を捨てるため）
  page.addEventListener('pointermove', (e) => {
    if (e.pointerId !== curId) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    // iPad の Safari は、前に送った点をもう一度まとめて送ってくることがある（線が行ったり来たりになり、長さが倍になる）。
    // 少し前に受け取ったのと同じ位置の点は捨てる
    const list = (evs.length ? evs : [e]).filter((ev) => {
      const k = ev.clientX + ',' + ev.clientY;
      if (seen.includes(k)) return false;
      seen.push(k); if (seen.length > 16) seen.shift();
      return true;
    });
    if (!list.length) return;
    samples += list.length;
    if (hdrag) { const [x, y] = toPage(list[list.length - 1]); dragHandle(x, y); return; }
    if (tool === 'er' && erased) { for (const ev of list) eraseAt(toPage(ev)); return; }
    if (tool === 'ls') { lassoMove(list); return; }
    if (!cur) return;
    if (loopT) { const [x, y] = toPage(list[list.length - 1]); if (Math.hypot(x - loopAt[0], y - loopAt[1]) > 5 / scale) { clearTimeout(loopT); loopT = 0; } }
    if (cur.shape) { adjustLive(toRel(list[list.length - 1])); return; }
    for (const ev of list) pending.push(toRel(ev));
    predicted = e.getPredictedEvents ? clipAhead(pending[pending.length - 1], e.getPredictedEvents().map(toRel)) : [];
    if (!raf) raf = requestAnimationFrame(frame);
    // ペンを止めたまま押さえていたら、図形に直す（直線・円・三角・四角。マーカーは直線だけ）
    if (cur.tool === 'pen' || cur.tool === 'hl') {
      // 止まっているかは画面上の位置で見る（紙が少しスクロールしても止まっているとみなす）。5px までのぶれは許す
      const q = pending[pending.length - 1], c = [e.clientX, e.clientY];
      if (!holdC || Math.hypot(c[0] - holdC[0], c[1] - holdC[1]) > 5) { hold = q; holdC = c; clearTimeout(holdT); holdT = setTimeout(snapShape, 450); }
    }
  });
  // 予測点は、ペンの先から画面の 5px までにとどめる。長く伸ばすと、離したときにその分が消えて線の終わりが途切れて見える
  function clipAhead(from, list) {
    const out = []; let left = 5 / scale, q0 = from;
    for (const q of list) {
      const l = Math.hypot(q[0] - q0[0], q[1] - q0[1]);
      if (l >= left) { const k = left / l; out.push([q0[0] + (q[0] - q0[0]) * k, q0[1] + (q[1] - q0[1]) * k, q[2]]); break; }
      out.push(q); left -= l; q0 = q;
    }
    return out;
  }
  function snapShape() {
    if (!cur || cur.shape || curId === null) return;
    if (pending.length) { cur.pts.push(...pending); pending = []; }
    // 止めている間のぶれは形を見るときに除く（止めた位置の近くに集まった最後の点）
    const pts = cur.pts, r = 6 / scale, L = pts[pts.length - 1];
    let n = pts.length; while (n > 2 && Math.hypot(pts[n - 2][0] - L[0], pts[n - 2][1] - L[1]) < r) n--;
    const g = fitShape(n < pts.length ? pts.slice(0, n - 1).concat([L]) : pts);
    if (!g || (cur.tool === 'hl' && g.k !== 'line')) { if (Math.hypot(L[0] - pts[0][0], L[1] - pts[0][1]) > 40) stat.textContent = '形に直せませんでした（もう少しまっすぐ、またはきれいに閉じると直ります）'; return; }
    cur.g = g; cur.pts = genPts(g); cur.shape = true; predicted = [];
    cur.live = { g0: cloneG(g), q0: hold };
    render(cur, null, false);
    stat.textContent = shapeName(g) + 'に直しました（離さずに動かすと向きや大きさが変わります）';
  }
  function end(e) {
    if (e.pointerId !== curId) return;
    curId = null; penDown = false; clearTimeout(holdT); clearTimeout(loopT); loopT = 0;
    if (hdrag) { endHandle(); return; }
    if (pdfDoc) pdfPump();
    const dt = (e.timeStamp - t0) / 1000;
    if (erased) { endErase(); return; }
    if (tool === 'ls') { lassoUp(); return; }
    if (!cur) return;
    if (pending.length) { cur.pts.push(...pending); pending = []; }
    // 離した位置も最後の点に入れる（最後の pointermove より先まで動いていることがある）
    if (!cur.shape && e.type === 'pointerup') {
      const q = toRel(e), l = cur.pts[cur.pts.length - 1];
      const d = Math.hypot(q[0] - l[0], q[1] - l[1]);
      if (d > .05 && d < 20 / scale) { q[2] = l[2]; cur.pts.push(q); }
    }
    predicted = [];
    bbox(cur);
    const victims = cur.tool === 'pen' && !cur.shape ? scribbleTargets(cur) : null;
    if (victims) {
      cur.el.remove(); removeAll(victims); push({ type: 'erase', list: victims });
      stat.textContent = `ぐちゃぐちゃ消し: ${victims.length}画を消しました`;
      cur = null; return;
    }
    render(cur, null, true); strokes.push(cur);
    push({ type: 'add', list: [cur] });
    const tag = cur.pen ? 'Pencil入力' : '入力';
    if (dt > .25 && !cur.shape) stat.textContent = `${tag} ${Math.round(samples / dt)}Hz・描画 ${Math.round(frames / dt)}fps`;
    const shaped = cur.shape; delete cur.shape; delete cur.live;
    loopCand = isLoop(cur) ? cur : null;
    if (shaped) setEdit(cur);
    cur = null;
  }
  // 書いている途中でやめる（指で書いているときにピンチが始まったとき）。消しゴムで消した分はそのまま残す
  function abortInput() {
    clearTimeout(holdT);
    if (hdrag) { const s = edit; s.g = hdrag.g0; s.pts = hdrag.pts0; render(s, null, true); hdrag = null; showHandles(); }
    try { page.releasePointerCapture(curId); } catch {}
    curId = null; penDown = false;
    if (erased) endErase();
    if (drag) { drag = null; for (const s of sel) place(s); showSel(); }
    if (lasso) { lasso = null; lassoEl.remove(); }
    if (cur) { cur.el.remove(); cur = null; pending = []; predicted = []; }
  }
  page.addEventListener('pointerup', end);
  page.addEventListener('pointercancel', end);


  // ---------- PDF ----------
  // PDF はページを紙の切れ目として縦に並べる。1ページを #doc の子要素1つにし、段落と同じ仕組みで書き込みを結びつける
  // （段落番号 = ページ番号、座標はページの上端から測った幅 680 の紙の px）。
  // 描くのは画面の近くのページだけで、離れたページの canvas は捨てる（数百ページでも Safari のメモリに収める）。
  // PDF.js は PDF を開くときに初めて読み込む（md だけ読むときは重くしない）
  const PDFJS = 'vendor/pdfjs/';
  let pdfjs = null, pdfDoc = null, pdfOpening = null, pdfIO = null, pdfBusy = false, outline = null;
  const near = new Set(), drawn = new Map();   // 画面の近くのページ番号 / 描いたページ -> { cv, k（紙 1px あたりの canvas の画素） }
  async function openPdf(data) {
    pdfjs ||= await import('./' + PDFJS + 'pdf.min.mjs');
    const base = new URL(PDFJS, location.href).href;
    pdfjs.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs';
    return pdfjs.getDocument({ data, cMapUrl: base + 'cmaps/', cMapPacked: true, standardFontDataUrl: base + 'standard_fonts/',
      wasmUrl: base + 'wasm/', iccUrl: base + 'iccs/', isEvalSupported: false, enableHWA: true }).promise;
  }
  const pdfBytes = async (v) => new Uint8Array(v instanceof Blob ? await v.arrayBuffer() : v);
  const pageH = (n) => Math.round(W * book.sizes[n - 1][1] / book.sizes[n - 1][0]);
  async function pdfHtml() {
    if (!pdfDoc) {
      const key = src;
      pdfOpening ||= kv.get('pdf:' + key).then(async (v) => v ? openPdf(await pdfBytes(v)) : null);
      const d = await pdfOpening;
      if (key !== src) { if (d) d.destroy(); return null; }
      pdfDoc = d; outline = null;
    }
    if (!pdfDoc) return null;
    return book.sizes.map((_, i) => `<div class="pg" data-n="${i + 1}" style="height:${pageH(i + 1)}px;--ph:${pageH(i + 1)}px"></div>`).join('');
  }
  function startPdf() {
    stopPdf(); showPgno();
    if (!isPdf() || !pdfDoc) return;
    pdfIO = new IntersectionObserver((es) => {
      for (const e of es) { const n = +e.target.dataset.n; if (e.isIntersecting) near.add(n); else { near.delete(n); dropPage(n); } }
      pdfPump();
    }, { rootMargin: '100% 0px' });   // 上下 1 画面分先まで描いておく
    for (const el of blocks) if (el.dataset.n) pdfIO.observe(el);
  }
  function dropPage(n) {
    const p = drawn.get(n);
    if (!p) return;
    for (const c of [p.cv, ...p.more]) { c.width = c.height = 0; c.remove(); }   // 幅を 0 にすると Safari がすぐメモリを返す
    drawn.delete(n); dropHd(n);
    if (pdfDoc) pdfDoc.getPage(n).then((pg) => pg.cleanup()).catch(() => {});
  }
  function stopPdf() { if (pdfIO) pdfIO.disconnect(); pdfIO = null; for (const n of [...drawn.keys()]) dropPage(n); near.clear(); }
  function closePdf() { stopPdf(); if (pdfDoc) pdfDoc.destroy(); pdfDoc = pdfOpening = outline = ptext = null; }
  // 拡大率に合わせた解像度で描く。拡大しすぎたときは、1ページの画素数を上限で止める（Safari の canvas の上限とメモリのため）
  const MAXPX = 6e6;
  const resOf = (n) => Math.min(scale * (devicePixelRatio || 1), Math.sqrt(MAXPX / (W * pageH(n))));
  const curPage = () => Math.max(1, blockAt((innerHeight / 2 - page.getBoundingClientRect().top) / scale));
  // 1ページずつ、画面の真ん中に近いページから描く。書いている間とピンチの間は描かない（ペンの描画を待たせない）
  // 1ページずつ、画面の真ん中に近いページから描く。書いている間とピンチの間は描かない（ペンの描画を待たせない）
  async function pdfPump() {
    if (pdfBusy || !pdfDoc || penDown || pinch) return;
    const c = curPage();
    const todo = [...near].filter((n) => { const p = drawn.get(n); return !p || Math.abs(p.k / resOf(n) - 1) > .05; })
      .sort((x, y) => Math.abs(x - c) - Math.abs(y - c));
    if (!todo.length) return pdfHd();
    const n = todo[0], k = resOf(n);
    const cv = await drawPdf(n, k);
    if (!cv) return pdfPump();
    const old = drawn.get(n), more = [];
    if (old) { old.cv.replaceWith(cv); for (const c of [old.cv, ...old.more]) { c.width = c.height = 0; c.remove(); } } else blocks[n].prepend(cv);
    drawn.set(n, { cv, k, more });
    fitCv(n, cv, [0, 0, W, pageH(n)], more);
    pdfPump();
  }
  // ページ n の範囲 r（元のページの px）を描いた canvas を、余白で切った位置に並べる。
  // 最初の切れ目には canvas そのものを（はみ出す分は隠して）置き、残りの切れ目には写しを作る（more に入れる）
  function fitCv(n, cv, r, more) {
    for (const c of more.splice(0)) { c.width = c.height = 0; c.remove(); }
    const ky = cv.height / (r[3] - r[1]), pos = (a, z, v) => `left:${r[0]}px;width:${r[2] - r[0]}px;top:${v}px;height:${z - a}px`;
    let first = true;
    for (const s of segs(n)) {
      const a = Math.max(r[1], s.c0), z = Math.min(r[3], s.c1);
      if (z <= a) continue;
      if (first) {
        first = false;
        cv.style.cssText = pos(r[1], r[3], s.v + r[1] - s.c0) + (a > r[1] || z < r[3] ? `;clip-path:inset(${a - r[1]}px 0 ${r[3] - z}px 0)` : '');
        continue;
      }
      const c = document.createElement('canvas'), y0 = Math.floor((a - r[1]) * ky);
      c.width = cv.width; c.height = Math.max(1, Math.ceil((z - r[1]) * ky) - y0); c.className = cv.className;
      if (cv.width && cv.height) c.getContext('2d').drawImage(cv, 0, y0, cv.width, c.height, 0, 0, c.width, c.height);
      c.style.cssText = pos(a, z, s.v + a - s.c0);
      cv.after(c); more.push(c);
    }
  }
  // 余白を変えたページの絵を並べ直す
  function placePage(n) {
    const p = drawn.get(n), h = hd.get(n);
    if (p) fitCv(n, p.cv, [0, 0, W, pageH(n)], p.more);
    if (h) fitCv(n, h.cv, h.r, h.more);
  }
  // ページ n の範囲 r（ページ内の紙の px。省略するとページ全体）を、紙 1px あたり k 画素で canvas に描く。
  // 描いている間に本やページが変わったら null
  async function drawPdf(n, k, r) {
    const pd = pdfDoc, [x0, y0, x1, y1] = r || [0, 0, W, pageH(n)], cv = document.createElement('canvas');
    pdfBusy = true;
    try {
      const pg = await pd.getPage(n), w1 = pg.getViewport({ scale: 1 }).width;
      const vp = pg.getViewport({ scale: k * W / w1, offsetX: -x0 * k, offsetY: -y0 * k });
      cv.width = Math.ceil((x1 - x0) * k); cv.height = Math.ceil((y1 - y0) * k);
      await pg.render({ canvas: cv, viewport: vp }).promise;
    } catch { cv.width = cv.height = 0; }   // 描けないページは白いままにする（何度も描き直さない）
    pdfBusy = false;
    if (pd !== pdfDoc || !near.has(n) || !blocks[n]) { cv.width = cv.height = 0; return null; }
    return cv;
  }
  // 拡大してページ全体の絵では細かさが足りないときは、画面に見えている部分だけを細かく描いて上に重ねる
  // （hd: ページ -> { cv, k, r }）。少し広めに描いておき、少しのスクロールでは描き直さない
  const hd = new Map(), HDPX = 8e6;   // 重ねる絵の画素数の合計の上限
  function dropHd(n) { const h = hd.get(n); if (!h) return; for (const c of [h.cv, ...h.more]) { c.width = c.height = 0; c.remove(); } hd.delete(n); }
  async function pdfHd() {
    const K0 = scale * (devicePixelRatio || 1), pr = page.getBoundingClientRect();
    const v = [-pr.left / scale, -pr.top / scale, (innerWidth - pr.left) / scale, (innerHeight - pr.top) / scale];
    const want = new Map();
    for (const n of near) {
      const t = tops[n], h = pageH(n), p = drawn.get(n);
      if (!p || p.k >= K0 * .95 || t >= v[3] || t + sheet(n) <= v[1]) continue;
      const a = [Math.max(0, v[0]), vToC(n, Math.max(0, v[1] - t)), Math.min(W, v[2]), vToC(n, Math.min(sheet(n), v[3] - t))];   // 見えている元のページの範囲
      if (a[2] > a[0] && a[3] > a[1]) want.set(n, a);
    }
    for (const n of [...hd.keys()]) if (!want.has(n)) dropHd(n);
    for (const [n, a] of want) {
      const w = a[2] - a[0], h = a[3] - a[1], cap = HDPX / want.size;
      const k = Math.min(K0, Math.sqrt(cap / (w * h))), e = Math.max(0, Math.min(.25, (Math.sqrt(cap / (w * h * k * k)) - 1) / 2));
      const old = hd.get(n);
      if (old && Math.abs(old.k / k - 1) < .05 && old.r[0] <= a[0] + .5 && old.r[1] <= a[1] + .5 && old.r[2] >= a[2] - .5 && old.r[3] >= a[3] - .5) continue;
      const r = [Math.max(0, a[0] - w * e), Math.max(0, a[1] - h * e), Math.min(W, a[2] + w * e), Math.min(pageH(n), a[3] + h * e)];
      const cv = await drawPdf(n, k, r);
      if (!cv) return pdfPump();
      dropHd(n);
      cv.className = 'hd';
      blocks[n].append(cv);
      const more = []; hd.set(n, { cv, k, r, more }); fitCv(n, cv, r, more);
      return pdfPump();
    }
  }
  // 端の「12 / 300」。押すとページの一覧（目次の画面の「ページ」）を開く
  const pgno = $('#pgno'), pgIn = $('#pg-in');
  let pgRaf = 0;
  function showPgno() {
    pgno.hidden = !isPdf();
    if (!isPdf()) return;
    $('#pg-c').textContent = curPage(); $('#pg-n').textContent = $('#pg-all').textContent = blocks.length - 1;
  }
  pgno.onclick = () => openToc('pages');
  let hdT = 0;
  const onScroll = () => {
    if (!isPdf()) return;
    if (!pgRaf) pgRaf = requestAnimationFrame(() => { pgRaf = 0; showPgno(); });
    clearTimeout(hdT); hdT = setTimeout(pdfPump, 150);   // 拡大しているときは、止まったところを細かく描き直す
  };
  addEventListener('scroll', onScroll, { passive: true });
  wrap.addEventListener('scroll', onScroll, { passive: true });
  pgIn.onfocus = () => pgIn.select();
  pgIn.onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const n = Math.round(+pgIn.value.replace(/[０-９]/g, (d) => d.charCodeAt(0) - 0xff10));
    if (n >= 1 && n < blocks.length) { pgIn.blur(); goTo(CH, n); }
    else pgIn.select();
  };
  // PDF の本文（検索用）。ページごとに文字と、文字のかたまりの位置（ページ内の紙の px）を一度だけ取り出し、端末に覚えておく。
  // [{ t: 本文, r: [[t の中の位置, x, y, 幅, 高さ], …] }]。スキャンした PDF は文字がないので空になる
  let ptext = null, ptextCb = null;   // ptextCb: 読み込みの進み具合を出す先（最後に検索したもの）
  function pdfTexts(progress) {
    if (progress) ptextCb = progress;
    return ptext ||= (async () => {
      const pd = pdfDoc, key = 'ptext:' + src, saved = await kv.get(key).catch(() => null);
      if (saved) return saved;
      const out = [];
      for (let n = 1; n <= pd.numPages; n++) {
        const pg = await pd.getPage(n), vp = pg.getViewport({ scale: W / pg.getViewport({ scale: 1 }).width });
        let t = ''; const r = [];
        for (const it of (await pg.getTextContent()).items) {
          const str = (it.str || '').replace(/\s+/g, ' ');
          if (str) {
            const m = pdfjs.Util.transform(vp.transform, it.transform), h = Math.hypot(m[2], m[3]);
            r.push([t.length, Math.round(m[4]), Math.round(m[5] - h), Math.round(it.width * vp.scale), Math.round(h)]);
            t += str;
          }
          if (it.hasEOL && !t.endsWith(' ')) t += ' ';
        }
        out.push({ t, r });
        pg.cleanup();
        if (ptextCb && n % 10 === 0) ptextCb(n, pd.numPages);
      }
      kv.set(key, out).catch(() => {});
      return out;
    })().catch(() => { ptext = null; return null; });
  }
  // 見つかった文字（t の at から len 文字）のおおよその位置: [x, y, 幅, 高さ]
  function pdfHitBox({ t, r }, at, len) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    r.forEach(([i, x, y, w, h], j) => {
      const end = j + 1 < r.length ? r[j + 1][0] : t.length, n = Math.max(1, end - i);
      if (end <= at || i >= at + len) return;
      const f0 = Math.max(0, at - i) / n, f1 = Math.min(n, at + len - i) / n;   // かたまりの中は、文字数の割合で位置を決める
      a = Math.min(a, x + w * f0); c = Math.max(c, x + w * f1); b = Math.min(b, y); d = Math.max(d, y + h);
    });
    return a < c ? [a, b, c - a, d - b] : null;
  }
  // PDF のしおり（目次）。目次を開いたときに一度だけ読む: [{ t: 題, n: ページ, d: 深さ }]
  async function pdfOutline() {
    if (outline || !pdfDoc) return outline || [];
    const out = [], pd = pdfDoc;
    const walk = async (items, d) => {
      for (const it of items || []) {
        let n = 0;
        try {
          const dest = typeof it.dest === 'string' ? await pd.getDestination(it.dest) : it.dest;
          if (dest && dest[0] != null) n = (typeof dest[0] === 'number' ? dest[0] : await pd.getPageIndex(dest[0])) + 1;
        } catch {}
        out.push({ t: it.title, n, d });
        if (d < 2) await walk(it.items, d + 1);
      }
    };
    try { await walk(await pd.getOutline(), 0); } catch {}
    if (pd === pdfDoc) outline = out;
    return out;
  }

  // ---------- chapters ----------
  const chapSel = $('#chap');   // 押すと目次・しおりが開く
  const srcLine = doc.firstElementChild;
  let ids = [];
  let opening = null;
  function fillChapters() {
    ids = book.chapters.map((c) => c.id);
    srcLine.textContent = book.source || book.title || '';
    document.body.classList.toggle('pdf', isPdf());
  }
  async function openChapter(id, restore) {
    if (!ids.includes(id)) id = ids.includes('ch1') ? 'ch1' : ids[0];
    const my = opening = {};
    syncNav(id);
    if (CH) store.set(memKey('pos:' + CH), String(scrollY));
    if (cs && cs.pending.size) pushChapter(CH);
    doc.classList.add('loading');
    let html = isPdf() ? await pdfHtml().catch(() => null) : await chapterHtml(id);
    if (html == null && canSync()) { try { await syncBook(); html = await chapterHtml(id); } catch {} }
    if (my !== opening) return;
    if (html == null) { stat.textContent = isPdf() ? 'PDF を開けませんでした' : 'この章はまだiPadに保存されていません。通信できるときに開いてください'; doc.classList.remove('loading'); if (CH) syncNav(CH); return; }
    const [saved, ans, wait] = await Promise.all([kv.get(inkKey(id)), kv.get(ansKey(id)), kv.get(askKey(id))]);
    if (my !== opening) return;
    for (const s of strokes) s.el.remove();
    strokes = []; setEdit(null); undoStack.length = 0; redoStack.length = 0; syncHist();
    CH = id;
    cs = { blocks: (saved && saved.blocks) || {}, sha: saved ? saved.sha : null, pending: new Set(saved ? saved.pending : []), at: saved && saved.at };
    store.set(memKey('chapter'), id);
    doc.replaceChildren(srcLine);
    doc.insertAdjacentHTML('beforeend', html);
    initBlocks(); markBm(); layout(); startPdf();
    showBlocks(cs.blocks);
    openQ = new Set(); setAnswers(ans || '', wait || []);
    doc.classList.remove('loading');
    scrollTo(0, restore ? +(store.get(memKey('pos:' + id)) || 0) : 0);
    fillImages();
    if (document.fonts) document.fonts.ready.then(layout);
    // 今の置き場所にまだ送っていない書き込み（つなぐ前に書いたもの・置き場所を変えたもの）を送る。GitHub の本は moveGhBook で写してから
    if (hasRemote() && ghMoved() && Object.keys(cs.blocks).length) { const n = cs.pending.size; moveTo(cs, where()); if (cs.pending.size !== n) { persist(); schedulePush(1500); } }
    // ページの画像の作り方を変えたときは、書き込みのあるページの画像を作り直す
    if (isPdf() && isLocal() && canPush()) {
      const bk = bookKey(), R = where(), vk = 'viewv:' + tag(R) + bk;
      kv.get(vk).then((v) => v === VIEWV || setTimeout(async () => {
        if (bk !== bookKey() || R !== where() || !pdfDoc || await kv.get(vk) === VIEWV) return;
        await upPages(bookDir(), bk, [...new Set(strokes.map((x) => x.b))], false, R);
        kv.set(vk, VIEWV);
      }, 3000));
    }
    showPending();
    lastPull = Date.now(); refreshChapter();
  }
  function syncNav(id) {
    const i = ids.indexOf(id);
    $('#chap-t').textContent = (book.chapters[i] || {}).label || '';
    $('#prev2').disabled = i <= 0;
    $('#next2').disabled = i >= ids.length - 1;
  }
  const step = (d) => { const i = ids.indexOf(CH) + d; if (ids[i]) openChapter(ids[i], false); };
  $('#prev2').onclick = () => step(-1);
  $('#next2').onclick = () => step(1);
  addEventListener('pagehide', () => { if (CH) store.set(memKey('pos:' + CH), String(scrollY)); });

  // ---------- 目次・しおり ----------
  // しおりは本ごとに端末へ保存する: [{ c: 章, b: 段落の番号, t: 段落の書き出し }]
  const toc = $('#toc');
  // 目次の外（暗くなった部分）を触ったら閉じる
  toc.addEventListener('click', (e) => {
    if (e.target !== toc) return;
    const r = toc.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) toc.close();
  });
  const loadBm = () => { try { return JSON.parse(store.get(memKey('bm')) || '[]'); } catch { return []; } };
  const blockTitle = (el) => blockMd(el).replace(/^#+ /, '').replace(/\$+/g, '').replace(/\s+/g, ' ').slice(0, 60);
  const bmsEl = $('#bms');
  function markBm() { for (const m of loadBm()) if (m.c === CH && blocks[m.b]) blocks[m.b].classList.add('bm'); showBm(); }
  function showBm() {
    bmsEl.replaceChildren(...blocks.flatMap((el, b) => {
      if (!el.classList.contains('bm')) return [];
      const i = document.createElement('i'); i.dataset.b = b; return [i];
    }));
    placeBm();
  }
  function placeBm() { for (const m of bmsEl.children) m.style.top = (tops[+m.dataset.b] || 0) + 'px'; }
  function toggleBm(b) {
    if (!CH || !blocks[b]) return;
    const list = loadBm(), i = list.findIndex((m) => m.c === CH && m.b === b);
    if (i >= 0) list.splice(i, 1); else list.push({ c: CH, b, t: isPdf() ? b + 'ページ' : blockTitle(blocks[b]) });
    store.set(memKey('bm'), JSON.stringify(list));
    blocks[b].classList.toggle('bm', i < 0); showBm();
    stat.textContent = i < 0 ? 'しおりを付けました' : 'しおりを外しました';
  }
  // box: PDF の検索で見つかった文字の位置（ページ内の紙の px）。そこが画面の上の方に来るようにして、一瞬だけ色を付ける
  async function goTo(c, b, flash, box) {
    toc.close();
    if (c !== CH) await openChapter(c, false);
    if (c !== CH) return;
    if (!b || !blocks[b]) { scrollTo(0, 0); return; }
    const barB = $('#bar').getBoundingClientRect().bottom;
    if (box) {
      const r = blocks[b].getBoundingClientRect();
      box = [box[0], cToV(b, box[1]), box[2], box[3]];   // ページの途中に余白があれば、その分下
      scrollBy(0, r.top + box[1] * scale - barB - (innerHeight - barB) * .3);
      const x = r.left + box[0] * scale;
      if (x < 0 || x + box[2] * scale > innerWidth) wrap.scrollLeft += x - innerWidth * .2;
      const m = document.createElement('div'); m.className = 'hitbox';
      m.style.cssText = `left:${box[0] - 3}px;top:${box[1] - 2}px;width:${box[2] + 6}px;height:${box[3] + 4}px`;
      blocks[b].append(m); setTimeout(() => m.remove(), 2000);
      return;
    }
    scrollBy(0, blocks[b].getBoundingClientRect().top - barB - 12);
    if (flash) { const el = blocks[b]; el.classList.remove('hit'); void el.offsetWidth; el.classList.add('hit'); setTimeout(() => el.classList.remove('hit'), 1900); }
  }
  function tocItem(text, cls, go, at) {
    const li = document.createElement('li'), btn = document.createElement('button');
    btn.type = 'button'; btn.className = cls; btn.onclick = go;
    if (at) { const s = document.createElement('span'); s.className = 'bm-at'; s.textContent = at; btn.append(s); }
    if (text.nodeType) btn.append(...text.childNodes); else btn.append(text);   // 見出しは数式を描いたまま並べる
    li.append(btn); return li;
  }
  chapSel.onclick = () => openToc('main');
  // tab: 'main'（目次・しおり・検索）か 'pages'（PDF のページの一覧）
  async function openToc(tab) {
    if (!book) return;
    if (!isPdf()) tab = 'main';
    $('#toc-head').hidden = !isPdf();
    const ol = isPdf() ? await pdfOutline() : [];
    const label = (c) => (book.chapters.find((x) => x.id === c) || {}).label || c;
    const bms = loadBm().filter((m) => ids.includes(m.c)).sort((x, y) => ids.indexOf(x.c) - ids.indexOf(y.c) || x.b - y.b);
    $('#toc-bm').hidden = !bms.length;
    $('#toc-bms').replaceChildren(...bms.map((m) => tocItem(m.t, '', () => goTo(m.c, m.b), label(m.c))));
    const rows = [];
    for (const c of book.chapters) {
      rows.push(tocItem(c.label, c.id === CH ? 'cur' : '', () => goTo(c.id, 0)));
      // 開いている章だけ、見出しも並べる（章の最初の見出しは章の名前と同じなので飛ばす）
      if (c.id === CH) blocks.forEach((el, b) => { if (/^H[2-4]$/.test(el.tagName)) rows.push(tocItem(el.cloneNode(true), el.tagName.toLowerCase(), () => goTo(CH, b))); });
      // PDF は PDF に入っている目次（しおり）を並べる
      if (c.id === CH) for (const o of ol) rows.push(tocItem(o.t, 'h' + (o.d + 2), () => goTo(CH, o.n), o.n ? String(o.n) : ''));
    }
    $('#toc-list').replaceChildren(...rows);
    $('#toc-q').value = ''; showHits('');
    if (!toc.open) toc.showModal();
    showTab(tab);
    pgIn.value = '';
    if (toc.contains(document.activeElement)) document.activeElement.blur();   // 開いただけでキーボードが出ないようにする
  }
  function showTab(tab) {
    for (const b of $('#toc-tabs').children) b.setAttribute('aria-selected', String(b.dataset.t === tab));
    $('#toc-tab-main').hidden = tab !== 'main'; $('#toc-pages').hidden = tab !== 'pages';
    toc.classList.toggle('pages', tab === 'pages');
    if (tab !== 'pages') pick = null;
    exShow();
    if (tab === 'pages') buildPages(); else stopThumbs();
    const cur = toc.querySelector(tab === 'pages' ? '.th.cur' : '#toc-list .cur'); if (cur) cur.scrollIntoView({ block: 'center' });
  }
  $('#toc-tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) showTab(b.dataset.t); };
  toc.addEventListener('close', () => { stopThumbs(); thMenu.hidden = true; pick = null; exShow(); });

  // ---------- ページの一覧（PDF） ----------
  // ページと白紙の縮小画像を並べる。画像は一覧で見えているものだけ作り、離れたら捨てる。
  // 押すとそのページへ。「…」から後ろに白紙を入れる・白紙を消す
  const grid = $('#pg-grid'), thMenu = $('#th-menu');
  let thIO = null, thQ = [], thBusy = false, thAt = null;
  function stopThumbs() {
    if (thIO) thIO.disconnect(); thIO = null; thQ = [];
    for (const c of grid.querySelectorAll('canvas')) { c.width = c.height = 0; }
    grid.replaceChildren();
  }
  function buildPages() {
    stopThumbs();
    const cur = curPage(), items = [];
    for (let n = 1; n < blocks.length; n++) {
      const k = Math.round((gaps[n] || 0) / gapUnit(n));
      for (let i = 0; i <= k; i++) items.push(thItem(n, i, k, n === cur && !i));
    }
    grid.replaceChildren(...items);
    thIO = new IntersectionObserver((es) => {
      for (const e of es) {
        const el = e.target;
        if (e.isIntersecting) { if (!el.dataset.d) { thQ.push(el); thPump(); } }
        else if (el.dataset.d) { const c = el.querySelector('canvas'); if (c) { c.width = c.height = 0; c.remove(); } delete el.dataset.d; }
      }
    }, { root: toc, rootMargin: '400px 0px' });
    for (const el of items) thIO.observe(el);
  }
  function thItem(n, i, k, cur) {
    const el = document.createElement('div'), [w, h] = book.sizes[n - 1];
    el.className = 'th' + (i ? ' blank' : '') + (cur ? ' cur' : '') + (pick && pick.has(n + ':' + i) ? ' on' : ''); el.dataset.n = n; el.dataset.i = i;
    const im = document.createElement('button'); im.type = 'button'; im.className = 'im'; im.style.aspectRatio = `${w} / ${h}`;
    im.setAttribute('aria-label', i ? `${n}ページの後ろの白紙へ` : `${n}ページへ`);
    const lb = document.createElement('div'); lb.className = 'lb';
    const t = document.createElement('span'); t.textContent = i ? `白紙${k > 1 ? i : ''}` : n;
    const m = document.createElement('button'); m.type = 'button'; m.className = 'th-m'; m.textContent = '…'; m.setAttribute('aria-label', 'このページの操作');
    lb.append(t, m); el.append(im, lb);
    return el;
  }
  // 縮小画像は1枚ずつ作る（ページの絵 + 書き込み）
  async function thPump() {
    if (thBusy || !thIO) return;
    const el = thQ.shift();
    if (!el) return;
    if (!el.isConnected || el.dataset.d) return thPump();
    thBusy = true;
    try {
      const n = +el.dataset.n, i = +el.dataset.i, im = el.firstChild, ph = pageH(n);
      const k = (im.clientWidth || 100) * (devicePixelRatio || 1) / W, cv = document.createElement('canvas');
      cv.width = Math.round(W * k); cv.height = Math.round(ph * k);
      if (!i) { const pg = await pdfDoc.getPage(n); await pg.render({ canvas: cv, viewport: pg.getViewport({ scale: k * W / pg.getViewport({ scale: 1 }).width }) }).promise; }
      const g = cv.getContext('2d'), y0 = i ? spSum(n) + i * gapUnit(n) : 0;
      if (i) { g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); }
      // 線は元のページ（白紙）の上の位置に直して描く。ページの途中の余白に書いた線は入れない
      const sp = spans[n] || [], up = (s) => i ? 0 : sp.reduce((a, p) => a + (p.e1 <= sy(s) ? p.e1 - p.e0 : 0), 0);
      g.save(); g.scale(k, k); g.translate(0, -y0);
      drawInk(g, strokes.filter((s) => s.b === n && (i || !sp.some((p) => sy(s) >= p.e0 && sy(s) < p.e1)) && s.bbox[3] - up(s) > y0 && s.bbox[1] - up(s) < y0 + ph), (s) => -up(s));
      g.restore();
      if (el.isConnected && thIO) { im.append(cv); el.dataset.d = 1; } else cv.width = cv.height = 0;
    } catch {}
    thBusy = false;
    thPump();
  }
  grid.addEventListener('click', (e) => {
    const th = e.target.closest('.th');
    if (!th) return;
    const n = +th.dataset.n, i = +th.dataset.i;
    if (pick) { if (!exBusy && e.target.closest('.im')) { const k = n + ':' + i; if (!pick.delete(k)) pick.add(k); th.classList.toggle('on', pick.has(k)); exFile = null; exShow(); } return; }   // 書き出すページを選んでいる
    if (e.target.closest('.th-m')) {
      thAt = { n, i };
      $('#th-del').hidden = !i;
      const r = e.target.getBoundingClientRect();
      thMenu.hidden = false;
      thMenu.style.left = Math.max(8, Math.min(innerWidth - thMenu.offsetWidth - 8, r.right - thMenu.offsetWidth)) + 'px';
      thMenu.style.top = Math.min(innerHeight - thMenu.offsetHeight - 8, r.bottom + 4) + 'px';
      return;
    }
    if (!e.target.closest('.im')) return;
    toc.close();
    if (!i) { goTo(CH, n); return; }
    scrollBy(0, blocks[n].getBoundingClientRect().top + (sheet(n) - pageH(n) + i * gapUnit(n)) * scale - $('#bar').getBoundingClientRect().bottom - 12);
  });
  toc.addEventListener('click', (e) => { if (!thMenu.hidden && !e.target.closest('#th-menu, .th-m')) thMenu.hidden = true; });
  const thKeep = () => { const t = toc.scrollTop; buildPages(); toc.scrollTop = t; };
  $('#th-add').onclick = () => { thMenu.hidden = true; blankOp(thAt.n, thAt.i, true); stat.textContent = `${thAt.n}ページの後ろに白紙を入れました`; thKeep(); };
  $('#th-del').onclick = () => { thMenu.hidden = true; blankOp(thAt.n, thAt.i, false); stat.textContent = '白紙を消しました'; thKeep(); };

  // ---------- 書き出し（PDF） ----------
  // ページの一覧の「書き出す」を押すと、縮小画像を押して書き出すページ（白紙も1枚ずつ）を選べる。選んだページを、書き込みを重ねた PDF にする。
  // 作り方は export.js（ドライブに置いて、クラウドの Claude も同じものを使う）。export.js と pdf-lib は書き出すときだけ読み込む（ふだんは重くしない）
  let pick = null, exFile = null, exBusy = false;   // 選んでいるとき: Set('<ページ>:<白紙の番号（0 はページそのもの）>') / 作った PDF（選び直すと捨てる。それまでは、もう一度共有できる）/ 作っている
  const exMsg = (t) => { $('#ex-msg').textContent = t; };
  const mb = (f) => f.size < 1048576 ? Math.ceil(f.size / 1024) + 'KB' : (f.size / 1048576).toFixed(1) + 'MB';
  function exShow() {
    const on = !!pick, pages = isPdf() && !$('#toc-pages').hidden;
    toc.classList.toggle('picking', on);
    $('#pg-go').hidden = !pages || on; $('#ex-on').hidden = !pages || on; $('#ex-bar').hidden = $('#ex-msg').hidden = !on;
    if (!on) return;
    const all = grid.children.length && pick.size === grid.children.length;
    $('#ex-n').textContent = `${pick.size}ページ`;
    $('#ex-all').textContent = all ? '選択を解除' : 'すべて選択';
    const go = $('#ex-go');
    if (!go.classList.contains('busy')) { go.disabled = !pick.size; go.textContent = exFile ? '共有する' : 'PDF にする'; }
  }
  $('#ex-on').onclick = () => { pick = new Set(); exFile = null; exMsg('書き出すページを押して選んでください。後ろの白紙も1枚ずつ選べます。'); exShow(); };
  $('#ex-x').onclick = () => { pick = null; exFile = null; exShow(); };
  $('#ex-all').onclick = () => {
    const ths = [...grid.children], all = pick.size === ths.length;
    pick = new Set(all ? [] : ths.map((th) => th.dataset.n + ':' + th.dataset.i));
    for (const th of ths) th.classList.toggle('on', !all);
    exFile = null; exShow();
  };
  $('#ex-go').onclick = async () => {
    const go = $('#ex-go'), job = pick;
    if (exFile) return shareFile(exFile);
    if (!job || !job.size || exBusy) return;
    exBusy = true; go.classList.add('busy'); go.disabled = $('#ex-all').disabled = true;
    try {
      const f = await exportPdf(new Set(job), (t) => { if (pick === job) go.textContent = t; });
      if (pick === job) {   // 作っている間に「やめる」を押したり閉じたりしていなければ渡す
        exFile = f; exMsg(`できました（${mb(f)}）`);
        await shareFile(f);
      }
    } catch (e) { if (pick === job) exMsg('書き出せませんでした: ' + (e && e.message || e)); }
    exBusy = false; go.classList.remove('busy'); $('#ex-all').disabled = false; exShow();
  };
  // iPad の共有シート（ファイルに保存・AirDrop・ほかのアプリ）で渡す。共有シートは押した直後しか開けないので、作るのに時間がかかったときはもう一度押してもらう
  async function shareFile(f) {
    try {
      if (!navigator.canShare || !navigator.canShare({ files: [f] })) return save(f);
      await navigator.share({ files: [f] });
    } catch (e) {
      if (e && e.name === 'NotAllowedError') exMsg(`できました（${mb(f)}）。「共有する」を押してください`);
      else if (!e || e.name !== 'AbortError') save(f);
    }
  }
  function save(f) {   // 共有できない端末（パソコンなど）はダウンロード
    const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  const PDFLIB = 'vendor/pdf-lib/pdf-lib.esm.min.js';
  async function exportPdf(keys, say) {
    say('準備しています');
    const [{ exportPdf: make }, L] = await Promise.all([import('./export.js'), import('./' + PDFLIB)]);
    // 今の書き込みと余白を写しておく（作っている間に書いても混ざらない）。線は画面に描いた輪郭をそのまま使う
    const ink = strokes.filter((s) => s.b > 0 && s.el).map((s) => ({ b: s.b, d: s.el.getAttribute('d'), hl: s.tool === 'hl', c: s.c, y0: s.bbox[1] - 10, y1: s.bbox[3] + 10 }));
    const spl = {};
    for (const b in sps) spl[b] = sps[b].map((p) => ({ ...p }));
    const { bytes, name } = await make({
      L, pdf: await pdfBytes(await kv.get('pdf:' + src)), unlock: () => pdfDoc,
      sizes: book.sizes, title: book.title, ink, gaps: { ...gaps }, sps: spl, keys, say,
      viewT: async (n) => (await pdfDoc.getPage(n)).getViewport({ scale: 1 }).transform,   // 画面で見ていたページの向き・範囲
    });
    return new File([bytes], name, { type: 'application/pdf' });
  }

  // 本文の検索。章ごとの段落の文字（数式は TeX）を一度だけ作って覚えておく。段落の番号は #doc の子要素の番号（先頭は出典の行）
  const searchText = new Map();   // '<本>:<章>' -> { html, texts }
  async function chapterTexts(id, progress) {
    if (isPdf()) { const p = await pdfTexts(progress); return p && p.map((x) => x.t); }
    const html = await chapterHtml(id);
    if (html == null) return null;
    const k = bookKey() + ':' + id, hit = searchText.get(k);
    if (hit && hit.html === html) return hit.texts;
    const t = document.createElement('template'); t.innerHTML = html;
    const texts = [...t.content.children].map((el) => blockMd(el).replace(/^#+ /, '').replace(/\s+/g, ' '));
    searchText.set(k, { html, texts });
    return texts;
  }
  let searchSeq = 0, searchT = 0;
  const note = (t) => { const li = document.createElement('li'); li.className = 'none'; li.textContent = t; return li; };
  async function showHits(q) {
    const my = ++searchSeq;
    q = q.trim();
    $('#toc-hits').hidden = !q; $('#toc-main').hidden = !!q;
    if (!q) return;
    const ql = q.toLowerCase(), hits = [];
    for (const c of book.chapters) {
      const texts = await chapterTexts(c.id, (n, all) => { if (my === searchSeq) $('#toc-hits').replaceChildren(note(`本文を読み込み中 ${n}/${all}ページ（初めての検索だけ）`)); });
      if (my !== searchSeq) return;
      if (isPdf() && texts && !texts.some((t) => t.trim())) { $('#toc-hits').replaceChildren(note('この PDF には文字の情報がないので、検索できません（スキャンした PDF など）')); return; }
      (texts || []).forEach((t, i) => {
        const at = t.toLowerCase().indexOf(ql);
        if (at >= 0 && hits.length < 200) hits.push({ c, b: i + 1, t, at });
      });
    }
    const rows = hits.map((h) => {
      const s = Math.max(0, h.at - 18), frag = document.createElement('span'), m = document.createElement('mark');
      m.textContent = h.t.slice(h.at, h.at + q.length);
      frag.append((s ? '…' : '') + h.t.slice(s, h.at), m, h.t.slice(h.at + q.length, h.at + q.length + 60));
      const li = isPdf() ? tocItem(frag, '', async () => goTo(CH, h.b, true, pdfHitBox((await ptext)[h.b - 1], h.at, q.length)), h.b + 'ページ')
        : tocItem(frag, '', () => goTo(h.c.id, h.b, true), h.c.label);
      li.querySelector('.bm-at').className = 'at';
      return li;
    });
    if (!rows.length) rows.push(note('見つかりませんでした'));
    else if (hits.length >= 200) rows.push(note('200件まで表示しています'));
    $('#toc-hits').replaceChildren(...rows);
  }
  $('#toc-q').oninput = () => { clearTimeout(searchT); searchT = setTimeout(() => showHits($('#toc-q').value), 200); };
  $('#toc-q').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchT); showHits($('#toc-q').value); $('#toc-q').blur(); } };

  // 段落を指で長押しすると、しおりを付ける・外す。しおりの印を指でタップしても外れる。投げ縄の選択も指のタップで外れる（「指で書く」がオフのとき）
  let lp = null;
  const lpStop = () => { if (lp) { clearTimeout(lp.t); lp = null; } };
  page.addEventListener('touchstart', (e) => {
    lpStop();
    const t = e.touches[0];
    if (finger || e.touches.length !== 1 || t.touchType === 'stylus' || palms.has(t.identifier) || e.target.closest('.sph')) return;
    const x = t.clientX, y = t.clientY;
    lp = { x, y, t: setTimeout(() => { lp = null; toggleBm(blockAt((y - page.getBoundingClientRect().top) / scale)); }, 550) };
  }, { passive: true });
  page.addEventListener('touchmove', (e) => { const t = e.touches[0]; if (lp && Math.hypot(t.clientX - lp.x, t.clientY - lp.y) > 8) lpStop(); }, { passive: true });
  page.addEventListener('touchend', () => {
    if (!lp) return;
    const r = page.getBoundingClientRect(), x = (lp.x - r.left) / scale, y = (lp.y - r.top) / scale;
    lpStop();
    // 投げ縄で選んでいるときは、指で軽く触ると選択を外す
    if (sel.length || picked.length) { clearSel(); return; }
    // 印は紙の左余白、段落の上端あたりにある。指で押しやすいよう、余白全体と上端から 36px までを当たりにする
    const b = blockAt(y);
    if (x < 48 && blocks[b] && blocks[b].classList.contains('bm') && y - tops[b] < 36) toggleBm(b);
  });
  page.addEventListener('touchcancel', lpStop);

  // ---------- 設定画面 ----------
  const dlg = $('#cfg'), msg = $('#cfg-msg');
  // Google ドライブ: 書き込み・画像・答えの置き場所
  function showDrive(m) {
    $('#cfg-drive').textContent = cfg.drive ? (drive.ok() ? 'ドライブとのつながりを切る' : 'ドライブにつなぎ直す') : 'Google ドライブにつなぐ';
    $('#drv-msg').textContent = m || (cfg.drive ? (drive.ok() ? 'つながっています。書き込み・画像・Claude の答えは、ドライブの「Ink Reader」フォルダに置きます' : 'つながりが切れています（1時間ごとに切れます）') : '');
  }
  $('#cfg-drive').onclick = () => {
    if (cfg.drive && drive.ok()) { cfg.drive = false; store.set(PREF + ':cfg', JSON.stringify(cfg)); return showDrive('切りました（書き込みはこのiPadに残ります）'); }
    drive.login().then(() => {
      cfg.drive = true; store.set(PREF + ':cfg', JSON.stringify(cfg)); relogin = false;
      showDrive('つながりました。書き込みを送ります');
      switchBook(src);
    }).catch((e) => showDrive(e.message));
  };
  function openCfg() {
    drive.prep().catch(() => {});
    showDrive();
    $('#cfg-token').value = cfg.token; $('#cfg-repo').value = cfg.repo; $('#cfg-branch').value = cfg.branch; $('#cfg-book').value = cfg.book;
    msg.textContent = cfg.token ? '接続先を変えるときだけ書き換えてください' : '';
    dlg.showModal();
  }
  $('#cfg-ver').textContent = APP_VERSION.replace('ink-reader-', '');
  $('#gear').onclick = openCfg;
  async function connect(force) {
    msg.textContent = '接続中…';
    try {
      if (!online()) throw new Error('通信できません');
      if (isLocal()) await switchBook('gh');
      await syncBook(force);
      msg.textContent = '本をダウンロードしました';
      fillChapters(); $('#empty').hidden = true; chapSel.disabled = false;
      await openChapter(CH && ids.includes(CH) ? CH : (store.get(memKey('chapter')) || 'ch1'), true);
      pushAll();
      return true;
    } catch (e) {
      msg.textContent = e.status === 401 ? 'トークンが無効です' : e.status === 403 || e.status === 404 ? 'リポジトリか本のフォルダが見つからないか、トークンに権限がありません' : (e.message || '接続できませんでした');
      return false;
    }
  }
  $('#cfg-save').onclick = async () => {
    cfg = { ...cfg, token: $('#cfg-token').value.trim(), repo: $('#cfg-repo').value.trim() || DEF.repo,
      branch: $('#cfg-branch').value.trim() || DEF.branch, session: cfg.session, book: $('#cfg-book').value.trim().replace(/\/+$/, '') || DEF.book };
    store.set(PREF + ':cfg', JSON.stringify(cfg));
    if (await connect(false)) setTimeout(() => dlg.close(), 600);
  };
  $('#cfg-sync').onclick = () => connect(true);

  // ---------- 本（ファイルから開く・切り替え） ----------
  // ファイルから開いた本: kv 'book:local:<id>' = { title, local:true, chapters:[{id,label,file}] }、本文は 'md:local:<id>:<章>'
  // 一覧は kv 'books' = [{ id, title }]（新しい順）
  function setSrc(v) { src = v; store.set(PREF + ':book', v); }
  function leaveBook() {   // 今の章を保存してから本を切り替える
    if (CH) store.set(memKey('pos:' + CH), String(scrollY));
    if (cs) persist();
    if (cs && cs.pending.size) pushChapter(CH);
    CH = null; cs = null;
    closePdf();
  }
  async function switchBook(v) {
    leaveBook(); setSrc(v);
    if (!await loadBook()) { $('#empty').hidden = false; chapSel.disabled = true; document.body.classList.remove('pdf'); doc.replaceChildren(srcLine); srcLine.textContent = ''; initBlocks(); showBlocks({}); setAnswers('', []); layout(); showPgno(); return; }
    $('#empty').hidden = true; chapSel.disabled = false;
    fillChapters();
    await openChapter(store.get(memKey('chapter')) || ids[0], true);
    if (!isLocal()) { pushAll(); if (canSync()) syncBook(false).catch(() => {}); }
  }
  const mdTitle = (md, name) => ((md.match(/^#{1,3}\s+(.+)$/m) || [])[1] || name.replace(/\.[^.]+$/, '')).replace(/[*_`$]/g, '').trim();
  async function addBook(id, meta) {
    await kv.set('book:' + id, meta);
    await kv.set('books', [{ id, title: meta.title }, ...((await kv.get('books')) || [])]);
    return { id, title: meta.title };
  }
  async function importMd(files) {
    const id = 'local:' + newId(), chapters = [];
    for (const [i, f] of files.entries()) {
      const md = await f.text(), c = { id: 'c' + (i + 1), label: mdTitle(md, f.name), file: f.name };
      await kv.set('md:' + id + ':' + c.id, { sha: f.name + ':' + f.size + ':' + f.lastModified, md });
      chapters.push(c);
    }
    const title = chapters[0].label + (chapters.length > 1 ? ` ほか${chapters.length - 1}章` : '');
    return addBook(id, { title, local: true, chapters, images: {} });
  }
  // PDF は1ファイルを1冊にする。PDF そのものは 'pdf:<本>' に置き、ページの大きさだけ先に調べておく（開くたびに全ページを読まないため）
  async function importPdf(f) {
    const id = 'local:' + newId();
    stat.textContent = `「${f.name}」を読み込み中…`;
    try { await kv.set('pdf:' + id, f); } catch { await kv.set('pdf:' + id, await f.arrayBuffer()); }
    let pd = null;
    try {
      pd = await openPdf(new Uint8Array(await f.arrayBuffer()));
      const sizes = [];
      for (let i = 1; i <= pd.numPages; i++) {
        const v = (await pd.getPage(i)).getViewport({ scale: 1 });
        sizes.push([Math.round(v.width * 100) / 100, Math.round(v.height * 100) / 100]);
        if (i % 25 === 0) stat.textContent = `PDF を読み込み中 ${i}/${pd.numPages}ページ`;
      }
      const title = f.name.replace(/\.pdf$/i, '');
      return await addBook(id, { title, local: true, pdf: true, chapters: [{ id: 'pdf', label: title, file: f.name }], sizes, images: {} });
    } catch (e) { kv.del('pdf:' + id).catch(() => {}); throw e; }
    finally { if (pd) pd.destroy(); }
  }
  const isPdfFile = (f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
  async function openFiles(files) {
    files = [...files].sort((x, y) => x.name.localeCompare(y.name, 'ja', { numeric: true }));
    if (!files.length) return;
    const opened = [];
    for (const f of files.filter(isPdfFile)) opened.push(await importPdf(f));
    const mds = files.filter((f) => !isPdfFile(f));
    if (mds.length) opened.push(await importMd(mds));
    shelf.close();
    await switchBook(opened[opened.length - 1].id);
    stat.textContent = `「${opened.map((b) => b.title).join('」「')}」をこのiPadに保存しました`;
  }
  for (const el of document.querySelectorAll('.open-file')) el.onchange = () => { openFiles(el.files).catch((e) => { stat.textContent = '開けませんでした: ' + (e.message || ''); }); el.value = ''; };
  const shelf = $('#shelf');
  async function showShelf() {
    const list = (await kv.get('books')) || [];
    const gh = cfg.token || await kv.get('book:' + cfg.repo + '@' + cfg.branch + ':' + cfg.book);
    const rows = (gh ? [{ id: 'gh', title: 'GitHub: ' + cfg.book.split('/').pop() }] : []).concat(list);
    $('#shelf-list').replaceChildren(...rows.map((r) => {
      const li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button'; b.className = 'open'; b.textContent = r.title; b.setAttribute('aria-current', String(r.id === src));
      b.onclick = () => { shelf.close(); if (r.id !== src || !CH) switchBook(r.id); };
      li.append(b);
      if (r.id !== 'gh') {   // ファイルから開いた本だけ消せる（2回押す）
        const d = document.createElement('button'); d.type = 'button'; d.className = 'del'; d.textContent = '削除';
        d.onclick = async () => {
          if (!d.classList.contains('arm')) { d.classList.add('arm'); d.textContent = 'もう一度押すと削除'; return; }
          const meta = await kv.get('book:' + r.id);
          for (const c of (meta && meta.chapters) || []) for (const k of ['md:', 'html:', 'ink:']) await kv.del(k + r.id + ':' + c.id);
          await kv.del('book:' + r.id); await kv.del('pdf:' + r.id); await kv.del('ptext:' + r.id);
          await kv.set('books', ((await kv.get('books')) || []).filter((x) => x.id !== r.id));
          if (r.id === src) { CH = null; cs = null; await switchBook('gh'); }
          showShelf();
        };
        li.append(d);
      }
      return li;
    }));
    if (!shelf.open) shelf.showModal();
  }
  $('#books').onclick = showShelf;

  // ---------- boot ----------
  const z = store.get(PREF + ':zoom');
  scale = z && z !== 'fit' ? +z : fitScale();
  zoomMode = z && z !== 'fit' ? 'manual' : 'fit';
  layout();
  (async () => {
    if (isLocal() && !await loadBook()) setSrc('gh');
    await loadBook();
    if (!book && canSync()) { try { await syncBook(); } catch (e) { stat.textContent = '本をダウンロードできませんでした: ' + (e.message || ''); } }
    if (!book) { $('#empty').hidden = false; chapSel.disabled = true; return; }
    fillChapters();
    const fromHash = location.hash.slice(1);
    await openChapter(ids.includes(fromHash) ? fromHash : (store.get(memKey('chapter')) || 'ch1'), true);
    pushAll();
    // 起動のたびに本の更新を確認（変わった章だけ取り直す）
    if (canSync()) syncBook(false).then(() => { stat.textContent = ''; }).catch(() => {});
  })();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
