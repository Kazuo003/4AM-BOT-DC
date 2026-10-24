require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const CHANNEL_ID = '1513357276256403558'; // 『🎁』giveaway
const GIVEAWAY_ROLE_ID = '1428223579316687029'; // @Giveaways
const REQ_CHANNEL_ID = '1513357316270063677'; // 『📋』requirement

client.on('ready', async () => {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) throw new Error('Không tìm thấy kênh giveaway!');

    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const hostId = guild.ownerId || '895890393806274570';
    const durationMs = 12 * 60 * 60 * 1000; // 12 tiếng
    const endsAt = Date.now() + durationMs;
    const endsTimestamp = Math.floor(endsAt / 1000);

    const prize = '3 Slot Chung Sức';
    const winnersCount = 3;
    const description = `Mời 1 người gửi tại <#${REQ_CHANNEL_ID}> & Treo bio: \`discord.gg/fouram owo giá rẻ\` (Không làm req mà pick trúng = Reroll / Ban!)`;

    const desc = [
      `🎁 **Phần thưởng:** **${prize}**`,
      `🏆 **Số người trúng:** **${winnersCount}** người (Mỗi bạn 1 Slot)`,
      `👑 **Người tổ chức:** <@${hostId}>`,
      `⏳ **Thời gian kết thúc:** <t:${endsTimestamp}:R> (<t:${endsTimestamp}:f>)`,
      `👥 **Số người tham gia:** **0**`,
      '',
      `📝 **Ghi chú/Điều kiện:** ${description}`,
      '',
      '⚡ *Nhấn nút **[ 🎉 Tham gia ]** bên dưới để nhận số báo danh may mắn!*'
    ];

    const embed = new EmbedBuilder()
      .setTitle(`🎉 GIVEAWAY: ${prize.toUpperCase()} 🎉`)
      .setDescription(desc.join('\n'))
      .setColor(0xF59E0B) // Amber/Gold cho giải Chung Sức
      .setThumbnail('https://cdn.discordapp.com/emojis/1283685258925895741.gif')
      .setFooter({ text: '4AM SHOP • Chúc bạn may mắn!' })
      .setTimestamp(new Date(endsAt));

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('pending')
        .setLabel('🎉 Tham gia (0)')
        .setStyle(ButtonStyle.Primary)
    );

    const msg = await channel.send({
      content: `🎉 **SỰ KIỆN GIVEAWAY 12 TIẾNG MỚI ĐÃ BẮT ĐẦU!** 🎉 <@&${GIVEAWAY_ROLE_ID}> @everyone`,
      embeds: [embed],
      components: [row],
      allowedMentions: { roles: [GIVEAWAY_ROLE_ID], parse: ['everyone'] }
    });

    const updatedRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`giveaway_join|${msg.id}`)
        .setLabel('🎉 Tham gia (0)')
        .setStyle(ButtonStyle.Primary)
    );

    await msg.edit({ components: [updatedRow] });

    console.log(`✅ SUCCESS! Đã tạo Giveaway thành công tại kênh <#${CHANNEL_ID}>!`);
    console.log(`- Message ID: ${msg.id}`);
    console.log(`- Giải thưởng: ${prize}`);
    console.log(`- Số người trúng: ${winnersCount} người`);
    console.log(`- Thời hạn: 12 tiếng (Kết thúc lúc: ${new Date(endsAt).toLocaleString('vi-VN')})`);

  } catch (err) {
    console.error('Lỗi khi tạo giveaway:', err);
  } finally {
    process.exit(0);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
