// commands/trialtrojan.js
const { createTrialPlugin } = require('../lib/trialBase');
// Sesuaikan: trialtrojan / trial-trojan
module.exports = createTrialPlugin({
  name: 'trialtrojan',
  aliases: ['trialtr'],
  title: 'Trial Trojan',
  commandTpl: '/usr/local/sbin/bot-trialtr {MIN}',
  minutes: 60
});
