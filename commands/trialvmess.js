// commands/trialvmess.js
const { createTrialPlugin } = require('../lib/trialBase');
// Sesuaikan nama command VPS (mis. trialvmess / trial-vmess)
module.exports = createTrialPlugin({
  name: 'trialvmess',
  aliases: ['trialvm'],
  title: 'Trial VMess',
  commandTpl: '/usr/local/sbin/bot-trialws {MIN}',
  minutes: 60
});
