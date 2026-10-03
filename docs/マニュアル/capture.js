// ─────────────────────────────────────────────────────────────
// 使い方マニュアルのスクリーンショットを、本物の画面から自動で撮るスクリプト（2026-10-03）
//   1) 本番DBのコピーでテスト用サーバーを 3095 番で起動する（本番には触らない）
//        例：git worktree で別フォルダを作り、server/data/app.db にコピーを置いて
//            PORT=3095 HOST=127.0.0.1 HTTPS_PORT=3495 HTTP80=0 AUTO_UPDATE_SEC=0 node server/index.js
//   2) node capture-demo.js   … 見本の予約・材料をテスト用サーバーに入れる
//   3) node capture.js shots  … shots/ に撮影（rects.json に部品の位置も出る）
//   4) python crops.py        … 拡大図（shots/crop/）を作り直す → HTML を Edge で PDF にする
// ─────────────────────────────────────────────────────────────
// マニュアル用スクリーンショットを、本物の画面から自動で撮る（Edge ヘッドレス＋DevTools プロトコル）
//   node mancap.js <出力フォルダ>
//   テスト用サーバー http://127.0.0.1:3095/（本番のコピー）を開いて、画面を操作してから撮る。
//   各ショットについて、指定した部品の位置（2倍の画素）も rects.json に書き出す（拡大図の切り抜き用）
const { spawn } = require("child_process");
const fs = require("fs"), path = require("path");
const OUT = path.resolve(process.argv[2] || "manshots");
fs.mkdirSync(OUT, { recursive: true });
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9333, APP = "http://127.0.0.1:3095/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (n) => { const d = new Date(Date.now() + n * 86400000), p = (x) => String(x).padStart(2, "0"); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); };

const PREP = `
  STAFF=["山田 太郎","佐藤 次郎","鈴木 三郎"];
  try{localStorage.setItem(PERSON_KEY,"山田 太郎");}catch(e){}
  window.__set=(id,v)=>{const s=document.querySelector(id);if(s.tagName==="SELECT"&&![...s.options].some(o=>o.value===String(v))){const o=document.createElement("option");o.value=v;o.textContent=v;s.appendChild(o);}s.disabled=false;s.value=v;s.dispatchEvent(new Event("change"));s.dispatchEvent(new Event("input"));};
  window.__rect=(sel,pad)=>{const e=document.querySelector(sel);if(!e)return null;const r=e.getBoundingClientRect();pad=pad||0;return [Math.round((r.left-pad)*devicePixelRatio),Math.round((r.top-pad)*devicePixelRatio),Math.round((r.width+pad*2)*devicePixelRatio),Math.round((r.height+pad*2)*devicePixelRatio)];};
  true`;
const MOBILE = { width: 375, height: 812, deviceScaleFactor: 2, mobile: true };
const DESK = { width: 1280, height: 760, deviceScaleFactor: 1.5, mobile: false };

const SHOTS = [
  { name: "shot-checkout", vp: MOBILE, js: `
      document.querySelector('.tab[data-view="checkout"]').click();
      __set("#co_mat","SUS304"); await new Promise(r=>setTimeout(r,150));
      __set("#co_koshu","角パイプ"); await new Promise(r=>setTimeout(r,150));
      __set("#co_spec","50×50"); await new Promise(r=>setTimeout(r,150));
      __set("#co_thk","2"); await new Promise(r=>setTimeout(r,250));
      document.scrollingElement.scrollTop=0;
      ({filter:__rect("#view-checkout .panel",0), card:__rect("#coList .co-card",0), ns:__rect("#btnNewStock",4)})` },
  { name: "shot-co", vp: MOBILE, js: `
      openCo(272); await new Promise(r=>setTimeout(r,200));
      document.querySelector("#coModePart").click(); await new Promise(r=>setTimeout(r,150));
      __set("#coUsed","1500"); coUpdateRemain(); document.activeElement&&document.activeElement.blur();
      ({part:__rect("#coPart",6)})` },
  { name: "shot-co-rsv", vp: MOBILE, js: `
      openCo(453); await new Promise(r=>setTimeout(r,250));
      ({item:__rect("#coItem",4), warn:__rect("#coRsv",4), foot:__rect("#coOverlay .modal-foot",0)})` },
  { name: "shot-ns", vp: MOBILE, js: `
      openNs(); await new Promise(r=>setTimeout(r,250));
      __set("#ns_mat","SUS304"); await new Promise(r=>setTimeout(r,150));
      __set("#ns_koshu","角パイプ"); await new Promise(r=>setTimeout(r,150));
      __set("#ns_thk","2"); await new Promise(r=>setTimeout(r,150));
      __set("#ns_spec","50×50"); await new Promise(r=>setTimeout(r,150));
      __set("#ns_fin","#400"); __set("#ns_len","1500"); document.activeElement&&document.activeElement.blur();
      ({})` },
  { name: "shot-locpick", vp: MOBILE, js: `
      pickLoc({mat:"SS400",koshu:"フラットバー",thk:9,spec:"9×50",len:1200,fin:""}); await new Promise(r=>setTimeout(r,250));
      ({modal:__rect("#locPickOverlay .modal",0), sug:__rect("#locPickSugWrap",4)})` },
  { name: "shot-rsv", vp: MOBILE, js: `
      openRsv(456); await new Promise(r=>setTimeout(r,250));
      __set("#rsvDate","${day(6)}"); __set("#rsvJob","〇〇工場 手すり"); document.activeElement&&document.activeElement.blur();
      ({modal:__rect("#rsvOverlay .modal",0)})` },
  { name: "shot-rsvcard", vp: MOBILE, js: `
      document.querySelector('.tab[data-view="checkout"]').click();
      __set("#co_mat","SUS304"); await new Promise(r=>setTimeout(r,150));
      __set("#co_koshu","角パイプ"); await new Promise(r=>setTimeout(r,150));
      __set("#co_spec","50×50"); await new Promise(r=>setTimeout(r,150));
      __set("#co_thk","2"); await new Promise(r=>setTimeout(r,250));
      const card=document.querySelector('#coList [data-rsv="453"]').closest('.co-card'); card.id="__rcard"; card.scrollIntoView({block:"center"}); await new Promise(r=>setTimeout(r,200));
      ({card:__rect("#__rcard",4)})` },
  { name: "shot-rsvlist", vp: DESK, js: `
      document.querySelector('.tab[data-view="reserve"]').click(); await new Promise(r=>setTimeout(r,250));
      document.scrollingElement.scrollTop=0;
      ({tab:__rect('.tab[data-view="reserve"]',6), list:__rect("#view-reserve .panel",0)})` },
  { name: "shot-inv", vp: DESK, js: `
      isAdmin=true; applyAdmin(); document.querySelector('.tab[data-view="inventory"]').click(); await new Promise(r=>setTimeout(r,300));
      __set("#invFilter","sus304 角パイプ 50×50"); invFilter="sus304 角パイプ 50×50"; renderInventory(); await new Promise(r=>setTimeout(r,200));
      invSel=new Set([...document.querySelectorAll("#invTable [data-sel]")].slice(0,3).map(c=>+c.dataset.sel)); renderInventory(); await new Promise(r=>setTimeout(r,150));
      document.scrollingElement.scrollTop=0;
      ({panel:__rect("#view-inventory .panel",0), tools:__rect("#view-inventory .panel-h",0), bar:__rect(".inv-tools",0)})` },
  { name: "shot-wledit", vp: DESK, js: `
      isAdmin=true; applyAdmin(); document.querySelector('.tab[data-view="worklog"]').click(); await new Promise(r=>setTimeout(r,900));
      const x=history.find(e=>e.type==="checkout"&&!e.undone_at&&e.record_id!=null)||history.find(e=>e.type==="checkout");
      openWlEdit(x.id); await new Promise(r=>setTimeout(r,250)); document.querySelector("#we_person").value="山田 太郎"; document.querySelector("#we_note").value="名前の打ち間違いを修正"; document.activeElement&&document.activeElement.blur();
      ({modal:__rect("#wlEditOverlay .modal",0), btn:__rect("[data-wledit]",3)})` },
];

(async () => {
  const prof = path.join(OUT, "_edgeprof");
  const edge = spawn(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--remote-debugging-port=" + PORT, "--user-data-dir=" + prof, "about:blank"], { stdio: "ignore" });
  let ver = null;
  for (let i = 0; i < 50 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch (e) { await sleep(200); } }
  if (!ver) throw new Error("Edge DevTools に接続できません");
  const tgt = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.j(new Error(JSON.stringify(d.error))) : p.r(d.result); } };
  const send = (method, params) => new Promise((r, j) => { const i = ++id; pend.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const evalJs = async (expr) => {
    const res = await send("Runtime.evaluate", { expression: `(async()=>{ ${expr.includes("return") ? expr : "return (" + expr.trim().replace(/;?\s*$/, "") + ")"} })()`, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails.exception && res.exceptionDetails.exception.description || res.exceptionDetails.text));
    return res.result.value;
  };
  await send("Page.enable"); await send("Runtime.enable");
  const rects = {};
  for (const s of SHOTS) {
    await send("Emulation.setDeviceMetricsOverride", s.vp);
    await send("Emulation.setUserAgentOverride", { userAgent: s.vp.mobile ? "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36" : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0" });
    await send("Page.navigate", { url: APP });
    await sleep(2500);
    await evalJs(`(()=>{${PREP}})()`);
    await evalJs(`document.head.insertAdjacentHTML("beforeend","<style>*{animation:none!important;transition:none!important}#toast,.undo-bar{display:none!important}</style>")`);
    // 本体の処理（最後の式の値を返す）
    const body = s.js.trim();
    const lastSemi = body.lastIndexOf("({");
    const code = body.slice(0, lastSemi) + "return " + body.slice(lastSemi);
    rects[s.name] = await evalJs(code);
    await sleep(400);
    const shot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, s.name + ".png"), Buffer.from(shot.data, "base64"));
    console.log("撮影:", s.name, JSON.stringify(rects[s.name]));
  }
  fs.writeFileSync(path.join(OUT, "rects.json"), JSON.stringify(rects, null, 1));
  ws.close(); edge.kill();
})().catch((e) => { console.log("ERR", e.message); process.exit(1); });
