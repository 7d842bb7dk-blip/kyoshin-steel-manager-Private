# 他のPCで開発する手順（Claude Code 対応）

このシステムは GitHub のプライベートリポジトリで管理されています。
どのPCからでも clone して開発でき、**push すると約3分で本番サーバーに自動反映**されます。

- リポジトリ：`https://github.com/7d842bb7dk-blip/kyoshin-steel-manager-Private.git`
- 本番：サーバー機（PROGRAM-TSUJIMOTO の PC）の `http://192.168.1.107:3001/`

---

## 1. 初回セットアップ（PCごとに1回だけ）

1. **インストール**（すべて公式サイトの標準インストールでOK）
   - [Git](https://git-scm.com/downloads)
   - [Node.js](https://nodejs.org/)（LTS 版）
   - [Claude Code](https://claude.com/claude-code)（コーディングに使う場合）
2. **clone**（コマンドプロンプトで）
   ```
   cd %USERPROFILE%\Desktop
   git clone https://github.com/7d842bb7dk-blip/kyoshin-steel-manager-Private.git
   cd kyoshin-steel-manager-Private
   npm install
   ```
   初回はブラウザで GitHub のログイン画面が開くので、リポジトリにアクセスできる
   アカウントでログインする（別アカウントを使う場合は、GitHub の
   Settings → Collaborators で招待しておくこと）。
3. **動作確認**：`開発用起動.bat` をダブルクリック → `http://localhost:3002/` が開けたらOK。

## 2. 日常の開発の流れ

```
git pull                  ← 作業前に必ず最新化
（編集する。Claude Code なら clone したフォルダを開くだけ。CLAUDE.md が読み込まれる）
開発用起動.bat            ← 手元で動作確認（ポート3002・開発用DB。本番データには一切触れない）
git add -A
git commit -m "変更内容"
git push                  ← 約3分以内に本番へ自動反映（全PCの画面も自動更新）
```

## 3. 大事な注意

- **push＝本番反映**です。壊れた状態で push しないこと。push 前に必ず手元（3002）で確認する。
- 開発用サーバー（`server/dev.js`）は **ポート3002・開発用DB（server/data-dev）** で動くので、
  本番の在庫データを壊す心配はありません（初回はサンプル在庫10件が入ります）。
- 本番の在庫DB（`server/data/app.db`）はサーバー機だけにあり、git には入っていません。
- 計算ロジックの変更は `docs/CALCULATION.md` と `CLAUDE.md` の注意書きを必ず読むこと。
- 競合したら：`git pull` してマージを解決 → push。本番の自動反映は fast-forward のみなので、
  競合状態のまま本番が壊れることはありません。

## 4. トラブル時

| 症状 | 対処 |
|---|---|
| push が拒否される | `git pull` してから push（他の人が先に push している） |
| 本番に反映されない | サーバー機で `更新して反映.bat` を実行（手動反映＋ヘルスチェック） |
| clone で認証エラー | GitHub にログインできるアカウントか確認。Collaborator 招待が必要な場合あり |
| 3002 が使用中 | `set PORT=3003` してから `node server\dev.js` |
