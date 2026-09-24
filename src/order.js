const { prisma } = require('./db');
const { shortOrderNo } = require('./utils');

async function ensureUser(discordId, email, name, country) {
  let user = await prisma.user.findUnique({ where: { discordId } });
  if (!user) {
    user = await prisma.user.create({ data: { discordId, email, name, country } });
  } else {
    const data = {};
    if (email && !user.email) data.email = email;
    if (name && !user.name) data.name = name;
    if (country && !user.country) data.country = country;
    if (Object.keys(data).length) user = await prisma.user.update({ where: { id: user.id }, data });
  }
  return user;
}

async function findOrCreateProduct({ type, name, sku, specJson, priceCents, currency }) {
  const existing = await prisma.product.findUnique({ where: { sku } });
  if (existing) return existing;
  return prisma.product.create({ data: { type, name, sku, specJson, priceCents, currency, active: true } });
}

async function createOrder({ userId, productId, planSnapshotJson, amountCents, currency, orderNo }) {
  const finalOrderNo = orderNo || shortOrderNo();
  return prisma.order.create({
    data: {
      orderNo: finalOrderNo,
      userId,
      productId,
      planSnapshotJson,
      amountCents: amountCents || 0,
      currency: currency || 'VNĐ',
      status: 'PENDING'
    }
  });
}

async function markPaid(orderId, provider = 'SIMULATED', ref = 'SIM-OK') {
  return prisma.order.update({ where: { id: orderId }, data: { status: 'PAID', paymentProvider: provider, providerRef: ref } });
}

// src/order.js
async function attachTicket(orderId, guildId, channelId, userId = null) {
  // Idempotent: if the channel already has a ticket row, reuse it.
  return prisma.ticket.upsert({
    where: { channelId },                // channelId is @unique
    update: { orderId, guildId, ...(userId ? { userId } : {}) },
    create: { orderId, guildId, channelId, ...(userId ? { userId } : {}), status: 'OPEN' }
  });
}

async function updateOrderStatus(orderId, status, paymentProvider = null, providerRef = null) {
  const data = { status };
  if (paymentProvider) data.paymentProvider = paymentProvider;
  if (providerRef) data.providerRef = providerRef;
  return prisma.order.update({
    where: { id: orderId },
    data,
    include: { user: true, product: true, ticket: true }
  });
}

async function updateOrderAmount(orderId, amountCents) {
  return prisma.order.update({
    where: { id: orderId },
    data: { amountCents: Math.max(0, parseInt(amountCents, 10) || 0) },
    include: { user: true, product: true, ticket: true }
  });
}

module.exports = { ensureUser, findOrCreateProduct, createOrder, markPaid, attachTicket, updateOrderStatus, updateOrderAmount };