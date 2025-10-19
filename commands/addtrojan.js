const { createAddWsPlugin } = require('../lib/addBaseWS');

module.exports = createAddWsPlugin({
  name: 'addtrojan',
  aliases: ['add-trojan'],
  title: 'Tambah Akun Trojan',
  commandTpl: '/usr/local/sbin/bot-addtr {USER} {EXP}',
  expMode: 'days',
  hargaPerHari: Number(process.env.HARGA_PER_HARI || 0)
});
