require('dotenv').config();
const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function main() {
  await client.login(process.env.DISCORD_BOT_TOKEN);
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  await guild.roles.fetch();
  const everyoneId = guild.id;
  const staffRole = process.env.STAFF_ROLE_ID ? await guild.roles.fetch(process.env.STAFF_ROLE_ID).catch(() => null) : null;

  const channels = await guild.channels.fetch();

  const categories = [];
  const uncategorized = [];

  channels.forEach(ch => {
    if (!ch) return;
    if (ch.type === 4) {
      categories.push({ id: ch.id, name: ch.name, position: ch.position, channel: ch, children: [] });
    }
  });

  categories.sort((a, b) => a.position - b.position);

  channels.forEach(ch => {
    if (!ch || ch.type === 4) return;
    if (ch.parentId) {
      const cat = categories.find(c => c.id === ch.parentId);
      if (cat) cat.children.push(ch);
    } else {
      uncategorized.push(ch);
    }
  });

  categories.forEach(c => c.children.sort((a, b) => a.position - b.position));
  uncategorized.sort((a, b) => a.position - b.position);

  const report = [];

  function auditChannel(ch) {
    const evPerms = ch.permissionsFor(everyoneId);
    const staffPerms = staffRole ? ch.permissionsFor(staffRole) : null;

    const canEvView = evPerms ? evPerms.has(PermissionsBitField.Flags.ViewChannel) : false;
    const canEvSend = evPerms ? evPerms.has(PermissionsBitField.Flags.SendMessages) : false;
    const canStaffSend = staffPerms ? staffPerms.has(PermissionsBitField.Flags.SendMessages) : false;
    const canStaffView = staffPerms ? staffPerms.has(PermissionsBitField.Flags.ViewChannel) : false;

    // Check specific overwrites
    const evOverwrite = ch.permissionOverwrites.cache.get(everyoneId);
    const evExplicitDenySend = evOverwrite ? evOverwrite.deny.has(PermissionsBitField.Flags.SendMessages) : false;
    const evExplicitAllowSend = evOverwrite ? evOverwrite.allow.has(PermissionsBitField.Flags.SendMessages) : false;
    const evExplicitDenyView = evOverwrite ? evOverwrite.deny.has(PermissionsBitField.Flags.ViewChannel) : false;

    return {
      id: ch.id,
      name: ch.name,
      type: ch.type,
      canEvView,
      canEvSend,
      canStaffView,
      canStaffSend,
      evExplicitDenySend,
      evExplicitAllowSend,
      evExplicitDenyView
    };
  }

  for (const cat of categories) {
    const catAudit = auditChannel(cat.channel);
    const childrenAudit = cat.children.map(auditChannel);
    report.push({
      category: cat.name,
      catId: cat.id,
      catAudit,
      channels: childrenAudit
    });
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
