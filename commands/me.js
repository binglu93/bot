// commands/me.js
const path = require('path');
const Database = require('better-sqlite3');
const ownerUtil = require('../lib/owner'); 

const { isOwnerMsg } = ownerUtil;

const DB_PATH = path.resolve(process.cwd(), 'julak', 'wallet.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const stmtGetUser = db.prepare(`SELECT tg_id, name, balance FROM users WHERE tg_id=?`);
const idr = n => Number(n||0).toLocaleString('id-ID');

async function show(bot, msg) {
  const tgId = String(msg.from.id);
  const row = stmtGetUser.get(tgId) || { name: msg.from.username || msg.from.first_name || 'User', balance: 0 };

  let txt = `👤 *Informasi Akun*\n\n`;
  txt += `• Username : @${msg.from.username || 'N/A'}\n`;
  txt += `• Nama     : ${row.name || 'N/A'}\n`;
  txt += `• Saldo    : Rp${idr(row.balance)}\n`;

  if (isOwnerMsg(msg)) {
    txt += `\n🛡 Anda admin/owner`;
  }

  await bot.sendMessage(msg.chat.id, txt, { parse_mode:'Markdown' });
}

module.exports = {
  name: 'me',
  aliases: ['me', 'saldo', 'profile'],
  description: 'Tampilkan info akun & saldo',
  async show(bot, msg){ return show(bot,msg); },
  async execute(bot, msg){ return show(bot,msg); }
};
