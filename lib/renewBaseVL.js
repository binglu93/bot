// lib/renewBaseVL.js
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
const listVpsText = (arr) => arr.map((v,i)=>`${i+1}. ${v.id || `${v.host}:${v.port||22}`}`).join('\n');

async function promptPickVps(bot, msg, title) {
  const vpsList = loadVpsList();
  const txt =
`${title}

Balas ANGKA untuk memilih SERVER:

${listVpsText(vpsList)}

Ketik /batal untuk membatalkan.`;
  await send(bot, msg.chat.id, txt);
  return vpsList;
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

// ===== validasi username VLess/Xray =====
function validateVLessUser(username) {
  try {
    const JAMBAN_FILE = '/etc/xray/config.json';
    if (!fs.existsSync(JAMBAN_FILE)) return { ok:false, msg:`Config tidak ditemukan di ${JAMBAN_FILE}` };
    const raw = fs.readFileSync(JAMBAN_FILE, 'utf-8');
    const lines = raw.split('\n');
    const found = lines.some(l => l.match(/^#&\s+${username}\s/) || l.includes(`"${username}"`));
    if (!found) return { ok:false, msg:`User ${username} tidak ditemukan di VMess config.` };
    return { ok:true };
  } catch(e) {
    return { ok:false, msg:e?.message || e };
  }
}

// ===== plugin creator =====
function createRenewVLPlugin({ name, aliases=[], title, commandTpl, expMode = 'days' }) {
  global.__renewvl_sessions ??= Object.create(null);

  function daysToExpStr(days) {
    if (expMode === 'date') {
      const d = new Date();
      d.setDate(d.getDate() + days);
      const pad = (n)=> String(n).padStart(2,'0');
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    }
    return String(days);
  }

  async function start(bot, msg) {
    const key = `${name}:${skey(msg)}`;
    let vpsList;
    try { vpsList = await promptPickVps(bot, msg, `*${title}*`); }
    catch (e) { return send(bot, msg.chat.id, `❌ ${e.message || e}`); }

    ensureUserSqlite(msg);
    global.__renewvl_sessions[key] = { step: 1, vpsList };

    setTimeout(() => {
      const S = global.__renewvl_sessions[key];
      if (S && S.step === 1) {
        delete global.__renewvl_sessions[key];
        send(bot, msg.chat.id, '⏳ Sesi dihapus karena tidak ada input 1 menit.').catch(()=>{});
      }
    }, 60_000);
  }

  async function cont(bot, msg) {
    const key = `${name}:${skey(msg)}`;
    const S = global.__renewvl_sessions[key];
    const t = textOf(msg);
    if (!S) return false;

    if (/^([./])?batal$/i.test(t)) {
      delete global.__renewvl_sessions[key];
      await send(bot, msg.chat.id, '✅ Sesi dibatalkan.');
      return true;
    }

    if (S.step === 1) {
      const idx = parseInt(t, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= S.vpsList.length) {
        await send(bot, msg.chat.id, '⚠️ Pilihan tidak valid! Balas dengan angka yang tertera.');
        return true;
      }
      S.vps = S.vpsList[idx];
      S.step = 2;
      await send(bot, msg.chat.id, '👤 Masukkan *username* akun yang akan diperpanjang:');
      return true;
    }

    if (S.step === 2) {
      if (!/^[A-Za-z0-9_.-]{3,32}$/.test(t)) {
        await send(bot, msg.chat.id, '⚠️ Username harus 3–32 char (huruf/angka/_ . -). Coba lagi.');
        return true;
      }
      S.user = t;

      // validasi username
      const check = validateVLessUser(S.user);
      if(!check.ok){
        await send(bot, msg.chat.id, `❌ ${check.msg}\nSaldo tidak terpotong.`);
        delete global.__renewvl_sessions[key];
        return true;
      }

      S.step = 3;
      await send(bot, msg.chat.id, '⏳ Masukkan *lama hari* aktif (contoh: `30`).');
      return true;
    }

    if (S.step === 3) {
      const days = parseInt(t, 10);
      if (isNaN(days) || days <= 0 || days > 3650) {
        await send(bot, msg.chat.id, '⚠️ Hari tidak valid (1–3650). Coba lagi.');
        return true;
      }
      
      const cost = days * 200; // harga tetap Rp200 per hari
      const u = ensureUserSqlite(msg);
      if (u.balance < cost) {
        await send(bot, msg.chat.id, `💸 Saldo tidak cukup.\n• Harga: Rp${idr(cost)}\n• Saldo: Rp${idr(u.balance)}`);
        delete global.__renewvl_sessions[key];
        return true;
      }

      // potong saldo
      const tx = db.transaction(()=>{ stmtAddBalance.run(-cost, String(msg.from.id)); });
      tx();
      const saldoAfter = u.balance - cost;

      const expStr = daysToExpStr(days);
      const cmd = commandTpl
        .replaceAll('{USER}', S.user)
        .replaceAll('{EXP}',  expStr);

      delete global.__renewvl_sessions[key];

      await send(bot, msg.chat.id,
        `⏳ Menjalankan ${title} di VPS: ${S.vps.id || `${S.vps.host}:${S.vps.port||22}`}\n`+
        `• Durasi: ${days} hari (EXP: ${expStr})\n`+
        `• Harga: Rp${idr(cost)}\n`+
        `• Saldo setelah: Rp${idr(saldoAfter)}`
      );

      await sshRun(S.vps, cmd, `✅ ${title} berhasil!`, bot, msg);

      // log pembelian
      try{
        logPurchase({
          tg_id : msg.from.id,
          kind  : (title||'renew-vless').toLowerCase().replace(/\s+/g,'-'),
          days  : days,
          vps_id: S.vps?.id || `${S.vps.host}:${S.vps.port||22}`
        });
      }catch(e){ console.error('[logPurchase] error:', e?.message||e); }

      return true;
    }

    return true;
  }

  return {
    name,
    aliases,
    description: `${title} (pakai saldo; harga dari harga.json; output ANSI dibersihkan)`,
    async execute(bot, msg){ return start(bot, msg); },
    async continue(bot, msg){ return cont(bot, msg); }
  };
}

module.exports = { createRenewVLPlugin };
