const fs = require('fs');
const path = require('path');
const { GpmPay, GpmPayError, GpmPayConfigError } = require('@gpmpay/sdk');
const {
  constructWebhookEvent,
  gpmpayWebhook,
  signWebhookPayload,
  GpmPayWebhookSignatureError
} = require('@gpmpay/sdk/webhooks');
const {
  buildVietQrImageUrl,
  buildVietQrPayload,
  buildPaymentInstructions
} = require('@gpmpay/sdk/vietqr');
const { prisma } = require('../db');
const { updateOrderStatus } = require('../order');

const LEDGER_FILE = path.resolve(__dirname, '../../.payment-ledger.json');

/**
 * Đọc sổ cái thanh toán (Payment Ledger) từ storage an toàn
 */
function readLedger() {
  try {
    if (!fs.existsSync(LEDGER_FILE)) return [];
    const content = fs.readFileSync(LEDGER_FILE, 'utf8');
    const data = JSON.parse(content);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('⚠️ [Payment Ledger] Lỗi khi đọc file ledger:', err.message);
    return [];
  }
}

/**
 * Ghi bản ghi mới vào sổ cái thanh toán an toàn (Atomic Write)
 */
function writeLedger(records) {
  const tempFile = `${LEDGER_FILE}.tmp`;
  try {
    fs.writeFileSync(tempFile, JSON.stringify(records, null, 2), { mode: 0o600 });
    fs.renameSync(tempFile, LEDGER_FILE);
  } catch (err) {
    console.error('⚠️ [Payment Ledger] Lỗi khi lưu ledger:', err.message);
    if (fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch (_) {}
    }
  }
}

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

/**
 * Phân giải mã BIN ngân hàng từ tên ngân hàng (chuẩn VietQR)
 */
function resolveBankBin(bankName) {
  if (!bankName) return '970422'; // mặc định MB Bank
  const clean = String(bankName).toLowerCase().replace(/[^a-z0-9]/g, '');
  const sorted = Object.keys(BANK_BINS).sort((a, b) => b.length - a.length);
  for (const k of sorted) {
    if (clean.includes(k)) return BANK_BINS[k];
  }
  return '970422';
}

/**
 * Khởi tạo GPM Pay client (Node.js SDK)
 */
let gpmPayClient = null;
function getGpmPayClient() {
  const token = process.env.GPMPAY_API_TOKEN;
  if (!token) {
    throw new GpmPayConfigError('Missing required environment variable: GPMPAY_API_TOKEN. Vui lòng cấu hình GPMPAY_API_TOKEN trong .env.');
  }
  if (!gpmPayClient) {
    gpmPayClient = new GpmPay({ apiToken: token });
  }
  return gpmPayClient;
}

/**
 * Trích xuất mã đơn hàng từ chuỗi nội dung chuyển khoản
 * Khớp mã dạng: "4AM ABC12345", "4AM_ABC12345" hoặc mã đơn hàng 8 ký tự nanoid
 */
function extractOrderCode(content) {
  if (!content || typeof content !== 'string') return null;
  const match = content.match(/4AM[\s_-]*([A-Za-z0-9]{6,12})/i) || content.match(/\b([A-Za-z0-9]{8})\b/i);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Xử lý sự kiện thanh toán từ GPM Pay Webhook (Payload đã qua xác thực chữ ký HMAC của SDK)
 * Tuân thủ nguyên tắc:
 * 1. Thoát sớm nếu là test ping (khi merchant đăng ký endpoint)
 * 2. Chỉ nhận transferType === 'in'
 * 3. Idempotency theo payload.id
 * 4. So khớp số tiền (số nguyên VND)
 * 5. Cập nhật DB & gọi callback
 */
async function processGpmWebhook(payload, options = {}) {
  const { onOrderPaid, getValidReceivingAccounts, source = 'WEBHOOK', requireReceivingAccount = false } = options;

  // 1. Thoát sớm nếu là gói tin test ping khi tạo webhook endpoint
  if (payload.test === true || payload.referenceCode === 'GPMPAY-VERIFY') {
    console.log('ℹ️ [GPM Pay] Nhận gói tin ping kiểm tra kết nối từ GPM Pay.');
    return { ok: true, test: true, message: 'Ping test verified' };
  }

  // 2. Chỉ xử lý tiền vào (transferType === 'in')
  if (payload.transferType && payload.transferType !== 'in') {
    return { ok: true, ignored: true, message: `Bỏ qua giao dịch transferType=${payload.transferType}` };
  }

  const transactionId = String(payload.id || payload.transaction_id || '').trim();
  const rawContent = String(payload.content || '').trim();
  const transferAmount = Math.max(0, Math.round(Number(payload.transferAmount || payload.amount || 0)));
  const receivingAccount = String(payload.accountNumber || payload.account_number || '').trim();

  if (!transactionId) {
    return { ok: false, code: 'MISSING_TRANSACTION_ID', message: 'Thiếu transaction id trong webhook payload' };
  }

  // 3. Idempotency is stored in the database so it also works across restarts
  // and multiple bot processes.
  const existingRecord = await prisma.paymentTransaction.findUnique({ where: { transactionId } });

  if (existingRecord) {
    console.log(`ℹ️ [GPM Pay] Bỏ qua webhook trùng lặp (Idempotency Hit): ${transactionId}`);
    return {
      ok: true,
      duplicate: true,
      code: 'ALREADY_PROCESSED',
      status: existingRecord.status,
      message: 'Giao dịch đã được ghi nhận trước đó.'
    };
  }

  // 4. Trích xuất mã đơn hàng từ nội dung chuyển khoản
  const orderCode = extractOrderCode(rawContent);
  if (!orderCode) {
    await prisma.paymentTransaction.create({ data: {
      transactionId, orderNo: null, amount: transferAmount, receivingAccount: receivingAccount || null,
      status: 'UNMATCHED_OR_FREE', source, rawPayloadJson: JSON.stringify(payload)
    }});
    if (typeof options.onUnmatchedPayment === 'function') {
      try {
        await options.onUnmatchedPayment({
          transferAmount,
          receivingAccount,
          transactionId,
          rawContent,
          timestamp: payload.transactionDate ? new Date(payload.transactionDate).getTime() : Date.now()
        });
      } catch (err) {
        console.error('⚠️ [GPM Pay] Lỗi khi gọi onUnmatchedPayment:', err);
      }
    }
    return { ok: true, code: 'UNMATCHED_PAYMENT_NOTIFIED', message: `Đã ghi nhận và thông báo biến động số dư tự do (+${transferAmount.toLocaleString('vi-VN')} VNĐ)` };
  }

  // 5. Tra cứu đơn hàng trong cơ sở dữ liệu
  const order = await prisma.order.findUnique({
    where: { orderNo: orderCode },
    include: { user: true, product: true, ticket: true }
  });

  if (!order) {
    await prisma.paymentTransaction.create({ data: {
      transactionId, orderNo: orderCode, amount: transferAmount, receivingAccount: receivingAccount || null,
      status: 'ORDER_NOT_FOUND', source, rawPayloadJson: JSON.stringify(payload)
    }});
    return { ok: false, code: 'ORDER_NOT_FOUND', message: `Không tìm thấy đơn hàng #${orderCode} trong cơ sở dữ liệu.` };
  }

  // Nếu đơn hàng đã hoàn tất trước đó
  if (order.status === 'PAID' || order.status === 'COMPLETED') {
    await prisma.paymentTransaction.create({ data: {
      transactionId, orderNo: orderCode, orderId: order.id, amount: transferAmount,
      expectedAmount: order.amountCents, receivingAccount: receivingAccount || null,
      status: 'ORDER_ALREADY_PAID', source, rawPayloadJson: JSON.stringify(payload)
    }});
    return { ok: true, duplicate: true, code: 'ORDER_ALREADY_PAID', message: `Đơn #${orderCode} đã ở trạng thái ${order.status}.` };
  }

  // 6. Kiểm tra tài khoản nhận nếu có cấu hình
  if (typeof getValidReceivingAccounts === 'function') {
    const validAccounts = getValidReceivingAccounts().map(acc => String(acc).replace(/\s+/g, '')).filter(Boolean);
    if (requireReceivingAccount && validAccounts.length === 0) {
      await prisma.paymentTransaction.create({ data: {
        transactionId, orderNo: orderCode, orderId: order.id, amount: transferAmount,
        expectedAmount: order.amountCents, receivingAccount: receivingAccount || null,
        status: 'PAYMENT_CONFIG_ERROR', source, rawPayloadJson: JSON.stringify(payload)
      }});
      return { ok: false, code: 'PAYMENT_CONFIG_ERROR', message: 'Chưa cấu hình tài khoản nhận hợp lệ; giao dịch cần đối soát thủ công.' };
    }
    if (requireReceivingAccount && !receivingAccount) {
      await prisma.paymentTransaction.create({ data: {
        transactionId, orderNo: orderCode, orderId: order.id, amount: transferAmount,
        expectedAmount: order.amountCents, receivingAccount: null,
        status: 'MISSING_RECEIVING_ACCOUNT', source, rawPayloadJson: JSON.stringify(payload)
      }});
      return { ok: false, code: 'MISSING_RECEIVING_ACCOUNT', message: 'Giao dịch không có thông tin tài khoản nhận; cần đối soát thủ công.' };
    }
    if (receivingAccount) {
    const isAccountValid = validAccounts.includes(receivingAccount.replace(/\s+/g, ''));
    if (!isAccountValid && validAccounts.length > 0) {
      await prisma.paymentTransaction.create({ data: {
        transactionId, orderNo: orderCode, orderId: order.id, amount: transferAmount,
        expectedAmount: order.amountCents, receivingAccount,
        status: 'UNAUTHORIZED_RECEIVER_ACCOUNT', source, rawPayloadJson: JSON.stringify(payload)
      }});
      return {
        ok: false,
        code: 'UNAUTHORIZED_RECEIVER_ACCOUNT',
        message: `Tài khoản nhận ${receivingAccount} không thuộc danh sách STK hợp lệ của cửa hàng.`
      };
    }
    }
  }

  // 7. Chỉ xác nhận khi số tiền khớp tuyệt đối. Payment của đơn vẫn chỉ có hai trạng thái:
  // chưa thanh toán hoặc đã thanh toán; giao dịch lệch tiền chỉ được lưu như lỗi kỹ thuật.
  if (order.amountCents > 0 && transferAmount !== order.amountCents) {
    await prisma.paymentTransaction.create({ data: {
      transactionId, orderNo: orderCode, orderId: order.id, expectedAmount: order.amountCents,
      amount: transferAmount, receivingAccount: receivingAccount || null,
      status: 'AMOUNT_MISMATCH', source, rawPayloadJson: JSON.stringify(payload)
    }});
    console.warn(`⚠️ [GPM Pay] Đơn #${orderCode} có số tiền giao dịch không khớp số tiền đơn.`);
    return {
      ok: false,
      code: 'AMOUNT_MISMATCH',
      message: 'Số tiền giao dịch không khớp số tiền đơn hàng. Đơn vẫn ở trạng thái chưa thanh toán.'
    };
  }

  // 8. Cập nhật trạng thái đơn hàng sang PAID & ghi nhận sổ cái
  let updatedOrder;
  try {
    updatedOrder = await prisma.$transaction(async tx => {
      await tx.paymentTransaction.create({ data: {
        transactionId, orderNo: orderCode, orderId: order.id, expectedAmount: order.amountCents,
        amount: transferAmount, receivingAccount: receivingAccount || null,
        status: 'SUCCESS', source, rawPayloadJson: JSON.stringify(payload)
      }});
      const updated = await tx.order.update({
        where: { id: order.id },
        data: { status: 'PAID', paymentProvider: 'GPM_PAY_AUTO', providerRef: `GPM_${transactionId}` },
        include: { user: true, product: true, ticket: true }
      });
      await tx.auditLog.create({ data: {
        orderId: order.id, actorType: 'SYSTEM', actorId: source, action: 'PAYMENT_CONFIRMED',
        beforeJson: JSON.stringify({ status: order.status }),
        afterJson: JSON.stringify({ status: 'PAID', transactionId, amount: transferAmount })
      }});
      return updated;
    });
  } catch (err) {
    if (err?.code === 'P2002') {
      return { ok: true, duplicate: true, code: 'ALREADY_PROCESSED', message: 'Giao dịch đã được ghi nhận trước đó.' };
    }
    throw err;
  }

  // Kích hoạt callback nghiệp vụ (Discord notification, role, subscription)
  if (typeof onOrderPaid === 'function') {
    try {
      await onOrderPaid(updatedOrder, { transactionId, transferAmount, receivingAccount, rawContent });
    } catch (cbErr) {
      console.error('⚠️ [GPM Pay] Lỗi khi chạy callback sau thanh toán:', cbErr);
    }
  }

  return {
    ok: true,
    order: updatedOrder,
    message: `Đã xác nhận thanh toán tự động thành công cho Đơn hàng #${orderCode}!`
  };
}

/**
 * Hàm hỗ trợ kiểm tra chữ ký HMAC (sử dụng SDK constructWebhookEvent)
 */
function verifyHmacSignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  try {
    constructWebhookEvent({ rawBody, signature, secret });
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = {
  GpmPay,
  getGpmPayClient,
  constructWebhookEvent,
  gpmpayWebhook,
  signWebhookPayload,
  buildVietQrImageUrl,
  buildVietQrPayload,
  buildPaymentInstructions,
  resolveBankBin,
  verifyHmacSignature,
  extractOrderCode,
  processGpmWebhook,
  readLedger,
  writeLedger,
  LEDGER_FILE
};
