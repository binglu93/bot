// lib/addBaseWS.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const Database = require('better-sqlite3');
const { logPurchase } = require('../lib/db');

const HARGA_PER_HARI = Number(process.env.HARGA_PER_HARI || 0);

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

function sshRun(vps, shellCmd, headerText, bot, msg, opts = {}) {
  // opts.timeoutMs (optional) untuk safety
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
          // kirim output asli kalau headerText diberikan
          if (headerText) {
            await send(bot, msg.chat.id, `${headerText}\n\n${clean || '(output kosong)'}`).catch(()=>{});
          }
          conn.end();
          // return object with code and combined output
          resolve({ ok: true, code: typeof code === 'number' ? code : null, stdout: out, stderr: errOut, combined: clean });
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
 * createAddWsPlugin
 * Steps:
 *  1) pilih VPS
 *  2) username
 *  3) hari aktif (integer) -> *expStr* (default pakai jumlah hari)
 *  4) cek saldo, potong saldo -> eksekusi SSH
 *
 * Options:
 *  - commandTpl: string, gunakan placeholder {USER} & {EXP}
 *  - expMode: 'days' | 'date'  (default 'days')
 *     - 'days' => EXP = String(hari)
 *     - 'date' => EXP = YYYY-MM-DD (hari ini + n)
 *  - hargaPerHari: number, harga per hari dari .env
 */
function createAddWsPlugin({ name, aliases=[], title, commandTpl, expMode = 'days', hargaPerHari=0 }) {
  global.__addws_sessions ??= Object.create(null);

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
    global.__addws_sessions[key] = { step: 1, vpsList };

    setTimeout(() => {
      const S = global.__addws_sessions[key];
      if (S && S.step === 1) {
        delete global.__addws_sessions[key];
        send(bot, msg.chat.id, '⏳ Sesi dihapus karena tidak ada input 1 menit.').catch(()=>{});
      }
    }, 60_000);
  }

  async function cont(bot, msg) {
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
      if (!/^[A-Za-z0-9_.-]{3,32}$/.test(t)) {
        await send(bot, msg.chat.id, '⚠️ Username harus 3–32 char (huruf/angka/_ . -). Coba lagi.');
        return true;
      }
      S.user = t;
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

      if (!hargaPerHari || hargaPerHari <= 0) {
        await send(bot, msg.chat.id, '❌ Harga per hari belum diatur. Minta admin set HARGA_PER_HARI di .env atau via /setharga.');
        delete global.__addws_sessions[key];
        return true;
      }

      const cost = days * hargaPerHari;
      const u = ensureUserSqlite(msg);
      const saldoBefore = u?.balance || 0;

      if (saldoBefore < cost) {
        const kurang = cost - saldoBefore;
        await send(
          bot,
          msg.chat.id,
          `💸 *Saldo tidak cukup*.\n` +
          `• Harga per hari: Rp${idr(hargaPerHari)}\n` +
          `• Total ( ${days} hari ): Rp${idr(cost)}\n` +
          `• Saldo: Rp${idr(saldoBefore)}\n` +
          `• Kurang: *Rp${idr(kurang)}*\n\n` +
          `Silakan /topup terlebih dahulu lalu jalankan perintah ini lagi.`
        );
        delete global.__addws_sessions[key];
        return true;
      }

      // sebelum eksekusi: hitung cost & cek saldo seperti biasa
const expStr = daysToExpStr(days);
const cmd = commandTpl
  .replaceAll('{USER}', S.user)
  .replaceAll('{EXP}',  expStr);

// kirim info bahwa proses dibuat
await send(
  bot,
  msg.chat.id,
  `⏳ Membuat ${title} di VPS: ${S.vps.id || `${S.vps.host}:${S.vps.port||22}`}\n` +
  `• Username: ${S.user}\n` +
  `• Durasi: ${days} hari (EXP: ${expStr})\n` +
  `• Harga per hari: Rp${idr(hargaPerHari)}\n` +
  `• Total Harga: Rp${idr(cost)}\n` +
  `• Saldo sebelum: Rp${idr(saldoBefore)}`
);

// jalankan SSH dan tunggu hasil (optional timeout 20s)
const res = await sshRun(S.vps, cmd, '', bot, msg, { timeoutMs: 20_000 });

// jika sshRun gagal (conn/exec error/timeout)
if (!res.ok) {
  await send(bot, msg.chat.id, `❌ Gagal membuat akun — reason: ${res.reason || 'unknown'}. Saldo tidak dipotong.`);
  delete global.__addws_sessions[key];
  return true;
}

// periksa exit code + isi output untuk pola error
const combined = String(res.combined || '').toLowerCase();
const exitCode = res.code;

// pola kegagalan umum (sesuaikan sesuai skrip VPS mu)
const failPatterns = [
  'no such file', 'not found', 'command not found', 'permission denied',
  'error', 'failed', 'segmentation fault'
];
// jika exitCode bukan 0 dianggap gagal (jika tersedia)
const exitCodeFailed = exitCode !== null && exitCode !== 0;
const matchedFail = failPatterns.some(p => combined.includes(p));

if (exitCodeFailed || matchedFail) {
  await send(bot, msg.chat.id, `❌ Gagal membuat akun (server returned error). Output:\n\n${res.combined || '(no output)'}\n\nSaldo tidak dipotong.`);
  delete global.__addws_sessions[key];
  return true;
}

// jika sampai sini => dianggap sukses -> baru potong saldo
const tx = db.transaction(() => {
  stmtAddBalance.run(-cost, String(msg.from.id));
});
tx();

const saldoAfter = saldoBefore - cost;
S.days = days;
delete global.__addws_sessions[key];

// kirim konfirmasi sukses dengan output server
await send(
  bot,
  msg.chat.id,
  `✅ ${title} berhasil dibuat!\n` +
  `• Username: ${S.user}\n` +
  `• Durasi: ${days} hari\n` +
  `• Total Harga: Rp${idr(cost)}\n` +
  `• Saldo sebelum: Rp${idr(saldoBefore)}\n` +
  `• Saldo sesudah: Rp${idr(saldoAfter)}\n\n` +
  `Output server:\n${res.combined || '(no output)'}`
);

// log pembelian setelah sukses
try {
  const vpsLabel = S.vps?.id || `${S.vps?.host}:${S.vps?.port||22}`;
  const kind = (title || 'add-vmess').toLowerCase().replace(/\s+/g, '-');
  logPurchase({
    tg_id : msg.from.id,
    kind  : kind,
    days  : S.days,
    vps_id: vpsLabel
  });
} catch (e) {
  console.error('[logPurchase add*] error:', e?.message || e);
}
      return true;
    }

    return true;
  }

  return {
    name,
    aliases,
    description: `${title} (pakai saldo; harga per hari dari .env; tanpa password; output asli, ANSI dihapus)`,
    async execute(bot, msg){ return start(bot, msg); },
    async continue(bot, msg){ return cont(bot, msg); }
  };
}

module.exports = { createAddWsPlugin };
