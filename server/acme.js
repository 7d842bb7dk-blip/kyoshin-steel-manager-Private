// ─────────────────────────────────────────────────────────────
// acme.js — Let's Encrypt 証明書の自動取得・自動更新（ACME / RFC 8555・DNS-01）
//   ・ドメインは DuckDNS（無料）。<名前>.duckdns.org → サーバーPCのLAN IP を向ける。
//   ・Let's Encrypt の証明書はスマホ・PCが最初から信頼しているので、各端末の設定は不要。
//   ・DNS-01 方式なので、サーバーをインターネットに公開する必要はない（外からは入れないまま）。
//   ・外部パッケージなし（Node標準の crypto / fetch、CSR作成だけ Git 同梱の openssl を使う）。
//   設定: server/data/acme.json（tools/証明書を自動取得.bat が作る。Git対象外）
// ─────────────────────────────────────────────────────────────
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const dnsp = require("node:dns").promises;
const { execFile } = require("node:child_process");

const DATA_DIR = process.env.TLS_DATA_DIR ? path.resolve(process.env.TLS_DATA_DIR) : path.join(__dirname, "data");
const TLS_DIR = path.join(DATA_DIR, "tls");
const CFG_PATH = path.join(DATA_DIR, "acme.json");
const DIRS = {
  prod: "https://acme-v02.api.letsencrypt.org/directory",
  staging: "https://acme-staging-v02.api.letsencrypt.org/directory",
};
const RENEW_BEFORE_DAYS = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

function readCfg() {
  try { return JSON.parse(fs.readFileSync(CFG_PATH, "utf8")); } catch (e) { return null; }
}
function writeCfg(c) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CFG_PATH, JSON.stringify(c, null, 2));
}
function leFiles(staging) {
  const s = staging ? "-staging" : "";
  return { key: path.join(TLS_DIR, `le${s}-key.pem`), cert: path.join(TLS_DIR, `le${s}-fullchain.pem`) };
}
function certExpiry(certPath) {
  try { return new Date(new crypto.X509Certificate(fs.readFileSync(certPath)).validTo); } catch (e) { return null; }
}
function lanIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) if (ni.family === "IPv4" && !ni.internal) return ni.address;
  }
  return null;
}

// ── DuckDNS（A レコードと、検証用 TXT レコードの設定） ──
function duckSub(domain) { return String(domain).toLowerCase().replace(/\.duckdns\.org\.?$/, ""); }
const FW_BLOCKED = "DuckDNS に接続できません。社内のファイアウォール（FortiGate）でまだブロックされています（duckdns.org の許可が必要）";
function duckNetError(e) {
  const code = String((e && e.cause && e.cause.code) || "");
  // FortiGate の Webフィルターは差し替えた証明書でブロック画面を返すため、証明書エラーになる
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return new Error(FW_BLOCKED);
  return new Error("DuckDNS に接続できません（" + (code || (e && e.message)) + "）");
}
// 設定前の疎通確認（ブロック中かどうか）
async function duckReachable() {
  try { await fetch("https://www.duckdns.org/", { method: "HEAD" }); return { ok: true }; }
  catch (e) { return { ok: false, message: duckNetError(e).message }; }
}
async function duck(params) {
  let r;
  try { r = await fetch("https://www.duckdns.org/update?" + new URLSearchParams(params).toString()); }
  catch (e) { throw duckNetError(e); }
  const t = (await r.text()).trim();
  if (!t.startsWith("OK")) throw new Error("DuckDNS の更新に失敗しました（サブドメイン名かトークンが違う可能性）");
  return t;
}
const setARecord = (cfg, ip) => duck({ domains: duckSub(cfg.domain), token: cfg.token, ip });
const setTxt = (cfg, txt) => duck({ domains: duckSub(cfg.domain), token: cfg.token, txt });
const clearTxt = (cfg) => duck({ domains: duckSub(cfg.domain), token: cfg.token, txt: "x", clear: "true" });

// DuckDNS の権威DNSに TXT が載ったか確認してから検証を依頼する
async function waitTxt(name, value) {
  const servers = [];
  for (const ns of ["ns1.duckdns.org", "ns2.duckdns.org", "ns3.duckdns.org"]) {
    try { servers.push(...(await dnsp.resolve4(ns))); } catch (e) { /* 取れた分だけ使う */ }
  }
  const r = new dnsp.Resolver();
  if (servers.length) r.setServers(servers);
  for (let i = 0; i < 40; i++) {
    try {
      const recs = await r.resolveTxt(name);
      if (recs.some((x) => x.join("") === value)) return true;
    } catch (e) { /* まだ無い */ }
    await sleep(3000);
  }
  return false;
}

// ── CSR（証明書署名要求）: Git 同梱の openssl で作る ──
function opensslPath() {
  const c = [process.env.OPENSSL,
    "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
    "C:\\Program Files\\Git\\usr\\bin\\openssl.exe"].filter(Boolean);
  return c.find((p) => fs.existsSync(p)) || "openssl";
}
function makeCsr(keyPem, domain) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acme-"));
  const kp = path.join(tmp, "k.pem"), out = path.join(tmp, "csr.der");
  fs.writeFileSync(kp, keyPem);
  return new Promise((resolve, reject) => {
    execFile(opensslPath(), ["req", "-new", "-key", kp, "-subj", "/CN=" + domain,
      "-addext", "subjectAltName=DNS:" + domain, "-outform", "DER", "-out", out], { timeout: 30000 },
    (err, so, se) => {
      try {
        if (err) return reject(new Error("CSRの作成に失敗: " + String(se || err.message).trim()));
        resolve(fs.readFileSync(out));
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    });
  });
}

// ── ACME クライアント（JWS ES256） ──
class Acme {
  constructor(dirUrl, accountKey) {
    this.dirUrl = dirUrl;
    this.key = accountKey;
    const j = crypto.createPublicKey(accountKey).export({ format: "jwk" });
    this.jwk = { crv: j.crv, kty: j.kty, x: j.x, y: j.y }; // RFC 7638 の並び順
    this.thumbprint = b64u(crypto.createHash("sha256").update(JSON.stringify(this.jwk)).digest());
    this.kid = null;
    this.nonce = null;
  }
  async init() {
    const r = await fetch(this.dirUrl);
    if (!r.ok) throw new Error("Let's Encrypt に接続できません（HTTP " + r.status + "）");
    this.dir = await r.json();
    return this.dir;
  }
  async getNonce() {
    if (this.nonce) { const n = this.nonce; this.nonce = null; return n; }
    const r = await fetch(this.dir.newNonce, { method: "HEAD" });
    return r.headers.get("replay-nonce");
  }
  // payload="" は POST-as-GET
  async post(url, payload, accept) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const prot = { alg: "ES256", nonce: await this.getNonce(), url };
      if (this.kid) prot.kid = this.kid; else prot.jwk = this.jwk;
      const p = b64u(JSON.stringify(prot));
      const pl = payload === "" ? "" : b64u(JSON.stringify(payload));
      const sig = crypto.sign("sha256", Buffer.from(p + "." + pl), { key: this.key, dsaEncoding: "ieee-p1363" });
      const headers = { "Content-Type": "application/jose+json" };
      if (accept) headers.Accept = accept;
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ protected: p, payload: pl, signature: b64u(sig) }) });
      const n = res.headers.get("replay-nonce");
      if (n) this.nonce = n;
      const ct = res.headers.get("content-type") || "";
      const body = ct.includes("json") ? await res.json() : await res.text();
      if (!res.ok) {
        if (body && body.type === "urn:ietf:params:acme:error:badNonce" && attempt < 2) continue;
        const e = new Error(`Let's Encrypt エラー ${res.status}: ${(body && body.detail) || body}`);
        e.acme = body; e.status = res.status;
        throw e;
      }
      return { status: res.status, body, location: res.headers.get("location") };
    }
    throw new Error("Let's Encrypt との通信に失敗しました（nonce）");
  }
  async account(onlyReturnExisting) {
    const r = await this.post(this.dir.newAccount,
      onlyReturnExisting ? { onlyReturnExisting: true } : { termsOfServiceAgreed: true });
    this.kid = r.location;
    return r;
  }
}

function loadOrCreateAccountKey(staging) {
  fs.mkdirSync(TLS_DIR, { recursive: true });
  const p = path.join(TLS_DIR, staging ? "acme-account-staging.pem" : "acme-account.pem");
  if (fs.existsSync(p)) return crypto.createPrivateKey(fs.readFileSync(p));
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  fs.writeFileSync(p, privateKey.export({ type: "pkcs8", format: "pem" }));
  return privateKey;
}

// ── 証明書の取得（本番 / staging=予行演習） ──
async function issue(cfg, opts) {
  const o = opts || {};
  const log = o.log || (() => {});
  if (!cfg || !cfg.domain || !cfg.token) throw new Error("acme.json の設定（ドメイン・トークン）がありません");
  if (!cfg.agreed) throw new Error("Let's Encrypt の利用規約に同意していません");
  // 先に DuckDNS を更新（トークン違い等はここで止まり、Let's Encrypt には何も送らない）
  const ip = cfg.lanIp || lanIP();
  log(`DNS 設定: ${cfg.domain} → ${ip}`);
  await setARecord(cfg, ip);

  const acme = new Acme(o.staging ? DIRS.staging : DIRS.prod, loadOrCreateAccountKey(o.staging));
  await acme.init();
  await acme.account(false);

  const order = await acme.post(acme.dir.newOrder, { identifiers: [{ type: "dns", value: cfg.domain }] });
  const orderUrl = order.location;
  let ord = order.body;

  for (const authzUrl of ord.authorizations) {
    const az = (await acme.post(authzUrl, "")).body;
    if (az.status === "valid") continue;
    const ch = (az.challenges || []).find((c) => c.type === "dns-01");
    if (!ch) throw new Error("DNS-01 検証が使えません");
    const txt = b64u(crypto.createHash("sha256").update(ch.token + "." + acme.thumbprint).digest());
    log("ドメインの確認用レコードを設定…");
    await setTxt(cfg, txt);
    await waitTxt("_acme-challenge." + cfg.domain, txt);
    await sleep(10000); // 反映待ちの余裕
    log("ドメインの確認を依頼…");
    await acme.post(ch.url, {});
    let st = az;
    for (let i = 0; i < 60; i++) {
      await sleep(3000);
      st = (await acme.post(authzUrl, "")).body;
      if (st.status !== "pending") break;
    }
    if (st.status !== "valid") {
      const d = (st.challenges || []).find((c) => c.type === "dns-01");
      throw new Error("ドメインの確認に失敗: " + ((d && d.error && d.error.detail) || st.status));
    }
  }

  for (let i = 0; i < 30 && ord.status !== "ready" && ord.status !== "valid"; i++) {
    await sleep(2000);
    ord = (await acme.post(orderUrl, "")).body;
    if (ord.status === "invalid") throw new Error("注文が無効になりました");
  }

  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const csr = await makeCsr(keyPem, cfg.domain);
  log("証明書の発行を依頼…");
  if (ord.status !== "valid") ord = (await acme.post(ord.finalize, { csr: b64u(csr) })).body;
  for (let i = 0; i < 60 && ord.status !== "valid"; i++) {
    if (ord.status === "invalid") throw new Error("証明書の発行に失敗しました");
    await sleep(2000);
    ord = (await acme.post(orderUrl, "")).body;
  }
  if (ord.status !== "valid" || !ord.certificate) throw new Error("証明書の発行がタイムアウトしました");
  const pem = (await acme.post(ord.certificate, "", "application/pem-certificate-chain")).body;
  if (!String(pem).includes("BEGIN CERTIFICATE")) throw new Error("証明書の受け取りに失敗しました");

  const f = leFiles(o.staging);
  fs.mkdirSync(TLS_DIR, { recursive: true });
  fs.writeFileSync(f.key + ".tmp", keyPem);
  fs.writeFileSync(f.cert + ".tmp", pem);
  fs.renameSync(f.key + ".tmp", f.key);
  fs.renameSync(f.cert + ".tmp", f.cert);
  try { await clearTxt(cfg); } catch (e) { /* 残っても害はない */ }
  const expires = certExpiry(f.cert);
  log(`証明書を取得しました（有効期限 ${expires ? expires.toLocaleDateString("ja-JP") : "?"}）`);
  return { ok: true, expires, files: f };
}

// ── サーバーから定期的に呼ぶ：期限30日前になったら自動更新 ──
async function renewIfNeeded(log) {
  const cfg = readCfg();
  if (!cfg || !cfg.agreed || !cfg.domain || !cfg.token) return { skipped: "未設定" };
  const exp = certExpiry(leFiles(false).cert);
  if (exp && exp.getTime() - Date.now() > RENEW_BEFORE_DAYS * 86400000) return { skipped: "期限内", expires: exp };
  return issue(cfg, { log });
}

module.exports = {
  DATA_DIR, TLS_DIR, CFG_PATH, DIRS,
  readCfg, writeCfg, leFiles, certExpiry, lanIP, duckSub, duckReachable,
  setARecord, issue, renewIfNeeded, makeCsr, Acme,
};
