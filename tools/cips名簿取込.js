// ─────────────────────────────────────────────────────────────
// cips名簿取込.js — CIPS(SQL Server) の社員マスタから名簿を取り込む
//
//   実行方法（サーバー機のコマンドプロンプトで）:
//     cd C:\Users\PROGRAM-TSUJIMOTO\Desktop\プログラムツール\kyoshin-steel-manager
//     node tools\cips名簿取込.js
//
//   ・CIPSへは読み取り専用アカウントで SELECT のみ
//   ・退職者は自動判定で除外（判定に使った列と除外者数を表示）
//   ・全列の生データを tools/cips_staff_dump.json に書き出す（git管理外・調整用）
//   ・名簿だけを差し替え保存。再実行すれば最新に更新される
// ─────────────────────────────────────────────────────────────
const path = require("node:path");
const fs = require("node:fs");

const PLB = "C:\\Users\\PROGRAM-TSUJIMOTO\\Desktop\\プログラムツール\\program-load-board";
const APP = path.join(__dirname, "..");
const BASE = process.env.STEEL_URL || "http://localhost:3001";

const sql = require(path.join(PLB, "node_modules", "mssql"));
const cfg = JSON.parse(fs.readFileSync(path.join(PLB, "server", "data", "cips-config.json"), "utf8"));

const S = (v) => String(v == null ? "" : v).trim();
/* 「値が入っている」判定：空・0・1900年代の空日付は「無し」とみなす */
function hasValue(v) {
  const s = S(v);
  if (s === "" || s === "0" || s === "false") return false;
  if (/^1900[-\/]?01[-\/]?01/.test(s)) return false;
  if (v instanceof Date && v.getFullYear() <= 1900) return false;
  return true;
}

(async () => {
  const pool = await sql.connect({
    server: cfg.server, port: cfg.port, database: cfg.database,
    user: cfg.user, password: cfg.password,
    options: { encrypt: false, trustServerCertificate: true },
    requestTimeout: 30000,
  });
  const cols = (await pool.request().query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='master_company_staff' ORDER BY ORDINAL_POSITION"
  )).recordset.map(c => c.COLUMN_NAME);
  const rows = (await pool.request().query("SELECT * FROM master_company_staff ORDER BY code")).recordset;
  await pool.close();

  console.log("[cips] 列:", cols.join(", "));
  console.log("[cips] 全", rows.length, "行");

  // 調整用：全データをローカルに書き出す（git管理外）
  fs.writeFileSync(path.join(__dirname, "cips_staff_dump.json"), JSON.stringify(rows, null, 1), "utf8");
  console.log("[cips] 生データを tools/cips_staff_dump.json に保存（ローカルのみ）");

  // ── 退職者の判定 ──
  // 1) 列名に retire / taisyoku / 退職 / resign を含む列に値が入っていれば退職
  // 2) 列名が del / delete_flag / invalid 系で値が真なら削除済み扱い
  const retireCols = cols.filter(c => /retire|taisyoku|退職|resign|quit/i.test(c));
  const deleteCols = cols.filter(c => /^(del($|_)|delete|del_flg|invalid|disable)/i.test(c));
  console.log("[判定] 退職系の列:", retireCols.join(", ") || "（なし）", " / 削除系の列:", deleteCols.join(", ") || "（なし）");

  const isRetired = (r) =>
    retireCols.some(c => hasValue(r[c])) || deleteCols.some(c => hasValue(r[c]));

  const names = [], excluded = [];
  for (const r of rows) {
    const name = S(r.name);
    if (!name) continue;
    if (isRetired(r)) { excluded.push(name); continue; }
    if (!names.includes(name)) names.push(name);
  }
  console.log(`[判定] 在籍 ${names.length}名 / 除外(退職・削除) ${excluded.length}名`);
  if (excluded.length) console.log("  除外:", excluded.join("、"));
  console.log("  取込:", names.join("、"));
  if (!names.length) { console.error("名前が取得できませんでした"); process.exit(1); }

  // ── 名簿だけ差し替えて保存 ──
  const m = fs.readFileSync(path.join(APP, "js", "app.js"), "utf8").match(/const ADMIN_PIN="([^"]+)"/);
  if (!m) { console.error("ADMIN_PIN が見つかりません"); process.exit(1); }
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
  console.log(`[done] 名簿 ${names.length}名 を保存しました（全PCに反映）`);
  console.log("※除外がおかしい場合は tools/cips_staff_dump.json を見せてください（調整します）");
})().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
