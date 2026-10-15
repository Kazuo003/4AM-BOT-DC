require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function main() {
  await client.login(process.env.DISCORD_BOT_TOKEN);
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  const everyoneId = guild.id; // @everyone ID is always guild.id
  const staffRoleId = process.env.STAFF_ROLE_ID;

  console.log(`📡 Đang áp dụng phân quyền trên server: ${guild.name} (${guild.id})`);
  console.log(`🛡️ Staff Role ID: ${staffRoleId}`);

  // 1. Nhóm 4 kênh mở cho mọi member chat:
  const memberChatChannels = [
    { name: '『🇻🇳』vie・chat', id: '1468825357829279805' },
    { name: '『🌐』foreign・chat', id: '1474022683330089132' },
    { name: '『⌨』bot・cmd', id: '1441258890871181312' },
    { name: '『💸』bid', id: '1506502433608695838' }
  ];

  for (const item of memberChatChannels) {
    const ch = await guild.channels.fetch(item.id);
    if (!ch) {
      console.warn(`⚠️ Không tìm thấy kênh: ${item.name} (${item.id})`);
      continue;
    }
    await ch.permissionOverwrites.edit(everyoneId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AddReactions: true,
      AttachFiles: true,
      EmbedLinks: true
    });
    console.log(`✅ [MỞ CHAT] Đã cấp quyền chat cho mọi member: ${item.name}`);
  }

  // 2. Nhóm 2 kênh chỉ cho Staff chat (Khóa chat member):
  const staffOnlyChannels = [
    { name: '『📖』auction-rule', id: '1506511828996329502' },
    { name: '『🔥』auction', id: '1506502533101785209' }
  ];

  for (const item of staffOnlyChannels) {
    const ch = await guild.channels.fetch(item.id);
    if (!ch) {
      console.warn(`⚠️ Không tìm thấy kênh: ${item.name} (${item.id})`);
      continue;
    }
    // Khóa chat với @everyone
    await ch.permissionOverwrites.edit(everyoneId, {
      ViewChannel: true,
      SendMessages: false,
      ReadMessageHistory: true,
      AddReactions: true,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      SendMessagesInThreads: false
    });
    // Mở quyền chat cho Staff
    if (staffRoleId) {
      await ch.permissionOverwrites.edit(staffRoleId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        AttachFiles: true,
        EmbedLinks: true
      });
    }
    console.log(`🔒 [CHỈ STAFF CHAT] Đã khóa chat member, mở chat cho Staff: ${item.name}`);
  }

  console.log('\n🎉 Hoàn thành thiết lập phân quyền thành công 100%!');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Lỗi khi thiết lập quyền:', err);
  process.exit(1);
});
