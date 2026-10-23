require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const {
  buildActiveGiveawayEmbed,
  buildGiveawayActionRow,
  registerGiveaway
} = require('../src/giveawayManager');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const DAILY_CHANNEL_ID = '1563227100293365981'; // 『🎁』giveaway-daily
const GIVEAWAYS_ROLE_ID = '1428223579316687029'; // @Giveaways

client.on('ready', async () => {
  try {
    const channel = await client.channels.fetch(DAILY_CHANNEL_ID);
    if (!channel) throw new Error(`Không tìm thấy kênh giveaway-daily (${DAILY_CHANNEL_ID})`);

    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const hostId = guild.ownerId || '895890393806274570';
    const durationMs = 24 * 60 * 60 * 1000; // 24 giờ (Daily)
    const endsAt = Date.now() + durationMs;
    const prize = '1.000.000 Cow (1M Cow)';
    const description = 'Treo bio: "owo giá rẻ tại: discord.gg/fouram" (Lưu ý: Khi trúng giải Staff sẽ check bio, nếu không có sẽ Reroll người khác!)';
    const winnersCount = 1;

    const dummy = {
      messageId: 'temp',
      channelId: DAILY_CHANNEL_ID,
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
      channelId: DAILY_CHANNEL_ID,
      guildId: guild.id,
      hostId,
      prize,
      description,
      durationMs,
      winnersCount,
      isDaily: true
    });

    console.log(`✅ SUCCESS! Đã tạo Daily Giveaway thành công với messageId: ${msg.id}`);
  } catch (err) {
    console.error('Lỗi khi tạo Daily Giveaway:', err);
  } finally {
    process.exit(0);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
