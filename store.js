// Крошечный клиент к Upstash Redis REST API. Нужен, чтобы хранить config.json
// и users.json не на локальном диске (на бесплатном Render его просто нет —
// файловая система эфемерна), а во внешнем бесплатном key-value хранилище.
//
// Настройка:
//  1) Зарегистрируйся на upstash.com, создай Redis-базу (Free tier).
//  2) Скопируй "REST URL" и "REST TOKEN" со страницы базы.
//  3) Задай их в Render как переменные окружения:
//     UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
//
// Если эти переменные не заданы — store.enabled = false, и config.js/users.js
// сами используют старое поведение (локальный файл).

const BASE = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const enabled = !!(BASE && TOKEN);

if (enabled && typeof fetch !== 'function') {
  throw new Error('Нужен Node.js 18+ (глобальный fetch) для работы с Upstash Redis');
}

async function get(key) {
  const res = await fetch(`${BASE}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  if (!res.ok) throw new Error(`Upstash GET ${key} — HTTP ${res.status}`);
  const json = await res.json();
  return json.result ?? null;
}

// Значение передаём телом запроса (а не в URL), чтобы не бороться
// с экранированием спецсимволов в JSON.
async function set(key, value) {
  const res = await fetch(`${BASE}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'text/plain' },
    body: value
  });
  if (!res.ok) throw new Error(`Upstash SET ${key} — HTTP ${res.status}`);
}

module.exports = { get, set, enabled };
