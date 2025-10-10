// lib/trialBase.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

const stripAnsi = (s = '') => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const userKey = (msg) => `${msg.chat?.id}:${msg.from?.id}`;
const textOf = (msg) => String(msg.text || msg.caption || '').trim();

// === ⚙️ Config dari .env ===
const TRIAL_LIMIT_PER_DAY = parseInt(process.env.TRIAL_LIMIT_PER_DAY || '2', 10);
const ADMIN_TG_ID = String(process.env.ADMIN_TG_ID || '').split(',').map((v) => v.trim()).filter(Boolean);

// === ⏱️ Fungsi pembatasan trial ===
const TRIAL_LOG_PATH = path.join(__dirname, '../data/trial_log.json');
function loadTrialLog() {
  if (!fs.existsSync(TRIAL_LOG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(TRIAL_LOG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}
function saveTrialLog(log) {
  fs.mkdirSync(path.dirname(TRIAL_LOG_PATH), { recursive: true });
  fs.writeFileSync(TRIAL_LOG_PATH, JSON.stringify(log, null, 2));
}

function canCreateTrial(userId, isAdmin = false) {
  if (isAdmin) return true; // 🟢 Admin bebas limit

  const today = new Date().toISOString().slice(0, 10);
  const log = loadTrialLog();
  const userData = log[userId] || { date: today, count: 0 };

  // Reset kalau hari berganti
  if (userData.date !== today) {
    log[userId] = { date: today, count: 0 };
    saveTrialLog(log);
    return true;
  }

  if (userData.count >= TRIAL_LIMIT_PER_DAY) return false;
  return true;
}

function incrementTrialCount(userId, isAdmin = false) {
  if (isAdmin) return; // 🟢 Admin tidak dihitung

  const today = new Date().toISOString().slice(0, 10);
  const log = loadTrialLog();
  const userData = log[userId] || { date: today, count: 0 };

  if (userData.date !== today) {
    userData.date = today;
    userData.count = 0;
  }
  userData.count += 1;
  log[userId] = userData;
  saveTrialLog(log);
}

// === VPS loader ===
function loadVpsList() {
  const p = './julak/vps.json';
  if (!fs.existsSync(p)) throw new Error('File ./julak/vps.json tidak ditemukan.');
  const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
  if (!Array.isArray(data) || data.length === 0) throw new Error('Data VPS kosong/tidak valid.');
  return data;
}
const listVpsText = (arr) => arr.map((v, i) => `${i + 1}. ${v.id || `${v.host}:${v.port}`}`).join('\n');

async function promptPick(bot, msg, title) {
  const vpsList = loadVpsList();
  const txt = `${title}
Balas ANGKA untuk memilih VPS:

${listVpsText(vpsList)}

Ketik /batal untuk membatalkan.`;
  await bot.sendMessage(msg.chat.id, txt, { parse_mode: 'Markdown' });
  return vpsList;
}

function runTrialCommand(vps, shellCmd, headerText, bot, msg) {
  return new Promise((resolve) => {
    const conn = new Client();
    conn.on('ready', () => {
      conn.exec(shellCmd, (err, stream) => {
        if (err) {
          bot.sendMessage(msg.chat.id, '❌ Gagal menjalankan perintah di VPS.').catch(() => {});
          conn.end();
          return resolve();
        }
        let out = '';
        stream.on('data', (c) => (out += c.toString()));
        stream.stderr.on('data', (c) => (out += c.toString()));
        stream.on('close', async () => {
          const clean = stripAnsi(out).trim();
          await bot.sendMessage(msg.chat.id, `${headerText}\n\n${clean || '(output kosong)'}`).catch(() => {});
          conn.end();
          resolve();
        });
      });
    });
    conn.on('error', (e) => {
      bot.sendMessage(msg.chat.id, `❌ SSH Error: ${e?.message || e}`).catch(() => {});
      resolve();
    });
    conn.connect({
      host: vps.host,
      port: vps.port,
      username: vps.username,
      password: vps.password,
    });
  });
}

function createTrialPlugin({ name, aliases = [], title, commandTpl, minutes = 60 }) {
  global.__trial_sessions ??= Object.create(null);

  async function start(bot, msg) {
    const key = `${name}:${userKey(msg)}`;
    const userId = String(msg.from?.id);
    const isAdmin = ADMIN_TG_ID.includes(userId);

    // 🔒 Batasi maksimal X trial per hari (kecuali admin)
    if (!canCreateTrial(userId, isAdmin)) {
      return bot.sendMessage(
        msg.chat.id,
        `⚠️ Kamu sudah mencapai batas ${TRIAL_LIMIT_PER_DAY} kali membuat trial hari ini.\nCoba lagi besok ya!`
      );
    }

    const txt = textOf(msg);
    if (/^([./])?batal$/i.test(txt)) {
      if (global.__trial_sessions[key]) {
        delete global.__trial_sessions[key];
        return bot.sendMessage(msg.chat.id, '✅ Sesi trial dibatalkan.');
      }
      return bot.sendMessage(msg.chat.id, '❌ Tidak ada sesi aktif.');
    }

    let vpsList;
    try {
      vpsList = await promptPick(bot, msg, `*${title}*`);
    } catch (e) {
      return bot.sendMessage(msg.chat.id, `❌ ${e.message || e}`);
    }

    global.__trial_sessions[key] = { step: 1, vpsList };

    setTimeout(() => {
      if (global.__trial_sessions[key]?.step === 1) {
        delete global.__trial_sessions[key];
        bot.sendMessage(msg.chat.id, '⏳ Sesi dihapus karena tidak ada input 1 menit.').catch(() => {});
      }
    }, 60_000);
  }

  async function cont(bot, msg) {
    const key = `${name}:${userKey(msg)}`;
    const s = global.__trial_sessions[key];
    if (!s) return false;

    const txt = textOf(msg);
    const userId = String(msg.from?.id);
    const isAdmin = ADMIN_TG_ID.includes(userId);

    if (/^([./])?batal$/i.test(txt)) {
      delete global.__trial_sessions[key];
      await bot.sendMessage(msg.chat.id, '✅ Sesi trial dibatalkan.');
      return true;
    }

    if (s.step === 1) {
      const idx = parseInt(txt, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= s.vpsList.length) {
        await bot.sendMessage(msg.chat.id, '⚠️ Pilihan tidak valid! Balas dengan angka yang tertera.');
        return true;
      }
      const vps = s.vpsList[idx];
      delete global.__trial_sessions[key];

      await bot.sendMessage(msg.chat.id, `⏳ Membuat ${title} di VPS: ${vps.id || `${vps.host}:${vps.port}`}`);
      const cmd = commandTpl.replace('{MIN}', String(minutes));

      // ✅ Tambahkan ke log (skip admin)
      incrementTrialCount(userId, isAdmin);

      await runTrialCommand(vps, cmd, `✅ ${title} Berhasil Dibuat!`, bot, msg);
      return true;
    }

    return true;
  }

  return {
    name,
    aliases,
    description: `${title} (output asli, tanpa warna ANSI, tanpa tombol)`,
    async execute(bot, msg) {
      return start(bot, msg);
    },
    async continue(bot, msg) {
      return cont(bot, msg);
    },
  };
}

module.exports = { createTrialPlugin };
