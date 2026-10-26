// ぐちゃぐちゃ消しの判定（app.js の scribbleTargets）を、合成した線で確かめる。ブラウザは使わない
// 使い方: node tests/scribble.cjs [比べる app.js ...]   消すべき形（横往復・縦ギザギザ・くるくる）と、消してはいけない字（m・w・M など）を数える
// 2026-10 時点: 53/70。残りは「小さい字の上の3〜4往復」「3往復だけ」「斜めの往復」「mm・eee を字の上に書く」で、続け書きの誤爆を避けるための割り切り
const fs = require('fs');
const src = (f) => { const t = fs.readFileSync(f, 'utf8'); const i = t.indexOf('  // 往復の多い線'); const j = t.indexOf('// ---------- 投げ縄', i); return t.slice(i, j); };
const make = (code) => { let strokes = []; const top = () => 0; const fn = new Function('strokes', 'top', code + '; return scribbleTargets;');
  return (scr, others) => { strokes = others; return fn(strokes, top)(scr); }; };
const bbox = (s) => { let a=1e9,b=1e9,c=-1e9,d=-1e9; for (const [x,y] of s.pts){a=Math.min(a,x);b=Math.min(b,y);c=Math.max(c,x);d=Math.max(d,y);} s.bbox=[a,b,c,d]; return s; };
let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - .5);
const S = (pts, s = 3.4) => bbox({ tool: 'pen', s, pts: pts.map(([x,y]) => [x + rnd()*0.8, y + rnd()*0.8, .5]) });
// 点列を細かく補間（240Hz 相当）
const dense = (poly, step = 1.5) => { const out = []; for (let i = 1; i < poly.length; i++) { const [x0,y0]=poly[i-1],[x1,y1]=poly[i]; const n = Math.max(1, Math.ceil(Math.hypot(x1-x0,y1-y0)/step)); for (let k=0;k<n;k++) out.push([x0+(x1-x0)*k/n, y0+(y1-y0)*k/n]); } out.push(poly[poly.length-1]); return out; };
const curve = (f, n = 200) => Array.from({ length: n + 1 }, (_, i) => f(i / n));
// 単語: x0..x0+W, 高さ H の小さな字（丸と縦棒）を並べる
function word(x0, y0, W, H) { const out = []; const n = Math.max(1, Math.round(W / (H * .8))); const cw = W / n;
  for (let i = 0; i < n; i++) { const cx = x0 + cw * (i + .5), cy = y0 + H / 2;
    if (i % 2) out.push(S(curve((t) => [cx + Math.cos(t * 6.6) * cw * .35, cy + Math.sin(t * 6.6) * H * .4], 60)));
    else out.push(S(dense([[cx - cw * .2, y0], [cx + cw * .1, y0 + H], [cx + cw * .3, y0 + H * .4]]))); }
  return out; }
const scribbles = {
  '横に往復 3回(2折り返し)': (x, y, W, H) => dense([[x, y + H*.3], [x + W, y + H*.5], [x, y + H*.7], [x + W, y + H*.6]]),
  '横に往復 4回': (x, y, W, H) => dense([[x, y + H*.2], [x + W, y + H*.4], [x, y + H*.6], [x + W, y + H*.8], [x+W*.1, y + H*.5]]),
  '横に往復 6回': (x, y, W, H) => dense([...Array(7)].map((_, i) => [i % 2 ? x + W : x, y + H * (.15 + .7 * i / 6)])),
  '縦ギザギザ 5山': (x, y, W, H) => dense([...Array(11)].map((_, i) => [x + W * i / 10, i % 2 ? y + H : y])),
  '縦ギザギザ 8山': (x, y, W, H) => dense([...Array(17)].map((_, i) => [x + W * i / 16, i % 2 ? y + H : y])),
  '縦ギザギザ 5山 往復': (x, y, W, H) => { const f = [...Array(11)].map((_, i) => [x + W * i / 10, i % 2 ? y + H : y]); return dense([...f, ...f.slice().reverse().map(([a,b]) => [a + 4, b])]); },
  'くるくる 6周': (x, y, W, H) => curve((t) => [x + H/2 + (W - H) * t + Math.cos(t * 6 * 6.283) * H / 2, y + H / 2 + Math.sin(t * 6 * 6.283) * H / 2], 600),
  '斜めに往復 5回': (x, y, W, H) => dense([...Array(6)].map((_, i) => i % 2 ? [x + W * (.2 + .15 * i), y] : [x + W * .15 * i, y + H])),
};
const ok = [], cases = [];
for (const [name, f] of Object.entries(scribbles)) for (const [W, H] of [[100, 22], [24, 22], [200, 24]]) {
  const tg = word(100, 100, W, H);
  cases.push({ kind: '消すべき', name: `${name} ${W}x${H}`, scr: S(f(98, 99, W + 4, H + 2)), others: tg, want: tg.length });
  // 少し小さめ・ずれたぐちゃぐちゃ（字の上下がはみ出す）
  cases.push({ kind: '消すべき', name: `${name} ${W}x${H} 低め`, scr: S(f(102, 104, W - 4, H * .7)), others: tg, want: tg.length });
}
// 普通に書いた字（既存の線の上に書き直し）。消えてはいけない
const H = 22, X = 300, Y = 300;
const letters = {
  m: dense([[X, Y + H], [X, Y + H*.3], [X + 4, Y], [X + 9, Y + H*.3], [X + 9, Y + H], [X + 9, Y + H*.3], [X + 13, Y], [X + 18, Y + H*.3], [X + 18, Y + H]]),
  mm: dense([[X, Y + H], [X, Y], [X + 9, Y + H], [X + 9, Y], [X + 18, Y + H], [X + 18, Y], [X + 27, Y + H], [X + 27, Y], [X + 36, Y + H]]),
  w: dense([[X, Y], [X + 5, Y + H], [X + 10, Y + 5], [X + 15, Y + H], [X + 20, Y]]),
  M: dense([[X, Y + H], [X, Y], [X + 10, Y + H*.7], [X + 20, Y], [X + 20, Y + H]]),
  N: dense([[X, Y + H], [X, Y], [X + 15, Y + H], [X + 15, Y]]),
  Z: dense([[X, Y], [X + 18, Y], [X, Y + H], [X + 18, Y + H]]),
  '≶ 3': dense([[X, Y], [X + 15, Y + 4], [X, Y + 9], [X + 15, Y + 13], [X, Y + 18]]),
  eee: curve((t) => [X + 40 * t + Math.cos(t * 3 * 6.283 + 3.14) * 6, Y + H/2 + Math.sin(t * 3 * 6.283) * H/2], 300),
  ζ: dense([[X, Y], [X + 12, Y], [X, Y + 12], [X + 3, Y + 20], [X + 12, Y + 18], [X + 8, Y + 26]]),
  '∿∿ 波線': curve((t) => [X + 120 * t, Y + Math.sin(t * 4 * 6.283) * 5], 400),
};
for (const [name, pts] of Object.entries(letters)) {
  cases.push({ kind: '消さない', name: `${name} を字の上に`, scr: S(pts), others: word(X - 2, Y, 40, H), want: 0 });
  cases.push({ kind: '消さない', name: `${name} の中に点`, scr: S(pts), others: [S([[X + 8, Y + 12]])], want: 0 });
}
cases.push({ kind: '消さない', name: '二重下線（往復）を字の下に', scr: S(dense([[X, Y + H + 4], [X + 100, Y + H + 5], [X, Y + H + 9], [X + 100, Y + H + 10]])), others: word(X, Y, 100, H), want: 0 });
cases.push({ kind: '消さない', name: 'W を字の上に', scr: S(dense([[X, Y], [X + 8, Y + H], [X + 16, Y], [X + 24, Y + H], [X + 32, Y]])), others: word(X, Y, 30, H), want: 0 });
const files = process.argv.length > 2 ? process.argv.slice(2) : [require('path').join(__dirname, '../app.js')];
for (const file of files) {
  const fn = make(src(file)); let good = 0; const bad = [];
  for (const c of cases) { const r = fn(c.scr, c.others); const n = r ? r.length : 0; const pass = c.want ? n === c.want : n === 0; if (pass) good++; else bad.push(`  ✗ [${c.kind}] ${c.name}: ${n}/${c.others.length}`); }
  console.log(`${file}: ${good}/${cases.length}`); console.log(bad.join('\n'));
}
