require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const {
  buildActiveGiveawayEmbed,
  buildGiveawayActionRow,
  registerGiveaway
} = require('../src/giveawayManager');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on('clientReady', async () => {
  try {
    const channelId = '1513357276256403558'; // 『🎁』giveaway
    const channel = await client.channels.fetch(channelId);
    if (!channel) throw new Error('Không tìm thấy kênh giveaway!');

    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const hostId = guild.ownerId || '895890393806274570';
    const durationMs = 24 * 60 * 60 * 1000; // 24h
    const endsAt = Date.now() + durationMs;
    const prize = '50k';
    const description = 'Mời 2 người gửi tại <#1513357316270063677> (Không làm req mà pick = BAN)';
    const winnersCount = 1;

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
      participants: []
    };

    const embed = buildActiveGiveawayEmbed(dummy);
    let row = buildGiveawayActionRow(dummy, false);

    const msg = await channel.send({
      content: '🎉 **SỰ KIỆN GIVEAWAY MỚI ĐÃ BẮT ĐẦU!** 🎉 @everyone',
      embeds: [embed],
      components: [row],
      allowedMentions: { parse: ['everyone'] }
    });

    dummy.messageId = msg.id;
    row = buildGiveawayActionRow(dummy, false);
    await msg.edit({ components: [row] });

    const registered = registerGiveaway({
      messageId: msg.id,
      channelId,
      guildId: guild.id,
      hostId,
      prize,
      description,
      durationMs,
      winnersCount
    });

    console.log('SUCCESS! Giveaway created with messageId:', msg.id);
  } catch (err) {
    console.error('ERROR:', err);
  } finally {
    process.exit(0);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
