require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const msgContent = `🇺🇸 **ENGLISH:**
We are looking to collaborate with shop owners as a cow supplier! We offer great rates depending on your sales volume and potential.
Please open a ticket in <#1379348256743489546> and send us your shop server link so we can evaluate and offer the best suitable rate!

━━━━━━━━━━━━━━━━━━━━━
🇮🇩 **BAHASA INDONESIA:**
Kami sedang mencari kolaborasi dengan para owner shop untuk menjadi supplier cow ya! Rate menarik & bersahabat tergantung pada potensi dan volume kalian.
Silakan buat ticket di <#1379348256743489546> dan kirimkan link server shop kalian agar kami bisa mengevaluasi serta memberikan penawaran rate yang paling sesuai ya!`;

client.on('clientReady', async () => {
  try {
    const ch = await client.channels.fetch('1513358136302637067');
    if (!ch) throw new Error('Không tìm thấy kênh announcement!');
    const sent = await ch.send({
      content: msgContent
    });
    console.log('SUCCESS! Sent message ID:', sent.id);
  } catch (err) {
    console.error('Error:', err);
  } finally {
    process.exit(0);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
