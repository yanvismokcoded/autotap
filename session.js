const { NewMessage } = require('telegram/events');

const Userbot = require('./userbot');
const Tapper = require('./tapper');

// Всё, что происходит от имени одного пользователя: его клиент и его тапер.
class UserSession {
  constructor(user, config, users, bot) {
    this.user = user;
    this.config = config;
    this.users = users;
    this.bot = bot; // telegraf — чтобы писать пользователю в личку

    this.userbot = new Userbot(user, config, users);
    this.tapper = null;
    this.handler = null;
    this.eventBuilder = null;
    this.running = false;
    this.dialogsPrimedAt = 0;
  }

  get client() {
    return this.userbot.client;
  }

  requireClient() {
    if (!this.userbot.client) throw new Error('Аккаунт не подключён — сначала /login <номер>');
    return this.userbot.client;
  }

  // ---------- запуск / остановка ----------

  async start() {
    if (this.running) return;
    if (!this.user.session) throw new Error('Нет сессии — нужна авторизация /login');

    await this.userbot.connect();
    if (!(await this.userbot.isAuthorized())) {
      throw new Error('Сессия недействительна, нужна повторная авторизация /login');
    }

    this.tapper = new Tapper(this.client, this.user, this.users);

    // Слушаем ТОЛЬКО служебные сообщения Telegram (777000: коды входа,
    // уведомления о новых сессиях/входах и т.п.) и сразу пересылаем в личку —
    // иначе код теряется среди других уведомлений, и его приходится искать
    // вручную через /login_code. Никакой другой логики (вз-чаты, автопост,
    // предложения) в этом боте нет вообще.
    this.handler = (event) => this.onMessage(event).catch((e) => console.log('handler error', e.message));
    // Фильтр func отсекает всё, кроме входящих из 777000, ДО вызова обработчика —
    // остальные сообщения аккаунта не попадают в onMessage вообще.
    this.eventBuilder = new NewMessage({
      incoming: true,
      func: (event) => String(event.chatId) === '777000'
    });
    this.client.addEventHandler(this.handler, this.eventBuilder);
    this.running = true;

    console.log(`[user ${this.user.id}] сессия запущена`);
  }

  async stop() {
    if (this.handler && this.client && this.eventBuilder) {
      try { this.client.removeEventHandler(this.handler, this.eventBuilder); } catch {}
    }
    this.handler = null;
    this.eventBuilder = null;
    this.running = false;
    await this.userbot.disconnect();
  }

  // ---------- уведомления ----------

  async notify(text) {
    if (!this.bot) return;
    try {
      await this.bot.telegram.sendMessage(this.user.id, text);
    } catch (e) {
      console.log('notify error', e.message);
    }
  }

  // ---------- служебный чат Telegram (777000) ----------

  async primeDialogs(force = false) {
    if (!this.client) return;
    if (!force && Date.now() - this.dialogsPrimedAt < 10 * 60 * 1000) return;
    try {
      await this.client.getDialogs({ limit: 200 });
      this.dialogsPrimedAt = Date.now();
    } catch (e) {
      console.log('primeDialogs error', e.errorMessage || e.message);
    }
  }

  // Последние сообщения от официального служебного аккаунта Telegram (id 777000).
  // Туда прилетает код входа, если у аккаунта уже есть другая живая сессия —
  // в этом случае Telegram не шлёт SMS/звонок, и код можно прочитать отсюда.
  async getServiceMessages(limit = 20) {
    const client = this.requireClient();
    await this.primeDialogs();
    try {
      return await client.getMessages('777000', { limit });
    } catch (e) {
      await this.primeDialogs(true);
      return await client.getMessages('777000', { limit });
    }
  }

  async onMessage(event) {
    const msg = event.message;
    if (!msg || msg.out || !this.running) return;

    if (String(msg.chatId) === '777000') {
      const text = msg.text || msg.message || '';
      if (text) await this.notify(`📨 Telegram (777000):\n\n${text}`);
    }
  }
}

// --- менеджер сессий: по одной на пользователя ---
class SessionManager {
  constructor(config, users) {
    this.config = config;
    this.users = users;
    this.map = new Map();
    this.bot = null;
  }

  setBot(bot) {
    this.bot = bot;
  }

  // Возвращает сессию пользователя, создавая её при необходимости.
  get(userId) {
    const key = String(userId);
    let s = this.map.get(key);
    if (!s) {
      const user = this.users.ensure(key);
      s = new UserSession(user, this.config, this.users, this.bot);
      this.map.set(key, s);
    }
    s.bot = this.bot;
    return s;
  }

  async drop(userId) {
    const key = String(userId);
    const s = this.map.get(key);
    if (s) {
      await s.stop();
      this.map.delete(key);
    }
  }

  // Поднимает сессии всех, кто уже авторизован
  async startAll() {
    for (const user of this.users.all()) {
      if (!user.session) continue;
      try {
        await this.get(user.id).start();
      } catch (e) {
        console.log(`[user ${user.id}] не удалось поднять сессию:`, e.message);
      }
    }
  }
}

module.exports = { UserSession, SessionManager };
