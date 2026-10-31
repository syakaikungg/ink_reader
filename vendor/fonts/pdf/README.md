# 書き出し用の字体

md の本を PDF に書き出すとき（`export-md.js`）、文字を文字のまま PDF に埋め込むための字体。書き出すときだけ読み込む（ふだんは読まない）。

- `NotoSerifJP-Regular.ttf`: Noto Serif JP の太さ 400（Google Fonts の TTF。npm の `@expo-google-fonts/noto-serif-jp@0.4.4` から）を、cp932（JIS 第1・第2水準ほか）で表せる文字と記号に絞ったもの（7,932 字）。レイアウトの表とヒントは外した。これにない字は、書き出すときに画面の字を絵にして置く。
- `SourceSerif4-Regular.ttf` / `-Semibold.ttf` / `-Italic.ttf`: `vendor/fonts/SourceSerif4-latin*.woff2`（可変の字体）を、太さ 400・600、opsz 16 に固定した TTF。fontkit が可変の woff2 を subset できないため。
- `KaTeX_*.ttf`: 数式の字体。`vendor/fonts/KaTeX_*.woff2`（KaTeX 0.16.11）を TTF に戻しただけ（字の形・幅は画面と同じ）。fontkit は woff2 を subset すると字が空になるため。KaTeX の字体は MIT ライセンス。

画面の md の本文も同じ字で描く（端末が違っても行の折り返しをそろえるため）。`../NotoSerifJP-cp932.woff2` は `NotoSerifJP-Regular.ttf` を woff2 にしただけのもの（`f = TTFont('NotoSerifJP-Regular.ttf'); f.flavor = 'woff2'; f.save('../NotoSerifJP-cp932.woff2')`。brotli が要る）。

ライセンスは KaTeX 以外は SIL Open Font License 1.1（`OFL.txt`）。作り方（fonttools 4.68）:

```python
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
import glob, os

def cp932(c):
    try: chr(c).encode('cp932'); return True
    except UnicodeEncodeError: return False
extra = [(0x20, 0x7f), (0xa0, 0x180), (0x2000, 0x2070), (0x2190, 0x2300), (0x2460, 0x24ff), (0x3000, 0x3100), (0xff00, 0xfff0)]
cps = {c for c in range(0x20, 0x10000) if cp932(c)} | {c for a, z in extra for c in range(a, z)}
f = TTFont('NotoSerifJP_400Regular.ttf')
o = subset.Options(); o.layout_features = []; o.name_IDs = ['*']; o.notdef_outline = True; o.hinting = False
s = subset.Subsetter(o); s.populate(unicodes=[c for c in cps if c in f.getBestCmap()]); s.subset(f)
f['glyf'].padding = 2   # fontkit の subset は loca を短い形で書くので、字の長さを偶数にそろえておく（奇数だと字が消える）
f.save('NotoSerifJP-Regular.ttf')

for w, name in ((400, 'Regular'), (600, 'Semibold')):
    g = instancer.instantiateVariableFont(TTFont('../SourceSerif4-latin.woff2'), {'wght': w, 'opsz': 16}); g.flavor = None
    g.save(f'SourceSerif4-{name}.ttf')
g = instancer.instantiateVariableFont(TTFont('../SourceSerif4-latin-italic.woff2'), {'opsz': 16}); g.flavor = None
g.save('SourceSerif4-Italic.ttf')
for p in glob.glob('../KaTeX_*.woff2'):
    g = TTFont(p); g.flavor = None; g['glyf'].padding = 2
    g.save(os.path.basename(p)[:-6] + '.ttf')
```
