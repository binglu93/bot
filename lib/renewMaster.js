// lib/renewMaster.js
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const Database = require('better-sqlite3');
const { logPurchase } = require('../lib/db');

// ===== sqlite wallet =====
const DB_PATH = path.resolve(process.cwd(), 'julak', 'wallet.db');
function openDB() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      tg_id TEXT PRIMARY KEY,
      name  TEXT,
      balance INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}
const db = openDB();
const stmtUpsertUser = db.prepare(`
  INSERT INTO users (tg_id, name, balance, created_at)
  VALUES (@tg_id, @name, 0, @created_at)
  ON CONFLICT(tg_id) DO UPDATE SET name = excluded.name
`);
const stmtGetUser    = db.prepare(`SELECT tg_id,name,balance FROM users WHERE tg_id=?`);
const stmtAddBalance = db.prepare(`UPDATE users SET balance = balance + ? WHERE tg_id=?`);

// ===== utils =====
const skey     = (msg) => `${msg.chat?.id}:${msg.from?.id}`;
const textOf   = (msg) => String(msg.text || msg.caption || '').trim();
const send     = (bot, chatId, text, opt={}) => bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opt });
const fullname = (u)=>[u?.first_name,u?.last_name].filter(Boolean).join(' ')||u?.username||'User';
const idr      = (n)=> Number(n||0).toLocaleString('id-ID');

function ensureUserSqlite(msg) {
  const tg_id = String(msg.from.id);
  const name  = fullname(msg.from);
  stmtUpsertUser.run({ tg_id, name, created_at: new Date().toISOString() });
  return stmtGetUser.get(tg_id);
}

function stripAnsi(s='') { return String(s).replace(/\x1b\[[0-9;]*m/g, ''); }

function loadVpsList() {
  const p = path.resolve(process.cwd(), 'julak', 'vps.json');
  if (!fs.existsSync(p)) throw new Error('File ./julak/vps.json tidak ditemukan.');
  const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
  if (!Array.isArray(data) || data.length === 0) throw new Error('Data VPS kosong/tidak valid.');
  return data;
}

function listVpsButtons(arr, name) {
  return arr.map((v,i)=>[
    { text: v.id || `${v.host}:${v.port||22}`, callback_data: `${name}:pickvps:${i}` }
  ]);
}

function sshRun(vps, shellCmd, headerText, bot, msg) {
  return new Promise((resolve) => {
    const conn = new Client();
    conn.on('ready', () => {
      conn.exec(shellCmd, (err, stream) => {
        if (err) {
          send(bot, msg.chat.id, '❌ Gagal menjalankan perintah di VPS.').catch(()=>{});
          conn.end(); return resolve();
        }
        let out = '';
        stream.on('data', (c)=> out += c.toString());
        stream.stderr.on('data', (c)=> out += c.toString());
        stream.on('close', async () => {
          const clean = stripAnsi(out).trim();
          await send(bot, msg.chat.id, `${headerText}\n\n${clean || '(output kosong)'}`).catch(()=>{});
          conn.end(); resolve();
        });
      });
    });
    conn.on('error', (e)=>{ send(bot, msg.chat.id, `❌ SSH Error: ${e?.message||e}`).catch(()=>{}); resolve(); });
    conn.connect({ host: vps.host, port: vps.port||22, username: vps.username, password: vps.password });
  });
}

// ===== validasi username =====
function validateUser(protocol, username) {
  if (protocol === 'ssh') {
    try {
      const raw = fs.readFileSync('/etc/passwd', 'utf-8');
      if (!raw.split('\n').some(line => line.startsWith(username + ':'))) {
        return { ok: false, msg: `User ${username} tidak ditemukan di sistem SSH.` };
      }
      return { ok: true };
    } catch (e) { return { ok: false, msg: e?.message||e }; }
  } else {
    const PENANDA = { vmess:'###', vless:'#&', trojan:'#!' };
    const file = '/etc/xray/config.json';
    if (!fs.existsSync(file)) return { ok:false, msg:`Config tidak ditemukan di ${file}` };
    const raw = fs.readFileSync(file, 'utf-8').split('\n');
    const re = new RegExp(`^${PENANDA[protocol]}\\s+${username}\\s`);
    const found = raw.some(l => re.test(l) || l.includes(`"${username}"`));
    if (!found) return { ok:false, msg:`User ${username} tidak ditemukan di ${protocol} config.` };
    return { ok:true };
  }
}

// ===== plugin master =====
function createRenewMasterPlugin({ name='renew', title='Perpanjang Akun', commandTpls }) {
  global.__renew_sessions ??= Object.create(null); // menyimpan semua session

  function daysToExpStr(days, expMode='days') {
    if (expMode === 'date') {
      const d = new Date();
      d.setDate(d.getDate() + days);
      const pad = n => String(n).padStart(2,'0');
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    }
    return String(days);
  }

  async function start(bot, msg) {
    const key = `${name}:${skey(msg)}`;
    ensureUserSqlite(msg);

    // tampilkan pilihan protocol
    const protocols = Object.keys(commandTpls);
    const buttons = protocols.map(p=>[{ text: p.toUpperCase(), callback_data:`${name}:protocol:${p}` }]);
    buttons.push([{ text:'❌ Batal', callback_data:`${name}:cancel`}]);

    global.__renew_sessions[key] = { step:0 };
    await bot.sendMessage(msg.chat.id, `*${title}*\n\nPilih protocol:`, {
      parse_mode:'Markdown',
      reply_markup: { inline_keyboard: buttons }
    });

    setTimeout(()=>{
      const S = global.__renew_sessions[key];
      if(S && S.step===0){ delete global.__renew_sessions[key]; send(bot,msg.chat.id,'⏳ Sesi dihapus karena tidak ada interaksi 1 menit.').catch(()=>{}); }
    },60000);
  }

  async function cont(bot, msg) {
    const key = `${name}:${skey(msg)}`;
    const S = global.__renew_sessions[key];
    if(!S) return false;

    const t = textOf(msg);

    if(/^([./])?batal$/i.test(t)){
      delete global.__renew_sessions[key];
      await send(bot,msg.chat.id,'✅ Sesi dibatalkan.');
      return true;
    }

    // step 2= input username, step3= input days
    if(S.step===2){
      if(!/^[A-Za-z0-9_.-]{3,32}$/.test(t)){ await send(bot,msg.chat.id,'⚠️ Username harus 3–32 char.'); return true; }
      S.user = t;

      const check = validateUser(S.protocol,S.user);
      if(!check.ok){ await send(bot,msg.chat.id,`❌ ${check.msg}\nSaldo tidak terpotong.`); delete global.__renew_sessions[key]; return true; }

      S.step=3;
      await send(bot,msg.chat.id,'⏳ Masukkan *lama hari* aktif (contoh: `30`).');
      return true;
    }

    if(S.step===3){
      const days=parseInt(t,10);
      if(isNaN(days)||days<=0||days>3650){ await send(bot,msg.chat.id,'⚠️ Hari tidak valid (1–3650).'); return true; }

      const cost = days*200;
      const u = ensureUserSqlite(msg);
      if(u.balance<cost){ await send(bot,msg.chat.id,`💸 Saldo tidak cukup.\n• Harga: Rp${idr(cost)}\n• Saldo: Rp${idr(u.balance)}`); delete global.__renew_sessions[key]; return true; }

      // potong saldo
      db.transaction(()=>{ stmtAddBalance.run(-cost,String(msg.from.id)); })();
      const saldoAfter = u.balance-cost;

      const expStr=daysToExpStr(days);
      const cmd = commandTpls[S.protocol].replaceAll('{USER}',S.user).replaceAll('{EXP}',expStr);

      delete global.__renew_sessions[key];

      await send(bot,msg.chat.id,
        `⏳ Menjalankan ${title} [${S.protocol.toUpperCase()}] di VPS: ${S.vps.id||`${S.vps.host}:${S.vps.port||22}`}\n`+
        `• Durasi: ${days} hari (EXP: ${expStr})\n`+
        `• Harga: Rp${idr(cost)}\n`+
        `• Saldo setelah: Rp${idr(saldoAfter)}`
      );

      await sshRun(S.vps, cmd, `✅ ${title} berhasil!`, bot, msg);

      try{
        logPurchase({
          tg_id : msg.from.id,
          kind  : `${title}-${S.protocol}`.toLowerCase().replace(/\s+/g,'-'),
          days  : days,
          vps_id: S.vps?.id||`${S.vps.host}:${S.vps.port||22}`
        });
      }catch(e){ console.error('[logPurchase] error:',e?.message||e); }

      return true;
    }

    return true;
  }

  async function onCallbackQuery(bot, query){
    try{
      const msg = query.message;
      const sessionKey = `${name}:${msg.chat.id}:${query.from.id}`; // konsisten dengan start()
      const S = global.__renew_sessions[sessionKey];
      if(!S){
        await bot.answerCallbackQuery(query.id, { text: 'Sesi tidak ditemukan atau kedaluwarsa.' });
        return false;
      }

      const data = String(query.data || '');

      if(data === `${name}:cancel`){
        delete global.__renew_sessions[sessionKey];
        await bot.answerCallbackQuery(query.id, { text: 'Dibatalkan.' });
        await send(bot, msg.chat.id, '✅ Sesi dibatalkan.');
        return true;
      }

      const parts = data.split(':');

      // pilih protocol (step 0)
      if(S.step === 0 && parts[1] === 'protocol'){
        const proto = parts[2];
        if (!commandTpls[proto]) {
          await bot.answerCallbackQuery(query.id, { text: 'Protocol tidak dikenal.' });
          return false;
        }
        S.protocol = proto;
        S.step = 1;

        // tampilkan list VPS
        const vpsList = loadVpsList();
        S.vpsList = vpsList;
        const buttons = listVpsButtons(vpsList, name);
        buttons.push([{ text: '❌ Batal', callback_data: `${name}:cancel` }]);

        await bot.answerCallbackQuery(query.id, { text: `Protocol dipilih: ${S.protocol.toUpperCase()}` });
        await bot.sendMessage(msg.chat.id, 'Pilih server:', { reply_markup: { inline_keyboard: buttons } });
        return true;
      }

      // pilih VPS (step 1)
      if(S.step === 1 && parts[1] === 'pickvps'){
        const idx = parseInt(parts[2], 10);
        if (isNaN(idx) || idx < 0 || idx >= (S.vpsList || []).length) {
          await bot.answerCallbackQuery(query.id, { text: 'Pilihan tidak valid.' });
          return false;
        }

        S.vps = S.vpsList[idx];
        S.step = 2;

        await bot.answerCallbackQuery(query.id, { text: `Server dipilih: ${S.vps.id || S.vps.host}` });

        // bersihkan keyboard (opsional)
        try {
          await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: msg.chat.id, message_id: msg.message_id });
        } catch (e) { /* ignore */ }

        await send(bot, msg.chat.id, '👤 Masukkan *username* akun yang akan diperpanjang:', { parse_mode: 'Markdown' });
        return true;
      }

      // jika tidak ada kondisi yang cocok
      return false;
    }catch(err){
      console.error('[onCallbackQuery] error:', err);
      try {
        await bot.answerCallbackQuery(query.id, { text: 'Terjadi error di server.' });
      } catch(e){}
      return false;
    }
  }

  return {
    name,
    description: `${title} (multi-protocol)`,
    async execute(bot, msg){ return start(bot, msg); },
    async continue(bot, msg){ return cont(bot, msg); },
    async onCallbackQuery(bot, query){ return onCallbackQuery(bot, query); }
  };
}

module.exports = { createRenewMasterPlugin };
