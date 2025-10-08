// commands/addvmess.js
const { createAddWsPlugin } = require('../lib/addBaseWS');

module.exports = createAddWsPlugin({
  name: 'addvmess',
  aliases: ['add-vmess'],
  title: 'Tambah Akun VMess',
  // Gunakan skrip non-interaktif yang menerima (user, exp)
  // Pastikan /usr/local/bin/addvmess_json.sh executable dan outputnya terstruktur
  commandTpl: '/usr/local/sbin/bot-addws {USER} {EXP}',
  expMode: 'days' // ubah ke 'date' bila script butuh YYYY-MM-DD
});
