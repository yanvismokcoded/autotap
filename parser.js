const TG_LINK_RE = /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/[^\s<>()\[\]"'«»*]+/gi;

// Юзы, за которых бот никогда не тапает (чс). На поиск ссылок это не влияет —
// ссылка на пост в этих же каналах обрабатывается как обычно.
const BLACKLISTED_USERNAMES = new Set(['mainirl', 'bestirl']);

function isBlacklisted(username) {
  return !!username && BLACKLISTED_USERNAMES.has(username.toLowerCase());
}

// Ссылки, которые не могут быть ссылкой на пост
const NOT_POST_RE = /\/(?:\+|joinchat\/|addlist\/|addstickers\/|addemoji\/|proxy|socks)/i;

// Ссылка на сообщение в ПУБЛИЧНОМ чате/канале:
//   t.me/chat/123, t.me/chat/123?comment=5, t.me/chat/topic/123
const MSG_LINK_RE = /^https?:\/\/(?:t\.me|telegram\.me)\/([a-zA-Z][a-zA-Z0-9_]{3,31})\/(\d+)(?:\/(\d+))?(?:[?#].*)?$/i;

function normalizeLink(raw) {
  let link = raw.replace(/[.,;:!?…]+$/, '');
  if (!link.startsWith('http')) link = 'https://' + link;
  return link;
}

function findLinks(text) {
  return (text.match(TG_LINK_RE) || []).map(normalizeLink);
}

// Если ссылок несколько (например, на канал и на пост) — берём ту, что ведёт на пост
function pickPostLink(links) {
  const usable = links.filter((l) => !NOT_POST_RE.test(l));
  const pool = usable.length ? usable : links;
  return pool.find((l) => MSG_LINK_RE.test(l)) || pool[0] || null;
}

function findUsername(text) {
  // "@юз1 & @юз2" — тап сразу за обоих, в этом же виде и отправляем.
  // Если один из пары в чс — тапаем только за второго; если оба в чс — ищем дальше.
  const pairRe = /@([a-zA-Z0-9_]{5,})\s*&\s*@([a-zA-Z0-9_]{5,})/g;
  let pair;
  while ((pair = pairRe.exec(text))) {
    const [, u1, u2] = pair;
    const b1 = isBlacklisted(u1);
    const b2 = isBlacklisted(u2);
    if (!b1 && !b2) return `${u1} & @${u2}`;
    if (b1 && !b2) return u2;
    if (b2 && !b1) return u1;
  }

  // Голое "@юз" — если он в чс, ищем следующее упоминание в тексте
  const atRe = /@([a-zA-Z0-9_]{5,})/g;
  let at;
  while ((at = atRe.exec(text))) {
    if (!isBlacklisted(at[1])) return at[1];
  }

  // "юз: name", "юз name", "юзер - name", "username name"
  const kwRe = /(?:юз(?:ер)?(?:нейм)?|user(?:name)?)\s*[:=\-—–]?\s*@?([a-zA-Z][a-zA-Z0-9_]{4,})/gi;
  let kw;
  while ((kw = kwRe.exec(text))) {
    if (!isBlacklisted(kw[1])) return kw[1];
  }

  // "вз? ссылка * юз" — юзер после звёздочки, @ не обязателен
  const starRe = /\*\s*@?([a-zA-Z0-9_]{5,})/g;
  let star;
  while ((star = starRe.exec(text))) {
    if (!isBlacklisted(star[1])) return star[1];
  }

  return null;
}

// Достаёт из текста ссылку на пост, юз и (если есть) число тапов.
// Работает и на свободных предложениях, не только на "вз? ссылка @юз".
// Возвращает null, если ссылки или юза нет.
function parseVzMessage(text, allowStarFormat = false) {
  if (!text) return null;

  const link = pickPostLink(findLinks(text));
  if (!link) return null;

  const username = findUsername(text);
  if (!username) return null;

  let count = null;
  const countMatch = text.match(/(\d+)\s*(?:голос|тап|вз)/i) || text.match(/вз\s+(\d+)/i);
  if (countMatch) count = parseInt(countMatch[1]);

  return { link, username, count };
}

// ---------- несколько голосований в одном сообщении ----------

// "ссылка*юз", "ссылка * @юз", "ссылка*юз1 & @юз2" — можно много штук подряд:
//   ищем вз t.me/chan/12*user_one t.me/chan2/45*user_two
const STAR_PAIR_SRC =
  '((?:https?:\\/\\/)?(?:t\\.me|telegram\\.me)\\/[^\\s<>()\\[\\]"\'«»*]+)' +
  '\\s*\\*\\s*@?([a-zA-Z0-9_]{5,})' +
  '(?:\\s*&\\s*@([a-zA-Z0-9_]{5,}))?';

function pickAllowed(u1, u2) {
  if (!u2) return isBlacklisted(u1) ? null : u1;
  const b1 = isBlacklisted(u1);
  const b2 = isBlacklisted(u2);
  if (!b1 && !b2) return `${u1} & @${u2}`;
  if (b1 && !b2) return u2;
  if (b2 && !b1) return u1;
  return null;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((it) => {
    const key = (it.link + '|' + it.username).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Только формат "ссылка*юз" (одна или несколько пар). Возвращает массив
// { link, username, count: null }.
function parseStarPairs(text) {
  if (!text) return [];
  const out = [];
  for (const m of text.matchAll(new RegExp(STAR_PAIR_SRC, 'gi'))) {
    if (NOT_POST_RE.test(m[1])) continue;
    const username = pickAllowed(m[2], m[3]);
    if (!username) continue;
    out.push({ link: normalizeLink(m[1]), username, count: null });
  }
  return dedupe(out);
}

// Все голосования из сообщения:
//  1) пары "ссылка*юз" — сколько бы их ни было;
//  2) иначе — по одной на строку ("ссылка @юз" на каждой строке);
//  3) иначе — как раньше: одна ссылка и один юз из всего текста.
function parseVzMessages(text) {
  if (!text) return [];

  const stars = parseStarPairs(text);
  if (stars.length) return stars;

  const perLine = [];
  for (const line of text.split(/\r?\n/)) {
    const r = parseVzMessage(line);
    if (r) perLine.push(r);
  }
  if (perLine.length >= 2) return dedupe(perLine);

  const single = parseVzMessage(text);
  return single ? [single] : [];
}

function isPostLink(link) {
  return /t\.me\/c\/\d+\/\d+/i.test(link) || MSG_LINK_RE.test(link);
}

// Ссылка на пост в тексте (без юза) — для "сначала кидают пост".
function parsePostLink(text) {
  if (!text) return null;
  const link = pickPostLink(findLinks(text));
  return link && isPostLink(link) ? link : null;
}

// Сообщение, в котором только юз (без ссылок): "@юз", "юз: имя", "@а & @б"
// или просто "имя".
function parseUsernameOnly(text) {
  if (!text) return null;
  if (findLinks(text).length) return null;
  const found = findUsername(text);
  if (found) return found;
  const bare = text.trim().match(/^@?([a-zA-Z][a-zA-Z0-9_]{4,31})$/);
  return bare && !isBlacklisted(bare[1]) ? bare[1] : null;
}

// Ищет в тексте ссылку на сообщение в публичном чате.
// Нужна для формата "вз? <ссылка на сообщение, где лежит пост и юз>".
// Возвращает { peer, id, link } или null.
function parseMessageLink(text) {
  if (!text) return null;
  for (const link of findLinks(text)) {
    if (NOT_POST_RE.test(link)) continue;
    const m = link.match(MSG_LINK_RE);
    if (!m) continue;
    // t.me/chat/topic/msg — настоящий id сообщения последний
    return { peer: m[1], id: parseInt(m[3] || m[2], 10), link };
  }
  return null;
}

// Текст сообщения + ссылки, спрятанные в "гиперссылках" (entity TextUrl).
// Без этого ссылка в тексте вида «вот пост» не видна парсеру.
function messageToText(msg) {
  if (!msg) return '';
  let text = msg.message || msg.text || '';
  for (const e of msg.entities || []) {
    if (e.className === 'MessageEntityTextUrl' && e.url) text += ' ' + e.url;
  }
  return text;
}

module.exports = {
  parseVzMessage, parseVzMessages, parseStarPairs, parsePostLink, parseUsernameOnly,
  parseMessageLink, messageToText, isBlacklisted, BLACKLISTED_USERNAMES
};
