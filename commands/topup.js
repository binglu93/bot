// commands/topup.js
const path = require('path');
const Database = require('better-sqlite3');
const fetch = global.fetch || require('node-fetch');

const DB_PATH = path.resolve(process.cwd(), 'julak', 'wallet.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// === DB Tables & Statements ===
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  tg_id TEXT PRIMARY KEY,
  name TEXT,
  balance INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS qris_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id TEXT NOT NULL,
  expected_amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  paid_at TEXT,
  kode_deposit TEXT,
  raw_match TEXT
);
`);

const stmtUpsertUser = db.prepare(`
INSERT INTO users (tg_id, name, balance, created_at)
VALUES (@tg_id, @name, 0, @created_at)
ON CONFLICT(tg_id) DO UPDATE SET name = excluded.name
`);
const stmtGetUser = db.prepare(`SELECT * FROM users WHERE tg_id=?`);
const stmtAddBalance = db.prepare(`UPDATE users SET balance = balance + ? WHERE tg_id=?`);
const stmtCreatePayment = db.prepare(`
INSERT INTO qris_payments (tg_id, expected_amount, status, created_at, kode_deposit, raw_match)
VALUES (?, ?, 'pending', ?, ?, ?)
`);
const stmtApprovePay = db.prepare(`
UPDATE qris_payments SET status='approved', paid_at=?, raw_match=? WHERE id=? AND status='pending'
`);
const stmtExpirePay = db.prepare(`
UPDATE qris_payments SET status='expired', paid_at=? WHERE id=? AND status='pending'
`);

const nowISO = () => new Date().toISOString();
const fullname = u => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'User';
const idr = n => Number(n||0).toLocaleString('id-ID');
const send = (bot, chatId, text, opt={}) => bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opt });

const API_URL = process.env.URL_API_KEY || "Url_Apimu";
const API_KEY = process.env.QRIS_API_KEY || "apikeymu";

async function apiCall(params) {
  const form = new URLSearchParams({ api_key: API_KEY, ...params });
  const res = await fetch(API_URL, { method: "POST", body: form });
  const data = await res.json();
  console.log("[DEBUG] API CALL", params, "=>", data);
  return data;
}

// === Topup Flow ===
async function startFlow(bot, msg) {
  const tg_id = String(msg.from.id);
  const name = fullname(msg.from);
  stmtUpsertUser.run({ tg_id, name, created_at: nowISO() });

  global.__qris_sessions ??= {};
  const key = `${msg.chat.id}:${msg.from.id}`;
  global.__qris_sessions[key] = { step: 1 };

  send(bot, msg.chat.id,
    `💰 *TOPUP QRIS*\nMasukkan nominal (contoh: \`5000\`).\nMinimal: *Rp5000*\n\nKetik */batal* untuk membatalkan.`);
}

async function handleContinue(bot, msg) {
  const key = `${msg.chat.id}:${msg.from.id}`;
  const S = global.__qris_sessions?.[key];
  if (!S) return false;

  const text = String(msg.text || '').trim();
  if (/^([./])?batal$/i.test(text)) {
    clearInterval(S.timer);
    delete global.__qris_sessions[key];
    return send(bot, msg.chat.id, '✅ Sesi topup dibatalkan.');
  }

  if (S.step === 1) {
    const nominal = parseInt(text.replace(/[^\d]/g,''), 10);
    if (isNaN(nominal) || nominal < 5000) {
      return send(bot, msg.chat.id, "⚠️ Nominal tidak valid. Minimal Rp5000.");
    }

    try {
      // 1️⃣ Buat deposit via API
      const dep = await apiCall({ action: "get-deposit", jumlah: String(nominal) });
      if (!dep || !dep.status) throw new Error(dep?.msg || 'Gagal request deposit');

      const jumlah_diterima = Number(dep.data.saldo_diterima || nominal);

      // 2️⃣ Simpan payment di DB
      const info = stmtCreatePayment.run(
        String(msg.from.id),
        jumlah_diterima,
        nowISO(),
        dep.data.kode_deposit,
        JSON.stringify(dep)
      );

      S.step = 2;
      S.paymentId = info.lastInsertRowid;
      S.kode = dep.data.kode_deposit;
      S.nominal = jumlah_diterima;

      // 3️⃣ Kirim QR ke user
      const qrRes = await fetch(dep.data.link_qr);
      const qrBuffer = await qrRes.arrayBuffer();

      const captionText =
`📥 *TOPUP QRIS*
• ID Pembayaran : #${S.paymentId}
• Nominal       : Rp${idr(S.nominal)}
• Kode Deposit  : ${S.kode}

⚠️ Scan QR dan bayar *persis* nominal di atas.
⏳ Sistem mengecek otomatis hingga 5 menit.

📖 *Panduan pembayaran*:
${dep.data.panduan_pembayaran}`;

      await bot.sendPhoto(msg.chat.id, Buffer.from(qrBuffer), { caption: captionText, parse_mode: 'Markdown' });

      // 4️⃣ Polling status-deposit
      const startTs = Date.now();
      S.timer = setInterval(async () => {
        try {
          const st = await apiCall({ action: "status-deposit", kode_deposit: S.kode });
          if (st.status && st.data.status === "Success") {
            clearInterval(S.timer);
            stmtApprovePay.run(nowISO(), JSON.stringify(st), S.paymentId);
            stmtAddBalance.run(Number(st.data.saldo_diterima || 0), String(msg.from.id));
            const u = stmtGetUser.get(String(msg.from.id));
            delete global.__qris_sessions[key];
            return send(bot, msg.chat.id,
              `✅ *Topup berhasil!*\n• Tambahan: Rp${idr(st.data.saldo_diterima)}\n• Saldo sekarang: *Rp${idr(u.balance)}*`);
          } else if (st.status && st.data.status === "Expired" || Date.now() - startTs > 5*60_000) {
            clearInterval(S.timer);
            stmtExpirePay.run(nowISO(), S.paymentId);
            delete global.__qris_sessions[key];
            return send(bot, msg.chat.id, '❌ Topup expired/gagal. Silakan ulangi.');
          }
        } catch(e) {
          console.error("[Topup polling error]", e?.message || e);
        }
      }, 10_000);

    } catch(e) {
      console.error("[Topup error]", e.message || e);
      delete global.__qris_sessions[key];
      return send(bot, msg.chat.id, "❌ Gagal membuat deposit. Coba lagi nanti.");
    }
  }

  return true;
}

module.exports = {
  name: 'topup',
  aliases: ['topup', 'saldo-topup'],
  description: 'Topup saldo via QRIS (API AriePulsa) FINAL FIX ALL',
  async execute(bot, msg)  { return startFlow(bot, msg); },
  async continue(bot, msg) { return handleContinue(bot, msg); }
};
