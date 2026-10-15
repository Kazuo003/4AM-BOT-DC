require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const scryptAsync = promisify(crypto.scrypt);
const projectRoot = path.resolve(__dirname, '..');
const menuDataPath = path.join(projectRoot, 'src', 'menuData.json');
const dashboardUsersPath = path.join(projectRoot, '.dashboard-users.json');
const sellerPassword = 'seller123';

if (!process.argv.includes('--confirm-reset')) {
  console.error('Refusing to reset data without --confirm-reset.');
  process.exit(1);
}

const now = Date.now();
const hoursAgo = (hours) => new Date(now - hours * 60 * 60 * 1000);
const json = (value) => JSON.stringify(value);

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, 64);
  return { salt, hash: derived.toString('hex') };
}

function testMenuData() {
  return {
    storeName: '4AM STORE — UI TEST',
    ticketChannelId: '900000000000000001',
    ticketCategoryId: '900000000000000002',
    menuChannelId: '900000000000000003',
    paymentMethods: 'BANK|MOMO|VIETQR',
    defaultLanguage: 'vi',
    mainBannerUrl: '',
    logoUrl: '/logo.png',
    menuEmbed: {
      color: '#5865F2', bannerUrl: '', logoUrl: '/logo.png',
      vi: {
        title: 'BẢNG GIÁ DỮ LIỆU KIỂM THỬ — {storeName}',
        lines: ['• Đây là dữ liệu giả lập để kiểm thử UI.', '• Không dùng để giao dịch thật.'],
        line1: '• Đây là dữ liệu giả lập để kiểm thử UI.',
        line2: '• Không dùng để giao dịch thật.',
        paymentTitle: 'PHƯƠNG THỨC THANH TOÁN', paymentMethods: 'BANK|MOMO|VIETQR',
        footerNote: 'TEST DATA — có thể reset bất kỳ lúc nào', placeholder: 'Chọn case cần kiểm thử...',
      },
    },
    sellers: {
      shop_common: {
        isShop: true, name: 'Tài khoản test chung',
        accounts: [{ bank: 'MB Bank', account: '0000009999', owner: 'FOUR AM TEST', qr: '' }],
      },
      '100000000000000001': {
        discordId: '100000000000000001', username: 'mint.seller', globalName: 'Minh Tú (Test)', name: 'Minh Tú (Test)', avatar: '',
        accounts: [{ bank: 'MB Bank', account: '0000001111', owner: 'NGUYEN MINH TU', qr: '' }],
      },
      '100000000000000002': {
        discordId: '100000000000000002', username: 'khoa.seller', globalName: 'Đăng Khoa (Test)', name: 'Đăng Khoa (Test)', avatar: '',
        accounts: [
          { bank: 'Vietcombank', account: '0000002222', owner: 'TRAN DANG KHOA', qr: '' },
          { bank: 'Techcombank', account: '0000003333', owner: 'TRAN DANG KHOA', qr: '' },
        ],
      },
      '100000000000000003': {
        discordId: '100000000000000003', username: 'linh.no-bank', globalName: 'Linh — Chưa có STK', name: 'Linh — Chưa có STK', avatar: '', accounts: [],
      },
    },
    categories: {
      owo: {
        label: 'OWO COIN — TEST', emoji: '🪙', title: 'OWO Coin test cases', titleEn: 'OWO Coin test cases',
        subtitle: 'Đơn thường và thanh toán thiếu/thừa', subtitleEn: 'Normal and mismatch payment cases',
        seller: '100000000000000001', handlers: [], accountIndex: '0', bannerUrl: '', color: 5793266,
        items: ['10M OWO | 85.000 VNĐ', '25M OWO | 200.000 VNĐ', '50M OWO | 390.000 VNĐ'], pingStaff: true, enabled: true,
      },
      vps: {
        label: 'VPS — TEST', emoji: '🖥️', title: 'VPS test cases', titleEn: 'VPS test cases',
        subtitle: 'Đơn đang xử lý và hoàn tất', subtitleEn: 'Processing and completed cases',
        seller: '100000000000000002', handlers: [], accountIndex: '0', bannerUrl: '', color: 15105570,
        items: ['VPS 2C/4GB | 250.000 VNĐ', 'VPS 4C/8GB | 500.000 VNĐ'], pingStaff: true, enabled: true,
      },
      bot: {
        label: 'DISCORD BOT — TEST', emoji: '🤖', title: 'Discord Bot test cases', titleEn: 'Discord Bot test cases',
        subtitle: 'Case hoàn tiền và hủy', subtitleEn: 'Refund and cancelled cases',
        seller: '100000000000000001', handlers: [], accountIndex: '0', bannerUrl: '', color: 3447003,
        items: ['Bot cơ bản | 150.000 VNĐ', 'Bot nâng cao | 320.000 VNĐ'], pingStaff: true, enabled: true,
      },
      hosting: {
        label: 'HOSTING — TEST', emoji: '☁️', title: 'Hosting config-error cases', titleEn: 'Hosting config-error cases',
        subtitle: 'Seller chưa cấu hình tài khoản ngân hàng', subtitleEn: 'Seller without bank configuration',
        seller: '100000000000000003', handlers: [], accountIndex: '0', bannerUrl: '', color: 10181046,
        items: ['Hosting 5GB | 99.000 VNĐ', 'Hosting 20GB | 180.000 VNĐ'], pingStaff: true, enabled: true,
      },
    },
    channels: {
      welcomeChannelId: '900000000000000004', menuViChannelId: '900000000000000003',
      ticketViChannelId: '900000000000000001', ticketCategoryId: '900000000000000002',
      orderCategoryId: '900000000000000005', customerRoleId: '900000000000000006',
    },
    ticketPanel: {
      color: '#5865F2', thumbnailUrl: '/logo.png', bannerUrl: '', channelNameVi: 'ticket-ui-test', ticketPrefix: 'test-ticket',
      vi: {
        title: 'TICKET KIỂM THỬ — {storeName}', subtitle: 'Dữ liệu giả lập cho admin và seller.',
        lines: ['• Test trạng thái đơn, thanh toán và phân quyền.', '• Không gửi thông tin thật vào ticket này.'],
        buttonLabel: 'Mở ticket test', welcomeTitle: 'TICKET TEST — {storeName}',
        welcomeMsg: 'Xin chào <@{userId}>, đây là ticket giả lập.', welcomeNote: 'Chỉ dùng để kiểm thử UI.',
      },
    },
  };
}

function orderRecord({
  id, orderNo, userId, productId, categoryKey, categoryLabel, selectedItem, sellerId, sellerName,
  amount, status, age, notes, paymentProvider = null, providerRef = null, archivedAt = null,
}) {
  const createdAt = hoursAgo(age);
  return {
    id, orderNo, userId, productId,
    planSnapshotJson: json({
      categoryKey, categoryLabel, selectedItem, notes, sellerId, sellerName,
      isTestData: true, testCase: notes, createdAt: createdAt.toISOString(),
    }),
    amountCents: amount, currency: 'VNĐ', status, paymentProvider, providerRef,
    createdAt, updatedAt: new Date(createdAt.getTime() + 12 * 60 * 1000), archivedAt,
  };
}

function transactionRecord({ id, transactionId, orderId = null, orderNo = null, amount, expectedAmount = null, status, age, account = '0000009999', content, source = 'GPM_WEBHOOK' }) {
  return {
    id, transactionId, orderId, orderNo, amount, expectedAmount, receivingAccount: account, status, source,
    rawPayloadJson: json({ gateway: source.includes('GPM') ? 'GPM Pay' : 'VietQR', content, testData: true }),
    processedAt: hoursAgo(age),
  };
}

function auditRecord({ id, orderId = null, action, actorType, actorId, age, before = null, after = null, metadata = {} }) {
  return {
    id, orderId, action, actorType, actorId,
    beforeJson: before ? json(before) : null, afterJson: after ? json(after) : null,
    metadataJson: json({ result: 'SUCCESS', source: 'ui-test-seed', ...metadata }), createdAt: hoursAgo(age),
  };
}

async function seed() {
  const products = [
    { id: 'test-product-owo', type: 'STORE_CATEGORY', name: 'OWO COIN — TEST', sku: 'TEST_OWO', specJson: json({ categoryKey: 'owo' }), priceCents: 85000, currency: 'VNĐ', active: true, createdAt: hoursAgo(240) },
    { id: 'test-product-vps', type: 'STORE_CATEGORY', name: 'VPS — TEST', sku: 'TEST_VPS', specJson: json({ categoryKey: 'vps' }), priceCents: 250000, currency: 'VNĐ', active: true, createdAt: hoursAgo(240) },
    { id: 'test-product-bot', type: 'STORE_CATEGORY', name: 'DISCORD BOT — TEST', sku: 'TEST_BOT', specJson: json({ categoryKey: 'bot' }), priceCents: 150000, currency: 'VNĐ', active: true, createdAt: hoursAgo(240) },
    { id: 'test-product-hosting', type: 'STORE_CATEGORY', name: 'HOSTING — TEST', sku: 'TEST_HOSTING', specJson: json({ categoryKey: 'hosting' }), priceCents: 99000, currency: 'VNĐ', active: true, createdAt: hoursAgo(240) },
  ];

  const users = [
    ['test-user-01', '200000000000000001', 'An'], ['test-user-02', '200000000000000002', 'Bình'],
    ['test-user-03', '200000000000000003', 'Chi'], ['test-user-04', '200000000000000004', 'Dũng'],
    ['test-user-05', '200000000000000005', 'Em'], ['test-user-06', '200000000000000006', 'Giang'],
    ['test-user-07', '200000000000000007', 'Hà'], ['test-user-08', '200000000000000008', 'Khánh'],
    ['test-user-09', '200000000000000009', 'Lan'], ['test-user-10', '200000000000000010', 'Minh'],
    ['test-user-11', '200000000000000011', 'Nam'], ['test-user-12', '200000000000000012', 'Oanh'],
    ['test-user-13', '200000000000000013', 'Phúc'], ['test-user-14', '200000000000000014', 'Quỳnh'],
    ['test-user-15', '200000000000000015', 'Trang'],
  ].map(([id, discordId, name], index) => ({ id, discordId, name, email: `test${index + 1}@example.invalid`, country: 'VN', createdAt: hoursAgo(300 - index) }));

  const orders = [
    orderRecord({ id: 'test-order-01', orderNo: '4AMT00001', userId: 'test-user-01', productId: 'test-product-owo', categoryKey: 'owo', categoryLabel: '10M OWO', selectedItem: '10M OWO', sellerId: '100000000000000001', sellerName: 'Minh Tú (Test)', amount: 85000, status: 'PENDING', age: 1, notes: 'CASE 01 — Chờ thanh toán, chưa có giao dịch.' }),
    orderRecord({ id: 'test-order-02', orderNo: '4AMT00002', userId: 'test-user-02', productId: 'test-product-owo', categoryKey: 'owo', categoryLabel: '25M OWO', selectedItem: '25M OWO', sellerId: '100000000000000001', sellerName: 'Minh Tú (Test)', amount: 100000, status: 'PENDING', age: 2, notes: 'CASE 02 — Chờ thanh toán qua QR.' }),
    orderRecord({ id: 'test-order-03', orderNo: '4AMT00003', userId: 'test-user-03', productId: 'test-product-owo', categoryKey: 'owo', categoryLabel: '30M OWO', selectedItem: '30M OWO', sellerId: '100000000000000001', sellerName: 'Minh Tú (Test)', amount: 120000, status: 'PENDING', age: 3, notes: 'CASE 03 — Chưa ghi nhận thanh toán.' }),
    orderRecord({ id: 'test-order-04', orderNo: '4AMT00004', userId: 'test-user-04', productId: 'test-product-vps', categoryKey: 'vps', categoryLabel: 'VPS 2C/4GB', selectedItem: 'VPS 2C/4GB', sellerId: '100000000000000002', sellerName: 'Đăng Khoa (Test)', amount: 250000, status: 'PAID', age: 4, notes: 'CASE 04 — Khớp tự động, chờ seller xử lý.', paymentProvider: 'GPM Pay', providerRef: 'TEST-TX-PAID' }),
    orderRecord({ id: 'test-order-05', orderNo: '4AMT00005', userId: 'test-user-05', productId: 'test-product-owo', categoryKey: 'owo', categoryLabel: 'Duyệt thủ công', selectedItem: 'Đơn tiền mặt', sellerId: '100000000000000001', sellerName: 'Minh Tú (Test)', amount: 45000, status: 'PAID', age: 6, notes: 'CASE 05 — Owner duyệt thanh toán thủ công.', paymentProvider: 'MANUAL', providerRef: 'TEST-MANUAL' }),
    orderRecord({ id: 'test-order-06', orderNo: '4AMT00006', userId: 'test-user-06', productId: 'test-product-vps', categoryKey: 'vps', categoryLabel: 'VPS 4C/8GB', selectedItem: 'VPS 4C/8GB', sellerId: '100000000000000002', sellerName: 'Đăng Khoa (Test)', amount: 500000, status: 'PROCESSING', age: 10, notes: 'CASE 06 — Seller đang giao hàng.', paymentProvider: 'GPM Pay', providerRef: 'TEST-TX-PROCESSING' }),
    orderRecord({ id: 'test-order-07', orderNo: '4AMT00007', userId: 'test-user-07', productId: 'test-product-owo', categoryKey: 'owo', categoryLabel: '50M OWO', selectedItem: '50M OWO', sellerId: '100000000000000001', sellerName: 'Minh Tú (Test)', amount: 390000, status: 'COMPLETED', age: 20, notes: 'CASE 07 — Hoàn tất bình thường.', paymentProvider: 'VietQR', providerRef: 'TEST-TX-COMPLETED' }),
    orderRecord({ id: 'test-order-08', orderNo: '4AMT00008', userId: 'test-user-08', productId: 'test-product-bot', categoryKey: 'bot', categoryLabel: 'Bot cơ bản', selectedItem: 'Bot cơ bản', sellerId: '100000000000000001', sellerName: 'Minh Tú (Test)', amount: 150000, status: 'CANCELLED', age: 26, notes: 'CASE 08 — Hủy do khách không thanh toán.' }),
    orderRecord({ id: 'test-order-09', orderNo: '4AMT00009', userId: 'test-user-09', productId: 'test-product-vps', categoryKey: 'vps', categoryLabel: 'VPS 4C/8GB', selectedItem: 'VPS 4C/8GB', sellerId: '100000000000000002', sellerName: 'Đăng Khoa (Test)', amount: 290000, status: 'CANCELLED', age: 30, notes: 'CASE 09 — Đơn đã thanh toán rồi được hủy.', paymentProvider: 'GPM Pay', providerRef: 'TEST-TX-CANCELLED-01' }),
    orderRecord({ id: 'test-order-10', orderNo: '4AMT00010', userId: 'test-user-10', productId: 'test-product-hosting', categoryKey: 'hosting', categoryLabel: 'Hosting 5GB', selectedItem: 'Hosting 5GB', sellerId: '100000000000000003', sellerName: 'Linh — Chưa có STK', amount: 99000, status: 'CANCELLED', age: 48, notes: 'CASE 10 — Đơn đã thanh toán rồi được hủy.', paymentProvider: 'GPM Pay', providerRef: 'TEST-TX-CANCELLED-02' }),
    orderRecord({ id: 'test-order-11', orderNo: '4AMT00011', userId: 'test-user-11', productId: 'test-product-bot', categoryKey: 'bot', categoryLabel: 'Bot nâng cao', selectedItem: 'Bot nâng cao', sellerId: '100000000000000001', sellerName: 'Minh Tú (Test)', amount: 175000, status: 'FAILED', age: 56, notes: 'CASE 11 — Tiền vào sai tài khoản nhận.' }),
    orderRecord({ id: 'test-order-12', orderNo: '4AMT00012', userId: 'test-user-12', productId: 'test-product-bot', categoryKey: 'bot', categoryLabel: 'Bot nâng cao', selectedItem: 'Bot nâng cao', sellerId: '100000000000000001', sellerName: 'Minh Tú (Test)', amount: 320000, status: 'DELIVERED', age: 70, notes: 'CASE 12 — Legacy DELIVERED được map sang Hoàn tất.', paymentProvider: 'VietQR', providerRef: 'TEST-TX-DELIVERED' }),
    orderRecord({ id: 'test-order-13', orderNo: '4AMT00013', userId: 'test-user-13', productId: 'test-product-vps', categoryKey: 'vps', categoryLabel: 'VPS chuyển trùng', selectedItem: 'VPS 2C/4GB', sellerId: '100000000000000002', sellerName: 'Đăng Khoa (Test)', amount: 210000, status: 'PAID', age: 80, notes: 'CASE 13 — Đơn đã thanh toán nhưng khách chuyển thêm lần nữa.', paymentProvider: 'GPM Pay', providerRef: 'TEST-TX-DUPLICATE' }),
    orderRecord({ id: 'test-order-14', orderNo: '4AMT00014', userId: 'test-user-14', productId: 'test-product-hosting', categoryKey: 'hosting', categoryLabel: 'Hosting 20GB', selectedItem: 'Hosting 20GB', sellerId: '100000000000000003', sellerName: 'Linh — Chưa có STK', amount: 180000, status: 'PENDING', age: 90, notes: 'CASE 14 — Seller chưa cấu hình tài khoản nhận.' }),
    orderRecord({ id: 'test-order-15', orderNo: '4AMT00015', userId: 'test-user-15', productId: 'test-product-owo', categoryKey: 'owo', categoryLabel: 'Đơn đã lưu trữ', selectedItem: '10M OWO', sellerId: '100000000000000001', sellerName: 'Minh Tú (Test)', amount: 85000, status: 'COMPLETED', age: 120, notes: 'CASE 15 — Đơn lưu trữ, không xuất hiện trong danh sách.', paymentProvider: 'MANUAL', providerRef: 'TEST-ARCHIVED', archivedAt: hoursAgo(24) }),
  ];

  const tickets = orders.slice(0, 14).map((order, index) => ({
    id: `test-ticket-${String(index + 1).padStart(2, '0')}`,
    guildId: '900000000000000000', channelId: `9100000000000000${String(index + 1).padStart(2, '0')}`,
    orderId: order.id, userId: order.userId,
    status: ['COMPLETED', 'CANCELLED'].includes(order.status) ? 'CLOSED' : 'OPEN', createdAt: order.createdAt,
  }));

  const transactions = [
    transactionRecord({ id: 'test-tx-03', transactionId: 'FT-MATCHED-001', orderId: 'test-order-04', orderNo: '4AMT00004', amount: 250000, expectedAmount: 250000, status: 'SUCCESS', age: 3.8, content: '4AMT00004 thanh toan' }),
    transactionRecord({ id: 'test-tx-04', transactionId: 'FT-PROCESSING-001', orderId: 'test-order-06', orderNo: '4AMT00006', amount: 500000, expectedAmount: 500000, status: 'SUCCESS', age: 9.8, content: '4AMT00006 thanh toan' }),
    transactionRecord({ id: 'test-tx-05', transactionId: 'FT-COMPLETED-001', orderId: 'test-order-07', orderNo: '4AMT00007', amount: 390000, expectedAmount: 390000, status: 'SUCCESS', age: 19.8, content: '4AMT00007 thanh toan', source: 'VIETQR_POLLING' }),
    transactionRecord({ id: 'test-tx-06', transactionId: 'FT-CANCELLED-001', orderId: 'test-order-09', orderNo: '4AMT00009', amount: 290000, expectedAmount: 290000, status: 'SUCCESS', age: 29.8, content: '4AMT00009 thanh toan' }),
    transactionRecord({ id: 'test-tx-07', transactionId: 'FT-CANCELLED-002', orderId: 'test-order-10', orderNo: '4AMT00010', amount: 99000, expectedAmount: 99000, status: 'SUCCESS', age: 47.8, content: '4AMT00010 thanh toan' }),
    transactionRecord({ id: 'test-tx-08', transactionId: 'FT-WRONG-ACCOUNT', orderId: 'test-order-11', orderNo: '4AMT00011', amount: 175000, expectedAmount: 175000, status: 'UNAUTHORIZED_RECEIVER_ACCOUNT', age: 55.8, account: '9999999999', content: '4AMT00011 sai tai khoan nhan' }),
    transactionRecord({ id: 'test-tx-09', transactionId: 'FT-DELIVERED-001', orderId: 'test-order-12', orderNo: '4AMT00012', amount: 320000, expectedAmount: 320000, status: 'SUCCESS', age: 69.8, content: '4AMT00012 thanh toan', source: 'VIETQR_POLLING' }),
    transactionRecord({ id: 'test-tx-10', transactionId: 'FT-DUPLICATE-OK', orderId: 'test-order-13', orderNo: '4AMT00013', amount: 210000, expectedAmount: 210000, status: 'SUCCESS', age: 79.8, content: '4AMT00013 thanh toan lan 1' }),
    transactionRecord({ id: 'test-tx-11', transactionId: 'FT-DUPLICATE-002', orderId: 'test-order-13', orderNo: '4AMT00013', amount: 210000, expectedAmount: 210000, status: 'ORDER_ALREADY_PAID', age: 79.2, content: '4AMT00013 thanh toan lan 2' }),
    transactionRecord({ id: 'test-tx-12', transactionId: 'FT-MISSING-BANK', orderId: 'test-order-14', orderNo: '4AMT00014', amount: 180000, expectedAmount: 180000, status: 'MISSING_RECEIVING_ACCOUNT', age: 89.8, account: '', content: '4AMT00014 seller chua co stk' }),
    transactionRecord({ id: 'test-tx-13', transactionId: 'FT-UNKNOWN-CODE', amount: 125000, status: 'UNKNOWN_ORDER_CODE', age: 5, content: 'CHUYEN TIEN MUA HANG KHONG CO MA DON' }),
    transactionRecord({ id: 'test-tx-14', transactionId: 'FT-ORDER-NOT-FOUND', orderNo: '4AM999999', amount: 88000, status: 'ORDER_NOT_FOUND', age: 7, content: '4AM999999 thanh toan' }),
    transactionRecord({ id: 'test-tx-15', transactionId: 'FT-CONFIG-ERROR', amount: 0, status: 'PAYMENT_CONFIG_ERROR', age: 12, account: '', content: 'Webhook signature invalid' }),
  ];

  const audits = [
    ...orders.slice(0, 14).map((order, index) => auditRecord({ id: `test-audit-create-${String(index + 1).padStart(2, '0')}`, orderId: order.id, action: 'ORDER_UPDATED', actorType: 'SYSTEM', actorId: 'ui-test-seed', age: Math.max(0.1, (order.createdAt.getTime() - now) / -3600000 - 0.05), after: { status: order.status }, metadata: { reason: order.planSnapshotJson.includes('CASE') ? 'Khởi tạo case kiểm thử' : '' } })),
    auditRecord({ id: 'test-audit-payment-01', orderId: 'test-order-04', action: 'PAYMENT_CONFIRMED', actorType: 'SYSTEM', actorId: 'gpm-webhook-test', age: 3.7, before: { status: 'PENDING' }, after: { status: 'PAID' }, metadata: { transactionId: 'FT-MATCHED-001', amount: 250000 } }),
    auditRecord({ id: 'test-audit-manual-01', orderId: 'test-order-05', action: 'PAYMENT_MANUALLY_APPROVED', actorType: 'ADMIN', actorId: 'admin', age: 5.8, before: { status: 'PENDING' }, after: { status: 'PAID' }, metadata: { reason: 'Khách thanh toán tiền mặt tại quầy test' } }),
    auditRecord({ id: 'test-audit-start-01', orderId: 'test-order-06', action: 'ORDER_STATUS_CHANGED', actorType: 'SELLER', actorId: 'seller.khoa', age: 8, before: { status: 'PAID' }, after: { status: 'PROCESSING' }, metadata: { workflowAction: 'start' } }),
    auditRecord({ id: 'test-audit-complete-01', orderId: 'test-order-07', action: 'ORDER_COMPLETED_BY_SELLER', actorType: 'SELLER', actorId: 'seller.mint', age: 18, before: { status: 'PROCESSING' }, after: { status: 'COMPLETED' }, metadata: { workflowAction: 'complete' } }),
    auditRecord({ id: 'test-audit-cancel-01', orderId: 'test-order-08', action: 'ORDER_STATUS_CHANGED', actorType: 'ADMIN', actorId: 'admin', age: 24, before: { status: 'PENDING' }, after: { status: 'CANCELLED' }, metadata: { reason: 'Khách không thanh toán sau 24 giờ' } }),
    auditRecord({ id: 'test-audit-cancel-paid-01', orderId: 'test-order-09', action: 'ORDER_STATUS_CHANGED', actorType: 'ADMIN', actorId: 'admin', age: 28, before: { status: 'PAID' }, after: { status: 'CANCELLED' }, metadata: { reason: 'Hủy đơn sau thanh toán để kiểm thử tách trạng thái đơn và payment' } }),
    auditRecord({ id: 'test-audit-cancel-paid-02', orderId: 'test-order-10', action: 'ORDER_STATUS_CHANGED', actorType: 'ADMIN', actorId: 'admin', age: 46, before: { status: 'PAID' }, after: { status: 'CANCELLED' }, metadata: { reason: 'Hủy đơn sau thanh toán để kiểm thử tách trạng thái đơn và payment' } }),
    auditRecord({ id: 'test-audit-rejected-01', orderId: 'test-order-11', action: 'PAYMENT_REJECTED', actorType: 'SYSTEM', actorId: 'gpm-webhook-test', age: 55.7, after: { transactionStatus: 'UNAUTHORIZED_RECEIVER_ACCOUNT' }, metadata: { result: 'FAILED', transactionId: 'FT-WRONG-ACCOUNT', reason: 'Tiền vào tài khoản không được phép' } }),
    auditRecord({ id: 'test-audit-handled-01', orderId: 'test-order-11', action: 'TRANSACTION_HANDLED_CHANGED', actorType: 'ADMIN', actorId: 'admin', age: 54, before: { handled: false }, after: { handled: true }, metadata: { transactionRecordId: 'test-tx-08', transactionId: 'FT-WRONG-ACCOUNT', reason: 'Đã liên hệ khách để xử lý riêng' } }),
    auditRecord({ id: 'test-audit-config-01', action: 'PAYMENT_REJECTED', actorType: 'SYSTEM', actorId: 'gpm-webhook-test', age: 11.9, after: { transactionStatus: 'PAYMENT_CONFIG_ERROR' }, metadata: { result: 'FAILED', transactionId: 'FT-CONFIG-ERROR', reason: 'Chữ ký webhook test không hợp lệ' } }),
    auditRecord({ id: 'test-audit-product-01', action: 'PRODUCT_CHANGED', actorType: 'ADMIN', actorId: 'admin', age: 16, before: { price: 80000 }, after: { price: 85000 }, metadata: { targetId: 'owo', reason: 'Test hiển thị diff giá sản phẩm' } }),
    auditRecord({ id: 'test-audit-seller-01', action: 'SELLER_PERMISSIONS_CHANGED', actorType: 'ADMIN', actorId: 'admin', age: 14, before: { permissions: ['orders.read'] }, after: { permissions: ['orders.read', 'orders.complete_own'] }, metadata: { targetId: 'seller.khoa' } }),
    auditRecord({ id: 'test-audit-sync-01', action: 'DISCORD_DRAFT_SAVED', actorType: 'ADMIN', actorId: 'admin', age: 9, after: { saved: true }, metadata: { reason: 'Test lưu nháp, không đồng bộ Discord thật' } }),
  ];

  const subscriptions = [
    { id: 'test-sub-01', userId: 'test-user-07', productId: 'test-product-owo', lastOrderId: 'test-order-07', status: 'ACTIVE', currentPeriodEnd: hoursAgo(-240), remindedExpiry: false, createdAt: hoursAgo(20), updatedAt: hoursAgo(18) },
    { id: 'test-sub-02', userId: 'test-user-12', productId: 'test-product-bot', lastOrderId: 'test-order-12', status: 'EXPIRED', currentPeriodEnd: hoursAgo(24), remindedExpiry: true, createdAt: hoursAgo(720), updatedAt: hoursAgo(24) },
  ];

  await prisma.$transaction(async (tx) => {
    await tx.auditLog.deleteMany();
    await tx.paymentTransaction.deleteMany();
    await tx.ticket.deleteMany();
    await tx.subscription.deleteMany();
    await tx.order.deleteMany();
    await tx.product.deleteMany();
    await tx.user.deleteMany();

    await tx.product.createMany({ data: products });
    await tx.user.createMany({ data: users });
    await tx.order.createMany({ data: orders });
    await tx.ticket.createMany({ data: tickets });
    await tx.paymentTransaction.createMany({ data: transactions });
    await tx.auditLog.createMany({ data: audits });
    await tx.subscription.createMany({ data: subscriptions });
  }, { timeout: 20000 });

  const [mintPassword, khoaPassword, lockedPassword] = await Promise.all([
    hashPassword(sellerPassword), hashPassword(sellerPassword), hashPassword(sellerPassword),
  ]);
  writeJsonAtomic(menuDataPath, testMenuData());
  writeJsonAtomic(dashboardUsersPath, [
    { username: 'seller.mint', sellerKey: '100000000000000001', permissions: ['orders.read', 'orders.complete_own', 'orders.edit', 'products.edit'], enabled: true, createdAt: new Date().toISOString(), password: mintPassword },
    { username: 'seller.khoa', sellerKey: '100000000000000002', permissions: ['orders.read', 'orders.complete_own'], enabled: true, createdAt: new Date().toISOString(), password: khoaPassword },
    { username: 'seller.locked', sellerKey: '100000000000000003', permissions: ['orders.read'], enabled: false, createdAt: new Date().toISOString(), password: lockedPassword },
  ]);

  const counts = {
    users: await prisma.user.count(), products: await prisma.product.count(), orders: await prisma.order.count(),
    visibleOrders: await prisma.order.count({ where: { archivedAt: null } }), tickets: await prisma.ticket.count(),
    transactions: await prisma.paymentTransaction.count(), auditLogs: await prisma.auditLog.count(), subscriptions: await prisma.subscription.count(),
  };
  console.log('UI test data seeded successfully.');
  console.log(JSON.stringify(counts, null, 2));
  console.log(`Seller accounts: seller.mint / ${sellerPassword}, seller.khoa / ${sellerPassword}`);
  console.log('Locked-account case: seller.locked / seller123 (login must fail).');
}

seed()
  .catch((error) => {
    console.error('Failed to seed UI test data:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
