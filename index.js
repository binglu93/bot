// index.js — Telegram bot (polling) + loader plugin + support sesi (+ auto-register user)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const Database = require('better-sqlite3');

// Simpan waktu start bot untuk perhitungan uptime
global.__BOT_STARTED_AT = Date.now();

// === QRIS CONFIG (jangan commit ke repo publik) ===
global.qrisConfig = {
  username: "username_orkut_anda",
  token: "token_qr_orkut_anda",
  baseurl: "https://url_api_anda",
  apikey: "apikey_anda",
  merchant: "code_merchant_orkut_anda",
  codeqr: "codeqr_orkut_anda"
};

// ===== Token: .env atau hardcode fallback =====
const HARDCODED_TOKEN = 'Token_bot_telegram_anda';
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || HARDCODED_TOKEN;
if (!TOKEN || TOKEN === 'PUT_YOUR_BOT_TOKEN_HERE') {
  console.error('❌  Token tidak tersedia. Set .env TELEGRAM_BOT_TOKEN=... ATAU isi HARDCODED_TOKEN.');
  process.exit(1);
}

// === Owner helper (hardcode di lib/owner.js)
const { parseOwnerIds, isOwnerMsg } = require('./lib/owner');

// ====== SQLITE: wallet.db (auto-register user) ======
const DB_PATH = path.resolve(process.cwd(), 'julak', 'wallet.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
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

const stmtUpsertUser = db.prepare(`
  INSERT INTO users (tg_id, name, balance, created_at)
  VALUES (@tg_id, @name, 0, @created_at)
  ON CONFLICT(tg_id) DO UPDATE SET name = COALESCE(excluded.name, users.name)
`);

function fullName(u) {
  return [u?.first_name, u?.last_name].filter(Boolean).join(' ')
      || u?.username
      || 'User';
}

function ensureUser(msg) {
  if (!msg?.from?.id) return;
  const tg_id = String(msg.from.id);
  const name  = fullName(msg.from);
  stmtUpsertUser.run({ tg_id, name, created_at: new Date().toISOString() });
}

// ====== BOT ======
const bot = new TelegramBot(TOKEN, { polling: true });
console.log('✅  Bot polling...');

// ===== Loader plugin =====
const COMMANDS_DIR = path.resolve(__dirname, 'commands');
const commandMap = new Map();
const aliasMap   = new Map();

function loadCommands() {
  if (!fs.existsSync(COMMANDS_DIR)) fs.mkdirSync(COMMANDS_DIR, { recursive: true });
  const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.js'));
  let count = 0;
  global.__registeredPlugins ??= Object.create(null);

  for (const file of files) {
    const full = path.join(COMMANDS_DIR, file);
    try {
      delete require.cache[require.resolve(full)];
      const mod = require(full);

      if (!mod?.name || typeof mod.execute !== 'function') {
        console.warn(`⚠️ Skip ${file} (tidak export {name, execute})`);
        continue;
      }

      const name = String(mod.name).toLowerCase();
      commandMap.set(name, mod);

      if (Array.isArray(mod.aliases)) {
        for (const a of mod.aliases) aliasMap.set(String(a).toLowerCase(), name);
      }

      count++;

      // register plugin jika ada register()
      if (typeof mod.register === 'function' && !global.__registeredPlugins[name]) {
        try {
          mod.register(bot);
          global.__registeredPlugins[name] = true;
          console.log(`   ↳ registered: ${name}`);
        } catch (e) {
          console.error(`   ↳ register error (${name}):`, e?.message || e);
        }
      }
    } catch (e) {
      console.error(`❌  Gagal load plugin ${file}:`, e?.message || e);
    }
  }

  console.log('🔌 Command termuat:', count);
}
loadCommands();

// ===== Parser command (prefix "/" & ".") =====
function parseCommand(text = '') {
  const t = (text || '').trim();
  if (!t) return null;
  if (!(t.startsWith('/') || t.startsWith('.'))) return null;
  const cut = t.slice(1);
  const [cmdRaw, ...args] = cut.split(/\s+/);
  const base = String(cmdRaw || '').split('@')[0].toLowerCase();
  return { cmd: base, args };
}

// ===== Router utama =====
bot.on('message', async (msg) => {
  try {
    const text = msg.text ? msg.text.trim() : '';
    const isMedia = msg.photo || msg.document || msg.video;

    console.log(`[msg] chat:${msg.chat.id} from:${msg.from.id} @${msg.from.username || '-'}: ${text}`);

    // Handle callback_query untuk approve otomatis
    bot.on('callback_query', async (query) => {
  try {
    const data = query.data || '';
    if (!data.startsWith('approve:')) return;

    const [ , userId, nominal, topupId ] = data.split(':');

    // cast admin ID ke string
    const adminId = String(query.from.id);

    if (adminId !== String(process.env.ADMIN_TG_ID)) {
      return bot.answerCallbackQuery(query.id, { text: '❌ Hanya admin yang bisa approve.', show_alert: true });
    }

    const topupManual = commandMap.get('topupmanual');
    if (!topupManual || typeof topupManual.approve !== 'function') return;

    await topupManual.approve(bot, query.message, [userId, nominal, topupId]);

    // hapus tombol
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: query.message.chat.id, message_id: query.message.message_id });
    bot.answerCallbackQuery(query.id, { text: `✅ Topup #${topupId} berhasil disetujui` });

  } catch (e) {
    console.error('❌ Callback approve error:', e);
    bot.answerCallbackQuery(query.id, { text: '❌ Terjadi error', show_alert: true });
  }
});

    // ===== COMMAND GLOBAL BATAL =====
    if (/^\/batal$/i.test(text)) {
      const { clearAllSessions } = require('./lib/session');
      clearAllSessions(bot);
      return bot.sendMessage(msg.chat.id, '✅  Semua sesi berhasil dibatalkan sayang.');
    }

    // Admin-only /reload
    if (/^\/reload$/i.test(text)) {
      if (!isOwnerMsg(msg)) return bot.sendMessage(msg.chat.id, '❌  Command ini hanya untuk owner.');
      for (const k of commandMap.keys()) commandMap.delete(k);
      for (const k of aliasMap.keys()) aliasMap.delete(k);
      loadCommands();
      return bot.sendMessage(msg.chat.id, '✅  Commands di-reload.');
    }

    // Command prefix (misal /topupmanual, /approve)
    if (text.startsWith('/') || text.startsWith('.')) {
      const parsed = parseCommand(text);
      if (parsed) {
        const name = commandMap.has(parsed.cmd) ? parsed.cmd : aliasMap.get(parsed.cmd);
        if (!name) return;
        const plugin = commandMap.get(name);

        // === khusus /approve ===
        if (plugin?.approve && parsed.cmd === 'approve') {
          return await plugin.approve(bot, msg, parsed.args);
        }

        return await plugin.execute(bot, msg, parsed.args);
      }
    }

    // 👇 Teruskan pesan non-text ke plugin berbasis sesi
    const key = `${msg.chat.id}:${msg.from.id}`;
    for (const n of ['topupmanual', 'trialssh','trialvmess','trialvless','trialtrojan','renewssh',
                     'addssh','addvmess','addvless','addtrojan','renewvless',
                     'topup','ceksaldo','admin','renewvmess','renewtrojan','history']) {
      const p = commandMap.get(n);
      if (p && typeof p.continue === 'function') {
        const handled = await p.continue(bot, msg);
        if (handled) return;
      }
    }

  } catch (e) {
    console.error('❌  Error handler:', e);
  }
});

// ===== /start & /help default =====
bot.onText(/^\/start$/i, async (msg) => {
  ensureUser(msg);
  const first = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ')
              || msg.from.username || 'teman';
  await bot.sendMessage(msg.chat.id, `Halo ${first}! 👋\nKetik /menu atau .menu untuk fitur.\nKetik /batal untuk membatalkan sesi aktif.`);
});

bot.onText(/^\/help$/i, async (msg) => {
  ensureUser(msg);
  await bot.sendMessage(msg.chat.id, '• /menu — menu bot\n• /batal — batal semua sesi aktif\n• /reload — reload plugin (owner)');
});

// ===== Info bot =====
bot.getMe()
  .then(me => {
    console.log(`🤖 Login sebagai @${me.username} (id: ${me.id})`);
    console.log('OWNER_ID(s):', parseOwnerIds().join(', '));
  })
  .catch(err => console.error('❌  getMe error:', err?.message || err));
