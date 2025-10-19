// lib/renewTemplateAutoPrice.js
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(process.cwd(), 'julak', 'wallet.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
const stmtGetUser    = db.prepare(`SELECT tg_id,name,balance FROM users WHERE tg_id=?`);
const stmtAddBalance = db.prepare(`UPDATE users SET balance = balance + ? WHERE tg_id=?`);

function ensureUserSqlite(msg) {
  const tg_id = String(msg.from.id);
  const name  = [msg.from.first_name,msg.from.last_name].filter(Boolean).join('')||msg.from.username||'User';
  db.prepare(`
    INSERT INTO users (tg_id,name,balance,created_at)
    VALUES (@tg_id,@name,0,@created_at)
    ON CONFLICT(tg_id) DO UPDATE SET name=excluded.name
  `).run({ tg_id, name, created_at: new Date().toISOString() });
  return stmtGetUser.get(tg_id);
}

function loadHarga() {
  const file = path.resolve(process.cwd(),'julak','harga.json');
  if(!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file,'utf-8'));
}

function stripAnsi(s=''){ return String(s).replace(/\x1b\[[0-9;]*m/g,''); }

function loadVpsList() {
  const p = path.resolve(process.cwd(), 'julak', 'vps.json');
  if (!fs.existsSync(p)) throw new Error('File ./julak/vps.json tidak ditemukan.');
  const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
  if (!Array.isArray(data) || data.length === 0) throw new Error('Data VPS kosong/tidak valid.');
  return data;
}
const listVpsText = (arr) => arr.map((v,i)=>`${i+1}. ${v.id || `${v.host}:${v.port||22}`}`).join('\n');
async function promptPickVps(bot, msg, title) {
  const vpsList = loadVpsList();
  const txt =
`${title}

Balas ANGKA untuk memilih SERVER:

${listVpsText(vpsList)}

Ketik /batal untuk membatalkan.`;
  await bot.sendMessage(msg.chat.id, txt);
  return vpsList;
}

function sshRun(vps, shellCmd) {
  return new Promise(resolve=>{
    const conn = new Client();
    let out='';
    conn.on('ready', ()=>{
      conn.exec(shellCmd,(err,stream)=>{
        if(err){ conn.end(); return resolve({ ok:false, output:err.message }); }
        stream.on('data',c=>out+=c.toString());
        stream.stderr.on('data',c=>out+=c.toString());
        stream.on('close',()=>{ conn.end(); resolve({ ok:true, output:stripAnsi(out) }); });
      });
    });
    conn.on('error', e=>resolve({ ok:false, output:e.message }));
    conn.connect({ host:vps.host, port:vps.port||22, username:vps.username, password:vps.password });
  });
}

function createRenewPluginAutoPrice({ name, aliases=[], title, commandTpl, validateUser }) {
  global.__renew_sessions ??= Object.create(null);
  const hargaList = loadHarga();

  async function start(bot, msg) {
    const key = `${name}:${msg.chat.id}:${msg.from.id}`;
    let vpsList;
    try{ vpsList = await promptPickVps(bot,msg,`*${title}*`); }
    catch(e){ return bot.sendMessage(msg.chat.id,`❌ ${e.message}`); }

    ensureUserSqlite(msg);
    global.__renew_sessions[key]={ step:1, vpsList };

    setTimeout(()=>{
      if(global.__renew_sessions[key]?.step===1){
        delete global.__renew_sessions[key];
        bot.sendMessage(msg.chat.id,'⏳ Sesi dihapus karena tidak ada input 1 menit.').catch(()=>{});
      }
    },60_000);
  }

  async function cont(bot, msg) {
    const key = `${name}:${msg.chat.id}:${msg.from.id}`;
    const S = global.__renew_sessions[key];
    const t = (msg.text||'').trim();
    if(!S) return false;

    if(/^([./])?batal$/i.test(t)){
      delete global.__renew_sessions[key];
      await bot.sendMessage(msg.chat.id,'✅ Sesi dibatalkan.');
      return true;
    }

    if(S.step===1){
      const idx=parseInt(t,10)-1;
      if(isNaN(idx) || idx<0 || idx>=S.vpsList.length){
        await bot.sendMessage(msg.chat.id,'⚠️ Pilihan tidak valid! Balas dengan angka yang tertera.');
        return true;
      }
      S.vps = S.vpsList[idx];
      S.step=2;
      await bot.sendMessage(msg.chat.id,'👤 Masukkan *username* akun yang akan diperpanjang:');
      return true;
    }

    if(S.step===2){
      S.user = t;
      try{ validateUser(S.user); }
      catch(e){
        await bot.sendMessage(msg.chat.id,`❌ ${e.message||'User tidak valid.'}`);
        return true;
      }
      S.step=3;
      await bot.sendMessage(msg.chat.id,'⏳ Masukkan lama hari aktif (contoh: `30`):');
      return true;
    }

    if(S.step===3){
      const days = parseInt(t,10);
      if(isNaN(days)||days<=0||days>3650){
        await bot.sendMessage(msg.chat.id,'⚠️ Hari tidak valid (1–3650). Coba lagi.');
        return true;
      }

      const u = ensureUserSqlite(msg);
      const harga = hargaList[name] || 1000; // fallback
      const cost = harga*days;
      if(u.balance<cost){
        await bot.sendMessage(msg.chat.id,`💸 Saldo tidak cukup. Harga: ${cost}, Saldo: ${u.balance}`);
        return true;
      }

      db.transaction(()=>{ stmtAddBalance.run(-cost,String(msg.from.id)); })();
      const cmd = commandTpl.replaceAll('{USER}',S.user).replaceAll('{EXP}',String(days));
      const result = await sshRun(S.vps,cmd);

      await bot.sendMessage(msg.chat.id,result.ok?`✅ ${title} berhasil.\n\n${result.output}`:`❌ Gagal: ${result.output}`);

      delete global.__renew_sessions[key];
      return true;
    }

    return true;
  }

  return {
    name, aliases, description:title,
    async execute(bot,msg){ return start(bot,msg); },
    async continue(bot,msg){ return cont(bot,msg); }
  };
}

module.exports = { createRenewPluginAutoPrice };
