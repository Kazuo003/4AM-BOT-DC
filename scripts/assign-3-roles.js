require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const TARGET_ROLES = [
  { id: '1428223724103925771', name: 'Stock' },
  { id: '1428223579316687029', name: 'Giveaways' },
  { id: '1562280274274947173', name: 'Event' }
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

client.on('ready', async () => {
  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    console.log(`Connected to Guild: ${guild.name} (${guild.id})`);
    console.log('Đang tải toàn bộ danh sách thành viên...');
    const members = await guild.members.fetch();
    const humans = members.filter(m => !m.user.bot);
    console.log(`Tổng số thành viên người thật: ${humans.size}`);

    const roleIds = TARGET_ROLES.map(r => r.id);
    const needUpdate = humans.filter(m => roleIds.some(rId => !m.roles.cache.has(rId)));
    console.log(`Số thành viên cần cấp bổ sung role: ${needUpdate.size}`);

    let successCount = 0;
    let errorCount = 0;
    let processed = 0;
    const totalNeed = needUpdate.size;

    for (const member of needUpdate.values()) {
      processed++;
      const missing = roleIds.filter(rId => !member.roles.cache.has(rId));
      if (missing.length > 0) {
        try {
          await member.roles.add(missing, 'Cấp 3 role Stock, Giveaways, Event theo yêu cầu Owner');
          successCount++;
          await sleep(350); // Giãn cách 350ms an toàn chống rate limit
        } catch (err) {
          errorCount++;
          console.error(`Lỗi cấp role cho ${member.user.tag}:`, err.message);
          if (err.status === 429) {
            const retryAfter = (err.rawError?.retry_after || 5) * 1000;
            console.warn(`⚠️ Rate limit! Đợi ${retryAfter}ms...`);
            await sleep(retryAfter);
          }
        }
      }

      if (processed % 20 === 0 || processed === totalNeed) {
        console.log(`[Tiến độ] ${processed}/${totalNeed} (${Math.round(processed / totalNeed * 100)}%) — Đã cấp thành công: ${successCount}, Lỗi: ${errorCount}`);
      }
    }

    console.log('\n🎉 HOÀN TẤT CẤP 3 ROLE CHO THÀNH VIÊN!');
    console.log(`- Tổng số thành viên cần cấp: ${totalNeed}`);
    console.log(`- Đã cấp thành công: ${successCount}`);
    console.log(`- Lỗi: ${errorCount}`);

  } catch (err) {
    console.error('Lỗi nghiêm trọng:', err);
  } finally {
    process.exit(0);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
