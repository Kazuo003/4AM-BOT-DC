/* API client + compatibility adapter for the existing 4AM Express backend. */
(function () {
  const TOKEN_KEY = '4am_admin_token';
  const getToken = () => localStorage.getItem(TOKEN_KEY);
  const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
  const clearToken = () => localStorage.removeItem(TOKEN_KEY);

  class ApiError extends Error { constructor(status, message, data) { super(message); this.status = status; this.data = data; } }

  async function request(method, url, body) {
    if (window.Demo?.enabled) return Demo.handle(method, url, body);
    const headers = { Accept: 'application/json' };
    const t = getToken(); if (t) headers.Authorization = `Bearer ${t}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try { res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }); }
    catch { throw new ApiError(0, 'Không kết nối được máy chủ.'); }
    let data = null; try { data = await res.json(); } catch { /* empty */ }
    if (res.status === 401) { clearToken(); window.dispatchEvent(new CustomEvent('auth:expired')); throw new ApiError(401, 'Phiên đăng nhập đã hết hạn.', data); }
    if (res.status === 403) throw new ApiError(403, (data && (data.error || data.message)) || 'Bạn không đủ quyền thực hiện thao tác này.', data);
    if (!res.ok) throw new ApiError(res.status, (data && (data.error || data.message)) || `Lỗi máy chủ (${res.status}).`, data);
    return data;
  }
  const enc = encodeURIComponent;
  const clone = (v) => JSON.parse(JSON.stringify(v ?? {}));
  const list = (r, ...keys) => Array.isArray(r) ? r : (keys.map((k) => r?.[k]).find(Array.isArray) || []);
  let legacyConfig = null;

  const json = (v, fallback = {}) => {
    if (v && typeof v === 'object') return v;
    try { return JSON.parse(v || ''); } catch { return fallback; }
  };
  const colorHex = (v) => typeof v === 'number' ? `#${v.toString(16).padStart(6, '0').slice(-6)}` : (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : '#5865F2');
  const legacyColor = (v, previous) => typeof previous === 'number' ? parseInt(String(v || '#5865F2').replace('#', ''), 16) : v;
  const splitPayMethods = (v) => Array.isArray(v) ? v : String(v || '').split('|').map((x) => x.trim()).filter(Boolean);
  const parseTier = (v) => {
    if (v && typeof v === 'object') return { label: String(v.label || ''), price: Number(v.price || 0) };
    const [label = '', raw = ''] = String(v || '').split('|');
    return { label: label.trim(), price: Number(raw.replace(/\D/g, '')) || 0 };
  };
  const formatTier = (t) => {
    if (typeof t === 'string') return t;
    const label = String(t?.label || '').trim();
    const price = Number(t?.price || 0);
    if (!label && !price) return '';
    return price > 0 ? `${label} | ${new Intl.NumberFormat('vi-VN').format(price)}đ` : `${label} | 0đ`;
  };
  const legacyStatus = (s) => ({ PROCESSING: 'PROCESSING', COMPLETED: 'COMPLETED', CANCELLED: 'CANCELLED' }[s] || s);
  const actionStatus = (a) => ({ manualApprove: 'PAID', complete: 'COMPLETED', start: 'PROCESSING', cancel: 'CANCELLED' }[a]);
  const normalizeUser = (u) => u && u.sellerKey && !u.sellerId ? { ...u, sellerId: u.sellerKey } : u;

  function normalizeSeller(id, s = {}) {
    return {
      id,
      discordId: s.discordId || (/^\d{17,20}$/.test(id) ? id : ''),
      username: s.username || s.name || id,
      globalName: s.globalName || s.name || s.username || id,
      avatar: s.avatar || '', isShop: !!s.isShop, locked: false,
      banks: (s.accounts || []).map((b) => ({ bankName: b.bankName || b.bank || '', account: b.account || '', owner: b.owner || '', qr: b.qr || '' })),
    };
  }

  function normalizeProduct(key, p = {}) {
    return {
      id: p.id || key, key, name: p.name || p.label || key, emoji: p.emoji || '📦',
      title: p.title || p.label || key,
      subtitle: p.subtitle || '',
      banner: p.banner || p.bannerUrl || '', color: colorHex(p.color),
      sellerId: p.sellerId || p.seller || '', handlers: Array.isArray(p.handlers) ? p.handlers : [],
      bankIndex: Number(p.bankIndex ?? p.accountIndex ?? 0) || 0,
      pingStaff: p.pingStaff !== false, enabled: p.enabled !== false,
      items: (p.items || []).map(parseTier),
    };
  }

  function normalizeData(envelope) {
    const raw = envelope?.data || envelope || {};
    legacyConfig = clone(raw);
    const menuVi = raw.menuEmbed?.vi || {};
    const ticketVi = raw.ticketPanel?.vi || {};
    return {
      ...raw,
      sellers: Object.entries(raw.sellers || {}).map(([id, s]) => normalizeSeller(id, s)),
      products: Object.entries(raw.categories || {}).map(([key, p]) => normalizeProduct(key, p)),
      menu: {
        shopName: raw.storeName || '4AM STORE', title: menuVi.title || '',
        lines: menuVi.lines || [menuVi.line1, menuVi.line2].filter(Boolean),
        payTitle: menuVi.section2Title !== undefined ? menuVi.section2Title : (menuVi.paymentTitle || ''),
        payMethods: splitPayMethods(menuVi.section2Lines !== undefined ? menuVi.section2Lines : (menuVi.paymentMethods || raw.paymentMethods)),
        footer: menuVi.footerNote || '', placeholder: menuVi.placeholder || '',
        banner: raw.menuEmbed?.bannerUrl || raw.mainBannerUrl || '', logo: raw.menuEmbed?.logoUrl || raw.logoUrl || '/logo.png',
        color: colorHex(raw.menuEmbed?.color), menuChannelId: raw.menuChannelId || '', ticketChannelId: raw.ticketChannelId || '',
      },
      ticket: {
        title: ticketVi.title || '', subtitle: ticketVi.subtitle || '', lines: ticketVi.lines || [],
        buttonLabel: ticketVi.buttonLabel || '', prefix: raw.ticketPanel?.ticketPrefix || 'ticket',
        welcomeTitle: ticketVi.welcomeTitle || '', welcomeMessage: ticketVi.welcomeMessage || ticketVi.welcomeMsg || '', welcomeNote: ticketVi.welcomeNote || '',
        thumbnail: raw.ticketPanel?.thumbnailUrl || '', banner: raw.ticketPanel?.bannerUrl || '', color: colorHex(raw.ticketPanel?.color),
        channelId: raw.ticketChannelId || '', categoryId: raw.ticketCategoryId || '',
      },
      botOnline: envelope?.botInfo ? !!envelope.botInfo.user : undefined,
      botMode: envelope?.botInfo?.mode || 'full',
      botName: envelope?.botInfo?.user?.tag || raw.storeName || '4AM STORE',
    };
  }

  function productsToLegacy(products, previous = {}) {
    return Object.fromEntries((products || []).map((p) => {
      const old = previous[p.key] || {};
      return [p.key, {
        ...old, label: p.name, emoji: p.emoji, title: p.title, titleEn: p.title,
        subtitle: p.subtitle, subtitleEn: p.subtitle, bannerUrl: p.banner,
        color: legacyColor(p.color, old.color), seller: p.sellerId,
        handlers: p.handlers || [], accountIndex: String(p.bankIndex ?? 0),
        pingStaff: p.pingStaff !== false, enabled: p.enabled !== false,
        items: (p.items || []).map(formatTier),
      }];
    }));
  }

  function sellersToLegacy(sellers, previous = {}) {
    return Object.fromEntries((sellers || []).map((s) => {
      const old = previous[s.id] || {};
      return [s.id, {
        ...old, isShop: s.isShop ?? old.isShop ?? false,
        name: s.globalName || s.username || old.name || s.id,
        username: s.username || old.username, globalName: s.globalName || old.globalName,
        avatar: s.avatar || old.avatar,
        discordId: s.discordId || old.discordId || (/^\d{17,20}$/.test(s.id) ? s.id : undefined),
        accounts: (s.banks || []).map((b) => ({ bank: b.bankName || '', account: b.account || '', owner: b.owner || '', qr: b.qr || '' })),
      }];
    }));
  }

  function mergeUiConfig(patch) {
    const next = clone(legacyConfig || {});
    if (patch.products) next.categories = productsToLegacy(patch.products, next.categories || {});
    if (patch.sellers) next.sellers = sellersToLegacy(patch.sellers, next.sellers || {});
    if (patch.menu) {
      const m = patch.menu;
      next.storeName = m.shopName || next.storeName; next.menuChannelId = m.menuChannelId ?? next.menuChannelId; next.ticketChannelId = m.ticketChannelId ?? next.ticketChannelId;
      next.menuEmbed = { ...(next.menuEmbed || {}), color: m.color, bannerUrl: m.banner, logoUrl: m.logo, vi: { ...(next.menuEmbed?.vi || {}), title: m.title, lines: m.lines || [], line1: m.lines?.[0] || '', line2: m.lines?.[1] || '', paymentTitle: m.payTitle, paymentMethods: (m.payMethods || []).join('|'), section2Title: m.payTitle, section2Lines: m.payMethods || [], footerNote: m.footer, placeholder: m.placeholder } };
    }
    if (patch.ticket) {
      const t = patch.ticket;
      next.ticketChannelId = t.channelId ?? next.ticketChannelId; next.ticketCategoryId = t.categoryId ?? next.ticketCategoryId;
      next.ticketPanel = { ...(next.ticketPanel || {}), color: t.color, thumbnailUrl: t.thumbnail, bannerUrl: t.banner, ticketPrefix: t.prefix, vi: { ...(next.ticketPanel?.vi || {}), title: t.title, subtitle: t.subtitle, lines: t.lines || [], buttonLabel: t.buttonLabel, welcomeTitle: t.welcomeTitle, welcomeMsg: t.welcomeMessage, welcomeNote: t.welcomeNote } };
    }
    const uiKeys = new Set(['products', 'sellers', 'menu', 'ticket', 'draft']);
    Object.entries(patch || {}).forEach(([k, v]) => { if (!uiKeys.has(k)) next[k] = v; });
    return next;
  }

  async function configPayload(patch) {
    if (!legacyConfig) normalizeData(await request('GET', '/api/data'));
    const next = mergeUiConfig(patch || {}); legacyConfig = clone(next); return next;
  }

  function normalizeOrder(o) {
    const snap = o.planSnapshot || json(o.planSnapshotJson);
    const customer = o.user || {}; const ticket = o.ticket || {};
    return {
      ...o, amount: Number(o.amount ?? o.amountCents ?? 0),
      service: o.service || snap.categoryLabel || o.product?.name || 'Dịch vụ',
      customerName: String(o.customerName || customer.globalName || customer.name || customer.username || 'Khách vãng lai').replace(/\s*[-—]\s*(Chờ thanh toán|Đã thanh toán|Duyệt thủ công|Đang xử lý|Hoàn tất|Đã hủy|Sai tài khoản|Đã giao|Chuyển trùng|Thiếu cấu hình|Đã lưu trữ).*$/i, '').trim() || 'Khách vãng lai',
      discordId: o.discordId || customer.id || '', customerAvatar: o.customerAvatar || customer.avatar || '',
      sellerId: o.sellerId || snap.sellerId || '', notes: o.notes ?? snap.notes ?? snap.selectedItem ?? '',
      ticketChannelId: o.ticketChannelId || ticket.channelId || '', ticketChannelName: o.ticketChannelName || ticket.channelName || '',
      ticketOpen: o.ticketOpen ?? ticket.isChannelOpen ?? ticket.status === 'OPEN',
      provider: o.provider || o.paymentProvider || '', transactionId: o.transactionId || '',
    };
  }

  function normalizeTransaction(t) {
    const raw = json(t.rawPayloadJson, t.raw || {});
    const expected = t.expectedAmount ?? t.order?.amountCents ?? null;
    let status = t.status;
    if (['UNDERPAID', 'OVERPAID'].includes(status)) status = 'AMOUNT_MISMATCH';
    if (status === 'SUCCESS' || status === 'PAID') status = expected != null && Number(t.amount) !== Number(expected) ? 'AMOUNT_MISMATCH' : 'MATCHED';
    const txDesc = raw.description || raw.content || raw.transactions?.[0]?.description || (raw.tx ? `Mã GD: ${raw.tx}` : '') || '';
    return {
      ...t, status, orderCode: t.orderCode || t.orderNo || t.order?.orderNo || '', expectedAmount: expected,
      receiverAccount: t.receiverAccount || t.receivingAccount || '', description: t.description || txDesc,
      provider: t.provider || raw.gateway || raw.bankName || (String(t.source || '').includes('GPM') ? 'GPM Pay' : (String(t.source || '').includes('PAYOS') ? 'PayOS' : (t.source === 'MANUAL_VERIFY' ? 'Duyệt thủ công' : t.source || ''))),
      createdAt: t.createdAt || t.processedAt, handled: t.handled ?? (status === 'MATCHED' || status === 'SUCCESS' || status === 'PAID'), raw,
    };
  }

  function normalizeAudit(a) {
    const metadata = json(a.metadataJson, a.metadata || {});
    return {
      ...a,
      before: json(a.beforeJson, a.before ?? null), after: json(a.afterJson, a.after ?? null), metadata,
      targetId: a.targetId || metadata.transactionId || metadata.targetId || '',
      result: a.result || metadata.result || (a.action === 'PAYMENT_REJECTED' ? 'FAILED' : 'SUCCESS'),
      source: a.source || metadata.source || '', ip: a.ip || metadata.ip || '',
    };
  }

  async function saveConfig(patch, sync) {
    const body = await configPayload(patch);
    return request('POST', sync ? '/api/save-and-sync' : '/api/save', body);
  }

  const api = {
    login: async (username, password) => { const r = await request('POST', '/api/login', { username, password }); return { ...r, user: normalizeUser(r.user) }; },
    me: async () => { const r = await request('GET', '/api/me'); return { ...r, user: normalizeUser(r.user) }; },
    logout: () => request('POST', '/api/logout'),
    dashboardUsers: async () => { const r = await request('GET', '/api/dashboard-users'); return { ...r, users: list(r, 'users').map((u) => ({ ...u, sellerId: u.sellerId || u.sellerKey, locked: u.locked ?? u.enabled === false })) }; },
    createDashboardUser: (b) => request('POST', '/api/dashboard-users', { ...b, sellerKey: b.sellerKey || b.sellerId }),
    updateDashboardUser: (u, b) => { const body = { ...b }; if (body.sellerId !== undefined) { body.sellerKey = body.sellerId; delete body.sellerId; } if (body.locked !== undefined) { body.enabled = !body.locked; delete body.locked; } return request('PATCH', `/api/dashboard-users/${enc(u)}`, body); },
    deleteDashboardUser: (u) => request('DELETE', `/api/dashboard-users/${enc(u)}`),
    autoResponses: async () => { const r = await request('GET', '/api/auto-responses'); return list(r, 'data'); },
    saveAutoResponse: (b) => request('POST', '/api/auto-responses', b),
    deleteAutoResponse: (id) => request('DELETE', `/api/auto-responses/${enc(id)}`),
    data: async () => normalizeData(await request('GET', '/api/data')),
    save: (b) => saveConfig(b, false), sync: () => request('POST', '/api/sync'), syncTicket: () => request('POST', '/api/sync-ticket'),
    saveAndSync: (b) => saveConfig(b, true),
    discordUser: async (id) => { const r = await request('GET', `/api/discord-user/${enc(id)}`); return r.user || r; },
    botEmojis: () => request('GET', '/api/bot-emojis'), translate: (b) => request('POST', '/api/translate', b), setupBilingual: () => request('POST', '/api/setup-bilingual-server'),
    orders: async () => { const r = await request('GET', '/api/orders'); return { ...r, orders: list(r, 'orders', 'items', 'data').map(normalizeOrder) }; },
    createOrder: (b) => request('POST', '/api/orders/create', { ...b, categoryKey: b.categoryKey || b.productKey, serviceName: b.serviceName || b.service, status: b.paymentStatus === 'PAID' ? 'PAID' : 'PENDING' }),
    completeOwn: (id, action) => request('POST', `/api/orders/${enc(id)}/complete-own`, action ? { action } : undefined),
    setStatus: (id, status, notify, reason, exceptional) => request('POST', `/api/orders/${enc(id)}/status`, { status: legacyStatus(status), notifyDiscord: notify, reason, exceptional }),
    runOrderAction: (id, action, b = {}) => {
      if (!window.Demo?.enabled && !window.Auth?.isAdmin?.() && ['start', 'complete'].includes(action)) return request('POST', `/api/orders/${enc(id)}/complete-own`, { action, ...b });
      const status = actionStatus(action); if (!status) return Promise.reject(new ApiError(400, 'Thao tác đơn hàng không hợp lệ.'));
      return request('POST', `/api/orders/${enc(id)}/status`, { status, action, ...b });
    },
    setAmount: (id, amount, reason) => request('POST', `/api/orders/${enc(id)}/amount`, { amount, reason }),
    updateOrder: (id, b) => request('POST', `/api/orders/${enc(id)}/update`, { ...b, serviceName: b.serviceName || b.service, status: b.status ? legacyStatus(b.status) : undefined }),
    archiveOrder: (id) => request('DELETE', `/api/orders/${enc(id)}`),
    transactions: async (status) => { const r = await request('GET', `/api/payment-transactions${status ? `?status=${enc(status)}` : ''}`); return { ...r, transactions: list(r, 'transactions', 'items', 'data').map(normalizeTransaction) }; },
    auditLogs: async () => { const r = await request('GET', '/api/audit-logs'); return { ...r, logs: list(r, 'logs', 'items', 'data').map(normalizeAudit) }; },
    markTxHandled: async (id, handled, reason) => { const r = await request('POST', `/api/payment-transactions/${enc(id)}/handled`, { handled, reason }); return normalizeTransaction(r.transaction || r); },
    attachTx: async (id, orderId, reason) => { const r = await request('POST', `/api/payment-transactions/${enc(id)}/attach`, { orderId, reason }); return normalizeTransaction(r.transaction || r); },
    saveDraft: (b) => saveConfig(b, false),
  };
  window.API = { ...api, getToken, setToken, clearToken, ApiError, list };
})();
