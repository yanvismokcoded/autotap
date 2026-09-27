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

  async tap(link, username, count) {
    const channels = this.user.channels || [];
    if (!channels.length) throw new Error('У вас не добавлено ни одного канала для тапов (/add_channel)');

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

    const discussion = {
      chatId: utils.getPeerId(discussionMsg.peerId),
      id: discussionMsg.id
    };

    const key = `${entity.id}_${post.id}`;
    const usedBefore = this.user.tapped[key] || [];
    const usedChannels = [];
    const failed = [];

    const peer = await this.client.getInputEntity(discussion.chatId);
    const limit = count && count > 0 ? count : channels.length;

    for (const channelRef of channels) {
      if (usedChannels.length >= limit) break;
      if (usedBefore.includes(channelRef)) continue;

      let channelEntity;
      try {
        channelEntity = await this.client.getEntity(channelRef);
      } catch (e) {
        failed.push(`${channelRef}: ${e.errorMessage || e.message}`);
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
        await sleep(2000 + Math.random() * 3000);
      } catch (e) {
        try {
          await this.client.joinChannel(entity);
          await doSend();
          usedChannels.push(channelRef);
          await sleep(2000 + Math.random() * 3000);
        } catch (e2) {
          failed.push(`${channelRef}: ${e2.errorMessage || e2.message}`);
        }
      }
    }

    if (usedChannels.length > 0) {
      this.user.tapped[key] = [...new Set([...usedBefore, ...usedChannels])];
      this.users.save();
    }

    return { usedChannels, failed, total: usedChannels.length };
  }
}

module.exports = Tapper;
