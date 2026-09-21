// ─────────────────────────────────────────────────────────────
// dev.js — 開発用サーバー起動（本番と衝突しない設定で index.js を起動）
//   ・ポート 3002（本番は 3001）
//   ・DB は server/data-dev/（本番の server/data/ とは別。git 管理外）
//   ・自動更新（git pull 監視）は無効
//   使い方：node server/dev.js   または「開発用起動.bat」
// ─────────────────────────────────────────────────────────────
const path = require("node:path");
process.env.PORT = process.env.PORT || "3002";
process.env.DB_DIR = process.env.DB_DIR || path.join(__dirname, "data-dev");
process.env.AUTO_UPDATE_SEC = "0";
require("./index.js");
