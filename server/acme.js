// ─────────────────────────────────────────────────────────────
// acme.js — Let's Encrypt 証明書の自動取得・自動更新（ACME / RFC 8555・DNS-01）
//   ・ドメインは会社のドメイン（エックスサーバー管理：zaiko.f-kyo-shin.co.jp 等）、自分で取ったドメイン
//     （XServerドメイン：kyoshin-zaiko.com 等）、DuckDNS のいずれか。
//     その名前 → サーバーPCのLAN IP を向ける。
//   ・Let's Encrypt の証明書はスマホ・PCが最初から信頼しているので、各端末の設定は不要。
//   ・DNS-01 方式なので、サーバーをインターネットに公開する必要はない（外からは入れないまま）。
//   ・外部パッケージなし（Node標準の crypto / fetch、CSR作成だけ Git 同梱の openssl を使う）。
//   設定: server/data/acme.json（tools/証明書を自動取得.bat が「本番取得に成功した後」に作る。Git対象外）
//   初回の取得はツールだけが行い、サーバーは既存証明書の更新（期限30日前）だけを行う。
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
const STATE_PATH = path.join(TLS_DIR, "renew-state.json");
const LOCK_PATH = path.join(TLS_DIR, "acme.lock");
const DIRS = {
  prod: "https://acme-v02.api.letsencrypt.org/directory",
  staging: "https://acme-staging-v02.api.letsencrypt.org/directory",
};
const RENEW_BEFORE_DAYS = 30;
const RETRY_AFTER_FAIL_MS = 6 * 3600 * 1000; // 失敗後は6時間あけて再試行（Let's Encrypt の失敗回数制限対策）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; } }
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + ".tmp", JSON.stringify(v, null, 2));
  fs.renameSync(p + ".tmp", p);
}
const readCfg = () => readJson(CFG_PATH);
const writeCfg = (c) => writeJson(CFG_PATH, c);
const readState = () => readJson(STATE_PATH) || {};
const writeState = (s) => writeJson(STATE_PATH, s);

function leFiles(staging) {
  const s = staging ? "-staging" : "";
  return { key: path.join(TLS_DIR, `le${s}-key.pem`), cert: path.join(TLS_DIR, `le${s}-fullchain.pem`) };
}
// 証明書の情報（期限・対象の名前が合っているか）
function certInfo(certPath, domain) {
  try {
    const x = new crypto.X509Certificate(fs.readFileSync(certPath));
    const expires = new Date(x.validTo);
    return { expires, matches: !domain || !!x.checkHost(domain), expired: expires.getTime() <= Date.now() };
  } catch (e) { return null; }
}
function certExpiry(certPath) { const i = certInfo(certPath); return i ? i.expires : null; }
function lanIPs() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
  }
  return out;
}
function lanIP() { return lanIPs()[0] || null; }

// ── 同時実行の防止（ツールとサーバーが同時に取得しないように） ──
function acquireLock() {
  fs.mkdirSync(TLS_DIR, { recursive: true });
  let st = null;
  try { st = fs.statSync(LOCK_PATH); } catch (e) { /* ロック無し */ }
  if (st) {
    let alive = false;
    const pid = parseInt(fs.readFileSync(LOCK_PATH, "utf8"), 10);
    if (pid > 0 && pid !== process.pid) {
      try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === "EPERM"; } // ESRCH＝もう居ない
    }
    if (alive && Date.now() - st.mtimeMs < 40 * 60000) throw new Error("別の証明書取得が実行中です。しばらく待ってから再実行してください");
    fs.rmSync(LOCK_PATH, { force: true }); // 途中で閉じた等の残骸
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" });
  return () => { try { fs.rmSync(LOCK_PATH, { force: true }); } catch (e) { /* */ } };
}

// ── 通信エラーの説明（FortiGate の Webフィルターは差し替えた証明書でブロック画面を返すため、証明書エラーになる） ──
function netError(service, e) {
  const code = String((e && e.cause && e.cause.code) || "");
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) {
    return new Error(`${service} に接続できません。社内のファイアウォール（FortiGate）でブロックされています`);
  }
  return new Error(`${service} に接続できません（${code || (e && e.message)}）`);
}

// ── 公開DNS（このPCの既定DNS 127.0.0.1 は外部への問い合わせを受け付けないため） ──
function publicResolver() {
  const r = new dnsp.Resolver({ timeout: 4000, tries: 2 });
  r.setServers(["8.8.8.8", "1.1.1.1"]);
  return r;
}

// ドメインの「登録先ネームサーバー」を、上位（.com や .jp）の管理サーバーに直接聞く。
//   公開DNS（8.8.8.8 等）は古い値を数時間覚えていることがあるため、切り替えの反映確認はこちらで行う。
//   Node の dns は委任（応答の authority 部）を返さないので、UDP で1問だけ自前で問い合わせる。
//   戻り値：NS名の配列／聞けなかったら null（呼び出し側で公開DNSに切り替える）
function dnsQueryNs(serverIp, zone, timeoutMs = 3000) {
  const dgram = require("node:dgram");
  return new Promise((resolve) => {
    const id = crypto.randomBytes(2).readUInt16BE(0);
    const q = [Buffer.from([id >> 8, id & 255, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0])]; // RD=0（再帰なし）・質問1件
    for (const l of zone.split(".")) { q.push(Buffer.from([l.length]), Buffer.from(l, "ascii")); }
    q.push(Buffer.from([0, 0, 2, 0, 1])); // 終端・NS・IN
    const sock = dgram.createSocket("udp4");
    const done = (v) => { clearTimeout(t); try { sock.close(); } catch (e) { /* */ } resolve(v); };
    const t = setTimeout(() => done(null), timeoutMs);
    sock.on("error", () => done(null));
    sock.on("message", (m) => {
      try {
        if (m.length < 12 || m.readUInt16BE(0) !== id) return;
        if ((m[3] & 15) !== 0) return done((m[3] & 15) === 3 ? [] : null); // NXDOMAIN＝登録なし
        const name = (off) => { // 圧縮に対応した名前の読み取り → [名前, 次の位置]
          const parts = []; let end = -1, jumps = 0;
          for (;;) {
            const len = m[off];
            if (len === 0) { off++; break; }
            if ((len & 0xc0) === 0xc0) { if (end < 0) end = off + 2; off = ((len & 0x3f) << 8) | m[off + 1]; if (++jumps > 20) throw new Error("loop"); continue; }
            parts.push(m.toString("ascii", off + 1, off + 1 + len)); off += len + 1;
          }
          return [parts.join(".").toLowerCase(), end < 0 ? off : end];
        };
        let off = 12;
        const qd = m.readUInt16BE(4), rrCount = m.readUInt16BE(6) + m.readUInt16BE(8);
        for (let i = 0; i < qd; i++) off = name(off)[1] + 4;
        const out = [];
        for (let i = 0; i < rrCount; i++) {
          const [owner, o2] = name(off);
          const type = m.readUInt16BE(o2), rdlen = m.readUInt16BE(o2 + 8);
          if (type === 2 && owner === zone.toLowerCase()) out.push(name(o2 + 10)[0]);
          off = o2 + 10 + rdlen;
        }
        done(out);
      } catch (e) { done(null); }
    });
    sock.send(Buffer.concat(q), 53, serverIp);
  });
}
async function delegationNs(zone) {
  const pub = publicResolver();
  const labels = zone.split(".");
  let hosts = [];
  for (let i = 1; i < labels.length && !hosts.length; i++) { // .co.jp → co.jp に無ければ jp、のように上へ
    try { hosts = await pub.resolveNs(labels.slice(i).join(".")); } catch (e) { /* この階層は区切りではない */ }
  }
  if (!hosts.length) return null;
  for (const h of hosts.slice(0, 4)) {
    let ips = [];
    try { ips = await pub.resolve4(h); } catch (e) { continue; }
    for (const ip of ips.slice(0, 1)) {
      const r = await dnsQueryNs(ip, zone);
      if (r) return r;
    }
  }
  return null;
}

// ── DNS サービスごとの操作 ──
//   provider: name / reachable() / setA(cfg, ip) / setTxt(cfg, value)→handle / clearTxt(cfg, handle)
//             / nsHosts(cfg)（権威DNSサーバー名） / settleMs（反映確認後の待ち時間）
//   setA は cfg.aId（自分が作ったAレコードのID）を記録する（エックスサーバーのみ）

// DuckDNS
function duckSub(domain) { return String(domain).toLowerCase().replace(/\.duckdns\.org\.?$/, ""); }
async function duck(params) {
  let r;
  try { r = await fetch("https://www.duckdns.org/update?" + new URLSearchParams(params).toString()); }
  catch (e) { throw netError("DuckDNS", e); }
  const t = (await r.text()).trim();
  if (!t.startsWith("OK")) throw new Error("DuckDNS の更新に失敗しました（サブドメイン名かトークンが違う可能性）");
  return t;
}
const duckdns = {
  name: "DuckDNS",
  async reachable() {
    try { await fetch("https://www.duckdns.org/", { method: "HEAD" }); return { ok: true }; }
    catch (e) { return { ok: false, message: netError("DuckDNS", e).message }; }
  },
  setA: (cfg, ip) => duck({ domains: duckSub(cfg.domain), token: cfg.token, ip }),
  async setTxt(cfg, value) { await duck({ domains: duckSub(cfg.domain), token: cfg.token, txt: value }); return null; },
  clearTxt: (cfg) => duck({ domains: duckSub(cfg.domain), token: cfg.token, txt: "x", clear: "true" }),
  nsHosts: async () => ["ns1.duckdns.org", "ns2.duckdns.org", "ns3.duckdns.org"],
  settleMs: 65000, // TXT の TTL(60秒)ぶん待って、予行演習の古い値が残らないようにする
};

// エックスサーバー（XServer API。公式仕様: https://developer.xserver.ne.jp/api/server/openapi.json ）
//   一覧 GET /v1/server/{servername}/dns?domain=… → { records: [{ id, domain, host("@"=本体), type, content, ttl }] }
//   追加 POST …/dns { domain, host, type, content, ttl } → { id }　更新 PUT …/dns/{id}　削除 DELETE …/dns/{id}
//   cfg: { zone:"f-kyo-shin.co.jp", host:"zaiko", servername:"xs123456.xsrv.jp", token:"APIキー", aId }
//   会社のホームページ・メールのDNSを壊さないため、触るのは次の2つだけ：
//     ・cfg.host の A レコード（自分が作ったもの＝cfg.aId か、中身がこのサーバーのIPのもの）
//     ・_acme-challenge.<cfg.host> の TXT レコード
const XS_API = process.env.XSERVER_API_BASE || "https://api.xserver.ne.jp";
// エラー時の案内（サーバー用とドメイン用で見るところが違う）
const XS_KIND = { label: "エックスサーバー", 401: "：APIキーを確認", 403: "：APIキーの権限（DNSレコード）を確認", 404: "：サーバーを確認" };
const XD_KIND = { label: "XServerドメイン", 401: "：APIキーを確認", 403: "：APIキーの権限（DNSレコード・ネームサーバー）と対象ドメインを確認",
  404: "：ドメイン名・APIキーの対象ドメインを確認" };
async function xsReq(token, method, p, body, kind = XS_KIND, retried) {
  let r;
  try {
    r = await fetch(XS_API + p, {
      method,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) { throw netError("エックスサーバー", e); }
  if (r.status === 429 && !retried) { // 回数制限：指定秒数待って1回だけ再試行
    await sleep(Math.min(60, parseInt(r.headers.get("retry-after") || "5", 10) || 5) * 1000);
    return xsReq(token, method, p, body, kind, true);
  }
  let j = null;
  try { j = await r.json(); } catch (e) { /* 本文なし */ }
  if (!r.ok) {
    const er = j && j.error;
    const detail = er ? String(er.message || er.code || "") + (Array.isArray(er.errors) && er.errors.length ? "（" + er.errors.join(" / ") + "）" : "") : "";
    const hint = kind[r.status] || "";
    const err = new Error(`${kind.label}APIエラー ${r.status} ${detail}${hint}`.replace(/\s+/g, " ").trim());
    err.status = r.status;
    throw err;
  }
  return j || {};
}
const xs = (cfg, method, p, body) => xsReq(cfg.token, method, `/v1/server/${encodeURIComponent(cfg.servername)}${p}`, body);
const up = (s) => String(s || "").toUpperCase();
function xsHost(cfg, h) { // 一覧の host を「ゾーンを除いた部分」にそろえる（本体は "@"）
  let s = String(h == null ? "" : h).toLowerCase().trim().replace(/\.$/, "");
  const z = String(cfg.zone).toLowerCase();
  if (s === "" || s === "@" || s === z) return "@";
  if (s.endsWith("." + z)) s = s.slice(0, -(z.length + 1));
  return s;
}
// 使える名前は「1語だけ」（zaiko など）。ホームページ・メールで使われうる名前は使わない
//   （エックスサーバーは *.ドメイン がホームページを指すため、mail 等に A を作ると上書きになる）
const RESERVED_HOSTS = new Set(["www", "mail", "smtp", "pop", "pop3", "imap", "ftp", "webmail", "autodiscover",
  "autoconfig", "mx", "ns", "ns1", "ns2", "ns3", "ns4", "ns5", "localhost", "cpanel", "admin", "server"]);
function checkHostName(h) {
  const s = String(h || "").toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(s)) return "使うアドレスの名前は英数字1語にしてください（例: zaiko）";
  if (RESERVED_HOSTS.has(s)) return `「${s}」はホームページ・メールで使われる名前なので使えません（例: zaiko）`;
  return null;
}
function hostOf(cfg) {
  const bad = checkHostName(cfg.host);
  if (bad) throw new Error(bad);
  return String(cfg.host).toLowerCase();
}
async function xsList(cfg) {
  const j = await xs(cfg, "GET", "/dns?domain=" + encodeURIComponent(cfg.zone));
  if (!j || !Array.isArray(j.records)) throw new Error("エックスサーバーのDNS一覧の形式が想定と違うため中止しました（何も変更していません）");
  const z = String(cfg.zone).toLowerCase();
  const recs = j.records.filter((r) => !r.domain || String(r.domain).toLowerCase() === z);
  // 安全装置：ドメイン本体（ホームページ・メール）の設定が一覧に見えない＝正しく読めていない → 書き込まない
  if (!recs.some((r) => xsHost(cfg, r.host) === "@" && ["A", "MX", "NS", "CNAME"].includes(up(r.type)))) {
    throw new Error(`エックスサーバーのDNS一覧に ${cfg.zone} 本体の設定が見当たらないため中止しました（何も変更していません）`);
  }
  return recs;
}
function foreignErr(cfg, r) {
  return new Error(`${cfg.domain} には既に別の設定（${up(r.type)} ${r.content}）があります。上書きしないので、別の名前を使ってください（何も変更していません）`);
}
const xserver = {
  name: "エックスサーバー",
  async reachable() {
    try { await fetch(XS_API + "/", { method: "GET" }); return { ok: true }; }
    catch (e) { return { ok: false, message: netError("エックスサーバー", e).message }; }
  },
  // APIキー情報（有効期限など）とサーバー一覧（ツールでの自動検出用）
  me: (token) => xsReq(token, "GET", "/v1/me"),
  servers: async (token) => { const j = await xsReq(token, "GET", "/v1/server"); return Array.isArray(j.servers) ? j.servers : []; },
  probe: (cfg) => xsList(cfg),
  async setA(cfg, ip) {
    const host = hostOf(cfg);
    const same = (await xsList(cfg)).filter((r) => xsHost(cfg, r.host) === host);
    const blocker = same.find((r) => ["CNAME", "AAAA"].includes(up(r.type)));
    if (blocker) throw foreignErr(cfg, blocker);
    const aRecs = same.filter((r) => up(r.type) === "A");
    const mine = aRecs.filter((r) => (cfg.aId != null && String(r.id) === String(cfg.aId)) || String(r.content).trim() === ip);
    const foreign = aRecs.find((r) => !mine.includes(r));
    if (foreign) throw foreignErr(cfg, foreign);
    if (!mine.length) {
      const j = await xs(cfg, "POST", "/dns", { domain: cfg.zone, host, type: "A", content: ip, ttl: 300 });
      cfg.aId = j.id;
      return;
    }
    const keep = mine.find((r) => cfg.aId != null && String(r.id) === String(cfg.aId)) || mine[0];
    if (String(keep.content).trim() !== ip) {
      await xs(cfg, "PUT", "/dns/" + keep.id, { domain: cfg.zone, host, type: "A", content: ip, ttl: 300 });
    }
    for (const x of mine) if (x !== keep) await xs(cfg, "DELETE", "/dns/" + x.id);
    cfg.aId = keep.id;
  },
  async setTxt(cfg, value) {
    const host = "_acme-challenge." + hostOf(cfg);
    for (const x of (await xsList(cfg)).filter((r) => up(r.type) === "TXT" && xsHost(cfg, r.host) === host)) {
      await xs(cfg, "DELETE", "/dns/" + x.id); // 前回の残りを掃除（この名前のTXTだけ）
    }
    const j = await xs(cfg, "POST", "/dns", { domain: cfg.zone, host, type: "TXT", content: value, ttl: 60 });
    return j.id;
  },
  async clearTxt(cfg, id) { if (id != null) await xs(cfg, "DELETE", "/dns/" + id); },
  nsHosts: (cfg) => publicResolver().resolveNs(cfg.zone),
  settleMs: 65000,
};

// XServerドメイン（自分で取ったドメイン。XServer Domain API: https://developer.xserver.ne.jp/api/domain/openapi.json ）
//   一覧 GET /v1/domain/{zone}/dns → { records: [{ id, host("@"=本体), type, content, ttl }] }
//   追加 POST …/dns { type, host, content, ttl } → { id }　変更 PUT …/dns/{id}　削除 DELETE …/dns/{id}
//   ネームサーバーが ns1〜3.xdomain.ne.jp でないと、設定した DNS は反映されない（ツールで確認・切り替え）
//   cfg: { zone:"kyoshin-zaiko.com", host:"@" or "zaiko", token, aId }
//   在庫システム専用のドメインなので、本体（@）も使える。触るのは cfg.host の A と _acme-challenge の TXT だけ。
const XDOMAIN_NS = ["ns1.xdomain.ne.jp", "ns2.xdomain.ne.jp", "ns3.xdomain.ne.jp"];
const xd = (cfg, method, p, body) => xsReq(cfg.token, method, `/v1/domain/${encodeURIComponent(cfg.zone)}${p}`, body, XD_KIND);
// ネームサーバーの権限が無いときは、どこを直せばよいかをはっきり言う
const NS_PERM_MSG = "APIキーに「ネームサーバー」の権限がありません（XServerアカウント →「APIキー管理」→ このキーの権限を「カスタム」にして、ネームサーバーとDNSレコードを変更できるようにする）";
async function xdNs(cfg, method, body) {
  try { return await xd(cfg, method, "/nameservers", body); }
  catch (e) {
    if (e.status !== 403) throw e;
    const er = new Error(NS_PERM_MSG);
    er.status = 403;
    throw er;
  }
}
// /v1/me の services.domain を見て、NS切替・DNS書き込みに必要な権限が「無いとはっきり分かる」ときだけ理由を返す
//   （形が想定と違う・項目名が分からないときは null＝判断しない。最後は実際の呼び出しで確かめる）
function xdPermProblem(me, zone) {
  if (!me || !me.services || typeof me.services !== "object") return null;
  const d = me.services.domain;
  if (!d) return "このAPIキーは「ドメイン」用ではありません（サーバー用のキーは使えません。「利用するサービス：ドメイン」で作り直してください）";
  if (zone && d.target_mode === "selected" && Array.isArray(d.targets) && d.targets.length
    && !d.targets.some((t) => String(t).toLowerCase() === zone)) {
    return `このAPIキーの対象に ${zone} が入っていません（対象：${d.targets.join(", ")}。ドメイン名の打ち間違いか、キーの対象ドメインを確認）`;
  }
  if (d.permission_type === "read") return "このAPIキーは「読み取りのみ」です（権限を「カスタム」にして、DNSレコードとネームサーバーを変更できるようにしてください）";
  if (d.permission_type === "custom" && d.permissions && typeof d.permissions === "object") {
    for (const [k, v] of Object.entries(d.permissions)) {
      if (/ネームサーバー|nameserver|DNSレコード|^dns([_-]?records?)?$/i.test(k) && v !== "full") return `このAPIキーには「${k}」の変更権限がありません（権限をカスタムで「変更可」にしてください）`;
    }
  }
  return null;
}
function xdHost(cfg) {
  const h = String(cfg.host || "").toLowerCase();
  if (h === "@") return "@";
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(h)) throw new Error("使うアドレスの名前は英数字1語にしてください（例: zaiko）");
  return h;
}
async function xdList(cfg) {
  const j = await xd(cfg, "GET", "/dns");
  if (!j || !Array.isArray(j.records)) throw new Error("XServerドメインのDNS一覧の形式が想定と違うため中止しました（何も変更していません）");
  return j.records;
}
const xdomain = {
  name: "XServerドメイン",
  reachable: () => xserver.reachable(),
  me: (token) => xsReq(token, "GET", "/v1/me", undefined, XD_KIND),
  permProblem: xdPermProblem,
  domains: async (token) => { const j = await xsReq(token, "GET", "/v1/domain", undefined, XD_KIND); return Array.isArray(j.domains) ? j.domains : []; },
  nameservers: async (cfg) => { const j = await xdNs(cfg, "GET"); return Array.isArray(j.nameservers) ? j.nameservers : []; },
  useXdomainNs: (cfg) => xdNs(cfg, "PUT", { nameservers: XDOMAIN_NS }),
  probe: (cfg) => xdList(cfg),
  // 同じ名前にある、自分の物ではない A / AAAA / CNAME（初期設定の駐車ページ等）。ツールで確認してから消す
  async others(cfg, ip) {
    const host = xdHost(cfg);
    return (await xdList(cfg)).filter((r) => xsHost(cfg, r.host) === host && ["A", "AAAA", "CNAME"].includes(up(r.type))
      && !(up(r.type) === "A" && ((cfg.aId != null && String(r.id) === String(cfg.aId)) || String(r.content).trim() === ip)));
  },
  async removeRecords(cfg, recs) { for (const r of recs) await xd(cfg, "DELETE", "/dns/" + r.id); },
  async setA(cfg, ip) {
    const host = xdHost(cfg);
    const same = (await xdList(cfg)).filter((r) => xsHost(cfg, r.host) === host);
    const blocker = same.find((r) => ["CNAME", "AAAA"].includes(up(r.type)));
    if (blocker) throw foreignErr(cfg, blocker);
    const aRecs = same.filter((r) => up(r.type) === "A");
    const mine = aRecs.filter((r) => (cfg.aId != null && String(r.id) === String(cfg.aId)) || String(r.content).trim() === ip);
    const foreign = aRecs.find((r) => !mine.includes(r));
    if (foreign) throw foreignErr(cfg, foreign);
    if (!mine.length) {
      const j = await xd(cfg, "POST", "/dns", { type: "A", host, content: ip, ttl: 300 });
      cfg.aId = j.id;
      return;
    }
    const keep = mine.find((r) => cfg.aId != null && String(r.id) === String(cfg.aId)) || mine[0];
    if (String(keep.content).trim() !== ip) await xd(cfg, "PUT", "/dns/" + keep.id, { type: "A", host, content: ip, ttl: 300 });
    for (const x of mine) if (x !== keep) await xd(cfg, "DELETE", "/dns/" + x.id);
    cfg.aId = keep.id;
  },
  async setTxt(cfg, value) {
    const h = xdHost(cfg);
    const host = h === "@" ? "_acme-challenge" : "_acme-challenge." + h;
    for (const x of (await xdList(cfg)).filter((r) => up(r.type) === "TXT" && xsHost(cfg, r.host) === host)) {
      await xd(cfg, "DELETE", "/dns/" + x.id);
    }
    const j = await xd(cfg, "POST", "/dns", { type: "TXT", host, content: value, ttl: 60 });
    return j.id;
  },
  async clearTxt(cfg, id) { if (id != null) await xd(cfg, "DELETE", "/dns/" + id); },
  // 反映確認は XServerドメインの権威DNSに直接聞く（公開DNSが切替前の古いNSを覚えていても影響されない）
  nsHosts: async () => XDOMAIN_NS.slice(),
  settleMs: 65000,
};

const PROVIDERS = { duckdns, xserver, xdomain };
function providerOf(cfg) { return PROVIDERS[(cfg && cfg.provider) || "duckdns"] || duckdns; }

// ── 権威DNSに TXT が載ったか確認してから検証を依頼する ──
//   各権威DNSサーバーへ直接問い合わせ、全サーバーに載るまで待つ（載る前に検証すると
//   「無い」という結果が最長1時間キャッシュされて失敗が続くため）。
async function waitTxt(name, value, nsHosts, maxMs, log) {
  const pub = publicResolver();
  const ips = [];
  for (const h of nsHosts) {
    try { ips.push(...(await pub.resolve4(h))); } catch (e) { /* 取れた分だけ使う */ }
  }
  if (!ips.length) throw new Error("権威DNSサーバーが見つかりません（" + nsHosts.join(", ") + "）");
  const deadline = Date.now() + maxMs;
  let lastLog = 0;
  while (Date.now() < deadline) {
    let missing = 0, ok = 0;
    for (const ip of ips) {
      const r = new dnsp.Resolver({ timeout: 3000, tries: 1 });
      r.setServers([ip]);
      try {
        const recs = await r.resolveTxt(name);
        if (recs.some((x) => x.join("") === value)) ok++; else missing++;
      } catch (e) {
        if (e.code === "ENODATA" || e.code === "ENOTFOUND") missing++; // まだ載っていない（応答なしは数えない）
      }
    }
    if (ok > 0 && missing === 0) return true;
    if (log && Date.now() - lastLog > 60000) { log(`DNSへの反映待ち…（${ok}/${ok + missing} 台に反映）`); lastLog = Date.now(); }
    await sleep(5000);
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
      // この中の例外は呼び出し元の try/catch に届かないため、必ずここで reject に変える
      try {
        if (err) throw new Error("CSRの作成に失敗: " + String(se || err.message).trim());
        resolve(fs.readFileSync(out));
      } catch (e) {
        reject(e);
      } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* 一時ファイルは残っても害なし */ }
      }
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
    let r;
    try { r = await fetch(this.dirUrl); } catch (e) { throw netError("Let's Encrypt", e); }
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
//   cfg はメモリ上のもの（setA が cfg.aId を書き込む）。acme.json への保存は呼び出し側が行う。
async function issue(cfg, opts) {
  const o = opts || {};
  const log = o.log || (() => {});
  if (!cfg || !cfg.domain || !cfg.token) throw new Error("設定（ドメイン・トークン）がありません");
  if (!cfg.agreed) throw new Error("Let's Encrypt の利用規約に同意していません");
  const release = acquireLock();
  try {
    const dnsSvc = providerOf(cfg);
    // 先に DNS を更新（トークン違い等はここで止まり、Let's Encrypt には何も送らない）
    const ip = cfg.lanIp || lanIP();
    log(`DNS 設定（${dnsSvc.name}）: ${cfg.domain} → ${ip}`);
    await dnsSvc.setA(cfg, ip);

    const acme = new Acme(o.staging ? DIRS.staging : DIRS.prod, loadOrCreateAccountKey(o.staging));
    await acme.init();
    await acme.account(false);

    const order = await acme.post(acme.dir.newOrder, { identifiers: [{ type: "dns", value: cfg.domain }] });
    const orderUrl = order.location;
    let ord = order.body;
    const txtHandles = [];
    try {
      for (const authzUrl of ord.authorizations) {
        const az = (await acme.post(authzUrl, "")).body;
        if (az.status === "valid") continue;
        const ch = (az.challenges || []).find((c) => c.type === "dns-01");
        if (!ch) throw new Error("DNS-01 検証が使えません");
        const txt = b64u(crypto.createHash("sha256").update(ch.token + "." + acme.thumbprint).digest());
        log("ドメインの確認用レコードを設定…");
        txtHandles.push(await dnsSvc.setTxt(cfg, txt));
        const nsHosts = await dnsSvc.nsHosts(cfg);
        // 全権威DNSに載るまで待つ（最大30分）。載らないまま検証を頼むと失敗が1時間続くので、ここで中止する
        if (!(await waitTxt("_acme-challenge." + cfg.domain, txt, nsHosts, 30 * 60000, log))) {
          throw new Error("DNSへの反映が30分たっても確認できませんでした。時間をおいて再実行してください");
        }
        await sleep(dnsSvc.settleMs);
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
    } finally {
      // 確認用レコードは検証が済んだら（失敗しても）消す
      for (const h of txtHandles) { try { await dnsSvc.clearTxt(cfg, h); } catch (e) { /* 次回の実行時にも掃除される */ } }
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
    const expires = certExpiry(f.cert);
    log(`証明書を取得しました（有効期限 ${expires ? expires.toLocaleDateString("ja-JP") : "?"}）`);
    return { ok: true, expires, files: f };
  } finally {
    release();
  }
}

// ── サーバーから定期的に呼ぶ：既存の証明書を期限30日前に自動更新 ──
//   初回の取得はツールだけが行う（証明書が無ければ何もしない）。
//   失敗したら6時間あけて再試行（再起動をまたいでも renew-state.json で覚えておく）。
async function renewIfNeeded(log) {
  const cfg = readCfg();
  if (!cfg || !cfg.agreed || !cfg.domain || !cfg.token) return { skipped: "未設定" };
  const info = certInfo(leFiles(false).cert, cfg.domain);
  if (!info) return { skipped: "証明書なし（初回はツールで取得）" };
  const st = readState();
  if (info.matches && info.expires.getTime() - Date.now() > RENEW_BEFORE_DAYS * 86400000) {
    if (st.lastError) writeState({ ...st, lastError: null }); // ツール等で取り直し済み → 警告を消す
    return { skipped: "期限内", expires: info.expires };
  }
  if (st.lastError && st.lastAttempt && Date.now() - st.lastAttempt < RETRY_AFTER_FAIL_MS) {
    return { skipped: "前回失敗のため待機中", lastError: st.lastError };
  }
  writeState({ ...st, lastAttempt: Date.now() });
  try {
    const r = await issue(cfg, { log });
    writeCfg(cfg); // aId 等の更新を保存
    writeState({ lastAttempt: Date.now(), lastSuccess: Date.now(), lastError: null });
    return r;
  } catch (e) {
    writeState({ ...readState(), lastAttempt: Date.now(), lastError: e.message });
    throw e;
  }
}

module.exports = {
  DATA_DIR, TLS_DIR, CFG_PATH, DIRS,
  readCfg, writeCfg, readState, writeState, leFiles, certInfo, certExpiry, lanIP, lanIPs, duckSub, checkHostName,
  PROVIDERS, XDOMAIN_NS, providerOf, publicResolver, delegationNs, waitTxt, issue, renewIfNeeded, makeCsr, Acme,
};
