const { createAddWsPlugin } = require('../lib/addBaseWS');

module.exports = createAddWsPlugin({
  name: 'addvless',
  aliases: ['add-vless'],
  title: 'Tambah Akun VLess',
  commandTpl: '/usr/local/sbin/bot-addvless {USER} {EXP}',
  expMode: 'days',
  hargaPerHari: Number(process.env.HARGA_PER_HARI || 0)
});
