// lib/trialBase.js
const fs = require('fs');
const { Client } = require('ssh2');

const stripAnsi = (s='') => String(s).replace(/\x1b\[[0-9;]*m/g, '');

// ✅ FIX: sesi unik per (chat,user)
const userKey = (msg) => `${msg.chat?.id}:${msg.from?.id}`;
const textOf  = (msg) => String(msg.text || msg.caption || '').trim();

function loadVpsList() {
  const p = './julak/vps.json';
  if (!fs.existsSync(p)) throw new Error('File ./julak/vps.json tidak ditemukan.');
  const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
  if (!Array.isArray(data) || data.length === 0) throw new Error('Data VPS kosong/tidak valid.');
  return data;
}
const listVpsText = (arr) => arr.map((v,i)=>`${i+1}. ${v.id || `${v.host}:${v.port}`}`).join('\n');

async function promptPick(bot, msg, title) {
  const vpsList = loadVpsList();
  const txt =
`${title}
Balas ANGKA untuk memilih SERVER:

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
          bot.sendMessage(msg.chat.id, '❌ Gagal menjalankan perintah di VPS.').catch(()=>{});
          conn.end(); return resolve();
        }
        let out = '';
        stream.on('data', (c)=> out += c.toString());
        stream.stderr.on('data', (c)=> out += c.toString());
        stream.on('close', async () => {
          const clean = stripAnsi(out).trim();
          await bot.sendMessage(msg.chat.id, `${headerText}\n\n${clean || '(output kosong)'}`).catch(()=>{});
          conn.end(); resolve();
        });
      });
    });
    conn.on('error', (e) => { bot.sendMessage(msg.chat.id, `❌ SSH Error: ${e?.message||e}`).catch(()=>{}); resolve(); });
    conn.connect({ host: vps.host, port: vps.port, username: vps.username, password: vps.password });
  });
}

function createTrialPlugin({ name, aliases=[], title, commandTpl, minutes=60 }) {
  global.__trial_sessions ??= Object.create(null);

  async function start(bot, msg) {
    const key = `${name}:${userKey(msg)}`;
    const txt = textOf(msg);
    if (/^([./])?batal$/i.test(txt)) {
      if (global.__trial_sessions[key]) {
        delete global.__trial_sessions[key];
        return bot.sendMessage(msg.chat.id, '✅ Sesi trial dibatalkan.');
      }
      return bot.sendMessage(msg.chat.id, '❌ Tidak ada sesi aktif.');
    }

    let vpsList;
    try { vpsList = await promptPick(bot, msg, `*${title}*`); }
    catch (e) { return bot.sendMessage(msg.chat.id, `❌ ${e.message || e}`); }

    global.__trial_sessions[key] = { step: 1, vpsList };

    setTimeout(() => {
      if (global.__trial_sessions[key]?.step === 1) {
        delete global.__trial_sessions[key];
        bot.sendMessage(msg.chat.id, '⏳ Sesi dihapus karena tidak ada input 1 menit.').catch(()=>{});
      }
    }, 60_000);
  }

  async function cont(bot, msg) {
    const key = `${name}:${userKey(msg)}`;
    const s = global.__trial_sessions[key];
    if (!s) return false;

    const txt = textOf(msg);

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
      await runTrialCommand(vps, cmd, `✅ ${title} Berhasil Dibuat!`, bot, msg);
      return true;
    }

    return true; // ada sesi plugin ini → telan pesan
  }

  return {
    name,
    aliases,
    description: `${title} (output asli, tanpa warna ANSI, tanpa tombol)`,
    async execute(bot, msg) { return start(bot, msg); },
    async continue(bot, msg) { return cont(bot, msg); }
  };
}

module.exports = { createTrialPlugin };
