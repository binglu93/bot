// commands/renewvmess.js
const { createRenewVMPlugin } = require('../lib/renewBaseVM');

module.exports = createRenewVMPlugin({
  name: 'renewvmess',
  aliases: ['renew-vmess'],
  title: 'Perpanjang Akun VMess',
  commandTpl: '/usr/local/sbin/bot-extws {USER} {EXP}',
  marker: '###' // gunakan penanda "### username"
});
