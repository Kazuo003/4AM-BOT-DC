/* App shell: boot, navigation (sidebar / bottom nav / drawer), overview, 401 handling. */
(function () {
  const { $, $$, esc, I, vnd, dShort, avatar, badge, state } = UI;
  // Legacy section IDs kept: tabSellers/tabProducts/tabOrders/tabConfig with btnTab* buttons.
  const NAV = [
    { id: 'overview', label: 'Tổng quan', icon: 'home', sec: 'tabOverview', btn: 'btnTabOverview', admin: true },
    { id: 'orders', label: 'Đơn hàng', icon: 'receipt', sec: 'tabOrders', btn: 'btnTabOrders' },
    { id: 'recon', label: 'Đối soát', icon: 'scale', sec: 'tabRecon', btn: 'btnTabRecon', admin: true },
    { id: 'products', label: 'Mặt hàng', icon: 'box', sec: 'tabProducts', btn: 'btnTabProducts' },
    { id: 'sellers', label: 'Người bán', icon: 'users', sec: 'tabSellers', btn: 'btnTabSellers', admin: true },
    { id: 'autoresponse', label: 'Tự động trả lời', short: 'Auto Reply', icon: 'zap', sec: 'tabAutoResponse', btn: 'btnTabAutoResponse' },
    { id: 'config', label: 'Cấu hình Discord', short: 'Discord', icon: 'settings', sec: 'tabConfig', btn: 'btnTabConfig', admin: true },
    { id: 'balance', label: 'Biến động số dư', icon: 'wallet', sec: 'tabBalance', btn: 'btnTabBalance', admin: true },
  ];
  let current = null; let booted = false;
  const allowed = () => NAV.filter((n) => !n.admin || Auth.isAdmin());

  function buildNav() {
    const items = allowed();
    const btn = (n, id) => `<button class="nav-btn" ${id ? `id="${n.btn}"` : ''} data-nav="${n.id}">${I(n.icon)}<span>${esc(n.label)}</span><span class="count" data-count="${n.id}"></span></button>`;
    const ops = items.filter((n) => ['overview', 'orders', 'recon'].includes(n.id)), store = items.filter((n) => ['products', 'sellers', 'autoresponse', 'config'].includes(n.id)), sys = items.filter((n) => n.id === 'balance');
    const group = (t, arr, ids) => arr.length ? `<div class="nav-group">${t}</div>${arr.map((n) => btn(n, ids)).join('')}` : '';
    $('#sidebar').innerHTML = group('Vận hành', ops, true) + group('Cửa hàng', store, true) + group('Hệ thống', sys, true) + `<div class="sidebar-foot">${Auth.isAdmin() ? 'Owner / Admin' : 'Workspace seller'}<br/><span class="mono">v2 · 4AM Control</span></div>`;
    $('#drawerNav').innerHTML = `<div class="brand" style="padding:6px 10px 12px"><img class="brand-logo" src="/logo.png" alt="" data-logo /><span>4AM STORE</span></div>` + group('Vận hành', ops) + group('Cửa hàng', store) + group('Hệ thống', sys);
    const bottom = Auth.isAdmin() ? ['overview', 'orders', 'recon', 'products'] : ['orders', 'products', 'autoresponse'];
    const bn = $('#bottomNav'); bn.style.setProperty('--cols', bottom.length + (Auth.isAdmin() ? 1 : 0));
    bn.innerHTML = bottom.map((id) => { const n = NAV.find((x) => x.id === id); return `<button data-nav="${id}">${I(n.icon)}<span>${esc(n.short || n.label)}</span></button>`; }).join('') + (Auth.isAdmin() ? `<button id="btnBottomMore" aria-label="Thêm mục">${I('menu')}<span>Thêm</span></button>` : '');
    $('#btnBottomMore')?.addEventListener('click', openDrawer);
    $$('[data-nav]').forEach((b) => b.addEventListener('click', () => { go(b.dataset.nav); UI.closeModal('navDrawer'); }));
    hydrateLogos();
  }
  function openDrawer() { UI.openModal('navDrawer'); }

  function go(id, push = true) {
    UI.closeMenu();
    if (id === 'audit') id = 'balance';
    const n = allowed().find((x) => x.id === id) || allowed()[0]; current = n.id;
    NAV.forEach((x) => { const s = document.getElementById(x.sec); if (s) s.hidden = x.id !== n.id; });
    $('#tabDenied').hidden = true;
    $$('[data-nav]').forEach((b) => { if (b.dataset.nav === n.id) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    if (push) history.replaceState(null, '', `${location.pathname}${location.search}#${n.id}`);
    document.title = `${n.label} — 4AM STORE`;
    if (n.id === 'overview') renderOverview();
    if (n.id === 'orders') Orders.render();
    if (n.id === 'recon') { Finance.renderRecon(); if (!Store.tx.length) Finance.loadRecon(); }
    if (n.id === 'balance') { Finance.renderBalance(); if (!Store.tx.length) Finance.loadRecon(); }
    if (n.id === 'products') Products.render();
    if (n.id === 'sellers') { Sellers.render(); Sellers.fillSelect(); Sellers.loadUsers(); }
    if (n.id === 'autoresponse') AutoResponseUI.render();
    if (n.id === 'config') DiscordConfig.render();
    $('#main').scrollTo?.(0, 0); window.scrollTo(0, 0);
  }

  function refreshCounts() {
    const set = (id, v, cls) => $$(`[data-count="${id}"]`).forEach((el) => { el.textContent = v || ''; el.classList.toggle('alert-count', !!cls); });
    set('orders', Store.orders.filter((o) => o.status === 'PROCESSING').length);
    if (Auth.isAdmin()) set('recon', Finance.riskCount(), true);
    if (current === 'overview') renderOverview();
  }

  function renderOverview() {
    const el = $('#tabOverview'); const o = Store.orders;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const paid = o.filter((x) => x.paymentStatus === 'PAID');
    const revToday = paid.filter((x) => new Date(x.createdAt) >= today).reduce((s, x) => s + Number(x.amount || 0), 0);
    const days = Array.from({ length: 14 }, (_, i) => { const d = new Date(today); d.setDate(d.getDate() - (13 - i)); const n = new Date(d); n.setDate(n.getDate() + 1); return { d, v: paid.filter((x) => { const c = new Date(x.createdAt); return c >= d && c < n; }).reduce((s, x) => s + Number(x.amount || 0), 0) }; });
    const max = Math.max(1, ...days.map((d) => d.v));
    const needPay = o.filter((x) => x.status === 'PROCESSING' && x.paymentStatus !== 'PAID');
    const needDeliver = o.filter((x) => x.status === 'PROCESSING' && x.paymentStatus === 'PAID');
    const risk = Finance.riskCount();
    const sum = (arr) => arr.reduce((s, x) => s + Number(x.amount || 0), 0);
    const tickets = o.filter((x) => x.ticketOpen);
    const kpis = [
      { id: 'revenue', label: 'Doanh thu hôm nay', icon: 'wallet', tone: 'accent', v: `${UI.num(revToday)}<small>VNĐ</small>`, aria: vnd(revToday), s: `Tổng đã thu: ${vnd(sum(paid))}`, go: { pays: ['PAID'] } },
      { id: 'pending', label: 'Chờ thanh toán', icon: 'clock', tone: needPay.length ? 't-warning' : '', v: needPay.length, s: `${vnd(sum(needPay))} đang chờ`, go: { status: 'PROCESSING', pay: 'UNPAID' } },
      { id: 'seller', label: 'Chờ giao hàng', icon: 'rotate', tone: 't-info', v: needDeliver.length, s: 'Đã nhận tiền, chờ giao', go: { status: 'PROCESSING', pay: 'PAID' } },
      { id: 'completed', label: 'Hoàn tất', icon: 'checkCircle', v: o.filter((x) => x.status === 'COMPLETED').length, s: 'Đã giao thành công', go: { status: 'COMPLETED' } },
      { id: 'recon', label: 'Lỗi đối soát', icon: 'scale', tone: risk ? 't-danger' : '', v: risk, s: risk ? 'Giao dịch chưa xử lý' : 'Không có vấn đề', recon: true },
      { id: 'ticket', label: 'Ticket đang mở', icon: 'hash', v: tickets.length, s: 'Trên Discord', go: { ticket: true } },
    ];
    const bySeller = (Store.data?.sellers || []).map((s) => ({ s, n: o.filter((x) => String(x.sellerId) === String(s.id) && ['READY', 'PROCESSING'].includes(x.status)).length, rev: paid.filter((x) => String(x.sellerId) === String(s.id)).reduce((a, x) => a + Number(x.amount || 0), 0) })).sort((a, b) => b.rev - a.rev);
    const hour = new Date().getHours(); const greet = hour < 5 ? 'Vẫn thức lúc 4AM à' : hour < 12 ? 'Chào buổi sáng' : hour < 18 ? 'Chào buổi chiều' : 'Chào buổi tối';
    el.innerHTML = `
      <div class="page-head"><div><h1>${greet}, ${esc(Auth.me?.displayName || Auth.me?.username || '')}</h1><p>${new Date().toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })}</p></div>
        <div class="actions"><button class="btn" data-goto="orders">${I('receipt')}Mở danh sách đơn</button></div></div>
      <div class="metrics kpis" role="list">${kpis.map((k) => `<button class="metric clickable ${k.tone || ''}" role="listitem" data-kpi="${k.id}" aria-label="${esc(k.label)}: ${esc(k.aria || k.v)}. Mở danh sách"><div class="k">${I(k.icon)}${esc(k.label)}</div><div class="v">${k.v}</div><div class="s">${esc(k.s)}</div></button>`).join('')}</div>
      <div class="ov-grid">
        <div class="card"><div class="card-head">${I('trend')}<h3>Doanh thu 14 ngày</h3><span class="spacer"></span><span class="hint">VNĐ / ngày</span></div>
          <div class="card-pad"><div class="bars" role="img" aria-label="Biểu đồ doanh thu 14 ngày">${days.map((d, i) => `<div class="bar ${i === 13 ? 'today' : ''}" style="height:${Math.max(3, (d.v / max) * 100)}%" title="${d.d.toLocaleDateString('vi-VN')}: ${vnd(d.v)}"></div>`).join('')}</div>
          <div class="bars-x">${days.map((d, i) => `<span>${i % 2 ? '' : d.d.getDate()}</span>`).join('')}</div></div></div>
        <div class="card"><div class="card-head">${I('users')}<h3>Seller</h3></div>
          ${bySeller.length ? bySeller.slice(0, 5).map((r) => `<div class="list-row">${avatar(r.s.avatar, r.s.globalName || r.s.username)}<div style="flex:1;min-width:0"><div class="cell-main">${esc(r.s.globalName || r.s.username)}</div><div class="cell-sub">${r.n} đơn đang xử lý</div></div><span class="mono secondary">${esc(vnd(r.rev))}</span></div>`).join('') : state.empty('Chưa có seller', 'Thêm seller trong trang Người bán.')}
        </div>
      </div>
      <div class="card" style="margin-top:16px"><div class="card-head">${I('zap')}<h3>Cần xử lý ngay</h3><span class="spacer"></span><button class="btn btn-sm btn-ghost" data-goto="orders">Xem tất cả${I('chevronRight', 'sm')}</button></div>
        ${[...needDeliver, ...needPay].slice(0, 6).map((x) => `<div class="list-row"><span class="mono cell-main" style="width:110px">${esc(Orders.orderNo(x))}</span>${Orders.statusBadge(x.status)}<div style="flex:1;min-width:0" class="cell-sub">${esc(x.service)} · ${esc(x.customerName || '')}</div><span class="mono">${esc(vnd(x.amount))}</span><button class="btn btn-sm btn-ghost btn-icon" data-act="open" data-id="${esc(x.id)}" aria-label="Mở đơn">${I('chevronRight', 'sm')}</button></div>`).join('') || state.empty('Không có việc tồn đọng', 'Mọi đơn đã được xử lý.')}
      </div>`;
    $$('[data-goto]', el).forEach((b) => b.addEventListener('click', () => go(b.dataset.goto)));
    $$('[data-kpi]', el).forEach((b) => b.addEventListener('click', () => { const k = kpis.find((x) => x.id === b.dataset.kpi); if (k.recon) { Finance.setGroup('review'); go('recon'); } else { go('orders'); Orders.setFilter(k.go); } }));
  }

  function hydrateLogos() { $$('img[data-logo]').forEach((img) => { if (img.dataset.bound) return; img.dataset.bound = 1; img.addEventListener('error', () => { const s = document.createElement('span'); s.className = img.className; s.textContent = '4AM'; s.setAttribute('aria-hidden', 'true'); img.replaceWith(s); }, { once: true }); if (img.complete && !img.naturalWidth) img.dispatchEvent(new Event('error')); }); }

  function showLogin() {
    // Wipe any admin data from screen
    Object.assign(window.Store, { data: null, orders: [], tx: [], audit: [], users: [] });
    $('#app').classList.add('hidden'); $('#loginScreen').classList.remove('hidden');
    ['ordersTableBody', 'ordersCardsMobile', 'sellersContainer', 'productsContainer', 'dashboardUsersList', 'tabOverview', 'tabRecon', 'tabAudit'].forEach((id) => { const e = document.getElementById(id); if (e) e.innerHTML = ''; });
    document.title = 'Đăng nhập — 4AM STORE'; setTimeout(() => $('#loginUsername')?.focus(), 50);
  }

  async function boot() {
    if (booted) return;
    $('#loginScreen').classList.add('hidden'); $('#app').classList.remove('hidden');
    $('#demoBanner').classList.toggle('hidden', !Demo.enabled);
    if (Demo.enabled) { const sw = $('#demoRoleSwitch'); sw.classList.remove('hidden'); $$('button', sw).forEach((b) => { const on = (b.dataset.role === 'admin') === Auth.isAdmin(); b.setAttribute('aria-pressed', String(on)); b.addEventListener('click', () => { if (!on) Demo.switchRole(b.dataset.role); }); }); }
    const me = Auth.me; $('#meName').textContent = me.displayName || me.username; $('#meRole').textContent = Auth.isAdmin() ? 'Owner' : 'Seller';
    $('#meAvatar').textContent = UI.initials(me.displayName || me.username);
    Auth.applyDomPermissions(document);
    buildNav(); Orders.init(); Products.init(); DiscordConfig.init(); if (Auth.isAdmin()) Sellers.init();
    $('#btnLogout').addEventListener('click', async () => { if (await UI.confirmDialog({ title: 'Đăng xuất?', message: 'Bạn sẽ cần đăng nhập lại để vào dashboard.', confirmText: 'Đăng xuất', icon: 'logout' })) { await Auth.logout(); location.reload(); } });
    $('#btnOpenDrawer').addEventListener('click', openDrawer);
    $('#btnHeaderSync')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const oldHtml = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `<span class="spin">⏳</span> Đang đồng bộ…`;
      try {
        if (Store.data?.products) {
          await API.save({ products: Store.data.products }).catch(() => {});
        }
        await API.sync();
        UI.toast('✅ Đã đồng bộ toàn bộ Menu & Ticket lên Discord thành công!', 'ok');
      } catch (err) {
        UI.toast(err.message || 'Lỗi khi đồng bộ lên Discord', 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = oldHtml;
      }
    });
    booted = true;
    const start = location.hash.slice(1) || (Auth.isAdmin() ? 'overview' : 'orders');
    go(start, false);
    // Data
    try { Store.data = await API.data(); setBot(Store.data.botOnline !== false, Store.data.botMode); Orders.fillSellerFilter(); if (['products', 'sellers', 'config'].includes(current)) go(current, false); } catch (e) { setBot(null); if (e.status !== 401) UI.toast(e.status === 403 ? 'Không đủ quyền tải cấu hình shop.' : e.message, 'error'); }
    if (Auth.isAdmin()) await Finance.loadRecon(true);
    await Orders.load();
    if (Auth.isAdmin()) Finance.loadAudit(true);
    if (current === 'overview') renderOverview();
  }
  function setBot(ok, mode = 'full') {
    const testMode = mode === 'dashboard-only' || mode === 'ui-test';
    $('#botDot').className = `dot ${testMode || ok === null ? 'warn' : ok ? 'ok' : 'err'}`;
    $('#botStatusText').textContent = mode === 'ui-test' ? 'Bot online · Test UI' : mode === 'dashboard-only' ? 'Chế độ test UI' : ok === null ? 'Không rõ trạng thái bot' : ok ? 'Bot đang hoạt động' : 'Bot ngoại tuyến';
  }

  window.addEventListener('auth:expired', () => { Auth.clear(); if (booted) { sessionStorage.setItem('4am_expired', '1'); location.reload(); } else showLogin(); });
  window.addEventListener('hashchange', () => { if (booted && Auth.me) go(location.hash.slice(1), false); });
  document.addEventListener('DOMContentLoaded', async () => {
    Icons.hydrate(); hydrateLogos();
    if (Demo.enabled) { const h = document.createElement('p'); h.className = 'alert alert-info'; h.innerHTML = `${I('help')}<span>Xem thử: nhập <b class="mono">owner</b> (quyền admin) hoặc <b class="mono">seller</b> (quyền seller), mật khẩu bất kỳ.</span>`; $('#loginForm').insertBefore(h, $('#loginError')); Icons.hydrate(h); }
    if (sessionStorage.getItem('4am_expired')) { sessionStorage.removeItem('4am_expired'); setTimeout(() => UI.toast('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.', 'info'), 300); }
    if (await Auth.restore()) boot(); else showLogin();
  });

  window.App = { boot, go, refreshCounts, showLogin };
  // Legacy tab switcher adapter
  window.switchTab = (name) => go({ sellers: 'sellers', products: 'products', orders: 'orders', config: 'config' }[String(name).replace(/^tab/i, '').toLowerCase()] || name);
})();
