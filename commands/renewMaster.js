// commands/renewMaster.js
const { createRenewMasterPlugin } = require('../lib/renewMaster');

module.exports = createRenewMasterPlugin({
  name: 'renew',
  title: 'Perpanjang Akun',
  commandTpls: {
    vmess  : '/usr/local/sbin/bot-extws {USER} {EXP}',
    vless  : '/usr/local/sbin/bot-extvl {USER} {EXP}',
    trojan : '/usr/local/sbin/bot-exttr {USER} {EXP}',
    ssh    : '/usr/local/sbin/bot-extssh {USER} {EXP}'
  }
});
