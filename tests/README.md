# tests/

JSDOMベースの関数単位テストを置く場所です。

## テストの考え方

各HTMLファイル内の `<script>` を抽出して、Node.js + JSDOM で実行し、
関数の振る舞いを検証します。

## ファイル構成（例）

```
tests/
├── README.md (このファイル)
├── timely/
│   ├── test_timely.js          (基本動作)
│   ├── test_discount.js        (割引機能)
│   ├── test_special_note.js    (特記事項)
│   └── ...
├── board/
│   └── test_board.js
└── shared/
    └── helpers.js              (共通ヘルパー)
```

## 既存テストの引き継ぎ

過去のセッションで作られた以下のテストは、引き継ぎ完了後に該当フォルダへ移行してください。

- `test_timely.js` (17件)
- `test_items2.js` (11件)
- `test_clothing.js` (11件)
- `test_receipt_nav.js` (11件)
- `test_salon_discount.js` (14件)
- `test_discount_ui.js` (22件)
- `test_discount_v2.js` (15件)
- `test_v44.js` (19件)
- `test_visit_time_validation.js` (10件)
- `test_special_note.js` (18件)

合計148件すべてパスしている状態が最新のベースラインです。

## 実行方法

```bash
cd tests
node timely/test_timely.js
```

複数まとめて実行するスクリプトは、必要に応じて `run-all.sh` などとして追加してください。

## 注意点

詳細は `../CLAUDE.md` の「テストのやり方」を参照してください。
特に以下に注意：

1. `<script>` 抽出時に `api.anthropic` を含むartifact内スクリプトは除外
2. localStorageモックは実際に読み書きする形にする
3. AudioContext / setInterval / requestAnimationFrame / alert もモック
4. ネストしたテンプレートリテラルは構文エラーを起こす → 文字列連結で書く
