// commands/topupmanual.js
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(process.cwd(), 'julak', 'wallet.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// === Ensure Table Exists ===
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  tg_id TEXT PRIMARY KEY,
  name TEXT,
  balance INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS manual_topups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id TEXT NOT NULL,
  nominal INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  approved_at TEXT,
  admin_id TEXT,
  bukti TEXT
);
`);

const stmtUpsertUser = db.prepare(`
INSERT INTO users (tg_id, name, balance, created_at)
VALUES (@tg_id, @name, 0, @created_at)
ON CONFLICT(tg_id) DO UPDATE SET name = excluded.name
`);
const stmtAddBalance = db.prepare(`UPDATE users SET balance = balance + ? WHERE tg_id=?`);
const stmtGetUser = db.prepare(`SELECT * FROM users WHERE tg_id=?`);
const stmtCreateManual = db.prepare(`
INSERT INTO manual_topups (tg_id, nominal, bukti, created_at)
VALUES (?, ?, ?, ?)
`);
const stmtApprove = db.prepare(`
UPDATE manual_topups SET status='approved', approved_at=?, admin_id=? WHERE id=? AND status='pending'
`);

const nowISO = () => new Date().toISOString();
const fullname = u => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'User';
const idr = n => Number(n||0).toLocaleString('id-ID');
const send = (bot, chatId, text, opt={}) => bot.sendMessage(chatId, text, { parse_mode:'Markdown', ...opt });

// === START Flow ===
async function startFlow(bot, msg) {
  const tg_id = String(msg.from.id);
  const name = fullname(msg.from);
  stmtUpsertUser.run({ tg_id, name, created_at: nowISO() });

  global.__manual_sessions ??= {};
  const key = `${msg.chat.id}:${msg.from.id}`;
  global.__manual_sessions[key] = { step: 1 };

  send(bot, msg.chat.id,
`💰 *TOPUP MANUAL*
Silakan kirim nominal yang ingin kamu topup (contoh: \`1000\`).

Ketik */batal* untuk membatalkan.`);
}

// === Continue ===
async function handleContinue(bot, msg) {
  const key = `${msg.chat.id}:${msg.from.id}`;
  const S = global.__manual_sessions?.[key];
  if (!S) return false;

  const text = String(msg.text || '').trim();
  if (/^([./])?batal$/i.test(text)) {
    delete global.__manual_sessions[key];
    return send(bot, msg.chat.id, '✅ Sesi topup manual dibatalkan.');
  }

  // Step 1: Nominal
  if (S.step === 1) {
    const nominal = parseInt(text.replace(/[^\d]/g,''), 10);
    if (isNaN(nominal) || nominal < 1000)
      return send(bot, msg.chat.id, "⚠️ Nominal tidak valid. Minimal Rp1000.");

    S.nominal = nominal;
    S.step = 2;

    // Ambil saldo user saat ini
    const user = stmtGetUser.get(String(msg.from.id));
    const currentBalance = idr(user.balance);

    // Data pembayaran
    const QRIS_IMAGE_URL = process.env.QRIS_IMAGE_URL || 'url_qrismu';
    const WA_NUMBER = process.env.ADMIN_WA_NUMBER || '0123456789';
    const TELEGRAM_ADMIN_USERNAME = process.env.TELEGRAM_ADMIN_USERNAME || 'username_telemu';

    // Caption preview pembayaran
    const caption = 
`💰 *TOP UP SALDO | JULAK VPN* 💰
══════════════════════

Saldo Saat Ini: Rp${currentBalance}

Metode Pembayaran:
1. Transfer ke rekening atau scan QRIS (jika tersedia)
   🏦 Bank/E-Wallet: DANA
   💳 No. Rekening: 081250851741
   👤 Atas Nama: MISLAN

🔎 [Manual QRIS](${QRIS_IMAGE_URL})

Setelah Transfer:
Kirim bukti transfer beserta User ID Telegram Anda:
\`${msg.from.id}\`

👇 Konfirmasi Ke Admin 👇
💬 [WhatsApp](https://wa.me/${WA_NUMBER}?text=Halo%20admin,%20saya%20mau%20konfirmasi%20top%20up%20saldo.%0AUser%20ID:%20${msg.from.id})
✈️ [Telegram](https://t.me/${TELEGRAM_ADMIN_USERNAME})

Saldo akan ditambahkan oleh Admin setelah verifikasi.`;

    // Kirim preview pembayaran (foto QRIS jika tersedia)
    try {
      await bot.sendPhoto(msg.chat.id, QRIS_IMAGE_URL, { caption, parse_mode: 'Markdown' });
    } catch (e) {
      await send(bot, msg.chat.id, caption); // fallback teks saja
    }

    // Instruksi lanjut kirim bukti transfer
    return send(bot, msg.chat.id, "📸 Atau kirim *foto bukti transfer ke bot* sekarang dan saldo otomatis bertambah setelah  admin cek dan approve");
  }

  // Step 2: Bukti Foto
  if (S.step === 2) {
    if (!msg.photo || msg.photo.length === 0)
      return send(bot, msg.chat.id, "⚠️ Kirim foto bukti transfer ya.");

    const fileId = msg.photo[msg.photo.length - 1].file_id;

    const info = stmtCreateManual.run(
      String(msg.from.id),
      Number(S.nominal),
      fileId,
      nowISO()
    );

    const topupId = info.lastInsertRowid;
    delete global.__manual_sessions[key];

    // Kirim konfirmasi ke user
    send(bot, msg.chat.id,
`📨 *Permintaan Topup Manual Diterima!*
🆔 ID: #${topupId}
💵 Nominal: Rp${idr(S.nominal)}

⏳ Tunggu admin memverifikasi pembayaranmu.`);

    // Kirim notifikasi ke admin
    const adminId = process.env.ADMIN_TG_ID; // isi ID admin di .env
    if (adminId) {
      send(bot, adminId,
`📢 *Topup Manual Baru!*
User: [${fullname(msg.from)}](tg://user?id=${msg.from.id})
Nominal: Rp${idr(S.nominal)}
ID: #${topupId}

Untuk menyetujui:
\`/approve ${msg.from.id} ${S.nominal} ${topupId}\``,
      { reply_markup: { inline_keyboard: [[{text:'✅ Approve', callback_data:`approve:${msg.from.id}:${S.nominal}:${topupId}`}]] } });
    }
  }

  return true;
}

// === Approve Command (Admin Only) ===
async function handleApprove(bot, msg, args) {
  const isAdmin = String(msg.from.id) === String(process.env.ADMIN_TG_ID);
  if (!isAdmin) return send(bot, msg.chat.id, '❌ Hanya admin yang bisa approve.');

  const [userId, amount, topupId] = args;
  if (!userId || !amount || !topupId)
    return send(bot, msg.chat.id, '⚙️ Format: `/approve <user_id> <nominal> <topup_id>`', {});

  stmtApprove.run(nowISO(), String(msg.from.id), Number(topupId));
  stmtAddBalance.run(Number(amount), String(userId));

  const u = stmtGetUser.get(String(userId));
  send(bot, msg.chat.id, `✅ Berhasil approve topup #${topupId}\nSaldo user sekarang: Rp${idr(u.balance)}`);
  send(bot, userId, `🎉 *Topup manual kamu disetujui!*\nTambahan: Rp${idr(amount)}\nSaldo saat ini: *Rp${idr(u.balance)}*`);
}

// === Export ===
module.exports = {
  name: 'topupmanual',
  aliases: ['topupmanual', 'manualtopup'],
  description: 'Topup saldo manual (admin konfirmasi)',
  async execute(bot, msg) { return startFlow(bot, msg); },
  async continue(bot, msg) { return handleContinue(bot, msg); },
  async approve(bot, msg, args) { return handleApprove(bot, msg, args); }
};
