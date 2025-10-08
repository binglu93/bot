// lib/pricing.js
const fs = require('fs');
const path = require('path');

function loadHarga() {
  const p = path.resolve(process.cwd(), 'julak', 'harga.json');
  if (!fs.existsSync(p)) throw new Error('File ./julak/harga.json tidak ditemukan.');
  const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
  return obj;
}

/** kembalikan { ok, price, message } */
function getPriceForDays(days) {
  try {
    const harga = loadHarga();
    const v = harga[String(days)];
    if (typeof v === 'number' && v >= 0) {
      return { ok: true, price: v };
    }
    return { ok: false, message: `Durasi ${days} hari belum diatur di harga.json.` };
  } catch (e) {
    return { ok: false, message: e.message || e };
  }
}

module.exports = { loadHarga, getPriceForDays };
