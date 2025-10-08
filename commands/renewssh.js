const fs = require('fs');
const { createRenewPluginAutoPrice } = require('../lib/renewTemplateAutoPrice');

const SSH_FILE = '/etc/ssh/.ssh.db';

function validateSSH(user){
  const data = fs.readFileSync(SSH_FILE,'utf-8');
  if(!data.includes(user)) throw new Error(`User ${user} tidak ditemukan di SSH db.`);
}

module.exports = createRenewPluginAutoPrice({
  name:'renewssh',
  aliases:['renew-ssh'],
  title:'Perpanjang Akun SSH',
  commandTpl:'/usr/local/sbin/bot-extssh {USER} {EXP}',
  validateUser:validateSSH
});
