// lib/db.js
// Helper SQLite untuk users + log pembelian + statistik

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(process.cwd(), 'julak', 'wallet.db');

function openDB() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      tg_id TEXT PRIMARY KEY,
      name  TEXT,
      balance INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_id TEXT NOT NULL,
      kind  TEXT NOT NULL,      -- 'add-ssh' | 'add-vmess' | 'trial-ssh' | ...
      days  INTEGER,            -- durasi hari (boleh NULL utk trial)
      vps_id TEXT,              -- id/label vps (opsional)
      created_at TEXT NOT NULL  -- ISO string (UTC)
    );

    CREATE INDEX IF NOT EXISTS idx_plogs_tg ON purchase_logs(tg_id);
    CREATE INDEX IF NOT EXISTS idx_plogs_created ON purchase_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_plogs_kind ON purchase_logs(kind);
  `);
  return db;
}

const db = openDB();

// -------- users ----------
const stmtUpsertUser = db.prepare(`
  INSERT INTO users (tg_id, name, balance, created_at)
  VALUES (@tg_id, @name, 0, @created_at)
  ON CONFLICT(tg_id) DO UPDATE SET name = excluded.name
`);
const stmtGetUser = db.prepare(`SELECT tg_id,name,balance FROM users WHERE tg_id=?`);

function ensureUser(tgId, name) {
  stmtUpsertUser.run({ tg_id: String(tgId), name, created_at: new Date().toISOString() });
  return stmtGetUser.get(String(tgId));
}

// -------- log pembelian ----------
const stmtInsertLog = db.prepare(`
  INSERT INTO purchase_logs (tg_id, kind, days, vps_id, created_at)
  VALUES (?, ?, ?, ?, ?)
`);

function logPurchase({ tg_id, kind, days = null, vps_id = null, at = new Date() }) {
  stmtInsertLog.run(String(tg_id), String(kind), days, vps_id, new Date(at).toISOString());
}

// -------- util WIB batas waktu ----------
function wibNow() { return new Date(Date.now() + 7*60*60*1000); } // UTC+7
function wibStartOfDay(d = wibNow()) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0,0,0));
  return new Date(x.getTime() - 7*60*60*1000); // convert back to UTC ISO
}
function wibStartOfWeek(d = wibNow()) {
  // Senin sebagai awal minggu
  const day = d.getUTCDay(); // 0=Min..6=Sab
  const diff = (day === 0 ? 6 : day - 1); // jarak ke Senin
  const base = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0,0,0));
  const mon = new Date(base.getTime() - diff*86400000);
  return new Date(mon.getTime() - 7*60*60*1000);
}
function wibStartOfMonth(d = wibNow()) {
  const base = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0,0,0));
  return new Date(base.getTime() - 7*60*60*1000);
}

// -------- query statistik ----------
function countLogsBetween(startIso, endIso, tgId = null) {
  if (tgId) {
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM purchase_logs WHERE created_at >= ? AND created_at < ? AND tg_id = ?`
    ).get(startIso, endIso, String(tgId));
    return Number(row?.n || 0);
  } else {
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM purchase_logs WHERE created_at >= ? AND created_at < ?`
    ).get(startIso, endIso);
    return Number(row?.n || 0);
  }
}

function rangeToday() {
  const start = wibStartOfDay();
  const end = new Date(start.getTime() + 86400000);
  return { start: start.toISOString(), end: end.toISOString() };
}
function rangeThisWeek() {
  const start = wibStartOfWeek();
  const end = new Date(start.getTime() + 7*86400000);
  return { start: start.toISOString(), end: end.toISOString() };
}
function rangeThisMonth() {
  const s = wibStartOfMonth();
  const e = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth()+1, 1, 0,0,0) - 7*60*60*1000);
  return { start: s.toISOString(), end: e.toISOString() };
}

function getUserStats(tgId) {
  const t = rangeToday(), w = rangeThisWeek(), m = rangeThisMonth();
  return {
    today:  countLogsBetween(t.start, t.end, tgId),
    week:   countLogsBetween(w.start, w.end, tgId),
    month:  countLogsBetween(m.start, m.end, tgId)
  };
}

function getGlobalStats() {
  const t = rangeToday(), w = rangeThisWeek(), m = rangeThisMonth();
  return {
    today:  countLogsBetween(t.start, t.end, null),
    week:   countLogsBetween(w.start, w.end, null),
    month:  countLogsBetween(m.start, m.end, null)
  };
}

function totalUsers() {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM users`).get();
  return Number(row?.n || 0);
}

// -------- fungsi saldo manual / topup --------
function addSaldo(tgId, nominal) {
  try {
    const row = db.prepare(`SELECT balance FROM users WHERE tg_id=?`).get(String(tgId));
    if (!row) return false;

    const newBalance = (row.balance || 0) + Number(nominal);
    db.prepare(`UPDATE users SET balance=? WHERE tg_id=?`).run(newBalance, String(tgId));
    return true;
  } catch (err) {
    console.error("❌ addSaldo error:", err);
    return false;
  }
}

function getSaldo(tgId) {
  const row = db.prepare(`SELECT balance FROM users WHERE tg_id=?`).get(String(tgId));
  return row ? row.balance : 0;
}

// =====================================================
module.exports = {
  db,
  ensureUser,
  logPurchase,
  getUserStats,
  getGlobalStats,
  totalUsers,
  addSaldo,  // ← tambahkan ini
  getSaldo   // ← dan ini
};
