// ─────────────────────────────────────────────────────────────
// db.js — SQLite 初期化と在庫レコードの CRUD
//   ・在庫は1つの app.db に集約（全PCで共有）。
//   ・DBは「入力素データ(mat/koshu/thk/spec/len/loc/fin)」のみ保持。
//     重量・キロ単価・材料費はクライアント compute() が算出（計算ロジックの二重持ちを避ける）。
//   ・更新のたび meta.version を +1。クライアントは version の増加で他PCの変更を検知する。
// ─────────────────────────────────────────────────────────────
const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DB_DIR ? path.resolve(process.env.DB_DIR) : path.join(__dirname, "data");
const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(DATA_DIR, "app.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");   // 複数PCからの同時アクセスに強い（ローカルディスク前提）
db.pragma("synchronous = NORMAL");

// ── スキーマ ──
db.exec(`
  CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mat TEXT, koshu TEXT, thk REAL, spec TEXT, len REAL,
    loc TEXT, fin TEXT,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER,                -- 記録日時（Date.now()）
    type TEXT,                 -- checkout(持ち出し) / add / edit / delete / bulk(CSV取込)
    person TEXT,               -- 誰が（持ち出しは必須、他は空可）
    mat TEXT, koshu TEXT, thk REAL, spec TEXT, fin TEXT, loc TEXT,  -- 対象のスナップショット
    len_before REAL,           -- 変更前の長さ
    len_after REAL,            -- 変更後の長さ（全部持ち出し/削除は 0 または NULL）
    qty INTEGER,               -- bulk のときの取込件数
    note TEXT
  );
`);

// QRラベル印刷済みの目印（後付け列。既存DBには自動で追加）
try { db.exec("ALTER TABLE records ADD COLUMN qr_printed_at INTEGER"); } catch (e) { /* 既にある */ }
// 取り消し（元に戻す）用の後付け列（2026-09-24〜の記録から入る）
//   record_id … 対象の在庫の番号（QRラベルの ?co= と同じ）
//   snap      … 変更前の在庫の中身（JSON）。全部持ち出し・削除を同じ番号で復活させるのに使う
//   undone_at … この記録を取り消した日時
//   undo_of   … 取り消しの記録が、どの記録を取り消したか
//   edited_at … 作業ログで管理者が修正した日時（2026-09-29〜）
//   deleted_at … 作業ログで管理者が削除した日時（DBには残し、作業ログ・CSVには出さない）
//   loc_after … 持ち出しで残りを戻した棚（2026-10-09〜。loc は持ち出す前の棚。全部使ったときは空）
for (const col of ["record_id INTEGER", "snap TEXT", "undone_at INTEGER", "undo_of INTEGER", "edited_at INTEGER", "deleted_at INTEGER", "loc_after TEXT"]) {
  try { db.exec("ALTER TABLE history ADD COLUMN " + col); } catch (e) { /* 既にある */ }
}
// 鋼材の予約（2026-09-30〜）：誰が・いつ・どの案件で、その材料を使う予定か
db.exec(`
  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id INTEGER NOT NULL,  -- 予約する在庫の番号
    person TEXT NOT NULL,        -- 誰が
    use_date TEXT NOT NULL,      -- いつ使う（YYYY-MM-DD）
    job TEXT NOT NULL,           -- どの案件で
    created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_reservations_record ON reservations(record_id);
`);

const now = () => Date.now();

// ── version ──
function getVersion() {
  const r = db.prepare("SELECT value FROM meta WHERE key='version'").get();
  return r ? parseInt(r.value, 10) : 1;
}
const _bump = db.prepare("UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key='version'");
function bumpVersion() { _bump.run(); return getVersion(); }

// ── 初期化（初回のみ version=1） ──
(function initMeta() {
  if (!db.prepare("SELECT value FROM meta WHERE key='version'").get()) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('version', '1')").run();
  }
})();

// ── 入力の正規化（API/CSVから来た素データを records 行に整える） ──
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function str(v) { return v === null || v === undefined ? "" : String(v).trim(); }
// 材料規格の表記統一：寸法の区切りは「×」（50*50・50x50・50＊50 → 50×50。Φ34 などはそのまま）
function specStr(v) { return str(v).replace(/(\d)\s*[*＊xX✕×]\s*(?=\d)/g, "$1×"); }
function normRec(r) {
  r = r || {};
  return {
    mat: str(r.mat), koshu: str(r.koshu), thk: num(r.thk),
    spec: specStr(r.spec), len: num(r.len), loc: str(r.loc), fin: str(r.fin),
  };
}
// 追加・取込に必要な最低限が揃っているか（材質・鋼種・規格＋板厚/長さが数値）
function isValidRec(r) {
  return !!r.mat && !!r.koshu && !!r.spec && r.thk !== null && r.len !== null;
}

// ── 取得 ──
function rowToRec(r) {
  return {
    id: r.id, mat: r.mat || "", koshu: r.koshu || "",
    thk: r.thk, spec: r.spec || "", len: r.len,
    loc: r.loc || "", fin: r.fin || "",
    qr: r.qr_printed_at || null, // QRラベル印刷済みの目印（印刷日時）
  };
}
function getRecords() {
  return db.prepare("SELECT * FROM records ORDER BY id").all().map(rowToRec);
}
function getRecordCount() {
  return db.prepare("SELECT COUNT(*) c FROM records").get().c;
}

// ── 入出庫履歴 ──
const _insHist = db.prepare(`
  INSERT INTO history (ts, type, person, mat, koshu, thk, spec, fin, loc, len_before, len_after, qty, note, record_id, snap, undo_of, loc_after)
  VALUES (@ts, @type, @person, @mat, @koshu, @thk, @spec, @fin, @loc, @len_before, @len_after, @qty, @note, @record_id, @snap, @undo_of, @loc_after)
`);
// 記録を1件追加し、その記録の番号（history.id）を返す
function logHistory(type, rec, extra) {
  const r = rec || {};
  const e = extra || {};
  const info = _insHist.run({
    ts: now(), type, person: str(e.person),
    mat: str(r.mat), koshu: str(r.koshu), thk: num(r.thk),
    spec: specStr(r.spec), fin: str(r.fin), loc: str(r.loc),
    len_before: e.len_before !== undefined ? num(e.len_before) : null,
    len_after: e.len_after !== undefined ? num(e.len_after) : null,
    qty: e.qty !== undefined ? num(e.qty) : null,
    note: str(e.note),
    record_id: e.record_id != null ? Number(e.record_id) : null,
    snap: e.snap ? JSON.stringify(e.snap) : null,
    undo_of: e.undo_of != null ? Number(e.undo_of) : null,
    loc_after: e.loc_after != null && str(e.loc_after) !== "" ? str(e.loc_after) : null,
  });
  return Number(info.lastInsertRowid);
}
function getHistory(limit) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 300, 1), 2000);
  return db.prepare("SELECT * FROM history WHERE deleted_at IS NULL ORDER BY id DESC LIMIT ?").all(n);
}

// ── 追加 / 更新 / 削除 ──
const _insert = db.prepare(`
  INSERT INTO records (mat, koshu, thk, spec, len, loc, fin, updated_at)
  VALUES (@mat, @koshu, @thk, @spec, @len, @loc, @fin, @updated_at)
`);
function addRecord(rec, person) {
  const r = normRec(rec);
  const info = _insert.run({ ...r, updated_at: now() });
  const hid = logHistory("add", r, { person, len_after: r.len, record_id: info.lastInsertRowid });
  const version = bumpVersion();
  return { id: info.lastInsertRowid, hid, version };
}

const _update = db.prepare(`
  UPDATE records SET mat=@mat, koshu=@koshu, thk=@thk, spec=@spec, len=@len,
    loc=@loc, fin=@fin, updated_at=@updated_at WHERE id=@id
`);
function updateRecord(id, rec, person) {
  const before = db.prepare("SELECT * FROM records WHERE id=?").get(Number(id));
  if (!before) return { ok: false, version: getVersion() };
  const r = normRec(rec);
  _update.run({ ...r, id: Number(id), updated_at: now() });
  const hid = logHistory("edit", r, { person, len_before: before.len, len_after: r.len, record_id: before.id, snap: before });
  return { ok: true, hid, version: bumpVersion() };
}

function deleteRecord(id, person) {
  const before = db.prepare("SELECT * FROM records WHERE id=?").get(Number(id));
  if (!before) return { ok: false, version: getVersion() };
  db.prepare("DELETE FROM records WHERE id=?").run(Number(id));
  const hid = logHistory("delete", before, { person, len_before: before.len, len_after: null, record_id: before.id, snap: before });
  return { ok: true, hid, version: bumpVersion() };
}

// ── QRラベル印刷済みの目印を付ける ──
function markLabeled(ids) {
  if (!Array.isArray(ids) || !ids.length) return { marked: 0, version: getVersion() };
  const t = now();
  const st = db.prepare("UPDATE records SET qr_printed_at=? WHERE id=?");
  let marked = 0;
  const tx = db.transaction(() => { for (const id of ids) marked += st.run(t, Number(id)).changes; });
  tx();
  return { marked, version: marked ? bumpVersion() : getVersion() };
}

// ── 持ち出し（現場の出庫）：全部→レコード削除 / 一部→残り長さに更新 ──
const _checkoutTx = db.transaction((id, usedLen, person, note, newLoc) => {
  const r = db.prepare("SELECT * FROM records WHERE id=?").get(Number(id));
  if (!r) return { ok: false, reason: "notfound" };
  const len = Number(r.len) || 0;
  const used = (usedLen === null || usedLen === undefined) ? len : Number(usedLen);
  if (!Number.isFinite(used) || used <= 0) return { ok: false, reason: "badlen" };
  if (used > len) return { ok: false, reason: "over" };
  const remain = Math.round((len - used) * 100) / 100;
  let n = note;
  if (remain <= 0) {
    db.prepare("DELETE FROM records WHERE id=?").run(r.id);
  } else if (newLoc && newLoc !== r.loc) {
    // 残りの長さに合わせて保管場所も移す（保管場所ガイドの決定）
    db.prepare("UPDATE records SET len=?, loc=?, updated_at=? WHERE id=?").run(remain, newLoc, now(), r.id);
    n = (str(note) ? str(note) + " / " : "") + `保管場所 ${r.loc || "未設定"}→${newLoc}`;
  } else {
    db.prepare("UPDATE records SET len=?, updated_at=? WHERE id=?").run(remain, now(), r.id);
  }
  const hid = logHistory("checkout", r, { person, note: n, len_before: len, len_after: remain > 0 ? remain : 0, record_id: r.id, snap: r,
    loc_after: remain > 0 ? (newLoc || r.loc) : null }); // 残りを戻した棚（作業ログに出す）
  // 予約していた本人が持ち出したら、その人のこの材料の予約は済みとして消す
  db.prepare("DELETE FROM reservations WHERE record_id=? AND person=?").run(r.id, person);
  return { ok: true, hid, removed: remain <= 0, remain: remain > 0 ? remain : 0, loc: remain > 0 ? (newLoc || r.loc) : null };
});
function checkoutRecord(id, opts) {
  const o = opts || {};
  if (!str(o.person)) return { ok: false, reason: "noperson", version: getVersion() };
  const res = _checkoutTx(id, o.usedLen, str(o.person), o.note, str(o.loc) || null);
  if (!res.ok) return { ...res, version: getVersion() };
  return { ...res, version: bumpVersion() };
}

// ── CSV一括取込（妥当な行だけ追加） ──
const _bulkAddTx = db.transaction((rows) => {
  let added = 0;
  const tnow = now();
  for (const raw of rows) {
    const r = normRec(raw);
    if (!isValidRec(r)) continue;
    _insert.run({ ...r, updated_at: tnow });
    added++;
  }
  return added;
});
function bulkAdd(rows, person) {
  const added = _bulkAddTx(Array.isArray(rows) ? rows : []);
  if (added > 0) logHistory("bulk", {}, { person, qty: added });
  const version = added > 0 ? bumpVersion() : getVersion();
  return { added, version };
}

// ── 初回のみサンプル在庫を投入（一度きり。全削除しても再投入しない） ──
const SEED = [
  { mat: "SUS304", koshu: "角パイプ", thk: 1.5, spec: "50*50", len: 2438, loc: "本社レーザー前", fin: "HL" },
  { mat: "SS400", koshu: "角パイプ", thk: 3.2, spec: "75*40", len: 3000, loc: "第二工場", fin: "黒皮" },
  { mat: "A6063", koshu: "丸パイプ(TP-S)", thk: 2, spec: "Φ48.6", len: 2000, loc: "本社材料倉庫", fin: "#400" },
  { mat: "SUS316L", koshu: "丸パイプ(TP-A)", thk: 2, spec: "Φ21.7", len: 1000, loc: "本社レーザー前", fin: "未研" },
  { mat: "SUS304", koshu: "丸パイプ(TP-S)", thk: 1.5, spec: "Φ34", len: 5000, loc: "本社材料倉庫", fin: "未研" },
  { mat: "SUS304", koshu: "フラットバー", thk: 1.5, spec: "50", len: 6000, loc: "本社材料倉庫", fin: "HOT" },
  { mat: "SS400", koshu: "アングル", thk: 6, spec: "40*40", len: 1000, loc: "本社レーザー前", fin: "HL" },
  { mat: "SUS304", koshu: "丸パイプ(TP-S)", thk: 1.2, spec: "Φ27.2", len: 1500, loc: "本社レーザー前", fin: "#400" },
  { mat: "SS400", koshu: "フラットバー", thk: 6, spec: "30", len: 2000, loc: "第二工場", fin: "ミガキ" },
  { mat: "SUS304", koshu: "チャンネル", thk: 5, spec: "100*50", len: 5000, loc: "本社レーザー前", fin: "HOT" },
];
// SEED_ON_FIRST_RUN=0 を環境変数で渡すと空で開始（サンプルを入れない）
const SEED_ENABLED = process.env.SEED_ON_FIRST_RUN !== "0";
function seedIfEmpty() {
  if (db.prepare("SELECT 1 FROM meta WHERE key='seeded'").get()) return 0; // 一度きり
  let n = 0;
  if (SEED_ENABLED && getRecordCount() === 0) {
    const tnow = now();
    const tx = db.transaction(() => { for (const s of SEED) { _insert.run({ ...normRec(s), updated_at: tnow }); n++; } });
    tx();
  }
  db.prepare("INSERT INTO meta (key, value) VALUES ('seeded','1')").run();
  if (n > 0) bumpVersion();
  return n;
}

// ── 鋼材倉庫の鍵（持出/返却は history に keyout/keyin として記録） ──
function keyStatus() {
  const r = db.prepare("SELECT * FROM history WHERE type IN ('keyout','keyin') AND undone_at IS NULL AND deleted_at IS NULL ORDER BY id DESC LIMIT 1").get();
  if (!r || r.type === "keyin") return { out: false, person: r ? r.person : "", ts: r ? r.ts : null };
  return { out: true, person: r.person, ts: r.ts };
}
function keyEvent(action, person) {
  if (!str(person)) return { ok: false, reason: "noperson" };
  const st = keyStatus();
  if (action === "in" && !st.out) return { ok: false, reason: "notout" };
  const hid = logHistory(action === "out" ? "keyout" : "keyin", {}, { person });
  return { ok: true, hid, status: keyStatus() };
}

// ── 取り消し（元に戻す） ──
//   持ち出し・登録・編集・削除・鍵の持出 を1件ずつ、記録する前の状態に戻す。
//   ・全部持ち出し／削除した在庫は「同じ番号」で復活させる（貼ってあるQRラベルがそのまま使える）
//   ・同じ在庫にその後の記録がある／在庫の状態が記録と合わない ときは戻さない（他の人の作業を壊さない）
//   ・取り消したことも作業ログに「取り消し」として残す
const UNDO_TYPES = new Set(["checkout", "add", "edit", "delete", "keyout"]);
const REC_COLS = ["mat", "koshu", "thk", "spec", "len", "loc", "fin", "updated_at", "qr_printed_at"];
function restoreRec(id, s) { // QRラベル印刷済みの目印は今の状態のまま（在庫の中身だけ戻す）
  const cols = REC_COLS.filter((c) => c !== "qr_printed_at");
  db.prepare(`UPDATE records SET ${cols.map((c) => c + "=@" + c).join(", ")} WHERE id=@id`)
    .run({ ...Object.fromEntries(cols.map((c) => [c, s[c] === undefined ? null : s[c]])), id: Number(id) });
}
function reinsertRec(s) {
  db.prepare(`INSERT INTO records (id, ${REC_COLS.join(", ")}) VALUES (@id, ${REC_COLS.map((c) => "@" + c).join(", ")})`)
    .run({ ...Object.fromEntries(REC_COLS.map((c) => [c, s[c] === undefined ? null : s[c]])), id: Number(s.id) });
}
const lenEq = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.005;
// 同じ在庫に、この記録より後の記録（取り消し済み・削除済み・取り消しの記録を除く）があるか
function hasLaterRec(h) {
  if (h.record_id == null) return false;
  return !!db.prepare("SELECT id FROM history WHERE record_id=? AND id>? AND undone_at IS NULL AND deleted_at IS NULL AND type<>'undo' LIMIT 1")
    .get(h.record_id, h.id);
}
const _undoTx = db.transaction((hid, person) => {
  const h = db.prepare("SELECT * FROM history WHERE id=?").get(Number(hid));
  if (!h || h.deleted_at) return { ok: false, reason: "notfound" };
  if (h.undone_at) return { ok: false, reason: "already" };
  if (!UNDO_TYPES.has(h.type)) return { ok: false, reason: "unsupported" };
  if (h.type !== "keyout" && h.record_id == null) return { ok: false, reason: "old" };
  let snap = null;
  try { snap = h.snap ? JSON.parse(h.snap) : null; } catch (e) { snap = null; }
  if (["checkout", "edit", "delete"].includes(h.type) && !snap) return { ok: false, reason: "old" };
  if (hasLaterRec(h)) return { ok: false, reason: "later" };
  const cur = h.record_id != null ? db.prepare("SELECT * FROM records WHERE id=?").get(h.record_id) : null;
  let after = null; // 取り消し後の在庫（記録用）
  if (h.type === "checkout") {
    if (Number(h.len_after) > 0) {
      if (!cur || !lenEq(cur.len, h.len_after)) return { ok: false, reason: "state" };
      restoreRec(cur.id, snap);
    } else {
      if (cur) return { ok: false, reason: "state" };
      reinsertRec(snap);
    }
    after = snap;
  } else if (h.type === "add") {
    if (!cur || !lenEq(cur.len, h.len_after)) return { ok: false, reason: "state" };
    db.prepare("DELETE FROM records WHERE id=?").run(cur.id);
    after = cur;
  } else if (h.type === "edit") {
    if (!cur) return { ok: false, reason: "state" };
    restoreRec(cur.id, snap);
    after = snap;
  } else if (h.type === "delete") {
    if (cur) return { ok: false, reason: "state" };
    reinsertRec(snap);
    after = snap;
  }
  db.prepare("UPDATE history SET undone_at=? WHERE id=?").run(now(), h.id);
  const TYPE_JA = { checkout: "持ち出し", add: "登録", edit: "編集", delete: "削除", keyout: "鍵の持出" };
  const uid = logHistory("undo", h.type === "keyout" ? {} : (after || h), {
    person, undo_of: h.id, record_id: h.record_id,
    len_before: h.type === "keyout" ? undefined : h.len_after,
    len_after: h.type === "keyout" ? undefined : (h.type === "add" ? null : (after ? after.len : null)),
    note: `取り消し：${TYPE_JA[h.type]}（${h.person || "—"}）`,
  });
  return { ok: true, uid, type: h.type, record_id: h.record_id, ts: h.ts };
});
// admin=true なら何日前の記録でも可。そうでなければ記録から UNDO_WINDOW_MS 以内だけ（現場の「元に戻す」）
const UNDO_WINDOW_MS = 5 * 60 * 1000;
function undoHistory(hid, person, admin) {
  const h = db.prepare("SELECT ts FROM history WHERE id=?").get(Number(hid));
  if (h && !admin && Date.now() - h.ts > UNDO_WINDOW_MS) return { ok: false, reason: "expired", version: getVersion() };
  const res = _undoTx(hid, str(person) || (admin ? "管理者" : ""));
  if (!res.ok) return { ...res, version: getVersion() };
  return { ...res, version: bumpVersion() };
}

// ── 作業ログの修正・削除（管理者） ──
//   修正：名前・日時・メモ。持ち出しは「残りの長さ」、登録は「登録した長さ」も直せて、在庫の長さも同じに直す
//     （その在庫にその後の記録が無く、在庫の長さが記録と合うときだけ。合わないときは在庫管理から手で直す）
//   削除：作業ログから消す（在庫は変えない。在庫も戻すときは先に「元に戻す」）。
//     消した記録は DB に残すので、直後なら restoreHistory で元に戻せる
const LEN_EDIT_TYPES = new Set(["checkout", "add"]);
const _editHistTx = db.transaction((hid, b) => {
  const h = db.prepare("SELECT * FROM history WHERE id=?").get(Number(hid));
  if (!h || h.deleted_at) return { ok: false, reason: "notfound" };
  const set = {};
  if (b.person !== undefined) {
    const p = str(b.person);
    if (!p && (h.type === "checkout" || h.type === "keyout")) return { ok: false, reason: "noperson" };
    if (p !== (h.person || "")) set.person = p;
  }
  if (b.ts !== undefined) {
    const t = Number(b.ts);
    if (!Number.isFinite(t) || t < Date.UTC(2020, 0, 1) || t > now() + 60 * 60 * 1000) return { ok: false, reason: "badts" };
    if (Math.round(t) !== h.ts) set.ts = Math.round(t);
  }
  if (b.note !== undefined && str(b.note) !== (h.note || "")) set.note = str(b.note);
  let stockChanged = false;
  if (b.len_after !== undefined && b.len_after !== null && b.len_after !== "") {
    const nv = num(b.len_after), ov = Number(h.len_after) || 0;
    if (nv === null || nv < 0) return { ok: false, reason: "badlen" };
    if (!lenEq(nv, ov)) {
      if (!LEN_EDIT_TYPES.has(h.type)) return { ok: false, reason: "nolen" };
      if (h.undone_at) return { ok: false, reason: "undone" };
      if (h.record_id == null) return { ok: false, reason: "old" };
      if (h.type === "add" && !(nv > 0)) return { ok: false, reason: "badlen" };
      if (h.type === "checkout" && h.len_before != null && nv > Number(h.len_before) + 0.005) return { ok: false, reason: "toolong" };
      if (hasLaterRec(h)) return { ok: false, reason: "later" };
      const cur = db.prepare("SELECT * FROM records WHERE id=?").get(h.record_id);
      let locAfter = null; // 直したあと、残りがある棚（持ち出しの「戻した棚」用）
      if (ov > 0) {
        if (!cur || !lenEq(cur.len, ov)) return { ok: false, reason: "state" };
        if (nv > 0) db.prepare("UPDATE records SET len=?, updated_at=? WHERE id=?").run(nv, now(), cur.id);
        else db.prepare("DELETE FROM records WHERE id=?").run(cur.id); // 残り0＝全部持ち出しに直す
        locAfter = nv > 0 ? cur.loc : null;
      } else {
        // 全部持ち出しで在庫が無くなった記録に「残り」を入れる → 同じ番号で在庫を復活（QRラベルがそのまま使える）
        if (cur) return { ok: false, reason: "state" };
        let snap = null;
        try { snap = h.snap ? JSON.parse(h.snap) : null; } catch (e) { snap = null; }
        if (!snap) return { ok: false, reason: "old" };
        reinsertRec({ ...snap, len: nv, updated_at: now() });
        locAfter = snap.loc;
      }
      set.len_after = nv;
      if (h.type === "checkout") set.loc_after = locAfter || null;
      stockChanged = true;
    }
  }
  if (!Object.keys(set).length) return { ok: true, changed: false, stockChanged: false };
  set.edited_at = now();
  db.prepare(`UPDATE history SET ${Object.keys(set).map((c) => c + "=@" + c).join(", ")} WHERE id=@id`).run({ ...set, id: h.id });
  return { ok: true, changed: true, stockChanged };
});
function editHistory(hid, b) {
  const r = _editHistTx(hid, b || {});
  return { ...r, version: r.ok && r.changed ? bumpVersion() : getVersion() };
}
function deleteHistory(hid) {
  const h = db.prepare("SELECT id, deleted_at FROM history WHERE id=?").get(Number(hid));
  if (!h || h.deleted_at) return { ok: false, reason: "notfound", version: getVersion() };
  db.prepare("UPDATE history SET deleted_at=? WHERE id=?").run(now(), h.id);
  return { ok: true, version: bumpVersion() };
}
function restoreHistory(hid) {
  const h = db.prepare("SELECT id, deleted_at FROM history WHERE id=?").get(Number(hid));
  if (!h || !h.deleted_at) return { ok: false, reason: "notfound", version: getVersion() };
  db.prepare("UPDATE history SET deleted_at=NULL WHERE id=?").run(h.id);
  return { ok: true, version: bumpVersion() };
}

// ── マスタ設定（単価・比重・式割当の上書き。null=プログラムの既定値を使用） ──
const _metaUpsert = db.prepare(
  "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
);
function getMasters() {
  const r = db.prepare("SELECT value FROM meta WHERE key='masters'").get();
  if (!r) return null;
  try { return JSON.parse(r.value); } catch (e) { return null; }
}
function getMastersVersion() {
  const r = db.prepare("SELECT value FROM meta WHERE key='mastersVersion'").get();
  return r ? parseInt(r.value, 10) || 0 : 0;
}
function setMasters(obj) {
  if (obj && obj.kikaku && typeof obj.kikaku === "object") { // 規格候補も「×」表記に統一
    for (const k of Object.keys(obj.kikaku)) if (Array.isArray(obj.kikaku[k])) obj.kikaku[k] = [...new Set(obj.kikaku[k].map(specStr).filter(Boolean))];
  }
  _metaUpsert.run("masters", JSON.stringify(obj ?? null));
  _metaUpsert.run("mastersVersion", String(getMastersVersion() + 1));
  bumpVersion(); // クライアントのポーリングに変更を知らせる
  return { mv: getMastersVersion(), version: getVersion() };
}

// ── 鋼材の予約（使う材料がバッティングしないように、誰が・いつ・どの案件で使うかを材料ごとに書いておく） ──
//   ・設定は無し。予約があっても持ち出しは止めない（画面に「予約あり」と出して気づけるようにするだけ）
//   ・予約日を過ぎた予約は出さない（30日たったらDBからも消す）
//   ・予約した本人がその材料を持ち出したら、その予約は消える（_checkoutTx）
//   ・在庫が無くなった材料の予約は出さない（取り消しで在庫が同じ番号で戻れば、予約もまた出る）
function todayStr(offsetDays) {
  const d = new Date(Date.now() + (offsetDays || 0) * 86400000);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
function getReservations() {
  return db.prepare(`
    SELECT v.id, v.record_id, v.person, v.use_date AS date, v.job
    FROM reservations v JOIN records r ON r.id = v.record_id
    WHERE v.use_date >= ? ORDER BY v.use_date, v.id`).all(todayStr());
}
function addReservation(b) {
  b = b || {};
  const rid = Number(b.record_id), person = str(b.person), date = str(b.date), job = str(b.job);
  const fail = (reason) => ({ ok: false, reason, version: getVersion() });
  if (!db.prepare("SELECT id FROM records WHERE id=?").get(rid)) return fail("notfound");
  if (!person) return fail("noperson");
  if (!job) return fail("nojob");
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const dt = m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  if (!dt || dt.getMonth() !== +m[2] - 1 || dt.getDate() !== +m[3]) return fail("baddate");
  if (date < todayStr()) return fail("pastdate");
  db.prepare("DELETE FROM reservations WHERE use_date < ?").run(todayStr(-30));
  // 同じ内容の予約がすでにあれば、二重には入れない
  const dup = db.prepare("SELECT id FROM reservations WHERE record_id=? AND person=? AND use_date=? AND job=?").get(rid, person, date, job);
  if (dup) return { ok: true, id: dup.id, version: getVersion() };
  const info = db.prepare("INSERT INTO reservations (record_id, person, use_date, job, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(rid, person, date, job, now());
  return { ok: true, id: Number(info.lastInsertRowid), version: bumpVersion() };
}
function deleteReservation(id) {
  const info = db.prepare("DELETE FROM reservations WHERE id=?").run(Number(id));
  if (!info.changes) return { ok: false, reason: "notfound", version: getVersion() };
  return { ok: true, version: bumpVersion() };
}

// ── 全状態（差分ポーリングのベース） ──
function getState() {
  return { records: getRecords(), reservations: getReservations(), version: getVersion(), mv: getMastersVersion() };
}

// ── 一度だけの移行：既存データの材料規格を「×」表記に統一（2026-09-27） ──
//   在庫・履歴（スナップショット含む）・マスタの規格候補を書き換える。
//   書き換える前に server/data/ に app.db のバックアップ（app-before-spec-x-日時.db）を作る。
(function migrateSpecX() {
  const KEY = "spec_x_v1";
  if (db.prepare("SELECT value FROM meta WHERE key=?").get(KEY)) return;
  const fixSnap = (j) => {
    if (!j) return j;
    try { const o = JSON.parse(j); if (o && typeof o === "object" && "spec" in o) { o.spec = specStr(o.spec); return JSON.stringify(o); } } catch (e) {}
    return j;
  };
  const recs = db.prepare("SELECT id, spec FROM records").all().filter((r) => specStr(r.spec) !== (r.spec || ""));
  const hist = db.prepare("SELECT id, spec, snap FROM history").all()
    .filter((h) => specStr(h.spec) !== (h.spec || "") || fixSnap(h.snap) !== h.snap);
  const mrow = db.prepare("SELECT value FROM meta WHERE key='masters'").get();
  let mNew = null;
  if (mrow && mrow.value) {
    try {
      const m = JSON.parse(mrow.value);
      if (m && m.kikaku && typeof m.kikaku === "object") {
        const before = JSON.stringify(m.kikaku);
        for (const k of Object.keys(m.kikaku)) if (Array.isArray(m.kikaku[k])) m.kikaku[k] = [...new Set(m.kikaku[k].map(specStr).filter(Boolean))];
        if (JSON.stringify(m.kikaku) !== before) mNew = JSON.stringify(m);
      }
    } catch (e) { /* 壊れたマスタは触らない */ }
  }
  if (recs.length || hist.length || mNew) {
    try {
      const d = new Date(), p2 = (n) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
      const bk = path.join(path.dirname(DB_PATH), `app-before-spec-x-${stamp}.db`);
      db.prepare("VACUUM INTO ?").run(bk);
      console.log("[移行] 規格の×統一の前にバックアップ:", bk);
    } catch (e) {
      console.error("[移行] バックアップに失敗したため、規格の×統一は行いません:", e.message);
      return; // バックアップが無いまま書き換えない（次回起動時に再挑戦）
    }
  }
  db.transaction(() => {
    const u1 = db.prepare("UPDATE records SET spec=? WHERE id=?");
    recs.forEach((r) => u1.run(specStr(r.spec), r.id));
    const u2 = db.prepare("UPDATE history SET spec=?, snap=? WHERE id=?");
    hist.forEach((h) => u2.run(specStr(h.spec), fixSnap(h.snap), h.id));
    if (mNew) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('masters', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(mNew);
      const mv = db.prepare("SELECT value FROM meta WHERE key='mastersVersion'").get();
      db.prepare("INSERT INTO meta (key, value) VALUES ('mastersVersion', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String((mv ? parseInt(mv.value, 10) || 0 : 0) + 1));
    }
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(KEY, String(now()));
    if (recs.length || hist.length) bumpVersion();
  })();
  if (recs.length || hist.length || mNew) console.log(`[移行] 規格を×表記に統一：在庫${recs.length}件・履歴${hist.length}件${mNew ? "・マスタ規格候補" : ""}`);
})();

module.exports = {
  db, DB_PATH,
  getVersion, bumpVersion,
  getRecords, getRecordCount,
  addRecord, updateRecord, deleteRecord, bulkAdd,
  checkoutRecord, getHistory, markLabeled,
  keyStatus, keyEvent, undoHistory, UNDO_WINDOW_MS,
  editHistory, deleteHistory, restoreHistory,
  getReservations, addReservation, deleteReservation,
  getMasters, getMastersVersion, setMasters,
  seedIfEmpty, getState,
};
