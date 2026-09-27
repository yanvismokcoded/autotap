const fs = require('fs');
const path = require('path');
const config = require('./config');

// Личные данные КАЖДОГО пользователя бота.
// Ключ — telegram id пользователя. Новый пользователь получает пустую
// карточку и логинится своим аккаунтом.

const file = path.join(config.VOLUME_DIR, 'users.json');

let data = { users: {} };

try {
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') data = parsed;
  }
} catch (e) {
  console.error('users.json битый, начинаю с пустого:', e.message);
  data = { users: {} };
}

if (!data.users || typeof data.users !== 'object') data.users = {};

function save() {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('users save error:', e.message);
  }
}

function blank(id) {
  return {
    id: String(id),
    username: null,
    registeredAt: Date.now(),
    key: null,

    // личная авторизация в Telegram
    phone: null,
    session: '',
    apiId: null, // если null — берётся общий из config
    apiHash: null,

    // каналы, которыми тапаем (пишем "@юз" в обсуждении поста от их имени)
    channels: [],

    // сколько тапов делать по умолчанию, если не указано явно
    defaultVotes: config.data.defaultVotes,

    // какие каналы уже тапали какой пост (чтобы не дублировать)
    // ключ "entityId_postId" -> [ref, ref, ...]
    tapped: {}
  };
}

// дописывает поля, появившиеся в новых версиях
function normalize(u) {
  const def = blank(u.id);
  for (const [k, v] of Object.entries(def)) {
    if (u[k] === undefined) u[k] = v;
  }
  if (!Array.isArray(u.channels)) u.channels = [];
  if (!u.tapped || typeof u.tapped !== 'object') u.tapped = {};
  return u;
}

function has(id) {
  return !!data.users[String(id)];
}

function get(id) {
  const u = data.users[String(id)];
  return u ? normalize(u) : null;
}

function create(id, extra = {}) {
  const u = Object.assign(blank(id), extra);
  data.users[String(id)] = u;
  save();
  return u;
}

function ensure(id, extra = {}) {
  return get(id) || create(id, extra);
}

function remove(id) {
  delete data.users[String(id)];
  save();
}

function all() {
  return Object.values(data.users).map(normalize);
}

module.exports = { data, save, has, get, create, ensure, remove, all, file };
