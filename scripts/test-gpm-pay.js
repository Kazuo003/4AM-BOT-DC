const { verifyHmacSignature, extractOrderCode, processGpmWebhook, readLedger } = require('../src/payment/gpmPay');
const crypto = require('crypto');
const assert = require('assert');

async function runTests() {
  console.log('🧪 Bắt đầu chạy test kiểm thử GPM Pay module...');

  // Test 1: Trích xuất mã đơn hàng
  assert.strictEqual(extractOrderCode('4AM AB12CD34'), 'AB12CD34');
  assert.strictEqual(extractOrderCode('Chuyen khoan 4AM_AB12CD34 ung ho shop'), 'AB12CD34');
  assert.strictEqual(extractOrderCode('AB12CD34'), 'AB12CD34');
  assert.strictEqual(extractOrderCode('khong co ma don'), null);
  console.log('✅ Test 1: Trích xuất mã đơn hàng (Regex) PASS');

  // Test 2: Xác thực chữ ký HMAC SHA256
  const secret = 'dummy_secret_for_test_123';
  const rawBody = JSON.stringify({ transaction_id: 'TXN1001', amount: 50000, content: '4AM TEST1234' });
  const validSignature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const invalidSignature = 'bad_signature_12345';

  assert.strictEqual(verifyHmacSignature(rawBody, validSignature, secret), true);
  assert.strictEqual(verifyHmacSignature(rawBody, invalidSignature, secret), false);
  assert.strictEqual(verifyHmacSignature(rawBody, validSignature, 'wrong_secret'), false);
  console.log('✅ Test 2: Xác thực chữ ký HMAC SHA256 PASS');

  // Test 3: Xử lý Webhook với Idempotency & Simulation
  const payload = {
    transaction_id: 'TXN_TEST_' + Date.now(),
    content: '4AM NONEXIST',
    amount: 100000,
    account_number: '0123456789'
  };

  const res1 = await processGpmWebhook(payload);
  assert.strictEqual(res1.ok, false);
  assert.strictEqual(res1.code, 'ORDER_NOT_FOUND');

  // Thử lại cùng transaction_id (Idempotency test)
  const res2 = await processGpmWebhook(payload);
  assert.strictEqual(res2.ok, true);
  assert.strictEqual(res2.duplicate, true);
  assert.strictEqual(res2.code, 'ALREADY_PROCESSED');
  console.log('✅ Test 3: Idempotency chống lặp giao dịch PASS');

  console.log('🎉 TẤT CẢ CÁC BÀI TEST GPM PAY ĐÃ PASS THÀNH CÔNG!');
}

runTests().catch(err => {
  console.error('❌ Test thất bại:', err);
  process.exit(1);
});
