// commands/menu.js
const fs = require('fs');
const net = require('net');
const path = require('path');
const Database = require('better-sqlite3');
//const { db, getSaldo, totalUsers, logPurchase } = require('../lib/db'); // sesuaikan path
const { isOwnerMsg } = require('../lib/owner');

// ====== CONFIG ======
const BRAND_NAME = 'JULAK VPN';
const STORE_NAME = 'PAPADAAN-STORE';
const CONTACT_ADM = '@rajaganjil93';

// ====== Plugins ======
function safeRequire(p){ try{ return require(p); } catch{return { execute: async()=>{} }; } }
const pTrialSSH    = safeRequire('./trialssh');
const pTrialVMESS  = safeRequire('./trialvmess');
const pTrialVLESS  = safeRequire('./trialvless');
const pTrialTROJAN = safeRequire('./trialtrojan');
const pAddSSH      = safeRequire('./addssh');
const pAddVMESS    = safeRequire('./addvmess');
const pAddVLESS    = safeRequire('./addvless');
const pAddTROJAN   = safeRequire('./addtrojan');
const pRenewSSH    = safeRequire('./renewssh');
const pRenewVMESS  = safeRequire('./renewvmess');
const pRenewVLESS  = safeRequire('./renewvless');
const pRenewTROJAN = safeRequire('./renewtrojan');
const pTOPUP       = safeRequire('./topup');
const pSALDO       = safeRequire('./ceksaldo');
const pADMIN       = safeRequire('./admin');
const pHISTORY       = safeRequire('./history');
const pTOPMANUAL       = safeRequire('./topupmanual');

// ====== DB ======
const DB_PATH = path.resolve(process.cwd(), 'julak', 'wallet.db');
function openDB() {
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        tg_id TEXT PRIMARY KEY,
        name TEXT,
        balance INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);
    return db;
  } catch {
    return null;
  }
}
const db = openDB();
function getSaldo(tgId) {
  try {
    if (!db) return 0;
    const row = db.prepare(`SELECT balance FROM users WHERE tg_id=?`).get(String(tgId));
    return Number(row?.balance || 0);
  } catch { return 0; }
}
function countUsers() {
  try {
    if (!db) return 0;
    const row = db.prepare(`SELECT COUNT(*) AS n FROM users`).get();
    return Number(row?.n || 0);
  } catch { return 0; }
}

// ===== VPS Status =====
function checkPort(host, port = 22, timeout = 2000){
  return new Promise(resolve=>{
    const sock = new net.Socket();
    let done = false;
    const finish = ok => { if(!done){ done=true; sock.destroy(); resolve(ok); } };
    sock.setTimeout(timeout);
    sock.once('connect', ()=>finish(true));
    sock.once('timeout', ()=>finish(false));
    sock.once('error', ()=>finish(false));
    try{ sock.connect(port, host); } catch{ finish(false); }
  });
}
function loadVpsList(){ const vpsPath=path.resolve(process.cwd(),'julak','vps.json'); if(!fs.existsSync(vpsPath)) return []; try{ return JSON.parse(fs.readFileSync(vpsPath,'utf-8'))||[]; } catch{return [];} }
async function getVpsStatuses(){ const list=loadVpsList(); const results=await Promise.all(list.map(async v=>{ const ok=await checkPort(v.host,v.port||22); return { name:v.name||v.id||v.host, online:ok }; })); return { results, count:list.length };}

// ===== Utils =====
const idr = n=>Number(n||0).toLocaleString('id-ID');
function fmtUptime(sec){ sec=Math.max(0,Math.floor(sec)); const d=Math.floor(sec/86400); sec-=d*86400; const h=Math.floor(sec/3600); sec-=h*3600; const m=Math.floor(sec/60); return `${d}d ${h}h ${m}m`; }
function escapeMd(s){ return s.replace(/([_*[\]()~`>#+-=|{}.!])/g,'\\$1'); }
function escapeBackticks(s=''){ return String(s).replace(/`/g, '\u200b`'); }
function nowJakarta(){ const w=new Date(Date.now()+7*3600*1000); const pad=n=>String(n).padStart(2,'0'); const hh=pad(w.getUTCHours()),mm=pad(w.getUTCMinutes()); const day=['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'][w.getUTCDay()]; const month=['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'][w.getUTCMonth()]; return { time:`${hh}:${mm} WIB`, date:`${day}, ${w.getUTCDate()} ${month} ${w.getUTCFullYear()}` }; }

// ===== Header =====
async function buildHeaderText(msg){
  const uname = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name || 'User';
  const uptime = fmtUptime(process.uptime());
  const { results:vpsList, count:vpsCount } = await getVpsStatuses();
  const status = vpsList.length ? vpsList.map(s=>`${s.online?'🟢':'🔴'} ${escapeBackticks(s.name)}`).join('\n') : '_Tidak ada VPS terdaftar_';
  const saldo = getSaldo(msg.from?.id);
  const totalUsers = countUsers();
  const { time, date } = nowJakarta();

  return [
`🎉 *Selamat Datang di ${BRAND_NAME}* 🎉`,
'━━━━━━━━━━━━━━━━━━━━━━━',
`👤 Pengguna : ${escapeBackticks(uname)}`,
`💰 Saldo : Rp.${idr(saldo)}`,
`🕒 Waktu : ${time}`,
`📅 Tanggal : ${date}`,
`♻️ Uptime Bot : ${uptime}`,
`🖥️ Server Terdaftar : ${vpsCount}`,
`👥 Total User : ${totalUsers}`,
'━━━━━━━━━━━━━━━━━━━━━━━',
'*Status Server:*',
status,
'━━━━━━━━━━━━━━━━━━━━━━━',
`🧭 Tekan tombol di bawah untuk membuka menu utama.`
  ].join('\n');
}

// ===== Keyboard =====
function buildMainKeyboard(isOwner) {
  const rows = [
    [
      { text: '🔰 SSH', callback_data: 'menu:submenu:ssh' },
      { text: '⚡ VMESS', callback_data: 'menu:submenu:vmess' }
    ],
    [
      { text: '🌀 VLESS', callback_data: 'menu:submenu:vless' },
      { text: '✴️ TROJAN', callback_data: 'menu:submenu:trojan' }
    ],
    [
      { text: '💰 SALDO', callback_data: 'menu:submenu:saldo' },
      { text: '📜 Riwayat Transaksi', callback_data: 'menu:run:history' }
    ]
  ];

  if (isOwner)
    rows.push([{ text: '🛡 ADMIN', callback_data: 'menu:submenu:admin' }]);

  rows.push([{ text: '🔄 Refresh', callback_data: 'menu:run:main' }]);
  return { inline_keyboard: rows };
}

function buildSubKeyboard(type) {
  const map = {
    ssh: [
      { text: '➕ Add SSH', callback_data: 'menu:run:addssh' },
      { text: '🆓 Trial SSH', callback_data: 'menu:run:trialssh' },
      { text: '♻️ Renew SSH', callback_data: 'menu:run:renewssh' }
    ],
    vmess: [
      { text: '➕ Add VMess', callback_data: 'menu:run:addvmess' },
      { text: '🆓 Trial VMess', callback_data: 'menu:run:trialvmess' },
      { text: '♻️ Renew VMess', callback_data: 'menu:run:renewvmess' }
    ],
    vless: [
      { text: '➕ Add VLess', callback_data: 'menu:run:addvless' },
      { text: '🆓 Trial VLess', callback_data: 'menu:run:trialvless' },
      { text: '♻️ Renew VLess', callback_data: 'menu:run:renewvless' }
    ],
    trojan: [
      { text: '➕ Add Trojan', callback_data: 'menu:run:addtrojan' },
      { text: '🆓 Trial Trojan', callback_data: 'menu:run:trialtrojan' },
      { text: '♻️ Renew Trojan', callback_data: 'menu:run:renewtrojan' }
    ],
    saldo: [
      { text: '💰 Topup Otomatis Min 5000', callback_data: 'menu:run:topup' },
      { text: '💰 Topup Manual Min 1000', callback_data: 'menu:run:topupmanual' },
      { text: '💳 Cek Saldo', callback_data: 'menu:run:ceksaldo' }
    ],
    admin: [
      { text: '➕ Tambah VPS', callback_data: 'menu:run:admin:addvps' },
      { text: '🗑 Hapus VPS', callback_data: 'menu:run:admin:delvps' },
      { text: '✏️ Edit Harga', callback_data: 'menu:run:admin:editharga' },
      { text: '📣 Broadcast', callback_data: 'menu:run:admin:broadcast' },
      { text: '💸 Add Saldo', callback_data: 'menu:run:admin:addsaldo' },
      { text: '📊 Data User', callback_data: 'menu:run:admin:datauser' }
    ]
  };

  const buttons = map[type] || [];
  buttons.push({ text: '🔙 Kembali', callback_data: 'menu:run:main' });

  return { inline_keyboard: buttons.map(b => [b]) };
}

// ===== Show User List =====
async function showUserList(bot, q){
  try{
    const rows = db.prepare(`SELECT name,balance,created_at FROM users ORDER BY created_at DESC LIMIT 100`).all();
    const total = countUsers();
    if(rows.length===0) return bot.sendMessage(q.message.chat.id,'📭 Belum ada user terdaftar.');
    const lines = rows.map((r,i)=>`${i+1}. ${escapeMd(r.name||'-')} — Rp${idr(r.balance)}\n🗓 ${r.created_at}`).join('\n\n');
    await bot.editMessageText(
      `📊 *Data 10 User Terbaru:*\n\n${lines}\n\nTotal user: *${total}*`,
      {
        chat_id:q.message.chat.id,
        message_id:q.message.message_id,
        parse_mode:'Markdown',
        reply_markup:{ inline_keyboard:[[ {text:'🔙 Kembali',callback_data:'menu:submenu:admin'} ]] }
      }
    );
  }catch(e){
    console.error('showUserList error',e);
    bot.sendMessage(q.message.chat.id,'❌ Gagal mengambil data user.');
  }
}

// ===== Riwayat Transaksi =====
function getUserHistory(tgId, limit=10){
  return db.prepare(`
    SELECT kind AS type, days, vps_id, created_at
    FROM purchase_logs
    WHERE tg_id=?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(String(tgId), limit);
}

async function showUserHistory(bot, q){
  try{
    const rows = getUserHistory(q.from?.id, 10);
    if(rows.length === 0) return bot.editMessageText('📭 Belum ada riwayat transaksi.', { chat_id:q.message.chat.id, message_id:q.message.message_id });

    const lines = rows.map((r,i)=>`${i+1}. ${r.type.toUpperCase()} — VPS: ${r.vps_id||'-'}\n${r.days||0} hari\n🗓 ${r.created_at}`).join('\n\n');

    await bot.editMessageText(
      `📜 *10 Riwayat Transaksi Terbaru:*\n\n${lines}`,
      {
        chat_id:q.message.chat.id,
        message_id:q.message.message_id,
        parse_mode:'Markdown',
        reply_markup:{ inline_keyboard:[[ {text:'🔙 Kembali',callback_data:'menu:run:main'} ]] }
      }
    );
  }catch(e){
    console.error('showUserHistory error', e);
    await bot.sendMessage(q.message.chat.id,'❌ Gagal mengambil riwayat.');
  }
}

// ===== Export =====
module.exports = {
  name:'menubutton',
  aliases:['menu','help','start'],
  description:'Menampilkan menu utama dengan tombol interaktif',

  async execute(bot,msg){
    try{
      const header = await buildHeaderText(msg);
      await bot.sendMessage(msg.chat.id, header, {
        parse_mode:'Markdown',
        reply_markup:{ inline_keyboard:[[ { text:'🧭 Buka Menu Utama', callback_data:'menu:run:main' } ]] }
      });
    }catch(e){
      console.error('[menu] execute error:',e);
      await bot.sendMessage(msg.chat.id,'❌ Gagal menampilkan menu.');
    }
  },

  register(bot){
    if(bot.__menubutton_registered) return;
    bot.__menubutton_registered = true;

    bot.on('callback_query', async q=>{
      try{
        const data=q.data||''; const chatId=q.message.chat.id; const msgId=q.message.message_id;
        await bot.answerCallbackQuery(q.id);
        
        if(data==='menu:run:main'){
          const header='✨ *MENU UTAMA* ✨\nPilih layanan di bawah ini:';
          return bot.editMessageText(header,{
            chat_id:chatId, message_id:msgId, parse_mode:'Markdown',
            reply_markup:buildMainKeyboard(isOwnerMsg(q))
          });
        }
        if(data.startsWith('menu:submenu:')){
          const type=data.split(':')[2];
          const titleMap={ssh:'SSH',vmess:'VMESS',vless:'VLESS',trojan:'TROJAN',saldo:'SALDO',admin:'ADMIN'};
          const header=`*📋 MENU ${titleMap[type]||''}*`;
          return bot.editMessageText(header,{
            chat_id:chatId, message_id:msgId, parse_mode:'Markdown',
            reply_markup:buildSubKeyboard(type)
          });
        }

        if(data==='menu:run:admin:datauser') return showUserList(bot,q);

        if(data.startsWith('menu:run:admin:')){
          const action = data.split(':')[3];
          const fakeMsg = { ...q.message, chat: q.message.chat, from: q.from };
          await pADMIN.execute(bot, fakeMsg, []);
          const stepMap = { addvps:'1', delvps:'2', editharga:'3', broadcast:'4', addsaldo:'5' };
          if(stepMap[action]){ fakeMsg.text = stepMap[action]; await pADMIN.continue(bot, fakeMsg); }
          return;
        }
        
        if(data==='menu:run:history') return showUserHistory(bot,q);

        const map={
          trialssh:pTrialSSH, trialvmess:pTrialVMESS, trialvless:pTrialVLESS, trialtrojan:pTrialTROJAN,
          renewssh:pRenewSSH, renewvmess:pRenewVMESS, renewvless:pRenewVLESS, renewtrojan:pRenewTROJAN,
          addssh:pAddSSH, addvmess:pAddVMESS, addvless:pAddVLESS, addtrojan:pAddTROJAN,
          topup:pTOPUP, ceksaldo:pSALDO, history:pHISTORY, topupmanual:pTOPMANUAL
        };
        const key=data.replace('menu:run:','');
        if(key==='ceksaldo') return refreshSaldo(bot,q);
        const plugin=map[key];
        if(plugin?.execute){
          await bot.editMessageText(`⏳ Menjalankan *${key}*...`,{chat_id:chatId,message_id:msgId,parse_mode:'Markdown'});
          const fakeMsg={...q.message,chat:q.message.chat,from:q.from,text:''};
          return plugin.execute(bot,fakeMsg,[]);
        }
      }catch(err){
        console.error('[menu] callback error:',err);
        await bot.sendMessage(q.message.chat.id,'❌ Terjadi kesalahan tombol.');
      }
    });
  }
};
