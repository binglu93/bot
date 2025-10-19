// lib/renewBaseVM.js
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
const skey     = (msg) => `${msg.chat?.id}:${msg.from?.id}`; // chatId:fromId
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

function escapeForRegex(s='') {
  // escape regex special chars in a string
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

// ===== validasi username berdasarkan marker yang diberikan =====
function validateUserByMarker(username, marker) {
  try {
    const JAMBAN_FILE = '/etc/xray/config.json';
    if (!fs.existsSync(JAMBAN_FILE)) return { ok:false, msg:`Config tidak ditemukan di ${JAMBAN_FILE}` };
    const raw = fs.readFileSync(JAMBAN_FILE, 'utf-8');
    const lines = raw.split('\n');

    // marker dapat berisi karakter khusus, jadi escape
    const safeMarker = escapeForRegex(marker);
    const safeUser = escapeForRegex(username);

    // pola: ^<marker>\s+<username>\s
    const re = new RegExp(`^${safeMarker}\\s+${safeUser}\\s`);
    const foundByMarker = lines.some(l => re.test(l));
    if (foundByMarker) return { ok:true };

    // fallback: cek kemunculan username di file (mis. sebagai email atau "username")
    const foundAnywhere = raw.includes(`"${username}"`) || raw.includes(username);
    if (foundAnywhere) {
      // beri peringatan bahwa deteksi bukan dari marker spesifik
      return { ok:true, note: 'ditemukan tanpa marker spesifik (fallback)' };
    }

    return { ok:false, msg:`User ${username} tidak ditemukan menggunakan penanda ${marker}` };
  } catch(e) {
    return { ok:false, msg:e?.message || e };
  }
}

// ===== plugin utama =====
function createRenewVMPlugin({ name, aliases=[], title, commandTpl, expMode = 'days', marker='###' }) {
  // marker: string seperti '###' atau '#&' atau '#!'
  global.__renewvm_sessions ??= Object.create(null);

  function daysToExpStr(days) {
    if (expMode === 'date') {
      const d = new Date();
      d.setDate(d.getDate() + days);
      const pad = (n)=> String(n).padStart(2,'0');
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    }
    return String(days);
  }

  // START: kirim keyboard server
  async function start(bot, msg) {
    const key = `${name}:${skey(msg)}`; // name:chat:from
    let vpsList;
    try { vpsList = loadVpsList(); }
    catch (e) { return send(bot, msg.chat.id, `❌ ${e.message || e}`); }

    ensureUserSqlite(msg);
    // inisialisasi session dengan flag promptedForUsername = false
    global.__renewvm_sessions[key] = { step: 1, vpsList, marker, promptedForUsername: false };

    const buttons = listVpsButtons(vpsList, name);
    buttons.push([{ text: '❌ Batal', callback_data: `${name}:cancel` }]);

    await bot.sendMessage(msg.chat.id, `*${title}*\n\nPilih server:`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    });

    setTimeout(() => {
      const S = global.__renewvm_sessions[key];
      if (S && S.step === 1) {
        delete global.__renewvm_sessions[key];
        send(bot, msg.chat.id, '⏳ Sesi dihapus karena tidak ada interaksi 1 menit.').catch(()=>{});
      }
    }, 60_000);
  }

  // CONTINUE: proses langkah-langkah setelah pilih server via tombol
  async function cont(bot, msg) {
    const key = `${name}:${skey(msg)}`;
    const S = global.__renewvm_sessions[key];
    if (!S) return false;
    const t = textOf(msg);

    if (/^([./])?batal$/i.test(t)) {
      delete global.__renewvm_sessions[key];
      await send(bot, msg.chat.id, '✅ Sesi dibatalkan.');
      return true;
    }

    if (S.step === 2) {
      if (!/^[A-Za-z0-9_.-]{3,32}$/.test(t)) {
        await send(bot, msg.chat.id, '⚠️ Username harus 3–32 char (huruf/angka/_ . -). Coba lagi.');
        return true;
      }
      S.user = t;

      // validasi berdasarkan marker yang diberikan untuk plugin ini
      const check = validateUserByMarker(S.user, S.marker || marker);
      if (!check.ok) {
        await send(bot, msg.chat.id, `❌ ${check.msg}\nSaldo tidak terpotong.`);
        delete global.__renewvm_sessions[key];
        return true;
      } else if (check.note) {
        // opsional: beri tahu user bahwa validasi pakai fallback
        await send(bot, msg.chat.id, `⚠️ Peringatan: ${check.note}`);
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

      const cost = days * 200; // tetap Rp200 per hari (ubah jika perlu)
      const u = ensureUserSqlite(msg);
      if (u.balance < cost) {
        await send(bot, msg.chat.id, `💸 Saldo tidak cukup.\n• Harga: Rp${idr(cost)}\n• Saldo: Rp${idr(u.balance)}`);
        delete global.__renewvm_sessions[key];
        return true;
      }

      // potong saldo
      const tx = db.transaction(()=>{ stmtAddBalance.run(-cost, String(msg.from.id)); });
      tx();
      const saldoAfter = u.balance - cost;

      const expStr = daysToExpStr(days);
      const cmd = commandTpl.replaceAll('{USER}', S.user).replaceAll('{EXP}', expStr);

      delete global.__renewvm_sessions[key];

      await send(bot, msg.chat.id,
        `⏳ Menjalankan ${title} di VPS: ${S.vps.id || `${S.vps.host}:${S.vps.port||22}`}\n`+
        `• Durasi: ${days} hari (EXP: ${expStr})\n`+
        `• Harga: Rp${idr(cost)}\n`+
        `• Saldo setelah: Rp${idr(saldoAfter)}`
      );

      await sshRun(S.vps, cmd, `✅ ${title} berhasil!`, bot, msg);

      try{
        logPurchase({
          tg_id : msg.from.id,
          kind  : (title||name).toLowerCase().replace(/\s+/g,'-'),
          days  : days,
          vps_id: S.vps?.id || `${S.vps.host}:${S.vps.port||22}`
        });
      }catch(e){ console.error('[logPurchase] error:', e?.message||e); }

      return true;
    }

    return true;
  }

  // CALLBACK handler untuk tombol inline
  async function onCallbackQuery(bot, query) {
    try {
      const msg = query.message;
      const userId = query.from.id;
      const startKey = `${name}:${msg.chat.id}:${userId}`;
      const sk = `${name}:${skey(msg)}`; // same format used in start()
      const S = global.__renewvm_sessions[startKey] || global.__renewvm_sessions[sk];
      if (!S) {
        await bot.answerCallbackQuery(query.id, { text: 'Sesi tidak ditemukan atau sudah kedaluwarsa.' });
        return false;
      }

      const data = query.data;
      if (data === `${name}:cancel`) {
        delete global.__renewvm_sessions[sk];
        delete global.__renewvm_sessions[startKey];
        await bot.answerCallbackQuery(query.id, { text: 'Dibatalkan.' });
        await send(bot, msg.chat.id, '✅ Sesi dibatalkan.');
        return true;
      }

      const parts = String(data).split(':');
      // expected: <pluginName>:pickvps:<index>
      if (parts[0] !== name) {
        // not for this plugin
        return false;
      }
      if (parts[1] !== 'pickvps') return false;
      const idx = parseInt(parts[2], 10);
      if (isNaN(idx) || idx < 0 || idx >= S.vpsList.length) {
        await bot.answerCallbackQuery(query.id, { text: 'Pilihan tidak valid.' });
        return false;
      }

      // if session already advanced to step 2 and we've prompted for username already,
      // just acknowledge the callback and don't re-send the username prompt.
      if (S.step === 2 && S.promptedForUsername) {
        await bot.answerCallbackQuery(query.id, { text: 'Server sudah dipilih sebelumnya.' });
        return true;
      }

      // Simpan VPS dan ubah state
      S.vps = S.vpsList[idx];
      S.step = 2;

      // tandai bahwa kita sudah mengirim prompt username agar tidak duplikat
      S.promptedForUsername = true;

      await bot.answerCallbackQuery(query.id, { text: `Server dipilih: ${S.vps.id || S.vps.host}` });

      // bersihkan inline keyboard pada pesan sebelumnya (opsional)
      try {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: msg.chat.id, message_id: msg.message_id });
      } catch (e) {
        // ignore if cannot edit (pesan mungkin sudah berubah)
      }

      // KIRIM prompt username **hanya sekali** per sesi
      await bot.sendMessage(msg.chat.id, '👤 Masukkan *username* akun yang akan diperpanjang:', { parse_mode: 'Markdown' });
      return true;
    } catch (err) {
      console.error('[onCallbackQuery] error:', err);
      try { await bot.answerCallbackQuery(query.id, { text: 'Terjadi error.' }); } catch(e){ }
      return false;
    }
  }

  return {
    name,
    aliases,
    description: `${title} (pakai saldo; keyboard server; validasi marker: ${marker})`,
    async execute(bot, msg){ return start(bot, msg); },
    async continue(bot, msg){ return cont(bot, msg); },
    async onCallbackQuery(bot, query){ return onCallbackQuery(bot, query); }
  };
}

module.exports = { createRenewVMPlugin };
