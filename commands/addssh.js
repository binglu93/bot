// commands/addssh.js
const { createAddSshPlugin } = require('../lib/addBase');

// Sesuai formatmu:
// printf "%s\n" "<username>" "<password>" "2" "<exp>" | addssh
module.exports = createAddSshPlugin({
  name: 'addssh',
  aliases: ['add-ssh'],
  title: 'Tambah Akun SSH',
  commandTpl: '/usr/local/sbin/bot-addssh {USER} {PASS} {EXP}',
  // expMode: 'days'  // default 'days'; kalau butuh tanggal: set 'date'
});

