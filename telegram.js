// Owner-only Telegram alerts. Students ko zero notification.
const https = require('https');
const config = require('./config');

function send(msg) {
  const token = config.telegramBotToken;
  const chatId = config.telegramChatId;
  if (!token || !chatId) return; // configured nahi — chupchaap skip
  const text = encodeURIComponent(msg);
  const url = `https://api.telegram.org/bot${token}/sendMessage?chat_id=${chatId}&text=${text}`;
  https.get(url, () => {}).on('error', () => {});
}

module.exports = {
  send,
  ipBlocked: () => send('🚨 CU Saathi: Portal ne IP block kiya! Server check karo.'),
  portalDown: () => send('⚠️ CU Saathi: Portal down / unreachable hai. Cached data serve ho raha hai.'),
  portalChanged: (d) => send('🔧 CU Saathi: Portal structure badla lagta hai — ' + d),
  serverStart: () => send('✅ CU Saathi server start ho gaya.'),
  nightly: (s) => send('🌙 Nightly summary: ' + s),
  captchaNeeded: (id) => send(`🔐 CU Saathi: ${id} ka session CAPTCHA maang raha hai.`),
};
