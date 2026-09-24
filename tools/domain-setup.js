// ─────────────────────────────────────────────────────────────
// domain-setup.js — 正式な証明書（Let's Encrypt）の初期設定
//   「証明書を自動取得.bat」から起動。以後の更新（期限30日前）はサーバーが自動で行う。
//   ① 会社のドメイン（エックスサーバー）… zaiko.f-kyo-shin.co.jp など
//   ② 自分で取ったドメイン（XServerドメイン）… kyoshin-zaiko.com など。在庫システム専用のドメインに限る
//      （ネームサーバーを XServerドメイン用に切り替えるため、使用中のドメインは入れないこと）
//   ③ DuckDNS … ○○.duckdns.org（社内ファイアウォールの許可が必要）
//   設定（acme.json）は「本番の証明書が取れた後」にだけ保存する。途中で失敗・中断しても
//   サーバーの動作は何も変わらない。
// ─────────────────────────────────────────────────────────────
"use strict";
const readline = require("node:readline");
const crypto = require("node:crypto");
const dnsp = require("node:dns").promises;
const acme = require("../server/acme");

const PORT = parseInt(process.env.PORT || "3001", 10);
const DEFAULT_DOMAIN = "zaiko.f-kyo-shin.co.jp";
const COMPANY_ZONE = DEFAULT_DOMAIN.split(".").slice(1).join("."); // 会社のホームページ・メールのドメイン
const log = (m) => console.log("  " + m);
let rl = null;
let nsSwitched = false; // ネームサーバーを切り替えた後か（エラー時の案内を変える）

// 入力は行ごとに貯めておき、質問のたびに1行ずつ取り出す（通信中に打たれた入力も取りこぼさない）
function makeAsker() {
  const r = readline.createInterface({ input: process.stdin });
  const queue = [], waiters = [];
  let closed = false;
  r.on("line", (l) => { if (waiters.length) waiters.shift()(l); else queue.push(l); });
  r.on("close", () => { closed = true; while (waiters.length) waiters.shift()(null); });
  const ask = async (q) => {
    process.stdout.write(q);
    let l;
    if (queue.length) l = queue.shift();
    else if (closed) l = null;
    else l = await new Promise((res) => waiters.push(res));
    if (l === null) throw new Error("入力が終わりました（中止）");
    if (!process.stdin.isTTY) process.stdout.write(l + "\n");
    return l;
  };
  return { ask, close: () => r.close() };
}

// 公開DNSで NS を引き、ドメインの管理元（ゾーン）を見つける
async function findZone(fqdn) {
  const r = acme.publicResolver();
  const labels = fqdn.split(".");
  for (let i = 1; i <= labels.length - 2; i++) { // 自分自身より上の階層から探す
    const name = labels.slice(i).join(".");
    try {
      const ns = await r.resolveNs(name);
      if (ns.length) return { zone: name, ns, isXserver: ns.some((n) => /xserver\.jp\.?$/i.test(n)) };
    } catch (e) { /* この階層にはNSが無い */ }
  }
  return null;
}

// エックスサーバー：APIキーから、会社ドメインが入っているサーバーを自動で見つける
async function detectServer(token, zone) {
  let servers = [];
  try { servers = (await acme.PROVIDERS.xserver.servers(token)).filter((s) => !s.status || s.status === "active"); }
  catch (e) { return { servers: [], hits: [] }; } // キーの権限でサーバー一覧が見られない → 手入力にまかせる
  const hits = [];
  for (const s of servers) {
    try {
      await acme.PROVIDERS.xserver.probe({ zone, servername: s.servername, token, domain: zone });
      hits.push(s.servername);
    } catch (e) { /* このサーバーには無い */ }
  }
  return { servers, hits };
}

const isXdNs = (ns) => Array.isArray(ns) && ns.length > 0 && ns.every((n) => /\.xdomain\.ne\.jp\.?$/i.test(n));

// ドメインの登録先ネームサーバーが XServerドメイン用になるまで待つ。
//   .com 等の上位の管理サーバーに直接確認（公開DNSは古い値を数時間覚えていることがあるため）。
//   直接聞けないときだけ公開DNS（8.8.8.8 と 1.1.1.1 を別々に）で確認する。
async function waitPublicNs(zone, maxMs, justSwitched) {
  const deadline = Date.now() + maxMs;
  let last = 0, fails = 0;
  if (justSwitched) await new Promise((r) => setTimeout(r, Math.min(30000, maxMs))); // 登録の反映を少し待ってから聞く
  for (;;) {
    let ns = await acme.delegationNs(zone);
    if (ns === null) {
      for (const ip of ["8.8.8.8", "1.1.1.1"]) {
        const r = new dnsp.Resolver({ timeout: 4000, tries: 1 });
        r.setServers([ip]);
        try {
          const x = await r.resolveNs(zone);
          if (isXdNs(x)) { ns = x; break; }
          if (ns === null) ns = x;
        } catch (e) {
          if (["ENOTFOUND", "ENODATA", "ESERVFAIL"].includes(e.code) && ns === null) ns = []; // 応答はある（まだ引けないだけ）
        }
      }
    }
    if (isXdNs(ns)) return true;
    fails = ns === null ? fails + 1 : 0;
    if (fails >= 4) throw new Error("ネームサーバーの反映を確認できません（DNSへの問い合わせが通りません。ネットワークを確認してから、もう一度実行してください）");
    if (Date.now() >= deadline) return false;
    if (Date.now() - last > 60000) {
      log(`ネームサーバーの反映待ち…（今の登録先：${ns && ns.length ? ns.join(", ") : "確認中"}。通常は数分〜1時間。このまま待っていてください）`);
      last = Date.now();
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
}

(async () => {
  console.log("");
  console.log("==============================================================");
  console.log("  鋼材在庫システム：正式な証明書の自動取得");
  console.log("  （これが済むと、全部のスマホ・PCで「保護されていません」が出なくなります）");
  console.log("==============================================================");
  console.log("");
  rl = makeAsker();

  console.log("  1 = 会社のドメイン（エックスサーバー。zaiko.f-kyo-shin.co.jp など）");
  console.log("  2 = 自分で取ったドメイン（XServerドメイン。例: kyoshin-zaiko.com）");
  console.log("  3 = DuckDNS（社内ファイアウォールの許可が必要）");
  const kind = (await rl.ask("どれで設定しますか？ [Enterで1]: ")).trim() || "1";
  let cfg;
  let nsSwitch = false, removeOthers = [];

  if (kind === "1") {
    const reach = await acme.PROVIDERS.xserver.reachable();
    if (!reach.ok) throw new Error(reach.message);

    let domain = (await rl.ask(`1) 使うアドレス [Enterで ${DEFAULT_DOMAIN}]: `)).trim().toLowerCase() || DEFAULT_DOMAIN;
    domain = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) throw new Error("アドレスの形式が違います（例: zaiko.f-kyo-shin.co.jp）");
    const z = await findZone(domain);
    if (!z) throw new Error("そのドメインが見つかりません");
    if (!z.isXserver) throw new Error(`${z.zone} はエックスサーバー以外で管理されています（${z.ns.join(", ")}）`);
    const host = domain.slice(0, -(z.zone.length + 1));
    const badName = acme.checkHostName(host);
    if (badName) throw new Error(badName + `（アドレスは「名前.${z.zone}」の形で）`);
    log(`ドメイン ${z.zone} の中に「${host}」を作ります（ホームページ・メールには影響しません）`);

    const token = (await rl.ask("2) エックスサーバーのAPIキー: ")).trim();
    if (token.length < 20) throw new Error("APIキーが短すぎます（コピーし直してください）");

    // APIキーの有効期限（期限付きだと、その日に自動更新が止まる）
    try {
      const me = await acme.PROVIDERS.xserver.me(token);
      if (me && me.expires_at) log(`⚠ このAPIキーは ${me.expires_at} に期限切れになります。それまでに新しいキーでこのツールを再実行してください`);
      else log("APIキー：OK（無期限）");
    } catch (e) {
      if (e.status === 401) throw new Error("APIキーが違います（コピーし直してください）");
      log("（APIキーの期限は確認できませんでした。続けます）");
    }

    // サーバーの自動検出（見つからない・複数ある場合だけ聞く）
    const { servers, hits } = await detectServer(token, z.zone);
    let servername = hits.length === 1 ? hits[0] : null;
    if (servername) log(`サーバー：${servername}（自動で見つけました）`);
    else {
      if (servers.length) log("このAPIキーで見えるサーバー：" + servers.map((s) => s.servername).join(", "));
      servername = (await rl.ask("3) サーバーID（初期ドメイン。例: xs123456 または xs123456.xsrv.jp）: ")).trim().toLowerCase();
      if (/^xs\d+$/.test(servername)) servername += ".xsrv.jp";
      if (!/^[a-z0-9-]+\.[a-z0-9.-]+$/.test(servername)) throw new Error("サーバーIDの形式が違います");
    }

    cfg = { provider: "xserver", domain, zone: z.zone, host, servername, token };
    // 前回このツールが作ったAレコードのIDを引き継ぐ（サーバーPCのIPが変わった時に、自分の設定として更新できるように）
    const prev = acme.readCfg();
    if (prev && prev.provider === "xserver" && prev.zone === cfg.zone && prev.host === cfg.host
      && prev.servername === cfg.servername && prev.aId != null) cfg.aId = prev.aId;
    const recs = await acme.PROVIDERS.xserver.probe(cfg); // 一覧が正しく読めるか（読めなければここで中止）
    log(`DNS設定の確認：OK（${z.zone} の設定 ${recs.length} 件を読み取り）`);
  } else if (kind === "2") {
    const xdv = acme.PROVIDERS.xdomain;
    const reach = await xdv.reachable();
    if (!reach.ok) throw new Error(reach.message);
    let zone = (await rl.ask("1) 取ったドメイン名（例: kyoshin-zaiko.com）: ")).trim().toLowerCase();
    zone = zone.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "").replace(/^www\./, "");
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(zone)) throw new Error("ドメイン名の形式が違います（例: kyoshin-zaiko.com）");
    if (zone === COMPANY_ZONE || zone.endsWith("." + COMPANY_ZONE)) {
      throw new Error(`${COMPANY_ZONE} は会社のホームページ・メールのドメインなので 2 では使えません（会社のドメインで設定するなら 1 を選んでください）`);
    }
    const hostIn = (await rl.ask(`2) 使うアドレス [Enterで https://${zone}/ ／ 例えば zaiko と入れると https://zaiko.${zone}/]: `)).trim().toLowerCase();
    let host = hostIn.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
    if (host === "" || host === "@" || host === zone) host = "@";
    else if (host.endsWith("." + zone)) host = host.slice(0, -(zone.length + 1));
    if (host !== "@" && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) throw new Error("名前は英数字1語にしてください（例: zaiko）");
    const domain = host === "@" ? zone : host + "." + zone;

    const token = (await rl.ask("3) XServerドメインのAPIキー: ")).trim();
    if (token.length < 20) throw new Error("APIキーが短すぎます（コピーし直してください）");
    let me = null;
    try {
      me = await xdv.me(token);
      if (me && me.expires_at) log(`⚠ このAPIキーは ${me.expires_at} に期限切れになります。それまでに新しいキーでこのツールを再実行してください`);
      else log("APIキー：OK（無期限）");
    } catch (e) {
      if (e.status === 401) throw new Error("APIキーが違います（コピーし直してください）");
      log("（APIキーの期限は確認できませんでした。続けます）");
    }
    const perm = xdv.permProblem(me, zone); // 権限不足は、質問に全部答える前にここで止める
    if (perm) throw new Error(perm);
    let doms = null;
    try { doms = await xdv.domains(token); } catch (e) { /* 権限で一覧が見られない場合は、下のDNS確認で判断 */ }
    if (doms) {
      const d = doms.find((x) => String(x.domain_name).toLowerCase() === zone);
      if (!d) throw new Error(`このAPIキーでは ${zone} が見えません（APIキーの対象ドメイン・ドメイン名を確認）`);
      if (d.status === "pending_create") throw new Error("ドメインの取得手続きがまだ処理中です。完了してからもう一度実行してください");
      if (d.status && d.status !== "active") throw new Error(`ドメインの状態が「${d.status}」のため使えません`);
    }
    cfg = { provider: "xdomain", domain, zone, host, token };
    const prev = acme.readCfg();
    if (prev && prev.provider === "xdomain" && prev.zone === cfg.zone && prev.host === cfg.host && prev.aId != null) cfg.aId = prev.aId;
    const recs = await xdv.probe(cfg); // DNSの一覧が読めるか（読めなければここで中止）
    log(`DNS設定の確認：OK（${zone} の設定 ${recs.length} 件を読み取り）`);
    // ネームサーバー（XServerドメインの ns1〜3.xdomain.ne.jp でないと、設定したDNSが反映されない）
    const ns = await xdv.nameservers(cfg);
    if (!isXdNs(ns)) {
      log(`今のネームサーバー：${ns.join(", ") || "（なし）"}`);
      // 使用中のドメインの取り違え防止（切り替えると、そのドメインのホームページ・メールが止まる）
      const pub = acme.publicResolver();
      let mx = [];
      try { mx = (await pub.resolveMx(zone)).map((m) => m.exchange).filter(Boolean); } catch (e) { /* メール設定なし */ }
      if (mx.length) {
        throw new Error(`${zone} はメールで使われています（${mx.join(", ")}）。切り替えるとメールが止まるため中止しました（何も変更していません）。在庫システム用に新しく取ったドメインを入力してください`);
      }
      const web = [];
      for (const n of [zone, "www." + zone]) {
        try { for (const ip of await pub.resolve4(n)) web.push(`${n} → ${ip}`); } catch (e) { /* なし */ }
      }
      if (web.length) {
        log("⚠ このドメインは今、次の場所を指しています（ホームページ等で使っている場合は、切り替えると止まります）:");
        for (const w of web) log("   " + w);
      }
      log("ネームサーバーを XServerドメイン用（ns1〜3.xdomain.ne.jp）に切り替えます。");
      const typed = (await rl.ask(`在庫システム用に新しく取ったドメインで間違いなければ、確認のためドメイン名（${zone}）をそのまま入力: `))
        .trim().toLowerCase().replace(/\.$/, "");
      if (typed !== zone) throw new Error("ドメイン名が一致しないため中止しました（何も変更していません）");
      nsSwitch = true;
    }
  } else if (kind === "3") {
    const reach = await acme.PROVIDERS.duckdns.reachable();
    if (!reach.ok) throw new Error(reach.message);
    let sub = (await rl.ask("1) DuckDNS のサブドメイン名（例: kyoshin-zaiko）: ")).trim().toLowerCase();
    sub = acme.duckSub(sub.replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
    if (!/^[a-z0-9][a-z0-9-]*$/.test(sub)) throw new Error("サブドメイン名は英小文字・数字・ハイフンで入力してください");
    const token = (await rl.ask("2) DuckDNS の token: ")).trim();
    if (!/^[0-9a-f-]{36}$/i.test(token)) throw new Error("token の形式が違います（xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx）");
    cfg = { provider: "duckdns", domain: `${sub}.duckdns.org`, token };
  } else {
    throw new Error("1〜3 を入力してください");
  }

  const detected = acme.lanIP() || "192.168.1.107";
  const ipIn = (await rl.ask(`このサーバーPCのIPアドレス [Enterで ${detected}]: `)).trim() || detected;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ipIn)) throw new Error("IPアドレスの形式が違います");
  cfg.lanIp = ipIn;
  if (cfg.provider === "xdomain") {
    // 同じ名前にある初期設定（案内ページ等）の確認。消すのは利用規約に同意した後
    removeOthers = await acme.PROVIDERS.xdomain.others(cfg, cfg.lanIp);
    if (removeOthers.length) {
      log(`${cfg.domain} には今、次の設定があります（ドメイン取得時の初期設定など）:`);
      for (const r of removeOthers) log(`   ${String(r.type).toUpperCase()}  ${r.content}`);
      const yn = (await rl.ask("在庫システム専用のドメインなので、これを消して置き換えますか？ (y/n): ")).trim().toLowerCase();
      if (yn !== "y") throw new Error("中止しました（何も変更していません）");
    }
  }

  const dir = await new acme.Acme(acme.DIRS.prod, crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey).init();
  console.log("");
  console.log("  証明書は Let's Encrypt（無料・世界共通の認証局）から取得します。");
  console.log("  利用規約（Subscriber Agreement）: " + ((dir.meta && dir.meta.termsOfService) || "https://letsencrypt.org/repository/"));
  const ag = (await rl.ask("利用規約に同意して取得しますか？ (y/n): ")).trim().toLowerCase();
  rl.close();
  if (ag !== "y") { console.log("\n  中止しました（何も変更していません）"); return; }
  cfg.agreed = true;
  cfg.agreedAt = new Date().toISOString();

  const svc = acme.providerOf(cfg);
  console.log(`\n[1/4] DNS に ${cfg.domain} → ${cfg.lanIp} を設定…`);
  if (cfg.provider === "xdomain") {
    if (nsSwitch) {
      nsSwitched = true;
      await acme.PROVIDERS.xdomain.useXdomainNs(cfg);
      log("ネームサーバーを XServerドメイン用に切り替えました");
    }
    if (!(await waitPublicNs(cfg.zone, parseInt(process.env.NS_WAIT_MAX_MS || String(60 * 60000), 10), nsSwitch))) {
      throw new Error("ネームサーバーの切り替えがまだ反映されていません。1〜数時間後にもう一度このツールを実行してください（次回も反映を確認してから進みます。最大60分）");
    }
    // 待っている間に初期設定が変わっていないか（切替時に案内ページ等が追加されることがある）→ 変わっていたら確認し直し
    const nowOthers = await acme.PROVIDERS.xdomain.others(cfg, cfg.lanIp);
    const key = (r) => `${r.id}|${String(r.type).toUpperCase()}|${r.content}`;
    const confirmed = new Set(removeOthers.map(key));
    if (nowOthers.length !== removeOthers.length || nowOthers.some((r) => !confirmed.has(key(r)))) {
      throw new Error("待っている間にDNSの初期設定が変わったため、ここで止めました。もう一度このツールを実行してください（新しい内容で確認が出ます）");
    }
    if (nowOthers.length) { await acme.PROVIDERS.xdomain.removeRecords(cfg, nowOthers); log("初期設定を削除しました"); }
  }
  await svc.setA(cfg, cfg.lanIp);
  log("OK");

  // 同じ名前の有効な証明書がもうあれば取り直さない（Let's Encrypt の発行枚数制限の対策）
  const existing = acme.certInfo(acme.leFiles(false).cert, cfg.domain);
  let expires;
  if (existing && existing.matches && existing.expires.getTime() - Date.now() > 30 * 86400000) {
    console.log("\n[2/4][3/4] 有効な証明書がすでにあるので、取得は省略します");
    expires = existing.expires;
  } else {
    console.log("\n[2/4] 予行演習（テスト用の認証局で手順を確認。数分〜十数分かかります）…");
    await acme.issue(cfg, { staging: true, log });
    console.log("\n[3/4] 本番の証明書を取得…");
    expires = (await acme.issue(cfg, { log })).expires;
  }
  acme.writeCfg(cfg); // ここで初めて保存（以後、サーバーが自動更新する）
  acme.writeState({ lastAttempt: Date.now(), lastSuccess: Date.now(), lastError: null }); // 管理者向けの警告を消す

  console.log("\n[4/4] サーバーに反映…");
  let ready = false;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/tls-reload`, { method: "POST" });
    const j = await res.json();
    ready = !!j.ready;
    log(j.ok ? "証明書を読み込みました" : "読み込めませんでした。サーバーを再起動してください");
  } catch (e) {
    log("サーバーが動いていません。起動すると自動で使われます");
  }
  if (!ready) {
    // 社内の名前解決がまだ古い値（ホームページのサーバー）を返している間は、サーバーは今までのアドレスで動き続ける
    let now = "?";
    try { now = (await dnsp.lookup(cfg.domain, { family: 4 })).address; } catch (e) { /* */ }
    log(`名前の切り替わり待ちです（社内では今 ${cfg.domain} → ${now}）。`);
    log("最長1時間ほどでサーバーが自動的に新しいアドレスに切り替えます。それまでは今までどおり使えます。");
  }

  console.log("");
  console.log("==============================================================");
  console.log(`  完了！ 新しいアドレス： https://${cfg.domain}/`);
  console.log(`  証明書の期限 ${expires ? expires.toLocaleDateString("ja-JP") : "?"}（期限の30日前にサーバーが自動更新）`);
  console.log("  スマホ・PCとも設定は不要です。旧アドレスは自動でここへ転送されます。");
  console.log("==============================================================");
})().catch((e) => {
  if (rl) rl.close();
  console.error("\n  エラー: " + e.message);
  if (nsSwitched) {
    console.error("  （ネームサーバーは XServerドメイン用に切り替え済みです。在庫システムは今までどおり使えます。");
    console.error("    時間をおいてもう一度このツールを実行すると続きから進みます。ダメなら画面をそのまま連絡）");
  } else {
    console.error("  （在庫システムは今までどおり使えます。内容を確認してもう一度実行してください。ダメなら画面をそのまま連絡）");
  }
  process.exitCode = 1;
});
