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
for (const col of ["record_id INTEGER", "snap TEXT", "undone_at INTEGER", "undo_of INTEGER"]) {
  try { db.exec("ALTER TABLE history ADD COLUMN " + col); } catch (e) { /* 既にある */ }
}

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
function normRec(r) {
  r = r || {};
  return {
    mat: str(r.mat), koshu: str(r.koshu), thk: num(r.thk),
    spec: str(r.spec), len: num(r.len), loc: str(r.loc), fin: str(r.fin),
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
  INSERT INTO history (ts, type, person, mat, koshu, thk, spec, fin, loc, len_before, len_after, qty, note, record_id, snap, undo_of)
  VALUES (@ts, @type, @person, @mat, @koshu, @thk, @spec, @fin, @loc, @len_before, @len_after, @qty, @note, @record_id, @snap, @undo_of)
`);
// 記録を1件追加し、その記録の番号（history.id）を返す
function logHistory(type, rec, extra) {
  const r = rec || {};
  const e = extra || {};
  const info = _insHist.run({
    ts: now(), type, person: str(e.person),
    mat: str(r.mat), koshu: str(r.koshu), thk: num(r.thk),
    spec: str(r.spec), fin: str(r.fin), loc: str(r.loc),
    len_before: e.len_before !== undefined ? num(e.len_before) : null,
    len_after: e.len_after !== undefined ? num(e.len_after) : null,
    qty: e.qty !== undefined ? num(e.qty) : null,
    note: str(e.note),
    record_id: e.record_id != null ? Number(e.record_id) : null,
    snap: e.snap ? JSON.stringify(e.snap) : null,
    undo_of: e.undo_of != null ? Number(e.undo_of) : null,
  });
  return Number(info.lastInsertRowid);
}
function getHistory(limit) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 300, 1), 2000);
  return db.prepare("SELECT * FROM history ORDER BY id DESC LIMIT ?").all(n);
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
  const hid = logHistory("checkout", r, { person, note: n, len_before: len, len_after: remain > 0 ? remain : 0, record_id: r.id, snap: r });
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
  const r = db.prepare("SELECT * FROM history WHERE type IN ('keyout','keyin') AND undone_at IS NULL ORDER BY id DESC LIMIT 1").get();
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
const _undoTx = db.transaction((hid, person) => {
  const h = db.prepare("SELECT * FROM history WHERE id=?").get(Number(hid));
  if (!h) return { ok: false, reason: "notfound" };
  if (h.undone_at) return { ok: false, reason: "already" };
  if (!UNDO_TYPES.has(h.type)) return { ok: false, reason: "unsupported" };
  if (h.type !== "keyout" && h.record_id == null) return { ok: false, reason: "old" };
  let snap = null;
  try { snap = h.snap ? JSON.parse(h.snap) : null; } catch (e) { snap = null; }
  if (["checkout", "edit", "delete"].includes(h.type) && !snap) return { ok: false, reason: "old" };
  if (h.record_id != null) {
    const later = db.prepare("SELECT id FROM history WHERE record_id=? AND id>? AND undone_at IS NULL AND type<>'undo' LIMIT 1")
      .get(h.record_id, h.id);
    if (later) return { ok: false, reason: "later" };
  }
  const cur = h.record_id != null ? db.prepare("SELECT * FROM records WHERE id=?").get(h.record_id) : null;
  const lenEq = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.005;
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
  _metaUpsert.run("masters", JSON.stringify(obj ?? null));
  _metaUpsert.run("mastersVersion", String(getMastersVersion() + 1));
  bumpVersion(); // クライアントのポーリングに変更を知らせる
  return { mv: getMastersVersion(), version: getVersion() };
}

// ── 全状態（差分ポーリングのベース） ──
function getState() {
  return { records: getRecords(), version: getVersion(), mv: getMastersVersion() };
}

module.exports = {
  db, DB_PATH,
  getVersion, bumpVersion,
  getRecords, getRecordCount,
  addRecord, updateRecord, deleteRecord, bulkAdd,
  checkoutRecord, getHistory, markLabeled,
  keyStatus, keyEvent, undoHistory, UNDO_WINDOW_MS,
  getMasters, getMastersVersion, setMasters,
  seedIfEmpty, getState,
};
