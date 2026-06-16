# HANDOFF.md — Claude Code 移行のための引き継ぎ手順

このファイルは、新体制（Claude Code + GitHub + Netlify連携）に移行するための作業ガイドです。
すべて完了したら、このファイルは削除して構いません。

## 現状

- **これまで**: Claudeチャットでコード生成 → コピペ → Netlify Drop で手動アップ
- **これから**: Claude Code でファイル直接編集 → Git でコミット → GitHub にプッシュ → Netlify が自動デプロイ

## 引き継ぎ作業 5ステップ

### ステップ1: このフォルダをMacの作業場所に配置

このフォルダを、Macのわかりやすい場所（例：`~/Documents/strawberry-field/` または `~/Projects/strawberry-field/`）に配置してください。

### ステップ2: timely.html を補完

このフォルダの `apps/` には現状3ファイルしか入っていません。
**最新の `timely.html`（特記事項機能・割引機能などが入った最新版）** を `apps/timely.html` として配置してください。

最新版は、Netlifyの `strawberry-field-app.netlify.app` で配信されているもの、または前のClaudeセッションで `/mnt/user-data/outputs/timely.html` として出力されていたものを使ってください。

### ステップ3: Git でローカルリポジトリ化

ターミナルでこのフォルダに入って、

```bash
cd ~/Documents/strawberry-field   # 配置した場所
git init
git add .
git commit -m "Initial commit: STRAWBERRY FIELD reservation system"
```

### ステップ4: GitHubにプッシュ

GitHub.comで新しいリポジトリを作成（例：`strawberry-field`、Privateでも Public でもOK）。
そのあとターミナルで、

```bash
git remote add origin https://github.com/あなたのID/strawberry-field.git
git branch -M main
git push -u origin main
```

### ステップ5: NetlifyをGitHubと連携

Netlifyの管理画面で `strawberry-field-app` プロジェクトを開く。

- 「**Project configuration**」→「**Build & deploy**」→「**Link to a Git repository**」
- GitHubと連携 → リポジトリ `strawberry-field` を選択
- ブランチ: `main`
- ビルドコマンド: 空（または `# none`）
- 公開ディレクトリ: `.`（リポジトリのルート）

これで、`main` ブランチにプッシュするたびに自動デプロイされます。

## 移行完了後の開発フロー

1. Claude Code でファイル編集（`claude` コマンドでターミナル起動）
2. ローカルで動作確認（`apps/index.html` をブラウザで開く）
3. テスト実行（必要に応じて）
4. `git add . && git commit -m "..."` でコミット
5. `git push` でプッシュ → Netlifyが自動デプロイ

## 注意点

- **localStorage互換性**: 既存ユーザー（あゆみさんなど）のlocalStorageデータを壊さないよう、データ構造の変更時は移行コードを入れること
- **本番URL**: `strawberry-field-app.netlify.app` を維持（他のNetlifyプロジェクトは削除済みであることを確認）
- **コミットメッセージ**: わかりやすく日本語でも英語でも構わない（例: "領収書の合計表示を修正"、"Add discount auto-fill for salon reservations"）

## Firebase移行の準備（将来）

このGitHub-Netlify連携が安定したら、次は Firebase 移行に進みます。
`planning/firebase-roadmap.html` を参照してください。

主な検討事項:
- データ移行: localStorage → Firestore
- 認証: Anonymous または Email/Password
- リアルタイム同期: onSnapshot リスナー
- セキュリティルール: 園ごと・役職ごとのアクセス制御
