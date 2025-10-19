// commands/renewssh.js
const { createRenewSHPlugin } = require('../lib/renewBaseSH');
module.exports = createRenewSHPlugin({
  name: 'renewssh',
  aliases: ['renew-ssh'],
  title: 'Perpanjang Akun SSH',
  commandTpl: '/usr/local/sbin/bot-extssh {USER} {EXP}',
  marker: '###' // gunakan penanda "#& username"
});
