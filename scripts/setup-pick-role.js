require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionsBitField,
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

    // 1. Kiểm tra / Tạo role Sale & Event
    const roles = await guild.roles.fetch();
    let stockRole = roles.get('1428223724103925771') || roles.find(r => r.name.toLowerCase() === 'stock');
    let giveawayRole = roles.get('1428223579316687029') || roles.find(r => r.name.toLowerCase() === 'giveaways' || r.name.toLowerCase() === 'giveaway');

    let saleRole = roles.find(r => r.name.toLowerCase() === 'sale');
    if (!saleRole) {
      saleRole = await guild.roles.create({
        name: 'Sale',
        color: 0xFF5722,
        reason: 'Tạo role Sale cho hệ thống Pick Role'
      });
      console.log('Created Role Sale:', saleRole.id);
    } else {
      console.log('Existing Role Sale:', saleRole.id);
    }

    let eventRole = roles.find(r => r.name.toLowerCase() === 'event');
    if (!eventRole) {
      eventRole = await guild.roles.create({
        name: 'Event',
        color: 0x9C27B0,
        reason: 'Tạo role Event cho hệ thống Pick Role'
      });
      console.log('Created Role Event:', eventRole.id);
    } else {
      console.log('Existing Role Event:', eventRole.id);
    }

    // 2. Tạo Category 🎭 4AM ROLES (nếu chưa có)
    const channels = await guild.channels.fetch();
    let roleCat = channels.find(c => c && c.type === ChannelType.GuildCategory && c.name.includes('4AM ROLES'));
    if (!roleCat) {
      roleCat = await guild.channels.create({
        name: '🎭 4AM ROLES',
        type: ChannelType.GuildCategory,
        position: 2,
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            allow: [PermissionsBitField.Flags.ViewChannel],
            deny: [PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.AddReactions]
          },
          {
            id: client.user.id,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.EmbedLinks,
              PermissionsBitField.Flags.ManageChannels,
              PermissionsBitField.Flags.ManageMessages
            ]
          }
        ]
      });
      console.log('Created Category 🎭 4AM ROLES:', roleCat.id);
    } else {
      console.log('Existing Category 🎭 4AM ROLES:', roleCat.id);
    }

    // 3. Dời 2 kênh role・info và role・info-en vào danh mục mới (giữ nguyên icon và tên)
    const roleInfoVi = await guild.channels.fetch('1422472589313441863').catch(() => null);
    if (roleInfoVi && roleInfoVi.parentId !== roleCat.id) {
      await roleInfoVi.setParent(roleCat.id, { lockPermissions: false });
      console.log('Moved 『✅』role・info into 🎭 4AM ROLES');
    }

    const roleInfoEn = await guild.channels.fetch('1548649836016832534').catch(() => null);
    if (roleInfoEn && roleInfoEn.parentId !== roleCat.id) {
      await roleInfoEn.setParent(roleCat.id, { lockPermissions: false });
      console.log('Moved 『✅』role・info-en into 🎭 4AM ROLES');
    }

    // 4. Tạo kênh 『🔔』pick-role (nếu chưa có)
    let pickRoleChannel = channels.find(c => c && c.parentId === roleCat.id && c.name.includes('pick-role'));
    if (!pickRoleChannel) {
      pickRoleChannel = await guild.channels.create({
        name: '『🔔』pick-role',
        type: ChannelType.GuildText,
        parent: roleCat.id,
        position: 0,
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory],
            deny: [PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.AddReactions]
          },
          {
            id: client.user.id,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.EmbedLinks,
              PermissionsBitField.Flags.ManageMessages
            ]
          }
        ]
      });
      console.log('Created Channel 『🔔』pick-role:', pickRoleChannel.id);
    } else {
      console.log('Existing Channel 『🔔』pick-role:', pickRoleChannel.id);
    }

    // Xóa tin nhắn cũ trong kênh pick-role (nếu có) để gửi bảng mới nhất
    const oldMessages = await pickRoleChannel.messages.fetch({ limit: 10 });
    if (oldMessages.size > 0) {
      for (const m of oldMessages.values()) {
        await m.delete().catch(() => {});
      }
    }

    // 5. Gửi Embed và Nút bấm vào kênh 『🔔』pick-role
    const embed = new EmbedBuilder()
      .setTitle('🎭 4AM STORE — NHẬN ROLE THÔNG BÁO')
      .setDescription([
        'Chào mừng bạn đến với **4AM Store**! Hãy chọn các Role bên dưới để nhận thông báo sớm nhất từ Shop nhé:\n',
        `📦 **Stock** (<@&${stockRole.id}>) — Nhận ping khi có hàng mới về kho.`,
        `🏷️ **Sale** (<@&${saleRole.id}>) — Nhận ping các đợt flash sale & ưu đãi giảm giá.`,
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

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`pick_role|${stockRole.id}`)
        .setLabel('Stock')
        .setEmoji('📦')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`pick_role|${saleRole.id}`)
        .setLabel('Sale')
        .setEmoji('🏷️')
        .setStyle(ButtonStyle.Danger),
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
    console.log('✅ Đã gửi bảng Pick Role thành công!');

    console.log('DONE_SUMMARY:', JSON.stringify({
      stockRoleId: stockRole.id,
      saleRoleId: saleRole.id,
      giveawayRoleId: giveawayRole.id,
      eventRoleId: eventRole.id,
      categoryId: roleCat.id,
      pickRoleChannelId: pickRoleChannel.id
    }));

  } catch (err) {
    console.error('Error during setup:', err);
  } finally {
    process.exit(0);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
