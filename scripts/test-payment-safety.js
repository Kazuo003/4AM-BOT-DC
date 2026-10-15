require('dotenv').config();
const assert = require('assert');
const { prisma } = require('../src/db');
const { processGpmWebhook } = require('../src/payment/gpmPay');

async function main() {
  const suffix = Date.now().toString(36).toUpperCase();
  const orderNo = suffix.slice(-8).padStart(8, 'A');
  const user = await prisma.user.create({ data: { discordId: `test_${suffix}`, name: 'Payment Safety Test' } });
  const product = await prisma.product.create({ data: {
    type: 'TEST', name: 'Payment Safety', sku: `TEST_${suffix}`, specJson: '{}', priceCents: 100000, currency: 'VNĐ'
  }});
  const order = await prisma.order.create({ data: {
    orderNo, userId: user.id, productId: product.id, planSnapshotJson: '{}', amountCents: 100000, currency: 'VNĐ'
  }});

  try {
    const common = { transferType: 'in', content: `4AM ${orderNo}`, accountNumber: '123456789' };
    const options = { source: 'TEST', requireReceivingAccount: true, getValidReceivingAccounts: () => ['123456789'] };
    const missingConfig = await processGpmWebhook({ ...common, id: `CONFIG_${suffix}`, transferAmount: 100000 }, {
      source: 'TEST', requireReceivingAccount: true, getValidReceivingAccounts: () => []
    });
    assert.strictEqual(missingConfig.code, 'PAYMENT_CONFIG_ERROR');
    assert.strictEqual((await prisma.order.findUnique({ where: { id: order.id } })).status, 'PENDING');

    const mismatched = await processGpmWebhook({ ...common, id: `MISMATCH_${suffix}`, transferAmount: 1000 }, options);
    assert.strictEqual(mismatched.code, 'AMOUNT_MISMATCH');
    assert.strictEqual((await prisma.order.findUnique({ where: { id: order.id } })).status, 'PENDING');

    const wrongAccount = await processGpmWebhook({ ...common, id: `ACCOUNT_${suffix}`, accountNumber: '999', transferAmount: 100000 }, options);
    assert.strictEqual(wrongAccount.code, 'UNAUTHORIZED_RECEIVER_ACCOUNT');

    const paidPayload = { ...common, id: `PAID_${suffix}`, transferAmount: 100000 };
    const paid = await processGpmWebhook(paidPayload, options);
    assert.strictEqual(paid.ok, true);
    assert.strictEqual((await prisma.order.findUnique({ where: { id: order.id } })).status, 'PAID');

    const duplicate = await processGpmWebhook(paidPayload, options);
    assert.strictEqual(duplicate.duplicate, true);
    assert.strictEqual(await prisma.paymentTransaction.count({ where: { transactionId: paidPayload.id } }), 1);
    console.log('✅ Payment safety: exact amount, receiver validation, atomic payment and idempotency PASS');
  } finally {
    await prisma.auditLog.deleteMany({ where: { orderId: order.id } });
    await prisma.paymentTransaction.deleteMany({ where: { orderId: order.id } });
    await prisma.order.delete({ where: { id: order.id } });
    await prisma.product.delete({ where: { id: product.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.$disconnect();
  }
}

main().catch(async err => {
  console.error(err);
  await prisma.$disconnect();
  process.exitCode = 1;
});
