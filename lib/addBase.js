// lib/addBase.js
// Flow: pilih VPS -> username -> password -> hari -> cek harga (harga.json) -> potong saldo (SQLite) -> SSH: printf "%s\n" "{USER}" "{PASS}" "2" "{EXP}" | addssh
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const Database = require('better-sqlite3');

// ===== harga loader =====
function loadHarga() {
  const p = path.resolve(process.cwd(), 'julak', 'harga.json');
  if (!fs.existsSync(p)) throw new Error('File ./julak/harga.json tidak ditemukan.');
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}
function getPriceForDays(days) {
  try {
    const harga = loadHarga();
    const v = harga[String(days)];
    if (typeof v === 'number' && v >= 0) return { ok: true, price: v };
    return { ok: false, message: `Durasi ${days} hari belum diatur di harga.json.` };
  } catch (e) {
    return { ok: false, message: e.message || e };
  }
}
function hargaListText() {
  try {
    const harga = loadHarga();
    const entries = Object.entries(harga)
      .map(([d, h]) => [parseInt(d, 10), h])
      .filter(([d, h]) => Number.isInteger(d) && typeof h === 'number')
      .sort((a,b)=>a[0]-b[0]);
    if (!entries.length) return '_Belum ada harga di harga.json_';
    return entries.map(([d,h]) => `• ${d} hari → Rp${Number(h).toLocaleString('id-ID')}`).join('\n');
  } catch {
    return '_Gagal membaca harga.json_';
  }
}

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
const stmtAddBalance = db.prepare(`UPDATE users SET balance = balance + ? WHERE tg_id=?`); // nilai negatif = potong

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

Balas ANGKA untuk memilih VPS:

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

/**
 * createAddSshPlugin
 * Steps:
 *  1) pilih VPS
 *  2) username
 *  3) password
 *  4) hari aktif (integer)
 *  5) tampilkan harga, cek saldo, potong saldo -> eksekusi SSH
 *
 * Options:
 *  - commandTpl: gunakan placeholder {USER} {PASS} {EXP}
 *     contoh: printf "%s\n" "{USER}" "{PASS}" "2" "{EXP}" | addssh
 *  - expMode: 'days' | 'date' (default 'days')
 */
function createAddSshPlugin({ name, aliases=[], title, commandTpl, expMode='days' }) {
  global.__addssh_sessions ??= Object.create(null);

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
    global.__addssh_sessions[key] = { step: 1, vpsList };

    setTimeout(() => {
      const S = global.__addssh_sessions[key];
      if (S && S.step === 1) {
        delete global.__addssh_sessions[key];
        send(bot, msg.chat.id, '⏳ Sesi dihapus karena tidak ada input 1 menit.').catch(()=>{});
      }
    }, 60_000);
  }

  async function cont(bot, msg) {
    const key = `${name}:${skey(msg)}`;
    const S = global.__addssh_sessions[key];
    const t = textOf(msg);
    if (!S) return false;

    if (/^([./])?batal$/i.test(t)) {
      delete global.__addssh_sessions[key];
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
      await send(bot, msg.chat.id, '👤 Masukkan *username* untuk akun:');
      return true;
    }

    if (S.step === 2) {
      // ✅ regex aman (minus di akhir)
      if (!/^[A-Za-z0-9_.-]{3,32}$/.test(t)) {
        await send(bot, msg.chat.id, '⚠️ Username harus 3–32 char (huruf/angka/_ . -). Coba lagi.');
        return true;
      }
      S.user = t;
      S.step = 3;
      await send(bot, msg.chat.id, '🔒 Masukkan *password* untuk akun (3–64 char):');
      return true;
    }

    if (S.step === 3) {
      if (t.length < 3 || t.length > 64) {
        await send(bot, msg.chat.id, '⚠️ Password harus 3–64 karakter. Coba lagi.');
        return true;
      }
      S.pass = t;
      S.step = 4;

      // tampilkan daftar harga
      const listHarga = hargaListText();
      await send(
        bot,
        msg.chat.id,
        `⏳ Masukkan *lama hari* aktif (contoh: \`30\`).\n\n*Daftar Harga:*\n${listHarga}`
      );
      return true;
    }

    if (S.step === 4) {
      const days = parseInt(t, 10);
      if (isNaN(days) || days <= 0 || days > 3650) {
        await send(bot, msg.chat.id, '⚠️ Hari tidak valid (1–3650). Coba lagi.');
        return true;
      }

      const pr = getPriceForDays(days);
      if (!pr.ok) {
        await send(bot, msg.chat.id, `❌ ${pr.message}\nTambahkan mapping di *harga.json*, contoh: {"${days}": 12345}`);
        return true;
      }
      const cost = pr.price;
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
          `• Kurang: *Rp${idr(kurang)}*\n\n` +
          `Silakan /topup terlebih dahulu lalu jalankan perintah ini lagi.`
        );
        delete global.__addssh_sessions[key];
        return true;
      }

      // potong saldo
      const tx = db.transaction(() => {
        stmtAddBalance.run(-cost, String(msg.from.id));
      });
      tx();

      const saldoAfter = saldoBefore - cost;

      S.days = days;
      delete global.__addssh_sessions[key];

      const expStr = daysToExpStr(days);
      const cmd = commandTpl
        .replaceAll('{USER}', S.user)
        .replaceAll('{PASS}', S.pass)
        .replaceAll('{EXP}',  expStr);

      await send(
        bot,
        msg.chat.id,
        `⏳ Membuat ${title} di VPS: ${S.vps.id || `${S.vps.host}:${S.vps.port||22}`}\n` +
        `• Username: ${S.user}\n` +
        `• Durasi: ${days} hari (EXP: ${expStr})\n` +
        `• Harga: Rp${idr(cost)}\n` +
        `• Saldo sebelum: Rp${idr(saldoBefore)}\n` +
        `• Saldo sesudah: Rp${idr(saldoAfter)}`
      );

      await sshRun(S.vps, cmd, `✅ ${title} Berhasil Dibuat!`, bot, msg);
      return true;
    }

    return true;
  }

  return {
    name,
    aliases,
    description: `${title} (pakai saldo; harga dari harga.json; minta password; output asli, ANSI dihapus)`,
    async execute(bot, msg){ return start(bot, msg); },
    async continue(bot, msg){ return cont(bot, msg); }
  };
}

module.exports = { createAddSshPlugin };
