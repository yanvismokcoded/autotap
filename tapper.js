const { Api, utils } = require('telegram');
const bigInt = require('big-integer');

function randomId() {
  return bigInt(Date.now()).shiftLeft(20).add(bigInt(Math.floor(Math.random() * 0xfffff)));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Тапает каналами КОНКРЕТНОГО пользователя. Никаких общих списков.
class Tapper {
  constructor(client, user, users) {
    this.client = client;
    this.user = user;
    this.users = users;
  }

  async resolveLink(link) {
    const cMatch = link.match(/t\.me\/c\/(\d+)\/(\d+)/);
    if (cMatch) {
      const chatId = bigInt('-100' + cMatch[1]).toString();
      const postId = parseInt(cMatch[2], 10);
      const entity = await this.client.getEntity(chatId);
      return { entity, postId };
    }

    const uMatch = link.match(/t\.me\/([a-zA-Z0-9_]+)(?:\/(\d+))?/);
    if (uMatch) {
      const username = uMatch[1];
      const postId = uMatch[2] ? parseInt(uMatch[2], 10) : null;
      const entity = await this.client.getEntity(username);
      return { entity, postId };
    }

    throw new Error('Не удалось распознать ссылку');
  }

  // Лёгкая проверка "уже тапали этот пост", без похода за сообщением —
  // используется ДО того, как бот вообще вступит в переписку по ссылке.
  async alreadyTapped(link) {
    const cMatch = link.match(/t\.me\/c\/(\d+)\/(\d+)/);
    const uMatch = !cMatch && link.match(/t\.me\/([a-zA-Z0-9_]+)\/(\d+)/);
    if (!cMatch && !uMatch) return false; // ссылка без номера поста — решить не можем, пропускаем как новую

    let entity;
    try {
      if (cMatch) {
        entity = await this.client.getEntity(bigInt('-100' + cMatch[1]).toString());
      } else {
        entity = await this.client.getEntity(uMatch[1]);
      }
    } catch {
      return false; // не смогли проверить — не блокируем
    }

    const postId = parseInt((cMatch ? cMatch[2] : uMatch[2]), 10);
    const key = `${entity.id}_${postId}`;
    const used = this.user.tapped[key];
    return !!(used && used.length > 0);
  }

  // Пост + его сообщение-корень в чате обсуждения (туда пишутся "голоса").
  async _locate(link) {
    const { entity, postId } = await this.resolveLink(link);

    let post;
    if (postId) {
      const msgs = await this.client.getMessages(entity, { ids: [postId] });
      post = msgs[0];
    } else {
      const msgs = await this.client.getMessages(entity, { limit: 1 });
      post = msgs[0];
    }
    if (!post) throw new Error('Пост не найден');

    const discussionResult = await this.client.invoke(new Api.messages.GetDiscussionMessage({
      peer: entity,
      msgId: post.id
    }));
    const discussionMsg = discussionResult.messages && discussionResult.messages[0];
    if (!discussionMsg) throw new Error('Обсуждение не найдено');

    return {
      entity,
      post,
      discussion: {
        chatId: utils.getPeerId(discussionMsg.peerId),
        id: discussionMsg.id
      }
    };
  }

  // Сверка "то ли это голосование": ищем под постом комментарии "@юз".
  // Если уже есть хоть один голос за этого юза — пост тот. Смотрим последние
  // scanLimit комментариев. Для пары "юз1 & @юз2" достаточно любого из двух.
  // Возвращает { found, scanned }.
  async checkVotes(link, username, scanLimit = 300) {
    const { discussion } = await this._locate(link);
    const peer = await this.client.getInputEntity(discussion.chatId);

    const names = (String(username).match(/[a-zA-Z0-9_]{5,}/g) || []).map((n) => n.toLowerCase());
    if (!names.length) return { found: 0, scanned: 0 };
    const res = names.map((n) => new RegExp('(^|[^a-z0-9_])@' + n + '(?![a-z0-9_])'));

    const comments = await this.client.getMessages(peer, { replyTo: discussion.id, limit: scanLimit });
    let found = 0;
    let scanned = 0;
    for (const m of comments) {
      scanned++;
      const text = String(m.message || m.text || '').toLowerCase();
      if (text && res.some((re) => re.test(text))) found++;
    }
    return { found, scanned };
  }

  // opts.onProgress({ done, total, failed }) — после каждого успешного тапа
  //   (и один раз в начале с done = 0), чтобы показывать прогресс в реальном времени;
  // opts.isCancelled() — true => остановиться после текущего канала.
  // Возвращает { usedChannels, failed, total, planned, cancelled }.
  async tap(link, username, count, opts = {}) {
    const channels = this.user.channels || [];
    if (!channels.length) throw new Error('У вас не добавлено ни одного канала для тапов (/add_channel)');

    const { entity, post, discussion } = await this._locate(link);

    const key = `${entity.id}_${post.id}`;
    const usedBefore = this.user.tapped[key] || [];
    const usedChannels = [];
    const failed = [];

    const peer = await this.client.getInputEntity(discussion.chatId);
    const limit = count && count > 0 ? count : channels.length;
    const available = channels.filter((c) => !usedBefore.includes(c)).length;
    const planned = Math.min(limit, available);

    const progress = () => {
      if (!opts.onProgress) return;
      try {
        opts.onProgress({ done: usedChannels.length, total: planned, failed: failed.length });
      } catch (e) {
        console.log('onProgress error', e.message);
      }
    };
    const cancelled = () => !!(opts.isCancelled && opts.isCancelled());

    progress();

    try {
      for (const channelRef of channels) {
        if (usedChannels.length >= limit) break;
        if (cancelled()) break;
        if (usedBefore.includes(channelRef)) continue;

        let channelEntity;
        try {
          channelEntity = await this.client.getEntity(channelRef);
        } catch (e) {
          failed.push(`${channelRef}: ${e.errorMessage || e.message}`);
          progress();
          continue;
        }

        const doSend = async () => {
          const sendAsPeer = await this.client.getInputEntity(channelEntity);
          await this.client.invoke(new Api.messages.SendMessage({
            peer,
            message: '@' + username,
            randomId: randomId(),
            replyTo: new Api.InputReplyToMessage({ replyToMsgId: discussion.id }),
            sendAs: sendAsPeer
          }));
        };

        try {
          await doSend();
          usedChannels.push(channelRef);
          progress();
          await sleep(2000 + Math.random() * 3000);
        } catch (e) {
          try {
            await this.client.joinChannel(entity);
            await doSend();
            usedChannels.push(channelRef);
            progress();
            await sleep(2000 + Math.random() * 3000);
          } catch (e2) {
            failed.push(`${channelRef}: ${e2.errorMessage || e2.message}`);
            progress();
          }
        }
      }
    } finally {
      // записываем уже сделанные тапы, даже если цикл оборвался ошибкой или /cancel
      if (usedChannels.length > 0) {
        this.user.tapped[key] = [...new Set([...usedBefore, ...usedChannels])];
        this.users.save();
      }
    }

    return { usedChannels, failed, total: usedChannels.length, planned, cancelled: cancelled() };
  }
}

module.exports = Tapper;
