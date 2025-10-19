// commands/trialvless.js
const { createTrialPlugin } = require('../lib/trialBase');
// Sesuaikan: trialvless / trial-vless
module.exports = createTrialPlugin({
  name: 'trialvless',
  aliases: ['trialvl'],
  title: 'Trial VLess',
  commandTpl: '/usr/local/sbin/bot-trialvl {MIN}',
  minutes: 60
});
