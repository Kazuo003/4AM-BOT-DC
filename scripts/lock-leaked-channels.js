require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function main() {
  await client.login(process.env.DISCORD_BOT_TOKEN);
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  const everyoneId = guild.id;
  const staffRoleId = process.env.STAFF_ROLE_ID;

  console.log(`🔒 Bắt đầu khóa chat các kênh thông tin trên server: ${guild.name} (${guild.id})`);

  const channelsToLock = [
    { name: '『📜』rules-en', id: '1548646012136988683' },
    { name: '『📜』tos-en', id: '1548646009515810889' },
    { name: '『🔔』announcement-en', id: '1548646014620143686' },
    { name: '『✅』role・info-en', id: '1548649836016832534' },
    { name: '『🌐』about-us', id: '1548645917631062127' },
    { name: '『📋』requirement', id: '1513357316270063677' }
  ];

  for (const item of channelsToLock) {
    const ch = await guild.channels.fetch(item.id).catch(() => null);
    if (!ch) {
      console.warn(`⚠️ Không tìm thấy kênh: ${item.name} (${item.id})`);
      continue;
    }

    // Khóa quyền nhắn tin của @everyone
    await ch.permissionOverwrites.edit(everyoneId, {
      ViewChannel: true,
      SendMessages: false,
      ReadMessageHistory: true,
      AddReactions: true,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      SendMessagesInThreads: false
    });

    // Mở quyền nhắn tin cho Staff
    if (staffRoleId) {
      await ch.permissionOverwrites.edit(staffRoleId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        AttachFiles: true,
        EmbedLinks: true
      });
    }

    console.log(`✅ [ĐÃ KHÓA CHAT] ${item.name} — @everyone: Xem/Thả reaction, Staff: Đăng bài/Chat`);
  }

  console.log('\n🎉 Đã hoàn tất khóa chat toàn bộ 6 kênh thành công!');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Lỗi khi khóa kênh:', err);
  process.exit(1);
});
