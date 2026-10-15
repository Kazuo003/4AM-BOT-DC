/* Demo mode — ONLY active with ?demo=1. Fake in-memory data for previewing the UI without the Express backend.
   Never loaded as a data source in production (no ?demo param = real API). Names/IDs/accounts are fictitious. */
(function () {
  const enabled = new URLSearchParams(location.search).has('demo');
  if (!enabled) { window.Demo = { enabled: false }; return; }
  const now = Date.now(), H = 3600e3;
  const iso = (ms) => new Date(now - ms).toISOString();
  const sellers = [
    { id: '100000000000000001', username: 'mint.seller', globalName: 'Minh Tú', avatar: '', banks: [{ bankName: 'MB Bank', account: '0000009999', owner: 'NGUYEN MINH TU', qr: '' }] },
    { id: '100000000000000002', username: 'khoa.dev', globalName: 'Đăng Khoa', avatar: '', banks: [{ bankName: 'Vietcombank', account: '0000001111', owner: 'TRAN DANG KHOA', qr: '' }, { bankName: 'Techcombank', account: '0000002222', owner: 'TRAN DANG KHOA', qr: '' }] },
    { id: '100000000000000003', username: 'linh.host', globalName: 'Linh', avatar: '', banks: [] },
  ];
  const db = {
    data: {
      botName: '4AM STORE', botOnline: true, guildId: '', sellers,
      products: [
        { id: 'p1', key: 'owo', name: 'OWO COIN', emoji: '🪙', title: 'OWO COIN — Giá theo số lượng', titleEn: 'OWO COIN — Tiered pricing', subtitle: 'Giao trong 5–15 phút sau khi thanh toán.\nHỗ trợ 24/7 qua ticket.', subtitleEn: 'Delivered in 5–15 minutes after payment.\n24/7 support via ticket.', banner: '', color: '#5865F2', sellerId: sellers[0].id, handlers: [sellers[1].id], bankIndex: 0, pingStaff: true, items: [{ label: '0 – 50M', price: 9000 }, { label: '51 – 100M', price: 8500 }, { label: '101 – 200M', price: 8000 }] },
        { id: 'p2', key: 'vps', name: 'VPS', emoji: '🖥️', title: 'VPS Việt Nam', titleEn: 'Vietnam VPS', subtitle: 'SSD NVMe, IP riêng, gia hạn theo tháng.', subtitleEn: 'NVMe SSD, dedicated IP, monthly billing.', banner: '', color: '#38BDF8', sellerId: sellers[1].id, handlers: [], bankIndex: 1, pingStaff: false, items: [{ label: '2 vCPU · 4GB', price: 150000 }, { label: '4 vCPU · 8GB', price: 290000 }] },
        { id: 'p3', key: 'bot', name: 'Discord Bot', emoji: '🤖', title: 'Bot Discord theo yêu cầu', titleEn: 'Custom Discord bot', subtitle: 'Code riêng, bàn giao source.', subtitleEn: 'Custom code, source included.', banner: '', color: '#22C55E', sellerId: sellers[1].id, handlers: [sellers[0].id], bankIndex: 0, pingStaff: true, items: [{ label: 'Gói cơ bản', price: 500000 }] },
        { id: 'p4', key: 'hosting', name: 'Web Hosting', emoji: '🌐', title: 'Web Hosting', titleEn: 'Web Hosting', subtitle: 'cPanel, SSL miễn phí.', subtitleEn: 'cPanel, free SSL.', banner: '', color: '#F59E0B', sellerId: sellers[2].id, handlers: [], bankIndex: 0, pingStaff: false, items: [{ label: '1GB', price: 50000 }, { label: '5GB', price: 120000 }] },
      ],
      menu: { shopName: '4AM STORE', title: 'Chào mừng đến 4AM STORE', lines: ['Chọn sản phẩm ở menu bên dưới.', 'Bot sẽ mở ticket riêng cho bạn.', 'Thanh toán qua chuyển khoản / VietQR.'], payTitle: 'Phương thức thanh toán', payMethods: ['Chuyển khoản ngân hàng', 'VietQR'], footer: '4AM STORE · Hỗ trợ 24/7', placeholder: 'Chọn sản phẩm bạn muốn mua…', banner: '', logo: '/logo.png', color: '#5865F2', menuChannelId: '', ticketChannelId: '' },
      ticket: { title: 'Hỗ trợ & mua hàng', subtitle: 'Mở ticket để được seller hỗ trợ trực tiếp.', lines: ['Mỗi ticket chỉ xử lý một đơn.', 'Không ping staff liên tục.'], buttonLabel: 'Mở ticket', welcomeTitle: 'Xin chào {user}!', welcomeMessage: 'Seller sẽ phản hồi trong ít phút.', welcomeNote: 'Vui lòng ghi rõ sản phẩm và số lượng.', prefix: 'ticket', thumbnail: '', banner: '', color: '#5865F2', channelId: '', categoryId: '' },
    },
    orders: [], tx: [], audit: [],
    users: [{ username: 'mint', sellerId: sellers[0].id, permissions: ['orders.read', 'orders.complete_own'], locked: false }, { username: 'khoa', sellerId: sellers[1].id, permissions: ['orders.read', 'orders.complete_own', 'orders.edit', 'products.edit'], locked: false }],
    me: null,
  };
  const customers = ['Hoàng Nam', 'Bảo Anh', 'Quang Huy', 'Thảo Vy', 'Gia Bảo', 'Phương Linh', 'Đức Anh', 'Mai Chi', 'Tuấn Kiệt', 'Ngọc Hân'];
  // Seed covers the order workflow while payment itself remains binary: unpaid or paid.
  const legacy = ['PENDING', 'PAID', 'PROCESSING', 'DELIVERED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'CANCELLED', 'PAID', 'PENDING', 'PENDING', 'COMPLETED', 'COMPLETED', 'CANCELLED'];
  const PAID_LEGACY = ['PAID', 'PROCESSING', 'DELIVERED', 'COMPLETED'];
  const plus = (isoStr, min) => new Date(new Date(isoStr).getTime() + min * 60e3).toISOString();
  let seq = 0; const nextId = (p) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
  const audit = (e) => db.audit.push({ id: nextId('a'), result: 'SUCCESS', ip: '113.161.xx.xx', source: 'dashboard', metadata: {}, ...e });
  for (let i = 0; i < 26; i++) {
    const p = db.data.products[i % 4], st = legacy[i % legacy.length], item = p.items[i % p.items.length];
    const amt = p.key === 'owo' ? item.price * (5 + (i % 6) * 5) : item.price;
    const createdAt = iso(i * 5.3 * H + 2 * H);
    db.orders.push({ id: `o${i}`, orderNo: `4AM${String(24051 + i).padStart(6, '0')}`, status: st, service: p.key === 'owo' ? `${(5 + (i % 6) * 5)}M OWO` : `${p.name} · ${item.label}`, productKey: p.key, amount: amt, customerName: customers[i % 10], discordId: `20000000000000${String(1000 + i)}`, customerAvatar: '', sellerId: p.sellerId, ticketChannelId: `30000000000000${String(1000 + i)}`, ticketChannelName: `ticket-${String(24051 + i)}`, ticketOpen: !['COMPLETED', 'CANCELLED'].includes(st), createdAt, updatedAt: createdAt, provider: '', transactionId: '', notes: i % 4 === 0 ? 'Khách yêu cầu giao vào acc phụ.' : '' });
  }
  const O = (i) => db.orders[i];
  let txn = 0;
  const tx = (o, status, extra = {}) => { const n = extra.n ?? txn++; delete extra.n; const t = { id: `t${n}`, transactionId: `FT${26100000 + n * 997}`, orderCode: o?.orderNo || '', description: o ? `${o.orderNo} ${o.customerName.toUpperCase()}` : '', orderId: o?.id ?? null, amount: o?.amount || 150000, expectedAmount: o?.amount ?? null, receiverAccount: '•••• 9999', provider: n % 3 ? 'GPM Pay' : 'VietQR', source: n % 3 ? 'WEBHOOK' : 'POLLING', createdAt: o ? plus(o.createdAt, 12) : iso(n * 2.2 * H), status, handled: false, ...extra }; t.raw = { gateway: t.provider, event: 'transaction.received', data: { id: t.transactionId, amount: t.amount, description: t.description, account: t.receiverAccount, when: t.createdAt } }; db.tx.push(t); return t; };
  // Matched transactions. Fixed slots so FT26100000→4AM024051, FT26104985→4AM024061, FT26106979→4AM024065.
  const matchList = [0, ...db.orders.map((o, i) => i).filter((i) => i !== 5 && PAID_LEGACY.includes(O(i).status))];
  matchList.splice(5, 0, 10); matchList.splice(7, 0, 14);
  matchList.forEach((i) => { const t = tx(O(i), 'MATCHED'); audit({ createdAt: t.createdAt, actorType: 'SYSTEM', actorId: 'gpm-webhook', action: 'PAYMENT_CONFIRMED', orderId: O(i).orderNo, targetId: t.transactionId, before: { orderStatus: 'PENDING_PAYMENT', paymentStatus: 'UNPAID' }, after: { orderStatus: 'READY', paymentStatus: 'PAID' }, ip: '', source: t.source.toLowerCase(), metadata: { transactionId: t.transactionId, amount: t.amount } }); });
  O(5).provider = 'MANUAL'; O(5).paymentStatus = 'PAID';
  audit({ createdAt: plus(O(5).createdAt, 15), actorType: 'ADMIN', actorId: 'owner', action: 'PAYMENT_MANUALLY_APPROVED', orderId: O(5).orderNo, targetId: O(5).id, before: { orderStatus: 'PENDING_PAYMENT', paymentStatus: 'UNPAID' }, after: { orderStatus: 'READY', paymentStatus: 'PAID' }, metadata: { reason: 'Khách chuyển tiền mặt tại quầy' } });
  // Needs review / config errors (never change order status automatically)
  tx(O(1), 'ORDER_ALREADY_PAID', { createdAt: plus(O(1).createdAt, 90) });
  tx(null, 'UNKNOWN_ORDER_CODE', { description: 'CK CHUYEN TIEN MUA HANG', amount: 120000 });
  tx(null, 'ORDER_NOT_FOUND', { orderCode: '4AM009999', description: '4AM009999 THANH TOAN', amount: 50000 });
  tx(O(23), 'UNAUTHORIZED_RECEIVER_ACCOUNT', { receiverAccount: '•••• 4321' });
  tx(null, 'MISSING_RECEIVING_ACCOUNT', { orderCode: '4AM024075', description: '4AM024075 LINH HOST', receiverAccount: '', amount: 50000 });
  tx(null, 'PAYMENT_CONFIG_ERROR', { description: 'Webhook chữ ký không hợp lệ', amount: 0 });
  db.tx.filter((t) => t.status !== 'MATCHED').forEach((t) => audit({ createdAt: t.createdAt, actorType: 'SYSTEM', actorId: 'gpm-webhook', action: 'PAYMENT_REJECTED', orderId: t.orderCode || '', targetId: t.transactionId, result: 'FAILED', ip: '', source: t.source.toLowerCase(), before: null, after: { transactionStatus: t.status }, metadata: { amount: t.amount, receiver: t.receiverAccount } }));
  // Workflow history in the new model
  db.orders.forEach((o) => {
    const by = sellers.find((x) => x.id === o.sellerId)?.username || 'seller';
    const step = (k, from, to, actorType = 'SELLER', actorId = by, meta = {}) => audit({ createdAt: plus(o.createdAt, 20 + k * 25), actorType, actorId, action: to === 'COMPLETED' && actorType === 'SELLER' ? 'ORDER_COMPLETED_BY_SELLER' : 'ORDER_STATUS_CHANGED', orderId: o.orderNo, targetId: o.id, before: { orderStatus: from }, after: { orderStatus: to }, metadata: meta });
    if (['PROCESSING', 'DELIVERED', 'COMPLETED'].includes(o.status)) step(1, 'READY', 'PROCESSING');
    if (['DELIVERED', 'COMPLETED'].includes(o.status)) step(2, 'PROCESSING', 'COMPLETED');
    if (o.status === 'CANCELLED') step(1, 'PENDING_PAYMENT', 'CANCELLED', 'ADMIN', 'owner', { reason: 'Khách không chuyển khoản sau 24 giờ' });
  });
  audit({ createdAt: iso(30 * H), actorType: 'ADMIN', actorId: 'owner', action: 'DISCORD_SYNCED', targetId: 'menu', before: null, after: { scope: 'menu' }, metadata: { channel: '#mua-hang' } });
  db.orders = OrderRules.reconcile(db.orders, db.tx);
  db.audit.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  db.publish = { menu: { at: iso(30 * H), by: 'owner' }, ticket: { at: iso(72 * H), by: 'owner' } };
  db.data.guildName = '4AM STORE Community'; db.data.menuChannelName = '#mua-hang'; db.data.ticketChannelName = '#tao-ticket';

  const R_GROUP = (st) => OrderRules.txGroup(st);
  const wait = (v, ms = 280) => new Promise((r) => setTimeout(() => r(JSON.parse(JSON.stringify(v))), ms));
  const err = (status, message) => Promise.reject(new API.ApiError(status, message));
  const isAdmin = () => db.me?.role === 'admin';
  function handle(method, url, body) {
    const u = new URL(url, location.origin); const p = u.pathname; const m = method;
    if (p === '/api/login') { const name = (body.username || '').toLowerCase(); db.me = name.startsWith('seller') || name === 'mint' ? { username: 'mint', displayName: 'Minh Tú', role: 'seller', sellerId: sellers[0].id, permissions: ['orders.read', 'orders.complete_own', 'orders.edit'] } : { username: body.username || 'owner', displayName: 'Owner', role: 'admin', permissions: [] }; sessionStorage.setItem('4am_demo_me', JSON.stringify(db.me)); return wait({ token: 'demo-token', user: db.me }); }
    if (!db.me) { try { db.me = JSON.parse(sessionStorage.getItem('4am_demo_me')); } catch { /* */ } }
    if (!db.me) return err(401, 'Chưa đăng nhập');
    if (p === '/api/me') return wait(db.me, 120);
    if (p === '/api/logout') { db.me = null; sessionStorage.removeItem('4am_demo_me'); return wait({ ok: true }); }
    if (p === '/api/data' && m === 'GET') return wait({ ...db.data, publish: db.publish });
    if (['/api/save', '/api/save-and-sync'].includes(p)) { const { draft, ...rest } = body || {}; Object.assign(db.data, rest); if (p === '/api/save-and-sync') { const at = new Date().toISOString(); db.publish.menu = { at, by: db.me.username }; db.publish.ticket = { at, by: db.me.username }; } return wait({ ok: true, publish: db.publish }, 600); }
    if (['/api/sync', '/api/sync-ticket', '/api/setup-bilingual-server'].includes(p)) { const at = new Date().toISOString(); if (p !== '/api/sync-ticket') db.publish.menu = { at, by: db.me.username }; if (p !== '/api/sync') db.publish.ticket = { at, by: db.me.username }; return wait({ ok: true, publish: db.publish }, 900); }
    if (p === '/api/translate') return wait({ text: body?.text || '' });
    if (p === '/api/bot-emojis') return wait([]);
    if (p.startsWith('/api/discord-user/')) { const id = p.split('/').pop(); return /^\d{15,20}$/.test(id) ? wait({ id, username: 'new.seller', globalName: 'Seller mới', avatar: '' }) : err(404, 'Không tìm thấy người dùng Discord'); }
    if (p === '/api/orders' && m === 'GET') { db.orders = OrderRules.reconcile(db.orders, db.tx); return wait(isAdmin() ? db.orders : db.orders.filter((o) => o.sellerId === db.me.sellerId)); }
    if (p === '/api/orders/create') { if (!isAdmin()) return err(403, 'Không đủ quyền'); const o = { id: `o${Date.now()}`, orderNo: `4AM${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`, paymentStatus: body.status === 'READY' ? 'PAID' : 'UNPAID', ticketOpen: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), provider: body.status === 'READY' ? 'MANUAL' : '', ...body }; db.orders.unshift(o); return wait(o); }
    let mm = p.match(/^\/api\/orders\/([^/]+)(?:\/(.+))?$/);
    if (mm) { const o = db.orders.find((x) => x.id === mm[1]); if (!o) return err(404, 'Không tìm thấy đơn'); const act = mm[2];
      if (m === 'DELETE') { if (!isAdmin()) return err(403, 'Không đủ quyền'); audit({ createdAt: new Date().toISOString(), actorType: 'ADMIN', actorId: db.me.username, action: 'ORDER_ARCHIVED', orderId: o.orderNo, targetId: o.id, before: { archived: false }, after: { archived: true } }); db.audit.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); db.orders = db.orders.filter((x) => x !== o); return wait({ ok: true }); }
      if (act === 'status' && !isAdmin()) { const ok = OrderRules.allowedActions(o, db.me).some((k) => OrderRules.ACTIONS[k].to === body.status && !OrderRules.ACTIONS[k].pay); if (!ok) return err(403, 'Không đủ quyền đổi trạng thái này'); }
      else if (!isAdmin() && act !== 'update') return err(403, 'Không đủ quyền');
      if (act === 'status') {
        const a = OrderRules.ACTIONS[body.action]; if (!a || !OrderRules.canRun(body.action, o, db.me)) return err(409, 'Thao tác không hợp lệ với trạng thái hiện tại');
        const before = { orderStatus: o.status, paymentStatus: o.paymentStatus }; o.status = a.to; if (a.pay) o.paymentStatus = a.pay;
        if (body.action === 'manualApprove') { o.provider = 'MANUAL'; if (body.transactionId) { const t = db.tx.find((x) => x.transactionId === body.transactionId); if (t) { t.handled = true; o.transactionId = t.transactionId; } } }
        const action = body.action === 'manualApprove' ? 'PAYMENT_MANUALLY_APPROVED' : (a.to === 'COMPLETED' && !isAdmin() ? 'ORDER_COMPLETED_BY_SELLER' : 'ORDER_STATUS_CHANGED');
        audit({ createdAt: new Date().toISOString(), actorType: isAdmin() ? 'ADMIN' : 'SELLER', actorId: db.me.username, action, orderId: o.orderNo, targetId: o.id, before, after: { orderStatus: o.status, paymentStatus: o.paymentStatus }, metadata: body.reason ? { reason: body.reason } : {} });
        db.audit.sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt)); }
      if (act === 'amount') { audit({ createdAt: new Date().toISOString(), actorType: 'ADMIN', actorId: db.me.username, action: 'ORDER_AMOUNT_CHANGED', orderId: o.orderNo, targetId: o.id, before: { amount: o.amount }, after: { amount: body.amount }, metadata: body.reason ? { reason: body.reason } : {} }); o.amount = body.amount; db.audit.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); }
      if (act === 'update') Object.assign(o, isAdmin() ? body : { notes: body.notes });
      o.updatedAt = new Date().toISOString(); return wait(o); }
    if (p === '/api/payment-transactions') { if (!isAdmin()) return err(403, 'Không đủ quyền'); const s = u.searchParams.get('status'); db.orders = OrderRules.reconcile(db.orders, db.tx); return wait(s ? db.tx.filter((t) => t.status === s) : db.tx); }
    mm = p.match(/^\/api\/payment-transactions\/([^/]+)\/(handled|attach)$/);
    if (mm) { if (!isAdmin()) return err(403, 'Không đủ quyền'); const t = db.tx.find((x) => x.id === mm[1]); if (!t) return err(404, 'Không tìm thấy giao dịch'); if (mm[2] === 'handled') t.handled = !!body.handled; else { const o = db.orders.find((x) => x.id === body.orderId || x.orderNo === body.orderId); if (!o) return err(404, 'Không tìm thấy đơn với mã này'); t.orderId = o.id; t.orderCode = o.orderNo; t.expectedAmount = o.amount; if (R_GROUP(t.status) !== 'config') t.status = t.amount === o.amount ? 'MATCHED' : 'AMOUNT_MISMATCH'; t.autoHandled = false; t.handled = t.status !== 'MATCHED' ? false : t.handled; } audit({ createdAt: new Date().toISOString(), actorType: 'ADMIN', actorId: db.me.username, action: mm[2] === 'handled' ? 'TRANSACTION_HANDLED_CHANGED' : 'TRANSACTION_ATTACHED', orderId: t.orderCode, targetId: t.transactionId, before: null, after: { handled: t.handled, orderId: t.orderId }, metadata: body.reason ? { reason: body.reason } : {} }); db.audit.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); db.orders = OrderRules.reconcile(db.orders, db.tx); return wait(t); }
    if (p === '/api/audit-logs') { if (!isAdmin()) return err(403, 'Không đủ quyền'); return wait(db.audit); }
    if (p === '/api/dashboard-users') { if (!isAdmin()) return err(403, 'Không đủ quyền'); if (m === 'POST') { if (db.users.some((x) => x.username === body.username)) return err(409, 'Tên đăng nhập đã tồn tại'); db.users.push({ locked: false, ...body, password: undefined }); return wait({ ok: true }); } return wait(db.users); }
    mm = p.match(/^\/api\/dashboard-users\/(.+)$/);
    if (p === '/api/auto-responses') {
      db.autoResponses = db.autoResponses || [{ id: 'sample_a', trigger: 'A', response: 'Xin chào! Bạn vừa nhắn chữ A đúng không? Đây là phản hồi tự động mẫu từ 4AM BOT.', matchType: 'exact', imageUrl: '' }];
      if (m === 'POST') {
        const item = { id: body.id || 'ar_' + Date.now(), trigger: body.trigger, response: body.response || '', imageUrl: body.imageUrl || '', matchType: body.matchType || 'exact' };
        const idx = db.autoResponses.findIndex(x => x.id === item.id || x.trigger.toLowerCase() === item.trigger.toLowerCase());
        if (idx >= 0) db.autoResponses[idx] = item; else db.autoResponses.push(item);
        return wait({ ok: true, data: item });
      }
      return wait({ ok: true, data: db.autoResponses });
    }
    mm = p.match(/^\/api\/auto-responses\/(.+)$/);
    if (mm) {
      const id = decodeURIComponent(mm[1]);
      db.autoResponses = (db.autoResponses || []).filter(x => x.id !== id && x.trigger !== id);
      return wait({ ok: true });
    }
    return err(404, `Demo: chưa hỗ trợ ${m} ${p}`);
  }
  function switchRole(role) {
    const me = role === 'seller' ? { username: 'mint', displayName: 'Minh Tú', role: 'seller', sellerId: sellers[0].id, permissions: ['orders.read', 'orders.complete_own', 'orders.edit'] } : { username: 'owner', displayName: 'Owner', role: 'admin', permissions: [] };
    sessionStorage.setItem('4am_demo_me', JSON.stringify(me)); localStorage.setItem('4am_admin_token', 'demo-token'); location.hash = ''; location.reload();
  }
  function log(e) { audit({ createdAt: new Date().toISOString(), actorType: db.me?.role === 'admin' ? 'ADMIN' : 'SELLER', actorId: db.me?.username || '—', ...e }); db.audit.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); }
  window.Demo = { enabled: true, handle, switchRole, log };
})();
