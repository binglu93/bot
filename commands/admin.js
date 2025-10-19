// commands/admin.js
// Admin panel (owner only) dengan sesi input: tambah/hapus VPS, edit harga, broadcast, addsaldo

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

/* ========= OWNER GUARD ========= */
function isOwnerMsg(msgOrQuery) {
  const allowed = ['2118266757']; // <-- hardcode ID owner di sini
  const uid = String(
    msgOrQuery?.from?.id ||
    msgOrQuery?.message?.from?.id ||
    ''
  );
  return allowed.includes(uid);
}

/* ========= UTIL ========= */
const send = (bot, chatId, text, opt = {}) =>
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opt });

const vpsPath   = () => path.resolve(process.cwd(), 'julak', 'vps.json');
const hargaPath = () => path.resolve(process.cwd(), 'julak', 'harga.json');

function readJSON(p, fb) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fb; }
}
function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

const idr = (n) => Number(n || 0).toLocaleString('id-ID');

/* ========= DB USERS (untuk broadcast & addsaldo) ========= */
const db = new Database(path.resolve(process.cwd(), 'julak', 'wallet.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    tg_id TEXT PRIMARY KEY,
    name  TEXT,
    balance INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
`);

const stmtAddBalance = db.prepare(`UPDATE users SET balance = balance + ? WHERE tg_id=?`);
const stmtGetUser    = db.prepare(`SELECT tg_id,name,balance FROM users WHERE tg_id=?`);
const stmtUpsertUser = db.prepare(`
  INSERT INTO users (tg_id, name, balance, created_at)
  VALUES (@tg_id, @name, 0, @created_at)
  ON CONFLICT(tg_id) DO UPDATE SET name = COALESCE(excluded.name, users.name)
`);

/* ========= SESSION mirip add* ========= */
function sessKey(msg){ return `${msg.chat.id}:${msg.from.id}`; }

function getS(msg){
  global.__admin_sessions ??= Object.create(null);
  return global.__admin_sessions[sessKey(msg)];
}

function setS(bot, msg, data, ttlMs = 120_000){
  global.__admin_sessions ??= Object.create(null);
  const key = sessKey(msg);
  // bersihkan timer lama
  if (global.__admin_sessions[key]?._timeout) {
    clearTimeout(global.__admin_sessions[key]._timeout);
  }
  const chatId = msg.chat.id;
  const timeout = setTimeout(() => {
    try { send(bot, chatId, '⏳ Sesi admin timeout.'); } catch {}
    delete global.__admin_sessions[key];
  }, ttlMs);

  global.__admin_sessions[key] = { ...data, _timeout: timeout };
}

function clearS(msg){
  const S = getS(msg);
  if (S?._timeout) clearTimeout(S._timeout);
  global.__admin_sessions && delete global.__admin_sessions[sessKey(msg)];
}

/* ========= PLUGIN ========= */
module.exports = {
  name: 'admin',
  aliases: [],
  description: 'Panel admin (owner only) dengan sesi input',

  async execute(bot, msg) {
    if (!isOwnerMsg(msg)) {
      return send(bot, msg.chat.id, '❌ Menu ini hanya untuk admin/owner.');
    }

    const harga = readJSON(hargaPath(), {});
    const tampilHarga = Object.entries(harga)
      .map(([d,h]) => `• ${d} hari → Rp${idr(h)}`)
      .sort((a,b) => {
        // sort by number at start of string
        const na = parseInt(a.split(' ')[1]) || 0;
        const nb = parseInt(b.split(' ')[1]) || 0;
        return na - nb;
      })
      .join('\n') || '_Belum ada harga_';

    const txt =
`*🛡 ADMIN MENU*
Pilih aksi dengan balas angka:

1. ➕ Tambah VPS
2. 🗑 Hapus VPS
3. ✏️ Edit Harga
4. 📣 Broadcast
5. 💸 Add Saldo Manual

*Harga saat ini:*
${tampilHarga}

Ketik */batal* untuk membatalkan.`;
    await send(bot, msg.chat.id, txt);
    setS(bot, msg, { step: 'main' });
  },

  async continue(bot, msg) {
    if (!isOwnerMsg(msg)) return false;
    const S = getS(msg);
    if (!S) return false;

    const t = String(msg.text || '').trim();
    if (!t) return true;

    // batal universal
    if (/^([./])?batal$/i.test(t)) {
      clearS(msg);
      await send(bot, msg.chat.id, '✅ Sesi admin dibatalkan.');
      return true;
    }

    /* ===== MAIN MENU ===== */
    if (S.step === 'main') {
      if (t === '1') {
        await send(bot, msg.chat.id,
`*Tambah VPS*
Kirim *1 baris* dengan format:
\`id|host|port|username|password\`

Contoh:
\`Andy|123.123.123.123|22|root|rahasia\``);
        setS(bot, msg, { step: 'addvps' });
        return true;
      }
      if (t === '2') {
        const list = readJSON(vpsPath(), []);
        if (!Array.isArray(list) || !list.length) {
          await send(bot, msg.chat.id, 'ℹ️ Tidak ada VPS.');
          clearS(msg); return true;
        }
        const rows = list.map((v,i)=>`${i+1}. ${v.id || v.host}`).join('\n');
        await send(bot, msg.chat.id, `*Hapus VPS*\nBalas ANGKA untuk menghapus:\n\n${rows}`);
        setS(bot, msg, { step: 'delvps', list });
        return true;
      }
      if (t === '3') {
        await send(bot, msg.chat.id,
`*Edit Harga*
Kirim satu/lebih pasangan *hari=harga* (bisa pisah spasi/baris).

Contoh:
\`7=3000 30=10000 60=15000 90=20000\``);
        setS(bot, msg, { step: 'editharga' });
        return true;
      }
      if (t === '4') {
        await send(bot, msg.chat.id, '*Broadcast*\nKirim teks yang akan disiarkan ke *semua user*.');
        setS(bot, msg, { step: 'broadcast' });
        return true;
      }
      if (t === '5') {
        await send(bot, msg.chat.id,
`*Add Saldo Manual*
Format: \`userId|nominal\`

Contoh:
\`5736569839|10000\``);
        setS(bot, msg, { step: 'addsaldo' });
        return true;
      }

      // input selain 1-5: abaikan & tetap di main
      return true;
    }

    /* ===== TAMBAH VPS ===== */
    if (S.step === 'addvps') {
      const parts = t.split('|').map(s=>s.trim());
      if (parts.length < 5) {
        await send(bot, msg.chat.id, '⚠️ Format salah. Gunakan: `id|host|port|username|password`');
        return true;
      }
      const [id, host, portStr, username, password] = parts;
      const port = parseInt(portStr, 10) || 22;

      const list = readJSON(vpsPath(), []);
      list.push({ id, host, port, username, password });
      writeJSON(vpsPath(), list);

      await send(bot, msg.chat.id, `✅ VPS *${id}* ditambahkan.`);
      clearS(msg);
      return true;
    }

    /* ===== HAPUS VPS ===== */
    if (S.step === 'delvps') {
      const idx = parseInt(t, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= (S.list?.length || 0)) {
        await send(bot, msg.chat.id, '⚠️ Pilihan tidak valid. Balas *angka* yang ada di daftar.');
        return true;
      }
      const list = readJSON(vpsPath(), []);
      const target = list[idx];
      list.splice(idx, 1);
      writeJSON(vpsPath(), list);

      await send(bot, msg.chat.id, `🗑 VPS *${target?.id || target?.host}* dihapus.`);
      clearS(msg);
      return true;
    }

    /* ===== EDIT HARGA ===== */
    if (S.step === 'editharga') {
      const harga = readJSON(hargaPath(), {});
      const pairs = t.split(/[\s\n]+/).filter(Boolean);
      let changed = 0;
      for (const p of pairs) {
        const m = p.match(/^(\d+)\s*=\s*(\d{1,})$/);
        if (!m) continue;
        const day = parseInt(m[1], 10);
        const val = parseInt(m[2], 10);
        if (Number.isInteger(day) && day > 0 && Number.isInteger(val) && val >= 0) {
          harga[String(day)] = val;
          changed++;
        }
      }
      writeJSON(hargaPath(), harga);
      await send(bot, msg.chat.id, `✅ Harga di-update (${changed} item).`);
      clearS(msg);
      return true;
    }

    /* ===== BROADCAST ===== */
    if (S.step === 'broadcast') {
      const users = db.prepare('SELECT tg_id FROM users').all();
      let ok = 0, fail = 0;
      for (const u of users) {
        try { await send(bot, u.tg_id, t); ok++; }
        catch { fail++; }
      }
      await send(bot, msg.chat.id, `📣 Broadcast selesai. Berhasil: ${ok}, Gagal: ${fail}.`);
      clearS(msg);
      return true;
    }

    /* ===== ADD SALDO MANUAL ===== */
    if (S.step === 'addsaldo') {
      const parts = t.split('|').map(s => s.trim());
      if (parts.length < 2) {
        await send(bot, msg.chat.id, '⚠️ Format salah. Gunakan: `userId|nominal`');
        return true;
      }
      const [uid, amountStr] = parts;
      const amount = parseInt(amountStr, 10);
      if (!uid || isNaN(amount)) {
        await send(bot, msg.chat.id, '⚠️ Format salah. Contoh: `5736569839|10000`');
        return true;
      }

      // pastikan user ada (nama kosong, created_at now)
      stmtUpsertUser.run({ tg_id: String(uid), name: null, created_at: new Date().toISOString() });

      // tambah saldo (bisa negatif juga kalau mau koreksi, tapi disini anggap +)
      stmtAddBalance.run(amount, String(uid));
      const u = stmtGetUser.get(String(uid));

      await send(
        bot,
        msg.chat.id,
        `✅ Saldo user *${uid}* ditambah Rp${idr(amount)}.\n` +
        `Saldo sekarang: *Rp${idr(u?.balance || 0)}*`
      );
      clearS(msg);
      return true;
    }

    return true;
  }
};
