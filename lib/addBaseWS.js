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

// === tampilkan daftar server dengan tombol ===
async function promptPickVps(bot, msg, title) {
  const vpsList = loadVpsList();
  const keyboard = vpsList.map((v, i) => [{
    text: v.id || `${v.host}:${v.port || 22}`,
    callback_data: `pickvps:${i}`
  }]);

  const txt = `${title}\n\nPilih salah satu server di bawah:`;
  await bot.sendMessage(msg.chat.id, txt, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });

  return vpsList;
}

// === eksekusi SSH command ===
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

// === callback tombol pilih server (versi fix duplikat) ===
async function handleVpsPick(bot, query) {
  const data = query.data;
  if (!data.startsWith('pickvps:')) return false;

  const idx = parseInt(data.split(':')[1]);

  // cari session yang aktif dan sedang di tahap pilih server (step=1)
  const key = Object.keys(global.__addws_sessions || {}).find(k => {
    const s = global.__addws_sessions[k];
    return s && s.step === 1 && k.endsWith(`:${query.from.id}`);
  });

  if (!key) {
    await bot.answerCallbackQuery(query.id, {
      text: '⚠️ Sesi tidak ditemukan atau sudah kadaluarsa.',
      show_alert: true
    });
    return true;
  }

  const S = global.__addws_sessions[key];

  if (!S || !S.vpsList || !S.vpsList[idx]) {
    await bot.answerCallbackQuery(query.id, {
      text: '❌ Server tidak ditemukan.',
      show_alert: true
    });
    return true;
  }

  // jika user tekan tombol dua kali, abaikan
  if (S.step !== 1) {
    await bot.answerCallbackQuery(query.id, {
      text: '⚠️ Server sudah dipilih sebelumnya.',
      show_alert: false
    });
    return true;
  }

  // simpan VPS yang dipilih
  S.vps = S.vpsList[idx];
  S.step = 2;

  await bot.answerCallbackQuery(query.id, {
    text: `✅ Server dipilih: ${S.vps.id || S.vps.host}`
  });

  // minta input username
  await bot.sendMessage(query.message.chat.id, '👤 Masukkan *username*:', {
    parse_mode: 'Markdown'
  });

  return true;
}

// === Plugin utama ===
function createAddWsPlugin({ name, aliases=[], title, commandTpl, expMode='days', hargaPerHari=0 }) {
  global.__addws_sessions ??= Object.create(null);
  
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
    try{ vpsList = await promptPickVps(bot, msg, `*${title}*`); }
    catch(e){ return send(bot, msg.chat.id, `❌ ${e.message||e}`); }

    ensureUserSqlite(msg);
    global.__addws_sessions[key] = { step: 1, vpsList };

    setTimeout(() => {
      const S = global.__addws_sessions[key];
      if (S && S.step === 1) {
        delete global.__addws_sessions[key];
        send(bot, msg.chat.id, '⏳ Sesi dihapus karena tidak ada input 1 menit.').catch(()=>{});
      }
    }, 60_000);
  }

  async function cont(bot, msg){
    const key = `${name}:${skey(msg)}`;
    const S = global.__addws_sessions[key];
    const t = textOf(msg);
    if (!S) return false;

    if (/^([./])?batal$/i.test(t)) {
      delete global.__addws_sessions[key];
      await send(bot, msg.chat.id, '✅ Sesi dibatalkan.');
      return true;
    }

    if (S.step === 1) {
      await send(bot, msg.chat.id, '⚠️ Silakan pilih server lewat tombol, bukan mengetik.');
      return true;
    }

    if (S.step === 2) {
      if (!/^[A-Za-z0-9_.-]{3,32}$/.test(t)) {
        await send(bot, msg.chat.id, '⚠️ Username harus 3–32 char (huruf/angka/_ . -). Coba lagi.');
        return true;
      }
      S.user = t;
      S.step = 3;
      await send(bot, msg.chat.id, '⏳ Masukkan *Masa Aktif (hari)*:');
      return true;
    }

    if (S.step === 3) {
      const days = parseInt(t, 10);
      if (isNaN(days) || days <= 0 || days > 3650) {
        await send(bot, msg.chat.id, '⚠️ Hari tidak valid (1–3650). Coba lagi.');
        return true;
      }

      if(!hargaPerHari || hargaPerHari<=0){ 
        await send(bot,msg.chat.id,'❌ Harga per hari belum diatur'); 
        delete global.__addws_sessions[key]; 
        return true; 
      }

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
        delete global.__addws_sessions[key];
        return true;
      }

      const expStr = daysToExpStr(days);
      const cmd = commandTpl
        .replaceAll('{USER}', S.user)
        .replaceAll('{EXP}',  expStr);

      await send(bot,msg.chat.id,`⏳ Membuat ${title} di VPS ${S.vps.id||S.vps.host}\n• Username: ${S.user}\n• Durasi: ${days} hari\n• Total Harga: Rp${idr(cost)}\n• Saldo sebelum: Rp${idr(saldoBefore)}`);

      const res = await sshRun(S.vps,cmd,'',bot,msg,{timeoutMs:20000});
      if(!res.ok){
        await send(bot,msg.chat.id,`❌ Gagal membuat ${title}. Saldo tidak dipotong.\nReason: ${res.reason || 'unknown'}`);
        delete global.__addws_sessions[key]; return true;
      }

      // cek error
      const combined = String(res.combined||'').toLowerCase();
      const exitCode = res.code;
      const failPatterns = ['no such file','not found','command not found','permission denied','error','failed'];
      const exitCodeFailed = exitCode!==null && exitCode!==0;
      const matchedFail = failPatterns.some(p=>combined.includes(p));
      if(exitCodeFailed||matchedFail){
        await send(bot,msg.chat.id,`❌ Gagal membuat ${title}. Output:\n${res.combined||'(no output)'}\nSaldo tidak dipotong.`);
        delete global.__addws_sessions[key]; return true;
      }

      // sukses -> potong saldo
      db.transaction(()=>{ stmtAddBalance.run(-cost,String(msg.from.id)) })();
      const saldoAfter = saldoBefore - cost;
      delete global.__addws_sessions[key];

      await send(bot,msg.chat.id,`✅ ${title} berhasil dibuat !\n\n${res.combined||'(no output)'}`);

      try{ logPurchase({ tg_id: msg.from.id, kind:'vmess', days, vps_id: S.vps?.id||S.vps?.host }); }
      catch(e){ console.error('[logPurchase SSH]',e?.message||e); }

      return true;
    }

    return true;
  }

  return {
    name,
    aliases,
    description: `${title} (pakai saldo, harga per hari dari .env)`,
    async execute(bot,msg){ return start(bot,msg); },
    async continue(bot,msg){ return cont(bot,msg); },
    handleVpsPick
  };
}

module.exports = { createAddWsPlugin, handleVpsPick };
