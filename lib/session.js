// lib/session.js
function sessKey(msg) {
  return `${msg.chat.id}:${msg.from.id}`;
}

function getS(msg) {
  global.__admin_sessions ??= Object.create(null);
  return global.__admin_sessions[sessKey(msg)];
}

function setS(bot, msg, data, ttlMs = 120_000) {
  global.__admin_sessions ??= Object.create(null);
  const key = sessKey(msg);

  // Hapus timeout lama
  if (global.__admin_sessions[key]?._timeout) {
    clearTimeout(global.__admin_sessions[key]._timeout);
  }

  const chatId = msg.chat.id;
  const timeout = setTimeout(() => {
    try { bot.sendMessage(chatId, '⏳ Sesi timeout otomatis.'); } catch {}
    delete global.__admin_sessions[key];
  }, ttlMs);

  global.__admin_sessions[key] = { ...data, _timeout: timeout };
}

function clearS(msg) {
  const S = getS(msg);
  if (S?._timeout) clearTimeout(S._timeout);
  global.__admin_sessions && delete global.__admin_sessions[sessKey(msg)];
}

function clearAllSessions(bot) {
  if (!global.__admin_sessions) {
    global.__admin_sessions = Object.create(null);
    return;
  }
  for (const [key, sess] of Object.entries(global.__admin_sessions)) {
    if (sess?._timeout) clearTimeout(sess._timeout);
  }
  global.__admin_sessions = Object.create(null);
  console.log('🧹 Semua sesi dibersihkan.');
  if (bot) bot.sendMessage(process.env.OWNER_ID || '', '✅ Semua sesi telah dibersihkan.');
}

module.exports = { sessKey, getS, setS, clearS, clearAllSessions };
