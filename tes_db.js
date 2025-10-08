// test_db.js
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(process.cwd(), 'julak', 'wallet.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Helper format IDR
const idr = n => Number(n||0).toLocaleString('id-ID');

// Cek semua users
console.log('=== Users ===');
const users = db.prepare(`SELECT * FROM users ORDER BY created_at DESC`).all();
users.forEach(u => {
  console.log(`TG_ID: ${u.tg_id}, Name: ${u.name}, Balance: Rp${idr(u.balance)}, Created: ${u.created_at}`);
});

// Cek 10 pembayaran terakhir
console.log('\n=== QRIS Payments (last 10) ===');
const payments = db.prepare(`SELECT * FROM qris_payments ORDER BY created_at DESC LIMIT 10`).all();
payments.forEach(p => {
  console.log(`#${p.id} TG_ID: ${p.tg_id}, Amount: Rp${idr(p.expected_amount)}, Status: ${p.status}, Created: ${p.created_at}, Paid: ${p.paid_at}`);
});

db.close();
