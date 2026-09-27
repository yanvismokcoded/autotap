// Фоновые циклы библиотеки telegram (gramjs) — в частности приём апдейтов —
// иногда кидают TIMEOUT/сетевые ошибки как необработанный reject, который
// не относится к нашему коду и который мы никак не await'им. Начиная с
// Node 15 необработанный rejection по умолчанию убивает весь процесс.
// Логируем и продолжаем работу вместо падения.
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
});

const config = require('./config');
const users = require('./users');
const { SessionManager } = require('./session');
const setupBot = require('./bot');
const http = require('http');

// Render (в т.ч. бесплатный Web Service) ждёт, что приложение слушает PORT,
// и без этого считает деплой нездоровым и перезапускает контейнер по кругу —
// из-за этого бот мог не успевать отвечать вообще ни на что. Открываем
// простой health-check сервер; сам бот всё так же работает через polling.
function startHealthServer() {
  const port = process.env.PORT;
  if (!port) return; // локально/на площадке без Web Service порт не нужен
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  }).listen(port, () => {
    console.log(`health-check сервер слушает порт ${port}`);
  });
}

async function main() {
  // ВАЖНО: до этого момента config.data/users.* ещё не заполнены —
  // init() тянет данные из Upstash Redis (если настроен) либо с диска.
  await config.init();
  await users.init();

  if (!config.data.botToken) {
    console.error('Не задан botToken (config.json или переменная BOT_TOKEN)');
    process.exit(1);
  }
  if (!config.data.apiId || !config.data.apiHash) {
    console.error('Не заданы apiId/apiHash (config.json или переменные API_ID/API_HASH)');
    process.exit(1);
  }

  const sessions = new SessionManager(config, users);
  const bot = setupBot(config, users, sessions);

  startHealthServer();

  // поднимаем сессии всех, кто уже авторизован
  await sessions.startAll();

  console.log(`Tap bot запущен. Пользователей: ${users.all().length}`);

  const shutdown = async (signal) => {
    console.log('Останавливаюсь:', signal);
    try { bot.stop(signal); } catch {}
    for (const s of sessions.map.values()) {
      try { await s.stop(); } catch {}
    }
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
