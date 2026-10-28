# Ink Reader

md（数式つき）の本を章ごとに表示し、iPad と Apple Pencil で書き込むための Web アプリです。
ホーム画面に追加すると、通信なしでも起動できます。

- 本文と書き込みはこのリポジトリには入っていません。非公開リポジトリ（既定 `syakaikungg/sakai_study`）から、iPad で入力した GitHub トークンを使って読み書きします。
- 本・図・書き込みは iPad の IndexedDB にも保存されます。通信がない間の書き込みは端末に貯めておき、つながったときに送ります。
- 書き込みは `<本のフォルダ>/ink/<章>.json` に「何番目の段落か」と段落内の座標で保存されます。AI はこのファイルと本文の md を合わせて読めます。

## 本のフォルダの形

```
books/nishimori/
  book.json          章の一覧（id, label, file）と図のフォルダ（imageDir）・図のサイズ（images）
  chapters/<id>.md   章ごとの md（$…$ / $$…$$ の数式）
  ink/<id>.json      書き込み（アプリが作る）
```

`book.json` と `chapters/` は sakai_study の `scripts/split_book.py` で一冊の md から作ります。

## トークン

GitHub の Settings → Developer settings → Fine-grained tokens で、対象を本のリポジトリだけにし、Repository permissions の Contents を Read and write にして作ります。

## 構成

- `index.html` / `app.js`: 画面と書き込み・同期
- `render.js`: md → HTML（KaTeX）。段落の分け方を変えると既存の書き込みがずれるので注意
- `sw.js`: アプリ本体のキャッシュ（更新したら `VERSION` を上げる）
- `vendor/`: KaTeX 0.16.11、marked 12.0.2、perfect-freehand 1.2.2、Source Serif 4

## 著作権

Copyright (C) 2026 syakaikungg. All rights reserved.

`vendor/` のライブラリは、それぞれのライセンス（KaTeX・marked・perfect-freehand は MIT、PDF.js は Apache 2.0）に従います。
