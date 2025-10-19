// commands/renewvless.js
const { createRenewVMPlugin } = require('../lib/renewBaseVM');

module.exports = createRenewVMPlugin({
  name: 'renewvless',
  aliases: ['renew-vless'],
  title: 'Perpanjang Akun VLess',
  commandTpl: '/usr/local/sbin/bot-extvl {USER} {EXP}',
  marker: '#&' // gunakan penanda "#& username"
});
