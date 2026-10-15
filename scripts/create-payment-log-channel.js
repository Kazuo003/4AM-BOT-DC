require('dotenv').config();
const { Client, GatewayIntentBits, ChannelType, PermissionsBitField, OverwriteType } = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function main() {
  await client.login(process.env.DISCORD_BOT_TOKEN);
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  await guild.roles.fetch();

  const everyoneRole = guild.roles.everyone;
  const staffRole = process.env.STAFF_ROLE_ID ? guild.roles.cache.get(process.env.STAFF_ROLE_ID) : null;
  const me = await guild.members.fetchMe();

  const channels = await guild.channels.fetch();
  let existing = channels.find(c => c && (c.name.includes('biến-động-số-dư') || c.name.includes('bien-dong-so-du')));

  if (existing) {
    console.log(`ℹ️ Kênh đã tồn tại: ${existing.name} (${existing.id})`);
    return existing;
  }

  const overwrites = [
    {
      id: everyoneRole.id,
      type: OverwriteType.Role,
      deny: [PermissionsBitField.Flags.ViewChannel]
    },
    {
      id: me.id,
      type: OverwriteType.Member,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.EmbedLinks,
        PermissionsBitField.Flags.AttachFiles,
        PermissionsBitField.Flags.ReadMessageHistory
      ]
    }
  ];

  if (staffRole) {
    overwrites.push({
      id: staffRole.id,
      type: OverwriteType.Role,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory
      ]
    });
  }

  const ch = await guild.channels.create({
    name: '『💰』biến-động-số-dư',
    type: ChannelType.GuildText,
    parent: '1419945304408592424',
    permissionOverwrites: overwrites
  });

  console.log(`✅ Đã tạo kênh thông báo tiền vào: ${ch.name} (${ch.id})`);
  return ch;
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Lỗi:', err);
    process.exit(1);
  });
