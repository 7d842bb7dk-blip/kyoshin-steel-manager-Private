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

const BOOT = Date.now(); // 起動時刻。変わっていたらクライアントは再読み込み（自動反映の波及用）

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
    return res.json({ unchanged: true, version, boot: BOOT, mv: dbm.getMastersVersion() });
  }
  res.json({ ...dbm.getState(), boot: BOOT });
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

// ── マスタ設定（単価・比重・式割当）：取得は誰でも、保存は管理者パスコード必須 ──
function adminPin() {
  try {
    const m = fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf8").match(/const ADMIN_PIN="([^"]+)"/);
    return m ? m[1] : "";
  } catch (e) { return ""; }
}
app.get("/api/masters", (req, res) =>
  res.json({ masters: dbm.getMasters(), mv: dbm.getMastersVersion() }));
app.put("/api/masters", (req, res) => {
  const pin = adminPin();
  if (!pin || (req.body || {}).pin !== pin) {
    return res.status(403).json({ error: "パスコードが正しくありません" });
  }
  try {
    const r = dbm.setMasters((req.body || {}).masters ?? null); // null = 初期値に戻す
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: `マスタの保存に失敗: ${e.message}` });
  }
});

// ── 入出庫履歴（新しい順） ──
app.get("/api/history", (req, res) => {
  res.json({ items: dbm.getHistory(req.query.limit), version: dbm.getVersion() });
});

// ── GitHub 自動反映：定期的に origin を確認し、新しいコミットがあれば取り込んで再起動 ──
//    無効化したい場合は環境変数 AUTO_UPDATE_SEC=0 で起動する
const AUTO_UPDATE_SEC = parseInt(process.env.AUTO_UPDATE_SEC || "180", 10);
const gitExec = (args, cb) => execFile("git", args, { cwd: ROOT, timeout: 60000 }, cb);
let updating = false;
function checkForUpdate() {
  if (updating) return;
  gitExec(["fetch", "--quiet"], (err) => {
    if (err) return; // オフライン・認証切れ等は無視（次回に再試行）
    gitExec(["rev-list", "--count", "HEAD..@{u}"], (err2, stdout) => {
      if (err2) return;
      const behind = parseInt(String(stdout).trim(), 10) || 0;
      if (!behind) return;
      updating = true;
      console.log(`[auto-update] GitHubに新しいコミットを${behind}件検出。取り込みます…`);
      gitExec(["pull", "--ff-only"], (err3, out3, errOut3) => {
        if (err3) {
          console.error("[auto-update] pull失敗（次回に再試行）:", String(errOut3 || err3.message).trim());
          updating = false;
          return;
        }
        console.log("[auto-update] 反映完了。再起動します。\n" + String(out3).trim());
        setTimeout(() => process.exit(0), 500); // 常駐ループ(server-daemon.bat)が新コードで再起動
      });
    });
  });
}
if (AUTO_UPDATE_SEC > 0) setInterval(checkForUpdate, AUTO_UPDATE_SEC * 1000);

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
