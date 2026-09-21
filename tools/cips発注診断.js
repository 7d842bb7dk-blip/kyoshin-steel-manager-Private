// ─────────────────────────────────────────────────────────────
// cips発注診断.js — CIPS の発注（仕入）関連テーブルの構造を調べる
//
//   実行方法（サーバー機のコマンドプロンプトで）:
//     cd C:\Users\PROGRAM-TSUJIMOTO\Desktop\プログラムツール\kyoshin-steel-manager
//     node tools\cips発注診断.js
//
//   ・読み取り専用アカウントで SELECT のみ。CIPSには一切書き込まない
//   ・発注/仕入らしきテーブルの列構成とサンプル行を
//     tools/cips_hattyu_dump.json に書き出す（git管理外・ローカルのみ）
//   ・この結果をもとに「材料キロ単価の平均→マスタ反映」の本番スクリプトを作る
// ─────────────────────────────────────────────────────────────
const path = require("node:path");
const fs = require("node:fs");

const PLB = "C:\\Users\\PROGRAM-TSUJIMOTO\\Desktop\\プログラムツール\\program-load-board";
const sql = require(path.join(PLB, "node_modules", "mssql"));
const cfg = JSON.parse(fs.readFileSync(path.join(PLB, "server", "data", "cips-config.json"), "utf8"));

(async () => {
  const pool = await sql.connect({
    server: cfg.server, port: cfg.port, database: cfg.database,
    user: cfg.user, password: cfg.password,
    options: { encrypt: false, trustServerCertificate: true },
    requestTimeout: 60000,
  });
  const q = async (s) => (await pool.request().query(s)).recordset;

  const out = { tables: [], candidates: {}, priceColumns: [] };

  // 1) 全テーブル名
  const tables = (await q("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME")).map(r => r.TABLE_NAME);
  out.tables = tables;
  console.log(`[cips] テーブル数: ${tables.length}`);

  // 2) 発注・仕入らしき名前のテーブル
  const cand = tables.filter(t => /purch|hattyu|hacchu|siire|shiire|buy|supplier|仕入|発注|order/i.test(t));
  console.log("[cips] 発注/仕入/order 系の候補:", cand.join(", ") || "（なし）");

  // 3) 単価・単位っぽい列を持つテーブルを横断検索
  out.priceColumns = await q(
    "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS " +
    "WHERE COLUMN_NAME LIKE '%price%' OR COLUMN_NAME LIKE '%tanka%' OR COLUMN_NAME LIKE '%unit%' " +
    "ORDER BY TABLE_NAME, COLUMN_NAME");
  console.log(`[cips] 単価/単位らしき列: ${out.priceColumns.length}件（詳細はダンプ参照）`);

  // 4) 候補テーブル（最大12個）の列構成・行数・サンプル
  for (const tname of cand.slice(0, 12)) {
    try {
      const cols = (await q(`SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='${tname}' ORDER BY ORDINAL_POSITION`));
      const cnt = (await q(`SELECT COUNT(*) c FROM [${tname}]`))[0].c;
      const sample = await q(`SELECT TOP 15 * FROM [${tname}] ORDER BY 1 DESC`);
      out.candidates[tname] = { count: cnt, columns: cols, sample };
      console.log(`  - ${tname}: ${cnt}行 / 列: ${cols.map(c => c.COLUMN_NAME).join(", ").slice(0, 160)}`);
    } catch (e) {
      out.candidates[tname] = { error: e.message };
      console.log(`  - ${tname}: 読み取り失敗 (${e.message})`);
    }
  }

  await pool.close();
  const dump = path.join(__dirname, "cips_hattyu_dump.json");
  fs.writeFileSync(dump, JSON.stringify(out, null, 1), "utf8");
  console.log("\n[done] 診断結果を書き出しました →", dump);
  console.log("この後、クロードに「診断できた」と伝えてください（ファイルを読んで本番スクリプトを作ります）");
})().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
