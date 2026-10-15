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
  EmbedBuilder, PermissionsBitField, parseEmoji, ActivityType
} = require('discord.js');

const express = require('express');
const { nanoid } = require('nanoid');
const { prisma } = require('./db');
const { CATALOG, CURRENCY } = require('./catalog');
const { ensureUser, findOrCreateProduct, createOrder, markPaid, attachTicket, updateOrderStatus, updateOrderAmount } = require('./order');
const { specToLines, shortOrderNo } = require('./utils');
const {
  getPayOS,
  createPayosPayment,
  getPayosPaymentInfo,
  processPayosWebhook,
  resolveBankBin,
  buildVietQrImageUrl
} = require('./payment/payos');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { promisify } = require('util');
const getPort = require('get-port').default; // <- note .default
const dashboardOnlyMode = ['1', 'true', 'yes'].includes(String(process.env.DASHBOARD_ONLY || '').toLowerCase());
const uiTestMode = ['1', 'true', 'yes'].includes(String(process.env.UI_TEST_MODE || '').toLowerCase());

const {
  loadAutoResponses,
  getAutoResponses,
  findMatchingAutoResponse,
  addOrUpdateAutoResponse,
  deleteAutoResponse
} = require('./autoResponse');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
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
      .setCustomId(`pay_sim_${orderId}`)
      .setLabel('✅ Tôi Đã Chuyển Khoản')
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
const autoCloseTimers = new Map(); // channelId -> { timer, messageId, orderNo }

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

// Unified Ticket action buttons (PayOS Link, Kiểm tra thanh toán, Nhập số lượng, Hoàn tất đơn hàng, Đóng Ticket)
function buildTicketActionRow(orderDraftNo, categoryKey = null, allowQuantity = true, checkoutUrl = null) {
  const row = new ActionRowBuilder();
  if (checkoutUrl && /^https?:\/\//i.test(checkoutUrl)) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel('💳 Trang thanh toán PayOS')
        .setStyle(ButtonStyle.Link)
        .setURL(checkoutUrl)
    );
  }
  if (orderDraftNo) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`check_payos|${orderDraftNo}`)
        .setLabel('🔄 Kiểm tra thanh toán')
        .setStyle(ButtonStyle.Success)
    );
  }
  if (orderDraftNo && allowQuantity && row.components.length < 4) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`btn_change_quantity|${orderDraftNo}|${categoryKey || ''}`)
        .setLabel('🔢 Nhập số lượng')
        .setStyle(ButtonStyle.Primary)
    );
  }
  if (orderDraftNo && row.components.length < 4) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`staff_complete_order|${orderDraftNo}`)
        .setLabel('🎉 Hoàn tất đơn hàng')
        .setStyle(ButtonStyle.Success)
    );
  }
  if (row.components.length < 5) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`close_simple_ticket|${orderDraftNo}`)
        .setLabel('🔒 Đóng Ticket')
        .setStyle(ButtonStyle.Danger)
    );
  }
  return row;
}

// Parse price from string (e.g. "150.000 VNĐ" -> 150000, "8.500đ / 1M" -> 8500, "200k" -> 200000)
function parsePrice(priceStr) {
  if (!priceStr) return 0;
  let str = String(priceStr).trim().toLowerCase();
  // Strip trailing unit denominators like "/ 1M", "/ 1m", "/ 1 cái", "/ acc", "/ slot"
  str = str.replace(/\/\s*\d*\s*[\p{L}0-9]+/gu, '').trim();
  const kMatch = str.match(/(\d+(?:[.,]\d+)?)\s*k\b/i);
  if (kMatch) {
    const num = parseFloat(kMatch[1].replace(',', '.'));
    return Math.round(num * 1000);
  }
  const cleaned = str.replace(/[^0-9]/g, '');
  return parseInt(cleaned, 10) || 0;
}

// Detect if a category or item is sold by quantity/unit (e.g. OwO Cash, Xu, Coin, acc, per unit)
function parseQuantityItemInfo(itemName, itemPrice, cat = {}) {
  const nameStr = String(itemName || '').trim();
  const priceStr = String(itemPrice || '').trim();
  const combined = `${cat?.label || ''} ${cat?.title || ''} ${nameStr} ${priceStr}`.toLowerCase();

  const isOwoOrCurrency = /\b(owo|cow|cash|xu|coin)\b/i.test(combined);
  const unitRegex = /(?:^|[\s/\d])(?:1?m|1?k|cái|acc|slot|lần)(?:[\s/]|$)/i;
  const hasPerUnit = unitRegex.test(priceStr) || unitRegex.test(nameStr);
  const hasRange = /\d+\s*-\s*\d+\s*(m|k)?/i.test(nameStr) || /\d+\s*(m|k)?\s*\+/i.test(nameStr) || />\s*\d+/i.test(nameStr);

  // If it's a fixed duration package like "1 Tháng", "1 Năm", don't treat as variable quantity unless it explicitly has /1m or band
  if (/(\d+\s*(tháng|năm|ngay|ngày|day|month|year))\b/i.test(nameStr) && !hasPerUnit && !hasRange) {
    return { isQuantity: false, unit: 'M', min: 0, max: Infinity, unitRate: parsePrice(priceStr) };
  }

  if (!isOwoOrCurrency && !hasPerUnit && !hasRange) {
    return { isQuantity: false, unit: 'M', min: 0, max: Infinity, unitRate: parsePrice(priceStr) };
  }

  // Determine unit (default 'M' for OwO / cash, or 'Xu', 'Coin', 'Cái')
  let unit = 'M';
  if (/(\d+\s*m\b|\/1?m\b)/i.test(nameStr) || /(\d+\s*m\b|\/1?m\b)/i.test(priceStr) || /\b(owo|cow)\b/i.test(combined)) {
    unit = 'M';
  } else if (/xu\b/i.test(combined)) {
    unit = 'Xu';
  } else if (/coin\b/i.test(combined)) {
    unit = 'Coin';
  } else if (/cái|acc|slot\b/i.test(combined)) {
    unit = 'Cái';
  }

  // Parse band range from itemName if present: e.g. "0 - 50m", "50 - 100m", "100m+"
  let min = 0;
  let max = Infinity;
  const rangeMatch = nameStr.match(/(\d+(?:\.\d+)?)\s*(?:m|k)?\s*-\s*(\d+(?:\.\d+)?)\s*(?:m|k)?/i);
  if (rangeMatch) {
    min = parseFloat(rangeMatch[1]);
    max = parseFloat(rangeMatch[2]);
  } else {
    const plusMatch = nameStr.match(/(\d+(?:\.\d+)?)\s*(?:m|k)?\s*\+/i) || nameStr.match(/>\s*(\d+(?:\.\d+)?)/i);
    if (plusMatch) {
      min = parseFloat(plusMatch[1]);
    }
  }

  const unitRate = parsePrice(priceStr);

  return {
    isQuantity: true,
    unit,
    min,
    max,
    unitRate,
    originalName: nameStr,
    originalPrice: priceStr
  };
}

// Find matching pricing band from category items for a given quantity
function findBestBandForQuantity(quantity, cat, fallbackIdx = 0) {
  const rawList = cat.items || [];
  const parsedItems = rawList.map((itemRaw, idx) => {
    const cleanRaw = String(itemRaw || '').trim().replace(/^•\s*/, '');
    let itemName = cleanRaw;
    let itemPrice = '';
    if (cleanRaw.includes('|')) {
      const parts = cleanRaw.split('|').map(s => s.trim());
      itemName = parts[0];
      itemPrice = parts.slice(1).join(' | ');
    }
    const info = parseQuantityItemInfo(itemName, itemPrice, cat);
    return { idx, itemName, itemPrice, ...info };
  });

  const bands = parsedItems.filter(p => p.isQuantity && p.unitRate > 0);
  if (bands.length === 0) {
    const item = parsedItems[fallbackIdx] || parsedItems[0];
    return {
      band: item,
      unitRate: item?.unitRate || parsePrice(item?.itemPrice) || 0,
      unit: 'M',
      bandName: item?.itemName || 'Gói OwO'
    };
  }

  // Check matching range: min <= quantity and (max === Infinity or quantity <= max)
  let matched = bands.find(b => quantity >= b.min && (quantity <= b.max || b.max === Infinity));
  if (!matched) {
    // If quantity is above all bands, use the highest tier band
    matched = bands[bands.length - 1];
  }

  return {
    band: matched,
    unitRate: matched.unitRate,
    unit: matched.unit || 'M',
    bandName: matched.itemName
  };
}

// Prompt embed & select menu asking customer which variant/package they want to buy
function buildCategoryItemPrompt(cat, categoryKey, orderDraftNo, selectedValue = null) {
  const rawItems = cat.items || [];
  const catName = cat.label || categoryKey || 'Sản phẩm';

  const options = [];
  rawItems.slice(0, 24).forEach((item, index) => {
    const raw = String(item || '').trim().replace(/^•\s*/, '');
    let label = raw;
    let description = '';
    if (raw.includes('|')) {
      const parts = raw.split('|').map(s => s.trim());
      label = parts[0];
      description = 'Giá: ' + parts.slice(1).join(' | ');
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
    label: 'Cần tư vấn và bàn bạc với người bán',
    value: 'consult_seller',
    description: 'Trao đổi, tư vấn trực tiếp với nhân viên / người bán',
    emoji: '💬',
    default: selectedValue === 'consult_seller'
  });

  let placeholder = '👉 Bạn muốn mua loại nào? Chọn tại đây...';
  if (selectedValue === 'consult_seller') {
    placeholder = 'Đã chọn: Cần tư vấn và bàn bạc với người bán (Bấm để đổi)';
  } else if (selectedValue && selectedValue.startsWith('item_')) {
    const idx = parseInt(selectedValue.replace('item_', ''), 10);
    const chosenRaw = rawItems[idx];
    if (chosenRaw) {
      const pName = String(chosenRaw).split('|')[0].trim().replace(/^•\s*/, '');
      placeholder = `Đã chọn: ${pName} (Bấm để đổi)`.slice(0, 100);
    }
  }

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`select_ticket_item|${orderDraftNo}|${categoryKey}`)
    .setPlaceholder(placeholder)
    .addOptions(options);

  const row = new ActionRowBuilder().addComponents(selectMenu);

  const embed = new EmbedBuilder()
    .setTitle(`❓ BẠN MUỐN MUA LOẠI NÀO CỦA ${catName.toUpperCase()}?`)
    .setDescription(
      `Vui lòng chọn loại gói bạn muốn mua ở danh mục bên dưới.\nNếu bạn chưa rõ hoặc cần thỏa thuận riêng, vui lòng chọn **"Cần tư vấn và bàn bạc với người bán"** nhé!`
    )
    .setColor(cat.color || 0x00C2A8);

  return { embed, row };
}

// Prompt embed & select menu for general ticket support
function buildGeneralTicketPrompt(categories = {}, orderDraftNo, selectedCategory = null) {
  const options = [];

  const catEntries = Object.entries(categories);
  catEntries.slice(0, 24).forEach(([key, cat]) => {
    let optEmoji = undefined;
    if (cat.emoji) {
      const match = cat.emoji.match(/<a?:([a-zA-Z0-9_]+):(\d+)>/);
      if (match) optEmoji = { name: match[1], id: match[2] };
      else optEmoji = cat.emoji;
    }
    const label = cat.label || key;
    options.push({
      label: label.slice(0, 100),
      value: key,
      description: `Xem các loại gói & giá của ${label}`.slice(0, 100),
      emoji: optEmoji,
      default: selectedCategory === key
    });
  });

  // Always append: Cần tư vấn và bàn bạc với người bán
  options.push({
    label: 'Cần tư vấn và bàn bạc với người bán',
    value: 'consult_seller',
    description: 'Trao đổi, tư vấn trực tiếp với nhân viên / người bán',
    emoji: '💬',
    default: selectedCategory === 'consult_seller'
  });

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`select_general_ticket_category|${orderDraftNo}`)
    .setPlaceholder('👉 Chọn sản phẩm cần mua hoặc yêu cầu tư vấn...')
    .addOptions(options);

  const row = new ActionRowBuilder().addComponents(selectMenu);

  const embed = new EmbedBuilder()
    .setTitle('❓ BẠN CẦN TƯ VẤN HOẶC MUA SẢN PHẨM NÀO?')
    .setDescription(
      'Vui lòng chọn sản phẩm bạn muốn mua bên dưới để xem các loại gói hiện có, hoặc chọn **"Cần tư vấn và bàn bạc với người bán"** để được hỗ trợ trực tiếp:'
    )
    .setColor(0x5865F2);

  return { embed, row };
}

/**
 * Tự động tìm và xóa/ẩn triệt để mã VietQR thanh toán hoặc bảng chọn gói trong kênh ticket.
 * Giúp kênh ticket gọn gàng, tránh tuyệt đối tình trạng khách hàng chuyển khoản trùng/lần 2 (như case 4AMT00013).
 * Khi đơn đã thanh toán (isPaid), tự động vô hiệu hóa (disabled) toàn bộ các nút chọn gói/nhập số lượng để khách không tạo lại QR.
 */
async function deleteTicketQrMessages(channel, options = {}) {
  if (!channel || !channel.isTextBased()) return;
  try {
    let isPaid = options.isPaid || options.disableControls || false;

    // Tự động kiểm tra trạng thái đơn nếu chưa truyền flag isPaid
    if (!isPaid) {
      const relatedOrder = await prisma.order.findFirst({
        where: { ticket: { channelId: channel.id } },
        select: { status: true }
      }).catch(() => null);
      if (relatedOrder && (relatedOrder.status === 'PAID' || relatedOrder.status === 'COMPLETED')) {
        isPaid = true;
      }
    }

    const fetched = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!fetched) return;

    for (const m of fetched.values()) {
      if (m.author.id !== client.user.id) continue;

      const hasQrImage = (m.embeds || []).some(emb => {
        const imgUrl = emb.image?.url || '';
        const thumbUrl = emb.thumbnail?.url || '';
        return (
          imgUrl.includes('vietqr.io') ||
          imgUrl.includes('quicklink.vietqr.io') ||
          thumbUrl.includes('vietqr.io') ||
          thumbUrl.includes('quicklink.vietqr.io')
        );
      });

      const isQrOrSelectionMsg =
        hasQrImage ||
        (typeof m.content === 'string' && (m.content.includes('Đã tạo mã QR thanh toán') || m.content.includes('vietqr.io'))) ||
        (m.embeds || []).some(emb => {
          const title = emb.title || '';
          const desc = emb.description || '';
          return (
            title.includes('ĐÃ CHỌN:') ||
            title.includes('SELECTED:') ||
            title.includes('CẦN TƯ VẤN') ||
            title.includes('NEED CONSULTATION') ||
            desc.includes('MÃ VIETQR THANH TOÁN') ||
            desc.includes('Quét mã VietQR') ||
            desc.includes('VIETQR')
          );
        });

      if (isQrOrSelectionMsg) {
        let deleted = false;
        try {
          await m.delete();
          deleted = true;
        } catch (_) {
          deleted = false;
        }

        // Nếu không xóa được, gỡ bỏ hoàn toàn ảnh QR khỏi embed và xóa nút bấm
        if (!deleted) {
          try {
            const strippedEmbeds = (m.embeds || []).map(oldEmb => {
              const eb = EmbedBuilder.from(oldEmb);
              eb.setImage(null);
              eb.setThumbnail(null);
              if (isPaid) {
                eb.setColor(0x10B981);
                eb.setFooter({ text: '✅ Đơn hàng đã được thanh toán — Mã QR đã hết hiệu lực' });
              }
              return eb;
            });
            await m.edit({
              content: typeof m.content === 'string' ? m.content.replace(/Đã tạo mã QR thanh toán[^\n.]*/gi, isPaid ? 'Đã xác nhận thanh toán thành công!' : '') : undefined,
              embeds: strippedEmbeds,
              components: []
            }).catch(() => {});
          } catch (_) {}
        }
      }

      // Khi đơn đã thanh toán: Khóa (disable) toàn bộ menu chọn gói và nút nhập số lượng trong ticket
      if (isPaid && m.components && m.components.length > 0) {
        let hasActionComponents = false;
        const disabledRows = [];

        for (const row of m.components) {
          try {
            const newRow = ActionRowBuilder.from(row);
            newRow.components.forEach(comp => {
              const customId = comp.data?.custom_id || '';
              if (
                customId.includes('item_select') ||
                customId.includes('btn_change_quantity') ||
                customId.includes('select_category')
              ) {
                comp.setDisabled(true);
                hasActionComponents = true;
              }
            });
            disabledRows.push(newRow);
          } catch (_) {}
        }

        if (hasActionComponents && disabledRows.length > 0) {
          await m.edit({ components: disabledRows }).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error('Lỗi khi xóa/ẩn mã QR thanh toán trong ticket:', err);
  }
}

/**
 * Gửi thông báo xác nhận thanh toán thành công dạng Webhook Embed vào kênh Ticket.
 * Giao diện to, rõ ràng, nổi bật, sang trọng như một Webhook ngân hàng chuyên nghiệp.
 * Ưu tiên tạo/gửi qua Webhook của kênh (để có tag [WEBHOOK]/[BOT] đẹp), nếu không thì fallback qua bot send embed.
 */
async function sendTicketPaymentNotification(ticketCh, { transferAmount, rawContent, transactionId, matchedOrder, receivingAccount }) {
  if (!ticketCh || !ticketCh.isTextBased()) return;

  const data = getMenuData();
  const storeName = data.storeName || '4AM STORE';
  const logo = data.logoUrl || data.menuEmbed?.logoUrl || (!data.logoUrl?.includes('imgur.com/4iB2Q2K') ? data.logoUrl : null);
  const staffRoleMention = process.env.STAFF_ROLE_ID ? `<@&${process.env.STAFF_ROLE_ID}>` : '';
  const customerMention = matchedOrder?.user?.discordId ? `<@${matchedOrder.user.discordId}>` : '';

  const embed = new EmbedBuilder()
    .setTitle('🎉 XÁC NHẬN THANH TOÁN THÀNH CÔNG!')
    .setColor(0x00C2A8) // Màu xanh mint sang trọng, nổi bật
    .setDescription([
      '**Hệ thống đã nhận được tiền chuyển khoản thành công từ ngân hàng!**',
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `💵 **Số tiền nhận:** **+${transferAmount.toLocaleString('vi-VN')} VNĐ**`,
      `🏦 **Tài khoản nhận:** \`${receivingAccount || process.env.BANK_ACCOUNT || '(không có)'}\` (${[process.env.BANK_NAME, process.env.BANK_OWNER].filter(Boolean).join(' — ') || 'Tài khoản đã cấu hình'})`,
      `📝 **Nội dung chuyển khoản:** \`${rawContent || '(Không có)'}\``,
      transactionId ? `🔢 **Mã giao dịch:** \`${transactionId}\`` : '',
      matchedOrder?.orderNo ? `📦 **Mã đơn hàng:** \`#${matchedOrder.orderNo}\` ${customerMention ? `(Khách: ${customerMention})` : ''}` : '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      '✅ **Trạng thái:** **ĐÃ THANH TOÁN (PAID)**',
      '⚡ **Hỗ trợ:** Staff đã nhận thông báo và sẽ bàn giao dịch vụ ngay cho bạn!',
      '',
      '⚠️ **Lưu ý:** Vui lòng không quét mã hoặc chuyển tiền thêm lần nữa cho đơn này!'
    ].filter(Boolean).join('\n'))
    .setFooter({ text: `${storeName} • Hệ Thống Xác Thực Tự Động VietQR` })
    .setTimestamp();

  if (logo && /^https?:\/\//i.test(logo.trim())) {
    embed.setThumbnail(logo.trim());
  }

  const pingText = [customerMention, staffRoleMention].filter(Boolean).join(' ');

  let sentViaWebhook = false;
  if (typeof ticketCh.fetchWebhooks === 'function') {
    try {
      const hooks = await ticketCh.fetchWebhooks().catch(() => null);
      let hook = hooks?.find(h => h.name === '4AM Payment' || h.name === '4AM Auto Pay');
      if (!hook && typeof ticketCh.createWebhook === 'function') {
        hook = await ticketCh.createWebhook({
          name: '4AM Payment',
          avatar: (logo && /^https?:\/\//i.test(logo.trim())) ? logo.trim() : undefined
        }).catch(() => null);
      }
      if (hook) {
        await hook.send({
          content: pingText ? `🔔 ${pingText}` : undefined,
          embeds: [embed],
          username: `${storeName} • Auto Payment`,
          avatarURL: (logo && /^https?:\/\//i.test(logo.trim())) ? logo.trim() : undefined
        });
        sentViaWebhook = true;
      }
    } catch (_) {}
  }

  if (!sentViaWebhook) {
    await ticketCh.send({
      content: pingText ? `🔔 ${pingText}` : undefined,
      embeds: [embed]
    }).catch(err => console.error('Lỗi gửi thông báo thanh toán vào ticket:', err));
  }
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

function buildPaymentBlock(seller, orderCode, accountIndex = 'all') {
  const isShopCommon = seller?.isShop || seller?.id === 'shop_common' || !seller?.discordId;
  const sellerDiscordId = !isShopCommon && (seller?.discordId || (seller?.id && /^\d{17,20}$/.test(seller.id) ? seller.id : null));
  const sellerMention = sellerDiscordId ? `<@${sellerDiscordId}>` : '';
  const sellerDisplayName = seller?.username ? `@${seller.username}` : (seller?.name || '4AM STORE');
  
  const headerTitle = isShopCommon
    ? '💳 **THÔNG TIN THANH TOÁN — CỬA HÀNG (STK CHUNG):**'
    : `💳 **THÔNG TIN THANH TOÁN — Người bán: ${sellerMention || sellerDisplayName}**`;

  let activeAccounts = seller?.accounts || [];
  if (accountIndex !== 'all' && accountIndex !== undefined && accountIndex !== '') {
    const idx = parseInt(accountIndex, 10);
    if (!isNaN(idx) && activeAccounts[idx]) {
      activeAccounts = [activeAccounts[idx]];
    }
  }

  if (!activeAccounts.length) {
    const bankName = process.env.BANK_NAME;
    const bankAccount = process.env.BANK_ACCOUNT;
    const bankOwner = process.env.BANK_OWNER;
    if (!bankName || !bankAccount || !bankOwner) {
      return '⚠️ **Thanh toán chuyển khoản đang tạm khóa vì shop chưa cấu hình đủ thông tin ngân hàng. Vui lòng chờ owner hỗ trợ.**';
    }
    return [
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      headerTitle,
      `🏛️ **Ngân hàng:** \`${bankName}\``,
      `🔢 **Số tài khoản:** \`${bankAccount}\``,
      `👤 **Chủ tài khoản:** \`${bankOwner}\``,
      `📝 **Nội dung CK:** \`4AM ${orderCode}\``,
      '*(Vui lòng điền đúng nội dung để nhân viên đối soát nhanh nhất)*',
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
    `📝 **Nội dung CK:** \`4AM ${orderCode}\``,
    '*(Vui lòng điền đúng nội dung để nhân viên đối soát nhanh nhất)*',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
  ].join('\n');
}

function buildMenuMessage(targetTicketChannelId = null) {
  const data = getMenuData();
  const targetTicketId = targetTicketChannelId || data.ticketChannelId || data.channels?.ticketViChannelId;
  const ticketMention = targetTicketId ? `<#${targetTicketId}>` : '#ticket';

  const defaultVi = {
    title: `BẢNG GIÁ CÁC MẶT HÀNG TẠI ${data.storeName || '4AM STORE'}`,
    line1: '• Xem Giá Sản Phẩm Bên Dưới Nhé !',
    line2: `• Khi chọn được mặt hàng ưng ý, bạn có thể tạo Ticket để mua hàng tại ${ticketMention}`,
    paymentTitle: '╰─ PHƯƠNG THỨC THANH TOÁN',
    paymentMethods: data.paymentMethods || 'Bank, MoMo, Card',
    footerNote: 'Bảng giá không cố định, có thể thay đổi theo thời gian',
    placeholder: 'Đưa ra lựa chọn'
  };

  const menuConf = (data.menuEmbed && data.menuEmbed.vi) ? data.menuEmbed.vi : defaultVi;
  const rawTitle = menuConf.title || defaultVi.title;
  const finalTitle = rawTitle.replace(/\{storeName\}/g, data.storeName || '4AM STORE');

  const descLines = [];
  // 1. Tiêu đề 1 giữ nguyên cỡ chữ to (#) theo đúng yêu cầu
  const cleanMainTitle = finalTitle.replace(/^#+\s*/, '').trim();
  if (cleanMainTitle) {
    descLines.push(`# ${cleanMainTitle}`);
  }

  const linesToUse = Array.isArray(menuConf.lines)
    ? menuConf.lines
    : [menuConf.line1, menuConf.line2].filter(Boolean);

  // 2. Nội dung 1 dạng subtext (-#) với bullet thanh lịch
  for (const line of linesToUse) {
    if (line !== undefined && line !== null && String(line).trim()) {
      const formatted = String(line)
        .replace(/\{ticket\}/g, ticketMention)
        .replace(/\{storeName\}/g, data.storeName || '4AM STORE')
        .trim();
      const bulletItem = formatted.startsWith('•') || formatted.startsWith('-') || formatted.startsWith('*')
        ? formatted
        : `• ${formatted}`;
      const subLine = bulletItem.startsWith('-#') ? bulletItem : `-# ${bulletItem}`;
      descLines.push(subLine);
    }
  }

  // 3. Mục 2 (Tiêu đề 2 & Nội dung 2) - Bỏ dòng trống descLines.push('') để khép sát 2 cục nội dung
  const sec2Title = menuConf.section2Title || menuConf.paymentTitle;
  if (sec2Title && sec2Title.trim()) {
    let cleanTitle = sec2Title.trim().replace(/^#+\s*/, '').replace(/^\*\*|\*\*$/g, '').trim();
    descLines.push(`### ${cleanTitle}`);
  }

  const sec2LinesRaw = menuConf.section2Lines || menuConf.paymentMethods;
  if (sec2LinesRaw) {
    const rawItems = Array.isArray(sec2LinesRaw)
      ? sec2LinesRaw
      : String(sec2LinesRaw).includes('\n')
        ? String(sec2LinesRaw).split('\n')
        : String(sec2LinesRaw).split('|');
    const items = rawItems.map(x => String(x || '').trim()).filter(Boolean);
    for (const item of items) {
      const formatted = item
        .replace(/\{ticket\}/g, ticketMention)
        .replace(/\{storeName\}/g, data.storeName || '4AM STORE')
        .trim();
      const bulletItem = formatted.startsWith('•') || formatted.startsWith('-') || formatted.startsWith('*')
        ? formatted
        : `• ${formatted}`;
      const subLine = bulletItem.startsWith('-#') ? bulletItem : `-# ${bulletItem}`;
      descLines.push(subLine);
    }
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
  if (banner && banner.trim() && /^https?:\/\//i.test(banner.trim())) {
    menuEmbed.setImage(banner.trim());
  }

  const logo = data.menuEmbed?.logoUrl !== undefined ? data.menuEmbed.logoUrl : data.logoUrl;
  if (logo && logo.trim() && /^https?:\/\//i.test(logo.trim())) {
    // Khôi phục lại Thumbnail logo góc phải theo đúng yêu cầu
    menuEmbed.setThumbnail(logo.trim());
  }

  if (menuConf.footerNote && menuConf.footerNote.trim()) {
    const fNote = menuConf.footerNote.trim();
    if (fNote.toLowerCase() !== (data.storeName || '4AM STORE').toLowerCase()) {
      menuEmbed.setFooter({ text: fNote, iconURL: (logo && /^https?:\/\//i.test(logo.trim())) ? logo.trim() : undefined });
    }
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
      label: cat.label || key,
      value: key,
      emoji: optEmoji
    };
  });

  const placeholderText = menuConf.placeholder || 'Đưa ra lựa chọn';
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('select_store_category')
    .setPlaceholder(placeholderText)
    .addOptions(selectOptions.length ? selectOptions : [{ label: 'Trống', value: 'none' }]);

  const selectRow = new ActionRowBuilder().addComponents(selectMenu);

  return { embeds: [menuEmbed], components: [selectRow] };
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

  const targetTicketId = data.ticketChannelId || data.channels?.ticketViChannelId;
  const messageData = buildMenuMessage(targetTicketId);

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
  console.log(`✅ Đã đồng bộ bảng giá vào kênh #${channel.name}`);
}

function buildTicketMessage() {
  const data = getMenuData();
  const tp = data.ticketPanel || {};
  const langConf = tp.vi || {};
  const storeName = data.storeName || '4AM STORE';

  // 1. Build Title & Description
  const rawTitle = langConf.title || '🎟️ TRUNG TÂM HỖ TRỢ & MUA HÀNG — {storeName}';
  const embedTitle = rawTitle.replace(/\{storeName\}/g, storeName);

  let descLines = [];
  if (langConf.subtitle) {
    descLines.push(langConf.subtitle.replace(/\{storeName\}/g, storeName));
    descLines.push('');
  }
  if (Array.isArray(langConf.lines) && langConf.lines.length > 0) {
    for (const l of langConf.lines) {
      if (l !== undefined && l !== null) {
        const trimmed = String(l).trim();
        if (trimmed) {
          const formatted = trimmed.replace(/\{storeName\}/g, storeName);
          const bulletLine = formatted.startsWith('•') || formatted.startsWith('-') || formatted.startsWith('*')
            ? formatted
            : `• ${formatted}`;
          descLines.push(bulletLine);
        } else if (descLines.length > 0 && descLines[descLines.length - 1] !== '') {
          descLines.push('');
        }
      }
    }
  } else {
    descLines.push('Chào mừng bạn đến với hệ thống hỗ trợ của **' + storeName + '**!');
    descLines.push('');
    descLines.push('• Mua các dịch vụ **Discord Nitro, Boost Server, Spotify, Youtube, Netflix, VPS, Bot Hosting**...');
    descLines.push('• Hỗ trợ kỹ thuật, kiểm tra đơn hàng hoặc bảo hành.');
    descLines.push('');
    descLines.push('👉 Bấm nút **"🎟️ Mở Ticket Hỗ Trợ"** bên dưới để tạo kênh chat riêng với Staff 24/7!');
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

  const btnLabel = langConf.buttonLabel || '🎟️ Mở Ticket Hỗ Trợ';
  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('create_general_ticket')
      .setLabel(btnLabel)
      .setStyle(ButtonStyle.Success)
  );

  return { embeds: [embed], components: [actionRow] };
}

async function syncTicketChannel(targetChannelId = null) {
  const data = getMenuData();
  const ticketChannelId = targetChannelId || data.ticketChannelId || data.channels?.ticketViChannelId || process.env.TICKET_PANEL_CHANNEL_ID || '1379348256743489546';
  const channel = await client.channels.fetch(ticketChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const tp = data.ticketPanel || {};

  // Build ticket message & clean old bot messages
  const messageData = buildTicketMessage();
  try {
    const fetched = await channel.messages.fetch({ limit: 20 });
    const botMsgs = fetched.filter(m => m.author.id === client.user.id);
    for (const m of botMsgs.values()) {
      await m.delete().catch(() => {});
    }
  } catch (_) {}

  await channel.send(messageData);
  console.log(`✅ Đã đồng bộ ticket panel vào kênh #${channel.name}`);
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

// Utility: resolve valid Ticket Category ID with safe fallbacks
function resolveTicketCategoryId(guild, data) {
  if (!guild) return null;
  const configuredId = data.channels?.ticketCategoryId || data.ticketCategoryId || process.env.TICKETS_CATEGORY_ID;
  if (configuredId) {
    const existing = guild.channels.cache.get(configuredId);
    if (existing && existing.type === ChannelType.GuildCategory) {
      return existing.id;
    }
  }
  const byName = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.toUpperCase().includes('TICKET'));
  if (byName) return byName.id;
  if (guild.channels.cache.has('1441078154239410206')) return '1441078154239410206';
  return null;
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    client.user.setPresence({
      activities: [{ name: '4AM STORE • Hệ thống tự động', type: ActivityType.Custom }],
      status: 'online'
    });
  } catch (_) {}
  if (uiTestMode) {
    console.log('🧪 UI test mode: Discord is connected, but sync, interactions, schedulers and GPM polling are disabled.');
    return;
  }
  await seedCatalog();
  console.log('Catalog seeded ✅');
  await syncMenuChannel();
  await syncTicketChannel();
  startExpiryReminderScheduler();
  console.log('4AM Discord Bot is ready! 🚀');
});


// ==========================================
// AUTO RESPONSE LISTENER (Tự động trả lời theo từ khóa)
// ==========================================
client.on('messageCreate', async (message) => {
  try {
    // Bỏ qua tin nhắn từ Bot, webhook hoặc ngoài Server (DM)
    if (!message || message.author?.bot || !message.guild) return;

    const content = message.content;
    if (!content) return;

    // Tìm phản hồi tự động phù hợp
    const matched = findMatchingAutoResponse(content, message.channel.id);
    if (!matched) return;

    const payload = {};
    if (matched.response) {
      payload.content = matched.response;
    }

    const imgUrl = (matched.imageUrl || '').trim();
    if (imgUrl && /^https?:\/\//i.test(imgUrl)) {
      payload.files = [{
        attachment: imgUrl,
        name: 'autoresponse_media' + (path.extname(imgUrl.split('?')[0]) || '.png')
      }];
    }

    // Nếu không có nội dung lẫn ảnh thì bỏ qua
    if (!payload.content && (!payload.files || !payload.files.length)) return;

    // Gửi trả lời: Reply hoặc Send vào kênh
    if (matched.replyMode === 'send') {
      await message.channel.send(payload).catch(async (sendErr) => {
        // Fallback: nếu đính kèm file ảnh lỗi, gửi lại nội dung chữ
        if (payload.files && payload.content) {
          await message.channel.send({ content: payload.content }).catch(() => {});
        }
      });
    } else {
      await message.reply(payload).catch(async (replyErr) => {
        // Fallback: nếu reply kèm ảnh lỗi, reply lại nội dung chữ
        if (payload.files && payload.content) {
          await message.reply({ content: payload.content }).catch(() => {});
        }
      });
    }
  } catch (err) {
    console.error('Lỗi trong bộ xử lý auto response (messageCreate):', err);
  }
});

client.on('interactionCreate', async (i) => {
  if (uiTestMode) {
    if (i.isRepliable() && !i.replied && !i.deferred) {
      await i.reply({ content: '🧪 Hệ thống đang ở chế độ kiểm thử giao diện. Vui lòng thử lại sau.', ephemeral: true }).catch(() => {});
    }
    return;
  }
  try {
  // --- Deprecated Language Role Buttons (No longer required) ---
  if (i.isButton() && (i.customId === 'role_lang_vi' || i.customId === 'role_lang_en')) {
    return i.reply({
      content: 'ℹ️ **Server đã mở toàn bộ kênh cho tất cả mọi người!** Bạn không cần phải chọn role ngôn ngữ nữa.',
      ephemeral: true
    });
  }


  // --- Sapphire Menu Dropdown Select ---
  if (i.isStringSelectMenu() && i.customId.startsWith('select_store_category')) {
    const selectedKey = i.values[0];
    const data = getMenuData();
    const cat = data.categories?.[selectedKey];
    if (!cat) {
      return i.reply({ content: '❌ Không tìm thấy thông tin cho danh mục này.', ephemeral: true });
    }

    const items = cat.items || [];
    
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
        return `• \` ${p.name} \`\n> ➜ **Giá:** \`${p.price}\``;
      }).join('\n');
    };

    const itemsList = formatPackageItemBox(items);
    const baseTitle = cat.title || `Bảng Giá ${cat.label}`;
    const catTitle = (cat.emoji && !baseTitle.includes(cat.emoji)) ? `${cat.emoji} ${baseTitle}` : baseTitle;
    const rawSubtitle = cat.subtitle || '';
    let noteLine = '';
    if (rawSubtitle && rawSubtitle.trim()) {
      noteLine = `-# ${rawSubtitle.trim()}`;
    }

    const { seller, handlers } = getSellerForCategory(selectedKey);
    const allHandlerIds = (handlers && handlers.length > 0) ? handlers : (seller?.discordId ? [seller.discordId] : []);
    
    let handlerLine = '';
    if (allHandlerIds.length > 0) {
      const handlerTags = allHandlerIds.map(h => `<@${h}>`).join(', ');
      handlerLine = `👤 **Người phụ trách:** ${handlerTags}`;
    } else {
      handlerLine = `👤 **Người phụ trách:** Staff 24/7`;
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
      .setCustomId(`create_ticket_from_menu|${selectedKey}`)
      .setLabel(`🎟️ Mở Ticket mua ${cat.label}`)
      .setStyle(ButtonStyle.Primary);

    const buttonRow = new ActionRowBuilder().addComponents(buyButton);

    return i.reply({ embeds: [catEmbed], components: [buttonRow], ephemeral: true });
  }

  // --- Create Ticket From Menu Button ---
  if (i.isButton() && i.customId.startsWith('create_ticket_from_menu|')) {
    const parts = i.customId.split('|');
    const categoryKey = parts[1];
    const lang = parts[2] || 'vi';
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
          content: `⏳ Bạn vui lòng chờ thêm **${gate.waitMin} phút** trước khi tạo ticket tiếp theo. (Giới hạn: ${TICKET_COOLDOWN_MIN} phút)`,
          ephemeral: true
        });
      }
    }

    await i.deferReply({ ephemeral: true });

    const guild = i.guild || await client.guilds.fetch(process.env.GUILD_ID);
    const orderDraftNo = shortOrderNo();
    const ticketCategoryId = resolveTicketCategoryId(guild, data);

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
    let ticketChannel = null;
    try {
      ticketChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: ticketCategoryId ?? undefined,
        permissionOverwrites: overwrites,
        reason: `Ticket mua ${cat.label} tạo bởi ${i.user.tag}`
      });
    } catch (chErr) {
      console.error('Lỗi khi tạo kênh ticket:', chErr);
      return i.editReply({ content: '❌ Không thể tạo kênh ticket lúc này. Vui lòng liên hệ Admin!', ephemeral: true });
    }

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

    let supportMsg = '';
    if (allHandlerIds.length > 1) {
      const tags = allHandlerIds.map(h => `<@${h}>`).join(' & ');
      supportMsg = `👥 Người phụ trách hỗ trợ: ${tags} sẽ trực tiếp hỗ trợ bạn đơn hàng này.`;
    } else if (allHandlerIds.length === 1) {
      supportMsg = `👤 Người bán phụ trách: <@${allHandlerIds[0]}> sẽ trực tiếp hỗ trợ bạn đơn hàng này.`;
    } else if (staffRoleId) {
      supportMsg = `Nhân viên hỗ trợ <@&${staffRoleId}> sẽ có mặt ngay để tư vấn cho bạn.`;
    }

    const welcomeEmbed = new EmbedBuilder()
      .setTitle(`🎟️ TICKET MUA HÀNG — ${cat.label.toUpperCase()}`)
      .setDescription([
        `Xin chào <@${i.user.id}>! Cảm ơn bạn đã quan tâm đến **${cat.label}** tại **${data.storeName || '4AM STORE'}**.`,
        supportMsg,
        '',
        `📦 **Dịch vụ quan tâm:** **${cat.label}**`,
        '',
        '👉 **Vui lòng chọn loại gói bạn muốn mua (hoặc chọn "Cần tư vấn") ở menu bên dưới:**'
      ].filter(Boolean).join('\n'))
      .setColor(cat.color || 0x00C2A8)
      .setFooter({ text: '4AM Shop • Hỗ trợ 24/7' })
      .setTimestamp();

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

    const hasQuantity = Object.values(cat.items || {}).some(it => {
      const clean = String(it || '').split('|')[0];
      const p = String(it || '').split('|')[1] || '';
      return parseQuantityItemInfo(clean, p, cat).isQuantity;
    });
    const itemPrompt = buildCategoryItemPrompt(cat, categoryKey, orderDraftNo);
    const ticketActionRow = buildTicketActionRow(orderDraftNo, categoryKey, hasQuantity);
    await ticketChannel.send({
      content: mentions.join(' '),
      embeds: [welcomeEmbed],
      components: [itemPrompt.row, ticketActionRow]
    });

    return i.editReply({ content: `✅ Đã tạo Ticket hỗ trợ mua **${cat.label}** tại: <#${ticketChannel.id}>` });
  }

  // --- Create General Ticket (From Ticket Channel Panel) ---
  if (i.isButton() && i.customId.startsWith('create_general_ticket')) {
    const data = getMenuData();
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

    const guild = i.guild || await client.guilds.fetch(process.env.GUILD_ID);
    const orderDraftNo = shortOrderNo();
    const ticketCategoryId = resolveTicketCategoryId(guild, data);

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
    const langConf = tp.vi || {};
    const storeName = data.storeName || '4AM STORE';
    const prefix = (tp.ticketPrefix || 'ticket-support').toLowerCase().replace(/[^a-z0-9_-]/g, '-');

    let ticketChannel = null;
    try {
      ticketChannel = await guild.channels.create({
        name: `${prefix}-${i.user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}-${orderDraftNo}`,
        type: ChannelType.GuildText,
        parent: ticketCategoryId ?? undefined,
        permissionOverwrites: overwrites,
        reason: `Ticket hỗ trợ tạo bởi ${i.user.tag}`
      });
    } catch (chErr) {
      console.error('Lỗi khi tạo kênh ticket tổng:', chErr);
      return i.editReply({ content: '❌ Không thể tạo kênh ticket lúc này. Vui lòng liên hệ Admin!', ephemeral: true });
    }

    if (!isStaff) markTicketOpened(i.user.id);

    // Auto-record support order in SQLite Database & attach ticket
    let dbOrder = null;
    try {
      const dbUser = await ensureUser(i.user.id, null, i.user.globalName || i.user.username, null);
      const dbProduct = await findOrCreateProduct({
        type: 'SUPPORT_TICKET',
        name: 'Hỗ Trợ Khách Hàng',
        sku: 'SUPPORT_GENERAL',
        specJson: JSON.stringify({ type: 'support' }),
        priceCents: 0,
        currency: 'VNĐ'
      });
      const planSnapshot = {
        categoryKey: 'support',
        categoryLabel: 'Ticket Hỗ Trợ',
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

    const welcomeTitle = (langConf.welcomeTitle || '🎟️ TICKET HỖ TRỢ — {storeName}').replace(/\{storeName\}/g, storeName);
    const rawWelcomeMsg = langConf.welcomeMsg || 'Xin chào <@{userId}>! Cảm ơn bạn đã liên hệ với **{storeName}**.';
    const welcomeMsg = rawWelcomeMsg.replace(/\{userId\}/g, i.user.id).replace(/\{user\}/g, `<@${i.user.id}>`).replace(/\{storeName\}/g, storeName);
    const welcomeNote = langConf.welcomeNote || '💬 *Vui lòng gửi câu hỏi hoặc dịch vụ bạn muốn tư vấn tại kênh này nhé!*';

    const welcomeEmbed = new EmbedBuilder()
      .setTitle(welcomeTitle)
      .setDescription([
        welcomeMsg,
        sellerDiscordId
          ? `Nhân viên phụ trách: <@${sellerDiscordId}> sẽ phản hồi bạn ngay.`
          : (staffRoleId ? `Nhân viên hỗ trợ <@&${staffRoleId}> sẽ có mặt ngay để phục vụ bạn.` : ''),
        '',
        welcomeNote
      ].filter(Boolean).join('\n'))
      .setColor(0x5865F2)
      .setFooter({ text: `${storeName} • Hỗ trợ 24/7` })
      .setTimestamp();

    const generalMentions = [`<@${i.user.id}>`];
    if (sellerDiscordId && sellerDiscordId !== i.user.id) {
      generalMentions.push(`<@${sellerDiscordId}>`);
    }
    if (staffRoleId) {
      generalMentions.push(`<@&${staffRoleId}>`);
    }

    const ticketActionRow = buildTicketActionRow(orderDraftNo);
    const generalPrompt = buildGeneralTicketPrompt(data.categories || {}, orderDraftNo);
    const comps = generalPrompt?.row ? [generalPrompt.row, ticketActionRow] : [ticketActionRow];

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
    const selectedVal = i.values[0];

    const data = getMenuData();
    const cat = data.categories?.[categoryKey] || { label: 'Sản phẩm', color: 0x00C2A8 };
    const catName = cat.label || categoryKey;
    const { seller, handlers } = getSellerForCategory(categoryKey);
    const staffRoleId = process.env.STAFF_ROLE_ID;

    // Find order in DB if exists
    const order = await prisma.order.findFirst({
      where: {
        OR: [
          { orderNo: orderDraftNo },
          { ticket: { channelId: i.channelId } }
        ]
      },
      include: { user: true, product: true }
    });

    if (order && (order.status === 'PAID' || order.status === 'COMPLETED')) {
      return i.reply({
        content: `⛔ Đơn hàng **#${order.orderNo}** đã được xác nhận thanh toán thành công! Không thể thay đổi gói hoặc tạo mã QR thanh toán mới.`,
        ephemeral: true
      });
    }

    const isStaff = await canManageTicket(i, order);

    if (order && order.user?.discordId && order.user.discordId !== i.user.id && !isStaff) {
      return i.reply({
        content: '❌ Chỉ người tạo ticket hoặc nhân viên phụ trách mới có thể thao tác chọn gói.',
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
      const updatedPrompt = buildCategoryItemPrompt(cat, categoryKey, orderDraftNo, 'consult_seller');
      const consultEmbed = new EmbedBuilder()
        .setTitle('💬 YÊU CẦU TƯ VẤN & BÀN BẠC VỚI NGƯỜI BÁN')
        .setDescription([
          `Khách hàng <@${i.user.id}> đã chọn: **Cần tư vấn và bàn bạc với người bán** về **${catName}**.`,
          '',
          `💬 <@${i.user.id}> vui lòng để lại câu hỏi, thời hạn hoặc yêu cầu cụ thể bên dưới để người bán hỗ trợ bạn ngay nhé!`,
          '',
          `*(Bạn có thể chọn lại gói trong menu bên dưới nếu muốn đổi)*`
        ].join('\n'))
        .setColor(0xF1C40F)
        .setTimestamp();

      const ticketActionRow = buildTicketActionRow(orderDraftNo);

      await i.update({
        components: [updatedPrompt.row, ticketActionRow]
      });

      // Xóa tin nhắn chọn gói / QR cũ để tránh trùng lặp
      try {
        const recentMessages = await i.channel.messages.fetch({ limit: 15 });
        for (const m of recentMessages.values()) {
          if (m.author.id === client.user.id && m.embeds.length > 0) {
            const title = m.embeds[0].title || '';
            if (
              title.includes('ĐÃ CHỌN:') ||
              title.includes('SELECTED:') ||
              title.includes('CẦN TƯ VẤN') ||
              title.includes('NEED CONSULTATION')
            ) {
              await m.delete().catch(() => {});
            }
          }
        }
      } catch (_) {}

      await i.channel.send({
        content: `🔔 ${pingStr}: Khách hàng <@${i.user.id}> đang **cần tư vấn và bàn bạc với người bán** về **${catName}**! Vui lòng vào hỗ trợ khách nhé!`,
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
        } catch (err) {
          console.error('Lỗi cập nhật order snapshot (consult):', err);
        }
      }
      return;
    }

    if (selectedVal.startsWith('item_')) {
      const idx = parseInt(selectedVal.replace('item_', ''), 10);
      const rawList = cat.items || [];
      const itemRaw = rawList[idx] || '';
      const cleanRaw = String(itemRaw).trim().replace(/^•\s*/, '');
      let itemName = cleanRaw;
      let itemPrice = '';
      if (cleanRaw.includes('|')) {
        const parts = cleanRaw.split('|').map(s => s.trim());
        itemName = parts[0];
        itemPrice = parts.slice(1).join(' | ');
      }

      const qInfo = parseQuantityItemInfo(itemName, itemPrice, cat);
      if (qInfo.isQuantity) {
        const modal = new ModalBuilder()
          .setCustomId(`modal_buy_quantity|${orderDraftNo}|${categoryKey}|${idx}`)
          .setTitle(`Mua ${catName}`.slice(0, 45))
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('quantity_input')
                .setLabel(`Nhập số lượng ${qInfo.unit} muốn mua:`.slice(0, 45))
                .setPlaceholder(`Ví dụ: 20 (Đơn giá: ${itemPrice || '8.5k'}/1${qInfo.unit})`.slice(0, 100))
                .setStyle(TextInputStyle.Short)
                .setMinLength(1)
                .setMaxLength(10)
                .setRequired(true)
            )
          );
        return i.showModal(modal);
      }

      const amountCents = parsePrice(itemPrice);

      // Resolve bank account for this category/seller
      const catAccountIdx = (cat.accountIndex !== undefined && cat.accountIndex !== 'all') ? parseInt(cat.accountIndex, 10) : 0;
      let targetAcc = seller?.accounts?.[catAccountIdx];
      if (!targetAcc?.account) {
        targetAcc = seller?.accounts?.find(a => a.account && a.account.trim().length > 0);
      }
      if (!targetAcc?.account && process.env.BANK_ACCOUNT) {
        targetAcc = {
          bank: process.env.BANK_NAME || 'MB Bank',
          account: process.env.BANK_ACCOUNT,
          owner: process.env.BANK_OWNER || data.storeName || '4AM STORE'
        };
      }

      let dynamicQrUrl = null;
      let payosCheckoutUrl = null;
      let payosAccountNumber = targetAcc?.account;
      let payosAccountOwner = targetAcc?.owner || data.storeName || 'VO THANH TINH';
      let payosBankName = targetAcc?.bank || 'BIDV';
      let memo = `4AM ${orderDraftNo}`;

      if (targetAcc?.account && amountCents > 0) {
        try {
          const payosRes = await createPayosPayment({
            orderNo: orderDraftNo,
            amount: amountCents,
            description: memo,
            items: [{
              name: `${catName} - ${itemName}`.slice(0, 50),
              quantity: 1,
              price: amountCents
            }]
          });
          if (payosRes?.ok) {
            if (payosRes.checkoutUrl) payosCheckoutUrl = payosRes.checkoutUrl;
            if (payosRes.accountNumber) payosAccountNumber = payosRes.accountNumber;
            if (payosRes.accountName) payosAccountOwner = payosRes.accountName;
            if (payosRes.description) memo = payosRes.description;
          }
        } catch (payosErr) {
          console.error('Lỗi khi gọi createPayosPayment:', payosErr.message);
        }

        const bankBin = resolveBankBin(payosBankName);
        dynamicQrUrl = buildVietQrImageUrl({
          bankBin,
          accountNumber: payosAccountNumber,
          amount: amountCents,
          description: memo,
          accountName: payosAccountOwner
        });
      }

      const updatedPrompt = buildCategoryItemPrompt(cat, categoryKey, orderDraftNo, selectedVal);

      const descLines = [
        `Khách hàng <@${i.user.id}> đã chọn loại sản phẩm:`,
        '',
        `📦 **Sản phẩm:** **${catName}**`,
        `🏷️ **Loại gói:** **${itemName}**`,
        `💰 **Đơn giá:** **${itemPrice || 'Liên hệ'}**`
      ];

      if (dynamicQrUrl) {
        descLines.push(
          '',
          '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
          '💳 **MÃ VIETQR THANH TOÁN TỰ ĐỘNG (PAYOS) - 4AM SHOP**',
          `🏦 **Ngân hàng:** **${payosBankName}**`,
          `🔢 **Số tài khoản:** \`${payosAccountNumber}\``,
          `👤 **Chủ tài khoản:** **${payosAccountOwner}**`,
          `💵 **Số tiền:** **${amountCents.toLocaleString('vi-VN')} VNĐ**`,
          `📝 **Nội dung CK:** \`${memo}\``,
          '',
          `⚡ *Quét mã VietQR hoặc bấm nút **[Trang thanh toán PayOS]** để chuyển khoản. Sau khi chuyển xong, bấm **[🔄 Kiểm tra thanh toán]** để hệ thống duyệt đơn ngay!*`,
          '━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
        );
      } else {
        descLines.push(
          '',
          `📌 Nhân viên/người bán đã nhận được lựa chọn và sẽ hỗ trợ giao dịch cho bạn ngay!`
        );
      }

      descLines.push(
        '',
        `*(Bạn có thể nhấn **🔢 Nhập số lượng** nếu muốn mua nhiều acc/gói, hoặc chọn lại gói khác trong menu)*`
      );

      const selectedEmbed = new EmbedBuilder()
        .setTitle(`✅ ĐÃ CHỌN: ${itemName.toUpperCase()}`)
        .setDescription(descLines.join('\n'))
        .setColor(0x2ECC71)
        .setTimestamp();

      if (dynamicQrUrl) {
        selectedEmbed.setImage(dynamicQrUrl);
      }

      const ticketActionRow = buildTicketActionRow(orderDraftNo, categoryKey, true, payosCheckoutUrl);

      await i.update({
        components: [updatedPrompt.row, ticketActionRow]
      });

      // Xóa tin nhắn chọn gói / QR cũ để tránh khách chuyển nhầm tiền vào QR cũ
      await deleteTicketQrMessages(i.channel);

      await i.channel.send({
        content: `📢 ${pingStr}: Khách hàng <@${i.user.id}> muốn mua **${catName}** — gói **${itemName}** (${itemPrice || ''}). ${dynamicQrUrl ? 'Đã tạo mã QR thanh toán tự động VietQR!' : 'Vui lòng kiểm tra và hỗ trợ khách hàng!'}`,
        embeds: [selectedEmbed]
      });

      if (order) {
        try {
          const snapshot = typeof order.planSnapshotJson === 'string' ? JSON.parse(order.planSnapshotJson || '{}') : (order.planSnapshotJson || {});
          snapshot.selectedItem = itemName;
          snapshot.itemPrice = itemPrice;
          snapshot.unitRate = amountCents;
          snapshot.quantity = 1;
          snapshot.categoryKey = categoryKey;
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
        content: '❌ Chỉ người tạo ticket hoặc nhân viên phụ trách mới có thể thao tác.',
        ephemeral: true
      });
    }

    const ticketActionRow = buildTicketActionRow(orderDraftNo);

    if (selectedVal === 'consult_seller') {
      const consultEmbed = new EmbedBuilder()
        .setTitle('💬 YÊU CẦU TƯ VẤN & BÀN BẠC VỚI NGƯỜI BÁN')
        .setDescription([
          `Khách hàng <@${i.user.id}> đã chọn: **Cần tư vấn và bàn bạc với người bán**.`,
          '',
          `💬 <@${i.user.id}> vui lòng để lại câu hỏi hoặc nội dung bạn cần hỗ trợ bên dưới để nhân viên phục vụ nhé!`,
          '',
          `*(Bạn có thể chọn lại sản phẩm khác ở menu bên dưới)*`
        ].join('\n'))
        .setColor(0xF1C40F)
        .setTimestamp();

      const generalPrompt = buildGeneralTicketPrompt(data.categories || {}, orderDraftNo, 'consult_seller');
      await i.update({
        components: [generalPrompt.row, ticketActionRow]
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
      return i.reply({ content: '❌ Không tìm thấy danh mục này.', ephemeral: true });
    }

    // Transform into the item selector for that category!
    const hasCatQuantity = Object.values(cat.items || {}).some(it => {
      const clean = String(it || '').split('|')[0];
      const p = String(it || '').split('|')[1] || '';
      return parseQuantityItemInfo(clean, p, cat).isQuantity;
    });
    const categoryActionRow = buildTicketActionRow(orderDraftNo, selectedVal, hasCatQuantity);

    const itemPrompt = buildCategoryItemPrompt(cat, selectedVal, orderDraftNo);
    await i.update({
      components: [itemPrompt.row, categoryActionRow]
    });

    // Also update order planSnapshot with category info
    if (order) {
      try {
        const { seller, handlers } = getSellerForCategory(selectedVal);
        const snapshot = typeof order.planSnapshotJson === 'string' ? JSON.parse(order.planSnapshotJson || '{}') : (order.planSnapshotJson || {});
        snapshot.categoryKey = selectedVal;
        snapshot.categoryLabel = cat.label;
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

    await deleteTicketQrMessages(i.channel);

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

    const receiptRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rate_order|${orderNo}`)
        .setLabel('⭐ Đánh giá dịch vụ')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('close_simple_ticket')
        .setLabel('🔒 Đóng Ticket Ngay')
        .setStyle(ButtonStyle.Danger)
    );

    await i.reply({ embeds: [receiptEmbed], components: [receiptRow] });

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
            'Chúc bạn trải nghiệm dịch vụ vui vẻ! Vui lòng dành chút thời gian vote sao và gửi feedback giúp shop nhé ⭐'
          ].filter(Boolean).join('\n'))
          .setTimestamp();
        const dmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`rate_order|${orderNo}`)
            .setLabel('⭐ Đánh giá dịch vụ & Feedback')
            .setStyle(ButtonStyle.Success)
        );
        await customer.send({ embeds: [dmEmbed], components: [dmRow] }).catch(() => {});
      }
    } catch (_) {}

    return;
  }

  // --- Button: Customer or Staff clicks "Nhập / Đổi số lượng" ---
  if (i.isButton() && i.customId.startsWith('btn_change_quantity|')) {
    const parts = i.customId.split('|');
    const orderDraftNo = parts[1];
    let categoryKey = parts[2] || '';

    const order = await prisma.order.findFirst({
      where: {
        OR: [
          { orderNo: orderDraftNo },
          { ticket: { channelId: i.channelId } }
        ]
      },
      include: { user: true, product: true }
    });

    if (order && (order.status === 'PAID' || order.status === 'COMPLETED')) {
      return i.reply({
        content: `⛔ Đơn hàng **#${order.orderNo}** đã được xác nhận thanh toán thành công! Không thể thay đổi số lượng hoặc tạo lại mã QR.`,
        ephemeral: true
      });
    }

    const isStaff = await canManageTicket(i, order);
    const isCustomer = !order || !order.user?.discordId || order.user.discordId === i.user.id;
    if (!isCustomer && !isStaff) {
      return i.reply({
        content: '❌ Chỉ người tạo ticket hoặc nhân viên phụ trách mới có thể đổi số lượng.',
        ephemeral: true
      });
    }
    let snap = {};
    if (order) {
      try {
        snap = JSON.parse(order.planSnapshotJson || '{}');
        if (!categoryKey) categoryKey = snap.categoryKey || '';
      } catch (_) {}
    }

    const data = getMenuData();
    const cat = data.categories?.[categoryKey] || {};
    const catName = cat.label || cat.title || 'Sản phẩm';

    // Check if category has pricing bands (like OwO)
    const hasCatBands = Object.values(cat.items || {}).some(it => {
      const clean = String(it || '').split('|')[0];
      const p = String(it || '').split('|')[1] || '';
      return parseQuantityItemInfo(clean, p, cat).isQuantity;
    });

    // If it's a fixed-price item (Spotify, Netflix...) and no package has been chosen yet:
    if (!hasCatBands && !snap.selectedItem && !snap.itemPrice && (!order || order.amountCents === 0)) {
      return i.reply({
        content: '👉 Vui lòng chọn loại gói bạn muốn mua (ví dụ: 1 Tháng, 1 Năm...) ở menu bên trên trước khi nhập số lượng nhé!',
        ephemeral: true
      });
    }

    // Determine unit
    let sampleUnit = 'gói';
    if (hasCatBands) {
      for (const it of (cat.items || [])) {
        const clean = String(it || '').split('|')[0];
        const p = String(it || '').split('|')[1] || '';
        const info = parseQuantityItemInfo(clean, p, cat);
        if (info.isQuantity) {
          sampleUnit = info.unit;
          break;
        }
      }
    } else {
      const combined = `${catName} ${snap.selectedItem || ''}`.toLowerCase();
      if (/acc|tài khoản/i.test(combined)) sampleUnit = 'acc';
      else if (/slot/i.test(combined)) sampleUnit = 'slot';
      else sampleUnit = 'gói';
    }

    let defaultVal = '1';
    if (snap.quantity) {
      defaultVal = String(snap.quantity);
    } else if (hasCatBands) {
      defaultVal = '';
    }

    const itemLabel = snap.selectedItem ? ` (${snap.selectedItem})` : '';
    const modal = new ModalBuilder()
      .setCustomId(`modal_buy_quantity|${orderDraftNo}|${categoryKey}|0`)
      .setTitle(`Nhập số lượng: ${catName}`.slice(0, 45))
      .addComponents(
        new ActionRowBuilder().addComponents(
          (() => {
            const input = new TextInputBuilder()
              .setCustomId('quantity_input')
              .setLabel(`Số lượng ${sampleUnit} muốn mua${itemLabel}:`.slice(0, 45))
              .setPlaceholder(hasCatBands ? `Ví dụ: 20 hoặc 50 (Tự tính theo band giá)` : `Ví dụ: 2 (Mua cho 2 ${sampleUnit})`)
              .setStyle(TextInputStyle.Short)
              .setMinLength(1)
              .setMaxLength(10)
              .setRequired(true);
            if (defaultVal && String(defaultVal).trim()) {
              input.setValue(String(defaultVal).trim());
            }
            return input;
          })()
        )
      );

    return i.showModal(modal);
  }

  // --- Button: Staff or Seller clicks "Sửa bill" ---
  if (i.isButton() && i.customId.startsWith('btn_staff_set_amount|')) {
    const parts = i.customId.split('|');
    const orderDraftNo = parts[1];

    const order = await prisma.order.findFirst({
      where: { orderNo: orderDraftNo },
      include: { user: true, product: true }
    });

    const isStaff = await canManageTicket(i, order);
    if (!isStaff) {
      return i.reply({
        content: '⚠️ Chỉ Nhân viên (Staff) hoặc Người bán phụ trách mới có quyền sửa số tiền bill!',
        ephemeral: true
      });
    }

    const modal = new ModalBuilder()
      .setCustomId(`modal_staff_set_amount|${orderDraftNo}`)
      .setTitle(`Sửa bill #${orderDraftNo}`.slice(0, 45));

    const currentAmount = order ? (order.amountCents || 0) : 0;

    const amountInput = new TextInputBuilder()
      .setCustomId('staff_amount_input')
      .setLabel('Số tiền thanh toán mới (VNĐ):')
      .setPlaceholder('Ví dụ: 170000 (chỉ điền số)')
      .setValue(currentAmount > 0 ? String(currentAmount) : '')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const reasonInput = new TextInputBuilder()
      .setCustomId('staff_reason_input')
      .setLabel('Lý do / Thỏa thuận / Tên gói:')
      .setPlaceholder('Ví dụ: Deal giá sỉ, giảm giá combo...')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder().addComponents(amountInput),
      new ActionRowBuilder().addComponents(reasonInput)
    );

    return i.showModal(modal);
  }

  // --- Modal Submit: Customer inputs quantity for OwO / Quantity Items ---
  if (i.isModalSubmit() && i.customId.startsWith('modal_buy_quantity|')) {
    const parts = i.customId.split('|');
    const orderDraftNo = parts[1];
    let categoryKey = parts[2];
    const fallbackIdx = parseInt(parts[3] || '0', 10);

    const rawInput = i.fields.getTextInputValue('quantity_input')?.trim() || '';
    const cleanNumStr = rawInput.replace(/,/g, '.').replace(/[^0-9.]/g, '');
    const quantity = parseFloat(cleanNumStr);

    if (isNaN(quantity) || quantity <= 0) {
      return i.reply({
        content: '⚠️ Số lượng không hợp lệ! Vui lòng nhập số dương (Ví dụ: 20 hoặc 50).',
        ephemeral: true
      });
    }

    const order = await prisma.order.findFirst({
      where: {
        OR: [
          { orderNo: orderDraftNo },
          { ticket: { channelId: i.channelId } }
        ]
      },
      include: { user: true, product: true }
    });

    if (order && (order.status === 'PAID' || order.status === 'COMPLETED')) {
      return i.reply({
        content: `⛔ Đơn hàng **#${order.orderNo}** đã được xác nhận thanh toán thành công! Không thể thay đổi số lượng hoặc tạo lại mã QR.`,
        ephemeral: true
      });
    }

    if (!categoryKey && order) {
      try {
        const snap = JSON.parse(order.planSnapshotJson || '{}');
        categoryKey = snap.categoryKey || '';
      } catch (_) {}
    }

    const data = getMenuData();
    const cat = data.categories?.[categoryKey] || {};
    const catName = cat.label || cat.title || 'Sản phẩm';

    // Check if category has pricing bands (like OwO)
    const hasCatBands = Object.values(cat.items || {}).some(it => {
      const clean = String(it || '').split('|')[0];
      const p = String(it || '').split('|')[1] || '';
      return parseQuantityItemInfo(clean, p, cat).isQuantity;
    });

    let unitRate = 0;
    let unit = 'gói';
    let bandName = '';
    let totalAmount = 0;

    if (hasCatBands) {
      // 1. BAND-BASED PRICING (OwO, Xu, Coin)
      const bandResult = findBestBandForQuantity(quantity, cat, fallbackIdx);
      unitRate = bandResult.unitRate || 0;
      unit = bandResult.unit || 'M';
      bandName = bandResult.bandName || `${catName}`;
      totalAmount = Math.round(quantity * unitRate);
    } else {
      // 2. FIXED-PRICE PACKAGES (Spotify, Netflix, VPS...)
      if (snap.unitRate && snap.unitRate > 0) {
        unitRate = snap.unitRate;
      } else if (snap.itemPrice) {
        unitRate = parsePrice(snap.itemPrice);
      } else if (order?.amountCents > 0 && snap.quantity) {
        unitRate = Math.round(order.amountCents / snap.quantity);
      } else if (order?.amountCents > 0) {
        unitRate = order.amountCents;
      } else {
        unitRate = order?.product?.priceCents || 0;
      }

      bandName = snap.selectedItem || (order?.product?.name || catName);

      const combined = `${catName} ${bandName}`.toLowerCase();
      if (/acc|tài khoản/i.test(combined)) unit = 'acc';
      else if (/slot/i.test(combined)) unit = 'slot';
      else unit = 'gói';

      if (unitRate <= 0) {
        return i.reply({
          content: '⚠️ Chưa xác định được đơn giá của gói này. Vui lòng chọn gói ở menu phía trên trước nhé!',
          ephemeral: true
        });
      }

      totalAmount = Math.round(quantity * unitRate);
    }

    // Resolve sellers and handlers
    const { seller, handlers, accountIndex } = getSellerForCategory(categoryKey);
    const allHandlerIds = (handlers && handlers.length > 0) ? handlers : (seller?.discordId ? [seller.discordId] : []);
    const pings = [];
    allHandlerIds.forEach(hId => {
      if (hId && !pings.includes(`<@${hId}>`)) pings.push(`<@${hId}>`);
    });
    const staffRoleId = process.env.STAFF_ROLE_ID;
    if (staffRoleId && !pings.includes(`<@&${staffRoleId}>`)) {
      pings.push(`<@&${staffRoleId}>`);
    }
    const pingStr = pings.length > 0 ? pings.join(' ') : 'Nhân viên hỗ trợ';

    // Resolve bank account
    const catAccountIdx = (cat.accountIndex !== undefined && cat.accountIndex !== 'all')
      ? parseInt(cat.accountIndex, 10)
      : ((accountIndex !== undefined && accountIndex !== 'all') ? parseInt(accountIndex, 10) : 0);
    let targetAcc = seller?.accounts?.[catAccountIdx];
    if (!targetAcc?.account) {
      targetAcc = seller?.accounts?.find(a => a.account && a.account.trim().length > 0);
    }
    if (!targetAcc?.account && process.env.BANK_ACCOUNT) {
      targetAcc = {
        bank: process.env.BANK_NAME || 'MB Bank',
        account: process.env.BANK_ACCOUNT,
        owner: process.env.BANK_OWNER || data.storeName || '4AM STORE'
      };
    }

    let dynamicQrUrl = null;
    let payosCheckoutUrl = null;
    let payosAccountNumber = targetAcc?.account;
    let payosAccountOwner = targetAcc?.owner || data.storeName || 'VO THANH TINH';
    let payosBankName = targetAcc?.bank || 'BIDV';
    let memo = `4AM ${orderDraftNo}`;

    if (targetAcc?.account && totalAmount > 0) {
      try {
        const payosRes = await createPayosPayment({
          orderNo: orderDraftNo,
          amount: totalAmount,
          description: memo,
          items: [{
            name: `${catName} - ${bandName}`.slice(0, 50),
            quantity: quantity,
            price: totalAmount
          }]
        });
        if (payosRes?.ok) {
          if (payosRes.checkoutUrl) payosCheckoutUrl = payosRes.checkoutUrl;
          if (payosRes.accountNumber) payosAccountNumber = payosRes.accountNumber;
          if (payosRes.accountName) payosAccountOwner = payosRes.accountName;
          if (payosRes.description) memo = payosRes.description;
        }
      } catch (payosErr) {
        console.error('Lỗi khi gọi createPayosPayment (quantity):', payosErr.message);
      }

      const bankBin = resolveBankBin(payosBankName);
      dynamicQrUrl = buildVietQrImageUrl({
        bankBin,
        accountNumber: payosAccountNumber,
        amount: totalAmount,
        description: memo,
        accountName: payosAccountOwner
      });
    }

    // Update order in database
    if (order) {
      try {
        const snapshot = typeof order.planSnapshotJson === 'string' ? JSON.parse(order.planSnapshotJson || '{}') : (order.planSnapshotJson || {});
        snapshot.quantity = quantity;
        snapshot.unit = unit;
        snapshot.unitRate = unitRate;
        snapshot.bandName = bandName;
        snapshot.selectedItem = snapshot.selectedItem || bandName;
        snapshot.itemPrice = `${unitRate.toLocaleString('vi-VN')} VNĐ / 1${unit}`;
        snapshot.consultationRequested = false;
        snapshot.categoryKey = categoryKey;

        await prisma.order.update({
          where: { id: order.id },
          data: {
            amountCents: totalAmount,
            planSnapshotJson: JSON.stringify(snapshot)
          }
        });
      } catch (err) {
        console.error('Lỗi cập nhật order snapshot (quantity):', err);
      }
    }

    const descLines = [
      `Khách hàng <@${i.user.id}> đã đặt số lượng mua:`,
      '',
      `📦 **Sản phẩm:** **${catName}**`,
      `🏷️ **Gói áp dụng:** **${bandName}**`,
      `🔢 **Số lượng:** **${quantity.toLocaleString('vi-VN')} ${unit}**`,
      `💰 **Đơn giá:** **${unitRate.toLocaleString('vi-VN')} VNĐ / 1${unit}**`,
      `💵 **TỔNG TIỀN:** **${totalAmount.toLocaleString('vi-VN')} VNĐ**`
    ];

    if (dynamicQrUrl) {
      descLines.push(
        '',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '💳 **MÃ VIETQR THANH TOÁN TỰ ĐỘNG (PAYOS) - 4AM SHOP**',
        `🏦 **Ngân hàng:** **${payosBankName}**`,
        `🔢 **Số tài khoản:** \`${payosAccountNumber}\``,
        `👤 **Chủ tài khoản:** **${payosAccountOwner}**`,
        `💵 **Số tiền:** **${totalAmount.toLocaleString('vi-VN')} VNĐ**`,
        `📝 **Nội dung CK:** \`${memo}\``,
        '',
        `⚡ *Quét mã VietQR hoặc bấm nút **[Trang thanh toán PayOS]** để chuyển khoản. Sau khi chuyển xong, bấm **[🔄 Kiểm tra thanh toán]** để hệ thống duyệt đơn ngay!*`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
      );
    } else {
      descLines.push(
        '',
        '📌 Nhân viên/người bán đã nhận được lựa chọn và sẽ hỗ trợ giao dịch cho bạn ngay!'
      );
    }

    descLines.push(
      '',
      `*(Bạn có thể nhấn **🔢 Nhập số lượng** để đổi lại số lượng, hoặc chọn lại gói khác trong menu nếu muốn đổi)*`
    );

    const qtyEmbed = new EmbedBuilder()
      .setTitle(`✅ ĐÃ CHỌN: ${quantity.toLocaleString('vi-VN')} ${unit.toUpperCase()} - ${bandName.toUpperCase()}`)
      .setDescription(descLines.join('\n'))
      .setColor(0x2ECC71)
      .setTimestamp();

    if (dynamicQrUrl) {
      qtyEmbed.setImage(dynamicQrUrl);
    }

    const ticketActionRow = buildTicketActionRow(orderDraftNo, categoryKey, true, payosCheckoutUrl);

    // Delete old QR / selection messages in ticket to keep it clean and prevent wrong transfers
    await deleteTicketQrMessages(i.channel);

    const itemInfoStr = (bandName && bandName !== catName) ? ` (${bandName})` : '';
    await i.reply({
      content: `📢 ${pingStr}: Khách hàng <@${i.user.id}> đặt mua **${catName}**${itemInfoStr} — Số lượng **${quantity.toLocaleString('vi-VN')} ${unit}** (Tổng: **${totalAmount.toLocaleString('vi-VN')} VNĐ**). ${dynamicQrUrl ? 'Đã tạo mã QR thanh toán tự động VietQR!' : 'Vui lòng kiểm tra và hỗ trợ!'}`,
      embeds: [qtyEmbed],
      components: [ticketActionRow]
    }).catch(async (err) => {
      console.error('Lỗi khi reply modal_buy_quantity:', err);
      await i.channel.send({
        content: `📢 ${pingStr}: Khách hàng <@${i.user.id}> đặt mua **${catName}**${itemInfoStr} — Số lượng **${quantity.toLocaleString('vi-VN')} ${unit}** (Tổng: **${totalAmount.toLocaleString('vi-VN')} VNĐ**). ${dynamicQrUrl ? 'Đã tạo mã QR thanh toán tự động VietQR!' : 'Vui lòng kiểm tra và hỗ trợ!'}`,
        embeds: [qtyEmbed],
        components: [ticketActionRow]
      });
    });

    return;
  }

  // --- Modal Submit: Staff adjusts bill amount ---
  if (i.isModalSubmit() && i.customId.startsWith('modal_staff_set_amount|')) {
    const parts = i.customId.split('|');
    const orderDraftNo = parts[1];

    const rawAmount = i.fields.getTextInputValue('staff_amount_input')?.trim() || '';
    const note = i.fields.getTextInputValue('staff_reason_input')?.trim() || '';

    const cleanAmount = parseInt(rawAmount.replace(/\D/g, ''), 10);
    if (isNaN(cleanAmount) || cleanAmount <= 0) {
      return i.reply({
        content: '⚠️ Vui lòng nhập số tiền VNĐ hợp lệ (ví dụ: 170000)!',
        ephemeral: true
      });
    }

    const order = await prisma.order.findFirst({
      where: {
        OR: [
          { orderNo: orderDraftNo },
          { ticket: { channelId: i.channelId } }
        ]
      },
      include: { user: true, product: true }
    });

    if (!order) {
      return i.reply({
        content: '❌ Không tìm thấy thông tin đơn hàng trong hệ thống.',
        ephemeral: true
      });
    }

    if (order.status === 'PAID' || order.status === 'COMPLETED') {
      return i.reply({
        content: `⛔ Đơn hàng **#${order.orderNo}** đã được thanh toán thành công. Không thể điều chỉnh số tiền hoặc tạo lại mã QR!`,
        ephemeral: true
      });
    }

    const isStaff = await canManageTicket(i, order);
    if (!isStaff) {
      return i.reply({
        content: '⚠️ Chỉ Nhân viên (Staff) hoặc Người bán phụ trách mới có quyền sửa số tiền bill!',
        ephemeral: true
      });
    }

    let snap = {};
    try { snap = JSON.parse(order.planSnapshotJson || '{}'); } catch (_) {}
    snap.adjustedBy = i.user.tag;
    snap.adjustedById = i.user.id;
    if (note) snap.adjustedNote = note;
    snap.adjustedAt = new Date().toISOString();

    await prisma.order.update({
      where: { id: order.id },
      data: {
        amountCents: cleanAmount,
        planSnapshotJson: JSON.stringify(snap)
      }
    });

    // Resolve bank account
    const data = getMenuData();
    const categoryKey = snap.categoryKey;
    const cat = data.categories?.[categoryKey] || {};
    const { seller, accountIndex } = getSellerForCategory(categoryKey);

    const catAccountIdx = (cat.accountIndex !== undefined && cat.accountIndex !== 'all')
      ? parseInt(cat.accountIndex, 10)
      : ((accountIndex !== undefined && accountIndex !== 'all') ? parseInt(accountIndex, 10) : 0);
    let targetAcc = seller?.accounts?.[catAccountIdx];
    if (!targetAcc?.account) {
      targetAcc = seller?.accounts?.find(a => a.account && a.account.trim().length > 0);
    }
    if (!targetAcc?.account && process.env.BANK_ACCOUNT) {
      targetAcc = {
        bank: process.env.BANK_NAME || 'MB Bank',
        account: process.env.BANK_ACCOUNT,
        owner: process.env.BANK_OWNER || data.storeName || '4AM STORE'
      };
    }

    let dynamicQrUrl = null;
    let payosCheckoutUrl = null;
    let payosAccountNumber = targetAcc?.account;
    let payosAccountOwner = targetAcc?.owner || data.storeName || 'VO THANH TINH';
    let payosBankName = targetAcc?.bank || 'BIDV';
    let memo = `4AM ${orderDraftNo}`;

    if (targetAcc?.account && cleanAmount > 0) {
      try {
        const payosRes = await createPayosPayment({
          orderNo: orderDraftNo,
          amount: cleanAmount,
          description: memo,
          items: [{
            name: `Đơn ${orderDraftNo} (NV chỉnh)`,
            quantity: 1,
            price: cleanAmount
          }]
        });
        if (payosRes?.ok) {
          if (payosRes.checkoutUrl) payosCheckoutUrl = payosRes.checkoutUrl;
          if (payosRes.accountNumber) payosAccountNumber = payosRes.accountNumber;
          if (payosRes.accountName) payosAccountOwner = payosRes.accountName;
          if (payosRes.description) memo = payosRes.description;
        }
      } catch (payosErr) {
        console.error('Lỗi khi gọi createPayosPayment (staff):', payosErr.message);
      }

      const bankBin = resolveBankBin(payosBankName);
      dynamicQrUrl = buildVietQrImageUrl({
        bankBin,
        accountNumber: payosAccountNumber,
        amount: cleanAmount,
        description: memo,
        accountName: payosAccountOwner
      });
    }

    const descLines = [
      `Nhân viên <@${i.user.id}> đã điều chỉnh lại số tiền bill đơn hàng:`,
      '',
      `🔢 **Mã đơn:** \`#${orderDraftNo}\``,
      `💵 **Số tiền thanh toán mới:** **${cleanAmount.toLocaleString('vi-VN')} VNĐ**`,
      note ? `📝 **Ghi chú điều chỉnh:** ${note}` : ''
    ];

    if (dynamicQrUrl) {
      descLines.push(
        '',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '💳 **MÃ VIETQR THANH TOÁN TỰ ĐỘNG (PAYOS) - 4AM SHOP**',
        `🏦 **Ngân hàng:** **${payosBankName}**`,
        `🔢 **Số tài khoản:** \`${payosAccountNumber}\``,
        `👤 **Chủ tài khoản:** **${payosAccountOwner}**`,
        `💵 **Số tiền:** **${cleanAmount.toLocaleString('vi-VN')} VNĐ**`,
        `📝 **Nội dung CK:** \`${memo}\``,
        '',
        `⚡ *Quét mã VietQR hoặc bấm nút **[Trang thanh toán PayOS]** để chuyển khoản. Sau khi chuyển xong, bấm **[🔄 Kiểm tra thanh toán]** để hệ thống duyệt đơn ngay!*`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
      );
    }

    const adjustEmbed = new EmbedBuilder()
      .setTitle(`✏️ ĐÃ ĐIỀU CHỈNH BILL: ${cleanAmount.toLocaleString('vi-VN')} VNĐ`)
      .setDescription(descLines.filter(Boolean).join('\n'))
      .setColor(0x3498DB)
      .setTimestamp();

    if (dynamicQrUrl) {
      adjustEmbed.setImage(dynamicQrUrl);
    }

    const hasQuantity = !!snap.quantity || !!snap.unit;
    const ticketActionRow = buildTicketActionRow(orderDraftNo, categoryKey, hasQuantity, payosCheckoutUrl);

    // Delete old QR / selection messages
    await deleteTicketQrMessages(i.channel);

    await i.reply({
      content: `📢 Khách hàng <@${order.user?.discordId}>: Nhân viên <@${i.user.id}> đã cập nhật lại số tiền bill là **${cleanAmount.toLocaleString('vi-VN')} VNĐ**! Mã VietQR thanh toán tự động mới đã sẵn sàng.`,
      embeds: [adjustEmbed],
      components: [ticketActionRow]
    }).catch(async (err) => {
      console.error('Lỗi khi reply modal_staff_set_amount:', err);
      await i.channel.send({
        content: `📢 Khách hàng <@${order.user?.discordId}>: Nhân viên <@${i.user.id}> đã cập nhật lại số tiền bill là **${cleanAmount.toLocaleString('vi-VN')} VNĐ**! Mã VietQR thanh toán tự động mới đã sẵn sàng.`,
        embeds: [adjustEmbed],
        components: [ticketActionRow]
      });
    });

    return;
  }

  // --- PayOS Manual Payment Check Button in Ticket ---
  if (i.isButton() && i.customId.startsWith('check_payos|')) {
    const orderDraftNo = i.customId.split('|')[1];
    await i.deferReply({ ephemeral: true });

    try {
      const order = await prisma.order.findUnique({
        where: { orderNo: orderDraftNo },
        include: { user: true, product: true, ticket: true }
      });

      if (!order) {
        return i.editReply({ content: '❌ Không tìm thấy thông tin đơn hàng này trong hệ thống.' });
      }

      if (order.status === 'PAID' || order.status === 'COMPLETED') {
        return i.editReply({ content: '✅ Đơn hàng này đã được xác nhận thanh toán thành công!' });
      }

      if (!order.providerRef) {
        return i.editReply({ content: 'ℹ️ Đơn hàng chưa có mã giao dịch PayOS. Vui lòng chọn lại gói sản phẩm để hệ thống tạo mã thanh toán mới.' });
      }

      const info = await getPayosPaymentInfo(order.providerRef);
      if (!info) {
        return i.editReply({ content: '⚠️ Chưa thể kết nối tới PayOS để tra cứu giao dịch. Quý khách vui lòng thử lại sau ít giây.' });
      }

      if (info.status === 'PAID') {
        const fullOrder = await prisma.order.findUnique({
          where: { id: order.id },
          include: { user: true, product: true, ticket: true }
        });
        await updateOrderStatus(order.id, 'PAID');
        await prisma.paymentTransaction.create({
          data: {
            transactionId: `PAYOS-BTN-${order.providerRef}-${Date.now()}`,
            orderNo: order.orderNo,
            orderId: order.id,
            amount: info.amount || order.amountCents,
            expectedAmount: order.amountCents,
            receivingAccount: process.env.BANK_ACCOUNT || '8888217932',
            status: 'SUCCESS',
            source: 'PAYOS_CHECK_BUTTON',
            rawPayloadJson: JSON.stringify(info)
          }
        });
        await notifyProcessedPayment(fullOrder || order, {
          transferAmount: info.amount || order.amountCents,
          receivingAccount: process.env.BANK_ACCOUNT || '8888217932',
          transactionId: `PAYOS-${order.providerRef}`,
          rawContent: `PayOS #${order.providerRef}`
        });
        return i.editReply({ content: '🎉 **Thanh toán thành công!** Đơn hàng của bạn đã được hệ thống tự động xác nhận.' });
      }

      return i.editReply({
        content: `⏳ **Trạng thái: Chưa nhận được thanh toán** (${info.status || 'PENDING'}).\n👉 Quý khách vui lòng quét mã VietQR hoặc bấm nút **[💳 Trang thanh toán PayOS]** để chuyển khoản đúng số tiền, sau đó bấm lại nút này nhé!`
      });
    } catch (btnErr) {
      console.error('Lỗi nút check_payos:', btnErr);
      return i.editReply({ content: '⚠️ Đã xảy ra lỗi khi kiểm tra thanh toán. Vui lòng thử lại sau.' });
    }
  }

  // --- Staff Button: Hoàn tất đơn hàng (1-Click trực tiếp trong Ticket) ---
  if (i.isButton() && i.customId.startsWith('staff_complete_order|')) {
    const orderDraftNo = i.customId.split('|')[1];
    await i.deferReply({ ephemeral: true });

    try {
      let order = null;
      if (orderDraftNo) {
        order = await prisma.order.findUnique({
          where: { orderNo: orderDraftNo },
          include: { user: true, product: true, ticket: true }
        });
      }
      if (!order) {
        const ticket = await prisma.ticket.findUnique({
          where: { channelId: i.channel.id },
          include: { order: { include: { user: true, product: true, ticket: true } } }
        });
        order = ticket?.order;
      }

      const isAllowed = await canManageTicket(i, order);
      if (!isAllowed) {
        return i.editReply({
          content: '❌ Chỉ nhân viên (Staff) hoặc Người bán phụ trách đơn hàng mới có quyền bấm Hoàn tất đơn hàng.'
        });
      }

      if (order && order.status === 'COMPLETED') {
        return i.editReply({
          content: 'ℹ️ Đơn hàng này đã được xác nhận hoàn tất trước đó rồi.'
        });
      }

      if (order) {
        await updateOrderStatus(order.id, 'COMPLETED');
        await prisma.auditLog.create({
          data: {
            orderId: order.id,
            actorType: 'DISCORD_STAFF',
            actorId: i.user.id,
            action: 'ORDER_COMPLETED_BY_STAFF',
            beforeJson: JSON.stringify({ status: order.status }),
            afterJson: JSON.stringify({ status: 'COMPLETED' })
          }
        }).catch(() => {});
      }

      // Trao role khách hàng Lucid Customer
      if (order) {
        await grantCustomerRole(i, order).catch(err => console.error('Lỗi cấp role khi hoàn tất đơn:', err));
      }

      // Xóa / ẩn mã QR thanh toán trong ticket nếu còn
      await deleteTicketQrMessages(i.channel, { isPaid: true }).catch(() => {});

      // Lấy thông tin hiển thị embed
      let parsedSnapshot = {};
      try {
        parsedSnapshot = JSON.parse(order?.planSnapshotJson || '{}');
      } catch (_) {}
      const serviceName = parsedSnapshot.categoryLabel || order?.product?.name || parsedSnapshot.selectedItem || 'Dịch vụ';
      const formattedAmount = (order?.amountCents || 0).toLocaleString('vi-VN') + ' ' + (order?.currency || 'VNĐ');
      const storeName = getMenuData().storeName || '4AM STORE';

      const completeEmbed = new EmbedBuilder()
        .setTitle('🔔 CẬP NHẬT ĐƠN HÀNG: 🎉 ĐÃ HOÀN THÀNH & GIAO HÀNG')
        .setDescription([
          `🌟 Đơn hàng **#${order?.orderNo || orderDraftNo}** đã hoàn thành bàn giao bởi <@${i.user.id}>! Cảm ơn bạn đã tin tưởng và ủng hộ **${storeName}**.`,
          '',
          `👉 *Khách hàng vui lòng bấm nút **⭐ Đánh giá dịch vụ** bên dưới để chấm điểm sao và gửi phản hồi giúp shop nhé!*`
        ].join('\n'))
        .addFields(
          { name: '📦 Dịch vụ / Sản phẩm', value: `**${serviceName}**`, inline: true },
          { name: '💰 Số tiền', value: `**${formattedAmount}**`, inline: true },
          { name: '👤 Khách hàng', value: `<@${order?.user?.discordId || (i.channel.name ? i.channel.name.split('-').pop() : 'Khách')}>`, inline: true }
        )
        .setColor(0x0EA5E9)
        .setFooter({ text: '4AM Discord Bot • Hoàn tất trực tiếp trên Discord' })
        .setTimestamp();

      const completeActionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`rate_order|${order?.orderNo || orderDraftNo}`)
          .setLabel('⭐ Đánh giá dịch vụ')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`close_simple_ticket|${order?.orderNo || orderDraftNo}`)
          .setLabel('🔒 Đóng Ticket')
          .setStyle(ButtonStyle.Danger)
      );

      // Cập nhật trạng thái nút trên tin nhắn đầu để vô hiệu hóa nút hoàn tất (tránh click trùng lặp)
      if (i.message?.components?.length) {
        try {
          const updatedRows = i.message.components.map(row => {
            const newRow = ActionRowBuilder.from(row);
            newRow.components.forEach(comp => {
              if (comp.data?.custom_id?.startsWith('staff_complete_order|')) {
                comp.setDisabled(true);
                comp.setLabel('✅ Đã hoàn tất đơn');
              }
            });
            return newRow;
          });
          await i.message.edit({ components: updatedRows }).catch(() => {});
        } catch (_) {}
      }

      // Gửi embed thông báo hoàn thành đơn hàng vào channel ticket kèm nút Đánh giá & Đóng Ticket
      await i.channel.send({ embeds: [completeEmbed], components: [completeActionRow] });

      // Gửi DM cho khách hàng nếu có
      try {
        if (order?.user?.discordId) {
          const customer = await client.users.fetch(order.user.discordId).catch(() => null);
          if (customer) {
            const dmEmbed = new EmbedBuilder()
              .setTitle(`🎉 ĐƠN HÀNG #${order.orderNo} ĐÃ HOÀN THÀNH`)
              .setColor(0x10B981)
              .setDescription([
                `Cảm ơn bạn đã mua hàng tại **${storeName}**!`,
                `Đơn hàng **#${order.orderNo}** (**${serviceName}**) của bạn đã được nhân viên hoàn tất bàn giao.`,
                '',
                `💰 **Số tiền:** **${formattedAmount}**`,
                '',
                'Chúc bạn trải nghiệm dịch vụ vui vẻ! Vui lòng dành chút thời gian vote sao và gửi feedback giúp shop nhé ⭐'
              ].filter(Boolean).join('\n'))
              .setTimestamp();

            const dmRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`rate_order|${order.orderNo}`)
                .setLabel('⭐ Đánh giá dịch vụ & Feedback')
                .setStyle(ButtonStyle.Success)
            );

            await customer.send({ embeds: [dmEmbed], components: [dmRow] }).catch(() => {});
          }
        }
      } catch (_) {}

      return i.editReply({
        content: `✅ Đã hoàn tất đơn hàng **#${order?.orderNo || orderDraftNo}** và gửi thông báo bàn giao thành công!`
      });
    } catch (completeErr) {
      console.error('Lỗi nút staff_complete_order:', completeErr);
      return i.editReply({
        content: '⚠️ Đã xảy ra lỗi khi hoàn tất đơn hàng. Vui lòng thử lại sau.'
      });
    }
  }

  // --- Nút Khách Hàng Đánh Giá Dịch Vụ & Feedback (1-5 sao) ---
  if (i.isButton() && i.customId.startsWith('rate_order|')) {
    const orderNo = i.customId.split('|')[1];
    let order = null;
    if (orderNo) {
      order = await prisma.order.findUnique({
        where: { orderNo },
        include: { user: true, product: true, ticket: true }
      });
    }
    if (!order && i.channel?.id) {
      const ticket = await prisma.ticket.findUnique({
        where: { channelId: i.channel.id },
        include: { order: { include: { user: true, product: true } } }
      });
      order = ticket?.order;
    }

    // Kiểm tra quyền: Chỉ khách hàng sở hữu đơn mới có quyền gửi đánh giá
    const customerDiscordId = order?.user?.discordId;
    if (customerDiscordId && customerDiscordId !== i.user.id) {
      return i.reply({
        content: `❌ Chỉ khách hàng sở hữu đơn hàng này (<@${customerDiscordId}>) mới có quyền gửi đánh giá dịch vụ.`,
        ephemeral: true
      });
    }

    // Kiểm tra xem đơn đã được đánh giá trước đó chưa
    if (order) {
      let snap = {};
      try { snap = JSON.parse(order.planSnapshotJson || '{}'); } catch (_) {}
      const existingFeedback = await prisma.auditLog.findFirst({
        where: {
          orderId: order.id,
          action: 'CUSTOMER_FEEDBACK'
        }
      });
      if (snap.review || existingFeedback) {
        return i.reply({
          content: `ℹ️ Bạn đã gửi đánh giá cho đơn hàng **#${order.orderNo}** rồi (${snap.review?.stars || 5}⭐). Cảm ơn sự ủng hộ của bạn! 💖`,
          ephemeral: true
        });
      }
    }

    const modal = new ModalBuilder()
      .setCustomId(`modal_rate_order|${order?.orderNo || orderNo}`)
      .setTitle('⭐ Đánh Giá & Góp Ý Dịch Vụ');

    const starsInput = new TextInputBuilder()
      .setCustomId('rating_stars')
      .setLabel('Số sao hài lòng (nhập từ 1 đến 5 sao)')
      .setStyle(TextInputStyle.Short)
      .setValue('5')
      .setPlaceholder('Nhập số từ 1 đến 5 (mặc định 5 ⭐)')
      .setMinLength(1)
      .setMaxLength(1)
      .setRequired(true);

    const commentInput = new TextInputBuilder()
      .setCustomId('feedback_comment')
      .setLabel('Lời nhận xét / Feedback của bạn')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Chia sẻ cảm nhận về dịch vụ, tốc độ hỗ trợ hoặc trải nghiệm mua hàng...')
      .setMaxLength(1000)
      .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder().addComponents(starsInput),
      new ActionRowBuilder().addComponents(commentInput)
    );

    return i.showModal(modal);
  }

  // --- Modal Submit: Gửi đánh giá dịch vụ & Feedback từ Khách hàng ---
  if (i.isModalSubmit() && i.customId.startsWith('modal_rate_order|')) {
    const orderNo = i.customId.split('|')[1];
    await i.deferReply({ ephemeral: true });

    try {
      let order = null;
      if (orderNo) {
        order = await prisma.order.findUnique({
          where: { orderNo },
          include: { user: true, product: true }
        });
      }
      if (!order && i.channel?.id) {
        const ticket = await prisma.ticket.findUnique({
          where: { channelId: i.channel.id },
          include: { order: { include: { user: true, product: true } } }
        });
        order = ticket?.order;
      }

      const rawStars = i.fields.getTextInputValue('rating_stars')?.trim() || '5';
      let stars = parseInt(rawStars, 10);
      if (isNaN(stars) || stars < 1) stars = 5;
      if (stars > 5) stars = 5;

      let comment = i.fields.getTextInputValue('feedback_comment')?.trim() || '';
      if (!comment) {
        comment = stars === 5 ? 'Dịch vụ uy tín, giao dịch nhanh chóng và nhiệt tình! ⭐⭐⭐⭐⭐' : 'Giao dịch hoàn tất thành công.';
      }

      // Lưu review vào database
      if (order) {
        let snap = {};
        try { snap = JSON.parse(order.planSnapshotJson || '{}'); } catch (_) {}
        snap.review = {
          stars,
          comment,
          reviewerId: i.user.id,
          reviewerTag: i.user.tag,
          reviewedAt: new Date().toISOString()
        };

        await prisma.order.update({
          where: { id: order.id },
          data: { planSnapshotJson: JSON.stringify(snap) }
        }).catch(() => {});

        await prisma.auditLog.create({
          data: {
            orderId: order.id,
            actorType: 'CUSTOMER',
            actorId: i.user.id,
            action: 'CUSTOMER_FEEDBACK',
            metadataJson: JSON.stringify({
              stars,
              comment,
              reviewerTag: i.user.tag,
              reviewedAt: new Date().toISOString()
            })
          }
        }).catch(() => {});
      }

      const starEmojis = '⭐'.repeat(stars) + (stars < 5 ? '☆'.repeat(5 - stars) : '');
      let parsedSnapshot = {};
      try { parsedSnapshot = JSON.parse(order?.planSnapshotJson || '{}'); } catch (_) {}
      const serviceName = parsedSnapshot.categoryLabel || order?.product?.name || parsedSnapshot.selectedItem || 'Dịch vụ';
      const formattedAmount = (order?.amountCents || 0).toLocaleString('vi-VN') + ' ' + (order?.currency || 'VNĐ');
      const storeName = getMenuData().storeName || '4AM STORE';
      const logoUrl = getMenuData().logoUrl || undefined;

      const feedbackChannelId = process.env.FEEDBACK_CHANNEL_ID || getMenuData().channels?.feedbackChannelId || '1417357717122715668';

      // Tạo embed feedback xịn sò đăng lên kênh feedback công khai
      const feedbackEmbed = new EmbedBuilder()
        .setAuthor({
          name: `${i.user.globalName || i.user.username} (${i.user.tag})`,
          iconURL: i.user.displayAvatarURL({ dynamic: true })
        })
        .setTitle(`🌟 ĐÁNH GIÁ DỊCH VỤ • #${order?.orderNo || orderNo}`)
        .setDescription([
          `> *“${comment}”*`,
          '',
          `⭐ **Đánh giá:** **${starEmojis}** (${stars}/5 sao)`,
          `📦 **Sản phẩm:** **${serviceName}**`,
          `💰 **Giá trị đơn:** **${formattedAmount}**`,
          `👤 **Khách hàng:** <@${i.user.id}>`
        ].join('\n'))
        .setColor(stars >= 4 ? 0xF59E0B : 0x0EA5E9)
        .setThumbnail(i.user.displayAvatarURL({ dynamic: true, size: 256 }))
        .setFooter({
          text: `${storeName} • Khách hàng đánh giá uy tín`,
          iconURL: logoUrl
        })
        .setTimestamp();

      // Gửi vào kênh feedback
      try {
        const feedbackChannel = client.channels.cache.get(feedbackChannelId) || await client.channels.fetch(feedbackChannelId).catch(() => null);
        if (feedbackChannel && feedbackChannel.isTextBased()) {
          await feedbackChannel.send({ embeds: [feedbackEmbed] });
        }
      } catch (fErr) {
        console.error('Lỗi khi gửi vào kênh feedback:', fErr);
      }

      // Nếu thao tác trong channel ticket: Gửi tin nhắn cảm ơn công khai vào ticket & kích hoạt tự động đóng sau 20s
      let targetTicketChannel = null;
      if (i.guild && i.channel && i.channel.id !== feedbackChannelId && i.channel.type !== ChannelType.DM) {
        targetTicketChannel = i.channel;
      } else if (order?.ticket?.channelId) {
        targetTicketChannel = client.channels.cache.get(order.ticket.channelId) || await client.channels.fetch(order.ticket.channelId).catch(() => null);
      }

      if (targetTicketChannel && targetTicketChannel.isTextBased()) {
        const ticketThanksEmbed = new EmbedBuilder()
          .setTitle('💖 CẢM ƠN QUÝ KHÁCH ĐÃ ĐÁNH GIÁ!')
          .setDescription([
            `<@${i.user.id}> vừa gửi đánh giá **${starEmojis}** (${stars}/5 sao):`,
            `> *“${comment}”*`,
            '',
            `✨ Đánh giá của bạn đã được đăng tại kênh <#${feedbackChannelId}>.`,
            `Cảm ơn bạn đã tin tưởng ủng hộ **${storeName}**!`
          ].join('\n'))
          .setColor(0x10B981)
          .setTimestamp();

        await targetTicketChannel.send({ embeds: [ticketThanksEmbed] }).catch(() => {});

        // Thiết lập cơ chế tự động đếm ngược 20 giây đóng ticket
        const closeUnixTime = Math.floor(Date.now() / 1000) + 20;
        const autoCloseEmbed = new EmbedBuilder()
          .setTitle('⏱️ TỰ ĐỘNG ĐÓNG TICKET SAU 20 GIÂY')
          .setDescription([
            `🔒 Kênh ticket này sẽ tự động đóng và xóa sau **20 giây** (vào lúc <t:${closeUnixTime}:R>).`,
            '',
            `👉 *Nếu cần hỗ trợ thêm hoặc muốn giữ ticket, hãy bấm **[❌ Hủy đóng tự động]** bên dưới nhé!*`
          ].join('\n'))
          .setColor(0xF59E0B)
          .setTimestamp();

        const autoCloseRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`cancel_auto_close|${order?.orderNo || orderNo}`)
            .setLabel('❌ Hủy đóng tự động')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(`close_simple_ticket|${order?.orderNo || orderNo}`)
            .setLabel('🔒 Đóng ngay')
            .setStyle(ButtonStyle.Danger)
        );

        const autoCloseMsg = await targetTicketChannel.send({
          embeds: [autoCloseEmbed],
          components: [autoCloseRow]
        }).catch(() => null);

        // Hủy timer cũ nếu có trên channel này
        if (autoCloseTimers.has(targetTicketChannel.id)) {
          clearTimeout(autoCloseTimers.get(targetTicketChannel.id).timer);
          autoCloseTimers.delete(targetTicketChannel.id);
        }

        const timer = setTimeout(async () => {
          autoCloseTimers.delete(targetTicketChannel.id);
          try {
            await prisma.ticket.updateMany({
              where: { channelId: targetTicketChannel.id },
              data: { status: 'CLOSED' }
            }).catch(() => {});

            const finalCloseEmbed = new EmbedBuilder()
              .setTitle('🔒 TICKET ĐÃ HOÀN TẤT & ĐÓNG TỰ ĐỘNG')
              .setDescription('Ticket đã tự động đóng sau khi hoàn tất đánh giá dịch vụ. Kênh sẽ xóa sau 3 giây...')
              .setColor(0x10B981)
              .setTimestamp();

            await targetTicketChannel.send({ embeds: [finalCloseEmbed] }).catch(() => {});

            setTimeout(() => {
              targetTicketChannel.delete().catch(() => {});
            }, 3000);
          } catch (delErr) {
            console.error('Lỗi khi tự động xóa kênh ticket sau 20s:', delErr);
          }
        }, 20000);

        autoCloseTimers.set(targetTicketChannel.id, {
          timer,
          messageId: autoCloseMsg?.id,
          orderNo: order?.orderNo || orderNo
        });
      }

      // Cập nhật nút trong tin nhắn hoàn tất để hiển thị trạng thái đã đánh giá
      if (i.message?.components?.length) {
        try {
          const updatedRows = i.message.components.map(row => {
            const newRow = ActionRowBuilder.from(row);
            newRow.components.forEach(comp => {
              if (comp.data?.custom_id?.startsWith('rate_order|')) {
                comp.setDisabled(true);
                comp.setLabel(`✅ Đã đánh giá (${stars}⭐)`);
                comp.setStyle(ButtonStyle.Secondary);
              }
            });
            return newRow;
          });
          await i.message.edit({ components: updatedRows }).catch(() => {});
        } catch (_) {}
      }

      return i.editReply({
        content: `🎉 **Cảm ơn bạn rất nhiều!** Đánh giá **${stars} sao** của bạn đã được ghi nhận và đăng tải lên kênh <#${feedbackChannelId}>.\n⏱️ *Kênh ticket sẽ tự động đóng sau 20 giây (bạn có thể bấm "Hủy đóng tự động" tại ticket nếu muốn tiếp tục trao đổi).* 💖`
      });
    } catch (err) {
      console.error('Lỗi khi xử lý modal_rate_order:', err);
      return i.editReply({
        content: '⚠️ Đã xảy ra lỗi khi lưu đánh giá. Vui lòng thử lại sau.'
      });
    }
  }

  // --- Nút Hủy Tự Động Đóng Ticket ---
  if (i.isButton() && i.customId.startsWith('cancel_auto_close|')) {
    const channelId = i.channel.id;
    const timerData = autoCloseTimers.get(channelId);

    if (timerData) {
      clearTimeout(timerData.timer);
      autoCloseTimers.delete(channelId);

      // Cập nhật lại tin nhắn đếm ngược để vô hiệu hóa nút bấm
      if (i.message?.components?.length) {
        try {
          const updatedRows = i.message.components.map(row => {
            const newRow = ActionRowBuilder.from(row);
            newRow.components.forEach(comp => {
              if (comp.data?.custom_id?.startsWith('cancel_auto_close|')) {
                comp.setDisabled(true);
                comp.setLabel('✅ Đã hủy đóng tự động');
                comp.setStyle(ButtonStyle.Success);
              }
            });
            return newRow;
          });
          await i.message.edit({ components: updatedRows }).catch(() => {});
        } catch (_) {}
      }

      const cancelledEmbed = new EmbedBuilder()
        .setTitle('⏹️ ĐÃ HỦY TỰ ĐỘNG ĐÓNG TICKET')
        .setDescription(`Quy trình tự động đóng ticket đã được hủy bởi <@${i.user.id}>.\nKênh ticket sẽ được giữ nguyên để tiếp tục trao đổi. Khi nào hoàn tất, bạn có thể bấm **🔒 Đóng Ticket** bất cứ lúc nào!`)
        .setColor(0x3B82F6)
        .setTimestamp();

      return i.reply({ embeds: [cancelledEmbed] });
    } else {
      return i.reply({
        content: 'ℹ️ Không có quy trình tự động đóng ticket nào đang chạy hoặc quy trình đã được hủy trước đó.',
        ephemeral: true
      });
    }
  }

  // --- Unified Close Ticket & Cancel Order (1-Click: Đóng ticket = Hủy đơn hàng) ---
  if (i.isButton() && (
    i.customId.startsWith('close_simple_ticket') ||
    i.customId.startsWith('close_ticket_cancel|') ||
    i.customId.startsWith('quick_staff_cancel|') ||
    i.customId.startsWith('customer_confirm_close|') ||
    i.customId.startsWith('resolve_just_close|')
  )) {
    // Hủy timer tự động đóng nếu đang chạy trên channel này
    if (autoCloseTimers.has(i.channel.id)) {
      clearTimeout(autoCloseTimers.get(i.channel.id).timer);
      autoCloseTimers.delete(i.channel.id);
    }
    let orderNo = i.customId.includes('|') ? i.customId.split('|')[1] : null;
    let order = null;
    if (orderNo) {
      order = await prisma.order.findUnique({
        where: { orderNo },
        include: { user: true, product: true, ticket: true }
      });
    }
    if (!order) {
      const ticket = await prisma.ticket.findUnique({
        where: { channelId: i.channel.id },
        include: { order: true }
      });
      order = ticket?.order;
      if (order && !orderNo) orderNo = order.orderNo;
    }

    if (order) {
      const isStaff = await canManageTicket(i, order);
      const isCustomer = order.user?.discordId === i.user.id;
      if (!isStaff && !isCustomer) {
        return i.reply({
          content: '⚠️ Chỉ người tạo ticket hoặc Nhân viên (Staff) mới có quyền đóng ticket này!',
          ephemeral: true
        });
      }

      // If order is still pending/unsettled: mark CANCELLED (Đóng ticket = Hủy đơn)
      if (order.status !== 'COMPLETED' && order.status !== 'PAID') {
        let snap = {};
        try { snap = JSON.parse(order.planSnapshotJson || '{}'); } catch (_) {}
        snap.cancelledBy = i.user.tag;
        snap.cancelledById = i.user.id;
        snap.cancelledReason = 'Đóng ticket / Hủy đơn hàng';
        snap.cancelledAt = new Date().toISOString();

        await prisma.order.update({
          where: { id: order.id },
          data: {
            status: 'CANCELLED',
            planSnapshotJson: JSON.stringify(snap)
          }
        });
      }
    }

    await prisma.ticket.updateMany({
      where: { channelId: i.channel.id },
      data: { status: 'CLOSED' }
    });

    const isAlreadyDone = order && (order.status === 'COMPLETED' || order.status === 'PAID');
    const closeEmbed = new EmbedBuilder()
      .setTitle(isAlreadyDone ? '🔒 TICKET ĐÃ HOÀN TẤT' : '🔒 ĐÃ ĐÓNG TICKET & HỦY ĐƠN HÀNG')
      .setColor(isAlreadyDone ? 0x10B981 : 0xEF4444)
      .setDescription([
        `Ticket đã được đóng bởi <@${i.user.id}>.`,
        (!isAlreadyDone && orderNo) ? `⚠️ Đơn hàng **#${orderNo}** đã được cập nhật thành **ĐÃ HỦY** trên hệ thống.` : '',
        '',
        `🔒 **Kênh ticket sẽ tự động đóng và xóa trong 3 giây...**`
      ].filter(Boolean).join('\n'))
      .setFooter({ text: '4AM STORE • Quản lý tự động' })
      .setTimestamp();

    await i.reply({ embeds: [closeEmbed] });

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
        if (!process.env.BANK_NAME || !process.env.BANK_ACCOUNT || !process.env.BANK_OWNER) {
          return i.reply({ content: '⚠️ Shop chưa cấu hình đầy đủ thông tin ngân hàng nên chưa thể tạo đơn thanh toán. Vui lòng liên hệ owner.', ephemeral: true });
        }
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
        const bankName = process.env.BANK_NAME;
        const bankAccount = process.env.BANK_ACCOUNT;
        const bankOwner = process.env.BANK_OWNER;
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

if (i.isChatInputCommand() && i.commandName === 'autoresponse') {
  const sub = i.options.getSubcommand();

  if (sub === 'add') {
    const trigger = i.options.getString('trigger', true);
    const response = i.options.getString('response', true);
    const image = i.options.getString('image') || '';
    const matchType = i.options.getString('match_type') || 'exact';

    const entry = addOrUpdateAutoResponse({
      trigger,
      response,
      imageUrl: image,
      matchType,
      replyMode: 'reply'
    });

    const embed = new EmbedBuilder()
      .setTitle('✅ ĐÃ LƯU PHẢN HỒI TỰ ĐỘNG')
      .setColor(0x10B981)
      .addFields(
        { name: '🎯 Từ khóa kích hoạt', value: `\`${entry.trigger}\``, inline: true },
        { name: '🔍 Kiểu so khớp', value: entry.matchType === 'contains' ? 'Có chứa từ khóa' : 'Khớp chính xác', inline: true },
        { name: '💬 Nội dung phản hồi', value: entry.response || '*(Không có văn bản)*' },
        { name: '🖼️ Ảnh / GIF đính kèm', value: entry.imageUrl ? `[Xem ảnh](${entry.imageUrl})` : '*(Không có)*' }
      )
      .setFooter({ text: '4AM Auto Response' })
      .setTimestamp();

    if (entry.imageUrl && /^https?:\/\//i.test(entry.imageUrl)) {
      embed.setImage(entry.imageUrl);
    }

    return i.reply({ embeds: [embed] });
  }

  if (sub === 'list') {
    const list = getAutoResponses();
    if (!list.length) {
      return i.reply({
        content: 'ℹ️ Hiện tại chưa có phản hồi tự động nào được cấu hình.',
        ephemeral: true
      });
    }

    const embed = new EmbedBuilder()
      .setTitle('📋 DANH SÁCH AUTO RESPONSE (TỰ ĐỘNG TRẢ LỜI)')
      .setColor(0x5865F2)
      .setDescription(
        list.map((item, idx) => {
          const typeBadge = item.matchType === 'contains' ? '`[Chứa]`' : '`[Chính xác]`';
          const imgBadge = item.imageUrl ? '🖼️' : '';
          return `**${idx + 1}.** \`${item.trigger}\` ${typeBadge} ${imgBadge}\n> ${item.response ? item.response.slice(0, 150) : '*(Chỉ ảnh)*'}${item.imageUrl ? `\n> 🔗 *Ảnh:* ${item.imageUrl}` : ''}`;
        }).join('\n\n')
      )
      .setFooter({ text: `Tổng cộng: ${list.length} phản hồi tự động` })
      .setTimestamp();

    return i.reply({ embeds: [embed] });
  }

  if (sub === 'delete') {
    const trigger = i.options.getString('trigger', true);
    const ok = deleteAutoResponse(trigger);
    if (ok) {
      return i.reply({
        content: `✅ Đã xóa phản hồi tự động cho từ khóa \`${trigger}\` thành công!`
      });
    } else {
      return i.reply({
        content: `⚠️ Không tìm thấy phản hồi tự động nào khớp với từ khóa \`${trigger}\`.`,
        ephemeral: true
      });
    }
  }
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
    await prisma.auditLog.create({ data: {
      orderId, actorType: 'DISCORD_STAFF', actorId: i.user.id, action: 'PAYMENT_REJECTED',
      beforeJson: JSON.stringify({ status: order.status }), afterJson: JSON.stringify({ status: 'FAILED' })
    }});
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
  await prisma.auditLog.create({ data: {
    orderId, actorType: 'DISCORD_STAFF', actorId: i.user.id, action: 'PAYMENT_MANUALLY_APPROVED',
    beforeJson: JSON.stringify({ status: order.status }), afterJson: JSON.stringify({ status: 'PAID' })
  }});
  await upsertSubscriptionForPaidOrder(orderId);
  
  await adminLog(
    `✅ Đã duyệt thanh toán cho Đơn hàng **#${order.orderNo}** bởi <@${i.user.id}>`,
    staffActionEmbed({
      title: 'Duyệt thanh toán thành công',
      actorId: i.user.username,
      details: `Đơn #${order.orderNo}\nKhách: <@${order.user?.discordId || 'unknown'}>\nSố tiền: ${formatPrice(order.amountCents, order.currency)}`
    })
  );
  await deleteTicketQrMessages(i.channel, { isPaid: true });
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
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.resolve(__dirname, '../public')));

// Dashboard identities are separate from seller payout details in menuData.json.
const scryptAsync = promisify(crypto.scrypt);
const dashboardUsersFile = path.resolve(__dirname, '../.dashboard-users.json');
const dashboardSessions = new Map();
const loginAttempts = new Map();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const ALLOWED_SELLER_PERMISSIONS = ['orders.read', 'orders.complete_own', 'orders.edit', 'products.edit', 'autoresponse'];

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

async function verifyAdminPassword(password) {
  const storedHash = process.env.ADMIN_PASSWORD_HASH;
  if (storedHash) {
    const [salt, hash] = storedHash.split(':');
    return verifyDashboardPassword(password, { salt, hash });
  }
  const legacy = process.env.ADMIN_PASSWORD;
  if (!legacy) return false;
  const expected = Buffer.from(legacy);
  const actual = Buffer.from(password);
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
  if (username.toLowerCase() === 'admin' && await verifyAdminPassword(password)) {
    identity = { id: 'admin', username: 'admin', role: 'admin', sellerKey: null, permissions: ['*'] };
  } else {
    const user = readDashboardUsers().find(item => item.username.toLowerCase() === username.toLowerCase());
    if (user?.enabled && await verifyDashboardPassword(password, user.password)) {
      const perms = Array.isArray(user.permissions) ? [...user.permissions] : ['orders.read'];
      if (!perms.includes('autoresponse')) perms.push('autoresponse');
      identity = { id: user.username, username: user.username, role: 'seller', sellerKey: user.sellerKey, permissions: perms };
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
  let session = dashboardSessions.get(token);

  // TẠM THỜI TẮT CHECK ADMIN: Tự động cấp quyền Admin để truy cập và thao tác tự do
  if (!session || session.expiresAt <= Date.now()) {
    session = {
      username: 'admin',
      role: 'admin',
      sellerKey: null,
      permissions: ['*'],
      expiresAt: Date.now() + 86400000
    };
  } else if (session.role === 'seller') {
    const user = readDashboardUsers().find(item => item.username === session.username && item.enabled);
    if (user) {
      const perms = Array.isArray(user.permissions) ? [...user.permissions] : ['orders.read'];
      if (!perms.includes('autoresponse')) perms.push('autoresponse');
      session.permissions = perms;
      session.sellerKey = user.sellerKey;
    }
  }

  req.dashboardUser = session;
  req.dashboardToken = token || 'bypass_token';
  return next();
}

function requireAdminAuth(req, res, next) {
  // Tạm thời tắt check admin: Cho phép tất cả thao tác
  return requireAuth(req, res, () => next());
}

function requirePermission(permission) {
  // Tạm thời tắt check quyền: Cho phép tất cả thao tác
  return (req, res, next) => requireAuth(req, res, () => next());
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

// Auto-responses API
app.get('/api/auto-responses', requireAuth, (_req, res) => {
  return res.json({ ok: true, data: getAutoResponses() });
});

app.post('/api/auto-responses', requireAuth, (req, res) => {
  try {
    const { id, trigger, response, imageUrl, matchType, replyMode } = req.body || {};
    if (!trigger) return res.status(400).json({ ok: false, error: 'Từ khóa (trigger) không được để trống.' });
    const entry = addOrUpdateAutoResponse({ id, trigger, response, imageUrl, matchType, replyMode });
    return res.json({ ok: true, data: entry });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/auto-responses/:id', requireAuth, (req, res) => {
  const ok = deleteAutoResponse(req.params.id);
  return res.json({ ok, message: ok ? 'Đã xóa phản hồi tự động.' : 'Không tìm thấy phản hồi tự động.' });
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
      ping: client.ws?.ping || 0,
      mode: dashboardOnlyMode ? 'dashboard-only' : uiTestMode ? 'ui-test' : 'full'
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
        botInfo
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
const ORDER_STATUSES = new Set(['PENDING', 'PAID', 'PROCESSING', 'DELIVERED', 'COMPLETED', 'FAILED', 'CANCELLED']);
const ORDER_TRANSITIONS = {
  PENDING: new Set(['PAID', 'FAILED', 'CANCELLED']),
  PAID: new Set(['PROCESSING', 'DELIVERED', 'COMPLETED', 'CANCELLED']),
  PROCESSING: new Set(['DELIVERED', 'COMPLETED']),
  DELIVERED: new Set(['COMPLETED']),
  FAILED: new Set(['PENDING', 'CANCELLED']),
  CANCELLED: new Set(['PENDING']),
  COMPLETED: new Set([])
};

function validateOrderTransition(from, to) {
  if (!ORDER_STATUSES.has(to)) return `Trạng thái không hợp lệ: ${to}`;
  if (from === to) return null;
  if (!ORDER_TRANSITIONS[from]?.has(to)) return `Không thể chuyển trạng thái từ ${from} sang ${to}.`;
  return null;
}

async function writeOrderAudit({ orderId, user, action, before, after, metadata }) {
  await prisma.auditLog.create({ data: {
    orderId,
    actorType: user?.role === 'seller' ? 'SELLER' : 'ADMIN',
    actorId: user?.username || 'unknown',
    action,
    beforeJson: before ? JSON.stringify(before) : null,
    afterJson: after ? JSON.stringify(after) : null,
    metadataJson: metadata ? JSON.stringify(metadata) : null
  }});
}

function parseStoredJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || ''); } catch (_) { return fallback; }
}

async function withTransactionHandledState(transactions) {
  if (!transactions.length) return transactions;
  const logs = await prisma.auditLog.findMany({
    where: { action: 'TRANSACTION_HANDLED_CHANGED' },
    orderBy: { createdAt: 'desc' },
    take: 1000
  });
  const handledById = new Map();
  for (const log of logs) {
    const metadata = parseStoredJson(log.metadataJson);
    const transactionKey = metadata.transactionRecordId || metadata.transactionId;
    if (!transactionKey || handledById.has(String(transactionKey))) continue;
    handledById.set(String(transactionKey), !!parseStoredJson(log.afterJson).handled);
  }
  return transactions.map(transaction => ({
    ...transaction,
    handled: handledById.has(String(transaction.id))
      ? handledById.get(String(transaction.id))
      : handledById.has(String(transaction.transactionId))
        ? handledById.get(String(transaction.transactionId))
        : ['SUCCESS', 'MATCHED', 'PAID'].includes(transaction.status)
  }));
}

app.get('/api/payment-transactions', requireAdminAuth, async (req, res) => {
  const status = req.query.status ? String(req.query.status) : undefined;
  const transactions = await prisma.paymentTransaction.findMany({
    where: status ? { status } : undefined,
    orderBy: { processedAt: 'desc' },
    take: 200,
    include: { order: { select: { orderNo: true, status: true, amountCents: true, currency: true } } }
  });
  res.json({ ok: true, transactions: await withTransactionHandledState(transactions) });
});

app.post('/api/payment-transactions/:id/handled', requireAdminAuth, async (req, res) => {
  try {
    if (typeof req.body?.handled !== 'boolean') return res.status(400).json({ ok: false, error: 'Thiếu trạng thái xử lý giao dịch.' });
    const transaction = await prisma.paymentTransaction.findUnique({
      where: { id: req.params.id },
      include: { order: { select: { orderNo: true, status: true, amountCents: true, currency: true } } }
    });
    if (!transaction) return res.status(404).json({ ok: false, error: 'Không tìm thấy giao dịch.' });
    const [current] = await withTransactionHandledState([transaction]);
    await writeOrderAudit({
      orderId: transaction.orderId,
      user: req.dashboardUser,
      action: 'TRANSACTION_HANDLED_CHANGED',
      before: { handled: current.handled },
      after: { handled: req.body.handled },
      metadata: { transactionRecordId: transaction.id, transactionId: transaction.transactionId, reason: String(req.body.reason || '').trim() }
    });
    return res.json({ ok: true, transaction: { ...transaction, handled: req.body.handled } });
  } catch (err) {
    console.error('Lỗi cập nhật trạng thái xử lý giao dịch:', err);
    return res.status(500).json({ ok: false, error: 'Không thể cập nhật giao dịch.' });
  }
});

app.post('/api/payment-transactions/:id/attach', requireAdminAuth, async (req, res) => {
  try {
    const orderId = String(req.body?.orderId || '').trim();
    if (!orderId) return res.status(400).json({ ok: false, error: 'Thiếu đơn hàng cần gắn.' });
    const transaction = await prisma.paymentTransaction.findUnique({ where: { id: req.params.id } });
    if (!transaction) return res.status(404).json({ ok: false, error: 'Không tìm thấy giao dịch.' });
    const order = await prisma.order.findFirst({
      where: { OR: [{ id: orderId }, { orderNo: orderId }] },
      include: { ticket: true, user: true }
    });
    if (!order) return res.status(404).json({ ok: false, error: 'Không tìm thấy đơn hàng.' });

    const transactionStatus = transaction.amount === order.amountCents ? 'SUCCESS' : 'AMOUNT_MISMATCH';
    const updated = await prisma.$transaction(async tx => {
      const attached = await tx.paymentTransaction.update({
        where: { id: transaction.id },
        data: { orderId: order.id, orderNo: order.orderNo, expectedAmount: order.amountCents, status: transactionStatus },
        include: { order: { select: { orderNo: true, status: true, amountCents: true, currency: true } } }
      });
      if (transactionStatus === 'SUCCESS' && order.status === 'PENDING') {
        await tx.order.update({
          where: { id: order.id },
          data: { status: 'PAID', paymentProvider: 'MANUAL_RECONCILIATION', providerRef: `TX_${transaction.transactionId}` }
        });
      }
      return attached;
    });
    await writeOrderAudit({
      orderId: order.id,
      user: req.dashboardUser,
      action: 'TRANSACTION_ATTACHED',
      before: { orderId: transaction.orderId, orderNo: transaction.orderNo, expectedAmount: transaction.expectedAmount, status: transaction.status },
      after: { orderId: order.id, orderNo: order.orderNo, expectedAmount: order.amountCents, status: transactionStatus },
      metadata: { transactionRecordId: transaction.id, transactionId: transaction.transactionId, reason: String(req.body.reason || '').trim() }
    });

    if (transactionStatus === 'SUCCESS' && order.ticket?.channelId && client.isReady()) {
      try {
        const ticketChannel = await client.channels.fetch(order.ticket.channelId).catch(() => null);
        if (ticketChannel?.isTextBased()) {
          await deleteTicketQrMessages(ticketChannel, { isPaid: true });
          await sendTicketPaymentNotification(ticketChannel, {
            transferAmount: transaction.amount,
            rawContent: `Đối soát thủ công: ${transaction.transactionId}`,
            transactionId: transaction.transactionId,
            matchedOrder: order,
            receivingAccount: transaction.receivingAccount || ''
          });
        }
      } catch (_) {}
    }

    return res.json({ ok: true, transaction: { ...updated, handled: transactionStatus === 'SUCCESS' } });
  } catch (err) {
    console.error('Lỗi gắn giao dịch vào đơn:', err);
    return res.status(500).json({ ok: false, error: 'Không thể gắn giao dịch vào đơn.' });
  }
});

app.get('/api/audit-logs', requireAdminAuth, async (_req, res) => {
  const logs = await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 500 });
  res.json({ ok: true, logs });
});

// Get all orders with metrics & live Discord info
app.get('/api/orders', requirePermission('orders.read'), async (req, res) => {
  try {
    let rawOrders = await prisma.order.findMany({
      where: { archivedAt: null },
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
        let isChannelOpen = o.ticket.status === 'OPEN';
        let chName = null;
        if (client.isReady() && o.ticket.channelId) {
          const ch = client.channels.cache.get(o.ticket.channelId);
          isChannelOpen = !!ch;
          if (ch) {
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
    const existing = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { ticket: true }
    });
    if (!existing) return res.status(404).json({ ok: false, error: 'Không tìm thấy đơn hàng.' });
    const sellerKey = req.dashboardUser.sellerKey;
    const seller = getMenuData().sellers?.[sellerKey];
    const discordId = seller?.discordId || (/^\d{17,20}$/.test(sellerKey) ? sellerKey : null);
    let snapshot = {};
    try { snapshot = JSON.parse(existing.planSnapshotJson || '{}'); } catch (_) {}
    if (snapshot.sellerId !== sellerKey && (!discordId || snapshot.sellerId !== discordId)) {
      return res.status(404).json({ ok: false, error: 'Không tìm thấy đơn hàng được giao cho tài khoản này.' });
    }
    const action = String(req.body?.action || 'complete');
    if (!['start', 'complete'].includes(action)) return res.status(400).json({ ok: false, error: 'Thao tác seller không hợp lệ.' });
    if (action === 'start' && existing.status !== 'PAID') {
      return res.status(409).json({ ok: false, error: 'Chỉ có thể bắt đầu xử lý đơn đã được xác nhận thanh toán.' });
    }
    if (action === 'complete' && !['PAID', 'PROCESSING'].includes(existing.status)) {
      return res.status(409).json({ ok: false, error: 'Chỉ có thể hoàn tất đơn đã thanh toán hoặc đang xử lý.' });
    }
    const nextStatus = action === 'start' ? 'PROCESSING' : 'COMPLETED';
    const updated = await updateOrderStatus(existing.id, nextStatus, 'DASHBOARD_SELLER', `${action.toUpperCase()}_BY_${req.dashboardUser.username}`);
    await writeOrderAudit({
      orderId: existing.id,
      user: req.dashboardUser,
      action: action === 'start' ? 'ORDER_STATUS_CHANGED' : 'ORDER_COMPLETED_BY_SELLER',
      before: { status: existing.status },
      after: { status: updated.status },
      metadata: { workflowAction: action }
    });

    if (existing.ticket?.channelId && client.isReady()) {
      try {
        const ticketChannel = await client.channels.fetch(existing.ticket.channelId).catch(() => null);
        if (ticketChannel?.isTextBased()) {
          await deleteTicketQrMessages(ticketChannel, { isPaid: true });
        }
      } catch (_) {}
    }
    return res.json({ ok: true, order: updated, message: action === 'start' ? `Đã bắt đầu xử lý đơn #${existing.orderNo}.` : `Đã hoàn tất đơn #${existing.orderNo}.` });
  } catch (err) {
    console.error('Lỗi seller hoàn tất đơn:', err);
    return res.status(500).json({ ok: false, error: 'Không thể cập nhật đơn hàng.' });
  }
});

// Rate-limit & deduplication cache for Discord order notifications (prevents duplicate spam on rapid clicks)
const orderStatusNotifyCache = new Map(); // key: `${orderId}:${status}` -> timestamp

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
    const transitionError = validateOrderTransition(existing.status, status);
    if (transitionError) return res.status(409).json({ ok: false, error: transitionError });
    if (req.dashboardUser.role === 'seller') {
      return res.status(403).json({ ok: false, error: 'Seller không được xác nhận thanh toán hoặc đổi trạng thái trực tiếp. Hãy dùng thao tác hoàn tất đơn được giao.' });
    }

    const prevStatus = existing.status;
    const updaterActor = req.dashboardUser.role === 'admin' ? 'PANEL_ADMIN' : `STAFF_${req.dashboardUser.username.toUpperCase()}`;
    let updated = await updateOrderStatus(id, status, updaterActor, 'UPDATED_BY_WEB');
    if (amount !== undefined && amount !== null && !isNaN(amount)) {
      updated = await updateOrderAmount(id, amount);
    }
    await writeOrderAudit({
      orderId: id, user: req.dashboardUser, action: 'ORDER_STATUS_CHANGED',
      before: { status: prevStatus, amountCents: existing.amountCents },
      after: { status: updated.status, amountCents: updated.amountCents }
    });

    // Two-way sync: Send receipt / status embed to Discord ticket channel if channel is open
    // Deduplication check: Do NOT resend if status has not changed or if notified in the last 15s
    const notifyKey = `${id}:${status}`;
    const lastNotified = orderStatusNotifyCache.get(notifyKey) || 0;
    const isRecentlyNotified = (Date.now() - lastNotified) < 15000;
    const isStatusChanged = prevStatus !== status;

    if (notifyDiscord && isStatusChanged && !isRecentlyNotified && existing.ticket?.channelId && client.isReady()) {
      orderStatusNotifyCache.set(notifyKey, Date.now());
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

          if (status === 'PAID' || status === 'COMPLETED') {
            await deleteTicketQrMessages(channel, { isPaid: true });
          }
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
    if (req.dashboardUser.role !== 'admin') return res.status(403).json({ ok: false, error: 'Chỉ owner/admin được sửa giá đơn hàng.' });
    const existing = req.targetOrder || await prisma.order.findUnique({ where: { id } });
    const updated = await updateOrderAmount(id, amount);
    await writeOrderAudit({ orderId: id, user: req.dashboardUser, action: 'ORDER_AMOUNT_CHANGED', before: { amountCents: existing?.amountCents }, after: { amountCents: updated.amountCents } });
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
    if (req.dashboardUser.role === 'seller' && (amount !== undefined || status || sellerId || sellerName || serviceName || customerName)) {
      return res.status(403).json({ ok: false, error: 'Seller chỉ được cập nhật ghi chú của đơn được giao.' });
    }
    if (status) {
      const transitionError = validateOrderTransition(existing.status, status);
      if (transitionError) return res.status(409).json({ ok: false, error: transitionError });
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
    await writeOrderAudit({
      orderId: id, user: req.dashboardUser, action: 'ORDER_UPDATED',
      before: { status: existing.status, amountCents: existing.amountCents, planSnapshotJson: existing.planSnapshotJson },
      after: { status: updated.status, amountCents: updated.amountCents, planSnapshotJson: updated.planSnapshotJson }
    });

    // If customerName provided and differs, update user record
    if (customerName && existing.user && existing.user.name !== customerName) {
      await prisma.user.update({
        where: { id: existing.user.id },
        data: { name: customerName }
      }).catch(() => {});
    }

    // Two-way sync to Discord if requested and channel exists
    const updateNotifyKey = `${id}:${status || existing.status}`;
    const lastUpdateNotified = orderStatusNotifyCache.get(updateNotifyKey) || 0;
    const isUpdateRecentlyNotified = (Date.now() - lastUpdateNotified) < 15000;
    const isStatusDifferent = status && existing.status !== status;

    if (notifyDiscord && (isStatusDifferent || notes) && !isUpdateRecentlyNotified && existing.ticket?.channelId && client.isReady()) {
      orderStatusNotifyCache.set(updateNotifyKey, Date.now());
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

          if (updated.status === 'PAID' || updated.status === 'COMPLETED') {
            await deleteTicketQrMessages(channel, { isPaid: true });
          }

          await channel.send({ embeds: [embed] });
        }
      } catch (err) {
        console.error('Không thể gửi thông báo ticket Discord:', err);
      }
    } else if (existing.ticket?.channelId && client.isReady() && (updated.status === 'PAID' || updated.status === 'COMPLETED')) {
      try {
        const ticketChannel = await client.channels.fetch(existing.ticket.channelId).catch(() => null);
        if (ticketChannel?.isTextBased()) {
          await deleteTicketQrMessages(ticketChannel, { isPaid: true });
        }
      } catch (_) {}
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
    const existing = await prisma.order.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ ok: false, error: 'Không tìm thấy đơn hàng.' });
    const archived = await prisma.order.update({ where: { id }, data: { archivedAt: new Date() } });
    await writeOrderAudit({ orderId: id, user: req.dashboardUser, action: 'ORDER_ARCHIVED', before: { archivedAt: existing.archivedAt }, after: { archivedAt: archived.archivedAt } });
    return res.json({ ok: true, message: 'Đã lưu trữ đơn hàng. Dữ liệu tài chính và lịch sử vẫn được bảo toàn.' });
  } catch (err) {
    console.error('Lỗi khi xóa đơn hàng:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Create manual order
app.post('/api/orders/create', requireAdminAuth, async (req, res) => {
  try {
    const { discordId, customerName, serviceName, categoryKey, amount, status = 'PENDING', notes, sellerId, sellerName } = req.body;
    if (!ORDER_STATUSES.has(status)) return res.status(400).json({ ok: false, error: 'Trạng thái đơn hàng không hợp lệ.' });

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

// --- GPM Pay Auto Payment Webhook Endpoint (@gpmpay/sdk) ---
const gpmWebhookSecret = process.env.GPMPAY_WEBHOOK_SECRET || process.env.GPM_PAY_WEBHOOK_SECRET;

function getConfiguredReceivingAccounts() {
  const accounts = String(process.env.BANK_ACCOUNT || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(account|accountNumber|bankAccount)$/i.test(key) && typeof child === 'string' && child.trim()) accounts.push(child.trim());
      else if (child && typeof child === 'object') visit(child);
    }
  };
  visit(getMenuData().paymentMethods);
  visit(getMenuData().sellers);
  return [...new Set(accounts)];
}

async function notifyProcessedPayment(updatedOrder, payment) {
  const logChannelId = process.env.PAYMENT_LOG_CHANNEL_ID;
  const bankLabel = [process.env.BANK_NAME, process.env.BANK_OWNER].filter(Boolean).join(' — ') || 'Tài khoản đã cấu hình';
  if (client.isReady() && logChannelId) {
    const logCh = await client.channels.fetch(logChannelId).catch(() => null);
    if (logCh?.isTextBased()) {
      const embed = new EmbedBuilder()
        .setTitle('💰 BIẾN ĐỘNG SỐ DƯ — ĐÃ ĐỐI SOÁT')
        .setColor(0x00C2A8)
        .setDescription([
          `💵 **Số tiền nhận:** **+${payment.transferAmount.toLocaleString('vi-VN')} VNĐ**`,
          `🏦 **Tài khoản nhận:** \`${payment.receivingAccount || '(không có)'}\` (${bankLabel})`,
          `🔢 **Mã giao dịch:** \`${payment.transactionId}\``,
          `📦 **Đơn hàng:** \`#${updatedOrder.orderNo}\``,
          `👤 **Khách:** <@${updatedOrder.user?.discordId}>`
        ].join('\n'))
        .setTimestamp();
      const staffRoleMention = process.env.STAFF_ROLE_ID ? `<@&${process.env.STAFF_ROLE_ID}>` : '';
      await logCh.send({ content: `🔔 ${staffRoleMention} Thanh toán đã được đối soát tự động.`, embeds: [embed] }).catch(console.error);
    }
  }

  if (updatedOrder.ticket?.channelId) {
    const ticketCh = await client.channels.fetch(updatedOrder.ticket.channelId).catch(() => null);
    if (ticketCh?.isTextBased()) {
      await deleteTicketQrMessages(ticketCh, { isPaid: true });
      await sendTicketPaymentNotification(ticketCh, {
        transferAmount: payment.transferAmount,
        rawContent: payment.rawContent || '',
        transactionId: payment.transactionId,
        matchedOrder: updatedOrder,
        receivingAccount: payment.receivingAccount || ''
      });
    }
  }
  await upsertSubscriptionForPaidOrder(updatedOrder.id);
}

// --- PayOS Webhook Endpoint (@payos/node) ---
app.post('/api/payos/webhook', async (req, res) => {
  try {
    const result = await processPayosWebhook(req.body, {
      onOrderPaid: notifyProcessedPayment,
      source: 'PAYOS_WEBHOOK'
    });
    if (!result.ok) {
      console.warn(`[PayOS Webhook] ${result.code}: ${result.message}`);
      return res.status(400).json(result);
    }
    return res.json({ ok: true, message: result.message });
  } catch (err) {
    console.error('Lỗi khi xử lý PayOS webhook:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/api/webhook/payos', (req, res) => res.redirect(307, '/api/payos/webhook'));

// --- PayOS Background Auto-Check for Pending Orders (Zero-Cloudflare, Works Everywhere) ---
let isPayosSyncing = false;
async function syncPayosPendingOrders() {
  if (isPayosSyncing || !client.isReady()) return;
  const payos = getPayOS();
  if (!payos) return;

  isPayosSyncing = true;
  try {
    const pendingOrders = await prisma.order.findMany({
      where: {
        status: 'PENDING',
        paymentProvider: 'PAYOS',
        providerRef: { not: null },
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      },
      include: { user: true, product: true, ticket: true },
      take: 5
    });

    for (const order of pendingOrders) {
      if (!order.providerRef) continue;
      const info = await getPayosPaymentInfo(order.providerRef);
      if (info && info.status === 'PAID') {
        const fullOrder = await prisma.order.findUnique({
          where: { id: order.id },
          include: { user: true, product: true, ticket: true }
        });
        await updateOrderStatus(order.id, 'PAID');
        await prisma.paymentTransaction.create({
          data: {
            transactionId: `PAYOS-AUTO-${order.providerRef}-${Date.now()}`,
            orderNo: order.orderNo,
            orderId: order.id,
            amount: info.amount || order.amountCents,
            expectedAmount: order.amountCents,
            receivingAccount: process.env.BANK_ACCOUNT || '8888217932',
            status: 'SUCCESS',
            source: 'PAYOS_POLLING',
            rawPayloadJson: JSON.stringify(info)
          }
        });
        await notifyProcessedPayment(fullOrder || order, {
          transferAmount: info.amount || order.amountCents,
          receivingAccount: process.env.BANK_ACCOUNT || '8888217932',
          transactionId: `PAYOS-${order.providerRef}`,
          rawContent: `PayOS #${order.providerRef}`
        });
      }
    }
  } catch (err) {
    console.error('[PayOS Polling] Đồng bộ thất bại:', err.message);
  } finally {
    isPayosSyncing = false;
  }
}

if (!dashboardOnlyMode && !uiTestMode) {
  setInterval(syncPayosPendingOrders, 12000);
}


// --- Real Production Health Check Endpoint ---
app.get('/health', async (_, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const botReady = client.isReady();
    return res.status(200).json({
      status: 'healthy',
      database: 'connected',
      mode: dashboardOnlyMode ? 'dashboard-only' : uiTestMode ? 'ui-test' : 'full',
      discordBot: dashboardOnlyMode ? 'disabled' : botReady ? 'ready' : 'connecting',
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

if (dashboardOnlyMode) {
  console.log('🧪 Dashboard-only mode: Discord login, menu sync and GPM polling are disabled.');
} else {
  client.login(process.env.DISCORD_BOT_TOKEN);
}
