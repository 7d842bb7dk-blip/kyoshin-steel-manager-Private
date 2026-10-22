// ─────────────────────────────────────────────────────────────
// 「鋼材の置き場所ルール表」（イラスト付き・印刷用）を、アプリの棚割り表 LOC_GUIDE から作る（2026-10-22）
//   node make-locrules.js          … 置き場所ルール表.html を作り直す
//   → Edge で PDF にする（使い方マニュアルと同じ手順）
// アプリの置き場所の判定（js/app.js の LOC_GUIDE・suggestLoc）と同じ中身になるので、
// 棚割りを変えたら、このスクリプトを実行し直すこと。
// ─────────────────────────────────────────────────────────────
const fs = require("fs"), path = require("path"), vm = require("vm");
const HERE = __dirname;
const SRC = fs.readFileSync(path.join(HERE, "..", "..", "js", "app.js"), "utf8");

// app.js から ANG_HOT・LOC_GUIDE・SHAPE_SVG だけを取り出して読む
function grab(name, open, close) {
  const i = SRC.indexOf("const " + name + "=");
  if (i < 0) throw new Error(name + " が見つかりません");
  let depth = 0, j = SRC.indexOf(open, i);
  for (let k = j; k < SRC.length; k++) {
    if (SRC[k] === open) depth++;
    else if (SRC[k] === close && --depth === 0) return SRC.slice(i, k + 1) + ";";
  }
  throw new Error(name + " の終わりが見つかりません");
}
const ctx = {};
vm.createContext(ctx);
vm.runInContext(grab("ANG_HOT", "[", "]") + grab("LOC_GUIDE", "[", "]") + grab("SHAPE_SVG", "{", "}") +
  "this.LOC_GUIDE=LOC_GUIDE;this.SHAPE_SVG=SHAPE_SVG;", ctx);
const { LOC_GUIDE, SHAPE_SVG } = ctx;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const n = (v) => Number(v).toLocaleString("ja-JP");

// 仕上げの色
const FIN = {
  "未研": ["#eef0f3", "#4b5563"], "#400": ["#e3eefb", "#1f5fa8"], "HL": ["#efe8fb", "#6b4fab"],
  "HOT": ["#fdeadf", "#b4501b"], "COLD": ["#e0f4f2", "#14776c"], "BA": ["#f3f0dc", "#76692a"],
};
const finChip = (f) => { const c = FIN[f] || ["#eef0f3", "#4b5563"]; return `<span class="fin" style="background:${c[0]};color:${c[1]}">${esc(f)}</span>`; };
const finCell = (g) => g.fin ? g.fin.map(finChip).join("") : `<span class="fin any">仕上げ問わず</span>`;

// 寸法の表示（丸物は Φ、角物は ×）
const ROUND = new Set(["maru", "kesho", "sani"]);
const FN_DESC = { "A-2": "不等辺、または 60×60 以上の等辺", "A-5": "30×30 以下の等辺" };
function sizeCell(g) {
  if (!g.sizes) return `<span class="any-size">寸法は問わない</span>`;
  if (typeof g.sizes === "function") return `<span class="cond">${esc(FN_DESC[g.loc] || "条件あり")}</span>`;
  return g.sizes.map((s) => `<span class="sz">${ROUND.has(g.cat) ? "Φ" + esc(s) : esc(String(s).replace(/\*/g, "×"))}</span>`).join("");
}

// 長さのバー（0〜6.5m の目盛り。はみ出す分は右端に矢印）
const SCALE = 6500;
function lenCell(g) {
  if (g.min <= 1 && g.max >= 99999) return `<div class="len"><div class="bar"><div class="fill all" style="left:0;width:100%"></div>${ticks()}</div><div class="lt">長さは問わない</div></div>`;
  const l = Math.min(g.min, SCALE) / SCALE * 100, r = Math.min(g.max, SCALE) / SCALE * 100;
  const w = Math.max(r - l, 1.2);
  const over = g.max > SCALE ? `<span class="over">▶</span>` : "";
  const txt = g.min === g.max ? `${n(g.min)} mm` : `${n(g.min)} 〜 ${n(g.max)} mm`;
  return `<div class="len"><div class="bar"><div class="fill" style="left:${l.toFixed(2)}%;width:${w.toFixed(2)}%"></div>${ticks()}${over}</div><div class="lt">${txt}</div></div>`;
}
function ticks() { let h = ""; for (let m = 1; m <= 6; m++) h += `<i style="left:${(m * 1000 / SCALE * 100).toFixed(2)}%"></i>`; return h; }
const scaleHead = () => { let h = ""; for (let m = 0; m <= 6; m++) h += `<b style="left:${(m * 1000 / SCALE * 100).toFixed(2)}%">${m}m</b>`; return `<div class="scale">${h}</div>`; };

const shelfColor = (loc) => ({ A: "#c0566f", B: "#3a6fb0", C: "#d08322", D: "#b0568f", E: "#1f8a6d", F: "#2f8fb0", G: "#6b5fc0", H: "#5a7d8c" }[loc[0]] || "#15171c");
const row = (g) => `<div class="row"><div class="shelf" style="background:${shelfColor(g.loc)}">${esc(g.loc)}</div><div class="fins">${finCell(g)}</div><div class="sizes">${sizeCell(g)}</div>${lenCell(g)}</div>`;
const byLen = (a, b) => a.min - b.min || a.max - b.max || a.loc.localeCompare(b.loc);

// アルミの見出しアイコン（鋼種を問わないので「Al」の札）
const AL_ICO = '<svg viewBox="0 0 24 24"><rect x="2.5" y="4" width="19" height="16" rx="3.5" fill="#c06a16"/><text x="12" y="16.3" text-anchor="middle" font-size="10" font-weight="800" fill="#fff" font-family="Segoe UI,Arial,sans-serif">Al</text></svg>';
// 鋼種ごとのまとまり
const pick = (f) => LOC_GUIDE.filter(f).sort(byLen);
const SECTIONS = [
  { title: "アングル", vi: "Thép góc (V)", shape: "アングル", sub: [
    { t: "短め（E棚）", rows: pick((g) => g.cat === "angle" && g.loc[0] === "E") },
    { t: "長め（A棚）", rows: pick((g) => g.cat === "angle" && g.loc[0] !== "E") }] },
  { title: "角パイプ", vi: "Ống vuông / chữ nhật", shape: "角パイプ", sub: [
    { t: "未研", rows: pick((g) => g.cat === "kaku" && g.fin && g.fin[0] === "未研") },
    { t: "#400", rows: pick((g) => g.cat === "kaku" && g.fin && g.fin[0] === "#400") },
    { t: "HL", rows: pick((g) => g.cat === "kaku" && g.fin && g.fin[0] === "HL") }] },
  { title: "丸パイプ（TP-S・TP-A）", vi: "Ống tròn", shape: "丸パイプ(TP-S)", sub: [
    { t: "", rows: pick((g) => g.cat === "maru") }] },
  { title: "化粧管・BA管", vi: "Ống trang trí / ống BA", shape: "化粧管", sub: [
    { t: "#400・BA", rows: pick((g) => g.cat === "kesho" && g.fin && g.fin[0] !== "HL") },
    { t: "HL", rows: pick((g) => g.cat === "kesho" && g.fin && g.fin[0] === "HL") }] },
  { title: "サニタリーパイプ", vi: "Ống vi sinh", shape: "サニタリーパイプ", note: "チタン管は長さにかかわらず C-3", sub: [
    { t: "", rows: pick((g) => g.cat === "sani") }] },
  { title: "チャンネル", vi: "Thép chữ U", shape: "チャンネル", sub: [
    { t: "", rows: pick((g) => g.cat === "chan") }] },
  { title: "アルミ（A6063）", vi: "Nhôm A6063", icon: AL_ICO, note: "アングル・角パイプ・丸パイプなど、鋼種は問わない", sub: [
    { t: "", rows: pick((g) => g.cat === "alumi") }] },
];
// 表に入れ忘れが無いか（チタンは注記で扱う）
const used = new Set(SECTIONS.flatMap((s) => s.sub.flatMap((u) => u.rows)));
const left = LOC_GUIDE.filter((g) => !used.has(g) && g.cat !== "ti");
if (left.length) throw new Error("表に入っていない棚があります: " + left.map((g) => g.loc + "/" + g.cat).join(", "));

const sectionHtml = (s) => {
  let h = `<section class="sec"><div class="sec-h"><span class="ico">${s.icon || SHAPE_SVG[s.shape] || ""}</span><span class="st">${esc(s.title)}</span><span class="vi sv">${esc(s.vi)}</span>${s.note ? `<span class="sn">※ ${esc(s.note)}</span>` : ""}</div>`;
  h += `<div class="thead"><div>棚</div><div>仕上げ</div><div>寸法（規格）</div><div class="lh">長さ${scaleHead()}</div></div>`;
  for (const u of s.sub) {
    if (!u.rows.length) continue;
    if (u.t) h += `<div class="subh">${esc(u.t)}</div>`;
    h += u.rows.map(row).join("");
  }
  return h + `</section>`;
};

const STEP = (no, t, d, ico) => `<div class="step"><div class="sno">${no}</div><div class="sico">${ico}</div><div class="stt">${t}</div><div class="std">${d}</div></div>`;
const ICO = {
  mat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3 3 7.5 12 12l9-4.5z"/><path d="M3 12.5 12 17l9-4.5"/></svg>',
  fin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 15l3-3 3 3 4-5"/></svg>',
  len: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 8h18v8H3z"/><path d="M7 8v3M11 8v4M15 8v3M19 8v4"/></svg>',
  stay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>',
};
const today = (() => { const d = new Date(); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; })();

const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>鋼材の置き場所ルール表</title>
<!-- このファイルは make-locrules.js で自動作成（js/app.js の LOC_GUIDE から）。直接編集しないこと -->
<style>
  :root{--red:#df1f26;--ink:#15171c;--soft:#5d6675;--line:#d7dce3;--bg:#f5f7f9}
  @page{size:A4;margin:9mm 10mm}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:"Yu Gothic UI","Meiryo","Segoe UI",sans-serif;color:var(--ink);font-size:9pt;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .vi{font-family:"Segoe UI",Arial,"Yu Gothic UI",Meiryo,sans-serif}
  .band{background:var(--ink);border-top:3mm solid var(--red);color:#fff;padding:4.5mm 6mm 4mm;border-radius:0 0 3mm 3mm;display:flex;align-items:flex-end;justify-content:space-between}
  .band h1{font-size:18pt;font-weight:800;letter-spacing:.04em}
  .band .bvi{font-size:9pt;color:#c4cbd6;margin-top:1mm}
  .band .bd{font-size:8pt;color:#c4cbd6;text-align:right;line-height:1.6}
  .steps{display:flex;gap:2.5mm;margin:4mm 0 3mm}
  .step{flex:1;border:0.4mm solid var(--line);border-radius:3mm;padding:2.5mm 3mm;position:relative;background:#fff}
  .step+.step::before{content:"▶";position:absolute;left:-2.6mm;top:42%;color:var(--red);font-size:7pt}
  .sno{position:absolute;top:2.2mm;right:2.6mm;width:5.5mm;height:5.5mm;border-radius:50%;background:var(--red);color:#fff;font-weight:800;font-size:8.5pt;display:flex;align-items:center;justify-content:center}
  .sico{width:7mm;height:7mm;color:var(--red)}
  .sico svg{width:100%;height:100%}
  .stt{font-weight:800;font-size:9.5pt;margin-top:1mm}
  .std{font-size:7.6pt;color:var(--soft);line-height:1.5;margin-top:.8mm}
  .info{display:flex;gap:3mm;margin-bottom:4mm}
  .legend,.norule{border-radius:3mm;padding:2.5mm 3.5mm;font-size:8pt;line-height:1.7}
  .legend{flex:0 0 80mm;background:var(--bg);border:0.4mm solid var(--line)}
  .legend b,.norule b{font-size:8.6pt}
  .norule{flex:1;background:#fff6e3;border:0.4mm solid #f2d59b;color:#5b3a00}
  .sec{margin-bottom:4mm}
  .sec-h{display:flex;align-items:center;gap:2.5mm;border-bottom:0.7mm solid var(--ink);padding-bottom:1.2mm;margin-bottom:1mm;break-after:avoid}
  .sec-h .ico{width:8mm;height:8mm;flex:0 0 auto}
  .sec-h .ico svg{width:100%;height:100%;display:block}
  .st{font-size:13pt;font-weight:800}
  .sv{font-size:8pt;color:var(--soft)}
  .sn{margin-left:auto;font-size:8pt;color:var(--soft)}
  .thead,.row{display:grid;grid-template-columns:15mm 27mm 1fr 66mm;gap:2.5mm;align-items:center}
  .thead{font-size:7.5pt;font-weight:700;color:var(--soft);padding:1mm 0 .5mm;break-after:avoid}
  .lh{position:relative}
  .scale{position:relative;height:3.2mm;margin-top:.5mm}
  .scale b{position:absolute;top:0;transform:translateX(-50%);font-size:6.5pt;font-weight:600;color:var(--soft)}
  .scale b:first-child{transform:none}
  .subh{font-size:8.5pt;font-weight:800;color:var(--red);margin:1.6mm 0 .6mm;padding-left:1.5mm;border-left:1mm solid var(--red);break-after:avoid}
  .row{padding:1.1mm 0;border-bottom:0.25mm solid #e7eaef;break-inside:avoid}
  .shelf{color:#fff;font-weight:800;font-size:10.5pt;border-radius:2mm;text-align:center;padding:.9mm 0;font-family:Consolas,"Yu Gothic UI",monospace;letter-spacing:.02em}
  .fins{display:flex;flex-wrap:wrap;gap:.8mm}
  .fin{display:inline-block;font-size:7.6pt;font-weight:800;border-radius:1.5mm;padding:.3mm 1.6mm}
  .fin.any{background:#f1f3f6;color:var(--soft);font-weight:700}
  .sizes{display:flex;flex-wrap:wrap;gap:.8mm;line-height:1.3}
  .sz{font-size:7.8pt;font-family:Consolas,"Yu Gothic UI",monospace;background:#f4f6f8;border:0.2mm solid #e1e5ea;border-radius:1.2mm;padding:.1mm 1.2mm}
  .any-size,.cond{font-size:8pt;font-weight:700;color:var(--soft)}
  .cond{color:#8a3a00}
  .len .bar{position:relative;height:3.4mm;background:#eef1f4;border-radius:1.7mm;overflow:hidden}
  .len .fill{position:absolute;top:0;bottom:0;background:var(--red);border-radius:1.7mm;opacity:.85}
  .len .fill.all{background:repeating-linear-gradient(45deg,#f4a6a9 0 1.5mm,#fbd5d6 1.5mm 3mm)}
  .len .bar i{position:absolute;top:0;bottom:0;width:0.2mm;background:rgba(21,23,28,.18)}
  .len .over{position:absolute;right:.5mm;top:50%;transform:translateY(-50%);font-size:6pt;color:#fff}
  .len .lt{font-size:7.4pt;color:var(--soft);margin-top:.4mm;font-family:Consolas,"Yu Gothic UI",monospace}
  .foot{margin-top:3mm;font-size:7.5pt;color:var(--soft);line-height:1.6;border-top:0.3mm solid var(--line);padding-top:2mm}
</style></head><body>
<div class="band"><div><h1>鋼材の置き場所ルール表</h1><div class="vi bvi">Bảng quy định vị trí cất vật liệu (theo loại thép)</div></div>
<div class="bd">アプリが「この材料の置き場所」を決めるときの表<br>${today} 時点</div></div>

<div class="steps">
${STEP(1, "材質と鋼種で決まる", "SUS（ステンレス）とアルミに棚の決まりがあります。下の表の鋼種ごとに見る", ICO.mat)}
${STEP(2, "仕上げ・寸法が合う棚", "仕上げ（未研・#400・HL…）と寸法が合う棚だけが候補。片#400・両#400 は #400 の棚", ICO.fin)}
${STEP(3, "長さが入る棚", "長さが範囲に入る棚。いくつかあれば<b>同じ鋼種が多いアルファベットの棚</b>（同じ鋼種を同じ列に固める）。どこにも入らなければ範囲が一番近い棚", ICO.len)}
${STEP(4, "今の棚が合えばそのまま", "今の棚が条件に合っていれば動かさない（直す必要なし）", ICO.stay)}
</div>

<div class="info">
  <div class="legend"><b>表の見かた</b><br>
  仕上げ：<span class="fin" style="background:${FIN["未研"][0]};color:${FIN["未研"][1]}">未研</span>
  <span class="fin" style="background:${FIN["#400"][0]};color:${FIN["#400"][1]}">#400</span>
  <span class="fin" style="background:${FIN.HL[0]};color:${FIN.HL[1]}">HL</span>
  <span class="fin" style="background:${FIN.HOT[0]};color:${FIN.HOT[1]}">HOT</span>
  <span class="fin" style="background:${FIN.COLD[0]};color:${FIN.COLD[1]}">COLD</span>
  <span class="fin" style="background:${FIN.BA[0]};color:${FIN.BA[1]}">BA</span><br>
  赤いバー ＝ その棚に置く<b>長さの範囲</b>（目盛りは1mごと）<br>
  同じ鋼種の中は、<b>短いものから順</b>に並んでいます</div>
  <div class="norule"><b>⚠ ルールが無い材料</b>（登録するとき「置き場所を選ぶ」画面が出ます）<br>
  ・<b>SS400（鉄）は全部</b>　・SUS のフラットバー　・仕上げが空欄のアングル<br>
  ・SUS の丸パイプ HL・#400（Φ16 だけは C-3）　・SUS の角パイプ HOT<br>
  ・この表に無い寸法の組み合わせ<br>
  → 同じ材料がある棚が「おすすめ」に出ます。わからなければ<b>「武田・航に確認」</b></div>
</div>

${SECTIONS.map(sectionHtml).join("\n")}

<div class="foot">この表は、アプリの棚割り表（js/app.js の LOC_GUIDE・棚割りPDFから作成）から自動で作っています。棚割りを変えたら <b>docs/マニュアル/make-locrules.js</b> を実行して作り直してください。<br>
E-12・B-1 は仕上げや鋼種が混ざった棚です（表の該当する行に出ています）。</div>
</body></html>
`;
fs.writeFileSync(path.join(HERE, "置き場所ルール表.html"), html);
console.log("作成: 置き場所ルール表.html（棚の行 " + used.size + " 件）");
