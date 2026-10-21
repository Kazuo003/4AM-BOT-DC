require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const ROLE_IDS = [
  '1428223724103925771', // Stock
  '1428223579316687029', // Giveaways
  '1562280274274947173'  // Event
];

client.on('clientReady', async () => {
  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    console.log('Connected to Guild:', guild.name);

    for (const rId of ROLE_IDS) {
      const role = await guild.roles.fetch(rId);
      if (role) {
        await role.edit({
          color: 0,
          mentionable: false
        }, 'Chỉnh màu mặc định và tắt quyền ping cho member');
        console.log(`[Success] Role "${role.name}" (${role.id}): Color -> Mặc định, Mentionable -> false`);
      } else {
        console.warn(`Role not found: ${rId}`);
      }
    }

    console.log('Done!');
  } catch (err) {
    console.error('Error:', err);
  } finally {
    process.exit(0);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
