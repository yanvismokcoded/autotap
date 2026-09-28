const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
const { computeCheck } = require('telegram/Password');
const { Raw } = require('telegram/events');

// Один экземпляр = один аккаунт одного пользователя бота.
class Userbot {
  constructor(user, config, users) {
    this.user = user;
    this.config = config;
    this.users = users;
    this.client = null;
    this.phoneCodeHash = null;
  }

  get apiId() {
    return this.user.apiId || this.config.data.apiId;
  }

  get apiHash() {
    return this.user.apiHash || this.config.data.apiHash;
  }

  init() {
    if (!this.apiId || !this.apiHash) throw new Error('Не заданы apiId/apiHash');
    this.client = new TelegramClient(
      new StringSession(this.user.session || ''),
      this.apiId,
      this.apiHash,
      { connectionRetries: 5, autoReconnect: true }
    );
    return this.client;
  }

  async connect() {
    if (!this.client) this.init();
    if (!this.client.connected) await this.client.connect();
    return this.client;
  }

  async sendCode(phone) {
    await this.connect();
    const result = await this.client.sendCode({ apiId: this.apiId, apiHash: this.apiHash }, phone);
    this.phoneCodeHash = result.phoneCodeHash;
    this.user.phone = phone;
    this.users.save();
    return result;
  }

  // Явно просим Telegram доставить код ДРУГИМ способом (обычно после
  // SentCodeTypeApp это переключает на SMS/звонок) — нужно, когда код
  // отправлен в другую сессию приложения, а таких сессий уже нет
  // (например, все сессии аккаунта недавно слетели).
  async resendCode() {
    if (!this.phoneCodeHash || !this.user.phone) throw new Error('Сначала /login <номер телефона>');
    const result = await this.client.invoke(new Api.auth.ResendCode({
      phoneNumber: this.user.phone,
      phoneCodeHash: this.phoneCodeHash
    }));
    this.phoneCodeHash = result.phoneCodeHash;
    return result;
  }

  async signIn(phone, code) {
    const cleanCode = String(code).replace(/\D/g, '');
    if (!this.phoneCodeHash) throw new Error('Сначала /login <номер телефона>');
    try {
      await this.client.invoke(new Api.auth.SignIn({
        phoneNumber: phone,
        phoneCode: cleanCode,
        phoneCodeHash: this.phoneCodeHash
      }));
    } catch (e) {
      if (e.errorMessage === 'SESSION_PASSWORD_NEEDED') return { twofa: true };
      throw e;
    }
    this.saveSession();
    return { twofa: false };
  }

  async checkPassword(password) {
    const pwd = await this.client.invoke(new Api.account.GetPassword());
    const computed = await computeCheck(pwd, password);
    await this.client.invoke(new Api.auth.CheckPassword({ password: computed }));
    this.saveSession();
  }

  // ---------- вход по QR ----------
  //
  // Протокол: auth.exportLoginToken -> показываем QR (tg://login?token=...) ->
  // ждём updateLoginToken (пользователь отсканировал) -> снова exportLoginToken
  // возвращает LoginTokenSuccess (или MigrateTo — тогда переезд на другой DC и
  // auth.importLoginToken). Токен живёт ~30 сек, поэтому QR периодически
  // обновляется. Если у аккаунта включена 2FA — Telegram отвечает
  // SESSION_PASSWORD_NEEDED, дальше пользователь вводит /password как обычно.
  //
  // onQr(url)      — вызывается при каждом новом токене (нужно показать QR)
  // isCancelled()  — true, если пользователь нажал /cancel
  // Возвращает { status: 'ok' | 'twofa' | 'timeout' | 'cancelled' }
  async qrLogin({ onQr, isCancelled, timeoutMs = 3 * 60 * 1000 }) {
    await this.connect();
    const args = { apiId: this.apiId, apiHash: this.apiHash, exceptIds: [] };
    const deadline = Date.now() + timeoutMs;

    let wake = null;
    let done = false;
    const wakeUp = () => {
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    };
    this._qrWake = wakeUp;

    const handler = (update) => {
      if (!done && update instanceof Api.UpdateLoginToken) wakeUp();
    };
    const evt = new Raw({});
    this.client.addEventHandler(handler, evt);

    try {
      let shown = null;
      while (Date.now() < deadline) {
        if (isCancelled()) return { status: 'cancelled' };

        let res = await this.client.invoke(new Api.auth.ExportLoginToken(args));

        if (res instanceof Api.auth.LoginTokenMigrateTo) {
          console.log(`[qr] аккаунт на другом DC, переключаюсь на DC${res.dcId}`);
          await this.client._switchDC(res.dcId);
          console.log('[qr] DC переключён, импортирую токен');
          res = await this.client.invoke(new Api.auth.ImportLoginToken({ token: res.token }));
        }

        if (res instanceof Api.auth.LoginTokenSuccess) {
          await this._afterQrLogin();
          return { status: 'ok' };
        }
        if (!(res instanceof Api.auth.LoginToken)) {
          throw new Error('Неожиданный ответ Telegram: ' + (res && res.className));
        }

        if (!shown || !shown.equals(res.token)) {
          shown = res.token;
          await onQr('tg://login?token=' + Buffer.from(res.token).toString('base64url'));
        }

        // ждём скана либо истечения токена (чтобы обновить QR)
        const left = res.expires - Math.floor(Date.now() / 1000);
        const waitMs = Math.min(Math.max(left, 5), 30) * 1000;
        await new Promise((resolve) => {
          const timer = setTimeout(wakeUp, waitMs);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      return { status: isCancelled() ? 'cancelled' : 'timeout' };
    } catch (e) {
      if (e.errorMessage === 'SESSION_PASSWORD_NEEDED') return { status: 'twofa' };
      throw e;
    } finally {
      done = true;
      this._qrWake = null;
      try { this.client.removeEventHandler(handler, evt); } catch {}
    }
  }

  // прервать ожидание скана (для /cancel)
  wakeQr() {
    if (this._qrWake) this._qrWake();
  }

  async _afterQrLogin() {
    try {
      const me = await this.client.getMe();
      if (me && me.phone) this.user.phone = '+' + me.phone;
    } catch {}
    this.saveSession();
  }

  saveSession() {
    this.user.session = this.client.session.save();
    this.users.save();
  }

  async isAuthorized() {
    if (!this.client) return false;
    try {
      await this.client.getMe();
      return true;
    } catch {
      return false;
    }
  }

  async logout() {
    try {
      if (this.client && this.client.connected) {
        await this.client.invoke(new Api.auth.LogOut());
      }
    } catch (e) {
      console.log('logout error', e.errorMessage || e.message);
    }
    try {
      if (this.client) await this.client.disconnect();
    } catch {}
    this.client = null;
    this.phoneCodeHash = null;
    this.user.session = '';
    this.users.save();
  }

  async disconnect() {
    try {
      if (this.client) await this.client.disconnect();
    } catch {}
    this.client = null;
  }
}

module.exports = Userbot;
