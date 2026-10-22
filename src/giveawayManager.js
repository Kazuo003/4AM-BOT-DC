const fs = require('fs');
const path = require('path');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const giveawaysFile = path.resolve(__dirname, 'giveaways.json');

/**
 * Đọc danh sách Giveaways từ file
 */
function loadGiveaways() {
  try {
    if (!fs.existsSync(giveawaysFile)) {
      fs.writeFileSync(giveawaysFile, '[]', 'utf8');
      return [];
    }
    const data = JSON.parse(fs.readFileSync(giveawaysFile, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('Lỗi khi đọc giveaways.json:', err);
    return [];
  }
}

/**
 * Lưu danh sách Giveaways vào file
 */
function saveGiveaways(list) {
  try {
    const tempFile = `${giveawaysFile}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tempFile, giveawaysFile);
  } catch (err) {
    console.error('Lỗi khi lưu giveaways.json:', err);
  }
}

/**
 * Parse chuỗi thời gian thành mili-giây (VD: 10s, 15m, 2h, 1d, 1h30m)
 */
function parseDuration(input) {
  if (!input) return null;
  const str = String(input).trim().toLowerCase();
  const regex = /(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hours?|d|days?|w|weeks?)/g;
  let totalMs = 0;
  let match;
  let found = false;

  while ((match = regex.exec(str)) !== null) {
    found = true;
    const val = parseInt(match[1], 10);
    const unit = match[2];
    if (unit.startsWith('s')) totalMs += val * 1000;
    else if (unit.startsWith('m')) totalMs += val * 60 * 1000;
    else if (unit.startsWith('h')) totalMs += val * 3600 * 1000;
    else if (unit.startsWith('d')) totalMs += val * 86400 * 1000;
    else if (unit.startsWith('w')) totalMs += val * 604800 * 1000;
  }

  if (!found) {
    const num = parseInt(str, 10);
    if (!isNaN(num) && num > 0) return num * 60 * 1000; // Mặc định là phút
    return null;
  }
  return totalMs > 0 ? totalMs : null;
}

/**
 * Tạo Embed hiển thị Giveaway đang hoạt động
 */
function buildActiveGiveawayEmbed(giveaway) {
  const endsTimestamp = Math.floor(giveaway.endsAt / 1000);
  const participantsCount = (giveaway.participants || []).length;

  const desc = [
    `🎁 **Phần thưởng:** **${giveaway.prize}**`,
    `🏆 **Số người trúng giải:** **${giveaway.winnersCount} người**`,
    `👑 **Người tổ chức:** <@${giveaway.hostId}>`,
    `⏳ **Thời gian kết thúc:** <t:${endsTimestamp}:R> (<t:${endsTimestamp}:f>)`,
    `👥 **Số người tham gia:** **${participantsCount}**`
  ];

  if (giveaway.description) {
    desc.push('', `📝 **Ghi chú/Điều kiện:** ${giveaway.description}`);
  }

  desc.push('', '⚡ *Nhấn nút **[ 🎉 Tham gia ]** bên dưới để có cơ hội nhận quà!*');

  return new EmbedBuilder()
    .setTitle(`🎉 GIVEAWAY: ${giveaway.prize.toUpperCase()} 🎉`)
    .setDescription(desc.join('\n'))
    .setColor(0x5865F2)
    .setThumbnail('https://cdn.discordapp.com/emojis/1283685258925895741.gif')
    .setFooter({ text: '4AM SHOP • Chúc bạn may mắn!' })
    .setTimestamp(new Date(giveaway.endsAt));
}

/**
 * Tạo Nút bấm tham gia Giveaway
 */
function buildGiveawayActionRow(giveaway, isEnded = false) {
  const count = (giveaway.participants || []).length;
  const button = new ButtonBuilder()
    .setCustomId(isEnded ? `giveaway_ended|${giveaway.messageId}` : `giveaway_join|${giveaway.messageId}`)
    .setLabel(isEnded ? `🎉 Đã kết thúc (${count})` : `🎉 Tham gia (${count})`)
    .setStyle(isEnded ? ButtonStyle.Secondary : ButtonStyle.Primary)
    .setDisabled(isEnded);

  return new ActionRowBuilder().addComponents(button);
}

/**
 * Tạo Embed hiển thị Giveaway đã kết thúc
 */
function buildEndedGiveawayEmbed(giveaway) {
  const winnersList = (giveaway.winners && giveaway.winners.length > 0)
    ? giveaway.winners.map(id => `<@${id}>`).join(', ')
    : '*Không có người tham gia hợp lệ*';

  const desc = [
    `🎁 **Phần thưởng:** **${giveaway.prize}**`,
    `👑 **Người tổ chức:** <@${giveaway.hostId}>`,
    `🏆 **Người chiến thắng:** ${winnersList}`,
    `👥 **Tổng số người tham gia:** **${(giveaway.participants || []).length}**`
  ];

  if (giveaway.description) {
    desc.push('', `📝 **Ghi chú:** ${giveaway.description}`);
  }

  return new EmbedBuilder()
    .setTitle(`🎉 GIVEAWAY ĐÃ KẾT THÚC 🎉`)
    .setDescription(desc.join('\n'))
    .setColor(0x2F3136)
    .setFooter({ text: '4AM SHOP • Giveaway đã khép lại!' })
    .setTimestamp(new Date());
}

/**
 * Thêm Giveaway mới vào danh sách
 */
function registerGiveaway({ messageId, channelId, guildId, hostId, prize, description, durationMs, winnersCount }) {
  const list = loadGiveaways();
  const now = Date.now();
  const endsAt = now + durationMs;

  const giveaway = {
    messageId,
    channelId,
    guildId,
    hostId,
    prize,
    description: description || '',
    durationMs,
    createdAt: now,
    endsAt,
    winnersCount: winnersCount || 1,
    participants: [],
    winners: [],
    ended: false
  };

  list.push(giveaway);
  saveGiveaways(list);
  return giveaway;
}

/**
 * Lấy thông tin Giveaway theo Message ID
 */
function getGiveaway(messageId) {
  const list = loadGiveaways();
  return list.find(g => g.messageId === messageId);
}

/**
 * Xử lý tham gia hoặc hủy tham gia Giveaway (tích hợp cơ chế tự phục hồi Self-Healing từ Discord Message)
 */
function toggleJoinGiveaway(messageId, userId, message = null) {
  const list = loadGiveaways();
  let g = list.find(x => x.messageId === messageId);

  // Cơ chế Tự Phục Hồi (Self-Healing): Nếu file JSON trên server bị thiếu giveaway này
  // (do tạo từ script ngoài hoặc file bị desync), tự động tái tạo object từ Embed của tin nhắn!
  if (!g && message && message.embeds && message.embeds.length > 0) {
    try {
      const embed = message.embeds[0];
      let prize = 'Giveaway';
      if (embed.title) {
        const titleMatch = embed.title.match(/GIVEAWAY:\s*(.*?)(?:\s*🎉|$)/i);
        if (titleMatch) prize = titleMatch[1].trim();
      }

      let hostId = message.guild?.ownerId || '895890393806274570';
      if (embed.description) {
        const hostMatch = embed.description.match(/👑 \*\*Người tổ chức:\*\* <@(\d+)>/);
        if (hostMatch) hostId = hostMatch[1];
      }

      let description = '';
      if (embed.description) {
        const descMatch = embed.description.match(/📝 \*\*Ghi chú\/Điều kiện:\*\* (.*)/);
        if (descMatch) description = descMatch[1].trim();
      }

      let winnersCount = 1;
      if (embed.description) {
        const winMatch = embed.description.match(/🏆 \*\*Số người trúng:\*\* \*\*(\d+)\*\*/);
        if (winMatch) winnersCount = parseInt(winMatch[1], 10) || 1;
      }

      const endsAt = embed.timestamp ? new Date(embed.timestamp).getTime() : (Date.now() + 86400000);
      const now = Date.now();

      g = {
        messageId,
        channelId: message.channelId,
        guildId: message.guildId,
        hostId,
        prize,
        description,
        durationMs: Math.max(0, endsAt - now),
        createdAt: now,
        endsAt,
        winnersCount,
        participants: [],
        winners: [],
        ended: endsAt <= now
      };

      list.push(g);
      saveGiveaways(list);
      console.log(`[Giveaway] Self-healed giveaway ${messageId} (${prize}) successfully.`);
    } catch (healErr) {
      console.error('[Giveaway] Failed to self-heal giveaway:', healErr);
    }
  }

  if (!g) return { ok: false, error: 'Không tìm thấy giveaway này.' };
  if (g.ended) return { ok: false, error: 'Giveaway này đã kết thúc!' };

  if (!Array.isArray(g.participants)) g.participants = [];
  const idx = g.participants.indexOf(userId);
  let joined = false;

  if (idx >= 0) {
    g.participants.splice(idx, 1);
    joined = false;
  } else {
    g.participants.push(userId);
    joined = true;
  }

  saveGiveaways(list);
  return { ok: true, joined, count: g.participants.length, giveaway: g };
}

/**
 * Bốc thăm và kết thúc Giveaway
 */
async function endGiveaway(client, messageId, manual = false) {
  const list = loadGiveaways();
  const g = list.find(x => x.messageId === messageId);
  if (!g || g.ended) return null;

  g.ended = true;

  // Thuật toán bốc thăm ngẫu nhiên công bằng
  const participants = [...(g.participants || [])];
  const winners = [];
  const neededWinners = Math.min(g.winnersCount || 1, participants.length);

  for (let i = 0; i < neededWinners; i++) {
    const randIdx = Math.floor(Math.random() * participants.length);
    winners.push(participants[randIdx]);
    participants.splice(randIdx, 1);
  }

  g.winners = winners;
  saveGiveaways(list);

  // Cập nhật tin nhắn Giveaway trên Discord
  try {
    const channel = await client.channels.fetch(g.channelId).catch(() => null);
    if (channel) {
      const msg = await channel.messages.fetch(g.messageId).catch(() => null);
      if (msg) {
        const endedEmbed = buildEndedGiveawayEmbed(g);
        const endedRow = buildGiveawayActionRow(g, true);
        await msg.edit({ embeds: [endedEmbed], components: [endedRow] }).catch(() => {});

        // Gửi thông báo chúc mừng
        if (winners.length > 0) {
          const mentions = winners.map(id => `<@${id}>`).join(' ');
          await channel.send({
            content: `🎊 **CHÚC MỪNG CHIẾN THẮNG!** 🎊\nChúc mừng ${mentions} đã may mắn trúng giải **${g.prize}** tổ chức bởi <@${g.hostId}>!\n👉 Hãy nhắn tin cho người tổ chức hoặc mở Ticket Staff để nhận thưởng nhé!`,
            reply: { messageReference: g.messageId }
          }).catch(() => {});
        } else {
          await channel.send({
            content: `📢 Giveaway **${g.prize}** đã kết thúc nhưng không có người tham gia hợp lệ!`,
            reply: { messageReference: g.messageId }
          }).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error('Lỗi khi gửi kết quả giveaway trên Discord:', err);
  }

  return g;
}

/**
 * Bốc thăm lại người trúng thưởng (Reroll)
 */
async function rerollGiveaway(client, messageId, rerollCount = 1) {
  const list = loadGiveaways();
  const g = list.find(x => x.messageId === messageId);
  if (!g) return { ok: false, error: 'Không tìm thấy giveaway này.' };
  if (!g.ended) return { ok: false, error: 'Giveaway chưa kết thúc, không thể reroll!' };

  const pool = (g.participants || []).filter(id => !(g.winners || []).includes(id));
  if (pool.length === 0) {
    return { ok: false, error: 'Không còn người tham gia nào khác trong danh sách để reroll!' };
  }

  const newWinners = [];
  const needed = Math.min(rerollCount, pool.length);
  for (let i = 0; i < needed; i++) {
    const randIdx = Math.floor(Math.random() * pool.length);
    newWinners.push(pool[randIdx]);
    pool.splice(randIdx, 1);
  }

  g.winners = [...(g.winners || []), ...newWinners];
  saveGiveaways(list);

  try {
    const channel = await client.channels.fetch(g.channelId).catch(() => null);
    if (channel) {
      const mentions = newWinners.map(id => `<@${id}>`).join(' ');
      await channel.send({
        content: `🎉 **REROLL GIVEAWAY THÀNH CÔNG!** 🎉\nNgười chiến thắng mới cho giải **${g.prize}** là: ${mentions}!\n👉 Hãy liên hệ Staff để nhận quà nhé!`,
        reply: { messageReference: g.messageId }
      }).catch(() => {});

      // Update lại embed gốc
      const msg = await channel.messages.fetch(g.messageId).catch(() => null);
      if (msg) {
        const endedEmbed = buildEndedGiveawayEmbed(g);
        const endedRow = buildGiveawayActionRow(g, true);
        await msg.edit({ embeds: [endedEmbed], components: [endedRow] }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('Lỗi khi reroll giveaway:', err);
  }

  return { ok: true, newWinners };
}

/**
 * Khởi động scheduler quét giveaway hết hạn định kỳ
 */
function initGiveawayScheduler(client) {
  setInterval(async () => {
    try {
      const list = loadGiveaways();
      const now = Date.now();
      const toEnd = list.filter(g => !g.ended && g.endsAt <= now);

      for (const g of toEnd) {
        await endGiveaway(client, g.messageId);
      }
    } catch (err) {
      console.error('Lỗi trong Giveaway Scheduler:', err);
    }
  }, 15000); // Quét mỗi 15 giây
}

module.exports = {
  loadGiveaways,
  saveGiveaways,
  parseDuration,
  buildActiveGiveawayEmbed,
  buildGiveawayActionRow,
  buildEndedGiveawayEmbed,
  registerGiveaway,
  getGiveaway,
  toggleJoinGiveaway,
  endGiveaway,
  rerollGiveaway,
  initGiveawayScheduler
};
