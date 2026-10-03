const { Telegraf } = require('telegraf');
const crypto = require('crypto');
const QRCode = require('qrcode');
const https = require('https');
const parser = require('./parser');

// Одноразовый ключ вида "A1B2-C3D4"
function generateKey() {
  const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

// Куда Telegram реально доставил код входа (result.type из auth.SentCode).
// className в gramjs может приходить с префиксом "auth." — отбрасываем его.
const SENT_CODE_WHERE = {
  SentCodeTypeApp: 'в другое уже открытое приложение Telegram с этим аккаунтом — ищите сообщение в служебном чате «Telegram»',
  SentCodeTypeSms: 'по SMS на телефон',
  SentCodeTypeCall: 'голосовым звонком на телефон',
  SentCodeTypeFlashCall: 'звонком-сбросом — код спрятан в номере звонившего',
  SentCodeTypeMissedCall: 'пропущенным звонком — код спрятан в номере звонившего',
  SentCodeTypeEmailCode: 'на привязанную к аккаунту почту',
  SentCodeTypeFragmentSms: 'через Fragment (анонимный номер)',
  SentCodeTypeFirebaseSms: 'через Firebase-SMS (такой способ работает только в официальных приложениях)',
  SentCodeTypeSmsWord: 'по SMS (слово вместо цифр)',
  SentCodeTypeSmsPhrase: 'по SMS (фраза вместо цифр)',
  SentCodeTypeSetUpEmailRequired: 'Telegram требует сначала привязать почту — вход по коду недоступен'
};
// Способы, при которых код сторонний клиент (бот) получить не сможет
const SENT_CODE_UNUSABLE = new Set(['SentCodeTypeFirebaseSms', 'SentCodeTypeSetUpEmailRequired']);

function sentCodeName(t) {
  return String((t && t.className) || '').split('.').pop();
}
function describeSentCode(result) {
  const name = sentCodeName(result && result.type);
  return SENT_CODE_WHERE[name] || (name ? `способом ${name}` : 'через Telegram');
}
function sentCodeUnusable(result) {
  return SENT_CODE_UNUSABLE.has(sentCodeName(result && result.type));
}

// В тексте сетевых ошибок Telegraf/node-fetch виден URL вида .../bot<ТОКЕН>/метод —
// прячем токен, чтобы он не утёк ни в чат, ни в логи.
function safeErr(e) {
  const msg = (e && (e.errorMessage || e.message)) || String(e);
  return String(msg).replace(/bot\d+:[\w-]+/g, 'bot<token>');
}

// Повтор при обрывах связи с api.telegram.org (socket hang up и т.п.)
async function withRetry(fn, tries = 3, delayMs = 1000) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw last;
}

function parseArgs(ctx) {
  return ctx.message.text.split(/[\s,;]+/).slice(1).filter(Boolean);
}

async function replyLong(ctx, text) {
  const MAX = 4000;
  let rest = text;
  while (rest.length > MAX) {
    let cut = rest.lastIndexOf('\n', MAX);
    if (cut <= 0) cut = MAX;
    await ctx.reply(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) await ctx.reply(rest);
}

function helpText(isOwner) {
  return (
    'Тап-бот. Каждый пользователь работает на своём аккаунте и со своим списком каналов.\n\n' +
    (isOwner ? '👑 Владелец:\n/genkey — выдать ключ регистрации\n/users — список пользователей\n/revoke <id> — удалить пользователя\n/login_code — показать последние сообщения из служебного чата Telegram (777000, до 20 шт.)\n\n' : '') +
    '🔑 Аккаунт:\n' +
    '/login <номер> — вход в свой Telegram (например /login +79990000000)\n' +
    '/login_qr — вход по QR-коду (без SMS; сканировать с другого устройства)\n' +
    '/cancel — отменить вход по QR\n' +    '/code <код> — код из Telegram\n' +
    '/resend_code — код не пришёл? запросить его заново другим способом (обычно переключает на SMS)\n' +
    '/password <пароль> — 2FA\n' +
    '/logout — выйти из аккаунта\n' +
    'ℹ️ Пока сессия активна, коды входа от Telegram (777000) пересылаются сразу и автоматически в личку\n' +
    '/api <apiId> <apiHash> — свои api-ключи (необязательно)\n\n' +
    '📢 Каналы для тапов:\n' +
    '/add_channel <ссылка> [...], /channels, /del_channel <ссылка> [...]\n' +
    '/create_channel <название>\n\n' +
    '👆 Тап:\n' +
    '/tap <ссылка на пост> @юз [количество] — тапнуть напрямую\n' +
    '/tap <ссылка на пост> — юз бот найдёт в посте сам (можно и ответом на пересланный пост)\n' +
    '/del_tap <ссылка|all> — забыть тап по посту (или все), можно тапнуть снова\n\n' +
    '⚙️ Прочее:\n' +
    '/settings — личные настройки (число тапов по умолчанию)\n' +
    '/set votes <число> — изменить\n' +
    '/status — статус'
  );
}

function setupBot(config, users, sessions) {
  // keepAlive: false — лечит "socket hang up", когда Node переиспользует
  // уже закрытое сервером соединение (особенно при отправке файлов).
  const bot = new Telegraf(config.data.botToken, {
    telegram: { agent: new https.Agent({ keepAlive: false }) }
  });
  sessions.setBot(bot);

  // ---------- доступ ----------

  const isOwner = (ctx) => !!config.data.ownerId && String(ctx.from.id) === String(config.data.ownerId);
  const isRegistered = (ctx) => users.has(ctx.from.id);

  const PUBLIC_COMMANDS = ['/start', '/activate', '/help'];

  bot.use((ctx, next) => {
    if (!ctx.from || ctx.chat?.type !== 'private') return; // бот работает только в личке
    if (isRegistered(ctx)) return next();

    const raw = (ctx.message && ctx.message.text) || '';
    const cmd = raw.split(/[\s@]/)[0];
    if (PUBLIC_COMMANDS.includes(cmd)) return next();

    return ctx.reply(
      '🔒 Доступ закрыт. Получите ключ у владельца бота и введите:\n/activate <ключ>'
    );
  });

  // удобные хелперы: данные и сессия ТЕКУЩЕГО пользователя
  const U = (ctx) => users.get(ctx.from.id);
  const S = (ctx) => sessions.get(ctx.from.id);

  // активные QR-входы: userId -> { cancelled, msgId }
  const qrFlows = new Map();

  // Фоновый процесс QR-входа. ВАЖНО: не await'им его из обработчика команды —
  // Telegraf обрабатывает апдейты по очереди (и режет обработчик по таймауту 90 с),
  // долгий обработчик заблокировал бы и /cancel, и /password.
  async function runQrLogin(uid, chatId, flow) {
    const s = sessions.get(uid);
    const say = (text) => withRetry(() => bot.telegram.sendMessage(chatId, text)).catch(() => {});
    const dropQr = async () => {
      if (flow.msgId) {
        await bot.telegram.deleteMessage(chatId, flow.msgId).catch(() => {});
        flow.msgId = null;
      }
    };

    const CAPTION =
      '📷 Отсканируйте QR с ДРУГОГО устройства:\n' +
      'Telegram → Настройки → Устройства → Подключить устройство.\n' +
      'QR обновляется каждые ~30 сек. Отмена: /cancel';

    // Основной способ — картинка. Если загрузка файлов до Telegram не проходит
    // (обрывы соединения) — запасной: QR символами в обычном сообщении.
    const showPhoto = async (url) => {
      const png = await QRCode.toBuffer(url, { width: 400, margin: 2 });
      if (flow.msgId) {
        try {
          await bot.telegram.editMessageMedia(
            chatId, flow.msgId, undefined,
            { type: 'photo', media: { source: png }, caption: CAPTION }
          );
          return;
        } catch (e) {
          await dropQr();
        }
      }
      const m = await withRetry(() => bot.telegram.sendPhoto(chatId, { source: png }, { caption: CAPTION }));
      flow.msgId = m.message_id;
    };

    const showText = async (url) => {
      const art = await QRCode.toString(url, { type: 'utf8', margin: 1 });
      const html = `<pre>${art}</pre>\n${CAPTION}`;
      if (flow.msgId) {
        try {
          await bot.telegram.editMessageText(chatId, flow.msgId, undefined, html, { parse_mode: 'HTML' });
          return;
        } catch (e) {
          await dropQr();
        }
      }
      const m = await withRetry(() => bot.telegram.sendMessage(chatId, html, { parse_mode: 'HTML' }));
      flow.msgId = m.message_id;
    };

    try {
      const result = await s.userbot.qrLogin({
        isCancelled: () => flow.cancelled,
        onQr: async (url) => {
          if (!flow.textMode) {
            try {
              await showPhoto(url);
              return;
            } catch (e) {
              console.error('qr: не удалось отправить картинку, перехожу на текстовый QR:', safeErr(e));
              flow.textMode = true;
              await dropQr();
            }
          }
          await showText(url);
        }
      });

      await dropQr();

      if (result.status === 'ok') {
        await s.start();
        await say('✅ Аккаунт подключён по QR. Добавьте каналы для тапов: /add_channel');
      } else if (result.status === 'twofa') {
        await say('🔐 QR принят, но включена 2FA. Введите пароль: /password <пароль>');
      } else if (result.status === 'cancelled') {
        await say('QR-вход отменён.');
      } else {
        await say('⌛ Время на вход по QR вышло. Повторить: /login_qr');
      }
    } catch (e) {
      await dropQr();
      console.error('qr login error:', String((e && e.stack) || e).replace(/bot\d+:[\w-]+/g, 'bot<token>'));
      await say(`Ошибка QR-входа: ${safeErr(e)}`);
    } finally {
      qrFlows.delete(uid);
    }
  }

  function clientOf(ctx) {
    const s = S(ctx);
    if (!s.userbot.client) throw new Error('Аккаунт не подключён — сначала /login <номер>');
    return s.userbot.client;
  }

  // ---------- регистрация ----------

  bot.start(async (ctx) => {
    if (!config.data.ownerId) {
      config.data.ownerId = ctx.from.id;
      config.save();
      users.ensure(ctx.from.id, { username: ctx.from.username || null, key: 'owner' });
      await ctx.reply('👑 Вы назначены владельцем бота (первый /start). Ключи выдаются командой /genkey.');
    }
    if (!isRegistered(ctx)) {
      return ctx.reply('🔒 Нужна регистрация. Получите ключ у владельца бота и введите:\n/activate <ключ>');
    }
    await replyLong(ctx, helpText(isOwner(ctx)));
  });

  bot.command('help', (ctx) => {
    if (!isRegistered(ctx)) return ctx.reply('🔒 Сначала /activate <ключ>');
    return replyLong(ctx, helpText(isOwner(ctx)));
  });

  bot.command('genkey', (ctx) => {
    if (!isOwner(ctx)) return ctx.reply('🔒 Команда только для владельца бота');
    const key = generateKey();
    config.data.pendingKeys[key] = { createdAt: Date.now() };
    config.save();
    ctx.reply(`🔑 Ключ регистрации: \`${key}\`\nОдноразовый. Отправьте новому пользователю.`, { parse_mode: 'Markdown' });
  });

  bot.command('activate', (ctx) => {
    const key = parseArgs(ctx)[0];
    if (!key) return ctx.reply('Формат: /activate <ключ>');
    if (users.has(ctx.from.id)) return ctx.reply('Вы уже зарегистрированы. /start — список команд');

    const normalized = key.toUpperCase();
    if (!config.data.pendingKeys[normalized]) return ctx.reply('❌ Неверный или уже использованный ключ');

    delete config.data.pendingKeys[normalized];
    config.save();

    users.create(ctx.from.id, { username: ctx.from.username || null, key: normalized });

    ctx.reply(
      '✅ Регистрация прошла успешно!\n\n' +
      'Дальше нужно подключить СВОЙ аккаунт Telegram:\n' +
      '1) /login +79990000000\n' +
      '2) /code <код из Telegram>\n' +
      '3) при 2FA — /password <пароль>\n\n' +
      'После этого добавьте каналы для тапов (/add_channel).'
    );
  });

  bot.command('users', (ctx) => {
    if (!isOwner(ctx)) return ctx.reply('🔒 Команда только для владельца бота');
    const list = users.all();
    if (!list.length) return ctx.reply('Пользователей нет');
    const lines = list.map((u, i) =>
      `${i + 1}. id ${u.id}${u.username ? ' @' + u.username : ''}` +
      ` — вход: ${u.session ? 'да' : 'нет'}, каналов: ${u.channels.length}`
    );
    replyLong(ctx, `Пользователей: ${list.length}\n` + lines.join('\n'));
  });

  bot.command('revoke', async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply('🔒 Команда только для владельца бота');
    const id = parseArgs(ctx)[0];
    if (!id) return ctx.reply('Формат: /revoke <id пользователя>');
    if (String(id) === String(config.data.ownerId)) return ctx.reply('Нельзя удалить владельца');
    if (!users.has(id)) return ctx.reply('Такого пользователя нет');
    await sessions.drop(id);
    users.remove(id);
    ctx.reply(`🗑 Пользователь ${id} удалён вместе со своими данными`);
  });

  // ---------- личная авторизация ----------

  bot.command('login', async (ctx) => {
    const u = U(ctx);
    const phone = parseArgs(ctx)[0] || u.phone;
    if (!phone) return ctx.reply('Формат: /login +79990000000');
    if (!/^\+?\d{7,15}$/.test(phone)) return ctx.reply('Похоже, это не номер. Формат: /login +79990000000');

    try {
      const s = S(ctx);
      await s.userbot.connect();
      if (await s.userbot.isAuthorized()) {
        return ctx.reply('Аккаунт уже подключён. Чтобы войти другим — сначала /logout');
      }
      const result = await s.userbot.sendCode(phone.startsWith('+') ? phone : '+' + phone);
      const where = describeSentCode(result);
      if (sentCodeUnusable(result)) {
        return ctx.reply(
          `Telegram выбрал способ доставки, при котором код не получить: ${where}.\n` +
          'Войдите по QR-коду: /login_qr'
        );
      }
      ctx.reply(
        `Код отправлен: ${where}.\nВведите, вставив пробелы между цифрами: /code 1 2 3 4 5\n` +
        '(без пробелов Telegram считает код «слитым» и аннулирует его)\n' +
        'Если код так и не пришёл — попробуйте /resend_code (запросит другой способ, обычно SMS) или войдите по QR: /login_qr'
      );
    } catch (e) {
      console.error('login error:', e);
      ctx.reply(`Ошибка: ${e.errorMessage || e.message}`);
    }
  });

  bot.command('login_qr', async (ctx) => {
    const uid = String(ctx.from.id);
    if (qrFlows.has(uid)) return ctx.reply('QR-вход уже запущен. Отменить: /cancel');

    try {
      const s = S(ctx);
      await s.userbot.connect();
      if (await s.userbot.isAuthorized()) {
        return ctx.reply('Аккаунт уже подключён. Чтобы войти другим — сначала /logout');
      }
    } catch (e) {
      console.error('login_qr error:', e);
      return ctx.reply(`Ошибка: ${e.errorMessage || e.message}`);
    }

    const flow = { cancelled: false, msgId: null, textMode: false };
    qrFlows.set(uid, flow);
    runQrLogin(uid, ctx.chat.id, flow); // намеренно без await
  });

  bot.command('cancel', (ctx) => {
    const flow = qrFlows.get(String(ctx.from.id));
    if (!flow) return ctx.reply('Нечего отменять.');
    flow.cancelled = true;
    S(ctx).userbot.wakeQr(); // сообщение об отмене отправит сам процесс входа
  });

  bot.command('resend_code', async (ctx) => {
    try {
      const s = S(ctx);
      const result = await s.userbot.resendCode();
      const where = describeSentCode(result);
      ctx.reply(`Код запрошен заново: ${where}.\nВведите: /code <код>`);
    } catch (e) {
      console.error('resend_code error:', e);
      ctx.reply(`Ошибка: ${e.errorMessage || e.message}`);
    }
  });

  bot.command('code', async (ctx) => {
    const u = U(ctx);
    const code = ctx.message.text.split(' ').slice(1).join('');
    if (!code) return ctx.reply('Формат: /code 12345');
    try {
      const s = S(ctx);
      const res = await s.userbot.signIn(u.phone, code);
      if (res.twofa) return ctx.reply('Нужен пароль 2FA: /password <пароль>');
      await s.start();
      ctx.reply('✅ Аккаунт подключён. Добавьте каналы для тапов: /add_channel');
    } catch (e) {
      console.error('code error:', e);
      ctx.reply(`Ошибка: ${e.errorMessage || e.message}`);
    }
  });

  bot.command('password', async (ctx) => {
    const pwd = ctx.message.text.split(' ').slice(1).join(' ');
    if (!pwd) return ctx.reply('Формат: /password пароль');
    try {
      const s = S(ctx);
      await s.userbot.checkPassword(pwd);
      await s.start();
      ctx.reply('✅ Аккаунт подключён. Добавьте каналы для тапов: /add_channel');
    } catch (e) {
      console.error('password error:', e);
      ctx.reply(`Ошибка: ${e.errorMessage || e.message}`);
    }
  });

  bot.command('logout', async (ctx) => {
    try {
      const flow = qrFlows.get(String(ctx.from.id));
      if (flow) flow.cancelled = true;
      const s = S(ctx);
      await s.stop();
      await s.userbot.logout();
      await sessions.drop(ctx.from.id);
      ctx.reply('👋 Вышли из аккаунта. Список каналов сохранён. Вход снова — /login <номер>');
    } catch (e) {
      ctx.reply(`Ошибка: ${e.message}`);
    }
  });

  // Если у аккаунта уже есть живая сессия (эта самая) — при новом входе с телефона
  // Telegram шлёт код не SMS'ом, а сообщением от служебного аккаунта 777000.
  // Эта команда читает его через нашу сессию.
  bot.command('login_code', async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply('🔒 Команда только для владельца бота');
    const s = S(ctx);
    try {
      await s.userbot.connect();
      if (!(await s.userbot.isAuthorized())) {
        return ctx.reply(
          'Текущая сессия недействительна — через бота код так не получить.\n' +
          'Нужно заново авторизоваться: /login <номер>, тогда Telegram пришлёт код по SMS или звонком.'
        );
      }
      const messages = await s.getServiceMessages(20);
      const withText = messages.filter((m) => m.message);
      if (!withText.length) return ctx.reply('В служебном чате Telegram (777000) пока пусто.');

      const lines = withText.map((m) => {
        const d = new Date(m.date * 1000);
        const p = (n) => String(n).padStart(2, '0');
        const time = `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
        return `[${time}] ${m.message}`;
      });
      await replyLong(ctx, `📨 Последние сообщения от Telegram:\n\n${lines.join('\n\n')}`);
    } catch (e) {
      ctx.reply(`Ошибка: ${e.errorMessage || e.message}`);
    }
  });

  bot.command('api', (ctx) => {
    const [apiId, apiHash] = parseArgs(ctx);
    const u = U(ctx);
    if (!apiId) {
      return ctx.reply(`Ваши api-ключи: ${u.apiId ? u.apiId + ' (свои)' : (config.data.apiId + ' (общие)')}\nСменить: /api <apiId> <apiHash>`);
    }
    if (!apiHash) return ctx.reply('Формат: /api <apiId> <apiHash>');
    u.apiId = Number(apiId);
    u.apiHash = apiHash;
    users.save();
    ctx.reply('Сохранено. Теперь /logout и заново /login <номер>');
  });

  // ---------- каналы для тапов ----------

  bot.command('add_channel', async (ctx) => {
    const u = U(ctx);
    const refs = parseArgs(ctx);
    if (!refs.length) return ctx.reply('Укажи одну или несколько ссылок/username каналов');

    const lines = [];
    for (const ref of refs) {
      if (u.channels.includes(ref)) lines.push(`• уже в списке: ${ref}`);
      else {
        u.channels.push(ref);
        lines.push(`✅ ${ref}`);
      }
    }
    users.save();
    await replyLong(ctx, lines.join('\n'));
  });

  bot.command('channels', (ctx) => {
    const u = U(ctx);
    replyLong(ctx, u.channels.length ? `Каналов: ${u.channels.length}\n` + u.channels.join('\n') : 'Список пуст');
  });

  bot.command('del_channel', (ctx) => {
    const u = U(ctx);
    const refs = parseArgs(ctx);
    if (!refs.length) return ctx.reply('Укажи ссылку/username канала (см. /channels)');
    const before = u.channels.length;
    u.channels = u.channels.filter((c) => !refs.includes(c));
    users.save();
    ctx.reply(`Удалено: ${before - u.channels.length} из ${refs.length}`);
  });

  bot.command('create_channel', async (ctx) => {
    const title = ctx.message.text.replace(/^\/\S+\s*/, '').trim();
    if (!title) return ctx.reply('Укажи название');
    try {
      const client = clientOf(ctx);
      const { Api, utils } = require('telegram');
      const result = await client.invoke(new Api.channels.CreateChannel({
        title, about: 'tap', broadcast: true, megagroup: false
      }));
      const channel = result.chats[0];
      const ref = channel.username ? '@' + channel.username : String(utils.getPeerId(channel));
      U(ctx).channels.push(ref);
      users.save();
      ctx.reply(`Канал создан: ${ref}`);
    } catch (e) {
      ctx.reply(`Ошибка: ${e.errorMessage || e.message}`);
    }
  });

  // ---------- тап ----------

  bot.command('tap', async (ctx) => {
    const u = U(ctx);
    const s = S(ctx);
    if (!s.running || !s.tapper) return ctx.reply('Аккаунт не подключён — сначала /login <номер>');
    if (!u.channels.length) return ctx.reply('Нет каналов для тапов (/add_channel)');

    const body = ctx.message.text.replace(/^\/\S+\s*/, '');
    let parsed = parser.parseVzMessage(body, true);

    // В команде нет явного юза — пробуем вытащить его прямо из поста:
    // 1) если дали ссылку на сообщение в чате/канале — подтягиваем его текст;
    // 2) если /tap отправлен ответом на пересланный пост — берём текст оттуда.
    if (!parsed) {
      const ref = parser.parseMessageLink(body);
      if (ref) {
        try {
          const [linked] = await s.client.getMessages(ref.peer, { ids: [ref.id] });
          if (linked) parsed = parser.parseVzMessage(parser.messageToText(linked), true);
        } catch (e) {
          console.log('tap: linked message error', e.errorMessage || e.message);
        }
      }
    }

    if (!parsed && ctx.message.reply_to_message) {
      const replied = ctx.message.reply_to_message;
      const repliedText = replied.text || replied.caption || '';
      parsed = parser.parseVzMessage(repliedText, true);
    }

    if (!parsed) {
      return ctx.reply(
        'Формат: /tap <ссылка на пост> @юз [количество]\n' +
        'Либо просто /tap <ссылка на сообщение с постом> — ссылку и юз возьму из него самого\n' +
        'Либо ответьте командой /tap на пересланный пост'
      );
    }

    try {
      await ctx.reply(`Тапаю: @${parsed.username} | ${parsed.link}…`);
      const result = await s.tapper.tap(parsed.link, parsed.username, parsed.count || u.defaultVotes);
      ctx.reply(`✅ Тап выполнен: @${parsed.username} | ${parsed.link} | каналов: ${result.total}`);
    } catch (e) {
      ctx.reply(`❌ Ошибка тапа: ${e.errorMessage || e.message}`);
    }
  });

  // Забыть, что пост уже тапали — чтобы можно было тапнуть его снова
  bot.command('del_tap', async (ctx) => {
    const u = U(ctx);
    const s = S(ctx);
    const arg = ctx.message.text.replace(/^\/\S+\s*/, '').trim();
    if (!arg) {
      return ctx.reply('Формат: /del_tap <ссылка на пост> — забыть тапы по этому посту, чтобы тапнуть снова\nОчистить всё: /del_tap all');
    }

    if (arg.toLowerCase() === 'all') {
      const count = Object.keys(u.tapped).length;
      u.tapped = {};
      users.save();
      return ctx.reply(`🗑 Забыл про все тапнутые посты (${count})`);
    }

    if (!s.tapper) return ctx.reply('Аккаунт не подключён — сначала /login <номер>');
    try {
      const { entity, postId } = await s.tapper.resolveLink(arg);
      if (!postId) return ctx.reply('В ссылке нет номера поста — нужна ссылка вида t.me/chat/123');
      const key = `${entity.id}_${postId}`;
      if (!u.tapped[key]) return ctx.reply('По этой ссылке записанных тапов нет');
      const channelsCount = u.tapped[key].length;
      delete u.tapped[key];
      users.save();
      ctx.reply(`🗑 Забыл тапы по этому посту (было каналов: ${channelsCount}) — можно тапнуть снова`);
    } catch (e) {
      ctx.reply(`❌ ${e.errorMessage || e.message}`);
    }
  });

  // ---------- настройки и статус ----------

  bot.command('settings', (ctx) => {
    const u = U(ctx);
    ctx.reply(
      'Личные настройки:\n' +
      `votes = ${u.defaultVotes}\n\n` +
      'Изменить: /set votes <число>'
    );
  });

  bot.command('set', (ctx) => {
    const u = U(ctx);
    const parts = ctx.message.text.split(/\s+/).slice(1);
    const name = (parts[0] || '').toLowerCase();
    const value = parts[1];
    if (name !== 'votes' || !value) return ctx.reply('Формат: /set votes <число>');
    const n = parseInt(value, 10);
    if (!n || n < 1) return ctx.reply('Нужно целое число больше 0');
    u.defaultVotes = n;
    users.save();
    ctx.reply(`✅ votes = ${u.defaultVotes}`);
  });

  bot.command('status', async (ctx) => {
    const u = U(ctx);
    const s = S(ctx);
    const auth = await s.userbot.isAuthorized();
    ctx.reply(
      `👤 Ваш id: ${u.id}\n` +
      `Аккаунт: ${auth ? 'подключён' + (u.phone ? ' (' + u.phone + ')' : '') : 'не подключён — /login <номер>'}\n` +
      `Каналов для тапов: ${u.channels.length}`
    );
  });

  bot.catch((err, ctx) => {
    console.error('bot error:', safeErr(err));
    try { ctx.reply(`Ошибка: ${safeErr(err)}`).catch(() => {}); } catch {}
  });

  bot.launch();
  return bot;
}

module.exports = setupBot;
