// commands/approve.js
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(process.cwd(), 'julak', 'wallet.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const stmtApprove = db.prepare(`
  UPDATE manual_topups
  SET status='approved', approved_at=?, admin_id=?
  WHERE id=? AND status='pending'
`);
const stmtAddBalance = db.prepare(`UPDATE users SET balance = balance + ? WHERE tg_id=?`);
const stmtGetUser = db.prepare(`SELECT * FROM users WHERE tg_id=?`);

const nowISO = () => new Date().toISOString();
const idr = n => Number(n||0).toLocaleString('id-ID');

module.exports = {
  name: 'approve',
  description: 'Approve topup manual (admin only)',
  async execute(bot, msg, args) {
    const adminId = String(msg.from.id);
    if (adminId !== String(process.env.ADMIN_TG_ID))
      return bot.sendMessage(msg.chat.id, '❌ Hanya admin yang bisa approve.');

    const [userId, amount, topupId] = args;
    if (!userId || !amount || !topupId)
      return bot.sendMessage(msg.chat.id, '⚙️ Format: /approve <user_id> <nominal> <topup_id>');

    // Update manual_topups
    stmtApprove.run(nowISO(), adminId, Number(topupId));

    // Tambah saldo user
    stmtAddBalance.run(Number(amount), String(userId));
    const u = stmtGetUser.get(String(userId));

    bot.sendMessage(msg.chat.id, `✅ Topup #${topupId} berhasil disetujui.\nSaldo user sekarang: Rp${idr(u.balance)}`);
    bot.sendMessage(userId, `🎉 Topup manual kamu disetujui!\nTambahan: Rp${idr(amount)}\nSaldo saat ini: Rp${idr(u.balance)}`);
  }
};
