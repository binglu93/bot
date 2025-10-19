const { createAddSshPlugin } = require('../lib/addBaseSSH');

module.exports = createAddSshPlugin({
  name: 'addssh',
  aliases: ['add-ssh'],
  title: 'Tambah Akun SSH',
  commandTpl: '/usr/local/sbin/bot-addssh {USER} {PASS} {EXP}',
  expMode: 'days',
  hargaPerHari: Number(process.env.HARGA_PER_HARI || 200)
});
