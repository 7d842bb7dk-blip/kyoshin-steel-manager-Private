// ─────────────────────────────────────────────────────────────
// domain-setup.js — ドメイン（DuckDNS）＋ Let's Encrypt 証明書の初期設定
//   「証明書を自動取得.bat」から起動。入力するのは サブドメイン名・トークン・規約への同意 の3つだけ。
//   以後の更新（90日ごと）はサーバーが自動で行う。
// ─────────────────────────────────────────────────────────────
"use strict";
const readline = require("node:readline/promises");
const dnsp = require("node:dns").promises;
const acme = require("../server/acme");

const PORT = parseInt(process.env.PORT || "3001", 10);
const log = (m) => console.log("  " + m);

(async () => {
  console.log("");
  console.log("==============================================================");
  console.log("  鋼材在庫システム：証明書の自動取得（各端末の設定が不要になります）");
  console.log("==============================================================");
  console.log("  事前準備：https://www.duckdns.org でログインし、サブドメインを1つ作成");
  console.log("  （その画面の上部に表示される token をコピーしておく）");
  console.log("");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let sub = (await rl.question("1) DuckDNS のサブドメイン名（例: kyoshin-zaiko）: ")).trim().toLowerCase();
  sub = acme.duckSub(sub.replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
  if (!/^[a-z0-9][a-z0-9-]*$/.test(sub)) throw new Error("サブドメイン名は英小文字・数字・ハイフンで入力してください");

  const token = (await rl.question("2) DuckDNS の token: ")).trim();
  if (!/^[0-9a-f-]{36}$/i.test(token)) throw new Error("token の形式が違います（xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx）");

  const detected = acme.lanIP() || "192.168.1.107";
  const ipIn = (await rl.question(`3) このサーバーPCのIPアドレス [Enterで ${detected}]: `)).trim() || detected;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ipIn)) throw new Error("IPアドレスの形式が違います");

  const dir = await new acme.Acme(acme.DIRS.prod, require("node:crypto").generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey).init();
  console.log("");
  console.log("  証明書は Let's Encrypt（無料・世界共通の認証局）から取得します。");
  console.log("  利用規約（Subscriber Agreement）: " + ((dir.meta && dir.meta.termsOfService) || "https://letsencrypt.org/repository/"));
  const ag = (await rl.question("4) 利用規約に同意して取得しますか？ (y/n): ")).trim().toLowerCase();
  rl.close();
  if (ag !== "y") { console.log("\n  中止しました（何も変更していません）"); return; }

  const cfg = { domain: `${sub}.duckdns.org`, token, lanIp: ipIn, agreed: true, agreedAt: new Date().toISOString() };

  console.log("\n[1/4] DuckDNS の設定を確認…");
  await acme.setARecord(cfg, cfg.lanIp);
  acme.writeCfg(cfg);
  log(`${cfg.domain} → ${cfg.lanIp}`);

  console.log("\n[2/4] 予行演習（テスト用の認証局で手順を確認）…");
  await acme.issue(cfg, { staging: true, log });

  console.log("\n[3/4] 本番の証明書を取得…");
  const r = await acme.issue(cfg, { log });

  console.log("\n[4/4] サーバーに反映…");
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/tls-reload`, { method: "POST" });
    const j = await res.json();
    log(j.ok ? `反映しました：${j.base}` : "反映できませんでした。サーバーを再起動してください");
  } catch (e) {
    log("サーバーが動いていません。起動すると自動で使われます");
  }

  // 社内のDNSで正しく引けるか（ルーターの設定によっては社内IPへの名前解決が止められることがある）
  try {
    const a = await dnsp.lookup(cfg.domain, { family: 4 });
    if (a.address === cfg.lanIp) log(`名前解決OK：${cfg.domain} → ${a.address}`);
    else log(`⚠ 名前解決の結果が ${a.address} でした（${cfg.lanIp} のはず）。数分後に再確認してください`);
  } catch (e) {
    log("⚠ このPCから名前解決できませんでした。数分待ってもダメならルーターの『DNSリバインディング保護』を確認");
  }

  console.log("");
  console.log("==============================================================");
  console.log(`  完了！ 新しいアドレス： https://${cfg.domain}/`);
  console.log(`  証明書の期限 ${r.expires ? r.expires.toLocaleDateString("ja-JP") : "?"}（期限の30日前にサーバーが自動更新）`);
  console.log("  スマホ・PCとも設定は不要です。旧アドレスは自動でここへ転送されます。");
  console.log("==============================================================");
})().catch((e) => {
  console.error("\n  エラー: " + e.message);
  console.error("  （入力を確認してもう一度実行してください。何度やってもダメなら画面をそのまま連絡）");
  process.exitCode = 1;
});
