require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const categoryUpdates = [
  { id: '1476050325906653357', newName: '✨ 4AM' },
  { id: '1379348230516506728', newName: '📅 28 . 06 . 2025' },
  { id: '1562280278171324536', newName: '🎭 4AM ROLES' },
  { id: '1379348232475508798', newName: '🔗 DISCORD.GG/FOURAM' },
  { id: '1468515122338074705', newName: '🎁 GIVEAWAY' },
  { id: '1548580668747817010', newName: '🛒 ORDER' },
  { id: '1417357568417726464', newName: '📦 SERVICE' },
  { id: '1513559910330400829', newName: '🔨 AUCTION' },
  { id: '1379348238297071618', newName: '🤝 PARTNER' },
  { id: '1475019290020417659', newName: '🪙 OWOVN' },
  { id: '1474752819276808312', newName: '🌐 FOREIGN TICKET' },
  { id: '1441078154239410206', newName: '🎫 TICKET' },
  { id: '1478428161208357100', newName: '🌾 OWO FARM' },
  { id: '1419945304408592424', newName: '🔒 LOGS' }
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

client.on('clientReady', async () => {
  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    console.log('Connected to Guild:', guild.name);

    for (const item of categoryUpdates) {
      try {
        const cat = await guild.channels.fetch(item.id).catch(() => null);
        if (!cat) {
          console.warn(`Category not found: ${item.id} (${item.newName})`);
          continue;
        }

        if (cat.name === item.newName) {
          console.log(`[Unchanged] ${cat.name}`);
        } else {
          const oldName = cat.name;
          await cat.setName(item.newName, 'Decor đồng bộ danh mục theo phong cách 4AM ROLES (Phương án B)');
          console.log(`[Renamed] "${oldName}" -> "${item.newName}"`);
          await sleep(1200); // Tránh rate limit
        }
      } catch (err) {
        console.error(`Error updating ${item.id} (${item.newName}):`, err.message);
      }
    }

    console.log('✅ Hoàn thành đổi tên toàn bộ danh mục!');
  } catch (err) {
    console.error('Fatal error:', err);
  } finally {
    process.exit(0);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
