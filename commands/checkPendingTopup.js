// commands/checkPendingTopup.js
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(process.cwd(), 'julak', 'wallet.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const stmtPending = db.prepare(`
  SELECT m.id AS topup_id, m.tg_id, m.nominal, m.status, u.name, u.balance
  FROM manual_topups m
  LEFT JOIN users u ON u.tg_id = m.tg_id
  WHERE m.status = 'pending'
  ORDER BY m.created_at ASC
`);

async function execute(bot, msg) {
  const rows = stmtPending.all();
  if (!rows || rows.length === 0) {
    return bot.sendMessage(msg.chat.id, '✅ Tidak ada topup manual pending.');
  }

  let text = '📋 Topup Manual Pending:\n\n';
  for (const r of rows) {
    text += `ID: #${r.topup_id}\nUser: ${r.name} (${r.tg_id})\nNominal: Rp${Number(r.nominal).toLocaleString('id-ID')}\nSaldo sekarang: Rp${Number(r.balance).toLocaleString('id-ID')}\nStatus: ${r.status}\n\n`;
  }

  await bot.sendMessage(msg.chat.id, text);
}

module.exports = {
  name: 'checkpendingtopup',
  aliases: ['pendingtopup'],
  description: 'Cek topup manual yang belum di-approve',
  execute
};
