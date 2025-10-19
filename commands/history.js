// commands/history.js
const Database = require('better-sqlite3');
const path = require('path');
const DB_PATH = path.resolve(process.cwd(), 'julak', 'wallet.db');
const db = new Database(DB_PATH);

const stmtHistory = db.prepare(`
  SELECT * FROM qris_payments WHERE tg_id=? ORDER BY id DESC LIMIT 10
`);

const idr = n => Number(n||0).toLocaleString('id-ID');

async function show(bot,msg){
  const chatId = msg.chat.id;
  const tgId = String(msg.from.id);
  const rows = stmtHistory.all(tgId);
  if(!rows.length) return bot.sendMessage(chatId, 'ℹ️ Riwayat tidak ada.');
  let txt = '📄 *Riwayat Topup Terakhir:*\n\n';
  for(const r of rows){
    txt += `• ID: #${r.id} | Nominal: Rp${idr(r.expected_amount)} | Status: ${r.status}\n`;
  }
  await bot.sendMessage(chatId, txt, { parse_mode:'Markdown' });
}

module.exports = {
  name: 'history',
  aliases: ['history','riwayat'],
  description: 'Tampilkan riwayat topup user',
  async show(bot,msg){ return show(bot,msg); },
  async execute(bot,msg){ return show(bot,msg); }
};
