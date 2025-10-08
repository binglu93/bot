// commands/trialssh.js
const { createTrialPlugin } = require('../lib/trialBase');
const { logPurchase } = require('../lib/db'); // pastikan ada fungsi ini

module.exports = createTrialPlugin({
  name: 'trialssh',
  aliases: ['trialsh'],
  title: 'Trial SSH',
  // sesuaikan dengan script trial-mu
  commandTpl: '/usr/local/sbin/bot-trial {MIN}',
  minutes: 60,

  // dipanggil setelah trial berhasil dijalankan di VPS
  onSuccess: async ({ bot, msg, vps, output }) => {
    try {
      const vpsLabel = vps?.id || `${vps?.host}:${vps?.port || 22}`;
      // durasi trial biasanya menit/jam; untuk log pakai days=0 atau 1 sesuai selera
      await logPurchase({
        tg_id: String(msg.from.id),
        kind: 'trial-ssh',
        days: 0,                // atau 1 kalau mau dicatat “1 hari”
        vps_id: vpsLabel,
        amount: 0,              // trial = gratis
        meta: { output }        // optional: simpan ringkas output kalau mau
      });
    } catch (e) {
      console.error('[logPurchase trial-ssh] error:', e?.message || e);
    }
  }
});
