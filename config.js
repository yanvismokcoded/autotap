const fs = require('fs');
const path = require('path');
const store = require('./store');

// Глобальный конфиг ПРИЛОЖЕНИЯ (общий для всех пользователей):
// apiId/apiHash, токен бота, id владельца и ключи регистрации.
// Личные данные каждого пользователя (сессия, каналы для тапов) — см. users.js
//
// Хранение: если заданы UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN —
// данные лежат в Upstash Redis (нужно на Render Free, где нет дисков).
// Иначе — как раньше, в локальном файле CONFIG_DIR/config.json.

const VOLUME_DIR = process.env.CONFIG_DIR || '/app/data';
const file = path.join(VOLUME_DIR, 'config.json');
const seedFile = path.join(__dirname, 'config.json');
const REMOTE_KEY = 'tapbot:config';

const DEFAULTS = {
  apiId: null,
  apiHash: '',
  botToken: '',
  ownerId: null,
  // значение по умолчанию для НОВОГО пользователя
  defaultVotes: 21,
  pendingKeys: {}
};

// ВАЖНО: объект не переприсваиваем целиком (data = ...), только мутируем —
// другие файлы делают require('./config') один раз при старте и держат
// ссылку именно на этот объект.
const data = {};

function loadLocal() {
  try {
    if (!fs.existsSync(VOLUME_DIR)) fs.mkdirSync(VOLUME_DIR, { recursive: true });
    if (!fs.existsSync(file)) {
      if (fs.existsSync(seedFile)) fs.copyFileSync(seedFile, file);
      else fs.writeFileSync(file, JSON.stringify({}, null, 2));
    }
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (e) {
    console.error('config.json не найден или битый:', e.message);
    return {};
  }
}

function saveLocal() {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('config save (файл) error:', e.message);
  }
}

// Нужно вызвать и дождаться (await) ДО первого обращения к config.data —
// в index.js это сделано первым делом в main().
async function init() {
  let loaded = {};
  if (store.enabled) {
    try {
      const raw = await store.get(REMOTE_KEY);
      loaded = raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.error('config: не смог прочитать из Upstash, начинаю с пустого:', e.message);
    }
  } else {
    loaded = loadLocal();
  }

  Object.assign(data, loaded);

  let changed = false;
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (data[k] === undefined) {
      data[k] = v;
      changed = true;
    }
  }

  // переменные окружения имеют приоритет (удобно для деплоя)
  if (process.env.API_ID) data.apiId = Number(process.env.API_ID);
  if (process.env.API_HASH) data.apiHash = process.env.API_HASH;
  if (process.env.BOT_TOKEN) data.botToken = process.env.BOT_TOKEN;
  if (process.env.OWNER_ID) data.ownerId = Number(process.env.OWNER_ID);

  if (changed) await save();

  console.log(
    'config.js: хранилище —', store.enabled ? 'Upstash Redis' : `файл ${file}`,
    '| apiId =', data.apiId, '| ownerId =', data.ownerId
  );
}

async function save() {
  if (store.enabled) {
    try {
      await store.set(REMOTE_KEY, JSON.stringify(data));
    } catch (e) {
      console.error('config save (Upstash) error:', e.message);
    }
  } else {
    saveLocal();
  }
}

module.exports = { data, save, init, file, VOLUME_DIR };
