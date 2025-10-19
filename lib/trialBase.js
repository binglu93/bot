require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const { logPurchase, ensureUser } = require('./db'); // 🟩 tambahkan koneksi ke database

// === ⚙️ CONFIG ===
const TRIAL_LIMIT_PER_DAY = parseInt(process.env.TRIAL_LIMIT_PER_DAY || '2', 10);
const ADMIN_TG_ID = String(process.env.ADMIN_TG_ID || '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

const stripAnsi = (s = '') => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const userKey = (msg) => `${msg.chat?.id}:${msg.from?.id}`;
const textOf = (msg) => String(msg.text || msg.caption || '').trim();

// === 🧠 TRIAL LIMIT TRACKER ===
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
  if (isAdmin) return true;
  const today = new Date().toISOString().slice(0, 10);
  const log = loadTrialLog();
  const userData = log[userId] || { date: today, count: 0 };
  if (userData.date !== today) {
    log[userId] = { date: today, count: 0 };
    saveTrialLog(log);
    return true;
  }
  return userData.count < TRIAL_LIMIT_PER_DAY;
}
function incrementTrialCount(userId, isAdmin = false) {
  if (isAdmin) return;
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

// === 💻 VPS LOADER ===
function loadVpsList() {
  const p = './julak/vps.json';
  if (!fs.existsSync(p)) throw new Error('File ./julak/vps.json tidak ditemukan.');
  const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
  if (!Array.isArray(data) || data.length === 0) throw new Error('Data VPS kosong/tidak valid.');
  return data;
}

// === 🔘 INLINE KEYBOARD ===
async function promptPickInline(bot, msg, title) {
  const vpsList = loadVpsList();
  const buttons = vpsList.map((v, i) => [
    { text: v.id || `${v.host}:${v.port}`, callback_data: `trial_pick:${i}` },
  ]);
  buttons.push([{ text: '❌ Batal', callback_data: 'trial_cancel' }]);

  await bot.sendMessage(
    msg.chat.id,
    `${title}\n\nPilih server trial dengan menekan tombol di bawah:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
  );
  return vpsList;
}

// === ⚙️ SSH RUNNER ===
function runTrialCommand(vps, shellCmd, headerText, bot, msg, { kind, minutes }) {
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

          // 🟩 Simpan ke database (logPurchase)
          try {
            ensureUser(msg.from.id, msg.from.first_name || 'Unknown');
            await logPurchase({
              tg_id: msg.from.id,
              kind,
              days: 0,
              vps_id: vps.id || vps.host,
              meta: {
                minutes,
                server: vps.host,
                port: vps.port,
                output: clean.slice(0, 2000), // batasi panjang
              },
            });
          } catch (e) {
            console.error('❌ Gagal log trial ke database:', e);
          }

          await bot.sendMessage(
            msg.chat.id,
            `${headerText}\n\n${clean || '(output kosong)'}`
          ).catch(() => {});
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

// === ⚡ CREATE TRIAL PLUGIN ===
function createTrialPlugin({ name, aliases = [], title, commandTpl, minutes = 60 }) {
  global.__trial_sessions ??= Object.create(null);

  // 🟩 Start command
  async function start(bot, msg) {
    const key = `${name}:${userKey(msg)}`;
    const userId = String(msg.from?.id);
    const isAdmin = ADMIN_TG_ID.includes(userId);

    if (!canCreateTrial(userId, isAdmin)) {
      return bot.sendMessage(
        msg.chat.id,
        `⚠️ Kamu sudah mencapai batas *${TRIAL_LIMIT_PER_DAY}* trial hari ini.\nCoba lagi besok ya!`,
        { parse_mode: 'Markdown' }
      );
    }

    let vpsList;
    try {
      vpsList = await promptPickInline(bot, msg, `*${title}*`);
    } catch (e) {
      return bot.sendMessage(msg.chat.id, `❌ ${e.message || e}`);
    }

    global.__trial_sessions[key] = { step: 1, vpsList };

    // auto-timeout
    setTimeout(() => {
      if (global.__trial_sessions[key]?.step === 1) {
        delete global.__trial_sessions[key];
        bot.sendMessage(msg.chat.id, '⏳ Sesi trial dihapus karena tidak ada respon.').catch(() => {});
      }
    }, 60_000);
  }

  // 🟩 Callback query handler
  async function handleCallback(bot, query) {
    const msg = query.message;
    const key = `${name}:${msg.chat.id}:${query.from.id}`;
    const s = global.__trial_sessions[key];
    if (!s) return;

    if (query.data === 'trial_cancel') {
      delete global.__trial_sessions[key];
      await bot.answerCallbackQuery(query.id, { text: '❌ Dibatalkan' });
      return bot.editMessageText('✅ Sesi trial dibatalkan.', {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
      });
    }

    if (query.data.startsWith('trial_pick:')) {
      const idx = parseInt(query.data.split(':')[1]);
      const vps = s.vpsList[idx];
      if (!vps) {
        return bot.answerCallbackQuery(query.id, { text: 'Server tidak valid!' });
      }

      delete global.__trial_sessions[key];
      await bot.answerCallbackQuery(query.id, { text: `Dipilih: ${vps.id || vps.host}` });

      await bot.editMessageText(
        `⏳ Membuat *${title}* di VPS *${vps.id || vps.host}*...`,
        { chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: 'Markdown' }
      );

      const userId = String(query.from.id);
      const isAdmin = ADMIN_TG_ID.includes(userId);
      incrementTrialCount(userId, isAdmin);

      const cmd = commandTpl.replace('{MIN}', String(minutes));

      // 🟩 Jalankan dan log ke DB
      await runTrialCommand(vps, cmd, `✅ ${title} Berhasil Dibuat!`, bot, msg, {
        kind: `trial-${name}`,
        minutes,
      });
    }
  }

  return {
    name,
    aliases,
    description: `${title} (pakai tombol inline)`,
    async execute(bot, msg) {
      return start(bot, msg);
    },
    async onCallback(bot, query) {
      return handleCallback(bot, query);
    },
  };
}

module.exports = { createTrialPlugin };