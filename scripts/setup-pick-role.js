require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on('clientReady', async () => {
  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    console.log('Connected to Guild:', guild.name);

    // 1. Xóa role Sale nếu còn tồn tại
    const roles = await guild.roles.fetch();
    const saleRole = roles.get('1562280272211484762') || roles.find(r => r.name.toLowerCase() === 'sale');
    if (saleRole) {
      await saleRole.delete('Xóa role Sale theo yêu cầu quản trị viên');
      console.log('✅ Đã xóa role Sale thành công!');
    } else {
      console.log('ℹ️ Không tìm thấy role Sale (có thể đã được xóa trước đó).');
    }

    // 2. Lấy role Stock, Giveaway, Event
    const stockRole = roles.get('1428223724103925771') || roles.find(r => r.name.toLowerCase() === 'stock');
    const giveawayRole = roles.get('1428223579316687029') || roles.find(r => r.name.toLowerCase() === 'giveaways' || r.name.toLowerCase() === 'giveaway');
    const eventRole = roles.get('1562280274274947173') || roles.find(r => r.name.toLowerCase() === 'event');

    if (!stockRole || !giveawayRole || !eventRole) {
      throw new Error(`Thiếu role: stock=${!!stockRole}, giveaway=${!!giveawayRole}, event=${!!eventRole}`);
    }

    // 3. Tìm kênh pick-role và xóa tin nhắn cũ
    const pickRoleChannel = await guild.channels.fetch('1562280284391739442');
    if (!pickRoleChannel) throw new Error('Không tìm thấy kênh pick-role!');

    const oldMessages = await pickRoleChannel.messages.fetch({ limit: 10 });
    for (const m of oldMessages.values()) {
      await m.delete().catch(() => {});
    }

    // 4. Tạo Embed mới chỉ gồm 3 role: Stock, Giveaways, Event
    const embed = new EmbedBuilder()
      .setTitle('🎭 4AM STORE — NHẬN ROLE THÔNG BÁO')
      .setDescription([
        'Chào mừng bạn đến với **4AM Store**! Hãy chọn các Role bên dưới để nhận thông báo sớm nhất từ Shop nhé:\n',
        `📦 **Stock** (<@&${stockRole.id}>) — Nhận ping khi có hàng mới về kho.`,
        `🎉 **Giveaways** (<@&${giveawayRole.id}>) — Nhận ping khi có sự kiện Giveaway phát quà.`,
        `🎊 **Event** (<@&${eventRole.id}>) — Nhận ping minigame & sự kiện cộng đồng.\n`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '⚡ **Hướng dẫn:**',
        '• Bấm vào nút bên dưới để **Nhận Role**.',
        '• Bấm lại nút đó một lần nữa để **Hủy Role** bất cứ khi nào bạn muốn!'
      ].join('\n'))
      .setColor(0x5865F2)
      .setImage('https://media.discordapp.net/attachments/1549013116145111050/1549026763089252443/3aa46f5701fc6ed92234ea0a9f86e2cd.gif?ex=6ad01757&is=6acec5d7&hm=c26b4f8582f2eb174e4ed2651fdce47951805970880019f6e2f8f39c2ac6cd24&=&width=640&height=356')
      .setFooter({ text: '4AM Store • Hệ thống thông báo tự động', iconURL: guild.iconURL() })
      .setTimestamp();

    // 5. Tạo 3 nút bấm
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
        .setStyle(ButtonStyle.Secondary)
    );

    await pickRoleChannel.send({ embeds: [embed], components: [row] });
    console.log('✅ Đã cập nhật bảng Pick Role mới (chỉ gồm 3 role: Stock, Giveaways, Event)!');

  } catch (err) {
    console.error('Lỗi thực hiện:', err);
  } finally {
    process.exit(0);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
