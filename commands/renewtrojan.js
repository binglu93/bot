// commands/renewtrojan.js
const { createRenewTRPlugin } = require('../lib/renewBaseTR');

module.exports = createRenewTRPlugin({
  name: 'renewtrojan',
  aliases: ['renew-trojan'],
  title: 'Perpanjang Akun Trojan',
  commandTpl: '/usr/local/sbin/bot-exttr {USER} {EXP}'
});
