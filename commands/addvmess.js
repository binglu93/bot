const { createAddWsPlugin } = require('../lib/addBaseWS');

module.exports = createAddWsPlugin({
  name: 'addvmess',
  aliases: ['add-vmess'],
  title: 'Tambah Akun VMess',
  commandTpl: '/usr/local/sbin/bot-addws {USER} {EXP}',
  expMode: 'days',
  hargaPerHari: Number(process.env.HARGA_PER_HARI || 0)
});
