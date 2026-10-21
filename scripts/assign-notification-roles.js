require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const TARGET_ROLES = [
  '1428223724103925771', // Stock
  '1428223579316687029', // Giveaways
  '1562280274274947173'  // Event
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

client.on('clientReady', async () => {
  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    console.log('Connected to Guild:', guild.name);
    console.log('Đang tải danh sách thành viên...');
    const members = await guild.members.fetch();
    const humans = members.filter(m => !m.user.bot);
    const total = humans.size;
    console.log(`Tìm thấy ${total} thành viên người thật. Bắt đầu cấp role an toàn...`);

    let successCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    let processed = 0;

    for (const member of humans.values()) {
      processed++;
      const missing = TARGET_ROLES.filter(rId => !member.roles.cache.has(rId));
      if (missing.length === 0) {
        skippedCount++;
      } else {
        try {
          await member.roles.add(missing, 'Cấp role thông báo mặc định cho toàn bộ thành viên');
          successCount++;
          await sleep(350); // Giãn cách 350ms an toàn chống rate limit
        } catch (err) {
          errorCount++;
          if (err.status === 429) {
            console.warn('⚠️ Gặp Rate Limit tạm thời, đang tạm dừng 5 giây...');
            await sleep(5000);
          }
        }
      }

      if (processed % 50 === 0 || processed === total) {
        console.log(`[Tiến độ] ${processed}/${total} (${Math.round(processed / total * 100)}%) — Đã cấp: ${successCount}, Đã có đủ: ${skippedCount}, Lỗi: ${errorCount}`);
      }
    }

    console.log('\n🎉 HOÀN TẤT CẤP ROLE CHO TOÀN BỘ SERVER!');
    console.log(`Tổng số: ${total} thành viên`);
    console.log(`Đã cấp thành công: ${successCount} thành viên`);
    console.log(`Đã có đủ role từ trước: ${skippedCount} thành viên`);
    console.log(`Lỗi bỏ qua: ${errorCount} thành viên`);

  } catch (err) {
    console.error('Lỗi nghiêm trọng:', err);
  } finally {
    process.exit(0);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
