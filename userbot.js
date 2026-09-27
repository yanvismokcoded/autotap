const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
const { computeCheck } = require('telegram/Password');

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
