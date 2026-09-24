require('dotenv').config();

process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ [Anti-Crash] Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (err, origin) => {
  console.error('⚠️ [Anti-Crash] Uncaught Exception:', err, origin);
});

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
const { ensureUser, findOrCreateProduct, createOrder, markPaid, attachTicket, updateOrderStatus, updateOrderAmount } = require('./order');
const { specToLines, shortOrderNo } = require('./utils');
const menuData = require('./menuData');
const { verifyHmacSignature, processGpmWebhook } = require('./payment/gpmPay');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { promisify } = require('util');
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

function shortSpec(spec = {}, type = '') {
  if (!spec || typeof spec !== 'object') return 'Cấu hình tiêu chuẩn';
  const entries = Object.entries(spec);
  if (!entries.length) return 'Cấu hình tiêu chuẩn';
  return entries.map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' | ');
}

function plansListEmbed(type, products = []) {
  const embed = new EmbedBuilder()
    .setTitle(`📦 Bảng giá các gói ${type}`)
    .setDescription('Vui lòng xem thông số cấu hình và lựa chọn gói phù hợp bên dưới:')
    .setColor(0x00C2A8);

  for (const p of products) {
    let specDesc = '';
    try {
      const parsed = JSON.parse(p.specJson || '{}');
      specDesc = specToLines(parsed);
    } catch (_) {
      specDesc = p.specJson || '';
    }
    embed.addFields({
      name: `${p.name} — ${formatPrice(p.priceCents, p.currency)}`,
      value: specDesc || 'Cấu hình tiêu chuẩn',
      inline: false
    });
  }
  return embed;
}
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

// Parse price from string (e.g. "150.000 VNĐ" -> 150000)
function parsePrice(priceStr) {
  if (!priceStr) return 0;
  const cleaned = String(priceStr).replace(/[^0-9]/g, '');
  return parseInt(cleaned, 10) || 0;
}

// Prompt embed & select menu asking customer which variant/package they want to buy
function buildCategoryItemPrompt(cat, categoryKey, lang = 'vi', orderDraftNo, selectedValue = null) {
  const isEn = lang === 'en';
  const rawItems = (isEn && cat.itemsEn && cat.itemsEn.length) ? cat.itemsEn : (cat.items || []);
  const catName = (isEn && cat.labelEn) ? cat.labelEn : (cat.label || categoryKey || 'Sản phẩm');

  const options = [];
  rawItems.slice(0, 24).forEach((item, index) => {
    const raw = String(item || '').trim().replace(/^•\s*/, '');
    let label = raw;
    let description = '';
    if (raw.includes('|')) {
      const parts = raw.split('|').map(s => s.trim());
      label = parts[0];
      description = (isEn ? 'Price: ' : 'Giá: ') + parts.slice(1).join(' | ');
    }

    let itemEmoji = undefined;
    if (cat.emoji) {
      const match = cat.emoji.match(/<a?:([a-zA-Z0-9_]+):(\d+)>/);
      if (match) itemEmoji = { name: match[1], id: match[2] };
      else itemEmoji = cat.emoji;
    }

    options.push({
      label: label.slice(0, 100),
      value: `item_${index}`,
      description: description ? description.slice(0, 100) : undefined,
      emoji: itemEmoji || '🏷️',
      default: selectedValue === `item_${index}`
    });
  });

  // Always append option: "Cần tư vấn và bàn bạc với người bán"
  options.push({
    label: (isEn ? 'Need consultation & discuss with seller' : 'Cần tư vấn và bàn bạc với người bán').slice(0, 100),
    value: 'consult_seller',
    description: (isEn ? 'Chat directly with staff / seller' : 'Trao đổi, tư vấn trực tiếp với nhân viên / người bán').slice(0, 100),
    emoji: '💬',
    default: selectedValue === 'consult_seller'
  });

  let placeholder = isEn ? '👉 Which type do you want to buy? Select here...' : '👉 Bạn muốn mua loại nào? Chọn tại đây...';
  if (selectedValue === 'consult_seller') {
    placeholder = isEn ? 'Selected: Consultation with seller (Click to change)' : 'Đã chọn: Cần tư vấn và bàn bạc với người bán (Bấm để đổi)';
  } else if (selectedValue && selectedValue.startsWith('item_')) {
    const idx = parseInt(selectedValue.replace('item_', ''), 10);
    const chosenRaw = rawItems[idx];
    if (chosenRaw) {
      const pName = String(chosenRaw).split('|')[0].trim().replace(/^•\s*/, '');
      placeholder = (isEn ? `Selected: ${pName} (Click to change)` : `Đã chọn: ${pName} (Bấm để đổi)`).slice(0, 100);
    }
  }

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`select_ticket_item|${orderDraftNo}|${categoryKey}|${lang}`)
    .setPlaceholder(placeholder)
    .addOptions(options);

  const row = new ActionRowBuilder().addComponents(selectMenu);

  const embed = new EmbedBuilder()
    .setTitle(isEn ? `❓ WHICH TYPE OF ${catName.toUpperCase()} DO YOU WANT TO BUY?` : `❓ BẠN MUỐN MUA LOẠI NÀO CỦA ${catName.toUpperCase()}?`)
    .setDescription(
      isEn
        ? `Please select the package/plan you wish to buy from the dropdown below.\nIf you are unsure or want custom terms, please select **"Need consultation & discuss with seller"**!`
        : `Vui lòng chọn loại gói bạn muốn mua ở danh mục bên dưới.\nNếu bạn chưa rõ hoặc cần thỏa thuận riêng, vui lòng chọn **"Cần tư vấn và bàn bạc với người bán"** nhé!`
    )
    .setColor(cat.color || 0x00C2A8);

  return { embed, row };
}

// Prompt embed & select menu for general ticket support
function buildGeneralTicketPrompt(categories = {}, lang = 'vi', orderDraftNo, selectedCategory = null) {
  const isEn = lang === 'en';
  const options = [];

  const catEntries = Object.entries(categories);
  catEntries.slice(0, 24).forEach(([key, cat]) => {
    let optEmoji = undefined;
    if (cat.emoji) {
      const match = cat.emoji.match(/<a?:([a-zA-Z0-9_]+):(\d+)>/);
      if (match) optEmoji = { name: match[1], id: match[2] };
      else optEmoji = cat.emoji;
    }
    const label = (isEn && cat.labelEn) ? cat.labelEn : (cat.label || key);
    options.push({
      label: label.slice(0, 100),
      value: key,
      description: (isEn ? `View packages & prices for ${label}` : `Xem các loại gói & giá của ${label}`).slice(0, 100),
      emoji: optEmoji,
      default: selectedCategory === key
    });
  });

  // Always append: Cần tư vấn và bàn bạc với người bán
  options.push({
    label: (isEn ? 'Need consultation & discuss with seller' : 'Cần tư vấn và bàn bạc với người bán').slice(0, 100),
    value: 'consult_seller',
    description: (isEn ? 'Chat directly with staff / seller' : 'Trao đổi, tư vấn trực tiếp với nhân viên / người bán').slice(0, 100),
    emoji: '💬',
    default: selectedCategory === 'consult_seller'
  });

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`select_general_ticket_category|${orderDraftNo}|${lang}`)
    .setPlaceholder(isEn ? '👉 Select a product or ask for advice...' : '👉 Chọn sản phẩm cần mua hoặc yêu cầu tư vấn...')
    .addOptions(options);

  const row = new ActionRowBuilder().addComponents(selectMenu);

  const embed = new EmbedBuilder()
    .setTitle(isEn ? '❓ WHAT PRODUCT ARE YOU INTERESTED IN?' : '❓ BẠN CẦN TƯ VẤN HOẶC MUA SẢN PHẨM NÀO?')
    .setDescription(
      isEn
        ? 'Please select the product you would like to purchase below to see its available packages, or select **"Need consultation & discuss with seller"** for direct support:'
        : 'Vui lòng chọn sản phẩm bạn muốn mua bên dưới để xem các loại gói hiện có, hoặc chọn **"Cần tư vấn và bàn bạc với người bán"** để được hỗ trợ trực tiếp:'
    )
    .setColor(0x5865F2);

  return { embed, row };
}

// Select menu shown inside ticket, with spec summary in description
function ticketPlanSelectRow(type, products, orderDraftId) {
  const options = products.map(p => {
    const spec = JSON.parse(p.specJson);
    return {
      label: `${p.name} — ${formatPrice(p.priceCents, p.currency)}`,
      description: shortSpec(spec, type).slice(0, 100), // Discord limit
      value: p.sku
    };
  });
  options.push({
    label: 'Cần tư vấn và bàn bạc với người bán',
    description: 'Trao đổi, tư vấn trực tiếp với nhân viên / người bán',
    value: 'consult_seller',
    emoji: '💬'
  });
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ticket_plan_${orderDraftId}|${type}`)
    .setPlaceholder(`Choose a ${type} plan or ask for advice`)
    .addOptions(options);
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



function startExpiryReminderScheduler() {
  setInterval(async () => {
    try {
      if (!client.isReady()) return;
      const now = new Date();
      const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      const expiring = await prisma.subscription.findMany({
        where: {
          status: 'ACTIVE',
          remindedExpiry: false,
          currentPeriodEnd: { gte: now, lte: in24h }
        },
        include: { user: true, product: true }
      });

      for (const sub of expiring) {
        try {
          const discordUser = await client.users.fetch(sub.user.discordId).catch(() => null);
          if (!discordUser) continue;

          const when = sub.currentPeriodEnd.toLocaleString('vi-VN');
          const renewBtn = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`renew_sub_${sub.id}`)
              .setLabel('🔁 Gia hạn ngay')
              .setStyle(ButtonStyle.Primary)
          );

          const embed = new EmbedBuilder()
            .setTitle('🔔 Dịch vụ của bạn sắp hết hạn')
            .setDescription([
              `**Gói dịch vụ:** ${sub.product.name} (${sub.product.sku})`,
              `**Thời hạn kết thúc:** ${when}`,
              '',
              'Bấm **Gia hạn ngay** bên dưới để mở ticket gia hạn tự động trên server.'
            ].join('\n'))
            .setColor(0xF39C12);

          await discordUser.send({ embeds: [embed], components: [renewBtn] }).catch(() => {});

          await prisma.subscription.update({
            where: { id: sub.id },
            data: { remindedExpiry: true }
          });
        } catch (e) {
          console.error('Lỗi gửi DM nhắc gia hạn:', e);
        }
      }
    } catch (err) {
      console.error('Lỗi scheduler nhắc gia hạn:', err);
    }
  }, 60 * 60 * 1000);
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
  const targetTicketId = targetTicketChannelId || data.ticketChannelId || data.channels?.ticketViChannelId;
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
  // 1. Tiêu đề chính to và nổi bật với Heading 1 Markdown (#)
  const cleanMainTitle = finalTitle.replace(/^#+\s*/, '').trim();
  descLines.push(`# ${cleanMainTitle}`);

  const linesToUse = Array.isArray(menuConf.lines)
    ? menuConf.lines
    : [menuConf.line1, menuConf.line2].filter(Boolean);

  // 2. Các dòng giới thiệu làm nhỏ lại dạng subtext (-#) để phân cấp rõ ràng, thẩm mỹ
  for (const line of linesToUse) {
    if (line !== undefined && line !== null && line.trim()) {
      const formatted = line
        .replace(/\{ticket\}/g, ticketMention)
        .replace(/\{storeName\}/g, data.storeName || '4AM STORE')
        .trim();
      const subLine = formatted.startsWith('-#') ? formatted : `-# ${formatted}`;
      descLines.push(subLine);
    }
  }

  // 3. Tiêu đề thanh toán dạng Heading 3 để gọn gàng, không lấn át tiêu đề chính
  if (menuConf.paymentTitle) {
    descLines.push('');
    let pTitle = menuConf.paymentTitle.trim();
    let cleanTitle = pTitle.replace(/^#+\s*/, '').replace(/^\*\*|\*\*$/g, '').trim();
    descLines.push(`### ${cleanTitle}`);
  }
  if (menuConf.paymentMethods) {
    descLines.push('```');
    descLines.push(menuConf.paymentMethods.trim());
    descLines.push('```');
  }
  if (menuConf.footerNote) {
    const fNote = menuConf.footerNote.trim();
    const cleanFoot = fNote.startsWith('-#') ? fNote : `-# *${fNote.replace(/^\*|\*$/g, '')}*`;
    descLines.push(cleanFoot);
  }

  let embedColor = 0x2B2D31;
  const rawColor = data.menuEmbed?.color;
  if (rawColor) {
    const cleanHex = rawColor.replace('#', '');
    const parsed = parseInt(cleanHex, 16);
    if (!isNaN(parsed)) embedColor = parsed;
  }

  const menuEmbed = new EmbedBuilder()
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
async function unlockServerChannels(guild) {
  if (!guild) throw new Error('Không tìm thấy Server Discord (Guild).');

  const data = getMenuData();
  const staffRoleId = process.env.STAFF_ROLE_ID || '1472036681048658041';
  const botMember = guild.members.me || await guild.members.fetch(client.user.id);
  const everyoneRole = guild.roles.everyone;

  // 1. Delete or clean up language roles "@Tiếng Việt" and "@English"
  const roleVi = guild.roles.cache.find(r => r.name === 'Tiếng Việt');
  if (roleVi) {
    await roleVi.delete('Xóa role phân biệt ngôn ngữ theo yêu cầu').catch(() => {});
  }
  const roleEn = guild.roles.cache.find(r => r.name === 'English');
  if (roleEn) {
    await roleEn.delete('Xóa role phân biệt ngôn ngữ theo yêu cầu').catch(() => {});
  }

  // Ensure Customer Role: Lucid Customer exists
  let roleLucid = guild.roles.cache.find(r => r.name === 'Lucid Customer');
  if (!roleLucid) {
    roleLucid = await guild.roles.create({
      name: 'Lucid Customer',
      color: 0x636E72,
      hoist: true,
      reason: 'Role khách hàng mua hàng tại shop',
      mentionable: false
    }).catch(() => null);
  }

  // Delete language selection channel if it exists
  const selectLangChan = guild.channels.cache.find(c => c.name.includes('select-language'));
  if (selectLangChan) {
    await selectLangChan.delete('Xóa kênh chọn role ngôn ngữ không còn cần thiết').catch(() => {});
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

  // 2. Category ORDER - Open for @everyone
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

  // Category ORDER permissions: Allow @everyone to view
  await catOrder.permissionOverwrites.set([
    { id: everyoneRole.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory] },
    { id: staffRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageMessages] },
    { id: botMember.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.EmbedLinks, PermissionsBitField.Flags.ManageChannels] }
  ]).catch(() => {});

  // 3. Menu channel (accessible to @everyone, read-only with language buttons)
  const menuOverwrites = [
    { id: everyoneRole.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory], deny: [PermissionsBitField.Flags.SendMessages] },
    { id: botMember.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.EmbedLinks, PermissionsBitField.Flags.ManageChannels] },
    { id: staffRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }
  ];
  const menuViChannel = await getOrCreateTextChannel('『🛒』menu', catOrder, menuOverwrites);

  // 4. Ticket channels (accessible to @everyone)
  const tpChans = data.ticketPanel || {};
  const ticketViChannelName = tpChans.channelNameVi || '『🎟』ticket-support';
  const ticketOverwrites = [
    { id: everyoneRole.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory], deny: [PermissionsBitField.Flags.SendMessages] },
    { id: botMember.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.EmbedLinks, PermissionsBitField.Flags.ManageChannels] },
    { id: staffRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }
  ];
  const ticketViChannel = await getOrCreateTextChannel(ticketViChannelName, catOrder, ticketOverwrites);

  // Delete redundant temp channels (including old separate EN ticket channels)
  const redundantNames = ['『🛒』menu-en', '『💬』chat-vi', '『💬』chat-en', '『🎟』ticket-support-en', 'ticket-support-en'];
  for (const rName of redundantNames) {
    const ch = guild.channels.cache.find(c => c.name === rName);
    if (ch) await ch.delete().catch(() => {});
  }

  // 5. Category TICKET for active customer tickets (Strictly Private for customer & staff)
  const catTicketTarget = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === 'TICKET') ||
                          guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.id === '1441078154239410206');

  if (catTicketTarget) {
    await catTicketTarget.permissionOverwrites.set([
      { id: everyoneRole.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: staffRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageMessages, PermissionsBitField.Flags.ReadMessageHistory] },
      { id: botMember.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ManageMessages] }
    ]).catch(() => {});
  }

  // 6. Absolute Safeguard: Strictly lock down private/staff/admin/log/ticket categories and channels
  // NEVER unlock these channels to @everyone!
  const privateKeywords = ['log', 'staff', 'admin', 'mod', 'vc', 'kho-anh', 'ticket', 'farm', 'owovn', 'foreign'];
  const allGuildChannels = await guild.channels.fetch().catch(() => guild.channels.cache);
  for (const [, ch] of allGuildChannels) {
    if (!ch) continue;
    const chName = (ch.name || '').toLowerCase();
    const parentName = (ch.parent?.name || '').toLowerCase();
    const isPrivate = privateKeywords.some(kw => chName.includes(kw) || parentName.includes(kw));

    if (isPrivate) {
      await ch.permissionOverwrites.edit(everyoneRole.id, {
        ViewChannel: false
      }).catch(() => {});
    }
  }

  // 7. Update and save clean channels into menuData
  data.channels = {
    menuViChannelId: menuViChannel.id,
    ticketViChannelId: ticketViChannel.id,
    ticketCategoryId: catTicketTarget?.id || '1441078154239410206',
    orderCategoryId: catOrder.id,
    customerRoleId: roleLucid?.id || '1427288885230178384'
  };
  delete data.bilingualRoles;
  delete data.channels.ticketEnChannelId;
  data.menuChannelId = menuViChannel.id;
  data.ticketChannelId = ticketViChannel.id;

  const menuMod = require('./menuData');
  menuMod.saveData(data);

  // 8. Synchronize unified menu and tickets (bilingual panels)
  await syncMenuChannel(menuViChannel.id, data.defaultLanguage || 'vi');
  await syncTicketChannel(ticketViChannel.id, data.defaultLanguage || 'vi');

  return {
    ok: true,
    categories: { order: catOrder, ticket: catTicketTarget },
    channels: {
      menuVi: menuViChannel,
      ticketVi: ticketViChannel
    }
  };
}

// Alias for backwards compatibility
const setupBilingualServer = unlockServerChannels;

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
  const targetTicketId = data.ticketChannelId || data.channels?.ticketViChannelId;
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

function buildTicketMessage(lang = null) {
  const data = getMenuData();
  const currentLang = (lang === 'en') ? 'en' : 'vi';
  const isEn = currentLang === 'en';
  const tp = data.ticketPanel || {};
  const langConf = isEn ? (tp.en || {}) : (tp.vi || {});
  const storeName = data.storeName || '4AM STORE';

  // 1. Build Title & Description
  const rawTitle = langConf.title || (isEn ? '🎟️ SUPPORT & ORDER CENTER — {storeName}' : '🎟️ TRUNG TÂM HỖ TRỢ & MUA HÀNG — {storeName}');
  const embedTitle = rawTitle.replace(/\{storeName\}/g, storeName);

  let descLines = [];
  if (langConf.subtitle) {
    descLines.push(langConf.subtitle.replace(/\{storeName\}/g, storeName));
    descLines.push('');
  }
  if (Array.isArray(langConf.lines) && langConf.lines.length > 0) {
    for (const l of langConf.lines) {
      if (l !== undefined && l !== null) {
        if (l.trim()) {
          descLines.push(l.replace(/\{storeName\}/g, storeName));
        } else if (descLines.length > 0 && descLines[descLines.length - 1] !== '') {
          descLines.push('');
        }
      }
    }
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
  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`create_general_ticket|${currentLang}`)
      .setLabel(btnLabel)
      .setStyle(ButtonStyle.Success)
  );

  const langButtonsRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('switch_ticket_lang|vi')
      .setLabel('🇻🇳 Tiếng Việt')
      .setStyle(currentLang === 'vi' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('switch_ticket_lang|en')
      .setLabel('🇬🇧 English')
      .setStyle(currentLang === 'en' ? ButtonStyle.Primary : ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [actionRow, langButtonsRow] };
}

async function syncTicketChannel(targetChannelId = null, targetLang = null) {
  const data = getMenuData();
  const ticketChannelId = targetChannelId || data.ticketChannelId || data.channels?.ticketViChannelId || process.env.TICKET_PANEL_CHANNEL_ID || '1379348256743489546';
  const channel = await client.channels.fetch(ticketChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const defaultLang = targetLang || data.defaultLanguage || 'vi';
  const tp = data.ticketPanel || {};

  // 1. Rename channel if desired name is configured and different
  const desiredChannelName = tp.channelNameVi || '『🎟』ticket-support';
  if (channel.name !== desiredChannelName && typeof channel.setName === 'function') {
    try {
      await channel.setName(desiredChannelName);
      console.log(`🏷️ Đã đổi tên kênh ticket trên Discord thành: #${desiredChannelName}`);
    } catch (e) {
      console.warn(`Không thể đổi tên kênh #${channel.name}:`, e.message);
    }
  }

  // 2. Build bilingual ticket message & clean old bot messages
  const messageData = buildTicketMessage(defaultLang);
  try {
    const fetched = await channel.messages.fetch({ limit: 20 });
    const botMsgs = fetched.filter(m => m.author.id === client.user.id);
    for (const m of botMsgs.values()) {
      await m.delete().catch(() => {});
    }
  } catch (_) {}

  await channel.send(messageData);
  console.log(`✅ Đã đồng bộ ticket panel song ngữ vào kênh #${channel.name} (${defaultLang.toUpperCase()})`);

  // 3. Tự động xóa kênh ticket tiếng Anh thừa nếu còn tồn tại
  const enChannelId = data.channels?.ticketEnChannelId;
  if (enChannelId && enChannelId !== ticketChannelId) {
    const enChan = await client.channels.fetch(enChannelId).catch(() => null);
    if (enChan) {
      await enChan.delete('Xóa kênh ticket tiếng Anh riêng biệt, chuyển sang panel song ngữ tại kênh chính').catch(() => {});
      console.log(`🗑️ Đã xóa kênh ticket thừa: #${enChan.name}`);
    }
    delete data.channels.ticketEnChannelId;
    const menuMod = require('./menuData');
    menuMod.saveData(data);
  }
}

//
// ----------- Events -----------
//

// Utility: check if user is staff (an toàn khi tương tác trong DM)
async function isStaffMember(i) {
  if (!i.guild) return false;
  const staffRoleId = process.env.STAFF_ROLE_ID;
  try {
    const member = await i.guild.members.fetch(i.user.id).catch(() => null);
    if (!member) return false;
    return member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
           (staffRoleId && member.roles.cache.has(staffRoleId));
  } catch (_) {
    return false;
  }
}

// Utility: check if user is staff or assigned seller for ticket
async function canManageTicket(i, order = null) {
  if (await isStaffMember(i)) return true;
  if (!i.guild) return false;
  try {
    const member = await i.guild.members.fetch(i.user.id).catch(() => null);
    if (!member) return false;
    if (member.permissions.has(PermissionsBitField.Flags.Administrator) ||
        member.permissions.has(PermissionsBitField.Flags.ManageChannels) ||
        member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return true;
    }
  } catch (_) {}

  if (order) {
    try {
      const snap = typeof order.planSnapshotJson === 'string' ? JSON.parse(order.planSnapshotJson || '{}') : (order.planSnapshotJson || {});
      if (Array.isArray(snap.handlers) && snap.handlers.includes(i.user.id)) return true;
      if (snap.sellerId === i.user.id) return true;
    } catch (_) {}
  }
  return false;
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await seedCatalog();
  console.log('Catalog seeded ✅');
  await syncMenuChannel();
  await syncTicketChannel();
  startExpiryReminderScheduler();
  console.log('4AM Discord Bot is ready! 🚀');
});


client.on('interactionCreate', async (i) => {
  try {
  // --- Deprecated Language Role Buttons (No longer required) ---
  if (i.isButton() && (i.customId === 'role_lang_vi' || i.customId === 'role_lang_en')) {
    return i.reply({
      content: 'ℹ️ **Server đã mở toàn bộ kênh cho tất cả mọi người!** Bạn không cần phải chọn role ngôn ngữ nữa.',
      ephemeral: true
    });
  }

  // --- Switch Menu Language (VI / EN) ---
  if (i.isButton() && i.customId.startsWith('switch_menu_lang|')) {
    const newLang = i.customId.split('|')[1] || 'vi';
    const menuMsg = buildMenuMessage(newLang);
    await i.update(menuMsg).catch(() => {});
    return;
  }

  // --- Switch Ticket Language (VI / EN) ---
  if (i.isButton() && i.customId.startsWith('switch_ticket_lang|')) {
    const newLang = i.customId.split('|')[1] || 'vi';
    const ticketMsg = buildTicketMessage(newLang);
    await i.update(ticketMsg).catch(() => {});
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
    
    const formatPackageItemBox = (rawList) => {
      if (!Array.isArray(rawList) || rawList.length === 0) return '';
      const parsed = rawList.map(item => {
        const raw = String(item || '').trim().replace(/^•\s*/, '');
        if (raw.includes('|')) {
          const parts = raw.split('|').map(s => s.trim());
          return { name: parts[0], price: parts.slice(1).join(' | ') };
        }
        return { name: raw, price: '' };
      });

      const maxTotalLen = Math.max(...parsed.map(p => (p.name + p.price).length));

      if (maxTotalLen <= 55) {
        const maxNameLen = Math.max(...parsed.map(p => p.name.length));
        const maxPriceLen = Math.max(...parsed.map(p => p.price.length));
        return parsed.map(p => {
          if (!p.price) return `• \` ${p.name} \``;
          const nameCol = p.name.padEnd(maxNameLen);
          const priceCol = p.price.padStart(maxPriceLen);
          return `• \` ${nameCol}  │  ${priceCol} \``;
        }).join('\n');
      }

      return parsed.map(p => {
        if (!p.price) return `• \` ${p.name} \``;
        return `• \` ${p.name} \`\n> ➜ **${isEn ? 'Price' : 'Giá'}:** \`${p.price}\``;
      }).join('\n');
    };

    const itemsList = formatPackageItemBox(items);
    const baseTitle = isEn ? (cat.titleEn || `Price List - ${cat.labelEn || cat.label}`) : (cat.title || `Bảng Giá ${cat.label}`);
    const catTitle = (cat.emoji && !baseTitle.includes(cat.emoji)) ? `${cat.emoji} ${baseTitle}` : baseTitle;
    const rawSubtitle = isEn ? (cat.subtitleEn || cat.subtitle || '') : (cat.subtitle || '');
    let noteLine = '';
    if (rawSubtitle && rawSubtitle.trim()) {
      noteLine = `-# ${rawSubtitle.trim()}`;
    }

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
      noteLine,
      handlerLine,
      itemsList
    ].filter(Boolean);

    const catEmbed = new EmbedBuilder()
      .setTitle(catTitle)
      .setDescription(descParts.join('\n\n'))
      .setColor(cat.color || 0x5865F2);

    if (cat.bannerUrl && cat.bannerUrl.trim() && !cat.bannerUrl.includes('imgur.com/W29F1cT') && !cat.bannerUrl.includes('imgur.com/rN9xV4v')) {
      catEmbed.setImage(cat.bannerUrl.trim());
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

    const cleanKey = String(categoryKey).toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const channelName = `ticket-${cleanKey}-${orderDraftNo}`.toLowerCase();
    const ticketChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: ticketCategoryId ?? undefined,
      permissionOverwrites: overwrites,
      reason: `Ticket mua ${cat.label} tạo bởi ${i.user.tag}`
    });

    if (!isStaff) markTicketOpened(i.user.id);

    // Auto-record order in SQLite Database & attach ticket
    let dbOrder = null;
    try {
      const dbUser = await ensureUser(i.user.id, null, i.user.globalName || i.user.username, null);
      const sku = `CAT_${categoryKey.toUpperCase()}`;
      const dbProduct = await findOrCreateProduct({
        type: 'STORE_CATEGORY',
        name: cat.label || categoryKey,
        sku,
        specJson: JSON.stringify(cat),
        priceCents: 0,
        currency: 'VNĐ'
      });
      const planSnapshot = {
        categoryKey,
        categoryLabel: cat.label,
        categoryLabelEn: cat.labelEn,
        sellerId: seller?.id || 'shop_common',
        sellerName: seller?.username ? `@${seller.username}` : (seller?.name || 'Shop Admin'),
        handlers: allHandlerIds,
        accountIndex: accountIndex || 'all',
        createdAt: new Date().toISOString()
      };
      dbOrder = await createOrder({
        orderNo: orderDraftNo,
        userId: dbUser.id,
        productId: dbProduct.id,
        planSnapshotJson: JSON.stringify(planSnapshot),
        amountCents: 0,
        currency: 'VNĐ'
      });
      await attachTicket(dbOrder.id, guild.id, ticketChannel.id, dbUser.id);
    } catch (orderErr) {
      console.error('Lỗi khi tự động tạo đơn hàng trong DB:', orderErr);
    }

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
          ? '👉 **Please choose which package you want to buy (or choose "Need consultation") from the menu below:**'
          : '👉 **Vui lòng chọn loại gói bạn muốn mua (hoặc chọn "Cần tư vấn") ở menu bên dưới:**'
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

    const staffActionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`quick_staff_complete|${orderDraftNo}`)
        .setLabel(isEn ? '✅ Complete Order' : '✅ Chốt & Hoàn Thành')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`quick_staff_cancel|${orderDraftNo}`)
        .setLabel(isEn ? '❌ Cancel Order' : '❌ Hủy Đơn Hàng')
        .setStyle(ButtonStyle.Secondary)
    );

    const mentions = [`<@${i.user.id}>`];
    for (const hId of allHandlerIds) {
      if (hId && hId !== i.user.id && !mentions.includes(`<@${hId}>`)) {
        mentions.push(`<@${hId}>`);
      }
    }
    const shouldPingStaff = cat.pingStaff === true || (allHandlerIds.length === 0);
    if (shouldPingStaff && staffRoleId && !mentions.includes(`<@&${staffRoleId}>`)) {
      mentions.push(`<@&${staffRoleId}>`);
    }

    const itemPrompt = buildCategoryItemPrompt(cat, categoryKey, lang, orderDraftNo);
    await ticketChannel.send({
      content: mentions.join(' '),
      embeds: [welcomeEmbed],
      components: [itemPrompt.row, ticketButtons, staffActionRow]
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

    // Auto-record support order in SQLite Database & attach ticket
    let dbOrder = null;
    try {
      const dbUser = await ensureUser(i.user.id, null, i.user.globalName || i.user.username, null);
      const dbProduct = await findOrCreateProduct({
        type: 'SUPPORT_TICKET',
        name: isEn ? 'General Support' : 'Hỗ Trợ Khách Hàng',
        sku: 'SUPPORT_GENERAL',
        specJson: JSON.stringify({ type: 'support', lang }),
        priceCents: 0,
        currency: 'VNĐ'
      });
      const planSnapshot = {
        categoryKey: 'support',
        categoryLabel: isEn ? 'Support Ticket' : 'Ticket Hỗ Trợ',
        sellerId: defaultSeller?.id || 'admin',
        sellerName: defaultSeller?.username ? `@${defaultSeller.username}` : (defaultSeller?.name || 'Shop Admin'),
        handlers: sellerDiscordId ? [sellerDiscordId] : [],
        createdAt: new Date().toISOString()
      };
      dbOrder = await createOrder({
        orderNo: orderDraftNo,
        userId: dbUser.id,
        productId: dbProduct.id,
        planSnapshotJson: JSON.stringify(planSnapshot),
        amountCents: 0,
        currency: 'VNĐ'
      });
      await attachTicket(dbOrder.id, guild.id, ticketChannel.id, dbUser.id);
    } catch (orderErr) {
      console.error('Lỗi khi tự động tạo ticket support trong DB:', orderErr);
    }

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
        .setLabel(isEn ? '🔒 Close Ticket' : '🔒 Đóng Ticket')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`show_seller_selector|${orderDraftNo}`)
        .setLabel(isEn ? '💳 Switch Bank Account' : '💳 Đổi STK người bán khác')
        .setStyle(ButtonStyle.Secondary)
    );

    const staffActionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`quick_staff_complete|${orderDraftNo}`)
        .setLabel(isEn ? '✅ Complete Order' : '✅ Chốt & Hoàn Thành')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`quick_staff_cancel|${orderDraftNo}`)
        .setLabel(isEn ? '❌ Cancel Order' : '❌ Hủy Đơn Hàng')
        .setStyle(ButtonStyle.Secondary)
    );

    const generalMentions = [`<@${i.user.id}>`];
    if (sellerDiscordId && sellerDiscordId !== i.user.id) {
      generalMentions.push(`<@${sellerDiscordId}>`);
    }
    if (staffRoleId) {
      generalMentions.push(`<@&${staffRoleId}>`);
    }

    const generalPrompt = buildGeneralTicketPrompt(data.categories || {}, lang, orderDraftNo);
    const comps = generalPrompt?.row ? [generalPrompt.row, ticketButtons, staffActionRow] : [ticketButtons, staffActionRow];

    await ticketChannel.send({
      content: generalMentions.join(' '),
      embeds: [welcomeEmbed],
      components: comps
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

  // --- Customer Selected Variant / Package or Consultation in Ticket ---
  if (i.isStringSelectMenu() && i.customId.startsWith('select_ticket_item|')) {
    const parts = i.customId.split('|');
    const orderDraftNo = parts[1];
    const categoryKey = parts[2];
    const lang = parts[3] || 'vi';
    const isEn = lang === 'en';
    const selectedVal = i.values[0];

    const data = getMenuData();
    const cat = data.categories?.[categoryKey] || { label: 'Sản phẩm', color: 0x00C2A8 };
    const catName = (isEn && cat.labelEn) ? cat.labelEn : (cat.label || categoryKey);
    const { seller, handlers } = getSellerForCategory(categoryKey);
    const staffRoleId = process.env.STAFF_ROLE_ID;

    // Find order in DB if exists
    const order = await prisma.order.findFirst({
      where: { orderNo: orderDraftNo },
      include: { user: true, product: true }
    });

    const isStaff = await canManageTicket(i, order);

    if (order && order.user?.discordId && order.user.discordId !== i.user.id && !isStaff) {
      return i.reply({
        content: isEn ? '❌ Only the customer who opened this ticket or staff can select options.' : '❌ Chỉ người tạo ticket hoặc nhân viên phụ trách mới có thể thao tác chọn gói.',
        ephemeral: true
      });
    }

    const allHandlerIds = (handlers && handlers.length > 0) ? handlers : (seller?.discordId ? [seller.discordId] : []);
    const pings = [];
    allHandlerIds.forEach(hId => {
      if (hId && !pings.includes(`<@${hId}>`)) pings.push(`<@${hId}>`);
    });
    const shouldPingStaff = cat.pingStaff === true || (allHandlerIds.length === 0);
    if (shouldPingStaff && staffRoleId && !pings.includes(`<@&${staffRoleId}>`)) {
      pings.push(`<@&${staffRoleId}>`);
    }
    const pingStr = pings.length ? pings.join(' ') : (staffRoleId ? `<@&${staffRoleId}>` : 'Nhân viên hỗ trợ');

    if (selectedVal === 'consult_seller') {
      const updatedPrompt = buildCategoryItemPrompt(cat, categoryKey, lang, orderDraftNo, 'consult_seller');
      const consultEmbed = new EmbedBuilder()
        .setTitle(isEn ? '💬 NEED CONSULTATION & DISCUSS WITH SELLER' : '💬 YÊU CẦU TƯ VẤN & BÀN BẠC VỚI NGƯỜI BÁN')
        .setDescription([
          isEn
            ? `Customer <@${i.user.id}> has selected: **Need consultation & discuss with seller** regarding **${catName}**.`
            : `Khách hàng <@${i.user.id}> đã chọn: **Cần tư vấn và bàn bạc với người bán** về **${catName}**.`,
          '',
          isEn
            ? `💬 <@${i.user.id}>, please leave your inquiries or details below so our staff can assist you right away!`
            : `💬 <@${i.user.id}> vui lòng để lại câu hỏi, thời hạn hoặc yêu cầu cụ thể bên dưới để người bán hỗ trợ bạn ngay nhé!`,
          '',
          isEn ? `*(You can re-select a package from the menu below if you change your mind)*` : `*(Bạn có thể chọn lại gói trong menu bên dưới nếu muốn đổi)*`
        ].join('\n'))
        .setColor(0xF1C40F)
        .setTimestamp();

      const ticketButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('close_simple_ticket').setLabel(isEn ? '🔒 Close Ticket' : '🔒 Đóng Ticket').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`show_seller_selector|${orderDraftNo}`).setLabel(isEn ? '💳 Switch Bank Account' : '💳 Đổi STK người bán khác').setStyle(ButtonStyle.Secondary)
      );
      const staffActionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`quick_staff_complete|${orderDraftNo}`).setLabel(isEn ? '✅ Complete Order' : '✅ Chốt & Hoàn Thành').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`quick_staff_cancel|${orderDraftNo}`).setLabel(isEn ? '❌ Cancel Order' : '❌ Hủy Đơn Hàng').setStyle(ButtonStyle.Secondary)
      );

      await i.update({
        components: [updatedPrompt.row, ticketButtons, staffActionRow]
      });

      await i.channel.send({
        content: `🔔 ${pingStr}: Khách hàng <@${i.user.id}> đang **cần tư vấn và bàn bạc với người bán** về **${catName}**! Vui lòng vào hỗ trợ khách nhé!`,
        embeds: [consultEmbed]
      });

      if (order) {
        try {
          const snapshot = typeof order.planSnapshotJson === 'string' ? JSON.parse(order.planSnapshotJson || '{}') : (order.planSnapshotJson || {});
          snapshot.selectedItem = isEn ? 'Need consultation & discuss with seller' : 'Cần tư vấn và bàn bạc với người bán';
          snapshot.consultationRequested = true;
          await prisma.order.update({
            where: { id: order.id },
            data: { planSnapshotJson: JSON.stringify(snapshot) }
          });
        } catch (err) {
          console.error('Lỗi cập nhật order snapshot (consult):', err);
        }
      }
      return;
    }

    if (selectedVal.startsWith('item_')) {
      const idx = parseInt(selectedVal.replace('item_', ''), 10);
      const rawList = (isEn && cat.itemsEn && cat.itemsEn.length) ? cat.itemsEn : (cat.items || []);
      const itemRaw = rawList[idx] || '';
      const cleanRaw = String(itemRaw).trim().replace(/^•\s*/, '');
      let itemName = cleanRaw;
      let itemPrice = '';
      if (cleanRaw.includes('|')) {
        const parts = cleanRaw.split('|').map(s => s.trim());
        itemName = parts[0];
        itemPrice = parts.slice(1).join(' | ');
      }

      const amountCents = parsePrice(itemPrice);

      const updatedPrompt = buildCategoryItemPrompt(cat, categoryKey, lang, orderDraftNo, selectedVal);
      const selectedEmbed = new EmbedBuilder()
        .setTitle(isEn ? `✅ SELECTED: ${itemName.toUpperCase()}` : `✅ ĐÃ CHỌN: ${itemName.toUpperCase()}`)
        .setDescription([
          isEn ? `Customer <@${i.user.id}> selected a package:` : `Khách hàng <@${i.user.id}> đã chọn loại sản phẩm:`,
          '',
          isEn ? `📦 **Product:** **${catName}**` : `📦 **Sản phẩm:** **${catName}**`,
          isEn ? `🏷️ **Package:** **${itemName}**` : `🏷️ **Loại gói:** **${itemName}**`,
          isEn ? `💰 **Price:** **${itemPrice || 'Contact'}**` : `💰 **Đơn giá:** **${itemPrice || 'Liên hệ'}**`,
          '',
          isEn
            ? `📌 Staff/Seller has been notified and will assist you shortly!`
            : `📌 Nhân viên/người bán đã nhận được lựa chọn và sẽ hỗ trợ giao dịch cho bạn ngay!`,
          '',
          isEn ? `*(You can re-select from the menu above if you want to switch to another plan)*` : `*(Bạn có thể chọn lại gói khác trong menu ở trên nếu muốn đổi)*`
        ].join('\n'))
        .setColor(0x2ECC71)
        .setTimestamp();

      const ticketButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('close_simple_ticket').setLabel(isEn ? '🔒 Close Ticket' : '🔒 Đóng Ticket').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`show_seller_selector|${orderDraftNo}`).setLabel(isEn ? '💳 Switch Bank Account' : '💳 Đổi STK người bán khác').setStyle(ButtonStyle.Secondary)
      );
      const staffActionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`quick_staff_complete|${orderDraftNo}`).setLabel(isEn ? '✅ Complete Order' : '✅ Chốt & Hoàn Thành').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`quick_staff_cancel|${orderDraftNo}`).setLabel(isEn ? '❌ Cancel Order' : '❌ Hủy Đơn Hàng').setStyle(ButtonStyle.Secondary)
      );

      await i.update({
        components: [updatedPrompt.row, ticketButtons, staffActionRow]
      });

      await i.channel.send({
        content: `📢 ${pingStr}: Khách hàng <@${i.user.id}> muốn mua **${catName}** — gói **${itemName}** (${itemPrice || ''}). Vui lòng kiểm tra và hỗ trợ khách hàng!`,
        embeds: [selectedEmbed]
      });

      if (order) {
        try {
          const snapshot = typeof order.planSnapshotJson === 'string' ? JSON.parse(order.planSnapshotJson || '{}') : (order.planSnapshotJson || {});
          snapshot.selectedItem = itemName;
          snapshot.itemPrice = itemPrice;
          snapshot.consultationRequested = false;

          const updateData = { planSnapshotJson: JSON.stringify(snapshot) };
          if (amountCents > 0) {
            updateData.amountCents = amountCents;
          }
          await prisma.order.update({
            where: { id: order.id },
            data: updateData
          });
        } catch (err) {
          console.error('Lỗi cập nhật order snapshot (item):', err);
        }
      }
      return;
    }
  }

  // --- Customer Selected Category or Consultation in General Support Ticket ---
  if (i.isStringSelectMenu() && i.customId.startsWith('select_general_ticket_category|')) {
    const parts = i.customId.split('|');
    const orderDraftNo = parts[1];
    const lang = parts[2] || 'vi';
    const isEn = lang === 'en';
    const selectedVal = i.values[0];

    const data = getMenuData();
    const staffRoleId = process.env.STAFF_ROLE_ID;

    const order = await prisma.order.findFirst({
      where: { orderNo: orderDraftNo },
      include: { user: true, product: true }
    });

    const isStaff = await canManageTicket(i, order);

    if (order && order.user?.discordId && order.user.discordId !== i.user.id && !isStaff) {
      return i.reply({
        content: isEn ? '❌ Only the customer who opened this ticket or staff can select options.' : '❌ Chỉ người tạo ticket hoặc nhân viên phụ trách mới có thể thao tác.',
        ephemeral: true
      });
    }

    const ticketButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('close_simple_ticket').setLabel(isEn ? '🔒 Close Ticket' : '🔒 Đóng Ticket').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`show_seller_selector|${orderDraftNo}`).setLabel(isEn ? '💳 Switch Bank Account' : '💳 Đổi STK người bán khác').setStyle(ButtonStyle.Secondary)
    );
    const staffActionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`quick_staff_complete|${orderDraftNo}`).setLabel(isEn ? '✅ Complete Order' : '✅ Chốt & Hoàn Thành').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`quick_staff_cancel|${orderDraftNo}`).setLabel(isEn ? '❌ Cancel Order' : '❌ Hủy Đơn Hàng').setStyle(ButtonStyle.Secondary)
    );

    if (selectedVal === 'consult_seller') {
      const consultEmbed = new EmbedBuilder()
        .setTitle(isEn ? '💬 NEED CONSULTATION & DISCUSS WITH SELLER' : '💬 YÊU CẦU TƯ VẤN & BÀN BẠC VỚI NGƯỜI BÁN')
        .setDescription([
          isEn
            ? `Customer <@${i.user.id}> has selected: **Need consultation & discuss with seller**.`
            : `Khách hàng <@${i.user.id}> đã chọn: **Cần tư vấn và bàn bạc với người bán**.`,
          '',
          isEn
            ? `💬 <@${i.user.id}>, please leave your inquiries or details below so our staff can assist you right away!`
            : `💬 <@${i.user.id}> vui lòng để lại câu hỏi hoặc nội dung bạn cần hỗ trợ bên dưới để nhân viên phục vụ nhé!`,
          '',
          isEn ? `*(You can re-select below if you wish to browse a product)*` : `*(Bạn có thể chọn lại sản phẩm khác ở menu bên dưới)*`
        ].join('\n'))
        .setColor(0xF1C40F)
        .setTimestamp();

      const generalPrompt = buildGeneralTicketPrompt(data.categories || {}, lang, orderDraftNo, 'consult_seller');
      await i.update({
        components: [generalPrompt.row, ticketButtons, staffActionRow]
      });

      await i.channel.send({
        content: `🔔 ${staffRoleId ? `<@&${staffRoleId}>` : 'Staff'}: Khách hàng <@${i.user.id}> đang **cần tư vấn và bàn bạc với người bán**! Vui lòng vào hỗ trợ khách nhé!`,
        embeds: [consultEmbed]
      });

      if (order) {
        try {
          const snapshot = typeof order.planSnapshotJson === 'string' ? JSON.parse(order.planSnapshotJson || '{}') : (order.planSnapshotJson || {});
          snapshot.selectedItem = 'Cần tư vấn và bàn bạc với người bán';
          snapshot.consultationRequested = true;
          await prisma.order.update({
            where: { id: order.id },
            data: { planSnapshotJson: JSON.stringify(snapshot) }
          });
        } catch (_) {}
      }
      return;
    }

    // A category was selected!
    const cat = data.categories?.[selectedVal];
    if (!cat) {
      return i.reply({ content: isEn ? '❌ Category not found.' : '❌ Không tìm thấy danh mục này.', ephemeral: true });
    }

    // Transform into the item selector for that category!
    const itemPrompt = buildCategoryItemPrompt(cat, selectedVal, lang, orderDraftNo);
    await i.update({
      components: [itemPrompt.row, ticketButtons, staffActionRow]
    });

    // Also update order planSnapshot with category info
    if (order) {
      try {
        const { seller, handlers } = getSellerForCategory(selectedVal);
        const snapshot = typeof order.planSnapshotJson === 'string' ? JSON.parse(order.planSnapshotJson || '{}') : (order.planSnapshotJson || {});
        snapshot.categoryKey = selectedVal;
        snapshot.categoryLabel = cat.label;
        snapshot.categoryLabelEn = cat.labelEn;
        if (seller) {
          snapshot.sellerId = seller.id || selectedVal;
          snapshot.sellerName = seller.username ? `@${seller.username}` : (seller.name || 'Shop Admin');
        }
        await prisma.order.update({
          where: { id: order.id },
          data: { planSnapshotJson: JSON.stringify(snapshot) }
        });
      } catch (_) {}
    }
  }

  // --- Quick Staff Complete Button (Shows Modal for Amount & Delivery Note) ---
  if (i.isButton() && i.customId.startsWith('quick_staff_complete|')) {
    const orderNo = i.customId.split('|')[1];
    const order = await prisma.order.findUnique({
      where: { orderNo },
      include: { user: true, product: true, ticket: true }
    });
    if (!order) {
      return i.reply({ content: '❌ Không tìm thấy thông tin đơn hàng trong hệ thống.', ephemeral: true });
    }
    const isAllowed = await canManageTicket(i, order);
    if (!isAllowed) {
      return i.reply({ content: '⚠️ Chỉ Nhân viên (Staff) hoặc Người bán phụ trách mới có quyền chốt đơn này!', ephemeral: true });
    }

    let defaultPrice = order.amountCents > 0 ? order.amountCents : (order.product?.priceCents || 0);
    if (defaultPrice === 0) {
      let snap = {};
      try { snap = JSON.parse(order.planSnapshotJson || '{}'); } catch (_) {}
      if (snap.categoryKey) {
        const mData = menuData.loadData ? menuData.loadData() : menuData;
        const cat = mData?.categories?.[snap.categoryKey];
        if (cat && Array.isArray(cat.items)) {
          for (const item of cat.items) {
            if (typeof item === 'string') {
              const match = item.match(/\|\s*([\d\.,]+)\s*(?:k|vnđ|vnd)/i) || item.match(/([\d\.,]+)\s*(?:k|vnđ|vnd)/i);
              if (match) {
                const raw = match[1].replace(/[\.,]/g, '');
                const val = parseInt(raw, 10);
                if (!isNaN(val) && val > 0) {
                  defaultPrice = val;
                  break;
                }
              }
            }
          }
        }
      }
    }

    const modal = new ModalBuilder()
      .setCustomId(`modal_complete_order|${orderNo}`)
      .setTitle(`Chốt Đơn Hàng #${orderNo}`.slice(0, 45));

    const amountInput = new TextInputBuilder()
      .setCustomId('complete_amount')
      .setLabel('Số tiền thanh toán thực tế (VNĐ)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Ví dụ: 65000 (chỉ điền số)')
      .setValue(defaultPrice > 0 ? String(defaultPrice) : '')
      .setRequired(true);

    const noteInput = new TextInputBuilder()
      .setCustomId('complete_note')
      .setLabel('Ghi chú giao hàng / Tên gói đã chốt')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Ví dụ: Đã giao acc Netflix 1 tháng profile 2, MB Bank')
      .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder().addComponents(amountInput),
      new ActionRowBuilder().addComponents(noteInput)
    );

    return i.showModal(modal);
  }

  // --- Modal Submit: Complete Order ---
  if (i.isModalSubmit() && i.customId.startsWith('modal_complete_order|')) {
    const orderNo = i.customId.split('|')[1];
    const rawAmount = i.fields.getTextInputValue('complete_amount')?.trim() || '';
    const note = i.fields.getTextInputValue('complete_note')?.trim() || '';

    const cleanAmount = parseInt(rawAmount.replace(/\D/g, ''), 10);
    if (isNaN(cleanAmount) || cleanAmount < 0) {
      return i.reply({ content: '⚠️ Vui lòng nhập số tiền VNĐ hợp lệ (ví dụ: 65000)!', ephemeral: true });
    }

    const order = await prisma.order.findUnique({
      where: { orderNo },
      include: { user: true, product: true, ticket: true }
    });
    if (!order) {
      return i.reply({ content: '❌ Không tìm thấy đơn hàng trong hệ thống.', ephemeral: true });
    }

    let snap = {};
    try { snap = JSON.parse(order.planSnapshotJson || '{}'); } catch (_) {}
    snap.completedBy = i.user.tag;
    snap.completedById = i.user.id;
    snap.completedNote = note;
    snap.completedAt = new Date().toISOString();

    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'COMPLETED',
        amountCents: cleanAmount,
        planSnapshotJson: JSON.stringify(snap)
      }
    });

    const receiptEmbed = new EmbedBuilder()
      .setTitle(`🎉 XÁC NHẬN HOÀN THÀNH ĐƠN HÀNG #${orderNo}`)
      .setColor(0x10B981)
      .setDescription([
        `Đơn hàng **#${orderNo}** đã được nhân viên <@${i.user.id}> chốt thành công và lưu vào Web Control Panel!`,
        '',
        `👤 **Khách hàng:** <@${order.user.discordId}>`,
        `💰 **Số tiền thanh toán:** **${cleanAmount.toLocaleString('vi-VN')} VNĐ**`,
        note ? `📝 **Ghi chú bàn giao:** ${note}` : '',
        `⏰ **Thời gian:** <t:${Math.floor(Date.now() / 1000)}:F>`,
        '',
        '🌟 *Cảm ơn bạn đã tin tưởng mua hàng tại 4AM STORE! Đơn hàng đã được lưu trữ an toàn.*'
      ].filter(Boolean).join('\n'))
      .setFooter({ text: '4AM STORE • Quản lý đơn hàng tự động' })
      .setTimestamp();

    const closeRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('close_simple_ticket')
        .setLabel('🔒 Đóng Ticket Ngay')
        .setStyle(ButtonStyle.Danger)
    );

    await i.reply({ embeds: [receiptEmbed], components: [closeRow] });

    // Send DM to customer if possible
    try {
      const customer = await client.users.fetch(order.user.discordId).catch(() => null);
      if (customer) {
        const dmEmbed = new EmbedBuilder()
          .setTitle(`🎉 ĐƠN HÀNG #${orderNo} HOÀN THÀNH`)
          .setColor(0x10B981)
          .setDescription([
            `Cảm ơn bạn đã mua hàng tại **4AM STORE**!`,
            `Đơn hàng **#${orderNo}** của bạn đã được hoàn tất thành công.`,
            '',
            `💰 **Số tiền:** **${cleanAmount.toLocaleString('vi-VN')} VNĐ**`,
            note ? `📝 **Ghi chú:** ${note}` : '',
            '',
            'Chúc bạn trải nghiệm dịch vụ vui vẻ! Nếu cần hỗ trợ thêm, hãy mở lại ticket tại server nhé.'
          ].filter(Boolean).join('\n'))
          .setTimestamp();
        await customer.send({ embeds: [dmEmbed] }).catch(() => {});
      }
    } catch (_) {}

    return;
  }

  // --- Quick Staff Cancel Button (1-Click Instant, No Modal) ---
  if (i.isButton() && i.customId.startsWith('quick_staff_cancel|')) {
    const orderNo = i.customId.split('|')[1];
    const order = await prisma.order.findUnique({
      where: { orderNo },
      include: { user: true, product: true, ticket: true }
    });
    if (!order) {
      return i.reply({ content: '❌ Không tìm thấy thông tin đơn hàng trong hệ thống.', ephemeral: true });
    }
    const isAllowed = await canManageTicket(i, order);
    if (!isAllowed) {
      return i.reply({ content: '⚠️ Chỉ Nhân viên (Staff) hoặc Người bán phụ trách mới có quyền hủy đơn này!', ephemeral: true });
    }

    let snap = {};
    try { snap = JSON.parse(order.planSnapshotJson || '{}'); } catch (_) {}
    snap.cancelledBy = i.user.tag;
    snap.cancelledById = i.user.id;
    snap.cancelledReason = 'Khách hủy / không chốt đơn';
    snap.cancelledAt = new Date().toISOString();

    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'CANCELLED',
        planSnapshotJson: JSON.stringify(snap)
      }
    });

    await prisma.ticket.updateMany({
      where: { channelId: i.channel.id },
      data: { status: 'CLOSED' }
    });

    const cancelEmbed = new EmbedBuilder()
      .setTitle(`❌ ĐÃ HỦY ĐƠN HÀNG #${orderNo}`)
      .setColor(0xEF4444)
      .setDescription([
        `Đơn hàng **#${orderNo}** đã được nhân viên <@${i.user.id}> đánh dấu **ĐÃ HỦY** trên hệ thống.`,
        '',
        `⚠️ **Trạng thái:** Khách hủy / Không mua`,
        `🔒 **Kênh ticket sẽ tự động đóng và xóa trong 3 giây...**`
      ].join('\n'))
      .setFooter({ text: '4AM STORE • Quản lý đơn hàng tự động' })
      .setTimestamp();

    await i.reply({ embeds: [cancelEmbed] });

    setTimeout(() => {
      i.channel.delete().catch(e => console.error('Không thể xóa kênh ticket:', e));
    }, 3000);
    return;
  }

  // --- Supporting Button: Dismiss Prompt ---
  if (i.isButton() && i.customId === 'resolve_dismiss_prompt') {
    await i.message.delete().catch(() => {});
    return;
  }

  // --- Supporting Button: Resolve Just Close (Staff) ---
  if (i.isButton() && i.customId.startsWith('resolve_just_close|')) {
    const orderNo = i.customId.split('|')[1];
    try {
      const order = await prisma.order.findUnique({ where: { orderNo } });
      if (order && order.status === 'PENDING') {
        let snap = {};
        try { snap = JSON.parse(order.planSnapshotJson || '{}'); } catch (_) {}
        snap.cancelledBy = i.user.tag;
        snap.cancelledReason = 'Đóng ticket tư vấn / Không phát sinh đơn';
        await prisma.order.update({
          where: { id: order.id },
          data: { status: 'CANCELLED', planSnapshotJson: JSON.stringify(snap) }
        });
      }
      await prisma.ticket.updateMany({
        where: { channelId: i.channel.id },
        data: { status: 'CLOSED' }
      });
    } catch (_) {}

    await i.reply({ content: '🔒 Đã ghi nhận ticket tư vấn. Kênh sẽ được xóa trong 3 giây...' });
    setTimeout(() => {
      i.channel.delete().catch(e => console.error('Không thể xóa kênh ticket:', e));
    }, 3000);
    return;
  }

  // --- Supporting Button: Customer Confirm Close ---
  if (i.isButton() && i.customId.startsWith('customer_confirm_close|')) {
    const orderNo = i.customId.split('|')[1];
    try {
      const order = await prisma.order.findUnique({ where: { orderNo } });
      if (order && order.status === 'PENDING') {
        let snap = {};
        try { snap = JSON.parse(order.planSnapshotJson || '{}'); } catch (_) {}
        snap.cancelledBy = i.user.tag;
        snap.cancelledReason = 'Khách tự đóng ticket khi chưa thanh toán';
        await prisma.order.update({
          where: { id: order.id },
          data: { status: 'CANCELLED', planSnapshotJson: JSON.stringify(snap) }
        });
      }
      await prisma.ticket.updateMany({
        where: { channelId: i.channel.id },
        data: { status: 'CLOSED' }
      });
    } catch (_) {}

    await i.reply({ content: '🔒 Ticket sẽ được đóng và xóa trong 3 giây...' });
    setTimeout(() => {
      i.channel.delete().catch(e => console.error('Không thể xóa kênh ticket:', e));
    }, 3000);
    return;
  }

  // --- Main Close Simple Ticket ---
  if (i.isButton() && i.customId === 'close_simple_ticket') {
    const ticket = await prisma.ticket.findUnique({
      where: { channelId: i.channel.id },
      include: { order: true }
    });
    const order = ticket?.order;

    // If order is already settled or not found: close directly
    if (!order || order.status === 'COMPLETED' || order.status === 'CANCELLED' || order.status === 'PAID') {
      try {
        await prisma.ticket.updateMany({
          where: { channelId: i.channel.id },
          data: { status: 'CLOSED' }
        });
      } catch (_) {}
      await i.reply({ content: '🔒 Ticket đã giải quyết xong. Kênh sẽ được xóa trong 3 giây...' });
      setTimeout(() => {
        i.channel.delete().catch(e => console.error('Không thể xóa kênh ticket:', e));
      }, 3000);
      return;
    }

    // Order is STILL PENDING!
    const isStaff = await canManageTicket(i, order);

    if (isStaff) {
      const promptEmbed = new EmbedBuilder()
        .setTitle(`📋 XÁC NHẬN KẾT QUẢ ĐƠN HÀNG #${order.orderNo}`)
        .setColor(0xF59E0B)
        .setDescription([
          `Đơn hàng này hiện đang ở trạng thái **PENDING (Chờ xử lý)**.`,
          `Để số liệu trên **Web Control Panel** được chính xác, vui lòng chọn kết quả trước khi đóng ticket:`,
          '',
          `🟢 **Chốt đơn thành công**: Khách đã mua, đã chuyển tiền và nhận hàng.`,
          `🔴 **Khách hủy đơn**: Khách đổi ý, không mua hoặc cãi nhau/hủy bỏ.`,
          `⚪ **Chỉ đóng ticket**: Khách vào hỏi tư vấn chung, không có đơn.`
        ].join('\n'));

      const promptRow1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`quick_staff_complete|${order.orderNo}`)
          .setLabel('🟢 Chốt đơn thành công')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`quick_staff_cancel|${order.orderNo}`)
          .setLabel('🔴 Khách hủy / Không mua')
          .setStyle(ButtonStyle.Danger)
      );

      const promptRow2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`resolve_just_close|${order.orderNo}`)
          .setLabel('⚪ Chỉ đóng ticket tư vấn')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('resolve_dismiss_prompt')
          .setLabel('↩️ Tiếp tục giữ kênh')
          .setStyle(ButtonStyle.Secondary)
      );

      return i.reply({ embeds: [promptEmbed], components: [promptRow1, promptRow2] });
    } else {
      const customerEmbed = new EmbedBuilder()
        .setTitle('🔒 XÁC NHẬN ĐÓNG TICKET')
        .setColor(0xEF4444)
        .setDescription('Bạn có chắc chắn muốn đóng ticket này không? Nếu đóng bây giờ, đơn hàng chưa chốt sẽ tự động được đánh dấu hủy.');

      const customerRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`customer_confirm_close|${order.orderNo}`)
          .setLabel('🔒 Xác nhận đóng (Hủy đơn)')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('resolve_dismiss_prompt')
          .setLabel('↩️ Tiếp tục giữ ticket')
          .setStyle(ButtonStyle.Secondary)
      );

      return i.reply({ embeds: [customerEmbed], components: [customerRow] });
    }
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
    const when = s.currentPeriodEnd.toLocaleString('vi-VN');
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
        `**Price**: ${formatPrice(product.priceCents, product.currency)}`,
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
if (i.isChatInputCommand() && (i.commandName === 'setup-bilingual' || i.commandName === 'unlock-server')) {
  await i.deferReply({ ephemeral: true });
  try {
    const result = await unlockServerChannels(i.guild);
    return i.editReply({
      content: [
        '🎉 **Đã mở khóa toàn bộ kênh & gỡ bỏ role ngôn ngữ thành công!**',
        '',
        '• **Phân quyền:** Toàn bộ thành viên (@everyone) đều xem được các kênh mua hàng, Menu và Ticket.',
        `• **Danh mục ORDER:**`,
        `  - Kênh Menu: <#${result.channels.menuVi.id}>`,
        `  - Kênh Ticket: <#${result.channels.ticketVi.id}> (Tích hợp chọn song ngữ)`,
        '✨ *Không còn yêu cầu chọn role Tiếng Việt/English để mở khóa kênh.*'
      ].join('\n')
    });
  } catch (err) {
    console.error('Lỗi khi mở khóa server:', err);
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
      const lines = list.map(o => `• #${o.orderNo} — ${o.status} — ${formatPrice(o.amountCents, o.currency)}`).join('\n') || 'Chưa có đơn hàng nào.';
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

if (i.isButton() && i.customId.startsWith('pay_upi_')) {
  const orderId = i.customId.split('pay_upi_')[1];
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { ticket: true } });
  if (!order) return i.reply({ content: 'Order not found.', ephemeral: true });

  const upiId = process.env.UPI_ID || 'not-set@upi';
  const qrPathPng = path.resolve(__dirname, '../assets/upi.png');
  const qrPathJpeg = path.resolve(__dirname, '../assets/upi.jpeg');
  const localQrPath = fs.existsSync(qrPathPng) ? qrPathPng : (fs.existsSync(qrPathJpeg) ? qrPathJpeg : null);
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

  if (sku === 'consult_seller') {
    const staffRoleId = process.env.STAFF_ROLE_ID;
    const embed = new EmbedBuilder()
      .setTitle('💬 YÊU CẦU TƯ VẤN & BÀN BẠC VỚI NGƯỜI BÁN')
      .setDescription(`Khách hàng <@${i.user.id}> đang cần tư vấn và bàn bạc về dịch vụ **${type}**.\n\nVui lòng để lại tin nhắn hoặc yêu cầu cụ thể bên dưới để nhân viên hỗ trợ bạn nhé!`)
      .setColor(0xF1C40F)
      .setTimestamp();
    return i.reply({
      content: staffRoleId ? `<@&${staffRoleId}>` : undefined,
      embeds: [embed]
    });
  }

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
          `**Price**: ${formatPrice(order.amountCents, order.currency)}`,
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
    console.error('⚠️ [interactionCreate Error]:', err);
    try {
      if (i.deferred) {
        await i.editReply({ content: '❌ Có lỗi xảy ra khi xử lý yêu cầu. Vui lòng thử lại sau.' });
      } else if (!i.replied && i.isRepliable()) {
        await i.reply({ content: '❌ Có lỗi xảy ra khi xử lý yêu cầu. Vui lòng thử lại sau.', ephemeral: true });
      }
    } catch (_) {}
  }
});

//
// ----------- Web Control Panel (Dashboard) Express Server -----------
//
const app = express();
app.use(express.json({ limit: '1mb' }));
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');
app.use(express.static(path.resolve(__dirname, '../public')));

// Dashboard identities are separate from seller payout details in menuData.json.
const scryptAsync = promisify(crypto.scrypt);
const dashboardUsersFile = path.resolve(__dirname, '../.dashboard-users.json');
const dashboardSessions = new Map();
const loginAttempts = new Map();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const ALLOWED_SELLER_PERMISSIONS = ['orders.read', 'orders.complete_own', 'orders.edit', 'products.edit'];

function readDashboardUsers() {
  try {
    const parsed = JSON.parse(fs.readFileSync(dashboardUsersFile, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Không đọc được tài khoản dashboard:', err);
    return [];
  }
}

function writeDashboardUsers(users) {
  const tempFile = `${dashboardUsersFile}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(tempFile, dashboardUsersFile);
}

async function hashDashboardPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = await scryptAsync(password, salt, 64);
  return { salt, hash: derived.toString('hex') };
}

async function verifyDashboardPassword(password, stored) {
  if (!stored?.salt || !stored?.hash) return false;
  const expected = Buffer.from(stored.hash, 'hex');
  const actual = await scryptAsync(password, stored.salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

app.post('/api/login', async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const attempts = loginAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (attempts.resetAt <= now) { attempts.count = 0; attempts.resetAt = now + 15 * 60 * 1000; }
  if (attempts.count >= 10) return res.status(429).json({ ok: false, error: 'Thử đăng nhập quá nhiều. Vui lòng đợi 15 phút.' });

  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  let identity = null;
  const adminPass = process.env.ADMIN_PASSWORD;

  if (username.toLowerCase() === 'admin' && adminPass && password === adminPass) {
    identity = { id: 'admin', username: 'admin', role: 'admin', sellerKey: null, permissions: ['*'] };
  } else {
    const user = readDashboardUsers().find(item => item.username.toLowerCase() === username.toLowerCase());
    if (user?.enabled && await verifyDashboardPassword(password, user.password)) {
      identity = { id: user.username, username: user.username, role: 'seller', sellerKey: user.sellerKey, permissions: user.permissions || ['orders.read'] };
    }
  }

  if (!identity) {
    attempts.count += 1;
    loginAttempts.set(ip, attempts);
    return res.status(401).json({ ok: false, error: 'Tên đăng nhập hoặc mật khẩu không chính xác.' });
  }

  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString('base64url');
  dashboardSessions.set(token, { ...identity, expiresAt: now + SESSION_TTL_MS });
  return res.json({ ok: true, token, user: { username: identity.username, role: identity.role, sellerKey: identity.sellerKey, permissions: identity.permissions } });
});

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const session = dashboardSessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) dashboardSessions.delete(token);
    return res.status(401).json({ ok: false, error: 'Phiên đăng nhập đã hết hạn hoặc không hợp lệ.' });
  }

  if (session.role === 'seller') {
    const user = readDashboardUsers().find(item => item.username === session.username && item.enabled);
    if (!user) {
      dashboardSessions.delete(token);
      return res.status(401).json({ ok: false, error: 'Tài khoản đã bị vô hiệu hóa.' });
    }
    session.permissions = user.permissions || ['orders.read'];
    session.sellerKey = user.sellerKey;
  }

  req.dashboardUser = session;
  req.dashboardToken = token;
  return next();
}

function requireAdminAuth(req, res, next) {
  return requireAuth(req, res, () => req.dashboardUser.role === 'admin'
    ? next()
    : res.status(403).json({ ok: false, error: 'Chức năng này chỉ dành cho quản trị viên.' }));
}

function requirePermission(permission) {
  return (req, res, next) => requireAuth(req, res, () => {
    if (req.dashboardUser.role === 'admin' || req.dashboardUser.permissions.includes(permission)) return next();
    return res.status(403).json({ ok: false, error: 'Tài khoản chưa được cấp quyền này.' });
  });
}

function canStaffAccessOrder(dashboardUser, order, menuData) {
  if (!dashboardUser) return false;
  if (dashboardUser.role === 'admin') return true;
  if (dashboardUser.role !== 'seller') return false;

  const sellerKey = dashboardUser.sellerKey;
  if (!sellerKey) return false;

  const data = menuData || (typeof getMenuData === 'function' ? getMenuData() : {});
  const sellerObj = data.sellers?.[sellerKey];
  const staffDiscordId = sellerObj?.discordId || (/^\d{17,20}$/.test(sellerKey) ? sellerKey : null);

  let snapshot = {};
  try {
    snapshot = typeof order.planSnapshotJson === 'string'
      ? JSON.parse(order.planSnapshotJson || '{}')
      : (order.planSnapshotJson || {});
  } catch (_) {}

  const orderSellerId = snapshot.sellerId || order.sellerId;
  const orderHandlers = Array.isArray(snapshot.handlers) ? snapshot.handlers : [];
  const catKey = snapshot.categoryKey;
  const cat = (catKey && data.categories) ? data.categories[catKey] : null;
  const catHandlers = Array.isArray(cat?.handlers) ? cat.handlers : [];
  const catSellerId = cat?.seller;

  // Điều kiện 1: Đơn hoặc mặt hàng do A trực tiếp phụ trách
  const isDirectSeller = (orderSellerId === sellerKey) || (staffDiscordId && orderSellerId === staffDiscordId);
  const isCatSeller = (catSellerId === sellerKey) || (staffDiscordId && catSellerId === staffDiscordId);

  // Điều kiện 2: Đơn hoặc mặt hàng phân cho nhóm (A, B, C) phụ trách (A có trong handlers)
  const isInOrderHandlers = orderHandlers.includes(sellerKey) || (staffDiscordId && orderHandlers.includes(staffDiscordId));
  const isInCatHandlers = catHandlers.includes(sellerKey) || (staffDiscordId && catHandlers.includes(staffDiscordId));

  if (isDirectSeller || isCatSeller || isInOrderHandlers || isInCatHandlers) {
    return true;
  }

  // Điều kiện 3: Đơn hoặc mặt hàng phân cho Toàn Server (All Server / STK Chung / Hỗ trợ chung)
  const isCommonSeller = (orderSellerId === 'shop_common') || (catSellerId === 'shop_common');
  const isGeneralSupport = (catKey === 'support' || !catKey);
  const hasNoSpecificHandlers = (orderHandlers.length === 0) && (catHandlers.length === 0);

  if (isCommonSeller || (isGeneralSupport && hasNoSpecificHandlers) || (!orderSellerId && hasNoSpecificHandlers)) {
    return true;
  }

  // Không thuộc các trường hợp trên => Không được phép truy cập
  return false;
}

function requireOrderManageAuth(req, res, next) {
  return requireAuth(req, res, async () => {
    const user = req.dashboardUser;
    if (!user) return res.status(401).json({ ok: false, error: 'Chưa đăng nhập.' });
    if (user.role === 'admin') return next();

    if (user.role === 'seller') {
      const hasEditPerm = Array.isArray(user.permissions) && user.permissions.includes('orders.edit');
      if (!hasEditPerm) {
        return res.status(403).json({ ok: false, error: 'Tài khoản chưa được cấp quyền chỉnh sửa đơn hàng.' });
      }

      const { id } = req.params;
      if (!id) return res.status(400).json({ ok: false, error: 'Thiếu ID đơn hàng.' });

      try {
        const order = await prisma.order.findUnique({
          where: { id },
          include: { user: true, product: true, ticket: true }
        });
        if (!order) return res.status(404).json({ ok: false, error: 'Không tìm thấy đơn hàng.' });

        if (!canStaffAccessOrder(user, order)) {
          return res.status(403).json({ ok: false, error: 'Bạn không có quyền truy cập hoặc chỉnh sửa đơn hàng này.' });
        }

        req.targetOrder = order;
        return next();
      } catch (err) {
        console.error('Lỗi kiểm tra quyền đơn hàng:', err);
        return res.status(500).json({ ok: false, error: 'Lỗi kiểm tra quyền hạn.' });
      }
    }

    return res.status(403).json({ ok: false, error: 'Không có quyền truy cập.' });
  });
}

function canStaffAccessCategory(dashboardUser, catKey, cat, menuData) {
  if (!dashboardUser) return false;
  if (dashboardUser.role === 'admin') return true;
  if (dashboardUser.role !== 'seller') return false;

  const sellerKey = dashboardUser.sellerKey;
  if (!sellerKey) return false;

  const data = menuData || (typeof getMenuData === 'function' ? getMenuData() : {});
  const sellerObj = data.sellers?.[sellerKey];
  const staffDiscordId = sellerObj?.discordId || (/^\d{17,20}$/.test(sellerKey) ? sellerKey : null);

  if (!cat) return false;

  const catSellerId = cat.seller;
  const catHandlers = Array.isArray(cat.handlers) ? cat.handlers : [];

  // Điều kiện 1: A là người phụ trách chính của mặt hàng
  const isCatSeller = (catSellerId === sellerKey) || (staffDiscordId && catSellerId === staffDiscordId);

  // Điều kiện 2: A nằm trong nhóm (A, B, C) phụ trách mặt hàng
  const isInCatHandlers = catHandlers.includes(sellerKey) || (staffDiscordId && catHandlers.includes(staffDiscordId));

  if (isCatSeller || isInCatHandlers) {
    return true;
  }

  // Điều kiện 3: Mặt hàng phân cho toàn server phụ trách (shop_common hoặc chưa gán ai)
  const isCommonSeller = (catSellerId === 'shop_common') || (!catSellerId && catHandlers.length === 0);
  if (isCommonSeller) {
    return true;
  }

  // Điều kiện 4: Không thuộc các điều kiện trên => Không có quyền truy cập
  return false;
}

function requireStoreConfigAuth(req, res, next) {
  return requireAuth(req, res, () => {
    const user = req.dashboardUser;
    if (!user) return res.status(401).json({ ok: false, error: 'Chưa đăng nhập.' });
    if (user.role === 'admin') return next();

    if (user.role === 'seller') {
      const canEdit = Array.isArray(user.permissions) && (user.permissions.includes('products.edit') || user.permissions.includes('orders.edit'));
      if (canEdit) return next();
      return res.status(403).json({ ok: false, error: 'Tài khoản chưa được cấp quyền chỉnh sửa mặt hàng.' });
    }

    return res.status(403).json({ ok: false, error: 'Không có quyền truy cập.' });
  });
}

app.get('/api/me', requireAuth, (req, res) => res.json({ ok: true, user: {
  username: req.dashboardUser.username,
  role: req.dashboardUser.role,
  sellerKey: req.dashboardUser.sellerKey,
  permissions: req.dashboardUser.permissions
} }));

app.post('/api/logout', requireAuth, (req, res) => {
  dashboardSessions.delete(req.dashboardToken);
  return res.json({ ok: true });
});

app.get('/api/dashboard-users', requireAdminAuth, (req, res) => {
  const users = readDashboardUsers().map(({ username, sellerKey, permissions, enabled, createdAt }) => ({ username, sellerKey, permissions, enabled, createdAt }));
  return res.json({ ok: true, users });
});

app.post('/api/dashboard-users', requireAdminAuth, async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const sellerKey = String(req.body?.sellerKey || '').trim();
  const permissions = Array.isArray(req.body?.permissions) ? [...new Set(req.body.permissions)] : ['orders.read'];
  if (!/^[a-zA-Z0-9._-]{2,32}$/.test(username)) return res.status(400).json({ ok: false, error: 'Tên đăng nhập cần 2–32 ký tự (chữ, số, dấu . _ -).' });
  if (password.length < 6 || password.length > 128) return res.status(400).json({ ok: false, error: 'Mật khẩu cần dài từ 6 đến 128 ký tự.' });
  if (permissions.some(permission => !ALLOWED_SELLER_PERMISSIONS.includes(permission)) || !permissions.includes('orders.read')) {
    return res.status(400).json({ ok: false, error: 'Quyền được chọn không hợp lệ.' });
  }
  const sellers = getMenuData().sellers || {};
  if (!sellers[sellerKey] || sellers[sellerKey].isShop) return res.status(400).json({ ok: false, error: 'Hãy chọn seller hợp lệ (không phải STK chung).' });
  const users = readDashboardUsers();
  if (users.some(user => user.username.toLowerCase() === username.toLowerCase())) return res.status(409).json({ ok: false, error: 'Tên đăng nhập đã tồn tại.' });
  if (users.some(user => user.sellerKey === sellerKey)) return res.status(409).json({ ok: false, error: 'Seller này đã có tài khoản dashboard.' });
  const passwordRecord = await hashDashboardPassword(password);
  users.push({ username, sellerKey, permissions, enabled: true, createdAt: new Date().toISOString(), password: passwordRecord });
  writeDashboardUsers(users);
  return res.status(201).json({ ok: true, user: { username, sellerKey, permissions, enabled: true } });
});

app.patch('/api/dashboard-users/:username', requireAdminAuth, async (req, res) => {
  const users = readDashboardUsers();
  const user = users.find(item => item.username.toLowerCase() === req.params.username.toLowerCase());
  if (!user) return res.status(404).json({ ok: false, error: 'Không tìm thấy tài khoản.' });
  if (typeof req.body?.enabled === 'boolean') user.enabled = req.body.enabled;
  if (req.body?.permissions !== undefined) {
    const permissions = Array.isArray(req.body.permissions) ? [...new Set(req.body.permissions)] : [];
    if (!permissions.includes('orders.read') || permissions.some(permission => !ALLOWED_SELLER_PERMISSIONS.includes(permission))) return res.status(400).json({ ok: false, error: 'Quyền được chọn không hợp lệ.' });
    user.permissions = permissions;
  }
  if (req.body?.password !== undefined) {
    const password = String(req.body.password);
    if (password.length < 6 || password.length > 128) return res.status(400).json({ ok: false, error: 'Mật khẩu cần dài từ 6 đến 128 ký tự.' });
    user.password = await hashDashboardPassword(password);
  }
  if (req.body?.sellerKey !== undefined) {
    const sellerKey = String(req.body.sellerKey).trim();
    const sellers = getMenuData().sellers || {};
    if (!sellers[sellerKey] || sellers[sellerKey].isShop) return res.status(400).json({ ok: false, error: 'Hãy chọn seller hợp lệ (không phải STK chung).' });
    user.sellerKey = sellerKey;
  }
  writeDashboardUsers(users);
  return res.json({ ok: true, user: { username: user.username, sellerKey: user.sellerKey, permissions: user.permissions, enabled: user.enabled } });
});

app.delete('/api/dashboard-users/:username', requireAdminAuth, (req, res) => {
  const users = readDashboardUsers();
  const idx = users.findIndex(item => item.username.toLowerCase() === req.params.username.toLowerCase());
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Không tìm thấy tài khoản.' });
  users.splice(idx, 1);
  writeDashboardUsers(users);
  return res.json({ ok: true, message: 'Đã xóa tài khoản dashboard.' });
});

// Get store data & bot info (auto-sync live Discord avatars for all sellers)
app.get('/api/data', requireAuth, async (req, res) => {
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
    if (req.dashboardUser.role === 'seller') {
      const key = req.dashboardUser.sellerKey;
      const allowedCategories = {};
      if (data.categories) {
        for (const [catKey, cat] of Object.entries(data.categories)) {
          if (canStaffAccessCategory(req.dashboardUser, catKey, cat, data)) {
            allowedCategories[catKey] = cat;
          }
        }
      }
      const sanitizedSellers = {};
      if (data.sellers) {
        for (const [sKey, sVal] of Object.entries(data.sellers)) {
          if (sKey === key || sKey === 'shop_common' || sVal.isShop) {
            sanitizedSellers[sKey] = sVal;
          } else {
            sanitizedSellers[sKey] = {
              name: sVal.name || sVal.username || sKey,
              username: sVal.username,
              globalName: sVal.globalName,
              avatar: sVal.avatar,
              discordId: sVal.discordId || (/^\d{17,20}$/.test(sKey) ? sKey : null),
              isShop: false,
              accounts: []
            };
          }
        }
      }
      return res.json({
        ok: true,
        data: {
          storeName: data.storeName,
          paymentMethods: data.paymentMethods,
          mainBannerUrl: data.mainBannerUrl,
          logoUrl: data.logoUrl,
          defaultLanguage: data.defaultLanguage,
          menuEmbed: data.menuEmbed,
          ticketChannelId: data.ticketChannelId,
          ticketPanel: data.ticketPanel,
          sellers: sanitizedSellers,
          categories: allowedCategories
        },
        botInfo: null
      });
    }
    return res.json({ ok: true, data, botInfo });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Fetch Discord user profile by Discord User ID
app.get('/api/discord-user/:id', requireAdminAuth, async (req, res) => {
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
app.get('/api/bot-emojis', requireAdminAuth, async (req, res) => {
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
app.post('/api/save', requireStoreConfigAuth, (req, res) => {
  try {
    const newConfig = req.body;
    if (!newConfig || typeof newConfig !== 'object') {
      return res.status(400).json({ ok: false, error: 'Dữ liệu không hợp lệ.' });
    }
    const menuMod = require('./menuData');
    const currentData = getMenuData();
    let finalConfig = newConfig;

    if (req.dashboardUser.role === 'seller') {
      const incomingCategories = newConfig.categories || {};
      const mergedCategories = { ...(currentData.categories || {}) };

      for (const [catKey, incomingCat] of Object.entries(incomingCategories)) {
        const existingCat = currentData.categories?.[catKey];
        if (existingCat && canStaffAccessCategory(req.dashboardUser, catKey, existingCat, currentData)) {
          mergedCategories[catKey] = {
            ...existingCat,
            ...incomingCat,
            seller: existingCat.seller,
            handlers: existingCat.handlers,
            accountIndex: existingCat.accountIndex
          };
        }
      }

      finalConfig = {
        ...currentData,
        categories: mergedCategories
      };
    }

    menuMod.saveData(finalConfig);
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

// Atomic Save & Sync to Discord Live
app.post('/api/save-and-sync', requireStoreConfigAuth, async (req, res) => {
  try {
    const newConfig = req.body;
    if (!newConfig || typeof newConfig !== 'object') {
      return res.status(400).json({ ok: false, error: 'Dữ liệu không hợp lệ.' });
    }

    const menuMod = require('./menuData');
    const currentData = getMenuData();
    let finalConfig = newConfig;

    if (req.dashboardUser.role === 'seller') {
      const incomingCategories = newConfig.categories || {};
      const mergedCategories = { ...(currentData.categories || {}) };

      for (const [catKey, incomingCat] of Object.entries(incomingCategories)) {
        const existingCat = currentData.categories?.[catKey];
        if (existingCat && canStaffAccessCategory(req.dashboardUser, catKey, existingCat, currentData)) {
          mergedCategories[catKey] = {
            ...existingCat,
            ...incomingCat,
            seller: existingCat.seller,
            handlers: existingCat.handlers,
            accountIndex: existingCat.accountIndex
          };
        }
      }

      finalConfig = {
        ...currentData,
        categories: mergedCategories
      };
    } else {
      if (!String(finalConfig.storeName || '').trim()) {
        return res.status(400).json({ ok: false, error: 'Tên cửa hàng không được để trống.' });
      }
      if (!String(finalConfig.menuEmbed?.vi?.title || '').trim()) {
        return res.status(400).json({ ok: false, error: 'Tiêu đề Menu tiếng Việt không được để trống.' });
      }
      if (!String(finalConfig.ticketPanel?.vi?.title || '').trim()) {
        return res.status(400).json({ ok: false, error: 'Tiêu đề Ticket tiếng Việt không được để trống.' });
      }
      const embedColors = [finalConfig.menuEmbed?.color, finalConfig.ticketPanel?.color].filter(Boolean);
      if (embedColors.some(color => !/^#[0-9A-Fa-f]{6}$/.test(color))) {
        return res.status(400).json({ ok: false, error: 'Màu embed phải có định dạng #RRGGBB.' });
      }
    }

    menuMod.saveData(finalConfig);
    delete require.cache[require.resolve('./menuData')];

    const syncErrors = [];
    if (client.isReady()) {
      try {
        await syncMenuChannel();
      } catch (err) {
        console.error('Lỗi sync menu live:', err);
        syncErrors.push('Menu: ' + err.message);
      }
      try {
        await syncTicketChannel();
      } catch (err) {
        console.error('Lỗi sync ticket live:', err);
        syncErrors.push('Ticket: ' + err.message);
      }
    }

    if (syncErrors.length > 0) {
      return res.json({
        ok: true,
        partial: true,
        message: 'Đã lưu cấu hình nhưng gặp lỗi sync Discord: ' + syncErrors.join('; ')
      });
    }

    return res.json({
      ok: true,
      message: client.isReady()
        ? 'Đã lưu và đồng bộ toàn bộ Menu & Ticket lên Discord!'
        : 'Đã lưu cấu hình thành công (Bot Discord đang offline, chưa thể đồng bộ live)!'
    });
  } catch (err) {
    console.error('Lỗi khi lưu và đồng bộ:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Translation Helper with token masking. Technical Discord syntax and formatting
// are restored byte-for-byte after translation.
async function translateText(text, from = 'vi', to = 'en') {
  if (!text || typeof text !== 'string' || !text.trim()) return text;
  const tokens = [];
  const tokenRegex = /(https?:\/\/[^\s]+|```[\s\S]*?```|`[^`]+`|\{[a-zA-Z0-9_]+\}|<@[!&]?\d+>|<#\d+>|<@&\d+>|<a?:[a-zA-Z0-9_~]+:\d+>|<t:\d+(?::[tTdDfFR])?>|<\/[a-zA-Z0-9_-]+:\d+>|\*\*|__|~~|\|\||(?<!\*)\*(?!\*)|(?<!_)_(?!_)|(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}))/gu;
  const tokenized = text.replace(tokenRegex, (match) => {
    const placeholder = 'ZXQPH' + tokens.length + 'QXZ';
    tokens.push({ placeholder, original: match });
    return placeholder;
  });

  if (!/[a-zA-ZÀ-ỹ]/.test(tokenized)) {
    return text;
  }

  return new Promise((resolve, reject) => {
    const postData = querystring.stringify({
      client: 'gtx',
      sl: from,
      tl: to,
      dt: 't',
      q: tokenized
    });

    const options = {
      hostname: 'translate.googleapis.com',
      path: '/translate_a/single?' + postData,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    };

    const request = https.request(options, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          let translated = (parsed[0] || []).map(item => item[0]).join('');
          for (let i = 0; i < tokens.length; i++) {
            const regex = new RegExp('ZXQPH' + i + 'QXZ', 'gi');
            translated = translated.replace(regex, tokens[i].original);
          }
          // Translation services sometimes insert spaces immediately inside
          // paired Markdown delimiters. Keep the Discord formatting valid.
          translated = translated
            .replace(/\*\*\s*([\s\S]*?)\s*\*\*/g, '**$1**')
            .replace(/__\s*([\s\S]*?)\s*__/g, '__$1__')
            .replace(/~~\s*([\s\S]*?)\s*~~/g, '~~$1~~')
            .replace(/\|\|\s*([\s\S]*?)\s*\|\|/g, '||$1||')
            .replace(/(?<!\*)\*\s*([^*\n]+?)\s*\*(?!\*)/g, '*$1*')
            .replace(/(?<!_)_\s*([^_\n]+?)\s*_(?!_)/g, '_$1_');
          const missingToken = tokens.some(token => !translated.includes(token.original));
          if (missingToken) throw new Error('Bản dịch làm thay đổi placeholder hoặc định dạng Discord');
          resolve(translated);
        } catch (e) {
          reject(e);
        }
      });
    });
    request.setTimeout(10000, () => request.destroy(new Error('Dịch vụ dịch quá thời gian chờ')));
    request.on('error', reject);
  });
}

// Auto translate text / batch texts (VI -> EN or EN -> VI)
app.post('/api/translate', requireAuth, async (req, res) => {
  try {
    const { text, texts, from = 'vi', to = 'en' } = req.body;
    if (Array.isArray(texts)) {
      const results = await Promise.all(texts.map(t => translateText(t, from, to)));
      return res.json({ ok: true, translations: results });
    }
    if (typeof text === 'string') {
      const result = await translateText(text, from, to);
      return res.json({ ok: true, translation: result });
    }
    return res.status(400).json({ ok: false, error: 'Thiếu tham số text hoặc texts để dịch.' });
  } catch (err) {
    console.error('Lỗi API translate:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Unlock Server Channels & Remove Language Roles
app.post('/api/setup-bilingual-server', requireAdminAuth, async (req, res) => {
  try {
    const guildId = process.env.GUILD_ID;
    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      return res.status(404).json({ ok: false, error: 'Không tìm thấy Server Discord từ GUILD_ID trong cấu hình .env.' });
    }
    const result = await unlockServerChannels(guild);
    return res.json({
      ok: true,
      message: 'Đã mở khóa toàn bộ kênh cho tất cả thành viên (@everyone) và gỡ bỏ role ngôn ngữ thành công!',
      data: {
        channels: {
          menu: result.channels.menuVi?.name,
          ticket: result.channels.ticketVi?.name
        }
      }
    });
  } catch (err) {
    console.error('Lỗi khi mở khóa server:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Orders Management API ---

// Get all orders with metrics & live Discord info
app.get('/api/orders', requirePermission('orders.read'), async (req, res) => {
  try {
    let rawOrders = await prisma.order.findMany({
      include: {
        user: true,
        product: true,
        ticket: true
      },
      orderBy: { createdAt: 'desc' }
    });

    if (req.dashboardUser.role === 'seller') {
      const menuData = getMenuData();
      rawOrders = rawOrders.filter(order => canStaffAccessOrder(req.dashboardUser, order, menuData));
    }

    let totalRevenue = 0;
    let pendingOrders = 0;
    let completedOrders = 0;

    const orders = await Promise.all(rawOrders.map(async (o) => {
      // Calculate revenue from PAID & COMPLETED orders
      if (o.status === 'PAID' || o.status === 'COMPLETED') {
        totalRevenue += (o.amountCents || 0);
      }
      if (o.status === 'PENDING') {
        pendingOrders++;
      } else if (o.status === 'COMPLETED') {
        completedOrders++;
      }

      let parsedSnapshot = {};
      try {
        parsedSnapshot = JSON.parse(o.planSnapshotJson || '{}');
      } catch (_) {}

      // Live Discord User Info
      let discordUser = {
        id: o.user?.discordId || '',
        name: o.user?.name || 'Khách vãng lai',
        username: o.user?.name || '',
        globalName: o.user?.name || '',
        tag: o.user?.name || '',
        avatar: null
      };

      if (o.user?.discordId && client.isReady()) {
        const cached = client.users.cache.get(o.user.discordId);
        if (cached) {
          discordUser.username = cached.username;
          discordUser.globalName = cached.globalName || cached.username;
          discordUser.tag = cached.tag || cached.username;
          discordUser.avatar = cached.displayAvatarURL({ extension: 'png', size: 64 });
        } else {
          try {
            const fetched = await client.users.fetch(o.user.discordId).catch(() => null);
            if (fetched) {
              discordUser.username = fetched.username;
              discordUser.globalName = fetched.globalName || fetched.username;
              discordUser.tag = fetched.tag || fetched.username;
              discordUser.avatar = fetched.displayAvatarURL({ extension: 'png', size: 64 });
            }
          } catch (_) {}
        }
      }

      // Live Ticket Channel status
      let ticketInfo = null;
      if (o.ticket) {
        let isChannelOpen = false;
        let chName = null;
        if (client.isReady() && o.ticket.channelId) {
          const ch = client.channels.cache.get(o.ticket.channelId);
          if (ch) {
            isChannelOpen = true;
            chName = ch.name;
          }
        }
        ticketInfo = {
          id: o.ticket.id,
          channelId: o.ticket.channelId,
          channelName: chName,
          status: o.ticket.status,
          isChannelOpen
        };
      }

      return {
        id: o.id,
        orderNo: o.orderNo,
        status: o.status,
        amountCents: o.amountCents,
        currency: o.currency || 'VNĐ',
        paymentProvider: o.paymentProvider,
        providerRef: o.providerRef,
        planSnapshot: parsedSnapshot,
        product: o.product ? {
          id: o.product.id,
          name: o.product.name,
          type: o.product.type,
          sku: o.product.sku
        } : null,
        user: discordUser,
        ticket: ticketInfo,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt
      };
    }));

    return res.json({
      ok: true,
      metrics: {
        totalOrders: orders.length,
        totalRevenue,
        pendingOrders,
        completedOrders
      },
      orders
    });
  } catch (err) {
    console.error('Lỗi API get orders:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Seller access is deliberately narrower than admin order management: a seller
// may only complete a paid order that is explicitly assigned to their seller ID.
app.post('/api/orders/:id/complete-own', requirePermission('orders.complete_own'), async (req, res) => {
  try {
    const existing = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ ok: false, error: 'Không tìm thấy đơn hàng.' });
    const sellerKey = req.dashboardUser.sellerKey;
    const seller = getMenuData().sellers?.[sellerKey];
    const discordId = seller?.discordId || (/^\d{17,20}$/.test(sellerKey) ? sellerKey : null);
    let snapshot = {};
    try { snapshot = JSON.parse(existing.planSnapshotJson || '{}'); } catch (_) {}
    if (snapshot.sellerId !== sellerKey && (!discordId || snapshot.sellerId !== discordId)) {
      return res.status(404).json({ ok: false, error: 'Không tìm thấy đơn hàng được giao cho tài khoản này.' });
    }
    if (existing.status !== 'PAID') return res.status(409).json({ ok: false, error: 'Chỉ có thể hoàn tất đơn đã được xác nhận thanh toán.' });
    const updated = await updateOrderStatus(existing.id, 'COMPLETED', 'DASHBOARD_SELLER', `COMPLETED_BY_${req.dashboardUser.username}`);
    return res.json({ ok: true, order: updated, message: `Đã hoàn tất đơn #${existing.orderNo}.` });
  } catch (err) {
    console.error('Lỗi seller hoàn tất đơn:', err);
    return res.status(500).json({ ok: false, error: 'Không thể cập nhật đơn hàng.' });
  }
});

// Update order status with 2-way sync to Discord
app.post('/api/orders/:id/status', requireOrderManageAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, amount, notifyDiscord = true } = req.body;
    if (!status) {
      return res.status(400).json({ ok: false, error: 'Thiếu trạng thái (status).' });
    }

    const existing = req.targetOrder || await prisma.order.findUnique({
      where: { id },
      include: { user: true, product: true, ticket: true }
    });
    if (!existing) {
      return res.status(404).json({ ok: false, error: 'Không tìm thấy đơn hàng.' });
    }

    const updaterActor = req.dashboardUser.role === 'admin' ? 'PANEL_ADMIN' : `STAFF_${req.dashboardUser.username.toUpperCase()}`;
    let updated = await updateOrderStatus(id, status, updaterActor, 'UPDATED_BY_WEB');
    if (amount !== undefined && amount !== null && !isNaN(amount)) {
      updated = await updateOrderAmount(id, amount);
    }

    // Two-way sync: Send receipt / status embed to Discord ticket channel if channel is open
    if (notifyDiscord && existing.ticket?.channelId && client.isReady()) {
      try {
        const channel = await client.channels.fetch(existing.ticket.channelId).catch(() => null);
        if (channel && channel.isTextBased()) {
          let parsedSnapshot = {};
          try {
            parsedSnapshot = JSON.parse(existing.planSnapshotJson || '{}');
          } catch (_) {}

          const serviceName = parsedSnapshot.categoryLabel || existing.product?.name || 'Dịch vụ';
          const formattedAmount = (updated.amountCents || 0).toLocaleString('vi-VN') + ' ' + (updated.currency || 'VNĐ');

          let statusBadge = '⏳ Đang Chờ Xử Lý';
          let embedColor = 0xF59E0B;
          let statusDesc = `Đơn hàng **#${existing.orderNo}** đang được nhân viên tiếp nhận và xử lý.`;

          if (status === 'PAID') {
            statusBadge = '💳 ĐÃ XÁC NHẬN THANH TOÁN';
            embedColor = 0x10B981;
            statusDesc = `🎉 **Thanh toán thành công!** Đơn hàng **#${existing.orderNo}** đã được xác nhận thanh toán hợp lệ trên Web Control Panel. Nhân viên sẽ bàn giao dịch vụ ngay cho bạn.`;
          } else if (status === 'COMPLETED') {
            statusBadge = '🎉 ĐÃ HOÀN THÀNH & GIAO HÀNG';
            embedColor = 0x0EA5E9;
            statusDesc = `🌟 Đơn hàng **#${existing.orderNo}** đã hoàn thành bàn giao! Cảm ơn bạn đã tin tưởng và ủng hộ **${getMenuData().storeName || '4AM STORE'}**.`;
          } else if (status === 'CANCELLED') {
            statusBadge = '❌ ĐÃ HỦY ĐƠN';
            embedColor = 0xEF4444;
            statusDesc = `Đơn hàng **#${existing.orderNo}** đã được hủy bởi quản trị viên.`;
          }

          const embed = new EmbedBuilder()
            .setTitle(`🔔 CẬP NHẬT ĐƠN HÀNG: ${statusBadge}`)
            .setDescription(statusDesc)
            .addFields(
              { name: '📦 Dịch vụ / Sản phẩm', value: `**${serviceName}**`, inline: true },
              { name: '💰 Số tiền', value: `**${formattedAmount}**`, inline: true },
              { name: '👤 Khách hàng', value: `<@${existing.user?.discordId}>`, inline: true }
            )
            .setColor(embedColor)
            .setFooter({ text: '4AM Control Panel • Đồng bộ trực tiếp' })
            .setTimestamp();

          await channel.send({ embeds: [embed] });
        }
      } catch (err) {
        console.error('Không thể gửi thông báo ticket Discord:', err);
      }
    }

    return res.json({ ok: true, order: updated, message: `Đã cập nhật trạng thái đơn #${existing.orderNo} sang ${status}!` });
  } catch (err) {
    console.error('Lỗi khi cập nhật trạng thái đơn:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Update order amount
app.post('/api/orders/:id/amount', requireOrderManageAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { amount } = req.body;
    if (amount === undefined || isNaN(amount)) {
      return res.status(400).json({ ok: false, error: 'Số tiền không hợp lệ.' });
    }
    const updated = await updateOrderAmount(id, amount);
    return res.json({ ok: true, order: updated, message: 'Đã cập nhật số tiền đơn hàng!' });
  } catch (err) {
    console.error('Lỗi khi cập nhật số tiền đơn:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Full update of order fields (Service name, Amount, Status, Notes, Seller, Customer Name)
app.post('/api/orders/:id/update', requireOrderManageAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { serviceName, notes, amount, status, sellerName, sellerId, customerName, notifyDiscord = false } = req.body;

    const existing = req.targetOrder || await prisma.order.findUnique({
      where: { id },
      include: { user: true, product: true, ticket: true }
    });
    if (!existing) {
      return res.status(404).json({ ok: false, error: 'Không tìm thấy đơn hàng.' });
    }

    // Update snapshot json
    let snapshot = {};
    try {
      snapshot = JSON.parse(existing.planSnapshotJson || '{}');
    } catch (_) {}

    if (serviceName) snapshot.categoryLabel = serviceName;
    if (notes !== undefined) {
      snapshot.selectedItem = notes;
      snapshot.notes = notes;
    }
    if (sellerName) snapshot.sellerName = sellerName;
    if (sellerId) snapshot.sellerId = sellerId;
    snapshot.updatedAt = new Date().toISOString();

    const orderData = {
      planSnapshotJson: JSON.stringify(snapshot)
    };

    if (amount !== undefined && !isNaN(amount)) {
      orderData.amountCents = Math.max(0, parseInt(amount, 10) || 0);
    }
    if (status) {
      orderData.status = status;
    }

    const updated = await prisma.order.update({
      where: { id },
      data: orderData,
      include: { user: true, product: true, ticket: true }
    });

    // If customerName provided and differs, update user record
    if (customerName && existing.user && existing.user.name !== customerName) {
      await prisma.user.update({
        where: { id: existing.user.id },
        data: { name: customerName }
      }).catch(() => {});
    }

    // Two-way sync to Discord if requested and channel exists
    if (notifyDiscord && existing.ticket?.channelId && client.isReady()) {
      try {
        const channel = await client.channels.fetch(existing.ticket.channelId).catch(() => null);
        if (channel && channel.isTextBased()) {
          const formattedAmount = (updated.amountCents || 0).toLocaleString('vi-VN') + ' ' + (updated.currency || 'VNĐ');
          let statusBadge = '⏳ Đang Chờ Xử Lý';
          let embedColor = 0xF59E0B;
          if (updated.status === 'PAID') {
            statusBadge = '💳 ĐÃ XÁC NHẬN THANH TOÁN';
            embedColor = 0x10B981;
          } else if (updated.status === 'COMPLETED') {
            statusBadge = '🎉 ĐÃ HOÀN THÀNH & GIAO HÀNG';
            embedColor = 0x0EA5E9;
          } else if (updated.status === 'CANCELLED') {
            statusBadge = '❌ ĐÃ HỦY ĐƠN';
            embedColor = 0xEF4444;
          }

          const embed = new EmbedBuilder()
            .setTitle(`🔔 CẬP NHẬT ĐƠN HÀNG: ${statusBadge}`)
            .setDescription(`Thông tin đơn hàng **#${existing.orderNo}** đã được cập nhật bởi quản trị viên.`)
            .addFields(
              { name: '📦 Dịch vụ', value: `**${snapshot.categoryLabel || existing.product?.name || 'Dịch vụ'}**`, inline: true },
              { name: '💰 Số tiền', value: `**${formattedAmount}**`, inline: true },
              { name: '👤 Phụ trách', value: `**${snapshot.sellerName || 'Shop Admin'}**`, inline: true }
            )
            .setColor(embedColor)
            .setFooter({ text: '4AM Control Panel • Cập nhật trực tiếp' })
            .setTimestamp();

          if (notes) {
            embed.addFields({ name: '📝 Ghi chú', value: notes, inline: false });
          }

          await channel.send({ embeds: [embed] });
        }
      } catch (err) {
        console.error('Không thể gửi thông báo ticket Discord:', err);
      }
    }

    return res.json({ ok: true, order: updated, message: `Đã lưu cập nhật cho đơn #${existing.orderNo}!` });
  } catch (err) {
    console.error('Lỗi khi cập nhật chi tiết đơn:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Delete an order
app.delete('/api/orders/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.ticket.deleteMany({ where: { orderId: id } });
    await prisma.subscription.deleteMany({ where: { lastOrderId: id } });
    await prisma.order.delete({ where: { id } });
    return res.json({ ok: true, message: 'Đã xóa đơn hàng thành công!' });
  } catch (err) {
    console.error('Lỗi khi xóa đơn hàng:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Create manual order
app.post('/api/orders/create', requireAdminAuth, async (req, res) => {
  try {
    const { discordId, customerName, serviceName, categoryKey, amount, status = 'PENDING', notes, sellerId, sellerName } = req.body;

    // Ensure or create user
    const finalDiscordId = (discordId && /^\d{17,20}$/.test(discordId.trim()))
      ? discordId.trim()
      : 'guest_' + Date.now();

    const user = await ensureUser(finalDiscordId, null, customerName || 'Khách Hàng', null);

    // Ensure product
    const prodSku = categoryKey ? `CAT_${categoryKey.toUpperCase()}` : `PROD_MANUAL_${Date.now()}`;
    const product = await findOrCreateProduct({
      type: 'STORE_CATEGORY',
      name: serviceName || 'Dịch vụ tùy chọn',
      sku: prodSku,
      specJson: JSON.stringify({ label: serviceName || 'Dịch vụ tùy chọn' }),
      priceCents: Math.max(0, parseInt(amount, 10) || 0),
      currency: 'VNĐ'
    });

    const planSnapshot = {
      categoryKey: categoryKey || 'custom',
      categoryLabel: serviceName || product.name,
      sellerId: sellerId || 'shop_common',
      sellerName: sellerName || 'Shop Admin',
      selectedItem: notes || '',
      notes: notes || '',
      isManual: true,
      createdAt: new Date().toISOString()
    };

    const orderNo = shortOrderNo();
    const order = await prisma.order.create({
      data: {
        orderNo,
        userId: user.id,
        productId: product.id,
        planSnapshotJson: JSON.stringify(planSnapshot),
        amountCents: Math.max(0, parseInt(amount, 10) || 0),
        currency: 'VNĐ',
        status: status || 'PENDING',
        paymentProvider: 'PANEL_ADMIN',
        providerRef: 'MANUAL_CREATE'
      },
      include: { user: true, product: true, ticket: true }
    });

    return res.json({ ok: true, order, message: `Đã tạo đơn hàng #${order.orderNo} thành công!` });
  } catch (err) {
    console.error('Lỗi khi tạo đơn hàng thủ công:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// --- GPM Pay Auto Payment Webhook Endpoint ---
app.post('/api/webhook/gpm-pay', async (req, res) => {
  try {
    const signature = req.headers['x-gpm-signature'] || req.headers['x-signature'] || req.body?.signature || '';
    const secret = process.env.GPM_PAY_WEBHOOK_SECRET;

    if (secret && !verifyHmacSignature(JSON.stringify(req.body), signature, secret)) {
      console.warn('⚠️ [GPM Pay Webhook] Từ chối request do chữ ký HMAC không hợp lệ.');
      return res.status(401).json({ ok: false, error: 'Chữ ký HMAC không hợp lệ.' });
    }

    const result = await processGpmWebhook(req.body, {
      getValidReceivingAccounts: () => {
        const data = getMenuData();
        const accounts = [];
        for (const s of Object.values(data.sellers || {})) {
          for (const acc of s.accounts || []) {
            if (acc.account) accounts.push(acc.account);
          }
        }
        if (process.env.BANK_ACCOUNT) accounts.push(process.env.BANK_ACCOUNT);
        return accounts;
      },
      onOrderPaid: async (order, meta) => {
        await upsertSubscriptionForPaidOrder(order.id).catch(() => {});
        if (order.ticket?.channelId && client.isReady()) {
          const ch = await client.channels.fetch(order.ticket.channelId).catch(() => null);
          if (ch && ch.isTextBased()) {
            const formatted = formatPrice(meta.transferAmount, order.currency);
            await ch.send(`🎉 **Thanh toán tự động thành công!** Đơn hàng **#${order.orderNo}** đã được hệ thống GPM Pay xác nhận (${formatted}). Staff sẽ kích hoạt dịch vụ cho bạn ngay!`).catch(() => {});
          }
        }
      }
    });

    return res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    console.error('⚠️ [GPM Pay Webhook Error]:', err);
    return res.status(500).json({ ok: false, error: 'Lỗi máy chủ khi xử lý webhook thanh toán.' });
  }
});

// --- Real Production Health Check Endpoint ---
app.get('/health', async (_, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const botReady = client.isReady();
    return res.status(200).json({
      status: 'healthy',
      database: 'connected',
      discordBot: botReady ? 'ready' : 'connecting',
      botPing: client.ws?.ping || 0,
      uptimeSeconds: Math.floor(process.uptime()),
      memory: {
        rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
      },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    return res.status(503).json({
      status: 'unhealthy',
      error: err.message,
      discordBot: client.isReady() ? 'ready' : 'disconnected',
      timestamp: new Date().toISOString()
    });
  }
});

// Serve frontend SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../public/index.html'));
});

let serverInstance = null;
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n🛑 [Shutdown] Nhận tín hiệu ${signal}. Bắt đầu tắt hệ thống an toàn...`);

  try {
    if (serverInstance) {
      await new Promise(resolve => serverInstance.close(resolve));
      console.log('✅ [Shutdown] HTTP server đã dừng tiếp nhận kết nối mới.');
    }
    if (client.isReady()) {
      client.destroy();
      console.log('✅ [Shutdown] Đã ngắt kết nối Discord client.');
    }
    await prisma.$disconnect();
    console.log('✅ [Shutdown] Đã đóng kết nối Prisma SQLite an toàn.');
  } catch (err) {
    console.error('⚠️ [Shutdown] Lỗi khi tắt hệ thống:', err);
  } finally {
    console.log('👋 [Shutdown] Hoàn tất tắt hệ thống.');
    process.exit(0);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

(async () => {
  const desiredPort = parseInt(process.env.PORT || '3000', 10);
  let PORT = desiredPort;
  try {
    serverInstance = app.listen(PORT, '0.0.0.0', () => {
      console.log(`🌐 Web Control Panel đang chạy tại: http://localhost:${PORT}`);
    });
    serverInstance.on('error', async (e) => {
      if (e.code === 'EADDRINUSE') {
        console.warn(`Cổng ${PORT} đang bận, tự động chọn cổng khả dụng tiếp theo...`);
        PORT = await getPort({ port: desiredPort + 1 });
        serverInstance = app.listen(PORT, '0.0.0.0', () => {
          console.log(`🌐 Web Control Panel đang chạy tại: http://localhost:${PORT}`);
        });
      }
    });
  } catch (err) {
    console.error('Lỗi khởi động Express:', err);
  }
})();

client.login(process.env.DISCORD_BOT_TOKEN);
