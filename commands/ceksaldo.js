// commands/ceksaldo_tg.js
const path = require('path');
const Database = require('better-sqlite3');
const DB_PATH = path.resolve(process.cwd(), 'julak', 'wallet.db');
const db = new Database(DB_PATH);
const idr = n => Number(n||0).toLocaleString('id-ID');

module.exports = {
  name: 'ceksaldo',
  aliases: ['saldo'],
  description: 'Cek saldo dan 5 transaksi terakhir',
  async execute(bot, msg) {
    const u = db.prepare(`SELECT tg_id,name,balance FROM users WHERE tg_id=?`).get(String(msg.from.id));
    if (!u) return bot.sendMessage(msg.chat.id, 'Belum ada akun. Jalankan /topup sekali untuk mendaftarkan.');
    const rows = db.prepare(`SELECT id, expected_amount, status, created_at FROM qris_payments WHERE tg_id=? ORDER BY id DESC LIMIT 5`)
                   .all(String(msg.from.id));
    const hist = rows.map(r => `#${r.id} • ${r.status} • Rp${idr(r.expected_amount)} • ${r.created_at.slice(0,19).replace('T',' ')}`).join('\n') || '-';
    const text = `💳 *Cek Saldo*\n• Nama  : ${u.name}\n• Akun  : ${u.tg_id}\n• Saldo : *Rp${idr(u.balance)}*\n\nRiwayat (5):\n${hist}`;
    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
  }
};
