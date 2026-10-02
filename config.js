// CU Saathi Server — configuration
// Secrets env vars se aate hain, code me kabhi hardcode nahi.
module.exports = {
  port: process.env.PORT || 3000,
  portalBase: 'https://students.cuchd.in',
  // Telegram (owner alerts) — @BotFather se banao, token yahan env me
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  // Session encryption key — pehli baar auto-generate, phir .server_key me save
  dataDir: process.env.DATA_DIR || __dirname + '/data',
};
