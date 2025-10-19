// commands/renewtrojan.js
const { createRenewVMPlugin } = require('../lib/renewBaseVM');

module.exports = createRenewVMPlugin({
  name: 'renewtrojan',
  aliases: ['renew-trojan'],
  title: 'Perpanjang Akun Trojan',
  commandTpl: '/usr/local/sbin/bot-exttr {USER} {EXP}',
  marker: '#!' // gunakan penanda "#! username"
});
