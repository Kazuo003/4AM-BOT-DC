const fs = require('fs');
const path = require('path');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// Thư mục dữ liệu vĩnh viễn (nằm ngoài phạm vi Git để không bao giờ bị ghi đè khi update)
const dataDir = path.resolve(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) {}
}

const persistentGiveawaysFile = path.resolve(dataDir, 'giveaways.json');
const backupGiveawaysFile = path.resolve(dataDir, 'giveaways.bak.json');
const legacyGiveawaysFile = path.resolve(__dirname, 'giveaways.json');

const DAILY_GIVEAWAY_CHANNEL_ID = process.env.DAILY_GIVEAWAY_CHANNEL_ID || '1563227100293365981';
const GIVEAWAYS_ROLE_ID = '1428223579316687029';
let isStartingDaily = false;


/**
 * Đọc danh sách Giveaways từ file (Ưu tiên data/giveaways.json vĩnh viễn)
 */
function loadGiveaways() {
  try {
    // 1. Kiểm tra file vĩnh viễn trong data/
    if (fs.existsSync(persistentGiveawaysFile)) {
      const raw = fs.readFileSync(persistentGiveawaysFile, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data) && data.length > 0) return data;
    }

    // 2. Kiểm tra bản sao lưu backup trong data/
    if (fs.existsSync(backupGiveawaysFile)) {
      const raw = fs.readFileSync(backupGiveawaysFile, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data) && data.length > 0) return data;
    }

    // 3. Fallback: Di chuyển dữ liệu từ src/giveaways.json sang data/
    if (fs.existsSync(legacyGiveawaysFile)) {
      const raw = fs.readFileSync(legacyGiveawaysFile, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        saveGiveaways(data);
        return data;
      }
    }

    saveGiveaways([]);
    return [];
  } catch (err) {
    console.error('Lỗi khi đọc giveaways.json:', err);
    return [];
  }
}

/**
 * Lưu danh sách Giveaways vào file (Đồng thời lưu cả file chính, backup và legacy)
 */
function saveGiveaways(list) {
  try {
    if (!Array.isArray(list)) list = [];
    const content = JSON.stringify(list, null, 2);

    // Lưu vào data/giveaways.json
    const tempFile = `${persistentGiveawaysFile}.tmp`;
    fs.writeFileSync(tempFile, content, 'utf8');
    fs.renameSync(tempFile, persistentGiveawaysFile);

    // Lưu bản sao lưu backup data/giveaways.bak.json
    fs.writeFileSync(backupGiveawaysFile, content, 'utf8');

    // Đồng bộ vào legacy src/giveaways.json để tương thích
    try {
      fs.writeFileSync(legacyGiveawaysFile, content, 'utf8');
    } catch (_) {}
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
 * Lọc sạch tên phần thưởng, loại bỏ ngoặc dư thừa như (1M Cow), (500k)
 */
function cleanPrizeText(prize) {
  if (!prize) return '';
  return String(prize).replace(/\s*\([^)]*\)/g, '').trim();
}

/**
 * Tạo Embed hiển thị Giveaway đang hoạt động (Chuẩn Mẫu 2: Quote Block, không in đậm nhãn, không thừa ngoặc)
 */
function buildActiveGiveawayEmbed(giveaway) {
  const endsTimestamp = Math.floor(giveaway.endsAt / 1000);
  const participantsCount = (giveaway.participants || []).length;
  const cleanPrize = cleanPrizeText(giveaway.prize);
  const isDaily = !!giveaway.isDaily;

  const quoteLines = [
    `> 👑 Tổ chức: <@${giveaway.hostId}>`,
    `> 🏆 Số lượng: ${giveaway.winnersCount || 1} giải`,
    `> ⌛ Kết thúc: <t:${endsTimestamp}:R>`,
    `> 👥 Tham gia: ${participantsCount}`
  ];

  let reqBlock = '';
  if (isDaily) {
    reqBlock = [
      '',
      '📌 Yêu cầu bắt buộc:',
      '• Treo bio: `owo giá rẻ tại: https://discord.gg/fouram`',
      '• Chưa treo bio khi chốt giải sẽ bị reroll.'
    ].join('\n');
  } else if (giveaway.description) {
    reqBlock = [
      '',
      '📌 Yêu cầu bắt buộc:',
      `• ${giveaway.description}`
    ].join('\n');
  }

  const desc = quoteLines.join('\n') + (reqBlock ? '\n' + reqBlock : '');
  const title = isDaily
    ? `🎁 DAILY GIVEAWAY — ${cleanPrize.toUpperCase()}`
    : `🎁 GIVEAWAY — ${cleanPrize.toUpperCase()}`;

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(desc)
    .setColor(0x5865F2)
    .setFooter({ text: '4AM SHOP' })
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
 * Tạo Embed hiển thị Giveaway đã kết thúc (Chuẩn Mẫu 2)
 */
function buildEndedGiveawayEmbed(giveaway) {
  const winnersList = (giveaway.winners && giveaway.winners.length > 0)
    ? giveaway.winners.map(id => `<@${id}>`).join(', ')
    : '*Không có người tham gia hợp lệ*';
  const cleanPrize = cleanPrizeText(giveaway.prize);
  const isDaily = !!giveaway.isDaily;

  const quoteLines = [
    `> 👑 Tổ chức: <@${giveaway.hostId}>`,
    `> 🏆 Người chiến thắng: ${winnersList}`,
    `> 👥 Tham gia: ${(giveaway.participants || []).length}`
  ];

  let noteBlock = '';
  if (isDaily) {
    noteBlock = [
      '',
      '📌 Lưu ý:',
      '• Staff sẽ kiểm tra bio trước khi trao giải.',
      '• Nếu hợp lệ, hãy mở Ticket Staff để nhận quà nhé!'
    ].join('\n');
  } else if (giveaway.description) {
    noteBlock = [
      '',
      '📌 Ghi chú:',
      `• ${giveaway.description}`
    ].join('\n');
  }

  const desc = quoteLines.join('\n') + (noteBlock ? '\n' + noteBlock : '');
  const title = isDaily
    ? `🎉 DAILY GIVEAWAY ĐÃ KẾT THÚC — ${cleanPrize.toUpperCase()}`
    : `🎉 GIVEAWAY ĐÃ KẾT THÚC — ${cleanPrize.toUpperCase()}`;

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(desc)
    .setColor(0x2F3136)
    .setFooter({ text: '4AM SHOP • Giveaway đã kết thúc' })
    .setTimestamp(new Date());
}

/**
 * Thêm Giveaway mới vào danh sách
 */
function registerGiveaway({ messageId, channelId, guildId, hostId, prize, description, durationMs, winnersCount, isDaily = false }) {
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
    ended: false,
    isDaily: !!isDaily
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
        const titleMatch = embed.title.match(/(?:GIVEAWAY(?:\s*—|\s*:)?\s*)(.*?)(?:\s*🎉|$)/i);
        if (titleMatch) prize = cleanPrizeText(titleMatch[1]);
      }

      let hostId = message.guild?.ownerId || '895890393806274570';
      if (embed.description) {
        const hostMatch = embed.description.match(/👑 (?:\*\*Người tổ chức:\*\*|Tổ chức:)\s*<@(\d+)>/);
        if (hostMatch) hostId = hostMatch[1];
      }

      let description = '';
      if (embed.description) {
        const descMatch = embed.description.match(/(?:📝 \*\*Ghi chú\/Điều kiện:\*\*|📌 Yêu cầu bắt buộc:\s*•\s*)(.*)/);
        if (descMatch) description = descMatch[1].trim();
      }

      let winnersCount = 1;
      if (embed.description) {
        const winMatch = embed.description.match(/🏆 (?:\*\*Số người trúng:\*\* \*\*|Số lượng:\s*)(\d+)/);
        if (winMatch) winnersCount = parseInt(winMatch[1], 10) || 1;
      }

      const endsAt = embed.timestamp ? new Date(embed.timestamp).getTime() : (Date.now() + 86400000);
      const now = Date.now();
      const isDaily = message.channelId === DAILY_GIVEAWAY_CHANNEL_ID || (embed.title && /DAILY/i.test(embed.title));

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
        ended: endsAt <= now,
        isDaily: !!isDaily
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
        // Gửi thông báo chúc mừng
        if (winners.length > 0) {
          const mentions = winners.map(id => `<@${id}>`).join(' ');
          const cleanPrize = cleanPrizeText(g.prize);
          if (g.isDaily) {
            const winMsg = await channel.send({
              content: `🎊 **CHÚC MỪNG CHIẾN THẮNG DAILY GIVEAWAY!** 🎊\nChúc mừng ${mentions} đã may mắn trúng giải **${cleanPrize}**!\n👉 **Lưu ý:** Staff sẽ kiểm tra bio (\`owo giá rẻ tại: https://discord.gg/fouram\`) trước khi trao giải.\nNếu hợp lệ, hãy mở Ticket Staff để nhận quà nhé! 🎁`,
              flags: [4096] // MessageFlags.SuppressEmbeds: không bung widget invite to đùng
            }).catch(() => null);

            if (winMsg) {
              g.winnerMessageId = winMsg.id;
              saveGiveaways(list);
            }
          } else {
            await channel.send({
              content: `🎊 **CHÚC MỪNG CHIẾN THẮNG!** 🎊\nChúc mừng ${mentions} đã may mắn trúng giải **${cleanPrize}** tổ chức bởi <@${g.hostId}>!\n👉 Hãy nhắn tin cho người tổ chức hoặc mở Ticket Staff để nhận thưởng nhé!`,
              reply: { messageReference: g.messageId },
              flags: [4096]
            }).catch(() => {});
          }

          if (g.isDaily) {
            setTimeout(async () => {
              try {
                console.log('[Daily Giveaway] Đang tự động bắt đầu đợt mới cho ngày tiếp theo...');
                await startDailyGiveaway(client, g.channelId, {
                  prize: cleanPrize,
                  description: g.description,
                  winnersCount: g.winnersCount,
                  hostId: g.hostId
                });
              } catch (dErr) {
                console.error('[Daily Giveaway] Lỗi tự động tạo đợt mới:', dErr);
              }
            }, 10000);
          }
        } else {
          const cleanPrize = cleanPrizeText(g.prize);
          await channel.send({
            content: `📢 Giveaway **${cleanPrize}** đã kết thúc nhưng không có người tham gia hợp lệ!`,
            reply: { messageReference: g.messageId },
            flags: [4096]
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
      const cleanPrize = cleanPrizeText(g.prize);
      const mentions = newWinners.map(id => `<@${id}>`).join(' ');
      await channel.send({
        content: `🎉 **REROLL GIVEAWAY THÀNH CÔNG!** 🎉\nNgười chiến thắng mới cho giải **${cleanPrize}** là: ${mentions}!\n👉 Hãy liên hệ Staff để nhận quà nhé!`,
        reply: { messageReference: g.messageId },
        flags: [4096]
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
 * Dọn dẹp các tin nhắn cũ trong kênh Daily Giveaway để giữ kênh luôn sạch sẽ, không bị biến thành bãi rác
 * Hỗ trợ truyền 1 ID hoặc 1 mảng IDs cần giữ lại (VD: Tin người trúng hôm trước + Embed hôm nay)
 */
async function cleanOldDailyGiveaways(channel, preserveIds = []) {
  let totalDeleted = 0;
  try {
    if (!channel || !channel.isTextBased()) return 0;
    const preserveSet = new Set(Array.isArray(preserveIds) ? preserveIds : [preserveIds].filter(Boolean));

    const fetched = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!fetched || fetched.size === 0) return 0;

    const toDelete = fetched.filter(m => {
      if (preserveSet.has(m.id)) return false;
      if (m.pinned) return false;
      return true;
    });

    if (toDelete.size > 0) {
      totalDeleted = toDelete.size;
      if (toDelete.size === 1) {
        await toDelete.first().delete().catch(() => {});
      } else {
        const deleted = await channel.bulkDelete(toDelete, true).catch(() => null);
        if (!deleted || deleted.size < toDelete.size) {
          const remaining = toDelete.filter(m => !deleted || !deleted.has(m.id));
          for (const msg of remaining.values()) {
            await msg.delete().catch(() => {});
          }
        }
      }
    }
  } catch (err) {
    console.error('[Giveaway Clean] Lỗi khi dọn dẹp kênh:', err);
  }
  return totalDeleted;
}

/**
 * Tự động tạo một đợt Daily Giveaway 1M Cow kéo dài 24 tiếng
 * Giữ lại hoặc khôi phục thông báo người chiến thắng hôm trước trên đầu kênh
 */
async function startDailyGiveaway(client, channelId = DAILY_GIVEAWAY_CHANNEL_ID, customConfig = {}) {
  if (isStartingDaily) return null;
  isStartingDaily = true;
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      console.warn('[Daily Giveaway] Không tìm thấy kênh:', channelId);
      return null;
    }

    const list = loadGiveaways();
    const lastEndedDaily = list
      .filter(x => x.isDaily && x.ended && x.channelId === channelId && x.winners && x.winners.length > 0)
      .sort((a, b) => (b.endsAt || b.createdAt) - (a.endsAt || a.createdAt))[0];

    const preserveIds = [];

    // Kiểm tra xem tin nhắn thông báo người thắng của đợt vừa rồi còn tồn tại trong kênh không
    let winnerMsgFound = false;
    if (lastEndedDaily && lastEndedDaily.winnerMessageId) {
      const existingWinMsg = await channel.messages.fetch(lastEndedDaily.winnerMessageId).catch(() => null);
      if (existingWinMsg) {
        winnerMsgFound = true;
        preserveIds.push(lastEndedDaily.winnerMessageId);
      }
    }

    // Tự động dọn dẹp các tin nhắn cũ và tin nhắn rác, giữ lại thông báo người trúng gần nhất
    await cleanOldDailyGiveaways(channel, preserveIds);

    // Nếu tin người thắng đợt vừa rồi bị mất (hoặc đã bị xóa trước đó), tự động gửi lại lên đầu kênh
    if (lastEndedDaily && !winnerMsgFound && lastEndedDaily.winners && lastEndedDaily.winners.length > 0) {
      const mentions = lastEndedDaily.winners.map(id => `<@${id}>`).join(' ');
      const cleanPrize = cleanPrizeText(lastEndedDaily.prize);
      const reWinMsg = await channel.send({
        content: `🎊 **CHÚC MỪNG CHIẾN THẮNG DAILY GIVEAWAY HÔM TRƯỚC!** 🎊\nChúc mừng ${mentions} đã may mắn trúng giải **${cleanPrize}**!\n👉 **Lưu ý:** Staff sẽ kiểm tra bio (\`owo giá rẻ tại: https://discord.gg/fouram\`) trước khi trao giải.\nNếu hợp lệ, hãy mở Ticket Staff để nhận quà nhé! 🎁`,
        flags: [4096] // SuppressEmbeds
      }).catch(() => null);

      if (reWinMsg) {
        lastEndedDaily.winnerMessageId = reWinMsg.id;
        saveGiveaways(list);
      }
    }

    const guild = channel.guild;
    const hostId = customConfig.hostId || guild.ownerId || '895890393806274570';
    const durationMs = customConfig.durationMs || 24 * 60 * 60 * 1000; // 24 giờ
    const endsAt = Date.now() + durationMs;
    const prize = customConfig.prize ? cleanPrizeText(customConfig.prize) : '1.000.000 Cow';
    const description = customConfig.description || '';
    const winnersCount = customConfig.winnersCount || 1;

    const dummy = {
      messageId: 'temp',
      channelId,
      guildId: guild.id,
      hostId,
      prize,
      description,
      durationMs,
      endsAt,
      winnersCount,
      participants: [],
      isDaily: true
    };

    const embed = buildActiveGiveawayEmbed(dummy);
    let row = buildGiveawayActionRow(dummy, false);

    const msg = await channel.send({
      content: `🎉 **DAILY GIVEAWAY 1.000.000 COW MỖI NGÀY ĐÃ BẮT ĐẦU!** 🎉 <@&${GIVEAWAYS_ROLE_ID}>`,
      embeds: [embed],
      components: [row],
      allowedMentions: { roles: [GIVEAWAYS_ROLE_ID] }
    });

    dummy.messageId = msg.id;
    row = buildGiveawayActionRow(dummy, false);
    await msg.edit({ components: [row] }).catch(() => {});

    const registered = registerGiveaway({
      messageId: msg.id,
      channelId,
      guildId: guild.id,
      hostId,
      prize,
      description,
      durationMs,
      winnersCount,
      isDaily: true
    });

    console.log(`[Daily Giveaway] Đã tạo thành công Giveaway hàng ngày: ${msg.id}`);
    return registered;
  } catch (err) {
    console.error('[Daily Giveaway] Lỗi khi tạo:', err);
    return null;
  } finally {
    isStartingDaily = false;
  }
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

      // Tự động kiểm tra: Nếu kênh Daily Giveaway chưa có đợt nào đang chạy thì khởi động
      if (client.isReady()) {
        const hasActiveDaily = list.some(x => !x.ended && x.channelId === DAILY_GIVEAWAY_CHANNEL_ID && x.endsAt > now);
        if (!hasActiveDaily) {
          console.log('[Daily Giveaway Scheduler] Chưa có đợt Daily Giveaway nào đang chạy -> Tự động khởi tạo...');
          await startDailyGiveaway(client, DAILY_GIVEAWAY_CHANNEL_ID);
        }
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
  cleanPrizeText,
  cleanOldDailyGiveaways,
  buildActiveGiveawayEmbed,
  buildGiveawayActionRow,
  buildEndedGiveawayEmbed,
  registerGiveaway,
  getGiveaway,
  toggleJoinGiveaway,
  endGiveaway,
  rerollGiveaway,
  initGiveawayScheduler,
  startDailyGiveaway
};
