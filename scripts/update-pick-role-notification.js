require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

client.on('clientReady', async () => {
  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    console.log('Connected to Guild:', guild.name);

    // 1. Đổi tên role Announcement thành Notification + Chỉnh màu mặc định & tắt quyền ping
    const notifRole = await guild.roles.fetch('1428223650976239700');
    if (!notifRole) throw new Error('Không tìm thấy role 1428223650976239700!');

    await notifRole.edit({
      name: 'Notification',
      color: 0,
      mentionable: false
    }, 'Đổi tên thành Notification & thiết lập chuẩn cho hệ thống Pick Role');
    console.log('✅ Đã đổi tên role thành Notification (color: 0, mentionable: false)');

    const stockRole = await guild.roles.fetch('1428223724103925771');
    const giveawayRole = await guild.roles.fetch('1428223579316687029');
    const eventRole = await guild.roles.fetch('1562280274274947173');

    // 2. Cập nhật Bảng Pick Role trong kênh 『🔔』pick-role
    const pickRoleChannel = await guild.channels.fetch('1562280284391739442');
    if (!pickRoleChannel) throw new Error('Không tìm thấy kênh pick-role!');

    const oldMessages = await pickRoleChannel.messages.fetch({ limit: 10 });
    for (const m of oldMessages.values()) {
      await m.delete().catch(() => {});
    }

    const embed = new EmbedBuilder()
      .setTitle('🎭 4AM STORE — NHẬN ROLE THÔNG BÁO')
      .setDescription([
        'Chào mừng bạn đến với **4AM Store**! Hãy chọn các Role bên dưới để nhận thông báo sớm nhất từ Shop nhé:\n',
        `📦 **Stock** (<@&${stockRole.id}>) — Nhận ping khi có hàng mới về kho.`,
        `🎉 **Giveaways** (<@&${giveawayRole.id}>) — Nhận ping khi có sự kiện Giveaway phát quà.`,
        `🎊 **Event** (<@&${eventRole.id}>) — Nhận ping minigame & sự kiện cộng đồng.`,
        `🔔 **Notification** (<@&${notifRole.id}>) — Nhận ping thông báo chung & cập nhật mới nhất từ Shop.\n`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '⚡ **Hướng dẫn:**',
        '• Bấm vào nút bên dưới để **Nhận Role**.',
        '• Bấm lại nút đó một lần nữa để **Hủy Role** bất cứ khi nào bạn muốn!'
      ].join('\n'))
      .setColor(0x5865F2)
      .setImage('https://media.discordapp.net/attachments/1549013116145111050/1549026763089252443/3aa46f5701fc6ed92234ea0a9f86e2cd.gif?ex=6ad01757&is=6acec5d7&hm=c26b4f8582f2eb174e4ed2651fdce47951805970880019f6e2f8f39c2ac6cd24&=&width=640&height=356')
      .setFooter({ text: '4AM Store • Hệ thống thông báo tự động', iconURL: guild.iconURL() })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`pick_role|${stockRole.id}`)
        .setLabel('Stock')
        .setEmoji('📦')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`pick_role|${giveawayRole.id}`)
        .setLabel('Giveaways')
        .setEmoji('🎉')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`pick_role|${eventRole.id}`)
        .setLabel('Event')
        .setEmoji('🎊')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`pick_role|${notifRole.id}`)
        .setLabel('Notification')
        .setEmoji('🔔')
        .setStyle(ButtonStyle.Danger)
    );

    await pickRoleChannel.send({ embeds: [embed], components: [row] });
    console.log('✅ Đã cập nhật bảng Pick Role mới gồm đủ 4 role!');

    // 3. Cấp role Notification cho toàn bộ thành viên người thật chưa có
    console.log('Đang tải danh sách thành viên để cấp role Notification...');
    const members = await guild.members.fetch();
    const humans = members.filter(m => !m.user.bot);
    const needRole = humans.filter(m => !m.roles.cache.has(notifRole.id));
    console.log(`Có ${needRole.size}/${humans.size} thành viên cần cấp role Notification. Bắt đầu...`);

    let success = 0;
    let failed = 0;
    let idx = 0;
    const totalNeed = needRole.size;

    for (const member of needRole.values()) {
      idx++;
      try {
        await member.roles.add(notifRole.id, 'Cấp role Notification mặc định cho thành viên');
        success++;
        await sleep(350); // safe pacing
      } catch (err) {
        failed++;
        if (err.status === 429) {
          console.warn('Rate limit hit, pausing 5s...');
          await sleep(5000);
        }
      }

      if (idx % 100 === 0 || idx === totalNeed) {
        console.log(`[Tiến độ cấp Notification] ${idx}/${totalNeed} (${Math.round(idx / totalNeed * 100)}%) — Thành công: ${success}, Lỗi: ${failed}`);
      }
    }

    console.log('🎉 HOÀN TẤT CẤP ROLE NOTIFICATION CHO TOÀN BỘ SERVER!');

  } catch (err) {
    console.error('Lỗi thực hiện:', err);
  } finally {
    process.exit(0);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
