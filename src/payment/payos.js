const { PayOS } = require('@payos/node');
const { prisma } = require('../db');
const { updateOrderStatus } = require('../order');

const BANK_BINS = {
  'vietcombank': '970436',
  'vcb': '970436',
  'vietinbank': '970415',
  'icb': '970415',
  'bidv': '970418',
  'techcombank': '970407',
  'tcb': '970407',
  'acb': '970416',
  'vpbank': '970432',
  'vpb': '970432',
  'tpbank': '970458',
  'tpb': '970458',
  'sacombank': '970403',
  'stb': '970403',
  'hdbank': '970437',
  'hdb': '970437',
  'vib': '970441',
  'shb': '970443',
  'seabank': '970440',
  'msb': '970426',
  'ocb': '970448',
  'agribank': '970405',
  'vba': '970405',
  'cake': '546034',
  'timo': '963388',
  'namabank': '970428',
  'lpbank': '970449',
  'mbbank': '970422',
  'mb': '970422'
};

function resolveBankBin(bankName) {
  if (!bankName) return '970418'; // mặc định BIDV theo kênh của shop
  const clean = String(bankName).toLowerCase().replace(/[^a-z0-9]/g, '');
  const sorted = Object.keys(BANK_BINS).sort((a, b) => b.length - a.length);
  for (const k of sorted) {
    if (clean.includes(k)) return BANK_BINS[k];
  }
  return '970418';
}

function buildVietQrImageUrl({ bankBin, accountNumber, amount, description, accountName, template = 'compact2' }) {
  const bin = bankBin || '970418';
  const acc = String(accountNumber || '').replace(/\s+/g, '');
  const amt = Math.max(0, Math.round(Number(amount) || 0));
  const des = encodeURIComponent(String(description || '').trim());
  const name = accountName ? encodeURIComponent(String(accountName).trim()) : '';
  let url = `https://img.vietqr.io/image/${bin}-${acc}-${template}.png?amount=${amt}&addInfo=${des}`;
  if (name) url += `&accountName=${name}`;
  return url;
}

let payosClient = null;
function getPayOS() {
  const clientId = process.env.PAYOS_CLIENT_ID;
  const apiKey = process.env.PAYOS_API_KEY;
  const checksumKey = process.env.PAYOS_CHECKSUM_KEY;
  if (!clientId || !apiKey || !checksumKey) {
    return null;
  }
  if (!payosClient) {
    payosClient = new PayOS({ clientId, apiKey, checksumKey });
  }
  return payosClient;
}

/**
 * Sinh mã đơn số nguyên duy nhất cho PayOS (yêu cầu Number <= Number.MAX_SAFE_INTEGER)
 */
function generatePayosOrderCode() {
  const timeSlice = Number(String(Date.now()).slice(-6));
  const rand = Math.floor(Math.random() * 900) + 100;
  return Number(`${timeSlice}${rand}`);
}

/**
 * Tạo link thanh toán PayOS
 */
async function createPayosPayment({ orderNo, amount, description, items = [] }) {
  const payos = getPayOS();
  if (!payos) {
    return { ok: false, error: 'Chưa cấu hình khóa PayOS trong .env' };
  }

  const orderCode = generatePayosOrderCode();
  // Description trong VietQR/PayOS không vượt quá 25 ký tự và không chứa ký tự đặc biệt
  const cleanDesc = (description || `4AM ${orderNo}`)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .trim()
    .slice(0, 25);

  const cleanAmount = Math.max(1000, Math.round(Number(amount) || 0));

  try {
    const paymentBody = {
      orderCode,
      amount: cleanAmount,
      description: cleanDesc,
      cancelUrl: process.env.PAYOS_CANCEL_URL || 'https://discord.com',
      returnUrl: process.env.PAYOS_RETURN_URL || 'https://discord.com',
      items: items.length > 0 ? items : [{
        name: `Đơn hàng ${orderNo}`,
        quantity: 1,
        price: cleanAmount
      }]
    };

    const paymentLinkRes = await payos.paymentRequests.create(paymentBody);

    // Cập nhật providerRef trong Order để đối soát khi Webhook gọi về
    if (orderNo) {
      await prisma.order.updateMany({
        where: { orderNo },
        data: {
          paymentProvider: 'PAYOS',
          providerRef: String(orderCode),
          amountCents: cleanAmount
        }
      }).catch(console.error);
    }

    return {
      ok: true,
      orderCode,
      amount: cleanAmount,
      accountNumber: paymentLinkRes.accountNumber,
      accountName: paymentLinkRes.accountName,
      bin: paymentLinkRes.bin,
      description: paymentLinkRes.description || cleanDesc,
      checkoutUrl: paymentLinkRes.checkoutUrl,
      qrCode: paymentLinkRes.qrCode,
      status: paymentLinkRes.status
    };
  } catch (err) {
    console.error('⚠️ [PayOS] Lỗi khi tạo payment link:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Tra cứu trạng thái đơn hàng trên PayOS bằng orderCode
 */
async function getPayosPaymentInfo(orderCode) {
  const payos = getPayOS();
  if (!payos) return null;
  try {
    const info = await payos.paymentRequests.get(Number(orderCode));
    return info;
  } catch (err) {
    console.error(`⚠️ [PayOS] Lỗi tra cứu orderCode=${orderCode}:`, err.message);
    return null;
  }
}

/**
 * Xử lý webhook từ PayOS
 */
async function processPayosWebhook(reqBody, options = {}) {
  const payos = getPayOS();
  if (!payos) {
    return { ok: false, code: 'PAYOS_NOT_CONFIGURED', message: 'PayOS chưa được cấu hình' };
  }

  const { onOrderPaid, source = 'PAYOS_WEBHOOK' } = options;

  let webhookData = null;
  try {
    webhookData = await payos.webhooks.verify(reqBody);
  } catch (err) {
    console.error('⚠️ [PayOS Webhook] Lỗi xác thực chữ ký Checksum:', err.message);
    return { ok: false, code: 'INVALID_SIGNATURE', message: 'Chữ ký Checksum không hợp lệ' };
  }

  if (!webhookData) {
    return { ok: false, code: 'EMPTY_WEBHOOK_DATA', message: 'Không có dữ liệu trong webhook' };
  }

  console.log('✅ [PayOS Webhook] Nhận dữ liệu webhook hợp lệ:', JSON.stringify(webhookData));

  // Kiểm tra gói tin test ping từ PayOS
  if (webhookData.desc === 'Webhook test' || webhookData.description === 'Webhook test' || webhookData.orderCode === 123) {
    console.log('ℹ️ [PayOS Webhook] Gói tin ping kiểm tra kết nối Webhook từ PayOS.');
    return { ok: true, test: true, message: 'Ping test verified' };
  }

  const orderCodeNum = Number(webhookData.orderCode);
  const transferAmount = Math.max(0, Math.round(Number(webhookData.amount || 0)));
  const reference = String(webhookData.reference || webhookData.paymentLinkId || `PAYOS-${orderCodeNum}`).trim();
  const transactionId = reference || `PAYOS-${orderCodeNum}-${Date.now()}`;
  const receivingAccount = String(webhookData.accountNumber || process.env.BANK_ACCOUNT || '').trim();

  // 1. Idempotency Check
  const existingRecord = await prisma.paymentTransaction.findUnique({
    where: { transactionId }
  });

  if (existingRecord) {
    console.log(`ℹ️ [PayOS] Bỏ qua webhook trùng lặp (Idempotency Hit): ${transactionId}`);
    return {
      ok: true,
      duplicate: true,
      code: 'ALREADY_PROCESSED',
      status: existingRecord.status,
      message: 'Giao dịch đã được ghi nhận trước đó.'
    };
  }

  // 2. Tìm đơn hàng tương ứng theo providerRef hoặc orderNo
  let order = await prisma.order.findFirst({
    where: {
      OR: [
        { providerRef: String(orderCodeNum) },
        { orderNo: String(webhookData.description || '').replace(/^4AM\s*/i, '').trim() }
      ]
    },
    include: { user: true, product: true, ticket: true }
  });

  if (!order) {
    await prisma.paymentTransaction.create({
      data: {
        transactionId,
        orderNo: String(orderCodeNum),
        amount: transferAmount,
        receivingAccount,
        status: 'ORDER_NOT_FOUND',
        source,
        rawPayloadJson: JSON.stringify(webhookData)
      }
    });
    return { ok: false, code: 'ORDER_NOT_FOUND', message: `Không tìm thấy đơn hàng tương ứng với orderCode=${orderCodeNum}` };
  }

  // Nếu đơn hàng đã hoàn tất trước đó
  if (order.status === 'PAID' || order.status === 'COMPLETED') {
    await prisma.paymentTransaction.create({
      data: {
        transactionId,
        orderNo: order.orderNo,
        orderId: order.id,
        amount: transferAmount,
        expectedAmount: order.amountCents,
        receivingAccount,
        status: 'ORDER_ALREADY_PAID',
        source,
        rawPayloadJson: JSON.stringify(webhookData)
      }
    });
    return { ok: true, duplicate: true, code: 'ORDER_ALREADY_PAID', message: `Đơn #${order.orderNo} đã ở trạng thái ${order.status}.` };
  }

  // 3. Đối soát số tiền
  if (order.amountCents > 0 && transferAmount < order.amountCents) {
    await prisma.paymentTransaction.create({
      data: {
        transactionId,
        orderNo: order.orderNo,
        orderId: order.id,
        expectedAmount: order.amountCents,
        amount: transferAmount,
        receivingAccount,
        status: 'AMOUNT_MISMATCH',
        source,
        rawPayloadJson: JSON.stringify(webhookData)
      }
    });
    return { ok: false, code: 'AMOUNT_MISMATCH', message: 'Số tiền thanh toán nhỏ hơn giá trị đơn hàng.' };
  }

  // 4. Cập nhật trạng thái đơn sang PAID
  const updatedOrder = await updateOrderStatus(order.id, 'PAID');

  await prisma.paymentTransaction.create({
    data: {
      transactionId,
      orderNo: order.orderNo,
      orderId: order.id,
      amount: transferAmount,
      expectedAmount: order.amountCents,
      receivingAccount,
      status: 'SUCCESS',
      source,
      rawPayloadJson: JSON.stringify(webhookData)
    }
  });

  const fullOrder = await prisma.order.findUnique({
    where: { id: order.id },
    include: { user: true, product: true, ticket: true }
  });

  if (typeof onOrderPaid === 'function') {
    try {
      await onOrderPaid(fullOrder || updatedOrder, {
        transferAmount,
        receivingAccount,
        transactionId,
        rawContent: webhookData.description || `PayOS #${orderCodeNum}`
      });
    } catch (cbErr) {
      console.error('⚠️ [PayOS] Lỗi khi gọi callback onOrderPaid:', cbErr);
    }
  }

  return {
    ok: true,
    code: 'PAID',
    order: fullOrder || updatedOrder,
    message: `Đơn hàng #${order.orderNo} đã được thanh toán thành công qua PayOS!`
  };
}

module.exports = {
  getPayOS,
  createPayosPayment,
  getPayosPaymentInfo,
  processPayosWebhook,
  resolveBankBin,
  buildVietQrImageUrl
};
