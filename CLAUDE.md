# Ink Reader（開発用メモ）

iPad と Apple Pencil で、md（数式つき）の本に手書きで書き込める Web アプリ（PWA、GitHub Pages: https://syakaikungg.github.io/ink_reader/ ）。
利用者は syakaikungg（masaki）。返答・コミットメッセージ・PR は日本語。PC は使わず、クラウドのセッションと iPad だけで開発・利用する。

**方針は [docs/principles.md](docs/principles.md)。軽さと滑らかさが最優先**（重くなる変更は入れない）。

## 仕組み

- 本は「本」ボタンから iPad の「ファイル」の md を開くこともできる（GitHub なし。端末の IndexedDB だけに保存、`app.js` の `openFiles` / `switchBook`）。
- GitHub の本と書き込みは別の非公開リポジトリ `syakaikungg/sakai_study` にある（`books/nishimori/`：`book.json`、`chapters/<章>.md`、`ink/<章>.json`）。アプリは iPad で入力された fine-grained PAT で GitHub API を直接読み書きする。
- 端末側は IndexedDB に本・図・書き込みを保存し、未送信の段落を貯めてオンライン時に送る。409/422 のときは取り込んでからまとめ直す（`app.js` の `pushChapter` / `merge`）。
- 書き込みは「`#doc` の何番目の子要素（段落）か」と、その段落の上端からの座標×10で保存する。`render.js` の段落の分け方を変えると、既存の書き込みがずれる。出力を変えたら `renderMarkdown.version` を上げる（端末内の HTML キャッシュを作り直すため）。
- 紙は幅 680px 固定で、拡大は CSS transform。2本指のピンチ中は `#sizer` を transform で伸ばすだけにし、指を離したときに拡大率を決めてレイアウトし直す（Safari の画面全体の拡大は止めている）。線は perfect-freehand で SVG にする。描画は requestAnimationFrame にまとめ、getCoalescedEvents / getPredictedEvents を使う。
- 機能：ペン（選んでいる色・太さのボタンをもう一度押すと色の一覧・太さのつまみ。端末に覚え、自分で選んだ色は線に `#rrggbb` で保存。線の終わりでペンを止めると `fitShape` で直線・円・楕円・三角・四角に直し（水平・垂直に近ければそろえる。マーカーは直線だけ）、離さずに動かすと向き・大きさが変わる。図形の形は線の `g` に残し、書いた直後か投げ縄で1本選ぶと出るつまみで形を変えられる）・マーカー・消しゴム・ぐちゃぐちゃ消し・投げ縄（移動・色・太さ・削除）・戻す/進む・章の切替（章の名前を押すと目次・しおり。しおりは段落を指で長押しで付け外しし（印のタップでも外れる）、本ごとに端末の localStorage に保存。目次の一番上の欄で本文を検索でき、押すとその段落へ飛ぶ）・「Claudeに聞く」。「Claudeに聞く」では、囲んだ段落の本文（数式は TeX に戻す）と手書きを、Claude アプリか sakai_study の Claude Code セッションに渡す。いつものセッションの URL は端末に保存する。
- PDF も「ファイルから開く」で開ける（1ファイル1冊、PDF 本体は IndexedDB の `pdf:<本>`、ページの大きさは本の情報 `sizes` に先に入れておく）。1ページを `#doc` の子要素1つ（`.pg`）にし、段落と同じ仕組みで書き込みを結びつける（段落番号 = ページ番号、座標はページ上端からの幅 680 の紙の px。書き込みの JSON にはページの大きさ `pt` も入れる）。PDF.js（`vendor/pdfjs/`、5.7.284）は PDF を開くときだけ読み込み、IntersectionObserver で画面の近くのページだけ canvas に描き、離れたら捨てる（`app.js` の「PDF」）。右下の「12 / 300」でページへ飛ぶ。目次には PDF のしおりを出す。「Claudeに聞く」は囲んだ範囲を画像にして渡す。
- 「sakai_studyで聞く」の質問文には質問ID が付く。sakai_study のセッションは答えを `books/<本>/answers/<章>.md` に `<!-- ink-answer id=<質問ID> b=<段落番号,…> -->` の行で区切って追記し、アプリは章を開くとき・アプリに戻ったときにそれを読んで、段落の右余白の「Q」から答えを開く（`app.js` の「Claude の答え」）。答え待ちの質問は端末だけに保存する。
- sakai_study 側では、`CLAUDE.md` の「Ink Reader からの質問」と `scripts/ink_view.py`（手書きを PNG にする）で質問に答える。

## 変更するとき

- ビルドはない。`vendor/` のライブラリはそのまま読み込む（KaTeX 0.16.11、marked 12.0.2、perfect-freehand 1.2.2、PDF.js 5.7.284）。
- アプリのファイルを変えたら `sw.js` の `VERSION` を上げる（上げないと、iPad に古い版が残る）。
- 確認：`node tests/smoke.cjs <sakai_study のパス>`（Playwright で GitHub API をモック）。ぐちゃぐちゃ消しの判定を変えたら `node tests/scribble.cjs` でも確かめる。PDF は `node tests/pdf.cjs`（300ページの PDF を作って確かめる。sakai_study は要らない）。`MD_DIR=<md のフォルダ>` を付けると「ファイルから開く」も確かめる。書き味やカクつきは、実機でしか分からない。利用者に試してもらい、入力の Hz と描画の fps（画面上部に表示される）を聞く。
- ブランチを切って PR を作り、利用者がマージする。main にマージすると Pages に反映される。
