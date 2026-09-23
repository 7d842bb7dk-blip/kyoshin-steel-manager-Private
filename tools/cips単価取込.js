// ─────────────────────────────────────────────────────────────
// cips単価取込.js — CIPS発注実績（kg単位のみ・直近1年）から
//                   材質×鋼種の平均キロ単価を算出し、単価マスタへ反映する
//
//   実行方法（サーバー機で）:
//     cd C:\Users\PROGRAM-TSUJIMOTO\Desktop\プログラムツール\kyoshin-steel-manager
//     node tools\cips単価取込.js          … 反映まで実行
//     node tools\cips単価取込.js 確認     … 計算結果の表示だけ（マスタは変更しない）
//
//   ルール：
//   ・f_Purchase_line の 単位=kg・単価>0・直近1年 の明細だけを対象（SELECTのみ）
//   ・品名から材質/鋼種/仕上げを判定し、数量加重平均を計算
//   ・優先順位: ①材質×鋼種の実績(3件以上) → ②同材質の形鋼類平均 → ③同材質全体平均
//   ・実績のない材質（A6063/SUS310S/チタン等）は現行マスタを据え置き
//   ・仕上げ別の実績が3件以上ある行は仕上げ別の平均を採用
//   ・新しい組み合わせは fin=null（仕上げ不問）の行として追加
// ─────────────────────────────────────────────────────────────
const path = require("node:path");
const fs = require("node:fs");

const PLB = "C:\\Users\\PROGRAM-TSUJIMOTO\\Desktop\\プログラムツール\\program-load-board";
const APP = path.join(__dirname, "..");
const BASE = process.env.STEEL_URL || "http://localhost:3001";
const DRY = /確認|dry/.test(process.argv[2] || "");

const sql = require(path.join(PLB, "node_modules", "mssql"));
const cfg = JSON.parse(fs.readFileSync(path.join(PLB, "server", "data", "cips-config.json"), "utf8"));

/* アプリと同じ組み合わせ（KOSHU_BY_MAT）。※アプリ側を変えたらここも合わせる */
const KOSHU_BY_MAT = {
  "SS400": ["角パイプ", "丸パイプ(TP-S)", "丸パイプ(TP-A)", "チャンネル", "アングル", "フラットバー"],
  "SUS304": ["角パイプ", "丸パイプ(TP-S)", "丸パイプ(TP-A)", "サニタリーパイプ", "化粧管", "BA管", "チャンネル", "アングル", "フラットバー"],
  "SUS316L": ["角パイプ", "丸パイプ(TP-S)", "丸パイプ(TP-A)", "サニタリーパイプ", "化粧管", "BA管", "チャンネル", "アングル", "フラットバー"],
  "A6063": ["角パイプ", "丸パイプ(TP-S)", "丸パイプ(TP-A)", "サニタリーパイプ", "化粧管", "BA管", "チャンネル", "アングル", "フラットバー", "丸棒", "角棒"],
};
/* 発注品名の鋼種 → アプリの鋼種への対応（丸パイプは種別不明なので両方に適用） */
const KOSHU_APPLY = {
  "角パイプ": ["角パイプ"], "丸パイプ": ["丸パイプ(TP-S)", "丸パイプ(TP-A)", "丸パイプ"],
  "化粧管": ["化粧管"], "サニタリーパイプ": ["サニタリーパイプ"], "BA管": ["BA管"],
  "アングル": ["アングル"], "チャンネル": ["チャンネル"], "フラットバー": ["フラットバー"],
  "丸棒": ["丸棒"], "角棒": ["角棒"],
};

const N = (s) => String(s == null ? "" : s);
function parseMat(s) {
  const u = s.toUpperCase();
  if (/SUS\s*-?316/.test(u)) return "SUS316L";
  if (/SUS\s*-?304/.test(u)) return "SUS304";
  if (/SUS\s*-?310/.test(u)) return "SUS310S";
  if (/SUS\s*-?430/.test(u)) return "SUS430";
  if (/SS\s*-?400|SPHC|SPCC/.test(u)) return "SS400";
  /* アルミ系はすべて A6063 に統一（2026-09-23 仕様） */
  if (/A?5052|A?6063|アルミ|ｱﾙﾐ|^AL\b|\bAL\b|A1050|5083/.test(u)) return "A6063";
  if (/チタン|ﾁﾀﾝ/.test(u)) return "チタン";
  return null;
}
function parseKoshu(s) {
  if (/角\s*パイプ|角ﾊﾟｲﾌﾟ/i.test(s)) return "角パイプ";
  if (/化粧/.test(s)) return "化粧管";
  if (/サニタリー|ｻﾆﾀﾘｰ/.test(s)) return "サニタリーパイプ";
  if (/BA管/.test(s)) return "BA管";
  if (/パイプ|ﾊﾟｲﾌﾟ|TP-?[SA]|配管/.test(s)) return "丸パイプ";
  if (/アングル|ｱﾝｸﾞﾙ/.test(s)) return "アングル";
  if (/チャンネル|ﾁｬﾝﾈﾙ/.test(s)) return "チャンネル";
  if (/フラットバー|ﾌﾗｯﾄﾊﾞｰ|\bFB\b|平鋼/i.test(s)) return "フラットバー";
  if (/丸棒|丸鋼/.test(s)) return "丸棒";
  if (/角棒/.test(s)) return "角棒";
  if (/縞板|2B|片研|両面|4[xX×]8|5[xX×]10|3[xX×]6|ﾒｰﾀｰ|メーター|1219/.test(s)) return "板材";
  return null;
}
function parseFin(s) {
  if (/#400/.test(s)) return "#400";
  if (/\bHL\b|ﾍｱﾗｲﾝ|ヘアライン/i.test(s)) return "HL";
  if (/\bBA\b/.test(s)) return "BA";
  if (/未研/.test(s)) return "未研";
  if (/ミガキ|ﾐｶﾞｷ/.test(s)) return "ミガキ";
  if (/黒皮/.test(s)) return "黒皮";
  return null;
}

(async () => {
  // 1) CIPSから直近1年のkg明細を取得
  const pool = await sql.connect({
    server: cfg.server, port: cfg.port, database: cfg.database,
    user: cfg.user, password: cfg.password,
    options: { encrypt: false, trustServerCertificate: true }, requestTimeout: 60000,
  });
  const rows = (await pool.request().query(
    "SELECT date_make, products_name, purchase_comment, qty, unit, unit_price FROM f_Purchase_line " +
    "WHERE unit IN ('kg','Kg','KG','ｋｇ','ＫＧ','㎏','ｷﾛ') " +
    "  AND TRY_CONVERT(float, unit_price) > 0 AND TRY_CONVERT(float, qty) > 0 " +
    "  AND date_make >= CONVERT(varchar, DATEADD(year,-1,GETDATE()), 23)")).recordset;
  await pool.close();

  // 2) 集計（数量加重）
  const agg = new Map();
  const add = (key, qty, price) => {
    const a = agg.get(key) || { n: 0, kg: 0, sum: 0 };
    a.n++; a.kg += qty; a.sum += qty * price; agg.set(key, a);
  };
  for (const r of rows) {
    const name = N(r.products_name) + " " + N(r.purchase_comment);
    const qty = Number(r.qty), price = Number(r.unit_price);
    if (!(qty > 0 && price > 0 && price < 100000)) continue;
    const mat = parseMat(name); if (!mat) continue;
    const koshu = parseKoshu(name), fin = parseFin(name);
    add(`M|${mat}`, qty, price);
    if (koshu && koshu !== "板材") add(`S|${mat}`, qty, price);          // 形鋼類平均
    if (koshu) add(`K|${mat}|${koshu}`, qty, price);
    if (koshu && fin) add(`F|${mat}|${koshu}|${fin}`, qty, price);
  }
  const avg = (k) => { const a = agg.get(k); return a ? Math.round(a.sum / a.kg) : null; };
  const nOf = (k) => { const a = agg.get(k); return a ? a.n : 0; };

  // 3) 組み合わせごとの採用価格を決める
  const decide = (mat, appKoshu) => {
    const src = Object.entries(KOSHU_APPLY).find(([, targets]) => targets.includes(appKoshu));
    const buyKoshu = src ? src[0] : appKoshu;
    if (nOf(`K|${mat}|${buyKoshu}`) >= 3) return { p: avg(`K|${mat}|${buyKoshu}`), why: `${buyKoshu}の実績${nOf(`K|${mat}|${buyKoshu}`)}件` };
    if (nOf(`S|${mat}`) >= 3) return { p: avg(`S|${mat}`), why: `同材質の形鋼類平均(${nOf(`S|${mat}`)}件)` };
    if (nOf(`M|${mat}`) >= 3) return { p: avg(`M|${mat}`), why: `同材質全体平均(${nOf(`M|${mat}`)}件・板材含む)` };
    return null;
  };

  // 4) 現在のマスタを取得して価格を更新
  const cur = await (await fetch(BASE + "/api/masters")).json();
  const masters = cur.masters || {};
  if (!Array.isArray(masters.price) || !masters.price.length) {
    console.error("マスタが取得できません（先に一度アプリでマスタを保存してください）"); process.exit(1);
  }
  const price = masters.price;
  const changes = [];
  for (const [mat, koshus] of Object.entries(KOSHU_BY_MAT)) {
    for (const koshu of koshus) {
      const d = decide(mat, koshu);
      if (!d || !d.p) continue;
      const buyK = (Object.entries(KOSHU_APPLY).find(([, t]) => t.includes(koshu)) || [koshu])[0];
      const exist = price.filter(p => p.mat === mat && p.koshu === koshu);
      /* SS400/A6063 は仕上げ不問で「複数行=合算」の仕様のため、
       * 平均値を正しく効かせるには1行に統合する必要がある */
      if ((mat === "SS400" || mat === "A6063") && exist.length) {
        const old = exist.reduce((s, p) => s + p.price, 0);
        for (const row of exist) price.splice(price.indexOf(row), 1);
        price.push({ mat, koshu, fin: null, price: d.p });
        if (old !== d.p) changes.push(`${mat} ${koshu}: ${old} → ${d.p}円/kg（${exist.length}行を1行に統合／${d.why}）`);
        continue;
      }
      if (exist.length) {
        for (const row of exist) {
          const finAvg = row.fin && nOf(`F|${mat}|${buyK}|${row.fin}`) >= 3 ? avg(`F|${mat}|${buyK}|${row.fin}`) : null;
          const np = finAvg || d.p;
          if (row.price !== np) { changes.push(`${mat} ${koshu} ${row.fin || "不問"}: ${row.price} → ${np}円/kg（${finAvg ? "仕上げ別実績" : d.why}）`); row.price = np; }
        }
      } else {
        price.push({ mat, koshu, fin: null, price: d.p });
        changes.push(`${mat} ${koshu} 不問: (新規) → ${d.p}円/kg（${d.why}）`);
      }
    }
  }

  console.log(`kg明細（直近1年・単価あり）: ${rows.length}件`);
  console.log("\n== マスタへの反映内容 ==");
  changes.forEach(c => console.log("  " + c));
  if (!changes.length) { console.log("  変更なし"); return; }
  if (DRY) { console.log("\n[確認モード] マスタは変更していません"); return; }

  const m = fs.readFileSync(path.join(APP, "js", "app.js"), "utf8").match(/const ADMIN_PIN="([^"]+)"/);
  const res = await fetch(BASE + "/api/masters", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: m[1], masters }),
  });
  if (!res.ok) { console.error("保存に失敗:", (await res.json()).error || res.status); process.exit(1); }
  console.log(`\n[done] ${changes.length}件を単価マスタに反映しました（全PCに反映されます）`);
})().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
