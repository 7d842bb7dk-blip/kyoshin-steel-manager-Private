// ─────────────────────────────────────────────────────────────
// 使い方マニュアルのスクリーンショットを、本物の画面から自動で撮るスクリプト（2026-10-03）
//   1) 本番DBのコピーでテスト用サーバーを 3095 番で起動する（本番には触らない）
//        例：git worktree で別フォルダを作り、server/data/app.db にコピーを置いて
//            PORT=3095 HOST=127.0.0.1 HTTPS_PORT=3495 HTTP80=0 AUTO_UPDATE_SEC=0 node server/index.js
//   2) node capture-demo.js   … 見本の予約・材料をテスト用サーバーに入れる
//   3) node capture.js shots  … shots/ に撮影（rects.json に部品の位置も出る）
//   4) python crops.py        … 拡大図（shots/crop/）を作り直す → HTML を Edge で PDF にする
// ─────────────────────────────────────────────────────────────
// マニュアル用の見本データ（テスト用サーバー 3095・本番のコピーにだけ入れる）
const B="http://127.0.0.1:3095";
const j=async(m,p,b)=>{const r=await fetch(B+p,{method:m,headers:{"Content-Type":"application/json"},body:b?JSON.stringify(b):undefined});return r.json();};
const day=n=>{const d=new Date(Date.now()+n*86400000),p=x=>String(x).padStart(2,"0");return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate());};
(async()=>{
  console.log(await j("POST","/api/reservations",{record_id:453,person:"山田 太郎",date:day(5),job:"〇〇工場 手すり"}));
  console.log(await j("POST","/api/reservations",{record_id:392,person:"佐藤 次郎",date:day(2),job:"△△様 架台"}));
  console.log(await j("POST","/api/reservations",{record_id:44,person:"鈴木 三郎",date:day(5),job:"〇〇工場 手すり"}));
  for(const loc of ["A-7","A-7","B-7"])console.log(await j("POST","/api/records",{mat:"SS400",koshu:"フラットバー",thk:9,spec:"9×50",len:2000,loc,fin:"",person:"見本"}));
})();
