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
- 機能：ペン・マーカー・消しゴム・ぐちゃぐちゃ消し・投げ縄（移動・色・太さ・削除）・戻す/進む・章の切替（章の名前を押すと目次・しおり。しおりは段落を指で長押しで付け外しし（印のタップでも外れる）、本ごとに端末の localStorage に保存）・「Claudeに聞く」。「Claudeに聞く」では、囲んだ段落の本文（数式は TeX に戻す）と手書きを、Claude アプリか sakai_study の Claude Code セッションに渡す。いつものセッションの URL は端末に保存する。
- sakai_study 側では、`CLAUDE.md` の「Ink Reader からの質問」と `scripts/ink_view.py`（手書きを PNG にする）で質問に答える。

## 変更するとき

- ビルドはない。`vendor/` のライブラリはそのまま読み込む（KaTeX 0.16.11、marked 12.0.2、perfect-freehand 1.2.2）。
- アプリのファイルを変えたら `sw.js` の `VERSION` を上げる（上げないと、iPad に古い版が残る）。
- 確認：`node tests/smoke.cjs <sakai_study のパス>`（Playwright で GitHub API をモック）。ぐちゃぐちゃ消しの判定を変えたら `node tests/scribble.cjs` でも確かめる。`MD_DIR=<md のフォルダ>` を付けると「ファイルから開く」も確かめる。書き味やカクつきは、実機でしか分からない。利用者に試してもらい、入力の Hz と描画の fps（画面上部に表示される）を聞く。
- ブランチを切って PR を作り、利用者がマージする。main にマージすると Pages に反映される。
