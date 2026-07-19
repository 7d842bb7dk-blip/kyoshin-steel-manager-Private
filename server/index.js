// ─────────────────────────────────────────────────────────────
// index.js — Express サーバ本体 / 在庫API + 既存フロントの静的配信
//   ・全状態は GET /api/state（?since=v で差分ポーリング）
//   ・在庫CRUD（追加/更新/削除/一括取込）
//   ・index.html / styles.css / js / assets のみ静的配信（server・data は出さない）
//   既定 http://0.0.0.0:3001  （社内LANの他PCからアクセス可）
// ─────────────────────────────────────────────────────────────
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const express = require("express");
const dbm = require("./db");

const ROOT = path.join(__dirname, ".."); // プロジェクト直下（index.html がある場所）
const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);
const HOST = process.env.HOST || "0.0.0.0";

app.use(express.json({ limit: "8mb" }));

// ── 状態取得（差分ポーリング対応） ──
app.get("/api/state", (req, res) => {
  const version = dbm.getVersion();
  const since = req.query.since != null ? parseInt(req.query.since, 10) : null;
  if (since != null && !Number.isNaN(since) && since >= version) {
    return res.json({ unchanged: true, version });
  }
  res.json(dbm.getState());
});

// ── 在庫の追加 ──
app.post("/api/records", (req, res) => {
  try {
    const { id, version } = dbm.addRecord(req.body || {}, (req.body || {}).person);
    res.json({ ok: true, id, version });
  } catch (e) {
    res.status(500).json({ error: `追加に失敗: ${e.message}` });
  }
});

// ── 在庫の更新 ──
app.put("/api/records/:id", (req, res) => {
  try {
    const r = dbm.updateRecord(req.params.id, req.body || {}, (req.body || {}).person);
    if (!r.ok) return res.status(404).json({ error: "該当の在庫が見つかりません", version: r.version });
    res.json({ ok: true, version: r.version });
  } catch (e) {
    res.status(500).json({ error: `更新に失敗: ${e.message}` });
  }
});

// ── 在庫の削除 ──
app.delete("/api/records/:id", (req, res) => {
  try {
    const r = dbm.deleteRecord(req.params.id, req.query.person);
    if (!r.ok) return res.status(404).json({ error: "該当の在庫が見つかりません", version: r.version });
    res.json({ ok: true, version: r.version });
  } catch (e) {
    res.status(500).json({ error: `削除に失敗: ${e.message}` });
  }
});

// ── CSV一括取込（rows: 素データ配列） ──
app.post("/api/records/bulk", (req, res) => {
  try {
    const rows = (req.body && req.body.rows) || [];
    const { added, version } = dbm.bulkAdd(rows, (req.body || {}).person);
    res.json({ ok: true, added, version });
  } catch (e) {
    res.status(500).json({ error: `取込に失敗: ${e.message}` });
  }
});

// ── 持ち出し（現場の出庫）：usedLen 省略 or 全長 → レコード削除、一部 → 残り長さに更新 ──
app.post("/api/checkout", (req, res) => {
  try {
    const b = req.body || {};
    const r = dbm.checkoutRecord(b.id, { person: b.person, usedLen: b.usedLen, note: b.note });
    if (!r.ok) {
      const msg =
        r.reason === "notfound" ? "該当の在庫が見つかりません（他の人が先に持ち出した可能性）"
        : r.reason === "noperson" ? "名前を入力してください"
        : r.reason === "over" ? "使う長さが在庫の長さを超えています"
        : "使う長さが正しくありません";
      return res.status(r.reason === "notfound" ? 404 : 400).json({ error: msg, version: r.version });
    }
    res.json({ ok: true, removed: r.removed, remain: r.remain, version: r.version });
  } catch (e) {
    res.status(500).json({ error: `持ち出しの記録に失敗: ${e.message}` });
  }
});

// ── 入出庫履歴（新しい順） ──
app.get("/api/history", (req, res) => {
  res.json({ items: dbm.getHistory(req.query.limit), version: dbm.getVersion() });
});

// ── 本番反映（管理者用）：git pull → 更新があればプロセス終了（常駐ループが新コードで再起動） ──
app.post("/api/deploy", (req, res) => {
  let pin = "";
  try {
    const m = fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf8").match(/const ADMIN_PIN="([^"]+)"/);
    if (m) pin = m[1];
  } catch (e) {}
  if (!pin || (req.body || {}).pin !== pin) {
    return res.status(403).json({ error: "パスコードが正しくありません" });
  }
  execFile("git", ["pull", "--ff-only"], { cwd: ROOT, timeout: 60000 }, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ error: "git pull に失敗: " + (String(stderr || err.message).trim()) });
    }
    const updated = !/Already up to date/i.test(stdout);
    res.json({ ok: true, updated, log: String(stdout).trim() });
    if (updated) {
      console.log("[deploy] 更新を取得。再起動します…\n" + stdout);
      setTimeout(() => process.exit(0), 800); // レスポンス送信後に終了 → server-daemon.bat が再起動
    }
  });
});

// ── ヘルスチェック（クライアントのモード判定・QR用ベースURLの取得にも使用） ──
function lanIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return "localhost";
}
app.get("/api/health", (req, res) =>
  res.json({ ok: true, version: dbm.getVersion(), base: `http://${lanIP()}:${PORT}/` }));

// 未定義の /api/* は JSON で 404
app.use("/api", (req, res) => res.status(404).json({ error: "Not Found" }));

// ── 静的配信（既存フロントのみ。server/ や data/ は配信しない） ──
const sendFile = (rel) => (req, res) => res.sendFile(path.join(ROOT, rel));
app.get("/", sendFile("index.html"));
app.get("/index.html", sendFile("index.html"));
app.get("/styles.css", sendFile("styles.css"));
app.use("/js", express.static(path.join(ROOT, "js")));
app.use("/assets", express.static(path.join(ROOT, "assets")));

const server = app.listen(PORT, HOST, () => {
  console.log(`[steel-manager] listening on http://localhost:${PORT}  (host=${HOST})`);
  console.log(`[steel-manager] DB=${dbm.DB_PATH}`);
  try {
    const n = dbm.seedIfEmpty();
    if (n) console.log(`[steel-manager] サンプル在庫を初回投入: ${n}件`);
  } catch (e) { console.error("[seed] 失敗:", e && e.message); }
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));

module.exports = app;
