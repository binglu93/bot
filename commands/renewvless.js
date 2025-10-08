// commands/renewvless.js
const { createRenewVLPlugin } = require('../lib/renewBaseVL');

module.exports = createRenewVLPlugin({
  name: 'renewvless',
  aliases: ['renew-vless'],
  title: 'Perpanjang Akun VLess',
  commandTpl: '/usr/local/sbin/bot-extvl {USER} {EXP}'
});
