/* =====================================================================
 *  鋼材管理システム  —  app.js
 *  ---------------------------------------------------------------------
 *  ■ よく編集する箇所（マスタ・設定）：このファイル冒頭付近にまとまっています
 *      MATERIALS            材質の一覧
 *      KOSHU_BY_MAT         材質ごとの鋼種（形状）一覧
 *      KIKAKU_BY_KOSHU      鋼種ごとの材料規格（寸法）候補
 *      FINISH_BY_MAT_KOSHU  材質×鋼種ごとの表面仕上げ候補
 *      FINISH_ALL           表面仕上げの全候補
 *      THICKNESS            板厚の候補
 *      LOCATIONS            保管場所の一覧
 *      DENSITY              材質別の比重
 *      SUS_PRICED / PRICE   キロ単価マスタ（単価ルール）
 *      FORMULA_DESC         断面積計算式の表示用説明
 *      SEED                 初期データ（在庫サンプル10件）
 *      ADMIN_PIN            管理者モードのパスコード
 *  ■ 計算ロジック：sectionArea() → weightKg() → unitPrice() → compute()
 *      ※計算式の詳細は docs/CALCULATION.md を参照
 *  ■ ファイル構成・編集方法は README.md を参照
 * ===================================================================== */

/* ===================== マスタデータ（Excel由来） ===================== */
const MATERIALS=["SS400","SUS304","SUS316L","SUS310S","A6063"]; /* アルミ系はすべて A6063 に統一（2026-09-23） */
const KOSHU_BY_MAT={
  "SS400":["角パイプ","丸パイプ(TP-S)","丸パイプ(TP-A)","チャンネル","アングル","フラットバー"],
  "SUS304":["角パイプ","丸パイプ(TP-S)","丸パイプ(TP-A)","サニタリーパイプ","化粧管","BA管","チャンネル","アングル","フラットバー"],
  "SUS316L":["角パイプ","丸パイプ(TP-S)","丸パイプ(TP-A)","サニタリーパイプ","化粧管","BA管","チャンネル","アングル","フラットバー"],
  "SUS310S":["角パイプ","丸パイプ(TP-S)","丸パイプ(TP-A)","サニタリーパイプ","チャンネル","アングル","フラットバー"],
  "A6063":["角パイプ","丸パイプ(TP-S)","丸パイプ(TP-A)","サニタリーパイプ","化粧管","BA管","チャンネル","アングル","フラットバー","丸棒","角棒"]
};
const KIKAKU_BY_KOSHU={
  "角パイプ":["50*50","75*40","60*60","100*50","125*50"],
  "丸パイプ(TP-S)":["Φ27.2","Φ34","Φ48.6","Φ38.1"],
  "丸パイプ(TP-A)":["Φ21.7","Φ48.6","Φ38.1","Φ34"],
  "サニタリーパイプ":["Φ27.2","Φ48.6","Φ38.1","Φ34"],
  "チャンネル":["80*40","100*50"],
  "アングル":["40*40","50*50"],
  "フラットバー":["30","50","60","65"]
};
const FINISH_BY_MAT_KOSHU={
  "SS400|フラットバー":["ミガキ","黒皮"],
  "SUS304|角パイプ":["HL","#400","未研","HOT"],"SUS304|丸パイプ(TP-S)":["HL","#400","未研"],"SUS304|丸パイプ(TP-A)":["HL","#400","未研"],"SUS304|サニタリーパイプ":["#400","未研"],"SUS304|チャンネル":["HL","#400","HOT"],"SUS304|アングル":["HL","#400","HOT","COLD"],"SUS304|フラットバー":["HL","#400","HOT","COLD"],
  "SUS316L|角パイプ":["HL","#400","未研","HOT"],"SUS316L|丸パイプ(TP-S)":["HL","#400","未研"],"SUS316L|丸パイプ(TP-A)":["HL","#400","未研"],"SUS316L|サニタリーパイプ":["#400","未研"],"SUS316L|チャンネル":["HL","#400","HOT"],"SUS316L|アングル":["HL","#400","HOT","COLD"],"SUS316L|フラットバー":["HL","#400","HOT","COLD"],
  "SUS310S|角パイプ":["HL","#400","未研","HOT"],"SUS310S|丸パイプ(TP-S)":["HL","#400","未研"],"SUS310S|丸パイプ(TP-A)":["HL","#400","未研"],"SUS310S|サニタリーパイプ":["#400","未研"],"SUS310S|チャンネル":["HL","#400","HOT"],"SUS310S|アングル":["HL","#400","HOT","COLD"],"SUS310S|フラットバー":["HL","#400","HOT","COLD"]
};
const FINISH_ALL=["HL","#400","未研","ミガキ","HOT","COLD","黒皮","BA"]; /* サニタリーは仕上げではなく鋼種（サニタリーパイプ）で扱う */
const THICKNESS=[1,1.2,1.5,1.6,2,2.1,2.3,3,3.2,4,4.5,5,6];
const LOCATIONS=["本社レーザー前","第二工場","第三工場","本社材料倉庫"]; /* 在庫が空のときの初期候補。在庫があれば実データから動的生成（locOptions） */
let DENSITY={"SUS304":7.93,"SUS316L":7.98,"SUS430":7.7,"SS400":7.85,"SGP":7.85,"STKM":7.85,"A5052":2.68,"A6063":2.7,"チタン":4.51};

/* キロ単価マスタ（合算ルール対応：同一キーが複数行ある場合は合計） */
let PRICE=[];
[["角パイプ",[null]],["丸パイプ(TP-S)",[null]],["丸パイプ(TP-A)",[null]],["チャンネル",[null]],["アングル",[null]],["フラットバー",["ミガキ","黒皮"]]]
  .forEach(([k,fins])=>fins.forEach(f=>PRICE.push({mat:"SS400",koshu:k,fin:f,price:250})));
["角パイプ","丸パイプ(TP-S)","丸パイプ(TP-A)","サニタリーパイプ","チャンネル","アングル"]
  .forEach(k=>PRICE.push({mat:"A6063",koshu:k,fin:null,price:800}));
const SUS_PRICED={
  "SUS304":{"角パイプ":["HL","#400","未研","HOT"],"丸パイプ(TP-S)":["HL","#400","未研"],"丸パイプ(TP-A)":["HL","#400","未研"],"サニタリーパイプ":["#400","未研"],"チャンネル":["HL","#400","HOT"],"アングル":["HL","#400","HOT","COLD"],"フラットバー":["HL","#400","HOT","COLD"]},
  "SUS316L":{"角パイプ":["#400","未研","HOT"],"丸パイプ(TP-S)":["HL","#400","未研"],"丸パイプ(TP-A)":["HL","#400","未研"],"サニタリーパイプ":["#400","未研"],"チャンネル":["HL","#400","HOT"],"アングル":["HL","#400","HOT","COLD"],"フラットバー":["HL","#400","HOT","COLD"]},
  "SUS310S":{"角パイプ":["HL","#400","未研","HOT"],"丸パイプ(TP-S)":["HL","#400","未研"],"丸パイプ(TP-A)":["HL","#400"],"サニタリーパイプ":["#400","未研"],"チャンネル":["HL","#400","HOT"],"アングル":["HL","#400","HOT","COLD"],"フラットバー":["HL","#400","HOT","COLD"]}
};
Object.entries(SUS_PRICED).forEach(([mat,o])=>Object.entries(o).forEach(([k,fins])=>fins.forEach(f=>PRICE.push({mat,koshu:k,fin:f,price:800}))));

/* 断面積の式（7種類・中身は固定＝Excel再現）と、鋼種→式の割り当て。
 * 「どの鋼種にどの式を使うか」は管理者モードのマスタ設定から変更できる */
const AREA_FORMULAS={
  round:{label:"丸管（パイプ）",view:"外径Φ・肉厚t",f:"π/4 × ( Φ² − (Φ−2t)² )",calc:(d1,d2,t)=>{const i=Math.max(d1-2*t,0);return Math.PI/4*(d1*d1-i*i);}},
  square:{label:"角パイプ",view:"外寸A×外寸B・肉厚t",f:"A×B − (A−2t)×(B−2t)",calc:(d1,d2,t)=>d1*d2-Math.max(d1-2*t,0)*Math.max(d2-2*t,0)},
  flat:{label:"フラットバー",view:"幅×厚t",f:"幅 × t",calc:(d1,d2,t)=>d1*t},
  angle:{label:"アングル",view:"辺A×辺B・厚t",f:"t × (A + B − t)",calc:(d1,d2,t)=>t*(d1+d2-t)},
  channel:{label:"チャンネル",view:"高さH×耳・厚t",f:"t × (H + 2×耳 − 2t)",calc:(d1,d2,t)=>t*(d1+2*d2-2*t)},
  solidRound:{label:"丸棒（無垢）",view:"外径Φ（無垢）",f:"π/4 × Φ²",calc:(d1)=>Math.PI/4*d1*d1},
  solidSquare:{label:"角棒（無垢）",view:"A×B（無垢）",f:"A × B",calc:(d1,d2)=>d1*(d2||d1)}
};
let KOSHU_FORMULA={
  "丸パイプ(TP-S)":"round","丸パイプ(TP-A)":"round","サニタリーパイプ":"round","化粧管":"round","BA管":"round","丸パイプ":"round",
  "角パイプ":"square","フラットバー":"flat","アングル":"angle","チャンネル":"channel","丸棒":"solidRound","角棒":"solidSquare"
};
function formulaDesc(koshu){return AREA_FORMULAS[KOSHU_FORMULA[koshu]]||null;}

/* ── マスタ設定（管理者が画面から編集可能。保存先＝サーバーDB／単体版は localStorage） ── */
let STAFF=[]; /* 名簿（持ち出し・鍵で名前を選択肢から選ぶための一覧。マスタ設定で編集） */
const DEFAULT_MASTERS={density:{...DENSITY},price:PRICE.map(p=>({...p})),koshuFormula:{...KOSHU_FORMULA},staff:[]};
function applyMasters(m){
  const src=(m&&typeof m==="object")?m:DEFAULT_MASTERS;
  DENSITY={...(src.density&&Object.keys(src.density).length?src.density:DEFAULT_MASTERS.density)};
  PRICE=((src.price&&src.price.length?src.price:DEFAULT_MASTERS.price))
    .map(p=>({mat:String(p.mat||""),koshu:String(p.koshu||""),fin:(p.fin===""||p.fin==null)?null:String(p.fin),price:Number(p.price)||0}));
  KOSHU_FORMULA={...(src.koshuFormula&&Object.keys(src.koshuFormula).length?src.koshuFormula:DEFAULT_MASTERS.koshuFormula)};
  STAFF=Array.isArray(src.staff)?src.staff.map(s=>String(s).trim()).filter(Boolean):[];
}

/* ===================== 計算エンジン（Excel数式と同一） ===================== */
function normSpec(s){return String(s==null?"":s).replace(/[Φφ]/g,"").replace(/[×Xx]/g,"*").trim();}
function dims(spec){const n=normSpec(spec),p=n.split("*");const d1=parseFloat(p[0]);const d2=p.length>1?parseFloat(p[1]):NaN;return{d1:isFinite(d1)?d1:0,d2:isFinite(d2)?d2:0};}
function density(mat){return DENSITY[mat]!=null?DENSITY[mat]:(String(mat).startsWith("SUS")?7.93:7.85);}
function sectionArea(mat,koshu,thk,spec){
  const{d1,d2}=dims(spec);const t=parseFloat(thk)||0;
  const fm=AREA_FORMULAS[KOSHU_FORMULA[koshu]];
  return fm?fm.calc(d1,d2,t):null;
}
function round(v,d){const f=Math.pow(10,d);return Math.round((v+Number.EPSILON)*f)/f;}
function weightKg(mat,koshu,thk,spec,len){const a=sectionArea(mat,koshu,thk,spec);if(a==null||!isFinite(a))return null;const L=parseFloat(len)||0;return round(a*L*density(mat)/1e6,3);}
function unitPrice(mat,koshu,fin){
  let rows;
  if(mat==="SS400"||mat==="A6063")rows=PRICE.filter(p=>p.mat===mat&&p.koshu===koshu);
  else{
    rows=PRICE.filter(p=>p.mat===mat&&p.koshu===koshu&&p.fin===fin);
    /* 仕上げ完全一致の行が無いときだけ「仕上げ不問(null)」行で代用。
     * 既存マスタにSUS系のnull行は無いため、従来の挙動（完全一致・合算）は変わらない。
     * CIPS発注実績から作る平均単価行（fin=null）を新しい組み合わせに使うための追加（2026-09） */
    if(!rows.length)rows=PRICE.filter(p=>p.mat===mat&&p.koshu===koshu&&p.fin==null);
  }
  if(!rows.length)return null;
  return rows.reduce((s,p)=>s+p.price,0);
}
function compute(r){
  const area=sectionArea(r.mat,r.koshu,r.thk,r.spec);
  const w=weightKg(r.mat,r.koshu,r.thk,r.spec,r.len);
  const u=unitPrice(r.mat,r.koshu,r.fin);
  const cost=(w!=null&&u!=null)?round(w*u,0):null;
  return{area:area!=null&&isFinite(area)?area:null,weight:w,unit:u,cost};
}

/* ===================== 状態・永続化 ===================== */
const SEED=[
  {mat:"SUS304",koshu:"角パイプ",thk:1.5,spec:"50*50",len:2438,loc:"本社レーザー前",fin:"HL"},
  {mat:"SS400",koshu:"角パイプ",thk:3.2,spec:"75*40",len:3000,loc:"第二工場",fin:"黒皮"},
  {mat:"A6063",koshu:"丸パイプ(TP-S)",thk:2,spec:"Φ48.6",len:2000,loc:"本社材料倉庫",fin:"#400"},
  {mat:"SUS316L",koshu:"丸パイプ(TP-A)",thk:2,spec:"Φ21.7",len:1000,loc:"本社レーザー前",fin:"未研"},
  {mat:"SUS304",koshu:"丸パイプ(TP-S)",thk:1.5,spec:"Φ34",len:5000,loc:"本社材料倉庫",fin:"未研"},
  {mat:"SUS304",koshu:"フラットバー",thk:1.5,spec:"50",len:6000,loc:"本社材料倉庫",fin:"HOT"},
  {mat:"SS400",koshu:"アングル",thk:6,spec:"40*40",len:1000,loc:"本社レーザー前",fin:"HL"},
  {mat:"SUS304",koshu:"丸パイプ(TP-S)",thk:1.2,spec:"Φ27.2",len:1500,loc:"本社レーザー前",fin:"#400"},
  {mat:"SS400",koshu:"フラットバー",thk:6,spec:"30",len:2000,loc:"第二工場",fin:"ミガキ"},
  {mat:"SUS304",koshu:"チャンネル",thk:5,spec:"100*50",len:5000,loc:"本社レーザー前",fin:"HOT"}
];
const LS_KEY="steel_mgr_records_v1";
let canPersist=true, records=[], editId=null;

/* --- サーバー共有 / ローカル の二重モード ---
 *  server : このページをサーバー(:3001)が配信。在庫は /api/* 経由で全PC共有。
 *  local  : file:// で開いた単体版(dist)や API 不達時。従来どおり localStorage に保存。 */
let MODE="local";   // "server" | "local"
let version=0;      // server: meta.version（差分ポーリング用）
let pollTimer=null;
let qrBase="";      // QRラベルに埋めるサーバーURL（/api/health の base。LAN側IPで返る）
let httpsBase="";   // かざすだけスキャン用のHTTPS URL（/api/health の httpsBase。無効時は空）
let bootId=0;       // サーバーの起動時刻。変わったら（自動更新で再起動したら）ページを再読み込み

/* サーバーが再起動していたら true を返しつつページを再読み込み（GitHub自動反映の波及）
 * ただしモーダル入力中は保留し、閉じた後のポーリングで再読み込みする */
function checkBoot(s){
  if(s&&s.boot){
    if(bootId&&s.boot!==bootId){
      if(document.querySelector(".overlay.show"))return false;
      location.reload();return true;
    }
    if(!bootId)bootId=s.boot;
  }
  return false;
}

async function apiGET(p){const r=await fetch(p,{headers:{Accept:"application/json"},cache:"no-store"});if(!r.ok)throw new Error("HTTP "+r.status);return r.json();}
async function apiSend(method,p,body){const r=await fetch(p,{method,headers:{"Content-Type":"application/json"},body:body!=null?JSON.stringify(body):undefined});let j={};try{j=await r.json();}catch(e){}if(!r.ok)throw new Error(j&&j.error?j.error:("HTTP "+r.status));return j;}
async function detectMode(){
  if(location.protocol==="file:")return "local";
  try{
    const r=await fetch("/api/health",{cache:"no-store"});
    if(r.ok){try{const j=await r.json();if(j&&j.base)qrBase=j.base;if(j&&j.httpsBase)httpsBase=j.httpsBase;}catch(e){}return "server";}
  }catch(e){}
  return "local";
}

/* マスタ設定の読込と、他PCでの変更の取り込み */
const MASTERS_KEY="steel_mgr_masters_v1";
let mastersV=0;
async function loadMasters(){
  if(MODE==="server"){
    try{const j=await apiGET("/api/masters");applyMasters(j.masters);mastersV=j.mv||0;}
    catch(e){/* 通信断時は現状のまま */}
  }else{
    try{const raw=localStorage.getItem(MASTERS_KEY);applyMasters(raw?JSON.parse(raw):null);}catch(e){}
  }
}
function syncMasters(s){
  if(MODE!=="server"||!s||s.mv===undefined||s.mv===mastersV)return;
  loadMasters().then(()=>{renderMasters();renderInventory();runSearch();renderCheckout();toast("マスタ設定が更新されました");});
}

async function loadRecords(){
  MODE=await detectMode();
  if(MODE==="server"){
    try{const s=await apiGET("/api/state");checkBoot(s);records=s.records||[];version=s.version||0;canPersist=true;return;}
    catch(e){MODE="local";}
  }
  // local（従来の localStorage 動作）
  try{const raw=localStorage.getItem(LS_KEY);if(raw){records=JSON.parse(raw);}else{records=SEED.map((r,i)=>({id:i+1,...r}));saveRecords();}}
  catch(e){canPersist=false;records=SEED.map((r,i)=>({id:i+1,...r}));}
}
function saveRecords(){if(MODE==="server")return;try{localStorage.setItem(LS_KEY,JSON.stringify(records));}catch(e){canPersist=false;}}
const nextId=()=>records.reduce((m,r)=>Math.max(m,r.id),0)+1;

// server: 最新状態を取り直して再描画（自分の変更後・ポーリング検知時）
async function refresh(){
  if(MODE!=="server")return;
  const s=await apiGET("/api/state");if(checkBoot(s))return;syncMasters(s);records=s.records||[];version=s.version||0;
  renderInventory();runSearch();updateFoot();renderCheckout();
}
// server: 約5秒ごとに他PCの変更を取り込む
function startPolling(){
  if(MODE!=="server"||pollTimer)return;
  pollTimer=setInterval(async()=>{
    try{const s=await apiGET("/api/state?since="+version);if(checkBoot(s))return;syncMasters(s);if(s&&s.unchanged)return;records=s.records||[];version=s.version||0;renderInventory();runSearch();updateFoot();renderCheckout();}
    catch(e){/* 一時的な通信断は無視（次回ポーリングで回復。再起動中もここに来る） */}
  },5000);
}

/* ===================== ユーティリティ ===================== */
const $=s=>document.querySelector(s);
const IC={
 mat:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linejoin="round"><path d="M12 3 3 7.5 12 12l9-4.5z"/><path d="M3 12.5 12 17l9-4.5"/></svg>',
 loc:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11z"/><circle cx="12" cy="10" r="2.3"/></svg>',
 fin:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l1.7 3.8L17.5 9.5l-3.8 1.7L12 15l-1.7-3.8L6.5 9.5l3.8-1.7z"/></svg>'
};
const SHAPE_SVG={
 "角パイプ":'<svg viewBox="0 0 24 24"><path fill="#3a6fb0" fill-rule="evenodd" d="M3.5 4.5h17v15h-17zM7 8v8h10V8z"/></svg>',
 "丸パイプ(TP-S)":'<svg viewBox="0 0 24 24"><path fill="#1f8a6d" fill-rule="evenodd" d="M12 3a9 9 0 100 18 9 9 0 000-18zm0 4a5 5 0 110 10 5 5 0 010-10z"/></svg>',
 "丸パイプ(TP-A)":'<svg viewBox="0 0 24 24"><path fill="#2f8fb0" fill-rule="evenodd" d="M12 3a9 9 0 100 18 9 9 0 000-18zm0 3a6 6 0 110 12 6 6 0 010-12z"/></svg>',
 "サニタリーパイプ":'<svg viewBox="0 0 24 24"><rect fill="#6b5fc0" x="10.4" y="2" width="3.2" height="3.4" rx="1"/><path fill="#6b5fc0" fill-rule="evenodd" d="M12 4.6a8 8 0 100 16 8 8 0 000-16zm0 4a4 4 0 110 8 4 4 0 010-8z"/></svg>',
 "チャンネル":'<svg viewBox="0 0 24 24"><path fill="#d08322" d="M5.5 4h12v3.6H9.6v8.8h7.9V20h-12z"/></svg>',
 "アングル":'<svg viewBox="0 0 24 24"><path fill="#c0566f" d="M5.5 4h3.7v12.4H20V20H5.5z"/></svg>',
 "フラットバー":'<svg viewBox="0 0 24 24"><rect fill="#5a7d8c" x="3" y="9.5" width="18" height="5" rx="2.4"/></svg>',
 "化粧管":'<svg viewBox="0 0 24 24"><path fill="#b0568f" fill-rule="evenodd" d="M12 3a9 9 0 100 18 9 9 0 000-18zm0 3.4a5.6 5.6 0 110 11.2 5.6 5.6 0 010-11.2z"/></svg>',
 "BA管":'<svg viewBox="0 0 24 24"><path fill="#8a7f3c" fill-rule="evenodd" d="M12 3a9 9 0 100 18 9 9 0 000-18zm0 3.7a5.3 5.3 0 110 10.6 5.3 5.3 0 010-10.6z"/></svg>',
 "丸パイプ":'<svg viewBox="0 0 24 24"><path fill="#4d7f6b" fill-rule="evenodd" d="M12 3a9 9 0 100 18 9 9 0 000-18zm0 4a5 5 0 110 10 5 5 0 010-10z"/></svg>',
 "丸棒":'<svg viewBox="0 0 24 24"><circle fill="#7a6f9c" cx="12" cy="12" r="8.5"/></svg>',
 "角棒":'<svg viewBox="0 0 24 24"><rect fill="#9c6f5a" x="4.5" y="4.5" width="15" height="15" rx="1.5"/></svg>'
};
function shapeSVG(k){return SHAPE_SVG[k]||'<svg viewBox="0 0 24 24"><rect fill="#8a93a3" x="4" y="4" width="16" height="16" rx="3"/></svg>';}
function shapeIco(k){return '<span class="shape-ic">'+shapeSVG(k)+'</span>';}
const fmtYen=n=>n==null?'<span class="muted">—</span>':'¥'+Math.round(n).toLocaleString("ja-JP");
const fmtYenP=n=>n==null?"—":"¥"+Math.round(n).toLocaleString("ja-JP");
const fmtKg=n=>n==null?'<span class="muted">—</span>':n.toLocaleString("ja-JP",{maximumFractionDigits:3});
const fmtNum=(n,d=1)=>n==null?'<span class="muted">—</span>':n.toLocaleString("ja-JP",{maximumFractionDigits:d});
function fillSelect(sel,opts,blankLabel){sel.innerHTML="";const b=document.createElement("option");b.value="";b.textContent=t(blankLabel||"指定なし");sel.appendChild(b);opts.forEach(o=>{const e=document.createElement("option");e.value=o;e.textContent=o;sel.appendChild(e);});}
function fillDatalist(dl,opts){dl.innerHTML="";opts.forEach(o=>{const e=document.createElement("option");e.value=o;dl.appendChild(e);});}
function matCls(m){return "m-"+String(m).toLowerCase().replace(/[^a-z0-9]/g,"");}
/* 保管場所の候補：在庫の実データから動的生成（在庫が空なら LOCATIONS を使用） */
function locOptions(){const s=[...new Set(records.map(r=>r.loc).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"ja"));return s.length?s:LOCATIONS;}

/* ── 選択肢の動的生成：マスタ＋在庫の実データにある文言を合算 ──
 * 新規登録・検索・持ち出しの選択肢が、実在庫に出てくる値を自動で含むようにする */
function uniqVals(arr){return [...new Set(arr.filter(v=>v!==""&&v!=null))];}
function matOptions(){return uniqVals([...MATERIALS,...records.map(r=>r.mat)]);}
function koshuOptions(mat){
  const base=(mat&&KOSHU_BY_MAT[mat])?KOSHU_BY_MAT[mat]:[];
  return uniqVals([...base,...records.filter(r=>!mat||r.mat===mat).map(r=>r.koshu)]);
}
function thkOptions(){
  return uniqVals([...THICKNESS,...records.map(r=>r.thk)]).map(Number).filter(n=>isFinite(n))
    .filter((n,i,a)=>a.indexOf(n)===i).sort((a,b)=>a-b);
}
function specOptions(koshu){
  const base=(koshu&&KIKAKU_BY_KOSHU[koshu])?KIKAKU_BY_KOSHU[koshu]:(koshu?[]:[].concat(...Object.values(KIKAKU_BY_KOSHU)));
  return uniqVals([...base,...records.filter(r=>!koshu||r.koshu===koshu).map(r=>r.spec)]);
}
function finOptions(mat,koshu){
  const base=(mat&&koshu)?finishOptions(mat,koshu):FINISH_ALL;
  return uniqVals([...base,...records.filter(r=>(!mat||r.mat===mat)&&(!koshu||r.koshu===koshu)).map(r=>r.fin)]);
}
/* 選択肢を差し替える（内容が変わったときだけ。選択中の値は維持） */
function refillSelect(sel,opts,blank){
  const key=opts.join("|");
  if(sel.dataset.opts===key)return;
  const cur=sel.value;fillSelect(sel,opts,blank);sel.dataset.opts=key;
  if(opts.map(String).includes(cur))sel.value=cur;
}
/* 名前の選択肢：名簿マスタ（マスタ設定で編集）。名簿が空のときだけ
 * 持ち出し/鍵の履歴に出てくる名前で代用（システム操作名は候補に入れない） */
function personOptions(){
  if(STAFF.length)return uniqVals([...STAFF]);
  return uniqVals(history.filter(x=>x.type==="checkout"||x.type==="keyout"||x.type==="keyin").map(x=>x.person));
}
/* 名前ピッカー：選択肢から選ぶ。前回の名前（端末に記憶）を自動選択。「直接入力」も可 */
function setupPersonPicker(selSel,inpSel){
  const sel=$(selSel),inp=$(inpSel);if(!sel||!inp)return;
  const opts=personOptions();
  let stored="";try{stored=(localStorage.getItem(PERSON_KEY)||"").trim();}catch(e){}
  sel.innerHTML="";
  const blank=document.createElement("option");blank.value="";blank.textContent=t("名前を選んでください");sel.appendChild(blank);
  opts.forEach(o=>{const e=document.createElement("option");e.value=o;e.textContent=o;sel.appendChild(e);});
  const free=document.createElement("option");free.value="__free";free.textContent=t("（名前を直接入力）");sel.appendChild(free);
  if(stored&&opts.includes(stored))sel.value=stored;
  else if(stored){sel.value="__free";inp.value=stored;}
  else inp.value="";
  const sync=()=>{inp.style.display=sel.value==="__free"?"block":"none";if(sel.value==="__free")setTimeout(()=>inp.focus(),50);};
  sel.onchange=sync;sync();
}
function pickerValue(selSel,inpSel){const sel=$(selSel);return sel.value==="__free"?$(inpSel).value.trim():sel.value.trim();}

/* 検索フィルタの選択肢を実データに追従させる */
function refreshSearchFilters(){
  refillSelect($("#f_mat"),matOptions(),"すべての材質");
  const m=$("#f_mat").value;
  if(m){refillSelect($("#f_koshu"),koshuOptions(m),"すべての鋼種");$("#f_koshu").disabled=false;}
  refillSelect($("#f_thk"),thkOptions(),"すべて");
  refillSelect($("#f_fin"),finOptions("",""),"すべて");
}
function finishOptions(mat,koshu){const k=mat+"|"+koshu;if(FINISH_BY_MAT_KOSHU[k]&&FINISH_BY_MAT_KOSHU[k].length)return FINISH_BY_MAT_KOSHU[k];return FINISH_ALL;}
function toast(msg){const t=$("#toast");$("#toastMsg").textContent=msg;t.classList.add("show");clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove("show"),2200);}

/* ===================== 言語（日本語／ベトナム語） =====================
 * 現場向け画面（タブ・検索・持ち出し・鍵・履歴）を翻訳対象にする。
 * 管理者向け画面（マスタ設定・作業ログ・計算）は日本語のみ。 */
const LANG_KEY="steel_mgr_lang";
let LANG="ja";try{if(localStorage.getItem(LANG_KEY)==="vi")LANG="vi";}catch(e){}
const I18N_VI={
  "メニュー":"Menu","在庫検索":"Tìm kiếm tồn kho","持ち出し":"Lấy vật liệu","入出庫履歴":"Lịch sử xuất nhập",
  "作業ログ":"Nhật ký công việc","在庫管理":"Quản lý tồn kho","重量・単価計算":"Tính trọng lượng・chi phí","マスタ参照":"Cài đặt master",
  "使い方":"Hướng dẫn",
  "検索条件":"Điều kiện tìm kiếm","材質":"Vật liệu","鋼種":"Loại thép","板厚 (mm)":"Độ dày (mm)","材料規格":"Quy cách",
  "長さ (mm)":"Chiều dài (mm)","表面仕上げ":"Hoàn thiện bề mặt","保管場所":"Vị trí kho","長さ":"Chiều dài","仕上げ":"Hoàn thiện",
  "条件は組み合わせ可能。空欄はすべて対象。材料規格は部分一致で絞り込みます。":"Có thể kết hợp điều kiện. Để trống = tất cả. Quy cách tìm theo một phần.",
  "条件クリア":"Xóa điều kiện","ヒット件数":"Số kết quả","合計重量":"Tổng trọng lượng","合計金額":"Tổng tiền",
  "該当材料の総重量":"Tổng trọng lượng vật liệu","材料費の合計（税抜）":"Tổng chi phí (chưa thuế)","検索結果":"Kết quả tìm kiếm",
  "CSV出力":"Xuất CSV","更新":"Cập nhật","件":"mục","合計":"Tổng",
  "すべての材質":"Tất cả vật liệu","すべての鋼種":"Tất cả loại thép","すべて":"Tất cả","すべての場所":"Tất cả vị trí",
  "指定なし":"Không chọn","部分一致 例: 50":"Tìm một phần, VD: 50","完全一致":"Khớp chính xác",
  "重量(kg)":"Trọng lượng (kg)","キロ単価":"Đơn giá/kg","材料費":"Chi phí","操作":"Thao tác","板厚":"Độ dày",
  "持ち出す材料をさがす":"Tìm vật liệu cần lấy",
  "QRを読み取る":"Quét mã QR","ラベルを撮影して、シャッターを押すと読み取ります":"Chụp nhãn QR rồi bấm nút chụp để đọc","読み取り中…":"Đang đọc…",
  "ふつうのカメラアプリをラベルにかざして、出てきたリンクを押してもOK（いちばん確実）":"Cũng có thể dùng camera thường của máy: hướng vào nhãn rồi bấm liên kết hiện ra (cách chắc chắn nhất)",
  "QRラベルを枠に入れてください":"Đưa nhãn QR vào giữa khung",
  "カメラを起動できませんでした（許可を確認してください）。かわりに撮影します":"Không mở được camera (hãy kiểm tra quyền truy cập). Sẽ chụp ảnh thay thế",
  "ライト":"Đèn",
  "かざすだけで読み取れる新アドレスはこちら（初回だけ警告→「詳細」→閲覧を許可）":"Địa chỉ mới để quét tự động (lần đầu có cảnh báo, hãy chọn cho phép)",
  "残材を登録":"Đăng ký vật liệu thừa","今日納入された材料の残りなど、リストに無い材料はこちら":"Vật liệu chưa có trong danh sách (VD: phần thừa của thanh mới nhập hôm nay)",
  "リストに無い材料（今日納入された定尺の残りなど）を在庫に登録します":"Đăng ký vào kho vật liệu chưa có trong danh sách (VD: phần thừa của thanh mới nhập)",
  "残りの長さ (mm)":"Chiều dài còn lại (mm)","選択してください":"Hãy chọn","先に材質を選択":"Chọn vật liệu trước","選択":"Chọn",
  "材質・鋼種・板厚・規格・長さは必須です":"Hãy nhập đủ: vật liệu, loại thép, độ dày, quy cách, chiều dài",
  "登録する":"Đăng ký","残材を登録しました":"Đã đăng ký vật liệu vào kho","保存に失敗しました: ":"Lưu thất bại: ",
  "例: 2500":"VD: 2500",
  "QRを読み取れませんでした。ラベルに近づけて撮り直してください":"Không đọc được QR. Hãy chụp lại gần hơn",
  "読み取れませんでした（写真は調査用に送信済み）。スマホのカメラアプリで大きく撮ってから「写真から選ぶ」も試してください":"Không đọc được (ảnh đã được gửi để kiểm tra). Hãy chụp to và rõ bằng camera của máy, rồi bấm 「Chọn từ ảnh đã chụp」",
  "このシステムのQRではないようです":"Có vẻ không phải mã QR của hệ thống này",
  "うまく読めないとき：写真から選ぶ":"Khi khó đọc: chọn từ ảnh đã chụp",
  "この在庫は見つかりません（すでに使い切った可能性があります）":"Không tìm thấy tồn kho này (có thể đã dùng hết)",
  "使う材料の「持ち出す」ボタンを押してください。空欄はすべて対象です。":"Nhấn nút 「Lấy ra」 của vật liệu cần dùng. Để trống = tất cả.",
  "持ち出す":"Lấy ra","条件に一致する在庫がありません":"Không có tồn kho phù hợp",
  "持ち出し登録":"Đăng ký lấy vật liệu","どれだけ使いますか？":"Bạn dùng bao nhiêu?",
  "全部 持ち出す":"Dùng hết (toàn bộ)","一部使った（残りを登録）":"Dùng một phần (nhập phần còn lại)",
  "残りの長さ (mm) — 使用後に残った長さを測って入力":"Chiều dài còn lại (mm) — đo phần còn lại sau khi dùng",
  "あなたの名前":"Tên của bạn","メモ（任意）":"Ghi chú (không bắt buộc)","キャンセル":"Hủy","持ち出しを記録":"Ghi nhận",
  "例: 1500":"VD: 1500","例: ◯◯案件で使用":"VD: dùng cho dự án ◯◯","例: 山田":"VD: Nguyen Van A",
  "名前を選んでください":"Hãy chọn tên của bạn","（名前を直接入力）":"(Tự nhập tên)",
  "鋼材倉庫の鍵":"Chìa khóa kho thép","鍵を借りて倉庫へ行く":"Mượn chìa khóa, vào kho","鍵を返却する":"Trả chìa khóa",
  "これから鋼材倉庫へ行くことを記録します":"Ghi nhận bạn sắp vào kho thép","記録して倉庫へ行く":"Ghi nhận và vào kho",
  "倉庫で材料を使ったら、材料のQRを読んで残りの長さの登録も忘れずに。":"Dùng vật liệu xong, nhớ quét QR của vật liệu và nhập chiều dài còn lại.",
  "状態を確認中…":"Đang kiểm tra…","状態を取得できませんでした":"Không lấy được trạng thái",
  "🔑 鍵はあります（持ち出しできます）":"🔑 Chìa khóa đang có (có thể mượn)","さんが鍵を持ち出し中":"đang giữ chìa khóa",
  "名前を入力してください":"Hãy nhập tên",
  "鍵の持ち出しを記録しました。行ってらっしゃい！":"Đã ghi nhận mượn chìa khóa. Chúc làm việc tốt!",
  "鍵の返却を記録しました。おつかれさまでした":"Đã ghi nhận trả chìa khóa. Cảm ơn bạn!",
  "残りの長さを入力してください":"Hãy nhập chiều dài còn lại",
  "今の長さより短い値を入力してください":"Hãy nhập giá trị ngắn hơn chiều dài hiện tại",
  "今の長さより短い値を入力してください（変わっていない場合は登録不要です）":"Hãy nhập giá trị ngắn hơn chiều dài hiện tại",
  "→ 全部使用として在庫から削除されます":"→ Dùng hết, sẽ xóa khỏi tồn kho",
  " mm 使用・残り ":" mm đã dùng, còn lại "," mm で登録します":" mm sẽ được ghi nhận",
  "持ち出しを記録しました（全部使用・在庫から削除）":"Đã ghi nhận (dùng hết, xóa khỏi tồn kho)",
  "持ち出しを記録しました（残り ":"Đã ghi nhận (còn lại ",
  "記録に失敗しました: ":"Ghi nhận thất bại: ",
  "日時":"Ngày giờ","種別":"Loại","名前":"Tên","品目":"Vật phẩm","数量・変化":"Số lượng・thay đổi","メモ":"Ghi chú",
  "登録":"Đăng ký","編集":"Sửa","削除":"Xóa","CSV取込":"Nhập CSV","鍵 持出":"Mượn chìa khóa","鍵 返却":"Trả chìa khóa",
  " mm 使用":" mm đã dùng","（残り ":"（còn lại ","（全部）":"（toàn bộ）","内容変更":"Đã sửa"," 件 取込":" dòng đã nhập",
  "履歴はまだありません。「持ち出し」画面から記録すると、ここに残ります":"Chưa có lịch sử. Ghi nhận từ màn hình 「Lấy vật liệu」 sẽ hiện ở đây",
  "履歴を更新しました":"Đã cập nhật lịch sử"
};
function t(s){return LANG==="ja"?s:(I18N_VI[s]||s);}
function applyLang(){
  const b=$("#langLabel");if(b)b.textContent=LANG==="ja"?"Tiếng Việt":"日本語";
  if(LANG==="ja")return; /* 日本語はHTMLの原文のまま（太字等の装飾を保持） */
  document.documentElement.lang="vi";
  document.querySelectorAll("[data-i18n]").forEach(el=>{el.textContent=t(el.dataset.i18n);});
  document.querySelectorAll("[data-i18n-ph]").forEach(el=>{el.placeholder=t(el.dataset.i18nPh);});
  /* 現場向け画面のテキストノードを辞書で置換（svg等の構造は保持） */
  document.querySelectorAll(
    "#view-search .fld-lab,#view-checkout .fld-lab,#view-search .panel-h h2,#view-checkout .panel-h h2,#view-history .panel-h h2,"+
    "#btnClear,#coClear,#btnExportSearch,"+
    "#coOverlay .co-lab,#coOverlay .co-q,#coOverlay .co-mode,#coOverlay .modal-h h3,#coCancel,#coSubmit,"+
    "#keyOverlay .co-lab,#keyOverlay .key-btn,#keyOverlay .modal-h h3,#nsOverlay .co-lab"
  ).forEach(el=>{
    [...el.childNodes].forEach(n=>{
      if(n.nodeType===3&&n.textContent.trim())n.textContent=n.textContent.replace(n.textContent.trim(),t(n.textContent.trim()));
    });
  });
  /* 要素まるごと置換（装飾なしのヒント文など） */
  document.querySelectorAll("#view-search .filter-hint,#view-checkout .filter-hint,#view-search .kpi-lab,#keyOverlay .key-note").forEach(el=>{el.textContent=t(el.textContent.trim());});
  document.querySelectorAll("#view-search .kpi-sub").forEach(el=>{if(el.id!=="kpiTotal")el.textContent=t(el.textContent.trim());});
  /* プレースホルダー */
  [["#f_spec","部分一致 例: 50"],["#f_len","完全一致"],["#co_spec","部分一致 例: 50"],["#coUsed","例: 1500"],["#coNote","例: ◯◯案件で使用"],["#coPerson","例: 山田"],["#keyPerson","例: 山田"],["#ns_len","例: 2500"],["#nsPerson","例: 山田"]]
    .forEach(([s,k])=>{const el=$(s);if(el)el.placeholder=t(k);});
}
function toggleLang(){LANG=LANG==="ja"?"vi":"ja";try{localStorage.setItem(LANG_KEY,LANG);}catch(e){}location.reload();}

/* ===================== ナビ ===================== */
const PG={search:["在庫検索","SEARCH / INVENTORY LOOKUP"],checkout:["持ち出し","CHECKOUT / TAKE OUT"],worklog:["作業ログ","WORK LOG / DAILY MONITOR"],inventory:["在庫管理","INVENTORY / DATA MANAGEMENT"],calc:["重量・単価計算","CALCULATOR / WEIGHT & COST"],master:["マスタ参照","MASTER / REFERENCE DATA"]};
document.querySelectorAll(".tab").forEach(it=>it.addEventListener("click",()=>{
  document.querySelectorAll(".tab").forEach(n=>n.classList.remove("active"));it.classList.add("active");
  const v=it.dataset.view;document.querySelectorAll(".view").forEach(s=>s.classList.remove("active"));$("#view-"+v).classList.add("active");
  $("#pgTitle").textContent=PG[v][0];$("#pgCrumb").textContent=PG[v][1];
  if(v==="checkout")renderCheckout();
  if(v==="worklog")loadHistory();
}));

/* ===================== 管理者モード ===================== */
let isAdmin=false;
function applyAdmin(){
  document.querySelectorAll(".tab.admin-only").forEach(t=>{t.style.display=isAdmin?"inline-flex":"none";});
  const b=$("#adminBtn");if(b)b.classList.toggle("on",isAdmin);
  const l=$("#adminLabel");if(l)l.textContent=isAdmin?"管理者中（解除）":"管理者モード";
  if(!isAdmin){const cur=document.querySelector(".tab.active");if(cur&&cur.classList.contains("admin-only")){const s=document.querySelector('.tab[data-view="search"]');if(s)s.click();}}
}
const ADMIN_PIN="0419"; /* ← 管理者パスコード：この数字を書き換えれば変更できます */
function openPin(){const o=$("#pinOverlay");$("#pinInput").value="";$("#pinErr").classList.remove("show");o.classList.add("show");setTimeout(()=>{const i=$("#pinInput");if(i)i.focus();},60);}
function closePin(){$("#pinOverlay").classList.remove("show");}
function submitPin(){
  if($("#pinInput").value===ADMIN_PIN){closePin();isAdmin=true;applyAdmin();toast("管理者モードに切り替えました");}
  else{$("#pinErr").classList.add("show");$("#pinInput").value="";$("#pinInput").focus();const m=document.querySelector(".pin-modal");if(m){m.classList.remove("shake");void m.offsetWidth;m.classList.add("shake");}}
}
/* ===================== 使い方ガイド ===================== */
function openHelp(){$("#helpOverlay").classList.add("show");}
function closeHelp(){$("#helpOverlay").classList.remove("show");}

/* ===================== 検索ビュー ===================== */
function initSearchControls(){
  fillSelect($("#f_mat"),MATERIALS,"すべての材質");
  fillSelect($("#f_koshu"),[],"すべての鋼種");$("#f_koshu").disabled=true;
  fillSelect($("#f_thk"),THICKNESS,"すべて");
  fillSelect($("#f_fin"),FINISH_ALL,"すべて");
  $("#f_mat").addEventListener("change",()=>{
    const m=$("#f_mat").value;
    if(m){fillSelect($("#f_koshu"),koshuOptions(m),"すべての鋼種");$("#f_koshu").disabled=false;$("#f_koshu").dataset.opts=koshuOptions(m).join("|");}
    else{fillSelect($("#f_koshu"),[],"すべての鋼種");$("#f_koshu").disabled=true;delete $("#f_koshu").dataset.opts;}
    updateSpecDatalist();runSearch();
  });
  $("#f_koshu").addEventListener("change",()=>{updateSpecDatalist();runSearch();});
  ["#f_thk","#f_fin"].forEach(s=>$(s).addEventListener("change",runSearch));
  ["#f_spec","#f_len"].forEach(s=>$(s).addEventListener("input",runSearch));
  $("#btnClear").addEventListener("click",()=>{
    $("#f_mat").value="";fillSelect($("#f_koshu"),[],"すべての鋼種");$("#f_koshu").disabled=true;
    $("#f_thk").value="";$("#f_fin").value="";$("#f_spec").value="";$("#f_len").value="";updateSpecDatalist();runSearch();
  });
}
function updateSpecDatalist(){fillDatalist($("#dl_spec"),specOptions($("#f_koshu").value));}
function getFilter(){return{mat:$("#f_mat").value,koshu:$("#f_koshu").value,thk:$("#f_thk").value,spec:$("#f_spec").value.trim(),len:$("#f_len").value.trim(),fin:$("#f_fin").value};}
function matchRec(r,f){
  if(f.mat&&r.mat!==f.mat)return false;
  if(f.koshu&&r.koshu!==f.koshu)return false;
  if(f.thk!==""&&Number(r.thk)!==Number(f.thk))return false;
  if(f.spec&&!String(r.spec).includes(f.spec))return false;
  if(f.len!==""&&Number(r.len)!==Number(f.len))return false;
  if(f.fin&&r.fin!==f.fin)return false;
  return true;
}
let lastSearch=[];
function runSearch(){
  refreshSearchFilters();
  const f=getFilter();
  const hits=records.filter(r=>matchRec(r,f)).map(r=>({...r,...compute(r)}));
  lastSearch=hits;
  const tw=Math.round(hits.reduce((s,h)=>s+(h.weight||0),0)*1000)/1000;
  const tc=hits.reduce((s,h)=>s+(h.cost||0),0);
  $("#kpiCount").innerHTML=hits.length+'<span class="kpi-unit">'+t("件")+'</span>';
  $("#kpiTotal").textContent=LANG==="vi"?("Tổng "+records.length+" mục"):("全 "+records.length+" 件中");
  $("#kpiWeight").innerHTML=fmtNum(tw,3)+'<span class="kpi-unit">kg</span>';
  $("#kpiCost").textContent=fmtYenP(tc);
  const wrap=$("#searchTable");
  if(!hits.length){wrap.innerHTML=emptyState(t("条件に一致する在庫がありません"));return;}
  let h='<table class="dt"><thead><tr><th>'+t("材質")+'</th><th>'+t("鋼種")+'</th><th class="r">'+t("板厚")+'</th><th>'+t("材料規格")+'</th><th class="r">'+t("長さ")+'</th><th>'+t("保管場所")+'</th><th class="r">'+t("重量(kg)")+'</th><th>'+t("表面仕上げ")+'</th><th class="r">'+t("キロ単価")+'</th><th class="r">'+t("材料費")+'</th></tr></thead><tbody>';
  hits.forEach(r=>{h+=`<tr><td><span class="pill mat ${matCls(r.mat)}">${IC.mat}${r.mat}</span></td><td>${shapeIco(r.koshu)}${r.koshu}</td><td class="r tnum">${r.thk}</td><td class="tnum">${r.spec}</td><td class="r tnum">${Number(r.len).toLocaleString()}</td><td><span class="pill loc">${IC.loc}${r.loc||"—"}</span></td><td class="r tnum">${fmtKg(r.weight)}</td><td><span class="pill fin">${IC.fin}${r.fin||"—"}</span></td><td class="r tnum">${r.unit==null?'<span class="muted">—</span>':r.unit.toLocaleString()}</td><td class="r tnum"><b>${fmtYen(r.cost)}</b></td></tr>`;});
  h+=`</tbody><tfoot><tr class="tfoot"><td colspan="6">${t("合計")}（${hits.length}${t("件")}）</td><td class="r tnum">${fmtNum(tw,3)}</td><td></td><td></td><td class="r tnum">${fmtYenP(tc)}</td></tr></tfoot></table>`;
  wrap.innerHTML=h;
}
function emptyState(msg){return`<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg><p>${msg}</p></div>`;}

/* ===================== 在庫ビュー ===================== */
function renderInventory(){
  $("#invCount").textContent=records.length+" 件";
  $("#footCount").textContent=records.length+" 件";
  const wrap=$("#invTable");
  if(!records.length){wrap.innerHTML=emptyState("在庫データがありません。「新規登録」から追加してください");return;}
  let h='<table class="dt"><thead><tr><th>材質</th><th>鋼種</th><th class="r">板厚</th><th>材料規格</th><th class="r">長さ</th><th>保管場所</th><th>仕上げ</th><th class="r">重量(kg)</th><th class="r">単価</th><th class="r">材料費</th><th>QR</th><th class="r">操作</th></tr></thead><tbody>';
  records.forEach(r=>{const c=compute(r);h+=`<tr><td><span class="pill mat ${matCls(r.mat)}">${IC.mat}${r.mat}</span></td><td>${shapeIco(r.koshu)}${r.koshu}</td><td class="r tnum">${r.thk}</td><td class="tnum">${r.spec}</td><td class="r tnum">${Number(r.len).toLocaleString()}</td><td>${r.loc?'<span class="pill loc">'+IC.loc+r.loc+'</span>':'<span class="muted">—</span>'}</td><td><span class="pill fin">${IC.fin}${r.fin||"—"}</span></td><td class="r tnum">${fmtKg(c.weight)}</td><td class="r tnum">${c.unit==null?'<span class="muted">—</span>':c.unit.toLocaleString()}</td><td class="r tnum"><b>${fmtYen(c.cost)}</b></td><td>${r.qr?`<span class="lab-ok" title="ラベル印刷済み ${fmtTs(r.qr)}">✔済</span>`:'<span class="lab-no">未</span>'}</td><td class="r"><div class="row-acts">${MODE==="server"?`<button class="icobtn" data-qrone="${r.id}" title="QRラベルを印刷"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1"/><path d="M14 14h3v3h-3zM20.5 14v3M14 20.5h3M18.5 18.5h2v2h-2z"/></svg></button>`:""}<button class="icobtn" data-edit="${r.id}" title="編集"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M13.5 6.5l3 3"/></svg></button><button class="icobtn del" data-del="${r.id}" title="削除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button></div></td></tr>`;});
  h+="</tbody></table>";wrap.innerHTML=h;
  wrap.querySelectorAll("[data-edit]").forEach(b=>b.addEventListener("click",()=>openModal(+b.dataset.edit)));
  wrap.querySelectorAll("[data-del]").forEach(b=>b.addEventListener("click",()=>delRecord(+b.dataset.del)));
  wrap.querySelectorAll("[data-qrone]").forEach(b=>b.addEventListener("click",()=>openQr([+b.dataset.qrone])));
}
async function delRecord(id){
  const r=records.find(x=>x.id===id);if(!r)return;
  if(!confirm(`この在庫を削除しますか？\n\n${r.mat} / ${r.koshu} / ${r.spec} / 長さ${r.len}mm`))return;
  if(MODE==="server"){
    try{await apiSend("DELETE","/api/records/"+id);await refresh();toast("在庫を削除しました");}
    catch(e){toast("削除に失敗しました: "+e.message);}
    return;
  }
  records=records.filter(x=>x.id!==id);localHist("delete",r,{len_before:r.len,len_after:null});
  saveRecords();renderInventory();runSearch();updateFoot();renderCheckout();renderWorklog();toast("在庫を削除しました");
}

/* ===================== モーダル（登録/編集） ===================== */
function setupCascade(matSel,koshuSel,specInput,specDL,finSel,thkSel){
  matSel.addEventListener("change",()=>{const m=matSel.value;if(m){fillSelect(koshuSel,koshuOptions(m),"選択してください");koshuSel.disabled=false;}else{fillSelect(koshuSel,[],"先に材質を選択");koshuSel.disabled=true;}refreshSpecFin();});
  koshuSel.addEventListener("change",refreshSpecFin);
  function refreshSpecFin(){
    const m=matSel.value,k=koshuSel.value;
    fillDatalist(specDL,k?specOptions(k):[]);
    if(m&&k){fillSelect(finSel,finOptions(m,k),"指定なし");finSel.disabled=false;}else{fillSelect(finSel,finOptions("",""),"指定なし");}
  }
}
function openModal(id){
  editId=id||null;
  $("#modalTitle").textContent=editId?"在庫を編集":"在庫を登録";
  $("#modalDelete").style.visibility=editId?"visible":"hidden";
  const r=editId?records.find(x=>x.id===editId):{mat:"",koshu:"",thk:"",spec:"",len:"",loc:"",fin:""};
  fillSelect($("#m_mat"),matOptions(),"選択してください");$("#m_mat").value=r.mat||"";
  if(r.mat){fillSelect($("#m_koshu"),koshuOptions(r.mat),"選択してください");$("#m_koshu").disabled=false;$("#m_koshu").value=r.koshu||"";}
  else{fillSelect($("#m_koshu"),[],"先に材質を選択");$("#m_koshu").disabled=true;}
  fillSelect($("#m_thk"),thkOptions(),"選択");$("#m_thk").value=r.thk!==""?r.thk:"";
  fillDatalist($("#dl_mspec"),r.koshu?specOptions(r.koshu):[]);$("#m_spec").value=r.spec||"";
  $("#m_len").value=r.len!==""?r.len:"";
  fillSelect($("#m_loc"),locOptions(),"指定なし");$("#m_loc").value=r.loc||"";
  fillSelect($("#m_fin"),(r.mat||r.koshu)?finOptions(r.mat,r.koshu):finOptions("",""),"指定なし");$("#m_fin").value=r.fin||"";
  modalPreview();
  $("#overlay").classList.add("show");
}
function closeModal(){$("#overlay").classList.remove("show");editId=null;}
function readModal(){return{mat:$("#m_mat").value,koshu:$("#m_koshu").value,thk:$("#m_thk").value,spec:$("#m_spec").value.trim(),len:$("#m_len").value.trim(),loc:$("#m_loc").value,fin:$("#m_fin").value};}
function modalPreview(){const r=readModal();const c=compute(r);$("#pvArea").textContent=c.area==null?"—":fmtNum(c.area,1);$("#pvWeight").textContent=c.weight==null?"—":fmtKg(c.weight);$("#pvUnit").textContent=c.unit==null?"—":c.unit.toLocaleString();$("#pvCost").textContent=c.cost==null?"—":fmtYenP(c.cost);}
async function saveModal(){
  const r=readModal();
  if(!r.mat||!r.koshu||r.thk===""||!r.spec||r.len===""){toast("材質・鋼種・板厚・規格・長さは必須です");return;}
  const rec={...r,thk:Number(r.thk),len:Number(r.len)};
  if(MODE==="server"){
    try{
      if(editId)await apiSend("PUT","/api/records/"+editId,rec);
      else await apiSend("POST","/api/records",rec);
      await refresh();toast(editId?"在庫を更新しました":"在庫を登録しました");closeModal();
    }catch(e){toast("保存に失敗しました: "+e.message);}
    return;
  }
  if(editId){const i=records.findIndex(x=>x.id===editId);const old=records[i];records[i]={id:editId,...rec};localHist("edit",rec,{len_before:old?old.len:null,len_after:rec.len});toast("在庫を更新しました");}
  else{records.push({id:nextId(),...rec});localHist("add",rec,{len_after:rec.len});toast("在庫を登録しました");}
  saveRecords();renderInventory();runSearch();updateFoot();renderCheckout();renderWorklog();closeModal();
}

/* ===================== QRコード生成（自前実装・外部ライブラリ不使用） =====================
 * バイトモード / 誤り訂正レベルM / バージョン1〜10 自動選択 / マスク自動評価
 * 用途：在庫ラベルのQR（持ち出しURL）。QR.svg(text) が SVG 文字列を返す。
 * ※デコーダ(jsQR)との往復テストで v1〜v10 の正当性を検証済み（2026-07-18） */
const QR=(()=>{
  /* GF(256) テーブル（生成多項式 0x11d） */
  const EXP=new Uint8Array(512),LOG=new Uint8Array(256);
  (()=>{let x=1;for(let i=0;i<255;i++){EXP[i]=x;LOG[x]=i;x<<=1;if(x&0x100)x^=0x11d;}for(let i=255;i<512;i++)EXP[i]=EXP[i-255];})();
  const gmul=(a,b)=>(a&&b)?EXP[LOG[a]+LOG[b]]:0;

  /* バージョン別テーブル：[ブロック毎EC語数, [[ブロック数, データ語数], ...]]
   * M=誤り訂正15%（画面表示用） / Q=25%（印刷ラベル用。汚れ・かすれに強い） */
  const TBLS={
    M:{
      1:[10,[[1,16]]],2:[16,[[1,28]]],3:[26,[[1,44]]],4:[18,[[2,32]]],5:[24,[[2,43]]],
      6:[16,[[4,27]]],7:[18,[[4,31]]],8:[22,[[2,38],[2,39]]],9:[22,[[3,36],[2,37]]],10:[26,[[4,43],[1,44]]]
    },
    Q:{
      1:[13,[[1,13]]],2:[22,[[1,22]]],3:[18,[[2,17]]],4:[26,[[2,24]]],5:[18,[[2,15],[2,16]]],
      6:[24,[[4,19]]],7:[18,[[2,14],[4,15]]],8:[22,[[4,18],[2,19]]],9:[20,[[4,16],[4,17]]],10:[24,[[6,19],[2,20]]]
    }
  };
  const LVL_BITS={M:0,Q:3}; /* 形式情報の誤り訂正レベル表示ビット */
  const ALIGN={1:[],2:[6,18],3:[6,22],4:[6,26],5:[6,30],6:[6,34],7:[6,22,38],8:[6,24,42],9:[6,26,46],10:[6,28,50]};
  const dataLenOf=(v,lvl)=>TBLS[lvl][v][1].reduce((s,[n,c])=>s+n*c,0);
  const capacity=(v,lvl)=>dataLenOf(v,lvl)-(v<10?2:3); /* バイトモードの最大文字数（モード+長さ分を差引） */

  /* リード・ソロモン誤り訂正 */
  function rs(data,ecLen){
    let g=[1];
    for(let i=0;i<ecLen;i++){
      const ng=new Array(g.length+1).fill(0);
      for(let j=0;j<g.length;j++){ng[j]^=g[j];ng[j+1]^=gmul(g[j],EXP[i]);}
      g=ng;
    }
    const res=data.concat(new Array(ecLen).fill(0));
    for(let i=0;i<data.length;i++){
      const f=res[i];if(!f)continue;
      for(let j=0;j<g.length;j++)res[i+j]^=gmul(g[j],f);
    }
    return res.slice(data.length);
  }

  /* データ符号化（バイトモード）→ 符号語列 */
  function encode(text,lvl){
    const bytes=new TextEncoder().encode(text);
    let v=0;for(let i=1;i<=10;i++){if(bytes.length<=capacity(i,lvl)){v=i;break;}}
    if(!v)throw new Error("QR: データが長すぎます("+bytes.length+"バイト)");
    const[ecLen,blocksDef]=TBLS[lvl][v],dataLen=dataLenOf(v,lvl);
    const bits=[];const push=(val,len)=>{for(let i=len-1;i>=0;i--)bits.push((val>>i)&1);};
    push(4,4);push(bytes.length,v<10?8:16);
    for(const b of bytes)push(b,8);
    const total=dataLen*8;
    for(let i=0;i<4&&bits.length<total;i++)bits.push(0);
    while(bits.length%8)bits.push(0);
    const data=[];for(let i=0;i<bits.length;i+=8){let x=0;for(let j=0;j<8;j++)x=(x<<1)|bits[i+j];data.push(x);}
    const pads=[0xEC,0x11];let pi=0;while(data.length<dataLen)data.push(pads[pi++%2]);
    const blocks=[];let off=0;
    for(const[n,c]of blocksDef)for(let k=0;k<n;k++){const d=data.slice(off,off+c);off+=c;blocks.push({d,e:rs(d,ecLen)});}
    const out=[];
    const maxD=Math.max(...blocks.map(b=>b.d.length));
    for(let i=0;i<maxD;i++)for(const b of blocks)if(i<b.d.length)out.push(b.d[i]);
    for(let i=0;i<ecLen;i++)for(const b of blocks)out.push(b.e[i]);
    return{v,codewords:out};
  }

  /* BCH（形式情報15bit / 型番情報18bit） */
  const bchDigit=n=>{let d=0;while(n){d++;n>>>=1;}return d;};
  function bchFormat(data){const G=0x537;let d=data<<10;while(bchDigit(d)-bchDigit(G)>=0)d^=G<<(bchDigit(d)-bchDigit(G));return((data<<10)|d)^0x5412;}
  function bchVersion(v){const G=0x1F25;let d=v<<12;while(bchDigit(d)-bchDigit(G)>=0)d^=G<<(bchDigit(d)-bchDigit(G));return(v<<12)|d;}

  const MASKS=[
    (i,j)=>(i+j)%2===0,(i,j)=>i%2===0,(i,j)=>j%3===0,(i,j)=>(i+j)%3===0,
    (i,j)=>(((i/2)|0)+((j/3)|0))%2===0,(i,j)=>(i*j)%2+(i*j)%3===0,
    (i,j)=>((i*j)%2+(i*j)%3)%2===0,(i,j)=>((i+j)%2+(i*j)%3)%2===0
  ];

  function matrix(text,lvl){
    lvl=TBLS[lvl]?lvl:"M";
    const{v,codewords}=encode(text,lvl);
    const size=17+4*v;
    const m=Array.from({length:size},()=>new Int8Array(size).fill(-1));
    const isData=Array.from({length:size},()=>new Uint8Array(size));
    /* ファインダ＋分離帯 */
    const finder=(r,c)=>{for(let i=-1;i<8;i++)for(let j=-1;j<8;j++){const rr=r+i,cc=c+j;if(rr<0||rr>=size||cc<0||cc>=size)continue;const inF=i>=0&&i<7&&j>=0&&j<7;m[rr][cc]=(inF&&(i===0||i===6||j===0||j===6||(i>=2&&i<=4&&j>=2&&j<=4)))?1:0;}};
    finder(0,0);finder(0,size-7);finder(size-7,0);
    /* タイミング */
    for(let i=8;i<size-8;i++){const b=i%2===0?1:0;if(m[6][i]<0)m[6][i]=b;if(m[i][6]<0)m[i][6]=b;}
    /* 位置合わせ（ファインダと重なる3隅のみ除外。タイミング上のものは描く） */
    const last=size-7;
    for(const r of ALIGN[v])for(const c of ALIGN[v]){
      if((r===6&&c===6)||(r===6&&c===last)||(r===last&&c===6))continue;
      for(let i=-2;i<=2;i++)for(let j=-2;j<=2;j++)m[r+i][c+j]=Math.max(Math.abs(i),Math.abs(j))!==1?1:0;
    }
    /* 形式情報エリアを予約（値は後でマスク毎に設定） */
    for(let i=0;i<8;i++){if(m[i][8]<0)m[i][8]=0;if(m[8][i]<0)m[8][i]=0;}
    m[8][8]=0;
    for(let i=0;i<8;i++){if(m[8][size-1-i]<0)m[8][size-1-i]=0;if(m[size-1-i][8]<0)m[size-1-i][8]=0;}
    m[size-8][8]=1; /* 固定暗モジュール */
    /* 型番情報（バージョン7以上） */
    if(v>=7){
      const bits=bchVersion(v);
      for(let i=0;i<18;i++){const b=(bits>>i)&1;m[(i/3)|0][i%3+size-11]=b;m[i%3+size-11][(i/3)|0]=b;}
    }
    /* データ配置（ジグザグ） */
    let idx=0,bit=7;
    const nextBit=()=>{let b=0;if(idx<codewords.length){b=(codewords[idx]>>bit)&1;if(--bit<0){bit=7;idx++;}}return b;};
    let up=true;
    for(let col=size-1;col>0;col-=2){
      if(col===6)col--;
      for(let k=0;k<size;k++){
        const r=up?size-1-k:k;
        for(const c of[col,col-1])if(m[r][c]===-1){m[r][c]=nextBit();isData[r][c]=1;}
      }
      up=!up;
    }
    /* 形式情報の書込み（マスク番号込み） */
    const setFormat=(mm,mask)=>{
      const bits=bchFormat((LVL_BITS[lvl]<<3)|mask);
      for(let i=0;i<15;i++){
        const b=(bits>>i)&1;
        if(i<6)mm[i][8]=b;else if(i<8)mm[i+1][8]=b;else mm[size-15+i][8]=b;
        if(i<8)mm[8][size-1-i]=b;else if(i<9)mm[8][15-i]=b;else mm[8][14-i]=b;
      }
      mm[size-8][8]=1;
    };
    /* マスク評価（罰則が最小のものを採用） */
    const penalty=mm=>{
      let p=0;
      for(let dir=0;dir<2;dir++)for(let i=0;i<size;i++){
        let run=1,prev=dir?mm[0][i]:mm[i][0];
        for(let j=1;j<size;j++){
          const cur=dir?mm[j][i]:mm[i][j];
          if(cur===prev){run++;}else{if(run>=5)p+=3+(run-5);run=1;prev=cur;}
        }
        if(run>=5)p+=3+(run-5);
      }
      for(let i=0;i<size-1;i++)for(let j=0;j<size-1;j++){const c=mm[i][j];if(c===mm[i][j+1]&&c===mm[i+1][j]&&c===mm[i+1][j+1])p+=3;}
      const pat1=[1,0,1,1,1,0,1,0,0,0,0],pat2=[0,0,0,0,1,0,1,1,1,0,1];
      for(let i=0;i<size;i++)for(let j=0;j<=size-11;j++){
        let a=true,b=true,c=true,d=true;
        for(let k=0;k<11;k++){
          if(mm[i][j+k]!==pat1[k])a=false;if(mm[i][j+k]!==pat2[k])b=false;
          if(mm[j+k][i]!==pat1[k])c=false;if(mm[j+k][i]!==pat2[k])d=false;
        }
        if(a)p+=40;if(b)p+=40;if(c)p+=40;if(d)p+=40;
      }
      let dark=0;for(let i=0;i<size;i++)for(let j=0;j<size;j++)dark+=mm[i][j];
      p+=10*Math.floor(Math.abs(dark*100/(size*size)-50)/5);
      return p;
    };
    let best=null,bestP=Infinity;
    for(let mask=0;mask<8;mask++){
      const mm=m.map(row=>Int8Array.from(row));
      for(let i=0;i<size;i++)for(let j=0;j<size;j++)if(isData[i][j]&&MASKS[mask](i,j))mm[i][j]^=1;
      setFormat(mm,mask);
      const p=penalty(mm);
      if(p<bestP){bestP=p;best=mm;}
    }
    return best.map(row=>Array.from(row));
  }

  /* SVG 出力（quiet zone 4モジュール込み）。lvl省略時はM、印刷ラベルは"Q"を推奨 */
  function svg(text,lvl){
    const m=matrix(text,lvl),n=m.length,q=4,S=n+q*2;
    let d="";
    for(let i=0;i<n;i++)for(let j=0;j<n;j++)if(m[i][j])d+="M"+(j+q)+" "+(i+q)+"h1v1h-1z";
    return'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+S+" "+S+'" shape-rendering="crispEdges"><rect width="'+S+'" height="'+S+'" fill="#fff"/><path d="'+d+'" fill="#000"/></svg>';
  }
  return{svg,matrix};
})();

/* ===================== 持ち出し（現場向け出庫） ===================== */
const HIST_KEY="steel_mgr_history_v1";   // 単体版（localStorage モード）の履歴保存先
const PERSON_KEY="steel_mgr_person";     // この端末で前回入力した名前
let history=[], coTarget=null, coMode="all";

/* 単体版でも履歴を残す（サーバー版はサーバー側が自動記録） */
function localHist(type,rec,extra){
  if(MODE==="server")return;
  const e=extra||{};const r=rec||{};
  history.unshift({id:(history[0]&&history[0].id||0)+1,ts:Date.now(),type,person:e.person||"",
    mat:r.mat||"",koshu:r.koshu||"",thk:r.thk!=null?r.thk:null,spec:r.spec||"",fin:r.fin||"",loc:r.loc||"",
    len_before:e.len_before!=null?e.len_before:null,len_after:e.len_after!=null?e.len_after:null,
    qty:e.qty!=null?e.qty:null,note:e.note||""});
  try{localStorage.setItem(HIST_KEY,JSON.stringify(history.slice(0,1000)));}catch(err){}
}
async function loadHistory(){
  if(MODE==="server"){
    try{const j=await apiGET("/api/history?limit=500");history=j.items||[];}
    catch(e){/* 通信断時は前回の内容を表示 */}
  }else{
    try{history=JSON.parse(localStorage.getItem(HIST_KEY)||"[]");}catch(e){history=[];}
  }
  renderWorklog();
}

function initCheckoutControls(){
  fillSelect($("#co_mat"),MATERIALS,"すべての材質");
  fillSelect($("#co_koshu"),[],"すべての鋼種");$("#co_koshu").disabled=true;
  fillSelect($("#co_loc"),locOptions(),"すべての場所");
  $("#co_mat").addEventListener("change",()=>{
    const m=$("#co_mat").value;
    if(m){fillSelect($("#co_koshu"),koshuOptions(m),"すべての鋼種");$("#co_koshu").disabled=false;$("#co_koshu").dataset.opts=koshuOptions(m).join("|");}
    else{fillSelect($("#co_koshu"),[],"すべての鋼種");$("#co_koshu").disabled=true;delete $("#co_koshu").dataset.opts;}
    updateCoDatalist();renderCheckout();
  });
  $("#co_koshu").addEventListener("change",()=>{updateCoDatalist();renderCheckout();});
  $("#co_loc").addEventListener("change",renderCheckout);
  $("#co_spec").addEventListener("input",renderCheckout);
  $("#coClear").addEventListener("click",()=>{
    $("#co_mat").value="";fillSelect($("#co_koshu"),[],"すべての鋼種");$("#co_koshu").disabled=true;
    $("#co_spec").value="";$("#co_loc").value="";updateCoDatalist();renderCheckout();
  });
  updateCoDatalist();
}
function updateCoDatalist(){fillDatalist($("#dl_cospec"),specOptions($("#co_koshu").value));}
function renderCheckout(){
  const wrap=$("#coList");if(!wrap)return;
  /* 絞り込みの候補を実データに追従させる（選択中の値は維持） */
  refillSelect($("#co_mat"),matOptions(),"すべての材質");
  const cm=$("#co_mat").value;
  if(cm){refillSelect($("#co_koshu"),koshuOptions(cm),"すべての鋼種");$("#co_koshu").disabled=false;}
  refillSelect($("#co_loc"),locOptions(),"すべての場所");
  const f={mat:$("#co_mat").value,koshu:$("#co_koshu").value,spec:$("#co_spec").value.trim(),loc:$("#co_loc").value};
  const hits=records.filter(r=>{
    if(f.mat&&r.mat!==f.mat)return false;
    if(f.koshu&&r.koshu!==f.koshu)return false;
    if(f.spec&&!String(r.spec).includes(f.spec))return false;
    if(f.loc&&r.loc!==f.loc)return false;
    return true;
  });
  if(!hits.length){wrap.innerHTML=emptyState(t("条件に一致する在庫がありません"));return;}
  let h="";
  hits.forEach(r=>{
    h+=`<div class="co-card">
      <div class="co-ic">${shapeSVG(r.koshu)}</div>
      <div class="co-info">
        <div class="co-line1"><span class="pill mat ${matCls(r.mat)}">${IC.mat}${r.mat}</span><b>${r.koshu}</b><span class="co-spec">${r.spec} × t${r.thk}</span></div>
        <div class="co-line2">${t("長さ")} <b>${Number(r.len).toLocaleString()} mm</b>　${r.loc?'<span class="pill loc">'+IC.loc+r.loc+'</span>':""}　${r.fin?'<span class="pill fin">'+IC.fin+r.fin+'</span>':""}</div>
      </div>
      <button class="btn primary co-btn" data-co="${r.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 17h8M18.5 13.5 22 17l-3.5 3.5"/><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l7 3.1"/></svg>${t("持ち出す")}</button>
    </div>`;
  });
  wrap.innerHTML=h;
  wrap.querySelectorAll("[data-co]").forEach(b=>b.addEventListener("click",()=>openCo(+b.dataset.co)));
}

function openCo(id){
  coTarget=records.find(x=>x.id===id);if(!coTarget)return;
  coMode="all";applyCoMode();
  $("#coItem").innerHTML=`<span class="co-ic sm">${shapeSVG(coTarget.koshu)}</span><span class="pill mat ${matCls(coTarget.mat)}">${IC.mat}${coTarget.mat}</span><b>${coTarget.koshu}</b><span class="co-spec">${coTarget.spec} × t${coTarget.thk}</span><span class="co-len">${t("長さ")} ${Number(coTarget.len).toLocaleString()} mm</span>`;
  $("#coUsed").value="";$("#coRemain").textContent="";$("#coNote").value="";
  setupPersonPicker("#coPersonSel","#coPerson");
  $("#coOverlay").classList.add("show");
}
function closeCo(){$("#coOverlay").classList.remove("show");coTarget=null;}
function applyCoMode(){
  $("#coModeAll").classList.toggle("active",coMode==="all");
  $("#coModePart").classList.toggle("active",coMode==="part");
  $("#coPart").style.display=coMode==="part"?"block":"none";
  if(coMode==="part")setTimeout(()=>$("#coUsed").focus(),60);
}
function coUpdateRemain(){
  /* 入力は「使用後に残った長さ」。使用量はここで逆算して表示する */
  if(!coTarget)return;
  const rem=Number($("#coUsed").value),len=Number(coTarget.len);
  const el=$("#coRemain");
  if($("#coUsed").value===""||!isFinite(rem)||rem<0){el.textContent="";return;}
  if(rem>=len){el.innerHTML='<span class="co-over">'+t("今の長さより短い値を入力してください")+"（"+len.toLocaleString()+" mm）</span>";return;}
  const used=Math.round((len-rem)*100)/100;
  el.textContent=rem===0?t("→ 全部使用として在庫から削除されます"):"→ "+used.toLocaleString()+t(" mm 使用・残り ")+rem.toLocaleString()+t(" mm で登録します");
}
async function submitCo(){
  if(!coTarget)return;
  const person=pickerValue("#coPersonSel","#coPerson");
  if(!person){toast(t("名前を入力してください"));$("#coPersonSel").focus();return;}
  const len=Number(coTarget.len);let usedLen=null;
  if(coMode==="part"){
    const rem=Number($("#coUsed").value);
    if($("#coUsed").value===""||!isFinite(rem)||rem<0){toast(t("残りの長さを入力してください"));$("#coUsed").focus();return;}
    if(rem>=len){toast(t("今の長さより短い値を入力してください（変わっていない場合は登録不要です）"));$("#coUsed").focus();return;}
    usedLen=rem===0?null:Math.round((len-rem)*100)/100;
  }
  const note=$("#coNote").value.trim();
  try{localStorage.setItem(PERSON_KEY,person);}catch(e){}
  if(MODE==="server"){
    try{
      const j=await apiSend("POST","/api/checkout",{id:coTarget.id,person,usedLen,note});
      await refresh();loadHistory();
      toast(j.removed?t("持ち出しを記録しました（全部使用・在庫から削除）"):t("持ち出しを記録しました（残り ")+Number(j.remain).toLocaleString()+" mm）");
      closeCo();
    }catch(e){toast(t("記録に失敗しました: ")+e.message);}
    return;
  }
  // 単体版（localStorage）
  const used=usedLen==null?len:usedLen;
  const remain=Math.round((len-used)*100)/100;
  if(remain<=0){records=records.filter(x=>x.id!==coTarget.id);}
  else{const i=records.findIndex(x=>x.id===coTarget.id);records[i]={...coTarget,len:remain};}
  localHist("checkout",coTarget,{person,note,len_before:len,len_after:remain>0?remain:0});
  saveRecords();renderInventory();runSearch();updateFoot();renderCheckout();renderWorklog();
  toast(remain<=0?t("持ち出しを記録しました（全部使用・在庫から削除）"):t("持ち出しを記録しました（残り ")+remain.toLocaleString()+" mm）");
  closeCo();
}

/* ===================== 履歴の共通部品（作業ログで使用） ===================== */
const HTYPE={checkout:["持ち出し","h-out"],add:["登録","h-in"],edit:["編集","h-edit"],delete:["削除","h-del"],bulk:["CSV取込","h-in"],keyout:["鍵 持出","h-out"],keyin:["鍵 返却","h-in"]};
function fmtTs(t){const d=new Date(t);const p=n=>String(n).padStart(2,"0");return d.getFullYear()+"/"+p(d.getMonth()+1)+"/"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes());}
function fmtDateJ(t){const d=new Date(t);const w=["日","月","火","水","木","金","土"][d.getDay()];const p=n=>String(n).padStart(2,"0");return d.getFullYear()+"/"+p(d.getMonth()+1)+"/"+p(d.getDate())+"（"+w+"）";}
function fmtTime(t){const d=new Date(t);const p=n=>String(n).padStart(2,"0");return p(d.getHours())+":"+p(d.getMinutes());}
function histAmount(x){
  const b=x.len_before,a=x.len_after;
  if(x.type==="checkout"){
    if(b==null)return "—";
    const used=Math.round((b-(a||0))*100)/100;
    return used.toLocaleString()+t(" mm 使用")+(a>0?t("（残り ")+a.toLocaleString()+"）":t("（全部）"));
  }
  if(x.type==="add")return a!=null?"＋ "+a.toLocaleString()+" mm":"—";
  if(x.type==="delete")return b!=null?"− "+b.toLocaleString()+" mm":"—";
  if(x.type==="edit"){if(b!=null&&a!=null&&b!==a)return b.toLocaleString()+" → "+a.toLocaleString()+" mm";return t("内容変更");}
  if(x.type==="bulk")return (x.qty||0)+t(" 件 取込");
  return "—";
}

/* ===================== 作業ログ（管理者・日付別の監視ページ） ===================== */
function renderWorklog(){
  const wrap=$("#worklogWrap");if(!wrap)return;
  if(!history.length){wrap.innerHTML=emptyState("記録はまだありません");return;}
  const asc=[...history].sort((a,b)=>a.ts-b.ts||a.id-b.id);
  /* 倉庫入り（keyout）ごとの解析：その日のうち（次に本人が倉庫入りするまで）に
   * 本人の在庫記録が何件あるか。返却の操作は無い運用（2026-09-23〜） */
  const outs=asc.filter(e=>e.type==="keyout");
  const sessions=outs.map(o=>{
    const dayEnd=new Date(o.ts);dayEnd.setHours(23,59,59,999);
    const next=outs.find(e=>e.person===o.person&&e.ts>o.ts);
    const end=Math.min(dayEnd.getTime(),next?next.ts:Infinity);
    const count=asc.filter(e=>["checkout","add","edit","delete","bulk"].includes(e.type)&&e.person===o.person&&e.ts>=o.ts&&e.ts<=end).length;
    return {person:o.person,out:o.ts,count,recent:(Date.now()-o.ts)<3600e3};
  });
  /* 日付ごとにまとめる（新しい日付が上、日の中は時刻順） */
  const byDate=new Map();
  for(const e of asc){const d=fmtDateJ(e.ts);if(!byDate.has(d))byDate.set(d,[]);byDate.get(d).push(e);}
  let h="";
  for(const d of [...byDate.keys()].reverse()){
    const evs=byDate.get(d);
    const ses=sessions.filter(s=>fmtDateJ(s.out)===d);
    h+=`<div class="wl-day"><div class="wl-date">${d}<span class="wl-daycount">${evs.length}件</span></div>`;
    if(ses.length){
      h+='<div class="wl-sessions">';
      ses.forEach(s=>{
        const noRec=s.count===0&&!s.recent;
        h+=`<div class="wl-ses${noRec?" warn":""}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2M15 8l3 3"/></svg><b>${s.person||"—"}</b>　${fmtTime(s.out)} 倉庫入り　／　その後の在庫記録 ${s.count>0?"<b>"+s.count+"件</b>":(s.recent?"（作業中）":'<span class="wl-bad">0件（記録なし⚠）</span>')}</div>`;
      });
      h+="</div>";
    }
    h+='<div class="tbl-wrap"><table class="dt"><thead><tr><th style="width:64px">時刻</th><th>種別</th><th>名前</th><th>内容</th><th class="r">数量・変化</th><th>メモ</th></tr></thead><tbody>';
    evs.forEach(x=>{
      const t=HTYPE[x.type]||[x.type,"h-edit"];
      const item=x.type==="keyout"?"鋼材倉庫の鍵を持ち出し":x.type==="keyin"?"鋼材倉庫の鍵を返却":x.type==="bulk"?"CSVから一括取込":
        (x.mat?`<span class="pill mat ${matCls(x.mat)}">${IC.mat}${x.mat}</span>`:"")+(x.koshu?shapeIco(x.koshu)+x.koshu:"")+(x.spec?` <span class="tnum">${x.spec}</span>`:"")+(x.thk!=null?` <span class="tnum muted">t${x.thk}</span>`:"");
      h+=`<tr><td class="tnum">${fmtTime(x.ts)}</td><td><span class="pill ${t[1]}" style="white-space:nowrap">${t[0]}</span></td><td>${x.person?"<b>"+x.person+"</b>":'<span class="muted">—</span>'}</td><td>${item||'<span class="muted">—</span>'}</td><td class="r tnum" style="white-space:nowrap">${(x.type==="keyout"||x.type==="keyin")?"—":histAmount(x)}</td><td class="muted" style="font-size:12px">${x.note||""}</td></tr>`;
    });
    h+="</tbody></table></div></div>";
  }
  wrap.innerHTML=h;
}
function exportWorklogCSV(){
  if(!history.length){toast("出力対象がありません");return;}
  const head=["日時","種別","名前","材質","鋼種","板厚(mm)","材料規格","表面仕上げ","保管場所","変更前長さ(mm)","変更後長さ(mm)","件数","メモ"];
  const lines=[head.join(",")];
  history.forEach(x=>{const t=HTYPE[x.type]||[x.type];lines.push([fmtTs(x.ts),t[0],x.person||"",x.mat||"",x.koshu||"",x.thk==null?"":x.thk,x.spec||"",x.fin||"",x.loc||"",x.len_before==null?"":x.len_before,x.len_after==null?"":x.len_after,x.qty==null?"":x.qty,x.note||""].map(csvCell).join(","));});
  const blob=new Blob(["﻿"+lines.join("\r\n")],{type:"text/csv;charset=utf-8"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="作業ログ.csv";a.click();URL.revokeObjectURL(a.href);toast("作業ログ.csv を出力しました");
}

/* ===================== 残材の新規登録（現場向け・スマホ対応） =====================
 * 納入されたばかりの定尺など、まだシステムに無い材料の残りをその場で在庫登録する */
function openNs(){
  fillSelect($("#ns_mat"),matOptions(),"選択してください");
  fillSelect($("#ns_koshu"),[],"先に材質を選択");$("#ns_koshu").disabled=true;
  fillSelect($("#ns_thk"),thkOptions(),"選択");
  fillDatalist($("#dl_nsspec"),[]);
  $("#ns_spec").value="";$("#ns_len").value="";
  fillSelect($("#ns_loc"),locOptions(),"指定なし");
  fillSelect($("#ns_fin"),finOptions("",""),"指定なし");
  setupPersonPicker("#nsPersonSel","#nsPerson");
  $("#nsOverlay").classList.add("show");
  setTimeout(()=>$("#ns_mat").focus(),60);
}
function closeNs(){$("#nsOverlay").classList.remove("show");}
async function submitNs(){
  const rec={mat:$("#ns_mat").value,koshu:$("#ns_koshu").value,thk:$("#ns_thk").value,spec:$("#ns_spec").value.trim(),len:$("#ns_len").value.trim(),loc:$("#ns_loc").value,fin:$("#ns_fin").value};
  const person=pickerValue("#nsPersonSel","#nsPerson");
  if(!rec.mat||!rec.koshu||rec.thk===""||!rec.spec||rec.len===""){toast(t("材質・鋼種・板厚・規格・長さは必須です"));return;}
  if(!(Number(rec.len)>0)){toast(t("残りの長さを入力してください"));$("#ns_len").focus();return;}
  if(!person){toast(t("名前を入力してください"));$("#nsPersonSel").focus();return;}
  try{localStorage.setItem(PERSON_KEY,person);}catch(e){}
  const body={mat:rec.mat,koshu:rec.koshu,thk:Number(rec.thk),spec:rec.spec,len:Number(rec.len),loc:rec.loc,fin:rec.fin,person};
  if(MODE==="server"){
    try{await apiSend("POST","/api/records",body);await refresh();loadHistory();toast(t("残材を登録しました"));closeNs();}
    catch(e){toast(t("保存に失敗しました: ")+e.message);}
    return;
  }
  records.push({id:nextId(),mat:rec.mat,koshu:rec.koshu,thk:Number(rec.thk),spec:rec.spec,len:Number(rec.len),loc:rec.loc,fin:rec.fin});
  localHist("add",rec,{person,len_after:Number(rec.len)});
  saveRecords();renderInventory();runSearch();updateFoot();renderCheckout();renderWorklog();
  toast(t("残材を登録しました"));closeNs();
}

/* ===================== 鋼材倉庫の鍵（QRから開く） ===================== */
/* 鍵置き場のQRから開く。「これから倉庫へ行く」ことを記録するだけ（返却の操作は無し。
 * 鍵はフックに戻すだけでよい。2026-09-23 仕様変更） */
async function openKey(){
  if(MODE!=="server"){toast("鍵の記録はサーバー版でのみ使えます");return;}
  $("#keyOverlay").classList.add("show");
  setupPersonPicker("#keyPersonSel","#keyPerson");
}
function closeKey(){$("#keyOverlay").classList.remove("show");}
async function keyAction(){
  const person=pickerValue("#keyPersonSel","#keyPerson");
  if(!person){toast(t("名前を入力してください"));$("#keyPersonSel").focus();return;}
  try{localStorage.setItem(PERSON_KEY,person);}catch(e){}
  try{
    await apiSend("POST","/api/key",{action:"out",person});
    loadHistory();
    toast(t("鍵の持ち出しを記録しました。行ってらっしゃい！"));
    setTimeout(closeKey,1400);
  }catch(e){toast(e.message);}
}

/* ===================== QR読み取り（スマホ：撮影→解析。HTTP環境でも動く方式） =====================
 * 3段構えで解読を試す：
 *  ① BarcodeDetector（Android Chrome等の端末内蔵デコーダ。最も強い）
 *  ② zxing-wasm（js/vendor に同梱した業界標準デコーダ。iPhone向けの本命）
 *  ③ jsQR（多段リサイズ＋中央切り抜き。最後の砦） */
let zxingReady=false;
function prepZxing(){
  if(zxingReady||!window.ZXingWASM)return;
  try{
    const o={locateFile:(f)=>"js/vendor/"+f};
    if(window.__ZXING_WASM_B64){ /* 単一ファイル版：build.py が埋め込んだ base64 の wasm を直接渡す（file:// では fetch 不可のため） */
      const s=atob(window.__ZXING_WASM_B64);
      const b=new Uint8Array(s.length);
      for(let i=0;i<s.length;i++)b[i]=s.charCodeAt(i);
      o.wasmBinary=b.buffer;
      o.locateFile=()=>"data:application/wasm;base64,"+window.__ZXING_WASM_B64;
    }
    ZXingWASM.prepareZXingModule({overrides:o});
    zxingReady=true;
  }catch(e){}
}
/* 読み取り試行の診断情報（失敗時にサーバへ送って原因を調べる） */
const SCAN_BUILD="2026-09-23.4";
function newScanDiag(file){return{build:SCAN_BUILD,name:file&&file.name,type:file&&file.type,size:file&&file.size,bd:"-",zx:"-",zx2:"-",jq:"-"};}
/* ブラウザの画像デコーダで ImageData 化（HEIC等、zxing内蔵デコーダが開けない形式の救済用） */
async function fileToImageData(blob,max){
  const url=URL.createObjectURL(blob);
  try{
    const img=await new Promise((ok,ng)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=ng;i.src=url;});
    const W=img.naturalWidth||img.width,H=img.naturalHeight||img.height;
    const sc=Math.min(1,(max||2200)/Math.max(W,H));
    const w=Math.max(1,Math.round(W*sc)),h=Math.max(1,Math.round(H*sc));
    const cv=document.createElement("canvas");cv.width=w;cv.height=h;
    const cx=cv.getContext("2d");cx.drawImage(img,0,0,w,h);
    return{data:cx.getImageData(0,0,w,h),W,H};
  }finally{URL.revokeObjectURL(url);}
}
async function decodeQrPhoto(file,d){
  d=d||newScanDiag(file);
  try{
    if("BarcodeDetector" in window){
      const bmp=await createImageBitmap(file);
      d.w=bmp.width;d.h=bmp.height;
      const det=new BarcodeDetector({formats:["qr_code"]});
      const rs=await det.detect(bmp);
      if(bmp.close)bmp.close();
      if(rs&&rs.length&&rs[0].rawValue){d.bd="hit";return rs[0].rawValue;}
      d.bd="miss";
    }else d.bd="none";
  }catch(e){d.bd="err:"+((e&&e.message)||e);}
  try{
    if(window.ZXingWASM){
      prepZxing();
      const rs=await ZXingWASM.readBarcodes(file,{formats:["QRCode"],tryHarder:true,maxNumberOfSymbols:1});
      if(rs&&rs.length&&rs[0].text){d.zx="hit";return rs[0].text;}
      d.zx="miss";
    }else d.zx="none";
  }catch(e){d.zx="err:"+((e&&e.message)||e);}
  try{ /* ②b: HEIC等はzxing内蔵デコーダで開けないので、ブラウザで描画してから再挑戦 */
    if(window.ZXingWASM&&zxingReady&&d.zx!=="hit"){
      const im=await fileToImageData(file,2200);
      if(!d.w){d.w=im.W;d.h=im.H;}
      const rs=await ZXingWASM.readBarcodes(im.data,{formats:["QRCode"],tryHarder:true,maxNumberOfSymbols:1});
      if(rs&&rs.length&&rs[0].text){d.zx2="hit";return rs[0].text;}
      d.zx2="miss";
    }
  }catch(e){d.zx2="err:"+((e&&e.message)||e);}
  try{
    const r=await scanImageFile(file,d);
    d.jq=r?"hit":(typeof jsQR==="function"?"miss":"none");
    return r;
  }catch(e){d.jq="err:"+((e&&e.message)||e);return null;}
}
/* ─── かざすだけスキャナー（カメラ常時起動→自動検出。HTTPSでのみ使える） ─── */
let scanStream=null,scanRunning=false,torchOn=false;
function canLiveScan(){return !!(window.isSecureContext&&navigator.mediaDevices&&navigator.mediaDevices.getUserMedia);}
async function openScanner(){
  $("#scanOverlay").classList.add("show");
  $("#scanStatus").textContent=t("QRラベルを枠に入れてください");
  try{
    scanStream=await navigator.mediaDevices.getUserMedia({
      video:{facingMode:{ideal:"environment"},width:{ideal:1920},height:{ideal:1080}},audio:false});
  }catch(e){
    closeScanner();
    toast(t("カメラを起動できませんでした（許可を確認してください）。かわりに撮影します"));
    $("#scanFile").click();
    return;
  }
  const v=$("#scanVideo");v.srcObject=scanStream;
  try{await v.play();}catch(e){}
  torchOn=false;
  try{ /* ライト（対応端末のみ表示。暗い倉庫向け） */
    const tr=scanStream.getVideoTracks()[0];
    const cap=tr.getCapabilities?tr.getCapabilities():{};
    $("#scanTorch").style.display=cap.torch?"":"none";
  }catch(e){$("#scanTorch").style.display="none";}
  scanRunning=true;
  scanLoop();
}
async function scanLoop(){
  const v=$("#scanVideo");
  const det=("BarcodeDetector" in window)?new BarcodeDetector({formats:["qr_code"]}):null;
  prepZxing();
  const cv=document.createElement("canvas");
  while(scanRunning){
    if(v.readyState>=2&&v.videoWidth){
      try{
        let text=null;
        if(det){
          const rs=await det.detect(v);
          if(rs&&rs.length&&rs[0].rawValue)text=rs[0].rawValue;
        }
        if(!text&&window.ZXingWASM&&zxingReady){
          const W=v.videoWidth,H=v.videoHeight,sc=Math.min(1,800/Math.max(W,H));
          cv.width=Math.max(1,Math.round(W*sc));cv.height=Math.max(1,Math.round(H*sc));
          const cx=cv.getContext("2d");cx.drawImage(v,0,0,cv.width,cv.height);
          const rs=await ZXingWASM.readBarcodes(cx.getImageData(0,0,cv.width,cv.height),
            {formats:["QRCode"],tryHarder:true,maxNumberOfSymbols:1});
          if(rs&&rs.length&&rs[0].text)text=rs[0].text;
        }
        if(!text&&!det&&!window.ZXingWASM&&typeof jsQR==="function"){
          const W=v.videoWidth,H=v.videoHeight,sc=Math.min(1,800/Math.max(W,H));
          cv.width=Math.max(1,Math.round(W*sc));cv.height=Math.max(1,Math.round(H*sc));
          const cx=cv.getContext("2d");cx.drawImage(v,0,0,cv.width,cv.height);
          const dd=cx.getImageData(0,0,cv.width,cv.height);
          const r=jsQR(dd.data,cv.width,cv.height,{inversionAttempts:"dontInvert"});
          if(r&&r.data)text=r.data;
        }
        if(text){
          closeScanner();
          if(!handleScanText(text))toast(t("このシステムのQRではないようです"));
          return;
        }
      }catch(e){}
    }
    await new Promise(r=>setTimeout(r,240));
  }
}
function closeScanner(){
  scanRunning=false;
  if(scanStream){try{scanStream.getTracks().forEach(tr=>tr.stop());}catch(e){}scanStream=null;}
  const v=$("#scanVideo");if(v)v.srcObject=null;
  $("#scanOverlay").classList.remove("show");
}
async function toggleTorch(){
  try{
    const tr=scanStream&&scanStream.getVideoTracks()[0];if(!tr)return;
    torchOn=!torchOn;
    await tr.applyConstraints({advanced:[{torch:torchOn}]});
  }catch(e){}
}

/* 読めなかった写真＋端末情報をサーバへ送る（調査用。失敗しても黙って続行） */
function reportScanFail(blob,diag){
  if(MODE!=="server")return;
  try{
    const meta=Object.assign({},diag||{},{ua:navigator.userAgent,at:new Date().toISOString()});
    fetch("/api/scanfail",{method:"POST",
      headers:{"Content-Type":"application/octet-stream","X-Scan-Meta":encodeURIComponent(JSON.stringify(meta))},
      body:blob}).catch(()=>{});
  }catch(e){}
}
async function scanImageFile(file,d){
  if(typeof jsQR!=="function")return null;
  const url=URL.createObjectURL(file);
  try{
    const img=await new Promise((ok,ng)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=ng;i.src=url;});
    const W=img.naturalWidth||img.width,H=img.naturalHeight||img.height;
    if(d&&!d.w){d.w=W;d.h=H;}
    /* スマホ写真は大きく、QRが小さく写ることも多い。
     * 解像度を変えた全体→中央部分の切り抜き、の順で粘り強く試す */
    const tries=[
      {max:1600,crop:0},{max:2400,crop:0},{max:1100,crop:0},
      {max:1600,crop:.6},{max:2400,crop:.6},{max:1600,crop:.4}
    ];
    for(const tr of tries){
      let sx=0,sy=0,sw=W,sh=H;
      if(tr.crop){sw=Math.round(W*tr.crop);sh=Math.round(H*tr.crop);sx=Math.round((W-sw)/2);sy=Math.round((H-sh)/2);}
      const sc=Math.min(1,tr.max/Math.max(sw,sh));
      const w=Math.max(1,Math.round(sw*sc)),h=Math.max(1,Math.round(sh*sc));
      const cv=document.createElement("canvas");cv.width=w;cv.height=h;
      const cx=cv.getContext("2d");cx.drawImage(img,sx,sy,sw,sh,0,0,w,h);
      const d=cx.getImageData(0,0,w,h);
      const r=jsQR(d.data,w,h,{inversionAttempts:"attemptBoth"});
      if(r&&r.data)return r.data;
      await new Promise(res=>setTimeout(res,0)); /* 固まらないように一息入れる */
    }
    return null;
  }finally{URL.revokeObjectURL(url);}
}
/* 読み取った文字列に応じて画面を開く（材料QR=?co / 鍵QR=?key） */
function handleScanText(text){
  let co=null,key=null;
  try{const u=new URL(String(text));co=u.searchParams.get("co");key=u.searchParams.get("key");}
  catch(e){const m=String(text).match(/co=(\d+)/);if(m)co=m[1];if(/[?&]key=/.test(String(text)))key="1";}
  if(key!=null){openKey();return true;}
  if(co!=null){
    const rec=records.find(x=>String(x.id)===String(co));
    if(rec)openCo(rec.id);
    else toast(t("この在庫は見つかりません（すでに使い切った可能性があります）"));
    return true;
  }
  return false;
}

/* ===================== QRラベル印刷（サーバー版のみ） ===================== */
function qrServerBase(){return(qrBase||location.origin+"/").replace(/\/+$/,"")+"/";}
function qrUrl(id){return qrServerBase()+"?co="+id;}
let qrTargetIds=null; /* いま印刷モーダルに出している在庫ID（鍵QRのときはnull） */
function openQr(ids){
  const list=records.filter(r=>ids.includes(r.id));
  if(!list.length){toast("印刷対象の在庫がありません");return;}
  qrTargetIds=list.map(r=>r.id);
  const unprinted=records.filter(r=>!r.qr).length;
  $("#qrNote").innerHTML="ラベルを切り取って<b>材料（または棚）に貼って</b>ください。スマホのカメラで読み取ると、その材料の<b>持ち出し画面が直接開きます</b>。<br>リンク先：<b class=\"tnum\">"+qrServerBase()+"</b>／印刷すると各在庫に<b>「✔済」の目印</b>が付きます（全体で未印刷 "+unprinted+" 件）";
  let h="";
  for(const r of list){
    let q="";try{q=QR.svg(qrUrl(r.id),"Q");}catch(e){} /* 印刷は誤り訂正Q（汚れに強い） */
    h+=`<div class="qr-label"><div class="qr-svg">${q}</div><div class="qr-txt"><b>${r.mat} ${r.koshu}</b><span class="tnum">${r.spec} × t${r.thk}</span><span>長さ ${Number(r.len).toLocaleString()}mm</span><span>${r.loc||""}${r.fin?"・"+r.fin:""}</span><span class="qr-id">No.${r.id}</span></div></div>`;
  }
  $("#qrSheet").innerHTML=h;
  $("#qrCount").textContent=list.length+" 枚";
  $("#qrOverlay").classList.add("show");
}
function closeQr(){$("#qrOverlay").classList.remove("show");}
/* 印刷後に「印刷済み」の目印を付ける（印刷ダイアログを閉じた後に確認） */
async function markPrinted(){
  if(MODE!=="server"||!qrTargetIds||!qrTargetIds.length)return;
  const ids=qrTargetIds;
  if(!confirm(ids.length+" 件の在庫に「ラベル印刷済み ✔」の目印を付けますか？\n（印刷をキャンセルした場合は「キャンセル」を押してください）"))return;
  try{
    await apiSend("POST","/api/labeled",{ids});
    await refresh();
    toast(ids.length+" 件に印刷済みの目印を付けました");
  }catch(e){toast("目印の保存に失敗しました: "+e.message);}
}
function openKeyQr(){
  qrTargetIds=null;
  $("#qrNote").innerHTML="このラベルを<b>鋼材倉庫の鍵の保管場所に貼ってください</b>。スマホで読み取ると「鍵の持ち出し／返却」画面が開き、誰がいつ倉庫へ行ったかが記録されます。";
  let q="";try{q=QR.svg(qrServerBase()+"?key=1","Q");}catch(e){}
  $("#qrSheet").innerHTML=`<div class="qr-label"><div class="qr-svg">${q}</div><div class="qr-txt"><b>鋼材倉庫の鍵</b><span>行く前・返す時に</span><span>スマホで読み取り</span><span class="qr-id">KEY</span></div></div>`;
  $("#qrCount").textContent="1 枚";
  $("#qrOverlay").classList.add("show");
}

/* ===================== 計算ビュー ===================== */
function initCalc(){
  fillSelect($("#c_mat"),MATERIALS,"選択してください");
  fillSelect($("#c_koshu"),[],"先に材質を選択");$("#c_koshu").disabled=true;
  fillSelect($("#c_thk"),THICKNESS,"選択");
  fillSelect($("#c_fin"),FINISH_ALL,"指定なし");
  $("#c_mat").addEventListener("change",()=>{const m=$("#c_mat").value;if(m){fillSelect($("#c_koshu"),KOSHU_BY_MAT[m],"選択してください");$("#c_koshu").disabled=false;}else{fillSelect($("#c_koshu"),[],"先に材質を選択");$("#c_koshu").disabled=true;}calcSpecFin();calcRun();});
  $("#c_koshu").addEventListener("change",()=>{calcSpecFin();calcRun();});
  ["#c_thk","#c_fin"].forEach(s=>$(s).addEventListener("change",calcRun));
  ["#c_spec","#c_len"].forEach(s=>$(s).addEventListener("input",calcRun));
}
function calcSpecFin(){const m=$("#c_mat").value,k=$("#c_koshu").value;fillDatalist($("#dl_cspec"),k&&KIKAKU_BY_KOSHU[k]?KIKAKU_BY_KOSHU[k]:[]);if(m&&k){fillSelect($("#c_fin"),finishOptions(m,k),"指定なし");}else fillSelect($("#c_fin"),FINISH_ALL,"指定なし");}
function calcRun(){
  const r={mat:$("#c_mat").value,koshu:$("#c_koshu").value,thk:$("#c_thk").value,spec:$("#c_spec").value.trim(),len:$("#c_len").value.trim(),fin:$("#c_fin").value};
  const c=compute(r);
  $("#rcCost").innerHTML=c.cost==null?'<small>¥</small>—':'<small>¥</small>'+Math.round(c.cost).toLocaleString("ja-JP");
  $("#rcArea").innerHTML=c.area==null?'—<small>mm²</small>':fmtNum(c.area,2)+'<small>mm²</small>';
  $("#rcWeight").innerHTML=c.weight==null?'—<small>kg</small>':fmtKg(c.weight)+'<small>kg</small>';
  $("#rcDens").textContent=r.mat?density(r.mat):"—";
  $("#rcUnit").innerHTML=c.unit==null?'—<small>円/kg</small>':c.unit.toLocaleString()+'<small>円/kg</small>';
  const sh=$("#rcShape");if(sh){if(r.koshu){sh.style.display="flex";sh.innerHTML='<div class="sh-ic">'+shapeSVG(r.koshu)+'</div><div class="sh-txt"><span class="sh-name">'+r.koshu+'</span><span class="sh-sub">'+(r.mat||"材質未選択")+'</span></div>';}else{sh.style.display="none";sh.innerHTML="";}}
  const fd=formulaDesc(r.koshu);
  if(fd&&r.spec&&r.thk!==""){const{d1,d2}=dims(r.spec);$("#rcFormula").innerHTML=`断面積 = ${fd.f}<br>＝ ${c.area!=null?fmtNum(c.area,2):"—"} mm²　(寸法 ${d1}${d2?(" × "+d2):""}, 厚 ${r.thk})<br>重量 = 断面積 × 長さ × 比重 ÷ 1,000,000<br>材料費 = 重量 × キロ単価`;}
  else $("#rcFormula").textContent="材質・鋼種・寸法を入力してください。";
}

/* ===================== マスタビュー（管理者が編集可能） ===================== */
const M_DEL='<button class="icobtn del m-del" title="行を削除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button>';
const mIn=(f,v,type,extra)=>`<input class="m-in${type==="number"?" num":""}" type="${type}" data-f="${f}" value="${v==null?"":String(v).replace(/"/g,"&quot;")}"${extra?" "+extra:""}>`;
function mDrow(m,d){return `<tr data-drow><td style="width:170px">${mIn("mat",m,"text",'placeholder="例: SUS304"')}</td><td class="r" style="width:110px">${mIn("val",d,"number",'step="0.01" min="0"')}</td><td class="r">${M_DEL}</td></tr>`;}
function mProw(p){return `<tr data-prow><td>${mIn("mat",p.mat,"text",'placeholder="例: SUS304"')}</td><td>${mIn("koshu",p.koshu,"text",'placeholder="例: 化粧管"')}</td><td>${mIn("fin",p.fin||"","text",'placeholder="不問"')}</td><td class="r" style="width:110px">${mIn("price",p.price,"number",'step="1" min="0"')}</td><td class="r">${M_DEL}</td></tr>`;}
function mFrow(k,fk){
  let s='<select class="m-in" data-f="formula">';
  Object.entries(AREA_FORMULAS).forEach(([key,v])=>{s+=`<option value="${key}"${key===fk?" selected":""}>${v.label}</option>`;});
  s+="</select>";
  const v=AREA_FORMULAS[fk]||AREA_FORMULAS.round;
  return `<tr data-frow><td style="width:200px">${mIn("koshu",k,"text",'placeholder="例: 化粧管"')}</td><td style="width:170px">${s}</td><td class="tnum" data-fdesc>${v.f}</td><td class="muted" data-fview style="font-size:11.5px">${v.view}</td><td class="r">${M_DEL}</td></tr>`;
}
function renderMasters(){
  let h='<table class="dt"><thead><tr><th>材質</th><th class="r">比重</th><th></th></tr></thead><tbody>';
  Object.entries(DENSITY).forEach(([m,d])=>{h+=mDrow(m,d);});
  h+='</tbody></table><div class="m-addwrap"><button class="btn ghost sm m-add" data-add="density"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>行を追加</button></div>';
  $("#mDensity").innerHTML=h;

  h='<table class="dt"><thead><tr><th>材質</th><th>鋼種</th><th>仕上げ（空欄＝不問）</th><th class="r">単価(円/kg)</th><th></th></tr></thead><tbody>';
  PRICE.forEach(p=>{h+=mProw(p);});
  h+='</tbody></table><div class="m-addwrap"><button class="btn ghost sm m-add" data-add="price"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>行を追加</button></div>';
  $("#mPrice").innerHTML=h;

  h='<table class="dt"><thead><tr><th>鋼種</th><th>適用する式</th><th>断面積 (mm²) の式</th><th>サイズの見方</th><th></th></tr></thead><tbody>';
  Object.entries(KOSHU_FORMULA).forEach(([k,fk])=>{h+=mFrow(k,fk);});
  h+='</tbody></table><div class="m-addwrap"><button class="btn ghost sm m-add" data-add="formula"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>鋼種を追加</button></div>';
  $("#mFormula").innerHTML=h;

  h='<table class="dt"><thead><tr><th>鋼種</th><th>材料規格候補</th></tr></thead><tbody>';
  Object.entries(KIKAKU_BY_KOSHU).forEach(([k,arr])=>{h+=`<tr><td>${shapeIco(k)}<b>${k}</b></td><td>${arr.map(x=>'<span class="pill fin" style="margin:2px 3px 2px 0">'+x+'</span>').join("")}</td></tr>`;});
  h+="</tbody></table>";$("#mSpec").innerHTML=h;

  h='<table class="dt"><thead><tr><th>名前</th><th></th></tr></thead><tbody>';
  STAFF.forEach(s=>{h+=mSrow(s);});
  h+='</tbody></table><div class="m-addwrap"><button class="btn ghost sm m-add" data-add="staff"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>名前を追加</button></div>';
  const ms=$("#mStaff");if(ms)ms.innerHTML=h;
}
function mSrow(v){return `<tr data-srow><td>${mIn("name",v,"text",'placeholder="例: 山田"')}</td><td class="r">${M_DEL}</td></tr>`;}
/* 画面のテーブルからマスタを読み取る（空行・不正値は除外） */
function collectMasters(){
  const density={};
  document.querySelectorAll("#mDensity [data-drow]").forEach(tr=>{
    const m=tr.querySelector('[data-f="mat"]').value.trim();
    const d=Number(tr.querySelector('[data-f="val"]').value);
    if(m&&isFinite(d)&&d>0)density[m]=d;
  });
  const price=[];
  document.querySelectorAll("#mPrice [data-prow]").forEach(tr=>{
    const mat=tr.querySelector('[data-f="mat"]').value.trim();
    const koshu=tr.querySelector('[data-f="koshu"]').value.trim();
    const fin=tr.querySelector('[data-f="fin"]').value.trim();
    const pr=Number(tr.querySelector('[data-f="price"]').value);
    if(mat&&koshu&&isFinite(pr)&&pr>=0)price.push({mat,koshu,fin:fin||null,price:pr});
  });
  const koshuFormula={};
  document.querySelectorAll("#mFormula [data-frow]").forEach(tr=>{
    const k=tr.querySelector('[data-f="koshu"]').value.trim();
    const key=tr.querySelector('[data-f="formula"]').value;
    if(k&&AREA_FORMULAS[key])koshuFormula[k]=key;
  });
  const staff=[];
  document.querySelectorAll("#mStaff [data-srow]").forEach(tr=>{
    const v=tr.querySelector('[data-f="name"]').value.trim();
    if(v&&!staff.includes(v))staff.push(v);
  });
  return{density,price,koshuFormula,staff};
}
async function saveMasters(reset){
  if(reset&&!confirm("単価・比重・式の割り当てを、プログラムの既定値に戻しますか？"))return;
  const masters=reset?null:collectMasters();
  if(!reset&&(!Object.keys(masters.density).length||!masters.price.length||!Object.keys(masters.koshuFormula).length)){toast("比重・単価・式の各表に1行以上必要です");return;}
  if(MODE==="server"){
    try{const j=await apiSend("PUT","/api/masters",{pin:ADMIN_PIN,masters});mastersV=j.mv||mastersV+1;}
    catch(e){toast("保存に失敗しました: "+e.message);return;}
  }else{
    try{if(masters)localStorage.setItem(MASTERS_KEY,JSON.stringify(masters));else localStorage.removeItem(MASTERS_KEY);}
    catch(e){toast("保存に失敗しました");return;}
  }
  applyMasters(masters);
  renderMasters();renderInventory();runSearch();renderCheckout();
  toast(reset?"マスタを初期値に戻しました":(MODE==="server"?"マスタを保存しました（全PCに反映されます）":"マスタを保存しました"));
}

/* ===================== CSV ===================== */
function exportCSV(rows,fname){
  const head=["材質","鋼種","板厚(mm)","材料規格","長さ(mm)","保管場所","表面仕上げ","重量(kg)","キロ単価","材料費"];
  const lines=[head.join(",")];
  rows.forEach(r=>{const c=compute(r);lines.push([r.mat,r.koshu,r.thk,r.spec,r.len,r.loc||"",r.fin||"",c.weight==null?"":c.weight,c.unit==null?"":c.unit,c.cost==null?"":c.cost].map(csvCell).join(","));});
  const blob=new Blob(["\uFEFF"+lines.join("\r\n")],{type:"text/csv;charset=utf-8"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=fname;a.click();URL.revokeObjectURL(a.href);toast(fname+" を出力しました");
}
function csvCell(v){v=String(v==null?"":v);return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v;}
async function importCSV(text){
  const lines=text.replace(/^\uFEFF/,"").split(/\r?\n/).filter(l=>l.trim());
  if(lines.length<2){toast("取込できる行がありません");return;}
  const rows=[];
  for(let i=1;i<lines.length;i++){
    const c=parseCSVLine(lines[i]);if(c.length<5)continue;
    const rec={mat:c[0].trim(),koshu:c[1].trim(),thk:Number(c[2]),spec:c[3].trim(),len:Number(c[4]),loc:(c[5]||"").trim(),fin:(c[6]||"").trim()};
    if(!rec.mat||!rec.koshu||!rec.spec||!isFinite(rec.thk)||!isFinite(rec.len))continue;
    rows.push(rec);
  }
  if(MODE==="server"){
    try{const j=await apiSend("POST","/api/records/bulk",{rows});await refresh();toast((j.added||0)+" 件を取り込みました");}
    catch(e){toast("取込に失敗しました: "+e.message);}
    return;
  }
  let added=0;
  for(const rec of rows){records.push({id:nextId(),...rec});added++;}
  if(added>0)localHist("bulk",{},{qty:added});
  saveRecords();renderInventory();runSearch();updateFoot();renderCheckout();renderWorklog();toast(added+" 件を取り込みました");
}
function parseCSVLine(line){const out=[];let cur="",q=false;for(let i=0;i<line.length;i++){const ch=line[i];if(q){if(ch==='"'){if(line[i+1]==='"'){cur+='"';i++;}else q=false;}else cur+=ch;}else{if(ch===','){out.push(cur);cur="";}else if(ch==='"')q=true;else cur+=ch;}}out.push(cur);return out;}

/* ===================== フッター / 初期化 ===================== */
function updateFoot(){
  $("#footCount").textContent=records.length+" 件";
  if(MODE==="server"){$("#footStore").textContent="サーバー保存（共有）";$("#footDot").className="dot";}
  else{$("#footStore").innerHTML=canPersist?'ローカル保存':'<span style="color:var(--accent)">セッションのみ</span>';$("#footDot").className=canPersist?"dot":"dot warn";}
}
async function init(){
  await loadRecords();
  await loadMasters();
  applyLang();
  $("#langBtn").addEventListener("click",toggleLang);
  initSearchControls();updateSpecDatalist();
  initCheckoutControls();
  initCalc();
  setupCascade($("#m_mat"),$("#m_koshu"),$("#m_spec"),$("#dl_mspec"),$("#m_fin"),$("#m_thk"));
  ["#m_mat","#m_koshu","#m_thk","#m_fin","#m_loc"].forEach(s=>$(s).addEventListener("change",modalPreview));
  ["#m_spec","#m_len"].forEach(s=>$(s).addEventListener("input",modalPreview));
  $("#btnNew").addEventListener("click",()=>openModal(null));
  $("#modalClose").addEventListener("click",closeModal);$("#modalCancel").addEventListener("click",closeModal);
  $("#modalSave").addEventListener("click",saveModal);
  $("#modalDelete").addEventListener("click",()=>{if(editId){delRecord(editId);closeModal();}});
  $("#overlay").addEventListener("click",e=>{if(e.target===$("#overlay"))closeModal();});
  $("#coClose").addEventListener("click",closeCo);$("#coCancel").addEventListener("click",closeCo);
  $("#coSubmit").addEventListener("click",submitCo);
  $("#coModeAll").addEventListener("click",()=>{coMode="all";applyCoMode();});
  $("#coModePart").addEventListener("click",()=>{coMode="part";applyCoMode();});
  $("#coUsed").addEventListener("input",coUpdateRemain);
  $("#coPerson").addEventListener("keydown",e=>{if(e.key==="Enter")submitCo();});
  $("#coOverlay").addEventListener("click",e=>{if(e.target===$("#coOverlay"))closeCo();});
  $("#btnQrAll").addEventListener("click",()=>openQr(records.map(r=>r.id)));
  $("#btnQrKey").addEventListener("click",openKeyQr);
  $("#keyClose").addEventListener("click",closeKey);
  $("#btnKeyOut").addEventListener("click",keyAction);
  $("#keyOverlay").addEventListener("click",e=>{if(e.target===$("#keyOverlay"))closeKey();});
  $("#keyPerson").addEventListener("keydown",e=>{if(e.key==="Enter")keyAction();});
  $("#btnWorklogRefresh").addEventListener("click",()=>{loadHistory();toast("作業ログを更新しました");});
  $("#btnExportWorklog").addEventListener("click",exportWorklogCSV);
  /* 残材の新規登録（現場向け） */
  $("#btnNewStock").addEventListener("click",openNs);
  $("#nsClose").addEventListener("click",closeNs);$("#nsCancel").addEventListener("click",closeNs);
  $("#nsSubmit").addEventListener("click",submitNs);
  $("#nsOverlay").addEventListener("click",e=>{if(e.target===$("#nsOverlay"))closeNs();});
  $("#ns_mat").addEventListener("change",()=>{
    const m=$("#ns_mat").value;
    if(m){fillSelect($("#ns_koshu"),koshuOptions(m),"選択してください");$("#ns_koshu").disabled=false;}
    else{fillSelect($("#ns_koshu"),[],"先に材質を選択");$("#ns_koshu").disabled=true;}
    fillDatalist($("#dl_nsspec"),[]);
    fillSelect($("#ns_fin"),finOptions(m,$("#ns_koshu").value),"指定なし");
  });
  $("#ns_koshu").addEventListener("change",()=>{
    const k=$("#ns_koshu").value;
    fillDatalist($("#dl_nsspec"),k?specOptions(k):[]);
    fillSelect($("#ns_fin"),finOptions($("#ns_mat").value,k),"指定なし");
  });
  /* QR読み取り（スマホ：カメラで撮影→解析。#scanFile2 はカメラ強制なしの「写真から選ぶ」） */
  const onScanPhoto=async e=>{
    const f=e.target.files[0];e.target.value="";if(!f)return;
    toast(t("読み取り中…"));
    /* iOSでは input 由来の File が数秒後に読めなくなることがあるため、先に中身を確保しておく */
    let blob=f;
    try{blob=new Blob([await f.arrayBuffer()],{type:f.type||"image/jpeg"});}catch(err){}
    const d=newScanDiag(f);
    let text=null;
    try{text=await decodeQrPhoto(blob,d);}catch(err){}
    if(text){
      if(!handleScanText(text))toast(t("このシステムのQRではないようです"));
      return;
    }
    if(MODE==="server"){
      reportScanFail(blob,d); /* 写真を調査用に自動送信 */
      toast(t("読み取れませんでした（写真は調査用に送信済み）。スマホのカメラアプリで大きく撮ってから「写真から選ぶ」も試してください"));
    }else{
      toast(t("QRを読み取れませんでした。ラベルに近づけて撮り直してください"));
    }
  };
  /* HTTPSなら「かざすだけ」ライブスキャナー、HTTPなら従来の撮影方式 */
  $("#btnScan").addEventListener("click",()=>{if(canLiveScan())openScanner();else $("#scanFile").click();});
  $("#btnScanAlt").addEventListener("click",()=>$("#scanFile2").click());
  $("#scanFile").addEventListener("change",onScanPhoto);
  $("#scanFile2").addEventListener("change",onScanPhoto);
  $("#scanClose").addEventListener("click",closeScanner);
  $("#scanTorch").addEventListener("click",toggleTorch);
  $("#scanOverlay").addEventListener("click",e=>{if(e.target===$("#scanOverlay"))closeScanner();});
  $("#qrClose").addEventListener("click",closeQr);$("#qrCancel").addEventListener("click",closeQr);
  $("#qrPrint").addEventListener("click",()=>{document.body.classList.add("qr-printing");window.print();});
  window.addEventListener("afterprint",()=>{
    const was=document.body.classList.contains("qr-printing");
    document.body.classList.remove("qr-printing");
    if(was)setTimeout(markPrinted,300);
  });
  $("#qrOnlyNew").addEventListener("click",()=>{
    const ids=records.filter(r=>!r.qr).map(r=>r.id);
    if(!ids.length){toast("未印刷の在庫はありません（すべて印刷済み）");return;}
    openQr(ids);
  });
  $("#qrOverlay").addEventListener("click",e=>{if(e.target===$("#qrOverlay"))closeQr();});
  if(MODE!=="server"){ /* QRラベル印刷はサーバー版のみ（ラベルにサーバーURLを埋めるため） */
    $("#btnQrAll").style.display="none";$("#btnQrKey").style.display="none";
    /* 読み取りはデコーダ（jsQR / zxing-wasm）が同梱されていれば単一ファイル版でも使える。
     * どのデコーダも無い環境（想定外）だけボタンを隠す */
    if(typeof jsQR!=="function"&&!window.ZXingWASM&&!("BarcodeDetector" in window)){
      $("#btnScan").style.display="none";$("#btnScanAlt").style.display="none";
    }
  }
  document.addEventListener("keydown",e=>{
    if(e.key==="Escape"){closeModal();closePin();closeHelp();closeCo();closeQr();closeKey();closeNs();closeScanner();}
    else if(e.key==="?"||e.key==="F1"){const t=(document.activeElement||{}).tagName;if(t!=="INPUT"&&t!=="SELECT"&&t!=="TEXTAREA"){e.preventDefault();openHelp();}}
  });
  $("#btnExportSearch").addEventListener("click",()=>{if(!lastSearch.length){toast("出力対象がありません");return;}exportCSV(lastSearch,"検索結果.csv");});
  $("#btnExportInv").addEventListener("click",()=>exportCSV(records,"在庫データ.csv"));
  $("#btnImport").addEventListener("click",()=>$("#fileInput").click());
  $("#fileInput").addEventListener("change",e=>{const f=e.target.files[0];if(!f)return;const rd=new FileReader();rd.onload=()=>importCSV(rd.result);rd.readAsText(f);e.target.value="";});
  $("#adminBtn").addEventListener("click",()=>{if(isAdmin){isAdmin=false;applyAdmin();toast("管理者モードを解除しました");}else openPin();});
  /* マスタ設定（管理者）：保存・初期化・行の追加/削除・式選択の表示更新 */
  $("#btnMastersSave").addEventListener("click",()=>saveMasters(false));
  $("#btnMastersReset").addEventListener("click",()=>saveMasters(true));
  $("#view-master").addEventListener("click",e=>{
    const del=e.target.closest(".m-del");if(del){del.closest("tr").remove();return;}
    const add=e.target.closest(".m-add");
    if(add){
      const tb=add.closest(".tbl-wrap").querySelector("tbody");
      const kind=add.dataset.add;
      if(kind==="density")tb.insertAdjacentHTML("beforeend",mDrow("",""));
      else if(kind==="price")tb.insertAdjacentHTML("beforeend",mProw({mat:"",koshu:"",fin:null,price:""}));
      else if(kind==="staff")tb.insertAdjacentHTML("beforeend",mSrow(""));
      else tb.insertAdjacentHTML("beforeend",mFrow("","round"));
      const last=tb.lastElementChild.querySelector("input");if(last)last.focus();
    }
  });
  $("#view-master").addEventListener("change",e=>{
    const sel=e.target.closest('select[data-f="formula"]');
    if(sel){const v=AREA_FORMULAS[sel.value];const tr=sel.closest("tr");
      const fd=tr.querySelector("[data-fdesc]");if(fd)fd.textContent=v.f;
      const fv=tr.querySelector("[data-fview]");if(fv)fv.textContent=v.view;}
  });
  $("#pinClose").addEventListener("click",closePin);$("#pinCancel").addEventListener("click",closePin);$("#pinSubmit").addEventListener("click",submitPin);
  $("#pinInput").addEventListener("keydown",e=>{if(e.key==="Enter")submitPin();else if(e.key==="Escape")closePin();});
  $("#pinOverlay").addEventListener("click",e=>{if(e.target===$("#pinOverlay"))closePin();});
  $("#helpBtn").addEventListener("click",openHelp);$("#helpClose").addEventListener("click",closeHelp);$("#helpOk").addEventListener("click",closeHelp);
  $("#helpOverlay").addEventListener("click",e=>{if(e.target===$("#helpOverlay"))closeHelp();});
  applyAdmin();
  /* スキャン方式の案内：HTTPS＝「かざすだけ」なのでヒント不要。HTTPのスマホにはHTTPSへの誘導リンクを出す */
  const _sh=document.querySelector(".scan-hint");
  if(_sh){
    if(canLiveScan())_sh.style.display="none";
    else if(MODE==="server"&&httpsBase){
      _sh.removeAttribute("data-i18n");
      _sh.innerHTML='<a href="'+httpsBase+'">'+t("かざすだけで読み取れる新アドレスはこちら（初回だけ警告→「詳細」→閲覧を許可）")+"</a>";
    }
  }
  renderInventory();renderMasters();runSearch();updateFoot();renderCheckout();
  await loadHistory(); /* 名前の選択肢に履歴の名前を使うため、QR直開きの前に読み込みを終える */
  const _n=new Date(),_w=["日","月","火","水","木","金","土"][_n.getDay()];
  const _hd=$("#hdrDate");if(_hd)_hd.textContent=_n.getFullYear()+"/"+String(_n.getMonth()+1).padStart(2,"0")+"/"+String(_n.getDate()).padStart(2,"0")+"（"+_w+"）";
  startPolling();
  /* QRから開かれたとき：?co=在庫ID → 持ち出し画面 ／ ?key=1 → 鍵の持出・返却画面 */
  const qs=new URLSearchParams(location.search);
  const coParam=qs.get("co"),keyParam=qs.get("key");
  if(coParam!=null||keyParam!=null){
    window.history.replaceState(null,"",location.pathname); /* 再読込で再度開かないようURLを掃除 */
  }
  if(coParam!=null){
    const tab=document.querySelector('.tab[data-view="checkout"]');if(tab)tab.click();
    const rec=records.find(x=>String(x.id)===String(coParam));
    if(rec)openCo(rec.id);
    else toast(t("この在庫は見つかりません（すでに使い切った可能性があります）"));
  }else if(window.matchMedia("(max-width: 760px)").matches){
    /* スマホは持ち出し画面だけのシンプル表示（タブ等はCSSで非表示） */
    const tb=document.querySelector('.tab[data-view="checkout"]');if(tb)tb.click();
    if(keyParam!=null)openKey();
  }else if(keyParam!=null){
    openKey();
  }
}
init();
