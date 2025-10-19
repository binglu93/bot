require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const Database = require('better-sqlite3');
const { logPurchase } = require('../lib/db');

const HARGA_PER_HARI = Number(process.env.HARGA_PER_HARI || 200);

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

// ===== inline keyboard VPS =====
async function promptPickVpsInline(bot, msg, title, callbackPrefix) {
  const vpsList = loadVpsList();
  const keyboard = vpsList.map(vps => [
    { text: vps.id || vps.host, callback_data: `${callbackPrefix}:pick:${vps.id||vps.host}` }
  ]);

  const txt = `${title}\n\nPilih salah satu server di bawah:`;
  await bot.sendMessage(msg.chat.id, txt, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });

  return vpsList;
}

// ===== SSH runner =====
function sshRun(vps, shellCmd, headerText, bot, msg, opts = {}) {
  return new Promise((resolve) => {
    const conn = new Client();
    let finished = false;
    const timer = opts.timeoutMs ? setTimeout(() => {
      if (!finished) {
        finished = true;
        try { conn.end(); } catch(e) {}
        resolve({ ok: false, reason: 'timeout', stdout: '', stderr: 'SSH timeout' });
      }
    }, opts.timeoutMs) : null;

    conn.on('ready', () => {
      conn.exec(shellCmd, (err, stream) => {
        if (err) {
          if (timer) clearTimeout(timer);
          finished = true;
          send(bot, msg.chat.id, '❌ Gagal menjalankan perintah di VPS.').catch(()=>{});
          conn.end();
          return resolve({ ok: false, reason: 'exec_error', stdout: '', stderr: String(err) });
        }
        let out = '';
        let errOut = '';
        stream.on('data', (c)=> out += c.toString());
        stream.stderr.on('data', (c)=> errOut += c.toString());
        stream.on('close', async (code, signal) => {
          if (timer) clearTimeout(timer);
          finished = true;
          const clean = stripAnsi((out + '\n' + errOut).trim());
          if (headerText) {
            await send(bot, msg.chat.id, `${headerText}\n\n${clean || '(output kosong)'}`).catch(()=>{});
          }
          conn.end();
          resolve({ ok: true, code: typeof code==='number'?code:null, stdout: out, stderr: errOut, combined: clean });
        });
      });
    });
    conn.on('error', (e)=>{ 
      if (timer) clearTimeout(timer);
      if (!finished) {
        finished = true;
        send(bot, msg.chat.id, `❌ SSH Error: ${e?.message||e}`).catch(()=>{});
        resolve({ ok: false, reason: 'conn_error', stdout:'', stderr: String(e) });
      }
    });
    conn.connect({ host: vps.host, port: vps.port||22, username: vps.username, password: vps.password });
  });
}

/**
 * createAddSshPlugin (all-in-one inline keyboard + callback)
 */
function createAddSshPlugin({ name, aliases=[], title, commandTpl, expMode='days', hargaPerHari=0 }) {
  global.__addssh_sessions ??= Object.create(null);

  function daysToExpStr(days){
    if(expMode==='date'){
      const d = new Date(); d.setDate(d.getDate()+days);
      const pad = n=>String(n).padStart(2,'0');
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    }
    return String(days);
  }

  async function start(bot, msg){
    const key = `${name}:${skey(msg)}`;
    let vpsList;
    try { 
      vpsList = await promptPickVpsInline(bot, msg, `*${title}*`, name);
    } catch(e){ 
      return send(bot, msg.chat.id, `❌ ${e.message||e}`); 
    }

    ensureUserSqlite(msg);
    global.__addssh_sessions[key] = { step: 1, vpsList };

    setTimeout(() => {
      const S = global.__addssh_sessions[key];
      if (S && S.step === 1) {
        delete global.__addssh_sessions[key];
        send(bot, msg.chat.id, '⏳ Sesi dihapus karena tidak memilih VPS 1 menit.').catch(()=>{});
      }
    }, 60_000);
  }

  async function cont(bot, msg){
    const key = `${name}:${skey(msg)}`;
    const S = global.__addssh_sessions[key];
    const t = textOf(msg);
    if (!S) return false;

    if (/^([./])?batal$/i.test(t)) {
      delete global.__addssh_sessions[key];
      await send(bot, msg.chat.id, '✅ Sesi dibatalkan.');
      return true;
    }

    if (S.step === 2) {
      if (!/^[A-Za-z0-9_.-]{3,32}$/.test(t)) {
        await send(bot, msg.chat.id, '⚠️ Username harus 3–32 char (huruf/angka/_ . -). Coba lagi.');
        return true;
      }
      S.user = t;
      S.step = 3;
      await send(bot, msg.chat.id, '🔒 Masukkan *password*:');
      return true;
    }

    if (S.step === 3) {
      if (t.length < 3 || t.length > 64) {
        await send(bot, msg.chat.id, '⚠️ Password harus 3–64 karakter. Coba lagi.');
        return true;
      }
      S.pass = t;
      S.step = 4;
      await send(bot, msg.chat.id, '⏳ Masukkan *Masa Aktif*');
      return true;
    }

    if (S.step === 4) {
      const days = parseInt(t, 10);
      if (isNaN(days) || days <= 0 || days > 3650) {
        await send(bot, msg.chat.id, '⚠️ Hari tidak valid (1–3650). Coba lagi.');
        return true;
      }

      if(!hargaPerHari || hargaPerHari<=0){ await send(bot,msg.chat.id,'❌ Harga per hari belum diatur'); delete global.__addssh_sessions[key]; return true; }

      const cost = days*hargaPerHari;
      const u = ensureUserSqlite(msg);
      const saldoBefore = u?.balance || 0;

      if (saldoBefore < cost) {
        const kurang = cost - saldoBefore;
        await send(
          bot,
          msg.chat.id,
          `💸 *Saldo tidak cukup*.\n` +
          `• Harga: Rp${idr(cost)}\n` +
          `• Saldo: Rp${idr(saldoBefore)}\n` +
          `• Kurang: *Rp${idr(kurang)}*`
        );
        delete global.__addssh_sessions[key];
        return true;
      }

      const expStr = daysToExpStr(days);
      const cmd = commandTpl
        .replaceAll('{USER}', S.user)
        .replaceAll('{PASS}', S.pass)
        .replaceAll('{EXP}',  expStr);

      await send(bot,msg.chat.id,`⏳ Membuat SSH di VPS ${S.vps.id||S.vps.host}\n• Username: ${S.user}\n• Durasi: ${days} hari\n• Total Harga: Rp${idr(cost)}\n• Saldo sebelum: Rp${idr(saldoBefore)}`);

      const res = await sshRun(S.vps,cmd,'',bot,msg,{timeoutMs:20000});
      if(!res.ok){
        await send(bot,msg.chat.id,`❌ Gagal membuat SSH. Saldo tidak dipotong.\nReason: ${res.reason || 'unknown'}`);
        delete global.__addssh_sessions[key]; return true;
      }

      const combined = String(res.combined||'').toLowerCase();
      const exitCode = res.code;
      const failPatterns = ['no such file','not found','command not found','permission denied','error','failed'];
      const exitCodeFailed = exitCode!==null && exitCode!==0;
      const matchedFail = failPatterns.some(p=>combined.includes(p));
      if(exitCodeFailed||matchedFail){
        await send(bot,msg.chat.id,`❌ Gagal membuat SSH. Output:\n${res.combined||'(no output)'}\nSaldo tidak dipotong.`);
        delete global.__addssh_sessions[key]; return true;
      }

      // sukses -> potong saldo
      db.transaction(()=>{ stmtAddBalance.run(-cost,String(msg.from.id)) })();
      delete global.__addssh_sessions[key];

      await send(bot,msg.chat.id,
        `✅ SSH berhasil dibuat !\n\n${res.combined||'(no output)'}`
      );

      try{ logPurchase({ tg_id: msg.from.id, kind:'ssh', days, vps_id: S.vps?.id||S.vps?.host }); }catch(e){console.error('[logPurchase SSH]',e?.message||e); }

      return true;
    }

    return true;
  }

  // ===== inline keyboard callback otomatis =====
  function attachCallbackHandler(bot){
    bot.on('callback_query', async query => {
      try {
        const data = query.data;
        if(!data.startsWith(`${name}:pick:`)) return;

        const chatId = query.message.chat.id;
        const key = `${name}:${chatId}:${query.from.id}`;
        const S = global.__addssh_sessions[key];
        if(!S) return bot.answerCallbackQuery(query.id, { text: '❌ Sesi sudah kadaluarsa.' });

        const vpsId = data.split(':')[2];
        const picked = S.vpsList.find(v => (v.id||v.host) === vpsId);
        if(!picked) return bot.answerCallbackQuery(query.id, { text: '❌ VPS tidak ditemukan.' });

        S.vps = picked;
        S.step = 2;

        await bot.editMessageText(`✅ VPS dipilih: ${picked.id||picked.host}\n\n👤 Masukkan *username*:`, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown'
        });

        await bot.answerCallbackQuery(query.id);
      } catch(e){
        console.error('[callback_query addssh]', e);
      }
    });
  }

  return {
    name,
    aliases,
    description: `${title} (pakai saldo, harga per hari dari .env)`,
    async execute(bot,msg){ 
      attachCallbackHandler(bot);
      return start(bot,msg); 
    },
    async continue(bot,msg){ return cont(bot,msg); }
  };
}

module.exports = { createAddSshPlugin };
