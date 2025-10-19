const { createTrialPlugin } = require('../lib/trialBase');

module.exports = createTrialPlugin({
  name: 'trialssh',
  aliases: ['trial-ssh'],
  title: 'Trial SSH',
  commandTpl: '/usr/local/sbin/bot-trial {MIN}', // {MIN} = durasi trial
  minutes: 60 // default 60 menit trial, bisa diubah
});
