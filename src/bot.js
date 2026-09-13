require('dotenv').config();

const {
  Client, GatewayIntentBits, Partials,
  ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  EmbedBuilder, PermissionsBitField, parseEmoji
} = require('discord.js');

const express = require('express');
const { nanoid } = require('nanoid');
const { prisma } = require('./db');
const { CATALOG, CURRENCY } = require('./catalog');
const { ensureUser, findOrCreateProduct, createOrder, markPaid, attachTicket } = require('./order');
const { specToLines, shortOrderNo } = require('./utils');
const menuData = require('./menuData');
const path = require('path');
const fs = require('fs');
const getPort = require('get-port').default; // <- note .default

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});

//
// ----------- Seed catalog into DB on startup -----------
//
async function seedCatalog() {
  for (const [type, items] of Object.entries(CATALOG)) {
    for (const it of items) {
      await findOrCreateProduct({
        type,
        name: it.name,
        sku: it.sku,
        specJson: JSON.stringify(it.spec),
        priceCents: it.priceCents,
        currency: CURRENCY
      });
    }
  }
}

//
// ----------- UI Builders -----------
//

const BILLING_DAYS = parseInt(process.env.BILLING_DAYS || '30', 10);

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/**
 * Called after an order is marked PAID.
 * Ensures a Subscription exists and extends/sets currentPeriodEnd.
 */
async function upsertSubscriptionForPaidOrder(orderId) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { user: true, product: true }
  });
  if (!order) return;

  const now = new Date();

  // Find existing active sub for this user+product
  const existing = await prisma.subscription.findFirst({
    where: {
      userId: order.userId,
      productId: order.productId,
      status: 'ACTIVE'
    }
  });

  if (!existing) {
    await prisma.subscription.create({
      data: {
        userId: order.userId,
        productId: order.productId,
        lastOrderId: order.id,
        status: 'ACTIVE',
        currentPeriodEnd: addDays(now, BILLING_DAYS),
        remindedExpiry: false
      }
    });
  } else {
    // Extend from the later of now or currentPeriodEnd
    const base = existing.currentPeriodEnd > now ? existing.currentPeriodEnd : now;
    await prisma.subscription.update({
      where: { id: existing.id },
      data: {
        lastOrderId: order.id,
        currentPeriodEnd: addDays(base, BILLING_DAYS),
        remindedExpiry: false // reset so the next cycle can be reminded
      }
    });
  }
}

/**
 * Create a new order for a subscription renewal (same product & price).
 * Returns the new Order row.
 */
async function createRenewalOrderForSubscription(subId) {
  const sub = await prisma.subscription.findUnique({
    where: { id: subId },
    include: { user: true, product: true }
  });
  if (!sub) throw new Error('Subscription not found');

  const planSnapshot = {
    name: sub.product.name,
    sku: sub.product.sku,
    spec: JSON.parse(sub.product.specJson || '{}'),
    renewal: true
  };

  const order = await prisma.order.create({
    data: {
      userId: sub.userId,
      productId: sub.productId,
      planSnapshotJson: JSON.stringify(planSnapshot),
      amountCents: sub.product.priceCents,
      currency: sub.product.currency,
      status: 'PENDING'
    }
  });

  return order;
}

module.exports = {
  prisma,
  ensureUser,
  findOrCreateProduct,
  createOrder,
  markPaid,
  attachTicket,
  // ⬇️ export new helpers
  upsertSubscriptionForPaidOrder,
  createRenewalOrderForSubscription
};
function shopButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('buy_vps').setLabel('Buy VPS').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('buy_bot').setLabel('Buy Bot').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('buy_web').setLabel('Buy Web').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('contact_sales').setLabel('Contact Sales').setStyle(ButtonStyle.Secondary)
  );
}
// ---- Payment buttons shown on the final "Review & Pay" message ----
function paymentButtons(orderId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`pay_upi_${orderId}`)
      .setLabel('📱 Pay via UPI')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`pay_sim_${orderId}`)
      .setLabel('✅ I Paid')
      .setStyle(ButtonStyle.Success)
  );
}
// Grant the purchased customer role (Lucid Customer) to the buyer
async function grantCustomerRole(i, order) {
  const data = getMenuData();
  let customerRoleId = process.env.CUSTOMER_ROLE_ID || data.channels?.customerRoleId;
  if (!customerRoleId && i.guild) {
    const roleLucid = i.guild.roles.cache.find(r => r.name === 'Lucid Customer');
    if (roleLucid) customerRoleId = roleLucid.id;
  }
  if (!customerRoleId) return;

  try {
    // Prefer the stored user on the order (we fetch it in the staff handler)
    const buyerDiscordId = order.user?.discordId;
    let buyerMember = null;

    if (buyerDiscordId) {
      buyerMember = await i.guild.members.fetch(buyerDiscordId).catch(() => null);
    }

    // Fallback: derive from ticket channel overwrites
    if (!buyerMember && order.ticket?.channelId) {
      const chan = await i.guild.channels.fetch(order.ticket.channelId).catch(() => null);
      if (chan) {
        const overwrites = chan.permissionOverwrites.cache;
        const buyerOw = overwrites.find(ow =>
          ow.type === 1 && // member overwrite
          ow.allow?.has?.(PermissionsBitField.Flags.ViewChannel)
        );
        if (buyerOw) {
          buyerMember = await i.guild.members.fetch(buyerOw.id).catch(() => null);
        }
      }
    }

    if (!buyerMember) return;

    await buyerMember.roles.add(customerRoleId).catch(() => {});
    await i.channel.send(`🎉 Đã trao vai trò khách hàng <@&${customerRoleId}> cho <@${buyerMember.id}>! Cảm ơn bạn đã tin tưởng và mua hàng tại shop!`);
  } catch (e) {
    console.error('Grant role failed:', e);
  }
}

// ----- Admin Log helper -----
async function adminLog(content, embed) {
  const channelId = process.env.ADMIN_LOG_CHANNEL_ID;
  if (!channelId) return;
  try {
    const chan = await client.channels.fetch(channelId).catch(() => null);
    if (!chan || !chan.isTextBased()) return;
    await chan.send({ content, embeds: embed ? [embed] : [] });
  } catch (e) { console.error('adminLog failed:', e); }
}

// small embed helper for staff actions
function staffActionEmbed({ title, actorId, details }) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(details)
    .setColor(0xFFA500)
    .setFooter({ text: `By ${actorId ? `@${actorId}` : 'staff'}` })
    .setTimestamp(new Date());
}

// ----- Rate limit: one ticket per X minutes -----
const TICKET_COOLDOWN_MIN = parseInt(process.env.RATE_LIMIT_MINUTES || '10', 10);
const lastTicketAt = new Map(); // userId -> Date

function canOpenTicket(userId) {
  const last = lastTicketAt.get(userId);
  if (!last) return { ok: true };
  const diffMin = (Date.now() - last.getTime()) / 60000;
  if (diffMin >= TICKET_COOLDOWN_MIN) return { ok: true };
  return { ok: false, waitMin: Math.ceil(TICKET_COOLDOWN_MIN - diffMin) };
}
function markTicketOpened(userId) {
  lastTicketAt.set(userId, new Date());
}


function formatPrice(amount, currency = 'VNĐ') {
  const formatted = new Intl.NumberFormat('vi-VN').format(amount);
  return `${formatted} ${currency}`;
}

function buildReceiptEmbed(order, snapshot) {
  const specLines = specToLines(snapshot.spec || {});
  return new EmbedBuilder()
    .setTitle(`🧾 Biên lai thanh toán — Đơn hàng #${order.orderNo}`)
    .setDescription([
      `**Trạng thái:** ĐÃ THANH TOÁN (PAID) ✅`,
      `**Sản phẩm:** ${order.product.name} (${order.product.sku})`,
      `**Số tiền:** ${formatPrice(order.amountCents, order.currency)}`,
      '',
      '**Thông số / Cấu hình:**',
      specLines || 'Tiêu chuẩn',
      snapshot.notes ? `\n**Ghi chú:** ${snapshot.notes}` : ''
    ].join('\n'))
    .setFooter({ text: `Cảm ơn bạn đã tin tưởng 4AM Shop! • ${new Date(order.createdAt).toLocaleString('vi-VN')}` })
    .setColor(0x4CAF50);
}

// Staff action row shown after the buyer clicks "I paid"
function staffControls(orderId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`staff_paid_${orderId}`)
      .setLabel('✅ Duyệt đơn (Mark as Paid)')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`staff_reject_${orderId}`)
      .setLabel('✖ Từ chối (Reject)')
      .setStyle(ButtonStyle.Danger)
  );
}

// Staff ticket controls (Close / Reopen)
function staffTicketControls(orderId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`staff_close_${orderId}`)
      .setLabel('🔒 Đóng Ticket')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`staff_reopen_${orderId}`)
      .setLabel('🔓 Mở lại Ticket')
      .setStyle(ButtonStyle.Primary)
  );
}

// Select menu shown inside ticket, with spec summary in description
function ticketPlanSelectRow(type, products, orderDraftId) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ticket_plan_${orderDraftId}|${type}`)
    .setPlaceholder(`Choose a ${type} plan`)
    .addOptions(
      products.map(p => {
        const spec = JSON.parse(p.specJson);
        return {
          label: `${p.name} — ₹${(p.priceCents/100).toFixed(0)}/mo`,
          description: shortSpec(spec, type).slice(0, 100), // Discord limit
          value: p.sku
        };
      })
    );
  return new ActionRowBuilder().addComponents(menu);
}
function extrasModal(orderId) {
  return new ModalBuilder()
    .setCustomId(`extras_modal|${orderId}`)
    .setTitle('Final Details')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('server_name').setLabel('Server name / hostname').setStyle(TextInputStyle.Short).setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('notes').setLabel('Any notes / preferences').setStyle(TextInputStyle.Paragraph).setRequired(false)
      )
    );
}

async function handlePayUpi(i, prisma) {
// UPI button -> show UPI ID + attach local QR image
if (i.isButton() && i.customId.startsWith('pay_upi_')) {
  const orderId = i.customId.split('pay_upi_')[1];
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { ticket: true }
  });
  if (!order) return i.reply({ content: 'Order not found.', ephemeral: true });

  const upiId = process.env.UPI_ID || 'not-set@upi';

  // Resolve file path relative to src/bot.js -> ../assets/upi.png
  const qrPath = path.resolve(__dirname, '../assets/upi.png');

  // Sanity check
  if (!fs.existsSync(qrPath)) {
    console.error('UPI QR not found at:', qrPath);
    return i.reply({
      content: `UPI ID: \`${upiId}\`\n(QR image missing on server)`,
      ephemeral: true
    });
  }

  // Build embed with inline image from attachment
  const embed = new EmbedBuilder()
    .setTitle('Pay via UPI')
    .setDescription([
      'Pay manually using this UPI ID:',
      `\`${upiId}\``,
      '',
      'After payment, click **✅ I Paid** so staff can verify.'
    ].join('\n'))
    .setColor(0x2ECC71)
    .setImage('attachment://upi.png'); // bind the attached file to the embed image

  const files = [{ attachment: qrPath, name: 'upi.png' }];

  // Try ephemeral first (preferred), fall back to public message if needed
  try {
    await i.reply({ embeds: [embed], files, ephemeral: true });
  } catch (err) {
    console.warn('Ephemeral with file failed, falling back to channel message:', err);
    await i.reply({ content: 'Sharing UPI details here (ephemeral failed).', ephemeral: true }).catch(() => {});
    await i.channel.send({ content: `<@${i.user.id}>`, embeds: [embed], files });
  }
}
}
function staffTicketControls(orderId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`staff_close_${orderId}`)
      .setLabel('🔒 Close Ticket')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`staff_reopen_${orderId}`)
      .setLabel('🔓 Reopen Ticket')
      .setStyle(ButtonStyle.Secondary)
  );
}

function startExpiryReminderScheduler() {
  // run every hour (lightweight for SQLite)
  setInterval(async () => {
    try {
      const now = new Date();
const in3m = new Date(now.getTime() + 3 * 60 * 1000); // 3 minutes
const in4m = new Date(now.getTime() + 4 * 60 * 1000); // 4 minutes

const expiring = await prisma.subscription.findMany({
  where: {
    status: 'ACTIVE',
    remindedExpiry: false,
    currentPeriodEnd: { gte: in3m, lt: in4m }
  },
  include: { user: true, product: true }
});

      for (const sub of expiring) {
        try {
          const discordUser = await client.users.fetch(sub.user.discordId).catch(() => null);
          if (!discordUser) continue;

          const when = sub.currentPeriodEnd.toLocaleString('en-IN');
          const renewBtn = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`renew_sub_${sub.id}`)
              .setLabel('🔁 Renew Now')
              .setStyle(ButtonStyle.Primary)
          );

          const embed = new EmbedBuilder()
            .setTitle('Your plan is expiring soon')
            .setDescription([
              `**Product:** ${sub.product.name} (${sub.product.sku})`,
              `**Current period ends:** ${when}`,
              '',
              'Click **Renew Now** to start renewal in your server ticket.'
            ].join('\n'))
            .setColor(0xF39C12);

          await discordUser.send({ embeds: [embed], components: [renewBtn] }).catch(() => {});

          // mark reminded to avoid duplicates this period
          await prisma.subscription.update({
            where: { id: sub.id },
            data: { remindedExpiry: true }
          });
        } catch (e) {
          console.error('DM expiry reminder failed:', e);
        }
      }
    } catch (err) {
      console.error('Expiry reminder scheduler error:', err);
    }
  }, 60 * 60 * 1000); // hourly
}
//
// ----------- Ticket creation -----------
//
async function openTicketChannel(guild, user, orderNo) {
  const categoryId = process.env.TICKETS_CATEGORY_ID || null;
  const staffRoleId = process.env.STAFF_ROLE_ID;

  const overwrites = [
    { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
    { id: user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }
  ];

  if (staffRoleId) {
    overwrites.push({
      id: staffRoleId,
      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory]
    });
  }

  const channel = await guild.channels.create({
    name: `order-${orderNo}`.toLowerCase(),
    type: ChannelType.GuildText,
    parent: categoryId ?? undefined,
    permissionOverwrites: overwrites,
    reason: 'New order ticket'
  });

  return channel;
}

//
// ----------- Live Menu Sync Helper -----------
//
function getMenuData() {
  try {
    delete require.cache[require.resolve('./menuData')];
    const mod = require('./menuData');
    return typeof mod.loadData === 'function' ? mod.loadData() : mod;
  } catch (err) {
    console.error('Lỗi khi đọc menuData.js:', err);
    return require('./menuData');
  }
}

function getSellerForCategory(categoryKey) {
  const data = getMenuData();
  const cat = data.categories?.[categoryKey];
  const sellerKey = cat?.seller || 'shop_common';
  
  let seller = null;
  if (sellerKey && data.sellers?.[sellerKey]) {
    seller = { id: sellerKey, ...data.sellers[sellerKey] };
  } else if (sellerKey) {
    const found = Object.entries(data.sellers || {}).find(([k, s]) => s.discordId === sellerKey || k === sellerKey);
    if (found) seller = { id: found[0], ...found[1] };
  }
  
  if (!seller) {
    if (data.sellers?.['shop_common']) {
      seller = { id: 'shop_common', ...data.sellers['shop_common'] };
    } else {
      const firstEntry = Object.entries(data.sellers || {})[0];
      seller = firstEntry ? { id: firstEntry[0], ...firstEntry[1] } : null;
    }
  }

  // Parse handlers (multiple assigned sellers / ping targets)
  const rawHandlers = Array.isArray(cat?.handlers) && cat.handlers.length > 0
    ? cat.handlers
    : (cat?.seller ? [cat.seller] : []);

  const handlerIds = [];
  for (const h of rawHandlers) {
    if (!h || h === 'shop_common') continue;
    const sellerObj = data.sellers?.[h];
    const dId = sellerObj?.discordId || (/^\d{17,20}$/.test(h) ? h : null);
    if (dId && !handlerIds.includes(dId)) {
      handlerIds.push(dId);
    }
  }

  // If handlerIds is empty but seller has a real discordId, include it
  if (handlerIds.length === 0 && seller?.discordId && !seller.isShop) {
    handlerIds.push(seller.discordId);
  }

  return {
    seller,
    handlers: handlerIds,
    accountIndex: cat?.accountIndex !== undefined ? cat.accountIndex : 'all'
  };
}

function buildPaymentBlock(seller, orderCode, accountIndex = 'all', lang = 'vi') {
  const isEn = lang === 'en';
  const isShopCommon = seller?.isShop || seller?.id === 'shop_common' || !seller?.discordId;
  const sellerDiscordId = !isShopCommon && (seller?.discordId || (seller?.id && /^\d{17,20}$/.test(seller.id) ? seller.id : null));
  const sellerMention = sellerDiscordId ? `<@${sellerDiscordId}>` : '';
  const sellerDisplayName = seller?.username ? `@${seller.username}` : (seller?.name || '4AM STORE');
  
  const headerTitle = isShopCommon
    ? (isEn ? '💳 **PAYMENT INFORMATION — STORE (COMMON ACCOUNT):**' : '💳 **THÔNG TIN THANH TOÁN — CỬA HÀNG (STK CHUNG):**')
    : (isEn ? `💳 **PAYMENT INFORMATION — Seller: ${sellerMention || sellerDisplayName}**` : `💳 **THÔNG TIN THANH TOÁN — Người bán: ${sellerMention || sellerDisplayName}**`);

  let activeAccounts = seller?.accounts || [];
  if (accountIndex !== 'all' && accountIndex !== undefined && accountIndex !== '') {
    const idx = parseInt(accountIndex, 10);
    if (!isNaN(idx) && activeAccounts[idx]) {
      activeAccounts = [activeAccounts[idx]];
    }
  }

  if (!activeAccounts.length) {
    const bankName = process.env.BANK_NAME || 'MB Bank';
    const bankAccount = process.env.BANK_ACCOUNT || (isEn ? 'Not configured' : 'Chưa cấu hình');
    const bankOwner = process.env.BANK_OWNER || (isEn ? 'Not configured' : 'Chưa cấu hình');
    return [
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      headerTitle,
      `🏛️ **${isEn ? 'Bank' : 'Ngân hàng'}:** \`${bankName}\``,
      `🔢 **${isEn ? 'Account No' : 'Số tài khoản'}:** \`${bankAccount}\``,
      `👤 **${isEn ? 'Account Owner' : 'Chủ tài khoản'}:** \`${bankOwner}\``,
      `📝 **${isEn ? 'Payment Note' : 'Nội dung CK'}:** \`4AM ${orderCode}\``,
      isEn ? '*(Please use the exact payment note so staff can verify quickly)*' : '*(Vui lòng điền đúng nội dung để nhân viên đối soát nhanh nhất)*',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
    ].join('\n');
  }

  const accountLines = activeAccounts.map(acc => {
    const icon = acc.bank.toLowerCase().includes('momo') ? '📱' :
                 acc.bank.toLowerCase().includes('card') ? '💳' :
                 acc.bank.toLowerCase().includes('crypto') || acc.bank.toLowerCase().includes('ltc') || acc.bank.toLowerCase().includes('usdt') ? '🪙' : '🏛️';
    return `${icon} **${acc.bank}:** \`${acc.account}\` — **${acc.owner}**`;
  }).join('\n');

  return [
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    headerTitle,
    accountLines,
    `📝 **${isEn ? 'Payment Note' : 'Nội dung CK'}:** \`4AM ${orderCode}\``,
    isEn ? '*(Please use the exact payment note so staff can verify quickly)*' : '*(Vui lòng điền đúng nội dung để nhân viên đối soát nhanh nhất)*',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
  ].join('\n');
}

function buildMenuMessage(lang = null, targetTicketChannelId = null) {
  const data = getMenuData();
  const currentLang = lang || data.defaultLanguage || 'vi';
  const targetTicketId = targetTicketChannelId || (currentLang === 'en' ? (data.channels?.ticketEnChannelId || data.ticketChannelId) : (data.channels?.ticketViChannelId || data.ticketChannelId));
  const ticketMention = targetTicketId ? `<#${targetTicketId}>` : '#ticket';

  const defaultVi = {
    title: `BẢNG GIÁ CÁC MẶT HÀNG TẠI ${data.storeName || '4AM STORE'}`,
    line1: '• Xem Giá Sản Phẩm Bên Dưới Nhé !',
    line2: `• Khi chọn được mặt hàng ưng ý, bạn có thể tạo Ticket để mua hàng tại ${ticketMention}`,
    paymentTitle: '╰─ PHƯƠNG THỨC THANH TOÁN',
    paymentMethods: data.paymentMethods || 'Bank, Card, MoMo, Tsr, LTC',
    footerNote: 'Bảng giá không cố định, có thể thay đổi theo thời gian',
    placeholder: 'Đưa ra lựa chọn'
  };

  const defaultEn = {
    title: `PRICE LIST AT ${data.storeName || '4AM STORE'}`,
    line1: '• Check out product prices below!',
    line2: `• Once you find your desired item, create a ticket at ${ticketMention}`,
    paymentTitle: '╰─ PAYMENT METHODS',
    paymentMethods: data.paymentMethods || 'Bank Transfer, Crypto (LTC/USDT), Card',
    footerNote: 'Prices are not fixed and may change over time',
    placeholder: 'Select a product to view...'
  };

  const menuConf = (data.menuEmbed && data.menuEmbed[currentLang]) ? data.menuEmbed[currentLang] : (currentLang === 'en' ? defaultEn : defaultVi);

  const rawTitle = menuConf.title || (currentLang === 'en' ? defaultEn.title : defaultVi.title);
  const finalTitle = rawTitle.replace(/\{storeName\}/g, data.storeName || '4AM STORE');

  const descLines = [];
  const linesToUse = Array.isArray(menuConf.lines)
    ? menuConf.lines
    : [menuConf.line1, menuConf.line2].filter(Boolean);

  for (const line of linesToUse) {
    if (line && line.trim()) {
      const formatted = line
        .replace(/\{ticket\}/g, ticketMention)
        .replace(/\{storeName\}/g, data.storeName || '4AM STORE');
      descLines.push(formatted);
    }
  }

  if (menuConf.paymentTitle) descLines.push(menuConf.paymentTitle);
  if (menuConf.paymentMethods) {
    descLines.push('```');
    descLines.push(menuConf.paymentMethods);
    descLines.push('```');
  }
  if (menuConf.footerNote) descLines.push(`*${menuConf.footerNote}*`);

  let embedColor = 0x2B2D31;
  const rawColor = data.menuEmbed?.color;
  if (rawColor) {
    const cleanHex = rawColor.replace('#', '');
    const parsed = parseInt(cleanHex, 16);
    if (!isNaN(parsed)) embedColor = parsed;
  }

  const menuEmbed = new EmbedBuilder()
    .setTitle(finalTitle)
    .setDescription(descLines.join('\n'))
    .setColor(embedColor);

  const banner = data.menuEmbed?.bannerUrl !== undefined ? data.menuEmbed.bannerUrl : data.mainBannerUrl;
  if (banner && banner.trim()) {
    menuEmbed.setImage(banner.trim());
  }

  const logo = data.menuEmbed?.logoUrl !== undefined ? data.menuEmbed.logoUrl : data.logoUrl;
  if (logo && logo.trim()) {
    menuEmbed.setThumbnail(logo.trim());
  }

  const selectOptions = Object.entries(data.categories || {}).map(([key, cat]) => {
    let optEmoji = undefined;
    if (cat.emoji && typeof cat.emoji === 'string' && cat.emoji.trim()) {
      const trimmed = cat.emoji.trim();
      if (trimmed.startsWith('<')) {
        const parsed = parseEmoji(trimmed);
        if (parsed && (parsed.id || parsed.name)) {
          optEmoji = parsed;
        }
      } else {
        optEmoji = trimmed;
      }
    }
    return {
      label: (currentLang === 'en' && cat.labelEn) ? cat.labelEn : (cat.label || key),
      value: key,
      emoji: optEmoji
    };
  });

  const placeholderText = menuConf.placeholder || (currentLang === 'en' ? 'Select a product to view...' : 'Đưa ra lựa chọn');
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`select_store_category|${currentLang}`)
    .setPlaceholder(placeholderText)
    .addOptions(selectOptions.length ? selectOptions : [{ label: 'Trống / Empty', value: 'none' }]);

  const selectRow = new ActionRowBuilder().addComponents(selectMenu);

  const langButtonsRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('switch_menu_lang|vi')
      .setLabel('🇻🇳 Tiếng Việt')
      .setStyle(currentLang === 'vi' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('switch_menu_lang|en')
      .setLabel('🇬🇧 English')
      .setStyle(currentLang === 'en' ? ButtonStyle.Primary : ButtonStyle.Secondary)
  );

  return { embeds: [menuEmbed], components: [selectRow, langButtonsRow] };
}

/**
 * Tự động tạo và phân quyền hệ thống Server Song Ngữ
 * - Cụm 4AM: #『🌐』select-language (duy nhất cụm này công khai cho @everyone)
 * - Category ORDER: #『🛒』menu & #『🎟』ticket (@Tiếng Việt), #『🛒』menu-en & #『🎟』ticket-en (@English)
 * - Category DISCORD.GG/FOURAM: #『🇻🇳』vie・chat (@Tiếng Việt) & #『🌐』foreign・chat (@English)
 * - Kênh #『🫶』feedback: Cả 2 role đều xem & nhắn tin được
 * - Category TICKET: Chứa ticket mới của bot (ticket cũ chuyển sang OWOVN)
 * - Phân quyền ẩn tất cả các danh mục khác đối với @everyone
 */
async function setupBilingualServer(guild) {
  if (!guild) throw new Error('Không tìm thấy Server Discord (Guild).');

  const data = getMenuData();
  const staffRoleId = process.env.STAFF_ROLE_ID || '1472036681048658041';
  const botMember = guild.members.me || await guild.members.fetch(client.user.id);
  const everyoneRole = guild.roles.everyone;

  // 1. Roles: Find or create "@Tiếng Việt", "@English", and "Lucid Customer"
  let roleVi = guild.roles.cache.find(r => r.name === 'Tiếng Việt');
  if (!roleVi) {
    roleVi = await guild.roles.create({
      name: 'Tiếng Việt',
      color: 0xE74C3C,
      reason: 'Role hiển thị cụm kênh Tiếng Việt cho server song ngữ',
      mentionable: false
    });
  }

  let roleEn = guild.roles.cache.find(r => r.name === 'English');
  if (!roleEn) {
    roleEn = await guild.roles.create({
      name: 'English',
      color: 0x3498DB,
      reason: 'Role hiển thị cụm kênh English cho server song ngữ',
      mentionable: false
    });
  }

  // Customer Role: Lucid Customer (role khách hàng cơ bản khi mua hàng)
  let roleLucid = guild.roles.cache.find(r => r.name === 'Lucid Customer');
  if (!roleLucid) {
    roleLucid = await guild.roles.create({
      name: 'Lucid Customer',
      color: 0x636E72,
      hoist: true,
      reason: 'Role khách hàng mua lần đầu tại shop',
      mentionable: false
    });
  }

  // Helper to find or create a text channel inside a category
  async function getOrCreateTextChannel(name, parentCat, overwrites) {
    let ch = null;
    if (parentCat) {
      ch = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.parentId === parentCat.id && c.name.toLowerCase() === name.toLowerCase());
    }
    if (!ch) {
      ch = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name.toLowerCase() === name.toLowerCase());
    }
    if (!ch) {
      ch = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: parentCat ? parentCat.id : undefined,
        permissionOverwrites: overwrites
      });
    } else {
      if (parentCat && ch.parentId !== parentCat.id) {
        await ch.setParent(parentCat.id, { lockPermissions: false }).catch(() => {});
      }
      if (overwrites && overwrites.length) {
        await ch.permissionOverwrites.set(overwrites).catch(() => {});
      }
    }
    return ch;
  }

  // 2. ENTRY CHANNEL: #『🌐』select-language inside Category 4AM
  const cat4AM = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.toLowerCase().includes('4am'));
  const selectLangOverwrites = [
    { id: everyoneRole.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory], deny: [PermissionsBitField.Flags.SendMessages] },
    { id: botMember.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.EmbedLinks, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ManageMessages] }
  ];
  const welcomeChannel = await getOrCreateTextChannel('『🌐』select-language', cat4AM, selectLangOverwrites);

  if (cat4AM) {
    await cat4AM.permissionOverwrites.edit(everyoneRole.id, { ViewChannel: true }).catch(() => {});
  }

  // Delete legacy category ─── 🌐 WELCOME ─── if exists
  const catWelcome = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.includes('WELCOME'));
  if (catWelcome) await catWelcome.delete().catch(() => {});

  const welcomeEmbed = new EmbedBuilder()
    .setTitle(`🌐 SELECT YOUR LANGUAGE / CHỌN NGÔN NGỮ — ${data.storeName || '4AM STORE'}`)
    .setDescription([
      '👋 **Chào mừng bạn đến với server! / Welcome to our server!**',
      '',
      'Vui lòng chọn ngôn ngữ bên dưới để mở khóa các kênh mua hàng & hỗ trợ tương ứng.',
      'Please select your preferred language below to unlock store and support channels.',
      '',
      '🇻🇳 **Tiếng Việt:** Bấm nút màu xanh lá bên dưới để mở cụm kênh tiếng Việt.',
      '🇬🇧 **English:** Click the blue button below to access English channels.'
    ].join('\n'))
    .setColor(0x5865F2);

  if (data.logoUrl) welcomeEmbed.setThumbnail(data.logoUrl);

  const langRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('role_lang_vi')
      .setLabel('🇻🇳 Tiếng Việt')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('role_lang_en')
      .setLabel('🇬🇧 English')
      .setStyle(ButtonStyle.Primary)
  );

  try {
    const fetched = await welcomeChannel.messages.fetch({ limit: 10 });
    const botMsgs = fetched.filter(m => m.author.id === client.user.id);
    for (const m of botMsgs.values()) {
      await m.delete().catch(() => {});
    }
  } catch (_) {}
  await welcomeChannel.send({ embeds: [welcomeEmbed], components: [langRow] });

  // 3. Category ORDER (all uppercase, no emoji)
  let catOrder = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === 'ORDER');
  const catViOld = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.includes('TIẾNG VIỆT'));
  if (!catOrder && catViOld) {
    catOrder = await catViOld.setName('ORDER');
  } else if (!catOrder) {
    catOrder = await guild.channels.create({
      name: 'ORDER',
      type: ChannelType.GuildCategory
    });
  }

  // Category ORDER permissions
  await catOrder.permissionOverwrites.set([
    { id: everyoneRole.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    { id: roleVi.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory] },
    { id: roleEn.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory] },
    { id: staffRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageMessages] },
    { id: botMember.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.EmbedLinks, PermissionsBitField.Flags.ManageChannels] }
  ]);

  // Unified Menu channel (single channel with interactive language toggle, visible to BOTH @Tiếng Việt and @English)
  const menuOverwrites = [
    { id: everyoneRole.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    { id: roleVi.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory], deny: [PermissionsBitField.Flags.SendMessages] },
    { id: roleEn.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory], deny: [PermissionsBitField.Flags.SendMessages] },
    { id: botMember.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.EmbedLinks, PermissionsBitField.Flags.ManageChannels] },
    { id: staffRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }
  ];
  const menuViChannel = await getOrCreateTextChannel('『🛒』menu', catOrder, menuOverwrites);

  // Ticket VI (only visible to @Tiếng Việt)
  const ticketViOverwrites = [
    { id: everyoneRole.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    { id: roleVi.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory], deny: [PermissionsBitField.Flags.SendMessages] },
    { id: roleEn.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    { id: botMember.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.EmbedLinks, PermissionsBitField.Flags.ManageChannels] },
    { id: staffRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }
  ];
  const tpChans = data.ticketPanel || {};
  const ticketViChannelName = tpChans.channelNameVi || '『🎟』ticket-support';
  const ticketViChannel = await getOrCreateTextChannel(ticketViChannelName, catOrder, ticketViOverwrites);

  // Ticket EN (only visible to @English)
  const ticketEnOverwrites = [
    { id: everyoneRole.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    { id: roleEn.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory], deny: [PermissionsBitField.Flags.SendMessages] },
    { id: roleVi.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    { id: botMember.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.EmbedLinks, PermissionsBitField.Flags.ManageChannels] },
    { id: staffRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }
  ];
  const ticketEnChannelName = tpChans.channelNameEn || '『🎟』ticket-support-en';
  const ticketEnChannel = await getOrCreateTextChannel(ticketEnChannelName, catOrder, ticketEnOverwrites);

  // Delete redundant menu-en channel if exists (as requested: only 1 menu channel needed)
  const tempMenuEn = guild.channels.cache.find(c => c.name === '『🛒』menu-en');
  if (tempMenuEn) await tempMenuEn.delete().catch(() => {});

  // Delete redundant temp channels and categories
  const tempChatVi = guild.channels.cache.find(c => c.name === '『💬』chat-vi');
  if (tempChatVi) await tempChatVi.delete().catch(() => {});
  const tempChatEn = guild.channels.cache.find(c => c.name === '『💬』chat-en');
  if (tempChatEn) await tempChatEn.delete().catch(() => {});

  const catEnOld = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.includes('ENGLISH ZONE'));
  if (catEnOld) await catEnOld.delete().catch(() => {});
  const catTicketsExtra = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.includes('TICKETS') && c.name.includes('───'));
  if (catTicketsExtra) await catTicketsExtra.delete().catch(() => {});

  // 4. Configure DISCORD.GG/FOURAM Category
  const catFouram = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.includes('FOURAM'));
  if (catFouram) {
    await catFouram.permissionOverwrites.set([
      { id: everyoneRole.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: roleVi.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
      { id: roleEn.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
      { id: botMember.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels] }
    ]);

    const chVieChat = guild.channels.cache.find(c => c.name.includes('vie・chat'));
    if (chVieChat) {
      await chVieChat.permissionOverwrites.set([
        { id: everyoneRole.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: roleVi.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles, PermissionsBitField.Flags.EmbedLinks] },
        { id: roleEn.id, deny: [PermissionsBitField.Flags.ViewChannel] }
      ]);
    }

    const chForeignChat = guild.channels.cache.find(c => c.name.includes('foreign・chat'));
    if (chForeignChat) {
      await chForeignChat.permissionOverwrites.set([
        { id: everyoneRole.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: roleEn.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles, PermissionsBitField.Flags.EmbedLinks] },
        { id: roleVi.id, deny: [PermissionsBitField.Flags.ViewChannel] }
      ]);
    }
  }

  // 5. Feedback channel
  const chFeedback = guild.channels.cache.find(c => c.name.includes('feedback'));
  if (chFeedback) {
    await chFeedback.permissionOverwrites.set([
      { id: everyoneRole.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: roleVi.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.SendMessages] },
      { id: roleEn.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.SendMessages] }
    ]);
  }

  // 6. Category TICKET for new tickets & move old tickets to OWOVN
  const catTicketTarget = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === 'TICKET') ||
                          guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.id === '1441078154239410206');
  const catOwovn = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.includes('OWOVN'));

  if (catTicketTarget && catOwovn) {
    const oldTickets = guild.channels.cache.filter(c => c.parentId === catTicketTarget.id && c.type === ChannelType.GuildText);
    for (const t of oldTickets.values()) {
      await t.setParent(catOwovn.id, { lockPermissions: false }).catch(() => {});
    }

    await catTicketTarget.permissionOverwrites.set([
      { id: everyoneRole.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: staffRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageMessages, PermissionsBitField.Flags.ReadMessageHistory] },
      { id: botMember.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ManageMessages] }
    ]);
  }

  // 7. Lock all other categories & channels from @everyone (Channel-level security)
  const communityCatNames = ['28 . 06 . 2025', 'DISCORD.GG/FOURAM', 'SERVICE', 'GIVEAWAY', 'Auction', 'PARTNER 🤝', 'TICKET & VOUCH'];
  const allCategories = guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory);
  for (const cat of allCategories.values()) {
    if (cat.id === cat4AM?.id) continue;
    await cat.permissionOverwrites.edit(everyoneRole.id, { ViewChannel: false }).catch(() => {});
    if (communityCatNames.some(n => cat.name.includes(n))) {
      await cat.permissionOverwrites.edit(roleVi.id, { ViewChannel: true, ReadMessageHistory: true }).catch(() => {});
      await cat.permissionOverwrites.edit(roleEn.id, { ViewChannel: true, ReadMessageHistory: true }).catch(() => {});
    }
  }

  // Ensure channel-level overrides don't leak to @everyone and separate languages cleanly
  const allChannels = await guild.channels.fetch();
  const viOnlyKeywords = ['vie・chat', '『🇻🇳』4am', '『📜』rule', '『📜』tos', '『🔔』announcement', '『❓』faq', 'role・info'];
  const enOnlyKeywords = ['foreign・chat', 'about-us', 'rules-en', 'tos-en', 'announcement-en', 'faq-en', 'role・info-en', 'role-info-en'];

  for (const [, ch] of allChannels) {
    if (!ch || ch.type === ChannelType.GuildCategory) continue;

    // Special handling for 4AM category
    if (cat4AM && ch.parentId === cat4AM.id) {
      if (ch.name.includes('select-language')) {
        await ch.permissionOverwrites.edit(everyoneRole.id, { ViewChannel: true, ReadMessageHistory: true }).catch(() => {});
      } else if (ch.name.includes('about-us')) {
        await ch.permissionOverwrites.edit(everyoneRole.id, { ViewChannel: false }).catch(() => {});
        await ch.permissionOverwrites.edit(roleEn.id, { ViewChannel: true, ReadMessageHistory: true }).catch(() => {});
        await ch.permissionOverwrites.edit(roleVi.id, { ViewChannel: false }).catch(() => {});
      } else if (ch.name.includes('4am')) {
        await ch.permissionOverwrites.edit(everyoneRole.id, { ViewChannel: false }).catch(() => {});
        await ch.permissionOverwrites.edit(roleVi.id, { ViewChannel: true, ReadMessageHistory: true }).catch(() => {});
        await ch.permissionOverwrites.edit(roleEn.id, { ViewChannel: false }).catch(() => {});
      }
      continue;
    }

    // Deny ViewChannel on the channel itself for @everyone
    await ch.permissionOverwrites.edit(everyoneRole.id, { ViewChannel: false }).catch(() => {});

    // For community channels, grant view to roleVi & roleEn based on language keywords
    const parentName = ch.parent ? ch.parent.name : '';
    if (communityCatNames.some(name => parentName.includes(name))) {
      const lowerName = ch.name.toLowerCase();
      const isViOnly = viOnlyKeywords.some(k => lowerName.includes(k.toLowerCase()) && !lowerName.includes('-en'));
      const isEnOnly = enOnlyKeywords.some(k => lowerName.includes(k.toLowerCase()));

      if (isViOnly) {
        const canSend = lowerName.includes('vie・chat');
        await ch.permissionOverwrites.edit(roleVi.id, { ViewChannel: true, ReadMessageHistory: true, SendMessages: canSend }).catch(() => {});
        await ch.permissionOverwrites.edit(roleEn.id, { ViewChannel: false }).catch(() => {});
      } else if (isEnOnly) {
        const canSend = lowerName.includes('foreign・chat');
        await ch.permissionOverwrites.edit(roleEn.id, { ViewChannel: true, ReadMessageHistory: true, SendMessages: canSend }).catch(() => {});
        await ch.permissionOverwrites.edit(roleVi.id, { ViewChannel: false }).catch(() => {});
      } else {
        await ch.permissionOverwrites.edit(roleVi.id, { ViewChannel: true, ReadMessageHistory: true }).catch(() => {});
        await ch.permissionOverwrites.edit(roleEn.id, { ViewChannel: true, ReadMessageHistory: true }).catch(() => {});
      }
    }
  }

  // 8. Save channels into menuData
  data.channels = {
    welcomeChannelId: welcomeChannel.id,
    menuViChannelId: menuViChannel.id,
    ticketViChannelId: ticketViChannel.id,
    ticketEnChannelId: ticketEnChannel.id,
    ticketCategoryId: catTicketTarget?.id || '1441078154239410206',
    orderCategoryId: catOrder.id,
    roleViId: roleVi.id,
    roleEnId: roleEn.id,
    customerRoleId: roleLucid.id
  };
  data.bilingualRoles = {
    vi: roleVi.id,
    en: roleEn.id
  };
  data.menuChannelId = menuViChannel.id;
  data.ticketChannelId = ticketViChannel.id;

  const menuMod = require('./menuData');
  menuMod.saveData(data);

  // 9. Synchronize unified menu and tickets
  await syncMenuChannel(menuViChannel.id, data.defaultLanguage || 'vi');
  await syncTicketChannel(ticketViChannel.id, 'vi');
  await syncTicketChannel(ticketEnChannel.id, 'en');

  return {
    ok: true,
    roles: { vi: roleVi, en: roleEn },
    categories: { fouram: cat4AM, order: catOrder, ticket: catTicketTarget },
    channels: {
      welcome: welcomeChannel,
      menuVi: menuViChannel,
      ticketVi: ticketViChannel,
      ticketEn: ticketEnChannel
    }
  };
}

async function syncMenuChannel(targetChannelId = null, targetLang = null) {
  const data = getMenuData();
  const menuChannelId = targetChannelId || data.channels?.menuViChannelId || process.env.MENU_CHANNEL_ID;
  if (!menuChannelId) {
    console.warn('⚠️ MENU_CHANNEL_ID chưa được cấu hình');
    return;
  }
  const channel = await client.channels.fetch(menuChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn(`⚠️ Không tìm thấy kênh text với ID: ${menuChannelId}`);
    return;
  }

  const langToUse = targetLang || data.defaultLanguage || 'vi';
  const targetTicketId = (langToUse === 'en') ? (data.channels?.ticketEnChannelId || data.ticketChannelId) : (data.channels?.ticketViChannelId || data.ticketChannelId);
  const messageData = buildMenuMessage(langToUse, targetTicketId);

  // Dọn dẹp tin nhắn cũ của bot trong kênh Menu để tránh bị spam / trôi
  try {
    const fetched = await channel.messages.fetch({ limit: 30 });
    const botMsgs = fetched.filter(m => m.author.id === client.user.id);
    for (const m of botMsgs.values()) {
      await m.delete().catch(() => {});
    }
  } catch (err) {
    console.error('Lỗi khi xóa tin nhắn menu cũ:', err);
  }

  await channel.send(messageData);
  console.log(`✅ Đã đồng bộ bảng giá vào kênh #${channel.name} (${langToUse.toUpperCase()})`);
}

async function syncTicketChannel(targetChannelId = null, targetLang = null) {
  const data = getMenuData();
  const ticketChannelId = targetChannelId || data.channels?.ticketViChannelId || process.env.TICKET_PANEL_CHANNEL_ID || '1379348256743489546';
  const channel = await client.channels.fetch(ticketChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const isEn = (targetLang === 'en');
  const tp = data.ticketPanel || {};
  const langConf = isEn ? (tp.en || {}) : (tp.vi || {});
  const storeName = data.storeName || '4AM STORE';

  // 1. Rename channel if desired name is configured and different
  const desiredChannelName = isEn
    ? (tp.channelNameEn || '『🎟』ticket-support-en')
    : (tp.channelNameVi || '『🎟』ticket-support');
  if (channel.name !== desiredChannelName && typeof channel.setName === 'function') {
    try {
      await channel.setName(desiredChannelName);
      console.log(`🏷️ Đã đổi tên kênh ticket trên Discord thành: #${desiredChannelName}`);
    } catch (e) {
      console.warn(`Không thể đổi tên kênh #${channel.name}:`, e.message);
    }
  }

  // 2. Build Title & Description
  const rawTitle = langConf.title || (isEn ? '🎟️ SUPPORT & ORDER CENTER — {storeName}' : '🎟️ TRUNG TÂM HỖ TRỢ & MUA HÀNG — {storeName}');
  const embedTitle = rawTitle.replace(/\{storeName\}/g, storeName);

  let descLines = [];
  if (langConf.subtitle) {
    descLines.push(langConf.subtitle.replace(/\{storeName\}/g, storeName));
    descLines.push('');
  }
  if (Array.isArray(langConf.lines) && langConf.lines.length > 0) {
    langConf.lines.forEach(l => {
      if (l && l.trim()) descLines.push(l.trim().replace(/\{storeName\}/g, storeName));
    });
  } else {
    // Fallback default lines
    if (isEn) {
      descLines.push('Welcome to **' + storeName + '** official support center!');
      descLines.push('');
      descLines.push('• Order services: **Discord Nitro, Server Boosts, Spotify, Netflix, VPS, Bot Hosting**...');
      descLines.push('• Technical support, order inquiries, or warranty.');
      descLines.push('');
      descLines.push('👉 Click the **"🎟️ Open Support Ticket"** button below to start a private chat with our 24/7 staff!');
    } else {
      descLines.push('Chào mừng bạn đến với hệ thống hỗ trợ của **' + storeName + '**!');
      descLines.push('');
      descLines.push('• Mua các dịch vụ **Discord Nitro, Boost Server, Spotify, Youtube, Netflix, VPS, Bot Hosting**...');
      descLines.push('• Hỗ trợ kỹ thuật, kiểm tra đơn hàng hoặc bảo hành.');
      descLines.push('');
      descLines.push('👉 Bấm nút **"🎟️ Mở Ticket Hỗ Trợ"** bên dưới để tạo kênh chat riêng với Staff 24/7!');
    }
  }

  let embedColor = 0x5865F2;
  if (tp.color) {
    try {
      embedColor = parseInt(tp.color.replace('#', ''), 16) || 0x5865F2;
    } catch (_) {}
  }

  const embed = new EmbedBuilder()
    .setTitle(embedTitle)
    .setDescription(descLines.join('\n'))
    .setColor(embedColor);

  const thumbUrl = tp.thumbnailUrl || (!data.logoUrl?.includes('imgur.com/4iB2Q2K') ? data.logoUrl : null);
  if (thumbUrl && thumbUrl.trim() && /^https?:\/\//i.test(thumbUrl.trim())) {
    embed.setThumbnail(thumbUrl.trim());
  }

  if (tp.bannerUrl && tp.bannerUrl.trim() && /^https?:\/\//i.test(tp.bannerUrl.trim())) {
    embed.setImage(tp.bannerUrl.trim());
  }

  const btnLabel = langConf.buttonLabel || (isEn ? '🎟️ Open Support Ticket' : '🎟️ Mở Ticket Hỗ Trợ');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(isEn ? 'create_general_ticket|en' : 'create_general_ticket|vi')
      .setLabel(btnLabel)
      .setStyle(ButtonStyle.Success)
  );

  try {
    const fetched = await channel.messages.fetch({ limit: 20 });
    const botMsgs = fetched.filter(m => m.author.id === client.user.id);
    for (const m of botMsgs.values()) {
      await m.delete().catch(() => {});
    }
  } catch (_) {}

  await channel.send({ embeds: [embed], components: [row] });
  console.log(`✅ Đã đồng bộ ticket panel vào kênh #${channel.name} (${isEn ? 'EN' : 'VI'})`);

  // Nếu sync mặc định (không truyền targetChannelId) và có kênh ticket tiếng Anh riêng, tự động sync luôn EN!
  if (!targetChannelId && data.channels?.ticketEnChannelId && data.channels.ticketEnChannelId !== ticketChannelId) {
    await syncTicketChannel(data.channels.ticketEnChannelId, 'en');
  }
}

//
// ----------- Events -----------
//

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await seedCatalog();
  console.log('Catalog seeded ✅');
  await syncMenuChannel();
  await syncTicketChannel();
});


client.on('interactionCreate', async (i) => {
  // --- Role Assignment: Bilingual Selection (Mô hình 1) ---
  if (i.isButton() && (i.customId === 'role_lang_vi' || i.customId === 'role_lang_en')) {
    await i.deferReply({ ephemeral: true });
    const isEnChoice = i.customId === 'role_lang_en';
    const data = getMenuData();
    const guild = i.guild || await client.guilds.fetch(process.env.GUILD_ID);
    const member = await guild.members.fetch(i.user.id).catch(() => null);
    if (!member) {
      return i.editReply({ content: isEnChoice ? '❌ Could not find member information.' : '❌ Không tìm thấy thông tin thành viên.' });
    }

    const roleViId = data.channels?.roleViId || data.bilingualRoles?.vi || guild.roles.cache.find(r => r.name === 'Tiếng Việt')?.id;
    const roleEnId = data.channels?.roleEnId || data.bilingualRoles?.en || guild.roles.cache.find(r => r.name === 'English')?.id;

    if (isEnChoice) {
      if (roleViId && member.roles.cache.has(roleViId)) {
        await member.roles.remove(roleViId).catch(() => {});
      }
      if (roleEnId) {
        await member.roles.add(roleEnId).catch(() => {});
      }
      return i.editReply({
        content: '🇬🇧 **Language set to English!**\nYou now have access to the **─── 🇬🇧 ENGLISH ZONE ───** channels. Enjoy shopping!'
      });
    } else {
      if (roleEnId && member.roles.cache.has(roleEnId)) {
        await member.roles.remove(roleEnId).catch(() => {});
      }
      if (roleViId) {
        await member.roles.add(roleViId).catch(() => {});
      }
      return i.editReply({
        content: '🇻🇳 **Đã chuyển sang Tiếng Việt!**\nBạn đã mở khóa toàn bộ danh mục **─── 🇻🇳 TIẾNG VIỆT ───**. Chúc bạn mua sắm vui vẻ!'
      });
    }
  }

  // --- Switch Menu Language (VI / EN) ---
  if (i.isButton() && i.customId.startsWith('switch_menu_lang|')) {
    const newLang = i.customId.split('|')[1] || 'vi';
    const menuMsg = buildMenuMessage(newLang);
    await i.update(menuMsg).catch(() => {});
    return;
  }

  // --- Sapphire Menu Dropdown Select ---
  if (i.isStringSelectMenu() && i.customId.startsWith('select_store_category')) {
    const parts = i.customId.split('|');
    const lang = parts[1] || 'vi';
    const isEn = lang === 'en';
    const selectedKey = i.values[0];
    const data = getMenuData();
    const cat = data.categories?.[selectedKey];
    if (!cat) {
      return i.reply({ content: isEn ? '❌ Category information not found.' : '❌ Không tìm thấy thông tin cho danh mục này.', ephemeral: true });
    }

    const items = (isEn && cat.itemsEn && cat.itemsEn.length) ? cat.itemsEn : (cat.items || []);
    const itemsList = items.map(item => `• ${item}`).join('\n');
    const catTitle = isEn ? (cat.titleEn || `Price List - ${cat.labelEn || cat.label}`) : (cat.title || `Bảng Giá ${cat.label}`);
    const catSubtitle = isEn ? (cat.subtitleEn || (cat.labelEn || cat.label).toUpperCase() + ':') : (cat.subtitle || cat.label.toUpperCase() + ':');

    const { seller, handlers } = getSellerForCategory(selectedKey);
    const allHandlerIds = (handlers && handlers.length > 0) ? handlers : (seller?.discordId ? [seller.discordId] : []);
    
    let handlerLine = '';
    if (allHandlerIds.length > 0) {
      const handlerTags = allHandlerIds.map(h => `<@${h}>`).join(', ');
      handlerLine = isEn ? `👤 **Staff in charge:** ${handlerTags}` : `👤 **Người phụ trách:** ${handlerTags}`;
    } else {
      handlerLine = isEn ? `👤 **Staff in charge:** Staff 24/7` : `👤 **Người phụ trách:** Staff 24/7`;
    }

    const descParts = [
      `${cat.emoji ? `${cat.emoji} ` : ''}**${catSubtitle}**`,
      handlerLine,
      itemsList
    ].filter(Boolean);

    const catEmbed = new EmbedBuilder()
      .setTitle(catTitle)
      .setDescription(descParts.join('\n\n'))
      .setColor(cat.color || 0x5865F2);

    if (cat.bannerUrl) {
      catEmbed.setImage(cat.bannerUrl);
    }

    const buyButton = new ButtonBuilder()
      .setCustomId(`create_ticket_from_menu|${selectedKey}|${lang}`)
      .setLabel(isEn ? `🎟️ Open Ticket to buy ${cat.labelEn || cat.label}` : `🎟️ Mở Ticket mua ${cat.label}`)
      .setStyle(ButtonStyle.Primary);

    const buttonRow = new ActionRowBuilder().addComponents(buyButton);

    return i.reply({ embeds: [catEmbed], components: [buttonRow], ephemeral: true });
  }

  // --- Create Ticket From Menu Button ---
  if (i.isButton() && i.customId.startsWith('create_ticket_from_menu|')) {
    const parts = i.customId.split('|');
    const categoryKey = parts[1];
    const lang = parts[2] || 'vi';
    const isEn = lang === 'en';
    const data = getMenuData();
    const cat = data.categories?.[categoryKey] || { label: 'Dịch vụ', color: 0x5865F2 };

    const staffRoleId = process.env.STAFF_ROLE_ID;
    const member = await i.guild.members.fetch(i.user.id);
    const isStaff = member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
                    (staffRoleId && member.roles.cache.has(staffRoleId));

    if (!isStaff) {
      const gate = canOpenTicket(i.user.id);
      if (!gate.ok) {
        return i.reply({
          content: isEn
            ? `⏳ Please wait **${gate.waitMin} minutes** before opening another ticket. (Cooldown: ${TICKET_COOLDOWN_MIN} min)`
            : `⏳ Bạn vui lòng chờ thêm **${gate.waitMin} phút** trước khi tạo ticket tiếp theo. (Giới hạn: ${TICKET_COOLDOWN_MIN} phút)`,
          ephemeral: true
        });
      }
    }

    await i.deferReply({ ephemeral: true });

    const guild = i.guild || await client.guilds.fetch(process.env.GUILD_ID);
    const orderDraftNo = shortOrderNo();
    const ticketCategoryId = data.channels?.ticketCategoryId || process.env.TICKETS_CATEGORY_ID || null;

    const { seller, handlers, accountIndex } = getSellerForCategory(categoryKey);
    const isShopCommon = seller?.isShop || seller?.id === 'shop_common' || !seller?.discordId;
    const sellerDiscordId = !isShopCommon && (seller?.discordId || (seller?.id && /^\d{17,20}$/.test(seller.id) ? seller.id : null));

    const overwrites = [
      { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: i.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles, PermissionsBitField.Flags.EmbedLinks] }
    ];

    if (staffRoleId) {
      overwrites.push({
        id: staffRoleId,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles, PermissionsBitField.Flags.EmbedLinks, PermissionsBitField.Flags.ManageMessages]
      });
    }

    // Grant channel view and chat permissions to all assigned handlers
    const allHandlerIds = (handlers && handlers.length > 0) ? handlers : (sellerDiscordId ? [sellerDiscordId] : []);
    for (const hId of allHandlerIds) {
      if (hId && hId !== i.user.id && hId !== staffRoleId && !overwrites.some(o => o.id === hId)) {
        overwrites.push({
          id: hId,
          allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles, PermissionsBitField.Flags.EmbedLinks, PermissionsBitField.Flags.ManageMessages]
        });
      }
    }

    const cleanLabel = ((isEn && cat.labelEn) ? cat.labelEn : (cat.label || 'service')).toLowerCase().replace(/[^a-z0-9]/g, '-');
    const channelName = `ticket-${cleanLabel}-${orderDraftNo}`.toLowerCase();
    const ticketChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: ticketCategoryId ?? undefined,
      permissionOverwrites: overwrites,
      reason: `Ticket mua ${cat.label} tạo bởi ${i.user.tag}`
    });

    if (!isStaff) markTicketOpened(i.user.id);

    const paymentBlock = buildPaymentBlock(seller, orderDraftNo, accountIndex, lang);

    let supportMsg = '';
    if (allHandlerIds.length > 1) {
      const tags = allHandlerIds.map(h => `<@${h}>`).join(' & ');
      supportMsg = isEn
        ? `👥 Assigned handlers: ${tags} will assist you directly with this order.`
        : `👥 Người phụ trách hỗ trợ: ${tags} sẽ trực tiếp hỗ trợ bạn đơn hàng này.`;
    } else if (allHandlerIds.length === 1) {
      supportMsg = isEn
        ? `👤 Assigned seller: <@${allHandlerIds[0]}> will assist you directly with this order.`
        : `👤 Người bán phụ trách: <@${allHandlerIds[0]}> sẽ trực tiếp hỗ trợ bạn đơn hàng này.`;
    } else if (staffRoleId) {
      supportMsg = isEn
        ? `Support staff <@&${staffRoleId}> will be right here to assist you.`
        : `Nhân viên hỗ trợ <@&${staffRoleId}> sẽ có mặt ngay để tư vấn cho bạn.`;
    }

    const welcomeEmbed = new EmbedBuilder()
      .setTitle(isEn ? `🎟️ ORDER TICKET — ${((isEn && cat.labelEn) ? cat.labelEn : cat.label).toUpperCase()}` : `🎟️ TICKET MUA HÀNG — ${cat.label.toUpperCase()}`)
      .setDescription([
        isEn
          ? `Hello <@${i.user.id}>! Thank you for your interest in **${cat.labelEn || cat.label}** at **${data.storeName || '4AM STORE'}**.`
          : `Xin chào <@${i.user.id}>! Cảm ơn bạn đã quan tâm đến **${cat.label}** tại **${data.storeName || '4AM STORE'}**.`,
        supportMsg,
        '',
        isEn ? `📦 **Product of interest:** **${cat.labelEn || cat.label}**` : `📦 **Dịch vụ quan tâm:** **${cat.label}**`,
        paymentBlock,
        isEn
          ? '💬 *Please specify the package or plan you want (e.g., duration, quantity) in this channel so staff/seller can assist you right away!*'
          : '💬 *Vui lòng nhắn rõ gói bạn muốn mua (ví dụ thời hạn, số lượng) tại kênh này để Staff/Seller hỗ trợ nhanh nhất nhé!*'
      ].filter(Boolean).join('\n'))
      .setColor(cat.color || 0x00C2A8)
      .setFooter({ text: isEn ? '4AM Shop • 24/7 Support' : '4AM Shop • Hỗ trợ 24/7' })
      .setTimestamp();

    // Specific QR code for selected account
    let selectedQr = null;
    if (accountIndex !== 'all' && accountIndex !== undefined && seller?.accounts?.[parseInt(accountIndex, 10)]?.qr) {
      selectedQr = seller.accounts[parseInt(accountIndex, 10)].qr;
    } else {
      const qrAcc = seller?.accounts?.find(a => a.qr);
      selectedQr = qrAcc?.qr || process.env.BANK_QR;
    }
    if (selectedQr) {
      welcomeEmbed.setImage(selectedQr);
    }

    const ticketButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('close_simple_ticket')
        .setLabel(isEn ? '🔒 Close Ticket' : '🔒 Đóng Ticket')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`show_seller_selector|${orderDraftNo}`)
        .setLabel(isEn ? '💳 Switch Bank Account' : '💳 Đổi STK người bán khác')
        .setStyle(ButtonStyle.Secondary)
    );

    const mentions = [`<@${i.user.id}>`];
    for (const hId of allHandlerIds) {
      if (hId && hId !== i.user.id && !mentions.includes(`<@${hId}>`)) {
        mentions.push(`<@${hId}>`);
      }
    }
    if (staffRoleId && !mentions.includes(`<@&${staffRoleId}>`)) {
      mentions.push(`<@&${staffRoleId}>`);
    }

    await ticketChannel.send({
      content: mentions.join(' '),
      embeds: [welcomeEmbed],
      components: [ticketButtons]
    });

    return i.editReply({ content: isEn ? `✅ Created purchase ticket for **${cat.labelEn || cat.label}** at: <#${ticketChannel.id}>` : `✅ Đã tạo Ticket hỗ trợ mua **${cat.label}** tại: <#${ticketChannel.id}>` });
  }

  // --- Create General Ticket (From Ticket Channel Panel) ---
  if (i.isButton() && i.customId.startsWith('create_general_ticket')) {
    const parts = i.customId.split('|');
    const lang = parts[1] || 'vi';
    const isEn = lang === 'en';
    const data = getMenuData();
    const staffRoleId = process.env.STAFF_ROLE_ID;
    const member = await i.guild.members.fetch(i.user.id);
    const isStaff = member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
                    (staffRoleId && member.roles.cache.has(staffRoleId));

    if (!isStaff) {
      const gate = canOpenTicket(i.user.id);
      if (!gate.ok) {
        return i.reply({
          content: isEn
            ? `⏳ Please wait **${gate.waitMin} minutes** before opening another ticket. (Cooldown: ${TICKET_COOLDOWN_MIN} min)`
            : `⏳ Bạn vui lòng chờ thêm **${gate.waitMin} phút** trước khi tạo ticket tiếp theo. (Giới hạn: ${TICKET_COOLDOWN_MIN} phút)`,
          ephemeral: true
        });
      }
    }

    await i.deferReply({ ephemeral: true });

    const guild = i.guild || await client.guilds.fetch(process.env.GUILD_ID);
    const orderDraftNo = shortOrderNo();
    const ticketCategoryId = data.channels?.ticketCategoryId || process.env.TICKETS_CATEGORY_ID || null;

    const defaultSeller = data.sellers?.['admin'] || Object.values(data.sellers || {})[0];
    const sellerDiscordId = defaultSeller?.discordId || (defaultSeller?.id && /^\d{17,20}$/.test(defaultSeller.id) ? defaultSeller.id : null);

    const overwrites = [
      { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: i.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles, PermissionsBitField.Flags.EmbedLinks] }
    ];

    if (staffRoleId) {
      overwrites.push({
        id: staffRoleId,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles, PermissionsBitField.Flags.EmbedLinks, PermissionsBitField.Flags.ManageMessages]
      });
    }

    if (sellerDiscordId && sellerDiscordId !== i.user.id && sellerDiscordId !== staffRoleId) {
      overwrites.push({
        id: sellerDiscordId,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles, PermissionsBitField.Flags.EmbedLinks, PermissionsBitField.Flags.ManageMessages]
      });
    }

    const tp = data.ticketPanel || {};
    const langConf = isEn ? (tp.en || {}) : (tp.vi || {});
    const storeName = data.storeName || '4AM STORE';
    const prefix = (tp.ticketPrefix || 'ticket-support').toLowerCase().replace(/[^a-z0-9_-]/g, '-');

    const ticketChannel = await guild.channels.create({
      name: `${prefix}-${i.user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}-${orderDraftNo}`,
      type: ChannelType.GuildText,
      parent: ticketCategoryId ?? undefined,
      permissionOverwrites: overwrites,
      reason: `Ticket hỗ trợ tạo bởi ${i.user.tag}`
    });

    if (!isStaff) markTicketOpened(i.user.id);

    const paymentBlock = buildPaymentBlock(defaultSeller, orderDraftNo, 'all', lang);

    const welcomeTitle = (langConf.welcomeTitle || (isEn ? '🎟️ SUPPORT TICKET — {storeName}' : '🎟️ TICKET HỖ TRỢ — {storeName}')).replace(/\{storeName\}/g, storeName);
    const rawWelcomeMsg = langConf.welcomeMsg || (isEn ? 'Hello <@{userId}>! Thank you for contacting **{storeName}**.' : 'Xin chào <@{userId}>! Cảm ơn bạn đã liên hệ với **{storeName}**.');
    const welcomeMsg = rawWelcomeMsg.replace(/\{userId\}/g, i.user.id).replace(/\{user\}/g, `<@${i.user.id}>`).replace(/\{storeName\}/g, storeName);
    const welcomeNote = langConf.welcomeNote || (isEn ? '💬 *Please send your inquiries or details of what you need assistance with!*' : '💬 *Vui lòng gửi câu hỏi hoặc dịch vụ bạn muốn tư vấn tại kênh này nhé!*');

    const welcomeEmbed = new EmbedBuilder()
      .setTitle(welcomeTitle)
      .setDescription([
        welcomeMsg,
        sellerDiscordId
          ? (isEn ? `Assigned staff: <@${sellerDiscordId}> will respond shortly.` : `Nhân viên phụ trách: <@${sellerDiscordId}> sẽ phản hồi bạn ngay.`)
          : (staffRoleId ? (isEn ? `Support team <@&${staffRoleId}> is available to assist you.` : `Nhân viên hỗ trợ <@&${staffRoleId}> sẽ có mặt ngay để phục vụ bạn.`) : ''),
        paymentBlock,
        welcomeNote
      ].filter(Boolean).join('\n'))
      .setColor(0x5865F2)
      .setFooter({ text: isEn ? `${storeName} • 24/7 Support` : `${storeName} • Hỗ trợ 24/7` })
      .setTimestamp();

    const qrAccount = defaultSeller?.accounts?.find(a => a.qr);
    if (qrAccount?.qr) {
      welcomeEmbed.setImage(qrAccount.qr);
    } else if (process.env.BANK_QR) {
      welcomeEmbed.setImage(process.env.BANK_QR);
    }

    const ticketButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('close_simple_ticket')
        .setLabel('🔒 Đóng Ticket')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`show_seller_selector|${orderDraftNo}`)
        .setLabel('💳 Đổi STK người bán khác')
        .setStyle(ButtonStyle.Secondary)
    );

    const generalMentions = [`<@${i.user.id}>`];
    if (sellerDiscordId && sellerDiscordId !== i.user.id) {
      generalMentions.push(`<@${sellerDiscordId}>`);
    }
    if (staffRoleId) {
      generalMentions.push(`<@&${staffRoleId}>`);
    }

    await ticketChannel.send({
      content: generalMentions.join(' '),
      embeds: [welcomeEmbed],
      components: [ticketButtons]
    });

    return i.editReply({ content: `✅ Đã tạo Ticket hỗ trợ tại: <#${ticketChannel.id}>` });
  }

  // --- Switch Seller / Bank Account in Ticket ---
  if (i.isButton() && i.customId.startsWith('show_seller_selector|')) {
    const orderCode = i.customId.split('|')[1];
    const data = getMenuData();
    const sellers = data.sellers || {};

    const options = Object.entries(sellers).map(([key, s]) => {
      const isShop = s.isShop || key === 'shop_common';
      const uname = isShop ? '🏢 STK Chung của Shop' : (s.username ? `@${s.username}` : (s.name || key));
      const sub = (!isShop && s.name) ? `${s.name} • ` : '';
      const accs = s.accounts?.map(a => `${a.bank}: ${a.account}`).join(', ') || 'Chưa có STK';
      return {
        label: uname.slice(0, 100),
        value: `${key}|${orderCode}`,
        description: `${sub}${accs}`.slice(0, 100)
      };
    });

    if (!options.length) {
      return i.reply({ content: 'Chưa có danh sách người bán nào được cấu hình trong menuData.js.', ephemeral: true });
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('select_seller_to_view')
      .setPlaceholder('Chọn người bán / tài khoản muốn chuyển...')
      .addOptions(options);

    const row = new ActionRowBuilder().addComponents(selectMenu);
    return i.reply({ content: '👇 Hãy chọn người bán để xem số tài khoản và thông tin chuyển khoản tương ứng:', components: [row], ephemeral: true });
  }

  if (i.isStringSelectMenu() && i.customId === 'select_seller_to_view') {
    const [sellerKey, orderCode] = i.values[0].split('|');
    const data = getMenuData();
    const seller = data.sellers?.[sellerKey];
    if (!seller) return i.reply({ content: '❌ Không tìm thấy thông tin người bán này.', ephemeral: true });

    // Grant switched seller permission to this ticket channel if applicable
    const sellerDiscordId = seller.discordId || (/^\d{17,20}$/.test(sellerKey) ? sellerKey : null);
    if (sellerDiscordId && sellerDiscordId !== i.user.id) {
      await i.channel.permissionOverwrites.edit(sellerDiscordId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        AttachFiles: true,
        EmbedLinks: true
      }).catch(() => {});
    }

    const paymentText = buildPaymentBlock(seller, orderCode, 'all');
    const isShop = seller.isShop || sellerKey === 'shop_common';
    const sellerTitle = isShop ? '🏢 CỬA HÀNG (STK CHUNG)' : (seller.username ? `@${seller.username}` : (seller.name || 'Người bán'));
    const embed = new EmbedBuilder()
      .setTitle(`💳 THÔNG TIN THANH TOÁN — ${sellerTitle}`)
      .setDescription(paymentText)
      .setColor(0x00C2A8);

    const qrAccount = seller.accounts?.find(a => a.qr);
    if (qrAccount?.qr) {
      embed.setImage(qrAccount.qr);
    }

    return i.reply({ embeds: [embed], ephemeral: true });
  }

  // --- Close Simple Ticket ---
  if (i.isButton() && i.customId === 'close_simple_ticket') {
    await i.reply({ content: '🔒 Ticket sẽ được đóng và xóa trong 3 giây...' });
    setTimeout(() => {
      i.channel.delete().catch(e => console.error('Không thể xóa kênh ticket:', e));
    }, 3000);
    return;
  }

  if (i.isChatInputCommand() && i.commandName === 'my-subscriptions') {
  const me = await prisma.user.findUnique({ where: { discordId: i.user.id } });
  if (!me) return i.reply({ content: 'No account found. Use /shop to start.', ephemeral: true });

  const subs = await prisma.subscription.findMany({
    where: { userId: me.id, status: 'ACTIVE' },
    include: { product: true }
  });

  if (!subs.length) return i.reply({ content: 'You have no active subscriptions.', ephemeral: true });

  const lines = subs.map(s => {
    const when = s.currentPeriodEnd.toLocaleString('en-IN');
    return `• **${s.product.name}** (\`${s.product.sku}\`) — ends **${when}**`;
  }).join('\n');

  return i.reply({ content: lines, ephemeral: true });
}
  // Customer clicked "Renew Now" in DM
if (i.isButton() && i.customId.startsWith('renew_sub_')) {
  await i.deferReply({ ephemeral: true }).catch(() => {});

  const subId = i.customId.replace('renew_sub_', '');
  try {
    // Create a renewal order
    const order = await createRenewalOrderForSubscription(subId);

    // Open/attach ticket in your main guild
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const buyer = await prisma.user.findUnique({ where: { id: order.userId } });
    const discordUser = await client.users.fetch(buyer.discordId);
    const orderNo = shortOrderNo();

    const ticketChannel = await openTicketChannel(guild, discordUser, orderNo);
    await attachTicket(order.id, guild.id, ticketChannel.id);

    // Show summary + payment buttons (re-using your existing helpers)
    const product = await prisma.product.findUnique({ where: { id: order.productId } });
    const snapshot = JSON.parse(order.planSnapshotJson || '{}');
    const spec = snapshot.spec || JSON.parse(product.specJson || '{}');

    const summary = new EmbedBuilder()
      .setTitle(`Renewal — Order #${order.orderNo}`)
      .setDescription([
        `**Product**: ${product.name} (${product.sku})`,
        `**Price**: ₹${(product.priceCents/100).toFixed(0)} ${product.currency}/mo`,
        `**Specs:**\n${specToLines(spec)}`
      ].join('\n'))
      .setColor(0x27AE60);

    await ticketChannel.send({
      content: `<@${discordUser.id}>`,
      embeds: [summary],
      components: [paymentButtons(order.id)]
    });

    await i.editReply({ content: `✅ Renewal started. Continue in your ticket: <#${ticketChannel.id}>` }).catch(() => {});
  } catch (e) {
    console.error('renew_sub failed:', e);
    await i.editReply({ content: '❌ Could not start renewal. Please try again later.' }).catch(() => {});
  }
}
  // --- Admin: Sync Menu ---
if (i.isChatInputCommand() && i.commandName === 'sync-menu') {
  await i.deferReply({ ephemeral: true });
  await syncMenuChannel();
  await syncTicketChannel();
  return i.editReply({ content: '✅ Đã đồng bộ bảng giá vào kênh Menu và Ticket panel thành công!' });
}

// --- Admin: Ticket Panel ---
if (i.isChatInputCommand() && i.commandName === 'ticket-panel') {
  await i.deferReply({ ephemeral: true });
  await syncTicketChannel();
  return i.editReply({ content: '✅ Đã gửi panel tạo Ticket vào kênh Ticket thành công!' });
}

// --- Admin: Setup Bilingual Server ---
if (i.isChatInputCommand() && i.commandName === 'setup-bilingual') {
  await i.deferReply({ ephemeral: true });
  try {
    const result = await setupBilingualServer(i.guild);
    return i.editReply({
      content: [
        '🎉 **Thiết lập server song ngữ hoàn tất thành công!**',
        '',
        `• **Roles:** <@&${result.roles.vi.id}> & <@&${result.roles.en.id}>`,
        `• **Cổng chọn ngôn ngữ:** <#${result.channels.welcome.id}> (Cụm 4AM - chỉ cụm này công khai cho user mới)`,
        `• **Danh mục ORDER:**`,
        `  - Kênh Menu tích hợp song ngữ: <#${result.channels.menuVi.id}>`,
        `  - Kênh Ticket: <#${result.channels.ticketVi.id}> (Tiếng Việt) & <#${result.channels.ticketEn.id}> (English)`,
        `• **Danh mục Ticket mới:** <#${result.categories.ticket?.id}>`,
        '',
        '✨ *User mới vào server chỉ thấy duy nhất cụm 4AM. Sau khi bấm nhận Role, các kênh theo ngôn ngữ sẽ tự động hiển thị!*'
      ].join('\n')
    });
  } catch (err) {
    console.error('Lỗi khi setup-bilingual:', err);
    return i.editReply({ content: `❌ Lỗi khi thiết lập server: ${err.message}` });
  }
}

// --- Admin/Staff: Send Bank Account into Channel ---
if (i.isChatInputCommand() && i.commandName === 'send-bank') {
  const data = getMenuData();
  const sellers = data.sellers || {};
  const sellerInput = i.options.getString('seller');

  let targetSeller = null;
  if (sellerInput && sellers[sellerInput]) {
    targetSeller = sellers[sellerInput];
  } else if (sellerInput) {
    targetSeller = Object.values(sellers).find(s => s.name.toLowerCase().includes(sellerInput.toLowerCase()));
  }

  if (!targetSeller) {
    const options = Object.entries(sellers).map(([key, s]) => ({
      label: s.name,
      value: key,
      description: s.accounts?.map(a => `${a.bank}: ${a.account}`).join(' • ').slice(0, 100) || 'STK người bán'
    }));

    if (!options.length) {
      return i.reply({ content: '❌ Chưa có người bán nào trong danh sách menuData.js.', ephemeral: true });
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('post_seller_bank_to_channel')
      .setPlaceholder('Chọn người bán để gửi STK vào kênh...')
      .addOptions(options);

    const row = new ActionRowBuilder().addComponents(selectMenu);
    return i.reply({ content: 'Chọn người bán bạn muốn gửi STK công khai vào kênh này:', components: [row], ephemeral: true });
  }

  const paymentText = buildPaymentBlock(targetSeller, shortOrderNo());
  const embed = new EmbedBuilder()
    .setTitle(`💳 THÔNG TIN THANH TOÁN — ${targetSeller.name}`)
    .setDescription(paymentText)
    .setColor(0x00C2A8);

  const qrAccount = targetSeller.accounts?.find(a => a.qr);
  if (qrAccount?.qr) {
    embed.setImage(qrAccount.qr);
  }

  return i.reply({ embeds: [embed] });
}

if (i.isStringSelectMenu() && i.customId === 'post_seller_bank_to_channel') {
  const sellerKey = i.values[0];
  const data = getMenuData();
  const seller = data.sellers?.[sellerKey];
  if (!seller) return i.reply({ content: '❌ Không tìm thấy thông tin người bán.', ephemeral: true });

  await i.deferUpdate();

  const paymentText = buildPaymentBlock(seller, shortOrderNo());
  const embed = new EmbedBuilder()
    .setTitle(`💳 THÔNG TIN THANH TOÁN — ${seller.name}`)
    .setDescription(paymentText)
    .setColor(0x00C2A8);

  const qrAccount = seller.accounts?.find(a => a.qr);
  if (qrAccount?.qr) {
    embed.setImage(qrAccount.qr);
  }

  await i.channel.send({ embeds: [embed] });
}

// --- Admin: Add Product ---
if (i.isChatInputCommand() && i.commandName === 'add-product') {
  const name = i.options.getString('name');
  const sku = i.options.getString('sku');
  const price = i.options.getInteger('price');
  const type = i.options.getString('type') || 'OTHER';
  const description = i.options.getString('description') || '';

  try {
    const spec = description ? { info: description } : { info: 'Tiêu chuẩn' };
    const product = await prisma.product.create({
      data: {
        name,
        sku,
        type,
        specJson: JSON.stringify(spec),
        priceCents: price,
        currency: 'VNĐ',
        active: true
      }
    });
    await syncMenuChannel();
    return i.reply({ content: `✅ Đã thêm sản phẩm **${product.name}** (\`${product.sku}\`) - ${formatPrice(price)} và cập nhật vào kênh Menu!`, ephemeral: true });
  } catch (err) {
    console.error(err);
    return i.reply({ content: '❌ Thêm sản phẩm thất bại (có thể SKU đã tồn tại).', ephemeral: true });
  }
}

// --- Admin: Set Price ---
if (i.isChatInputCommand() && i.commandName === 'set-price') {
  const sku = i.options.getString('sku');
  const price = i.options.getInteger('price');

  try {
    const product = await prisma.product.update({
      where: { sku },
      data: { priceCents: price }
    });
    await syncMenuChannel();
    return i.reply({ content: `✅ Đã cập nhật giá cho **${product.name}** thành ${formatPrice(price)} và đẩy lên kênh Menu!`, ephemeral: true });
  } catch (err) {
    console.error(err);
    return i.reply({ content: '❌ Không tìm thấy mã SKU sản phẩm.', ephemeral: true });
  }
}

// --- Admin: Toggle Plan ---
if (i.isChatInputCommand() && i.commandName === 'toggle-plan') {
  const sku = i.options.getString('sku');
  const enabled = i.options.getBoolean('enabled');

  try {
    const product = await prisma.product.update({
      where: { sku },
      data: { active: enabled }
    });
    const state = enabled ? 'Mở bán ✅' : 'Ẩn / Tạm hết hàng ❌';
    await syncMenuChannel();
    return i.reply({ content: `🔧 Sản phẩm **${product.name}** (\`${sku}\`) đã được chuyển sang trạng thái: **${state}** và cập nhật kênh Menu!`, ephemeral: true });
  } catch (err) {
    console.error(err);
    return i.reply({ content: '❌ Không tìm thấy mã SKU sản phẩm.', ephemeral: true });
  }
}

// --- Admin: List Products ---
if (i.isChatInputCommand() && i.commandName === 'list-products') {
  const products = await prisma.product.findMany({ orderBy: [{ type: 'asc' }, { priceCents: 'asc' }] });
  if (!products.length) return i.reply({ content: 'Kho hiện chưa có sản phẩm nào.', ephemeral: true });

  const lines = products.map(p => `• **${p.name}** (\`${p.sku}\`) — ${formatPrice(p.priceCents, p.currency)} [${p.type}] [${p.active ? '🟢 Bật' : '🔴 Tắt'}]`).join('\n');
  return i.reply({ content: `📦 **Danh sách sản phẩm trong kho:**\n\n${lines}`, ephemeral: true });
}

  try {
    //
    // Slash commands
    //
    if (i.isChatInputCommand() && i.commandName === 'shop') {
      const embed = new EmbedBuilder()
        .setTitle('Welcome to the Store')
        .setDescription('Buy VPS, Bot hosting, or Web hosting — without leaving Discord.')
        .setColor(0x00C2A8);
      return i.reply({ embeds: [embed], components: [shopButtons()], ephemeral: true });
    }

    if (i.isChatInputCommand() && i.commandName === 'orders') {
      const list = await prisma.order.findMany({ orderBy: { createdAt: 'desc' }, take: 10 });
      const lines = list.map(o => `• ${o.orderNo} — ${o.status} — ₹${(o.amountCents/100).toFixed(0)} ${o.currency}`).join('\n') || 'No orders yet.';
      return i.reply({ content: lines, ephemeral: true });
    }

    //
    // Buy buttons → directly create ticket (no Customer Details modal)
    //
    if (i.isButton()) {
      const id = i.customId;

      //
      // Click "🛒 Mua [Tên gói]" from Live Menu Channel
      //
      if (id.startsWith('buy_prod_')) {
        const productId = id.replace('buy_prod_', '');
        const product = await prisma.product.findUnique({ where: { id: productId } });
        if (!product || !product.active) {
          return i.reply({ content: '❌ Sản phẩm này hiện đang tạm hết hàng hoặc không khả dụng.', ephemeral: true });
        }

        // Rate limit (staff bypass)
        const staffRoleId = process.env.STAFF_ROLE_ID;
        const member = await i.guild.members.fetch(i.user.id);
        const isStaff = member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
                        (staffRoleId && member.roles.cache.has(staffRoleId));

        if (!isStaff) {
          const gate = canOpenTicket(i.user.id);
          if (!gate.ok) {
            return i.reply({
              content: `⏳ Bạn vui lòng chờ thêm **${gate.waitMin} phút** trước khi tạo ticket tiếp theo. (Giới hạn: ${TICKET_COOLDOWN_MIN} phút)`,
              ephemeral: true
            });
          }
        }

        await i.deferReply({ ephemeral: true });

        const displayName = i.user.globalName || i.user.username;
        const user = await ensureUser(i.user.id, null, displayName, null);

        const orderDraftNo = shortOrderNo();
        const order = await createOrder({
          userId: user.id,
          productId: product.id,
          planSnapshotJson: JSON.stringify({ name: product.name, sku: product.sku, spec: JSON.parse(product.specJson || '{}') }),
          amountCents: product.priceCents,
          currency: product.currency || 'VNĐ'
        });

        const guild = await client.guilds.fetch(process.env.GUILD_ID);
        const cleanSku = product.sku.toLowerCase().replace(/[^a-z0-9]/g, '-');
        const ticketChannel = await openTicketChannel(guild, i.user, `${cleanSku}-${orderDraftNo}`);
        await attachTicket(order.id, guild.id, ticketChannel.id);
        if (!isStaff) markTicketOpened(i.user.id);

        const priceFormatted = formatPrice(order.amountCents, order.currency);
        const bankName = process.env.BANK_NAME || 'MB Bank';
        const bankAccount = process.env.BANK_ACCOUNT || 'Chưa cấu hình';
        const bankOwner = process.env.BANK_OWNER || 'Chưa cấu hình';
        const transferContent = `4AM ${order.orderNo}`;

        let specText = '';
        try {
          const parsed = JSON.parse(product.specJson || '{}');
          specText = Object.entries(parsed).map(([k, v]) => `• **${k}**: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n');
        } catch (_) {
          specText = product.specJson || '';
        }

        const orderEmbed = new EmbedBuilder()
          .setTitle(`🧾 ĐƠN HÀNG #${order.orderNo}`)
          .setDescription([
            `Xin chào <@${i.user.id}>! Đơn hàng mua **${product.name}** của bạn đã được tiếp nhận.`,
            staffRoleId ? `Nhân viên <@&${staffRoleId}> sẽ hỗ trợ bạn trực tiếp tại kênh này.` : '',
            '',
            `📦 **Gói dịch vụ:** **${product.name}** (\`${product.sku}\`)`,
            `💰 **Số tiền thanh toán:** **${priceFormatted}**`,
            specText ? `⚙️ **Thông số cấu hình:**\n${specText}` : '',
            '',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            '💳 **HƯỚNG DẪN THANH TOÁN CHUYỂN KHOẢN:**',
            `🏛️ **Ngân hàng:** \`${bankName}\``,
            `🔢 **Số tài khoản:** \`${bankAccount}\``,
            `👤 **Chủ tài khoản:** \`${bankOwner}\``,
            `📝 **Nội dung chuyển khoản:** \`${transferContent}\``,
            '*(Vui lòng điền đúng nội dung để nhân viên đối soát nhanh nhất)*',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            '',
            'Sau khi chuyển khoản thành công, bạn hãy bấm nút **"✅ Tôi đã thanh toán"** bên dưới để Staff kiểm tra và kích hoạt dịch vụ cho bạn nhé!'
          ].filter(Boolean).join('\n'))
          .setColor(0x00C2A8)
          .setFooter({ text: '4AM Shop • Hỗ trợ 24/7' })
          .setTimestamp();

        if (process.env.BANK_QR) {
          orderEmbed.setImage(process.env.BANK_QR);
        }

        const ticketButtons = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`pay_sim_${order.id}`)
            .setLabel('✅ Tôi đã thanh toán (I Paid)')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`staff_close_${order.id}`)
            .setLabel('🔒 Đóng Ticket')
            .setStyle(ButtonStyle.Secondary)
        );

        await ticketChannel.send({
          content: `<@${i.user.id}> ${staffRoleId ? `<@&${staffRoleId}>` : ''}`,
          embeds: [orderEmbed],
          components: [ticketButtons]
        });

        return i.editReply({ content: `✅ Đã tạo Ticket mua **${product.name}** tại: <#${ticketChannel.id}>` });
      }

      const typeMap = { 'buy_vps': 'VPS', 'buy_bot': 'BOT', 'buy_web': 'WEB' };

      if (typeMap[id]) {
        const type = typeMap[id];

        // Rate limit (staff bypass)
        const staffRoleId = process.env.STAFF_ROLE_ID;
        const member = await i.guild.members.fetch(i.user.id);
        const isStaff = member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
                        (staffRoleId && member.roles.cache.has(staffRoleId));

        if (!isStaff) {
          const gate = canOpenTicket(i.user.id);
          if (!gate.ok) {
            return i.reply({
              content: `⏳ You can open a new ticket in **${gate.waitMin} min**. (Limit: ${TICKET_COOLDOWN_MIN} min)`,
              ephemeral: true
            });
          }
        }

        await i.deferReply({ ephemeral: true });

        const displayName = i.user.globalName || i.user.username;
        const user = await ensureUser(i.user.id, null, displayName, null);

        const guild = await client.guilds.fetch(process.env.GUILD_ID);
        const orderDraftNo = shortOrderNo();
        const ticketChannel = await openTicketChannel(guild, i.user, orderDraftNo);
        if (!isStaff) markTicketOpened(i.user.id);

        const products = await prisma.product.findMany({ where: { type, active: true } });

        const hello = new EmbedBuilder()
          .setTitle(`Hi ${displayName}!`)
          .setDescription([
            `Let’s finish your **${type}** order.`,
            `**Step 1:** Review plans below & pick one.`,
            `**Step 2:** Choose payment option & pay.`
          ].join('\n'))
          .setColor(0x00C2A8);

        const list = plansListEmbed(type, products);
        const draftId = nanoid(10);

        await ticketChannel.send({
          content: `<@${i.user.id}>`,
          embeds: [hello, list],
          components: [ticketPlanSelectRow(type, products, draftId)]
        });

        return i.editReply({ content: `Ticket created: <#${ticketChannel.id}>` });
      }

      if (id === 'contact_sales') {
        return i.reply({ content: 'Sales will be with you shortly!', ephemeral: true });
      }
    }
// Utility: check if user is staff
async function isStaffMember(i) {
  const staffRoleId = process.env.STAFF_ROLE_ID;
  const member = await i.guild.members.fetch(i.user.id);
  return member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
         (staffRoleId && member.roles.cache.has(staffRoleId));
}
if (i.isButton() && i.customId.startsWith('pay_upi_')) {
  const orderId = i.customId.split('pay_upi_')[1];
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { ticket: true } });
  if (!order) return i.reply({ content: 'Order not found.', ephemeral: true });

  const upiId = process.env.UPI_ID || 'not-set@upi';
  const qrUrl = process.env.UPI_QR;

  const embed = new EmbedBuilder()
    .setTitle('Pay via UPI')
    .setDescription([
      `Please scan the QR code below or pay manually using this UPI ID:`,
      `\`${upiId}\``,
      '',
      'Once you complete the payment, click **✅ I Paid**.'
    ].join('\n'))
    .setColor(0x2ECC71);

  if (qrUrl) embed.setImage(qrUrl);

  return i.reply({ embeds: [embed], ephemeral: true });
}
// Close ticket
if (i.isButton() && i.customId.startsWith('staff_close_')) {
  if (!(await isStaffMember(i))) return i.reply({ content: 'Only staff can use this action.', ephemeral: true });
  const orderId = i.customId.split('staff_close_')[1];
  await i.deferUpdate();

  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { ticket: true } });
  if (!order?.ticket) return;

  await adminLog(
    `🔒 Ticket closed for Order **#${order.orderNo}** by <@${i.user.id}>`,
    staffActionEmbed({
      title: 'Ticket Closed',
      actorId: i.user.username,
      details: `Order #${order.orderNo} • Channel: <#${order.ticket.channelId}>`
    })
  );

  const chan = await i.guild.channels.fetch(order.ticket.channelId);
  // Lock channel for the buyer (but keep staff)
  try {
    // Remove Send Messages from all member overwrites except staff
    const overwrites = chan.permissionOverwrites.cache;
    const staffRoleId = process.env.STAFF_ROLE_ID;

    // For each member overwrite with ViewChannel allowed, deny SendMessages
    for (const ow of overwrites.values()) {
      if (ow.type === 1) { // member overwrite
        await chan.permissionOverwrites.edit(ow.id, { SendMessages: false }).catch(() => {});
      }
    }
    // Also rename the channel to show closed state
    await chan.setName(`${chan.name}`.replace(/^order-/, 'closed-')).catch(() => {});
  } catch (e) { console.error('Close ticket perms/rename failed:', e); }

  await prisma.ticket.update({ where: { id: order.ticket.id }, data: { status: 'CLOSED' } }).catch(() => {});
  await i.channel.send('🔒 Ticket closed. Buyer cannot send messages now.');
}

// Reopen ticket
if (i.isButton() && i.customId.startsWith('staff_reopen_')) {
  if (!(await isStaffMember(i))) return i.reply({ content: 'Only staff can use this action.', ephemeral: true });
  const orderId = i.customId.split('staff_reopen_')[1];
  await i.deferUpdate();

  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { ticket: true } });
  if (!order?.ticket) return;

  await adminLog(
    `🔓 Ticket reopened for Order **#${order.orderNo}** by <@${i.user.id}>`,
    staffActionEmbed({
      title: 'Ticket Reopened',
      actorId: i.user.username,
      details: `Order #${order.orderNo} • Channel: <#${order.ticket.channelId}>`
    })
  );

  const chan = await i.guild.channels.fetch(order.ticket.channelId);
  try {
    // Restore Send Messages for the buyer overwrite(s)
    const overwrites = chan.permissionOverwrites.cache;
    for (const ow of overwrites.values()) {
      if (ow.type === 1) {
        await chan.permissionOverwrites.edit(ow.id, { SendMessages: true }).catch(() => {});
      }
    }
    // Rename back if previously closed-
    await chan.setName(`${chan.name}`.replace(/^closed-/, 'order-')).catch(() => {});
  } catch (e) { console.error('Reopen ticket perms/rename failed:', e); }

  await prisma.ticket.update({ where: { id: order.ticket.id }, data: { status: 'OPEN' } }).catch(() => {});
  await i.channel.send('🔓 Ticket reopened. Buyer can send messages again.');
}


if (i.isChatInputCommand() && i.commandName === 'announce') {
  const title = i.options.getString('title');
  const msg   = i.options.getString('message');
  const image = i.options.getString('image');
  const color = i.options.getString('color') || '#5865F2';

  const channelId = process.env.ANNOUNCEMENTS_CHANNEL_ID;
  if (!channelId) return i.reply({ content: 'ANNOUNCEMENTS_CHANNEL_ID not set.', ephemeral: true });

  const chan = await client.channels.fetch(channelId).catch(() => null);
  if (!chan || !chan.isTextBased()) return i.reply({ content: 'Announcements channel not found.', ephemeral: true });

  const hex = parseInt(color.replace('#',''), 16);
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(msg)
    .setColor(isNaN(hex) ? 0x5865F2 : hex)
    .setTimestamp(new Date());
  if (image) embed.setImage(image);

  await chan.send({ embeds: [embed] });
  await adminLog(`📢 Announcement posted by <@${i.user.id}>: **${title}**`);
  return i.reply({ content: '✅ Announcement posted.', ephemeral: true });
}
    //
    // Plan selection inside ticket → create order + ask extras
    //
    if (i.isStringSelectMenu() && i.customId.startsWith('ticket_plan_')) {
  const [draftId, type] = i.customId.replace('ticket_plan_', '').split('|');
  const sku = i.values[0];

  const product = await prisma.product.findUnique({ where: { sku } });
  if (!product) return i.reply({ content: 'Plan not found. Please try again.', ephemeral: true });

  const user = await prisma.user.findUnique({ where: { discordId: i.user.id } });
  if (!user) return i.reply({ content: 'User record not found. Please run /shop again.', ephemeral: true });

  const spec = JSON.parse(product.specJson);
  const planSnapshot = { name: product.name, sku, spec };

  const order = await createOrder({
    userId: user.id,
    productId: product.id,
    planSnapshotJson: JSON.stringify(planSnapshot),
    amountCents: product.priceCents,
    currency: product.currency
  });

  await attachTicket(order.id, i.guild.id, i.channel.id);

  // ❗ Important: do NOT i.update() here — we need to open a modal as the response
  return i.showModal(
    new ModalBuilder()
      .setCustomId(`extras_modal|${order.id}`)
      .setTitle(`Final Details — ${product.name}`)
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('server_name').setLabel('Server name / hostname').setStyle(TextInputStyle.Short).setRequired(false)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('notes').setLabel('Any notes / preferences').setStyle(TextInputStyle.Paragraph).setRequired(false)
        )
      )
  );
}

    //
    // Extras modal → final summary + payment
    //
    if (i.isModalSubmit() && i.customId.startsWith('extras_modal|')) {
      const orderId = i.customId.split('|')[1];
      const serverName = i.fields.getTextInputValue('server_name') || null;
      const notes = i.fields.getTextInputValue('notes') || null;

      const order = await prisma.order.findUnique({ where: { id: orderId }, include: { product: true } });
      if (!order) return i.reply({ content: 'Order not found.', ephemeral: true });

      const snapshot = JSON.parse(order.planSnapshotJson);
      snapshot.serverName = serverName;
      snapshot.notes = notes;
      await prisma.order.update({ where: { id: orderId }, data: { planSnapshotJson: JSON.stringify(snapshot) } });

      const spec = snapshot.spec;
      const summary = new EmbedBuilder()
        .setTitle(`Order #${order.orderNo} — Review & Pay`)
        .setDescription([
          `**Product**: ${order.product.name} (${order.product.sku})`,
          `**Price**: ₹${(order.amountCents/100).toFixed(0)} ${order.currency}/mo`,
          `**Specs:**\n${specToLines(spec)}`,
          serverName ? `**Server name**: ${serverName}` : null,
          notes ? `**Notes**: ${notes}` : null
        ].filter(Boolean).join('\n'))
        .setColor(0xFFD23F);

      return i.reply({ embeds: [summary], components: [paymentButtons(order.id)] });
    }
// Staff actions: Mark as Paid / Reject
if (i.isButton() && (i.customId.startsWith('staff_paid_') || i.customId.startsWith('staff_reject_'))) {
  const isPaidAction = i.customId.startsWith('staff_paid_');
  const orderId = i.customId.split('_').pop();
  

  // Check permissions: Manage Server OR STAFF_ROLE_ID
  const staffRoleId = process.env.STAFF_ROLE_ID;
  const member = await i.guild.members.fetch(i.user.id);
  const isStaff =
    member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
    (staffRoleId && member.roles.cache.has(staffRoleId));

  if (!isStaff) {
    return i.reply({ content: 'Only staff can use this action.', ephemeral: true });
  }

  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { product: true, ticket: true } });
  if (!order) return i.reply({ content: 'Order not found.', ephemeral: true });

  // Remove buttons from that staff message
  await i.update({ components: [] });

  if (!isPaidAction) {
    // Reject
    await prisma.order.update({
      where: { id: orderId },
      data: { status: 'FAILED', paymentProvider: 'STAFF', providerRef: `REJECTED_BY_${i.user.id}` }
    });
    await adminLog(
  `❌ Payment rejected for Order **#${order.orderNo}** by <@${i.user.id}>`,
  staffActionEmbed({
    title: 'Payment Rejected',
    actorId: i.user.username,
    details: `Order #${order.orderNo}\nReason: manual reject\nBuyer: <@${order.user?.discordId || 'unknown'}>`
  })
);
    await i.channel.send(`❌ Payment **rejected** by <@${i.user.id}> for **Order #${order.orderNo}**.`);
    return;
  }

  // Approve → mark paid and continue (simulated provisioning for now)
  await markPaid(orderId, 'STAFF', `APPROVED_BY_${i.user.id}`);
  await upsertSubscriptionForPaidOrder(orderId);
  
  await adminLog(
    `✅ Đã duyệt thanh toán cho Đơn hàng **#${order.orderNo}** bởi <@${i.user.id}>`,
    staffActionEmbed({
      title: 'Duyệt thanh toán thành công',
      actorId: i.user.username,
      details: `Đơn #${order.orderNo}\nKhách: <@${order.user?.discordId || 'unknown'}>\nSố tiền: ${formatPrice(order.amountCents, order.currency)}`
    })
  );
  await i.channel.send(`✅ Thanh toán **ĐÃ ĐƯỢC DUYỆT** bởi <@${i.user.id}> cho **Đơn hàng #${order.orderNo}**.`);
  // After marking PAID:
  await grantCustomerRole(i, order);
  await i.channel.send('Thanh toán hợp lệ ✅ Đang tiến hành kích hoạt dịch vụ cho khách…');
  
  // --- DM the buyer a receipt ---
  try {
    const fresh = await prisma.order.findUnique({
      where: { id: orderId },
      include: { product: true, user: true, ticket: true }
    });

    const snapshot = JSON.parse(fresh.planSnapshotJson || '{}');
    const buyerUser = await client.users.fetch(fresh.user.discordId);
    const receipt = buildReceiptEmbed(fresh, snapshot);

    const dmIntro = `Xin chào ${fresh.user.name || buyerUser.username}, cảm ơn bạn đã mua hàng tại 4AM Shop! Dưới đây là biên lai cho **Đơn hàng #${fresh.orderNo}**.`;
    await buyerUser.send({ content: dmIntro, embeds: [receipt] });
    await i.channel.send('📩 Đã gửi biên lai thanh toán chi tiết qua tin nhắn riêng (DM) cho khách hàng.');
  } catch (err) {
    console.error('Lỗi DM biên lai:', err);
    await i.channel.send('⚠️ Không thể gửi DM cho khách (có thể khách đã khóa nhận tin nhắn từ người lạ).');
  }
}

// Payment button — manual review + staff controls
if (i.isButton() && i.customId.startsWith('pay_sim_')) {
  const orderId = i.customId.split('pay_sim_')[1];
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { ticket: true, product: true }
  });
  if (!order) return i.reply({ content: 'Không tìm thấy đơn hàng.', ephemeral: true });
  if (i.channelId !== order.ticket?.channelId) {
    return i.reply({ content: 'Vui lòng sử dụng nút thanh toán bên trong kênh Ticket của bạn.', ephemeral: true });
  }

  await i.deferUpdate();
  try { await i.message.edit({ components: [] }); } catch (_) {}

  const staffRoleId = process.env.STAFF_ROLE_ID;
  const mention = staffRoleId ? `<@&${staffRoleId}>` : '`(Chưa cấu hình STAFF_ROLE_ID)`';

  await i.channel.send({
    content: `${mention}\n🔔 **Khách hàng <@${i.user.id}> đã bấm "Tôi đã thanh toán"** cho **Đơn hàng #${order.orderNo}**.\nNhân viên vui lòng kiểm tra giao dịch và duyệt đơn bên dưới:`,
    components: [staffControls(order.id)]
  });

  await i.channel.send('Cảm ơn bạn! Đội ngũ Staff đã nhận được thông báo và sẽ kiểm tra chuyển khoản để kích hoạt dịch vụ cho bạn ngay. 🙌');

  await i.channel.send({
    content: '⚙️ Bảng điều khiển Ticket dành cho Staff:',
    components: [staffTicketControls(order.id)]
  });
}
  } catch (err) {
    console.error(err);
    if (i.isRepliable()) {
      return i.reply({ content: 'Something went wrong.', ephemeral: true });
    }
  }
});

//
// ----------- Web Control Panel (Dashboard) Express Server -----------
//
const app = express();
app.use(express.json());
app.use(express.static(path.resolve(__dirname, '../public')));

// Login auth check
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  const adminPass = process.env.ADMIN_PASSWORD || '4amstore123';
  if (password === adminPass) {
    const token = Buffer.from(adminPass).toString('base64');
    return res.json({ ok: true, token });
  }
  return res.status(401).json({ ok: false, error: 'Mật khẩu quản trị không chính xác.' });
});

function requireAdminAuth(req, res, next) {
  const adminPass = process.env.ADMIN_PASSWORD || '4amstore123';
  const expectedToken = Buffer.from(adminPass).toString('base64');
  const authHeader = req.headers['authorization'];
  if (authHeader === `Bearer ${expectedToken}`) {
    return next();
  }
  return res.status(401).json({ ok: false, error: 'Phiên đăng nhập đã hết hạn hoặc không hợp lệ.' });
}

// Get store data & bot info (auto-sync live Discord avatars for all sellers)
app.get('/api/data', async (req, res) => {
  try {
    const data = getMenuData();
    if (client.isReady() && data.sellers) {
      for (const [key, seller] of Object.entries(data.sellers)) {
        const dId = seller.discordId || (/^\d{17,20}$/.test(key) ? key : null);
        if (dId) {
          try {
            const u = await client.users.fetch(dId);
            if (u) {
              seller.username = u.username;
              seller.globalName = u.globalName || u.username;
              seller.avatar = u.displayAvatarURL({ extension: 'png', size: 128 });
              if (!seller.discordId) seller.discordId = u.id;
            }
          } catch (_) {}
        }
      }
    }
    const botInfo = {
      user: client.user ? { tag: client.user.tag, id: client.user.id } : null,
      ping: client.ws?.ping || 0
    };
    return res.json({ ok: true, data, botInfo });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Fetch Discord user profile by Discord User ID
app.get('/api/discord-user/:id', async (req, res) => {
  try {
    const rawId = (req.params.id || '').trim();
    if (!/^\d{17,20}$/.test(rawId)) {
      return res.status(400).json({ ok: false, error: 'Discord User ID phải gồm 17 đến 20 chữ số.' });
    }
    const user = await client.users.fetch(rawId);
    if (!user) {
      return res.status(404).json({ ok: false, error: 'Không tìm thấy người dùng Discord với ID này.' });
    }
    return res.json({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        globalName: user.globalName || user.username,
        tag: user.tag || user.username,
        avatar: user.displayAvatarURL({ extension: 'png', size: 128 })
      }
    });
  } catch (err) {
    return res.status(404).json({ ok: false, error: 'Không tìm thấy tài khoản Discord này (hoặc ID không tồn tại).' });
  }
});

// Get all Discord emojis from servers where the bot is present
app.get('/api/bot-emojis', async (req, res) => {
  try {
    if (!client.isReady()) {
      return res.json({ ok: true, emojis: [] });
    }
    const emojis = [];
    client.emojis.cache.forEach(em => {
      emojis.push({
        id: em.id,
        name: em.name,
        animated: !!em.animated,
        format: em.animated ? `<a:${em.name}:${em.id}>` : `<:${em.name}:${em.id}>`,
        url: em.imageURL({ extension: em.animated ? 'gif' : 'png', size: 64 }),
        guild: em.guild ? em.guild.name : 'Server'
      });
    });
    return res.json({ ok: true, emojis });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Save store data
app.post('/api/save', requireAdminAuth, (req, res) => {
  try {
    const newConfig = req.body;
    if (!newConfig || typeof newConfig !== 'object') {
      return res.status(400).json({ ok: false, error: 'Dữ liệu không hợp lệ.' });
    }
    const menuMod = require('./menuData');
    menuMod.saveData(newConfig);
    delete require.cache[require.resolve('./menuData')];
    return res.json({ ok: true, message: 'Đã lưu cấu hình thành công!' });
  } catch (err) {
    console.error('Lỗi khi lưu menuData:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Save & Sync to Discord Live
app.post('/api/sync', requireAdminAuth, async (req, res) => {
  try {
    await syncMenuChannel();
    await syncTicketChannel();
    return res.json({ ok: true, message: 'Đã đồng bộ thành công lên Discord!' });
  } catch (err) {
    console.error('Lỗi khi đồng bộ Discord:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Sync only Ticket Panel & Channels to Discord Live
app.post('/api/sync-ticket', requireAdminAuth, async (req, res) => {
  try {
    await syncTicketChannel();
    return res.json({ ok: true, message: 'Đã đồng bộ Ticket Panel & đổi tên kênh thành công!' });
  } catch (err) {
    console.error('Lỗi khi đồng bộ Ticket Panel:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 1-Click Auto Setup Bilingual Server (Mô hình 1: Role-based)
app.post('/api/setup-bilingual-server', requireAdminAuth, async (req, res) => {
  try {
    const guildId = process.env.GUILD_ID;
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      return res.status(404).json({ ok: false, error: 'Không tìm thấy Server Discord từ GUILD_ID trong cấu hình .env.' });
    }
    const result = await setupBilingualServer(guild);
    return res.json({
      ok: true,
      message: 'Thiết lập server song ngữ hoàn tất thành công!',
      data: {
        roles: { vi: result.roles.vi.name, en: result.roles.en.name },
        channels: {
          welcome: result.channels.welcome?.name,
          menu: result.channels.menuVi?.name,
          ticketVi: result.channels.ticketVi?.name,
          ticketEn: result.channels.ticketEn?.name
        }
      }
    });
  } catch (err) {
    console.error('Lỗi khi setup bilingual server:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));

// Serve frontend SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../public/index.html'));
});

(async () => {
  const desiredPort = parseInt(process.env.PORT || '3000', 10);
  let PORT = desiredPort;
  try {
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`🌐 Web Control Panel đang chạy tại: http://localhost:${PORT}`);
    });
    server.on('error', async (e) => {
      if (e.code === 'EADDRINUSE') {
        console.warn(`Cổng ${PORT} đang bận, tự động chọn cổng khả dụng tiếp theo...`);
        PORT = await getPort({ port: desiredPort + 1 });
        app.listen(PORT, '0.0.0.0', () => {
          console.log(`🌐 Web Control Panel đang chạy tại: http://localhost:${PORT}`);
        });
      }
    });
  } catch (err) {
    console.error('Lỗi khởi động Express:', err);
  }
})();

client.login(process.env.DISCORD_BOT_TOKEN);