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

async function createOrder({ userId, productId, planSnapshotJson, amountCents, currency }) {
  const orderNo = shortOrderNo();
  return prisma.order.create({ data: { orderNo, userId, productId, planSnapshotJson, amountCents, currency, status: 'PENDING' } });
}

async function markPaid(orderId, provider = 'SIMULATED', ref = 'SIM-OK') {
  return prisma.order.update({ where: { id: orderId }, data: { status: 'PAID', paymentProvider: provider, providerRef: ref } });
}

// src/order.js
async function attachTicket(orderId, guildId, channelId) {
  // Idempotent: if the channel already has a ticket row, reuse it.
  return prisma.ticket.upsert({
    where: { channelId },                // channelId is @unique
    update: { orderId, guildId },        // update to point at the latest order
    create: { orderId, guildId, channelId, status: 'OPEN' }
  });

}

module.exports = { ensureUser, findOrCreateProduct, createOrder, markPaid, attachTicket };