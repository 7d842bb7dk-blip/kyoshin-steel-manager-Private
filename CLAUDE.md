# CLAUDE.md

このファイルは Claude Code がプロジェクトを理解するための説明書です。
作業を始める前に必ず読んでください。

---

## プロジェクト概要

**鋼材管理システム**（Kyo-shin Steel Manager）— 鋼材の在庫検索・在庫管理・持ち出し登録・
入出庫履歴・重量／材料費計算を行う社内向け Web アプリ。**共有サーバー版（v1.1.0〜）**。

- **由来**：Excel マクロ（`新_鋼材管理Excel.xlsm`）から移行。計算ロジックは Excel を
  リバースエンジニアリングして再現しており、**サンプル在庫10件の重量が Excel と一致することを検証済み**。
- **構成**：フロントは素の HTML / CSS / JavaScript（フレームワーク・CDN・Webフォント禁止）。
  サーバーは Node.js ＋ Express ＋ better-sqlite3（`server/`）。依存はこの2つだけに保つこと。
- **本番の正式アドレスは `https://kouzaizaiko.wataru419.com/`（PC・スマホ共通・1本化。下記の正式な証明書）**。
  証明書が使えない時は自動で `https://192.168.1.107/`（社内CA証明書）に戻る。在庫・履歴は SQLite に
  集約され**全PC共有**（クライアントは約5秒の差分ポーリングで同期）。HTTPSなのはスマホの
  「かざすだけQRスキャン」（カメラAPI）がHTTPS必須のため。自己署名証明書は `server/data/tls/`
  （Git対象外）、IPが変わったら `tools/TLS証明書を作る.bat` で作り直す。
- 旧アドレス `http://…:3001`（印刷済みQRラベルのリンク先）と `http://…:80` は正式アドレスへ
  **302転送**（`/api/*` と localhost は転送しない）。443が使えない環境では 3443 に自動退避。
- **稼働中の正式アドレスは `https://kouzaizaiko.wataru419.com/`**（2026-09-24〜。XServerドメインで取得した
  `wataru419.com`・Let's Encrypt・サーバーが期限30日前に自動更新）。社内の名前解決が 192.168.1.107 を指している間、
  IP・:3001・:80 へのアクセスはこのアドレスへ302転送される。`wataru419.com` 本体と他の名前は、今後の別システム用に空けてある。
- **正式な証明書（Let's Encrypt）**：`tools/証明書を自動取得.bat` で設定する（選択肢 1＝会社ドメイン
  `zaiko.f-kyo-shin.co.jp`・エックスサーバーDNS／2＝自分で取ったドメイン／3＝DuckDNS）。
  実装は `server/acme.js`（外部パッケージなし）。サーバーは既存証明書を期限30日前に自動更新し、
  社内の名前解決がこのサーバーを指している間だけドメインへ転送する（それ以外はIPのまま動く）。
  **エックスサーバーのDNSは `zaiko` の A と `_acme-challenge.zaiko` の TXT 以外に触らないこと**
  （ホームページ・メールと同じドメイン）。API仕様は https://developer.xserver.ne.jp/api/server/openapi.json 。
  DuckDNS は社内の FortiGate で「ダイナミックDNS」としてブロックされている（2026-09 確認）。
  自分で取ったドメイン（XServerドメイン）も選べる（provider "xdomain"。API仕様は
  https://developer.xserver.ne.jp/api/domain/openapi.json 、ネームサーバーは ns1〜3.xdomain.ne.jp 必須）。

## 本番サーバー機（重要）

- サーバー機：PROGRAM-TSUJIMOTO の PC。このリポジトリの実体は
  `C:\Users\PROGRAM-TSUJIMOTO\Desktop\プログラムツール\kyoshin-steel-manager`。
- **常駐**：ログオン時にスタートアップの `kyoshin-steel.vbs` → `server-daemon.bat` が隠し起動。
  クラッシュしても10秒後に自動再起動。停止は `サーバー停止.bat`。
- **コード変更の反映は自動**：サーバーが約3分ごとに GitHub（origin）を監視し、新しいコミットが
  あれば `git pull --ff-only` → 自動再起動（`AUTO_UPDATE_SEC` 環境変数で間隔変更、`0` で無効）。
  クライアントは `/api/state` の `boot`（サーバー起動時刻）の変化を検知して自動再読み込みする。
  **push すれば数分で本番に反映される**ことを前提に、壊れた状態のコミットを push しないこと。
  手動で即時反映したい場合はサーバー機で `更新して反映.bat`。
- DB は `server/data/app.db`（**git 管理外**。消すと在庫・履歴が消えるので注意）。

## 開発コマンド

```bash
npm install                 # 初回のみ（express / better-sqlite3）
node server/dev.js          # ★開発はこちら：ポート3002・開発用DB(server/data-dev)・自動更新オフ
                            #   （「開発用起動.bat」のダブルクリックでも同じ）
node server/index.js        # 本番と同じ起動（ポート3001・server/data/。サーバー機では常駐が使用中）
python build.py             # 単体ファイル版 dist/ のビルド（Python がある PC のみ）
```

他のPCで開発を始める手順は `docs/他PCでの開発手順.md` を参照（clone → npm install → dev起動 →
push で本番自動反映）。**開発時は必ず dev.js（3002）を使うこと**。本番DBを直接触らない。

## ファイル構成

```
index.html          画面のマークアップ（6つの view を切り替え）
styles.css          スタイル全般。冒頭の :root に CSS 変数（配色）
js/app.js           フロントのロジック全部（マスタ・計算・QR生成・描画・イベント）
server/index.js     Express サーバー（静的配信＋在庫/持ち出し/履歴 API）
server/db.js        SQLite（records / history / meta）とCRUD・持ち出し・履歴記録
assets/logo.png     Kyo-shin ロゴ
server-daemon.bat   常駐ループ（クラッシュ後10秒で再起動・二重起動ガード）
サーバー停止.bat     サーバー＋常駐ループの停止
更新して反映.bat     git pull ＋ サーバー再起動（サーバー機で実行）
docs/CALCULATION.md 計算仕様（断面積・重量・キロ単価・材料費）
dist/               単体ファイル版（直接編集しない。build.py の生成物）
```

## ⚠ 触るときに注意すること

### 1. 計算ロジックは勝手に「改善」しないこと
`sectionArea()` / `weightKg()` / `unitPrice()` / `compute()` は **Excel の挙動をそのまま再現**。
一見おかしく見える挙動も**意図的**。変更する場合は必ず `docs/CALCULATION.md` と突き合わせること。
なお **単価・比重・鋼種→式の割り当ては管理者がマスタ設定画面から編集可能**（サーバーDBの
`meta.masters` に上書きが入る。コード内の `DEFAULT_MASTERS` が既定値）。式の中身
（`AREA_FORMULAS` の7種類）だけはコード固定。
- `unitPrice()` は Excel の **SUMIFS と同じ「合算」**（SS400 フラットバー＝ミガキ250＋黒皮250＝500）。
- SS400 / A6063 は `材質＋鋼種` で照合（仕上げ不問）。SUS 系は `材質＋鋼種＋表面仕上げ`。
- 丸め：重量は小数第3位、材料費は整数。

### 2. 外部依存を増やさないこと
フロントはバニラ JS のみ（QRコード生成も `js/app.js` 内の自前実装）。
サーバーは express / better-sqlite3 のみ。CDN・Webフォント・新規 npm パッケージは追加しない。
**例外**：QR読み取り用に jsQR（MIT）を `js/jsqr.js`、zxing-wasm（Apache-2.0）を
`js/vendor/zxing-reader.js`＋`zxing_reader.wasm` に同梱（ローカル配信・オフライン動作は維持。
自前実装が現実的でないため）。読み取りは BarcodeDetector → zxing-wasm → jsQR の3段フォールバック
（`decodeQrPhoto()`）。これ以外の同梱追加は原則しない。

### 3. API とデータの互換を壊さないこと
- API：`GET /api/state?since=v`（差分ポーリング）、`POST/PUT/DELETE /api/records`、
  `POST /api/records/bulk`、`POST /api/checkout`、`GET /api/history`、`GET /api/health`（`base` 含む）。
- クライアントは二重モード：サーバー配信時は API、`file://`（単体版）では localStorage
  （在庫 `steel_mgr_records_v1`・履歴 `steel_mgr_history_v1`）に自動フォールバック。両対応を保つこと。
- QRラベルは `?co=<在庫ID>` を開くと該当在庫の持ち出しモーダルが直接開く仕様。ID の意味を変えないこと。

### 4. `js/app.js` に `let history` がある
`window.history` を隠蔽しているため、ブラウザ履歴 API は `window.history.…` と書くこと。

## 画面（6つの view）

1. **在庫検索** … 連動絞り込み、KPI集計、CSV出力
2. **持ち出し**（現場向け・全員） … 全部/一部使用を数タップで記録。名前必須・端末に記憶
3. **入出庫履歴** … 誰が・いつ・何を・どれだけ。CSV出力
4. **在庫管理** … 追加・編集・削除、CSV取込／出力、**QRラベル印刷**
5. **重量・単価計算**（管理者のみ） … 単品試算
6. **マスタ参照**（管理者のみ） … 比重・単価ルール・断面積式・規格候補

管理者モード＝ヘッダー右ボタン＋パスコード（`js/app.js` の `ADMIN_PIN`。クライアント側の簡易ロック）。

## デザイン方針（Kyo-shin ブランド）

- 配色：赤 `--accent: #df1f26` ＋ 黒 `#15171c` ＋ 白。上部ヘッダー型・赤いピル型タブ。
- 親しみやすくポップ：角丸・丸ゴシック優先・KPIカード・材質カラータグ・断面形状アイコン（`SHAPE_SVG`）。
- アイコンはすべてインライン SVG。スマホ幅（760px以下）対応を維持すること。

## コミュニケーション

- **回答・コメント・UI 文言はすべて日本語**で。
- 変更したら `CHANGELOG.md` に追記する。
- サーバー機以外で開発した変更は push 後、サーバー機の `更新して反映.bat` で本番反映。
