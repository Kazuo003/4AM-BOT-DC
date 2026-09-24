const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
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

/**
 * Kiểm tra chữ ký HMAC SHA256 của Webhook
 * @param {string|Buffer} rawBody - Nội dung thô của request
 * @param {string} signature - Chữ ký nhận được từ header hoặc body
 * @param {string} secret - Khóa bí mật cấu hình trong .env
 */
function verifyHmacSignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  try {
    const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const signatureBuffer = Buffer.from(signature.trim().toLowerCase(), 'hex');
    const computedBuffer = Buffer.from(computed.toLowerCase(), 'hex');

    if (signatureBuffer.length !== computedBuffer.length) {
      return false;
    }
    return crypto.timingSafeEqual(signatureBuffer, computedBuffer);
  } catch (err) {
    console.error('⚠️ [GPM Pay] Lỗi xác thực chữ ký HMAC:', err.message);
    return false;
  }
}

/**
 * Trích xuất mã đơn hàng từ chuỗi nội dung chuyển khoản
 * Ví dụ: "4AM ABC12345" -> "ABC12345", hoặc "ABC12345"
 */
function extractOrderCode(content) {
  if (!content || typeof content !== 'string') return null;
  const match = content.match(/(?:4AM[\s_-]*)?([A-Za-z0-9_-]{8,12})/i);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Xử lý webhook thanh toán GPM Pay với Idempotency, đối soát mã đơn, số tiền và STK nhận
 * @param {Object} payload - Dữ liệu webhook parse từ GPM Pay
 * @param {Object} options - Tùy chọn xác minh và callback
 */
async function processGpmWebhook(payload, options = {}) {
  const isEnabled = process.env.GPM_PAY_ENABLED === 'true';
  const { onOrderPaid, getValidReceivingAccounts } = options;

  // Trích xuất các trường thông dụng từ payload
  const transactionId = String(payload.transaction_id || payload.ref_no || payload.id || payload.trans_id || '').trim();
  const rawContent = String(payload.content || payload.description || payload.memo || payload.note || '').trim();
  const transferAmount = Math.max(0, parseInt(payload.amount || payload.transfer_amount || 0, 10));
  const receivingAccount = String(payload.account_number || payload.receiver_account || payload.bank_account || '').trim();

  if (!transactionId) {
    return { ok: false, code: 'MISSING_TRANSACTION_ID', message: 'Thiếu transaction_id trong webhook payload' };
  }

  // 1. Kiểm tra Idempotency chống xử lý lặp
  const ledger = readLedger();
  const existingRecord = ledger.find(item => item.transactionId === transactionId);

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

  // 2. Trích xuất mã đơn hàng
  const orderCode = extractOrderCode(rawContent);
  if (!orderCode) {
    const record = {
      transactionId,
      orderNo: null,
      amount: transferAmount,
      receivingAccount,
      status: 'UNKNOWN_ORDER_CODE',
      rawPayload: payload,
      processedAt: new Date().toISOString()
    };
    ledger.push(record);
    writeLedger(ledger);
    return { ok: false, code: 'UNKNOWN_ORDER_CODE', message: `Không tìm thấy mã đơn trong nội dung: "${rawContent}"` };
  }

  // 3. Tra cứu đơn hàng trong Database
  const order = await prisma.order.findUnique({
    where: { orderNo: orderCode },
    include: { user: true, product: true, ticket: true }
  });

  if (!order) {
    const record = {
      transactionId,
      orderNo: orderCode,
      amount: transferAmount,
      receivingAccount,
      status: 'ORDER_NOT_FOUND',
      rawPayload: payload,
      processedAt: new Date().toISOString()
    };
    ledger.push(record);
    writeLedger(ledger);
    return { ok: false, code: 'ORDER_NOT_FOUND', message: `Không tìm thấy đơn hàng #${orderCode} trong cơ sở dữ liệu.` };
  }

  // Nếu đơn đã được duyệt thanh toán trước đó
  if (order.status === 'PAID' || order.status === 'COMPLETED') {
    const record = {
      transactionId,
      orderNo: orderCode,
      orderId: order.id,
      amount: transferAmount,
      receivingAccount,
      status: 'ORDER_ALREADY_PAID',
      rawPayload: payload,
      processedAt: new Date().toISOString()
    };
    ledger.push(record);
    writeLedger(ledger);
    return { ok: true, duplicate: true, code: 'ORDER_ALREADY_PAID', message: `Đơn #${orderCode} đã ở trạng thái ${order.status}.` };
  }

  // 4. Kiểm tra tài khoản nhận (Receiving Account Validation)
  if (typeof getValidReceivingAccounts === 'function' && receivingAccount) {
    const validAccounts = getValidReceivingAccounts();
    const isAccountValid = validAccounts.some(acc => acc.replace(/\s+/g, '') === receivingAccount.replace(/\s+/g, ''));
    if (!isAccountValid && validAccounts.length > 0) {
      const record = {
        transactionId,
        orderNo: orderCode,
        orderId: order.id,
        amount: transferAmount,
        receivingAccount,
        status: 'UNAUTHORIZED_RECEIVER_ACCOUNT',
        rawPayload: payload,
        processedAt: new Date().toISOString()
      };
      ledger.push(record);
      writeLedger(ledger);
      return {
        ok: false,
        code: 'UNAUTHORIZED_RECEIVER_ACCOUNT',
        message: `Tài khoản nhận ${receivingAccount} không thuộc danh sách STK hợp lệ của cửa hàng.`
      };
    }
  }

  // 5. Kiểm tra số tiền chuyển khoản
  // Nếu đơn hàng có giá cố định > 0 và số tiền khách chuyển < giá trị đơn
  if (order.amountCents > 0 && transferAmount < order.amountCents) {
    const record = {
      transactionId,
      orderNo: orderCode,
      orderId: order.id,
      expectedAmount: order.amountCents,
      amount: transferAmount,
      receivingAccount,
      status: 'PARTIAL_AMOUNT',
      rawPayload: payload,
      processedAt: new Date().toISOString()
    };
    ledger.push(record);
    writeLedger(ledger);
    return {
      ok: false,
      code: 'PARTIAL_AMOUNT',
      message: `Số tiền nhận (${transferAmount} VNĐ) nhỏ hơn giá trị đơn hàng (${order.amountCents} VNĐ). Cần đối soát thủ công.`
    };
  }

  // 6. Nếu chế độ GPM Pay chưa bật live, ghi log an toàn mà không thay đổi DB
  if (!isEnabled) {
    console.log(`[GPM Pay SIMULATION] Giao dịch hợp lệ nhưng GPM_PAY_ENABLED=false (Sandbox). Order #${orderCode}, Số tiền: ${transferAmount}`);
    const record = {
      transactionId,
      orderNo: orderCode,
      orderId: order.id,
      amount: transferAmount,
      receivingAccount,
      status: 'SIMULATION_VERIFIED',
      rawPayload: payload,
      processedAt: new Date().toISOString()
    };
    ledger.push(record);
    writeLedger(ledger);
    return {
      ok: true,
      simulation: true,
      order,
      message: `[Sandbox] Đã xác thực giao dịch thành công cho đơn #${orderCode}. Hệ thống đang ở chế độ an toàn (chưa kích hoạt DB live).`
    };
  }

  // 7. Cập nhật trạng thái đơn hàng sang PAID & ghi nhận sổ cái
  const updatedOrder = await updateOrderStatus(
    order.id,
    'PAID',
    'GPM_PAY_AUTO',
    `GPM_TRANS_${transactionId}`
  );

  const record = {
    transactionId,
    orderNo: orderCode,
    orderId: order.id,
    amount: transferAmount,
    receivingAccount,
    status: 'SUCCESS',
    rawPayload: payload,
    processedAt: new Date().toISOString()
  };
  ledger.push(record);
  writeLedger(ledger);

  // Kích hoạt callback nếu có (ví dụ thông báo Discord, cấp role, tạo subscription)
  if (typeof onOrderPaid === 'function') {
    try {
      await onOrderPaid(updatedOrder, { transactionId, transferAmount });
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

module.exports = {
  verifyHmacSignature,
  extractOrderCode,
  processGpmWebhook,
  readLedger,
  LEDGER_FILE
};
