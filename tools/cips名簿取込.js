// ─────────────────────────────────────────────────────────────
// cips名簿取込.js — CIPS(SQL Server) の社員マスタから名簿を取り込む
//
//   実行方法（サーバー機のコマンドプロンプトで）:
//     cd C:\Users\PROGRAM-TSUJIMOTO\Desktop\プログラムツール\kyoshin-steel-manager
//     node tools\cips名簿取込.js
//
//   ・CIPSへは読み取り専用アカウントで SELECT のみ（program-load-board と同じ設定を利用）
//   ・取得した名前を、このシステムのマスタ「名簿」に上書き保存する
//     （比重・単価・式・他の設定はそのまま。名簿だけ差し替え）
//   ・再実行すれば最新の名簿に更新される。不要な名前は マスタ参照→名簿 で削除可
// ─────────────────────────────────────────────────────────────
const path = require("node:path");
const fs = require("node:fs");

const PLB = "C:\\Users\\PROGRAM-TSUJIMOTO\\Desktop\\プログラムツール\\program-load-board";
const APP = path.join(__dirname, "..");
const BASE = process.env.STEEL_URL || "http://localhost:3001";

const sql = require(path.join(PLB, "node_modules", "mssql"));
const cfg = JSON.parse(fs.readFileSync(path.join(PLB, "server", "data", "cips-config.json"), "utf8"));

(async () => {
  // 1) CIPS から社員名を取得
  const pool = await sql.connect({
    server: cfg.server, port: cfg.port, database: cfg.database,
    user: cfg.user, password: cfg.password,
    options: { encrypt: false, trustServerCertificate: true },
    requestTimeout: 30000,
  });
  const cols = (await pool.request().query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='master_company_staff'"
  )).recordset.map(c => c.COLUMN_NAME);
  console.log("[cips] master_company_staff の列:", cols.join(", "));
  const rows = (await pool.request().query("SELECT * FROM master_company_staff ORDER BY code")).recordset;
  await pool.close();

  // 退職フラグらしき列があれば除外に使う（無ければ全員）
  const retireCol = cols.find(c => /retire|taisyoku|delete|del_flg|invalid/i.test(c));
  const names = [];
  for (const r of rows) {
    if (retireCol && String(r[retireCol] ?? "").trim() !== "" && String(r[retireCol]).trim() !== "0") continue;
    const name = String(r.name ?? "").trim();
    if (name && !names.includes(name)) names.push(name);
  }
  console.log(`[cips] 取得: ${rows.length}行 → 名簿 ${names.length}名` + (retireCol ? `（除外判定列: ${retireCol}）` : "（除外判定列なし・全員）"));
  console.log("  " + names.join("、"));
  if (!names.length) { console.error("名前が取得できませんでした"); process.exit(1); }

  // 2) 管理者パスコードを js/app.js から取得
  const m = fs.readFileSync(path.join(APP, "js", "app.js"), "utf8").match(/const ADMIN_PIN="([^"]+)"/);
  if (!m) { console.error("ADMIN_PIN が見つかりません"); process.exit(1); }

  // 3) 現在のマスタを取得し、名簿だけ差し替えて保存
  const cur = await (await fetch(BASE + "/api/masters")).json();
  const masters = cur.masters || {};
  masters.staff = names;
  const res = await fetch(BASE + "/api/masters", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: m[1], masters }),
  });
  const j = await res.json();
  if (!res.ok) { console.error("保存に失敗:", j.error || res.status); process.exit(1); }
  console.log(`[done] 名簿 ${names.length}名 を保存しました（全PCに反映されます）`);
})().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
