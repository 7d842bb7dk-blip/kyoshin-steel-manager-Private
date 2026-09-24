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
const tls = require("node:tls");
const dnsp = require("node:dns").promises;
const { execFile } = require("node:child_process");
const express = require("express");
const dbm = require("./db");
const acme = require("./acme");

const BOOT = Date.now(); // 起動時刻。変わっていたらクライアントは再読み込み（自動反映の波及用）

const ROOT = path.join(__dirname, ".."); // プロジェクト直下（index.html がある場所）
const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);
const HOST = process.env.HOST || "0.0.0.0";

app.use(express.json({ limit: "8mb" }));

// ── アドレスの一本化：正式アドレス（canonicalBase）以外で開いたページは正式アドレスへ転送 ──
//    Let's Encrypt 証明書があれば https://<ドメイン>/、無ければ https://<IP>/。
//    /api/* は転送しない（開きっぱなしの旧ページのポーリングを壊さないため）。
//    localhost はサーバー機での開発用にそのまま通す。
app.use((req, res, next) => {
  if (!httpsOn) return next();
  if (req.path.startsWith("/api/")) return next();
  if (req.path === "/ca.crt") return next(); // 証明書を信頼する前でも取得できるようそのまま通す
  if (req.hostname === "localhost" || req.hostname === "127.0.0.1") return next();
  // 有効な証明書でドメイン宛てに届いたものは、そのまま通す（IPへ追い返さない）
  if (req.secure && leCtx && String(req.hostname).toLowerCase() === leDomain) return next();
  const want = new URL(canonicalBase());
  if (req.secure && req.hostname === want.hostname) return next();
  res.redirect(302, want.origin + req.originalUrl);
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
  if (renewing) return; // 証明書の更新中は再起動しない（途中で止めると確認用レコードやロックが残る）
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
  const suffix = HTTPS_PORT === 443 ? "" : ":" + HTTPS_PORT;
  // ドメインに切り替えるのは、証明書が有効で、しかも社内の名前解決がこのサーバーを指しているときだけ
  if (httpsOn && leCtx && leDomain && leReady) return `https://${leDomain}${suffix}/`;
  if (httpsOn) return `https://${lanIP()}${suffix}/`;
  return `http://${lanIP()}:${PORT}/`;
}
function tlsStatus() { // 管理者向けの状態表示用
  const pend = acme.readPending();
  const pending = pend && pend.cfg ? { domain: pend.cfg.domain, lastError: pend.lastError || null } : null;
  if (!leDomain && !acme.readCfg()) return pending ? { domain: null, active: false, pending } : null;
  const cfg = acme.readCfg() || {};
  const info = acme.certInfo(acme.leFiles(false).cert, cfg.domain);
  const st = acme.readState();
  return {
    domain: cfg.domain || null,
    active: !!(leCtx && leReady),
    expires: info ? info.expires.toISOString() : null,
    daysLeft: info ? Math.floor((info.expires.getTime() - Date.now()) / 86400000) : null,
    lastError: st.lastError || null,
    pending,
  };
}
app.get("/api/health", (req, res) =>
  res.json({ ok: true, version: dbm.getVersion(), base: canonicalBase(),
    httpsBase: httpsOn ? canonicalBase() : null, tls: tlsStatus() }));

// ── Let's Encrypt 証明書の読み直し（取得ツールから呼ぶ。サーバー機の中からだけ受け付ける） ──
app.post("/api/tls-reload", async (req, res) => {
  const ip = String(req.socket.remoteAddress || "");
  if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(ip)) return res.status(403).json({ error: "forbidden" });
  const ok = loadLe();
  await checkLeDns();
  res.json({ ok, domain: leDomain, ready: leReady, base: canonicalBase() });
});

// ── 社内CA証明書の配布（旧方式。Let's Encrypt 導入後は不要だが、IP直打ち用に残す） ──
app.get("/ca.crt", (req, res) => {
  const p = path.join(acme.TLS_DIR, "ca.pem");
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
//    ・Let's Encrypt 証明書（ドメイン名宛て）があれば、そのドメインでのアクセスに使う（端末の設定不要）。
//    ・IP直打ちには社内CA証明書（server/data/tls/cert.pem）で応答する。
//    ・証明書ファイルは server/data/tls/（Git対象外）。取得は tools/証明書を自動取得.bat。
//    443（ポート表記なし）で起動し、使えなければ 3443 に退避する。
let HTTPS_PORT = parseInt(process.env.HTTPS_PORT || "443", 10);
let httpsOn = false;
let httpsServer = null;
let leCtx = null, leDomain = null, leReady = false, leExpires = null;
function dropLe(reason) {
  if (leCtx && reason) console.log("[tls] Let's Encrypt 証明書を使いません：" + reason);
  leCtx = null; leDomain = null; leReady = false; leExpires = null;
}
// 期限切れ・名前違いの証明書は使わない（その場合は従来どおりIPのアドレスで動く）
function loadLe() {
  try {
    const cfg = acme.readCfg();
    const f = acme.leFiles(false);
    if (!cfg || !cfg.domain || !fs.existsSync(f.cert) || !fs.existsSync(f.key)) { dropLe(); return false; }
    const domain = String(cfg.domain).toLowerCase();
    const info = acme.certInfo(f.cert, domain);
    if (!info) { dropLe("証明書を読めません"); return false; }
    if (!info.matches) { dropLe(`証明書の名前が ${domain} と違います`); return false; }
    if (info.expired) { dropLe("期限切れです"); return false; }
    leCtx = tls.createSecureContext({ key: fs.readFileSync(f.key), cert: fs.readFileSync(f.cert) });
    leDomain = domain;
    leExpires = info.expires;
    console.log(`[tls] Let's Encrypt 証明書: ${leDomain}（期限 ${info.expires.toLocaleDateString("ja-JP")}）`);
    return true;
  } catch (e) {
    console.error("[tls] Let's Encrypt 証明書の読み込みに失敗:", e.message);
    dropLe();
    return false;
  }
}
// 社内の名前解決（スマホと同じ 192.168.1.1 を使うOSのDNS）がこのサーバーを指しているか。
// 指していない間（切り替え直後のキャッシュ・IP変更後など）はドメインへの転送をしない。
// あわせて、ディスク上の証明書が別の手段で更新されていれば読み直す。
async function checkLeDns() {
  const cfg = acme.readCfg() || {};
  const disk = cfg.domain ? acme.certInfo(acme.leFiles(false).cert, cfg.domain) : null;
  if (disk && disk.matches && !disk.expired && (!leExpires || disk.expires.getTime() !== leExpires.getTime())) loadLe();
  if (leCtx && leExpires && leExpires.getTime() <= Date.now()) dropLe("期限切れになりました");
  if (!leCtx || !leDomain) { leReady = false; return; }
  const want = cfg.lanIp;
  let ok;
  if (!want || !acme.lanIPs().includes(want)) ok = false; // このPCのIPが変わった
  else {
    try { ok = (await dnsp.lookup(leDomain, { family: 4, all: true })).some((a) => a.address === want); }
    catch (e) { return; } // 一時的な名前解決の失敗では切り替えない（今の状態を保つ）
  }
  if (ok !== leReady) console.log(ok ? `[tls] 名前解決OK。正式アドレスを https://${leDomain}/ に切り替えます`
    : `[tls] ${leDomain} がこのサーバー（${want}）を指していないため、IPのアドレスで動かします`);
  leReady = ok;
}
loadLe();
checkLeDns();
setInterval(checkLeDns, 5 * 60 * 1000);
// 既存証明書の自動更新（期限30日前。12時間ごとに確認。初回の取得はツールで行う）
let renewing = false;
async function renewTick() {
  if (renewing) return;
  renewing = true;
  try {
    const r = await acme.renewIfNeeded((m) => console.log("[acme] " + m));
    if (r && r.ok) { loadLe(); await checkLeDns(); }
  } catch (e) {
    console.error("[acme] 証明書の自動更新に失敗（6時間後に再試行）:", e.message);
  } finally { renewing = false; }
}
setTimeout(renewTick, 60 * 1000);
setInterval(renewTick, 12 * 3600 * 1000);
// 初回取得の続き（ツールで「サーバーに任せる」になった分）。DNSが動き出し次第、取得して切り替える
async function pendingTick() {
  if (renewing || !acme.readPending()) return;
  renewing = true;
  try {
    const r = await acme.finishPending((m) => console.log("[acme] " + m));
    if (r && r.ok) {
      console.log("[acme] 初回の証明書取得が完了しました");
      loadLe();
      await checkLeDns();
    }
  } catch (e) {
    console.error("[acme] 初回の証明書取得に失敗（6時間後に再試行）:", e.message);
  } finally { renewing = false; }
}
setTimeout(pendingTick, 90 * 1000);
setInterval(pendingTick, 10 * 60 * 1000);
// 想定外の非同期エラーでサーバーごと落ちないよう、記録だけ残す
process.on("unhandledRejection", (e) => console.error("[steel-manager] 未処理のエラー:", e && e.message ? e.message : e));
function startHttps(tlsOpts, port) {
  const s = https.createServer({
    ...tlsOpts,
    SNICallback: (name, cb) => cb(null, (leCtx && String(name).toLowerCase() === leDomain) ? leCtx : undefined),
  }, app);
  s.on("error", (e) => {
    if (port === 443) {
      console.log(`[steel-manager] 443で起動できず(${e.code})。3443で再試行します`);
      HTTPS_PORT = 3443;
      startHttps(tlsOpts, 3443);
    } else {
      console.error("[steel-manager] HTTPS起動失敗:", e.message);
    }
  });
  s.listen(port, HOST, () => {
    httpsOn = true;
    httpsServer = s;
    console.log(`[steel-manager] 正式アドレス: ${canonicalBase()}`);
  });
}
try {
  startHttps({
    key: fs.readFileSync(path.join(acme.TLS_DIR, "key.pem")),
    cert: fs.readFileSync(path.join(acme.TLS_DIR, "cert.pem")),
  }, HTTPS_PORT);
} catch (e) {
  console.log("[steel-manager] HTTPSは無効（server/data/tls/ に cert.pem / key.pem が無い）");
}

// ── http:80 も開けておく（アドレスバーに素のIPを打った人を https へ転送するため） ──
if (process.env.HTTP80 !== "0") {
  const s80 = app.listen(80, HOST, () => console.log("[steel-manager] http:80 → https へ転送"));
  s80.on("error", (e) => console.log(`[steel-manager] http:80 は使用不可(${e.code})`));
}

process.on("SIGINT", () => { if (httpsServer) httpsServer.close(); server.close(() => process.exit(0)); });
process.on("SIGTERM", () => { if (httpsServer) httpsServer.close(); server.close(() => process.exit(0)); });

module.exports = app;
