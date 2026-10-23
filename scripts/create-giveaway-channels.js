require('dotenv').config();
const { Client, GatewayIntentBits, ChannelType, PermissionsBitField } = require('discord.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

async function main() {
  await client.login(process.env.DISCORD_BOT_TOKEN);
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  await guild.roles.fetch().catch(() => {});
  const everyoneRoleId = guild.id;
  const staffRoleId = process.env.STAFF_ROLE_ID || '1472036681048658041';

  const categoryId = '1468515122338074705'; // 🎁 GIVEAWAY
  const category = await guild.channels.fetch(categoryId);
  if (!category) {
    throw new Error('Category 🎁 GIVEAWAY not found');
  }

  console.log(`Found category: ${category.name} (${category.id})`);

  // Standard overwrites for read-only channels where only Staff can post
  const readOnlyOverwrites = [
    {
      id: everyoneRoleId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.AddReactions
      ],
      deny: [
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.CreatePublicThreads,
        PermissionsBitField.Flags.CreatePrivateThreads,
        PermissionsBitField.Flags.SendMessagesInThreads
      ]
    },
    {
      id: staffRoleId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.EmbedLinks,
        PermissionsBitField.Flags.AttachFiles,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.MentionEveryone
      ]
    }
  ];

  // 1. Create or verify 『🎁』giveaway-daily
  const existingChannels = await guild.channels.fetch();
  let chDaily = existingChannels.find(c => c.parentId === categoryId && (c.name.includes('giveaway-daily') || c.name.includes('daily')));
  if (!chDaily) {
    chDaily = await guild.channels.create({
      name: '『🎁』giveaway-daily',
      type: ChannelType.GuildText,
      parent: categoryId,
      permissionOverwrites: readOnlyOverwrites,
      reason: 'Kênh Giveaway hàng ngày theo yêu cầu của Owner'
    });
    console.log(`✅ Đã tạo kênh: ${chDaily.name} (${chDaily.id})`);
  } else {
    console.log(`ℹ️ Kênh giveaway-daily đã tồn tại: ${chDaily.name} (${chDaily.id})`);
  }

  // 2. Create or verify 『📸』proof
  let chProof = existingChannels.find(c => c.parentId === categoryId && c.name.includes('proof'));
  if (!chProof) {
    chProof = await guild.channels.create({
      name: '『📸』proof',
      type: ChannelType.GuildText,
      parent: categoryId,
      permissionOverwrites: readOnlyOverwrites,
      reason: 'Kênh Proof bằng chứng trao quà Giveaway theo yêu cầu của Owner'
    });
    console.log(`✅ Đã tạo kênh: ${chProof.name} (${chProof.id})`);
  } else {
    console.log(`ℹ️ Kênh proof đã tồn tại: ${chProof.name} (${chProof.id})`);
  }

  // 3. Sắp xếp thứ tự kênh trong danh mục:
  // giveaway -> giveaway-daily -> requirement -> proof
  const chGiveaway = existingChannels.find(c => c.parentId === categoryId && c.name === '『🎁』giveaway');
  const chReq = existingChannels.find(c => c.parentId === categoryId && c.name === '『📋』requirement');

  const orderedList = [chGiveaway, chDaily, chReq, chProof].filter(Boolean);
  for (let idx = 0; idx < orderedList.length; idx++) {
    await orderedList[idx].setPosition(idx).catch(() => {});
  }
  console.log('✅ Đã sắp xếp thứ tự các kênh trong danh mục 🎁 GIVEAWAY thành công!');

  console.log('\nDanh sách kênh hiện tại trong mục 🎁 GIVEAWAY:');
  const updatedChannels = await guild.channels.fetch();
  updatedChannels
    .filter(c => c.parentId === categoryId)
    .sort((a, b) => a.position - b.position)
    .forEach(c => console.log(`  - ${c.name} (ID: ${c.id}, Vị trí: ${c.position})`));

  process.exit(0);
}

main().catch(err => {
  console.error('Lỗi:', err);
  process.exit(1);
});
