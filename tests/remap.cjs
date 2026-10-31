// 本文が変わったときの段落の付け直し（app.js の remapOf）を、ハッシュの並びで確かめる。ブラウザは使わない
// 使い方: node tests/remap.cjs
const fs = require('fs'), path = require('path');
const t = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8'), i = t.indexOf('  function remapOf('), e = t.indexOf('\n  }\n', i) + 4;
const remapOf = new Function(t.slice(i, e) + '; return remapOf;')();
let ok = true;
const check = (name, from, to, want) => { const got = remapOf(from, to), g = JSON.stringify(got); console.log(g === JSON.stringify(want) ? '✓' : '✗', name, g); if (g !== JSON.stringify(want)) ok = false; };
const A = ['s', 'a', 'b', 'c', 'd', 'e'];
check('同じ', A, A, null);
check('前に1段落', A, ['s', 'x', 'a', 'b', 'c', 'd', 'e'], [0, 2, 3, 4, 5, 6]);
check('前書きが消えた（2段落減る）', ['s', 'hr', 'fm', 'a', 'b', 'c'], ['s', 'a', 'b', 'c'], [0, 0, 0, 1, 2, 3]);
check('段落を書き直した', A, ['s', 'a', 'B', 'c', 'd', 'e'], null);
check('書き直して前に1段落', A, ['s', 'x', 'a', 'B', 'c', 'd', 'e'], [0, 2, 3, 4, 5, 6]);
check('うしろに足した', A, A.concat(['f', 'g']), null);
check('最後を消した', A, A.slice(0, 4), [0, 1, 2, 3, 3, 3]);
check('段落を消した（前の段落へ寄せる）', A, ['s', 'a', 'c', 'd', 'e'], [0, 1, 1, 2, 3, 4]);
check('段落を2つに分けた', A, ['s', 'a', 'b1', 'b2', 'c', 'd', 'e'], [0, 1, 2, 4, 5, 6]);
check('同じ字の段落が並ぶ', ['s', 'a', 'q', 'q', 'b'], ['s', 'x', 'a', 'q', 'q', 'b'], [0, 2, 3, 4, 5]);
check('前の版の記録（書き込みのある段落だけ）', ['s', null, null, 'c', null, 'e'], ['s', 'new', 'a', 'b', 'c', 'd', 'e'], [0, 1, 3, 4, 5, 6]);
check('入れ替わり', A, ['s', 'a', 'c', 'b', 'd', 'e'], [0, 1, 3, 2, 4, 5]);
// 3000 段落でも速い
const big = [...Array(3000)].map((_, k) => 'p' + k), big2 = ['p-new'].concat(big.slice(0, 1500), big.slice(1501));
const t0 = Date.now(), m = remapOf(big, big2);
console.log(m[1] === 2 && m[1499] === 1500 && m[1501] === 1501 && m[2999] === 2999 ? '✓' : '✗', '3000 段落の付け直し', Date.now() - t0 + 'ms', [m[1], m[1499], m[1500], m[1501], m[2999]]);
if (!(m[1] === 2 && m[1499] === 1500 && m[1501] === 1501 && m[2999] === 2999)) ok = false;
process.exit(ok ? 0 : 1);
