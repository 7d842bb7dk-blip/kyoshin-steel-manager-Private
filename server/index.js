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
const https = require("node:https");
const { execFile } = require("node:child_process");
const express = require("express");
const dbm = require("./db");

const BOOT = Date.now(); // 起動時刻。変わっていたらクライアントは再読み込み（自動反映の波及用）

const ROOT = path.join(__dirname, ".."); // プロジェクト直下（index.html がある場所）
const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);
const HOST = process.env.HOST || "0.0.0.0";

app.use(express.json({ limit: "8mb" }));

// ── アドレスの一本化：正式アドレスは https://<IP>/（証明書があるとき） ──
//    旧アドレス（http://<IP>:3001 等）でページを開いたら正式アドレスへ自動転送する。
//    /api/* は転送しない（開きっぱなしの旧ページのポーリングを壊さないため）。
//    localhost はサーバー機での開発用にそのまま通す。
app.use((req, res, next) => {
  if (!httpsOn || req.secure) return next();
  if (req.path.startsWith("/api/")) return next();
  if (req.path === "/ca.crt") return next(); // 証明書を信頼する前でも取得できるようhttpのまま通す
  if (req.hostname === "localhost" || req.hostname === "127.0.0.1") return next();
  const suffix = HTTPS_PORT === 443 ? "" : `:${HTTPS_PORT}`;
  res.redirect(302, `https://${lanIP()}${suffix}${req.originalUrl}`);
});

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
    const r = dbm.checkoutRecord(b.id, { person: b.person, usedLen: b.usedLen, note: b.note, loc: b.loc });
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

// ── 鋼材倉庫の鍵：持出/返却の記録と現在の状態 ──
app.get("/api/key", (req, res) => res.json(dbm.keyStatus()));
app.post("/api/key", (req, res) => {
  const b = req.body || {};
  if (b.action !== "out" && b.action !== "in") return res.status(400).json({ error: "actionが不正です" });
  const r = dbm.keyEvent(b.action, b.person);
  if (!r.ok) {
    return res.status(400).json({ error: r.reason === "noperson" ? "名前を入力してください" : "鍵はすでに返却されています" });
  }
  res.json({ ok: true, status: r.status });
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

// ── QRラベル印刷済みの目印（印刷後に付ける） ──
app.post("/api/labeled", (req, res) => {
  try {
    const r = dbm.markLabeled((req.body || {}).ids);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: `目印の保存に失敗: ${e.message}` });
  }
});

// ── 入出庫履歴（新しい順） ──
app.get("/api/history", (req, res) => {
  res.json({ items: dbm.getHistory(req.query.limit), version: dbm.getVersion() });
});

// ── QR読み取り失敗の診断（失敗した写真＋端末情報を保存。原因調査用・最新20件のみ） ──
const SCANFAIL_DIR = path.join(__dirname, "data", "scanfail");
app.post("/api/scanfail", express.raw({ type: "application/octet-stream", limit: "25mb" }), (req, res) => {
  try {
    fs.mkdirSync(SCANFAIL_DIR, { recursive: true });
    let meta = {};
    try { meta = JSON.parse(decodeURIComponent(String(req.headers["x-scan-meta"] || ""))); } catch (e) {}
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) meta = {};
    const ts = new Date().toISOString().replace(/[:.]/g, "-") + "-" + Math.random().toString(36).slice(2, 6);
    const ext = /png/i.test(String(meta.type || "")) ? "png" : "jpg";
    if (req.body && req.body.length) fs.writeFileSync(path.join(SCANFAIL_DIR, `${ts}.${ext}`), req.body);
    fs.writeFileSync(path.join(SCANFAIL_DIR, `${ts}.json`),
      JSON.stringify({ ...meta, ip: req.ip, bytes: req.body ? req.body.length : 0 }, null, 2));
    const files = fs.readdirSync(SCANFAIL_DIR).sort(); // ISO名なので辞書順=時刻順
    while (files.length > 40) { // 写真+JSONで2ファイル/件 → 20件まで
      const f = files.shift();
      try { fs.unlinkSync(path.join(SCANFAIL_DIR, f)); } catch (e) {}
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: `診断の保存に失敗: ${e.message}` });
  }
});

// ── GitHub 自動反映：定期的に origin を確認し、新しいコミットがあれば取り込んで再起動 ──
//    無効化したい場合は環境変数 AUTO_UPDATE_SEC=0 で起動する
const AUTO_UPDATE_SEC = parseInt(process.env.AUTO_UPDATE_SEC || "180", 10);
const gitExec = (args, cb) => execFile("git", args, { cwd: ROOT, timeout: 60000 }, cb);
let updating = false;
let startedHead = ""; // 起動時のコミット。変わっていたら（このPCで直接コミットした場合も）再起動する
gitExec(["rev-parse", "HEAD"], (e, out) => { if (!e) startedHead = String(out).trim(); });
function checkForUpdate() {
  if (updating) return;
  // ① このPC上で直接コミットされた場合（リモートより遅れ0でも HEAD は変わる）
  gitExec(["rev-parse", "HEAD"], (eh, oh) => {
    if (!eh && startedHead && String(oh).trim() !== startedHead && !updating) {
      updating = true;
      console.log("[auto-update] このPCでの新しいコミットを検出。再起動します。");
      setTimeout(() => process.exit(0), 500);
    }
  });
  // ② GitHub 側の新しいコミット
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
function canonicalBase() { // 正式アドレス（QRラベルのリンク先・誘導リンクに使う）
  if (httpsOn) return `https://${lanIP()}${HTTPS_PORT === 443 ? "" : ":" + HTTPS_PORT}/`;
  return `http://${lanIP()}:${PORT}/`;
}
app.get("/api/health", (req, res) =>
  res.json({ ok: true, version: dbm.getVersion(), base: canonicalBase(),
    httpsBase: httpsOn ? canonicalBase() : null }));

// ── 社内CA証明書の配布：各端末で1回インストール＋信頼すると「安全ではありません」が消える ──
app.get("/ca.crt", (req, res) => {
  const p = path.join(__dirname, "data", "tls", "ca.pem");
  if (!fs.existsSync(p)) return res.status(404).send("CA証明書がありません");
  res.set("Content-Type", "application/x-x509-ca-cert");
  res.set("Content-Disposition", 'attachment; filename="kyoshin-ca.crt"');
  res.send(fs.readFileSync(p));
});

// 未定義の /api/* は JSON で 404
app.use("/api", (req, res) => res.status(404).json({ error: "Not Found" }));

// ── 静的配信（既存フロントのみ。server/ や data/ は配信しない） ──
//    no-cache = 毎回サーバへ確認（304なら転送なし）。スマホに古いJSが残る事故を防ぐ
const noCache = { setHeaders: (res) => res.set("Cache-Control", "no-cache") };
const sendFile = (rel) => (req, res) => {
  res.set("Cache-Control", "no-cache");
  res.sendFile(path.join(ROOT, rel));
};
app.get("/", sendFile("index.html"));
app.get("/index.html", sendFile("index.html"));
app.get("/styles.css", sendFile("styles.css"));
app.use("/js", express.static(path.join(ROOT, "js"), noCache));
app.use("/assets", express.static(path.join(ROOT, "assets"), noCache));

const server = app.listen(PORT, HOST, () => {
  console.log(`[steel-manager] listening on http://localhost:${PORT}  (host=${HOST})`);
  console.log(`[steel-manager] DB=${dbm.DB_PATH}`);
  try {
    const n = dbm.seedIfEmpty();
    if (n) console.log(`[steel-manager] サンプル在庫を初回投入: ${n}件`);
  } catch (e) { console.error("[seed] 失敗:", e && e.message); }
});

// ── HTTPS（正式アドレス。カメラの「かざすだけスキャン」はHTTPSでしか使えない） ──
//    証明書は server/data/tls/（自己署名・Git対象外）。無ければ tools/TLS証明書を作る.bat で生成。
//    443（ポート表記なしの https://<IP>/）で起動し、使えなければ 3443 に退避する。
let HTTPS_PORT = parseInt(process.env.HTTPS_PORT || "443", 10);
let httpsOn = false;
let httpsServer = null;
function startHttps(tls, port) {
  const s = https.createServer(tls, app);
  s.on("error", (e) => {
    if (port === 443) {
      console.log(`[steel-manager] 443で起動できず(${e.code})。3443で再試行します`);
      HTTPS_PORT = 3443;
      startHttps(tls, 3443);
    } else {
      console.error("[steel-manager] HTTPS起動失敗:", e.message);
    }
  });
  s.listen(port, HOST, () => {
    httpsOn = true;
    httpsServer = s;
    const suffix = port === 443 ? "" : `:${port}`;
    console.log(`[steel-manager] 正式アドレス: https://${lanIP()}${suffix}/`);
  });
}
try {
  const tlsDir = path.join(__dirname, "data", "tls");
  const tls = {
    key: fs.readFileSync(path.join(tlsDir, "key.pem")),
    cert: fs.readFileSync(path.join(tlsDir, "cert.pem")),
  };
  startHttps(tls, HTTPS_PORT);
} catch (e) {
  console.log("[steel-manager] HTTPSは無効（server/data/tls/ に cert.pem / key.pem が無い）");
}

// ── http:80 も開けておく（アドレスバーに素のIPを打った人を https へ転送するため） ──
try {
  const s80 = app.listen(80, HOST, () => console.log("[steel-manager] http:80 → https へ転送"));
  s80.on("error", (e) => console.log(`[steel-manager] http:80 は使用不可(${e.code})`));
} catch (e) {}

process.on("SIGINT", () => { if (httpsServer) httpsServer.close(); server.close(() => process.exit(0)); });
process.on("SIGTERM", () => { if (httpsServer) httpsServer.close(); server.close(() => process.exit(0)); });

module.exports = app;
