/* Orders: list, filters, pagination, lifecycle actions, desktop table, mobile cards, detail modal, manual order. */
(function () {
  const { $, $$, esc, I, vnd, dShort, dt, shortId, avatar, badge, toast, openModal, closeModal, confirmDialog, reasonDialog, withLoading, state, copy } = UI;
  const R = window.OrderRules;
  window.Store = window.Store || { data: null, orders: [], tx: [], audit: [], users: [] };

  // Helper to remove any status suffixes from customer name
  const cleanCustomerName = (n) => String(n || '—').replace(/\s*[-—]\s*(Chờ thanh toán|Đã thanh toán|Duyệt thủ công|Đang xử lý|Hoàn tất|Đã hủy|Sai tài khoản|Đã giao|Chuyển trùng|Thiếu cấu hình|Đã lưu trữ).*$/i, '').trim() || '—';

  // 3 Trạng thái đơn hàng: Đang xử lý | Hoàn tất | Đã hủy
  const STATUS = {
    PROCESSING: { t: 'Đang xử lý', k: 'warning', i: 'rotate' },
    COMPLETED: { t: 'Hoàn tất', k: 'success', i: 'checkCircle' },
    CANCELLED: { t: 'Đã hủy', k: 'danger', i: 'ban' },
    // Backwards compatibility aliases
    PENDING: { t: 'Đang xử lý', k: 'warning', i: 'rotate' },
    PENDING_PAYMENT: { t: 'Đang xử lý', k: 'warning', i: 'rotate' },
    READY: { t: 'Đang xử lý', k: 'warning', i: 'rotate' },
    PURCHASED: { t: 'Đang xử lý', k: 'warning', i: 'rotate' },
    DELIVERED: { t: 'Hoàn tất', k: 'success', i: 'checkCircle' },
    FAILED: { t: 'Đã hủy', k: 'danger', i: 'ban' },
    REFUNDED: { t: 'Đã hủy', k: 'danger', i: 'ban' },
  };
  const PAY = {
    UNPAID: ['neutral', 'Chưa thanh toán', 'clock'],
    PAID: ['success', 'Đã thanh toán', 'wallet']
  };
  const statusBadge = (s) => { const m = STATUS[s] || { t: s || '—', k: 'neutral', i: 'help' }; return badge(m.k, m.i, m.t); };
  const payStatusOf = (o) => o.paymentStatus === 'PAID' ? 'PAID' : 'UNPAID';
  const FILTERS = [
    ['all', 'Tất cả'],
    ['PROCESSING', 'Đang xử lý'],
    ['COMPLETED', 'Hoàn tất'],
    ['CANCELLED', 'Đã hủy']
  ];
  const STEPS = ['PROCESSING', 'COMPLETED'];
  const PROVIDER = (p) => p === 'MANUAL' ? 'Thủ công' : p || '';
  const txOf = (o) => (Store.tx || []).filter((t) => t.orderId != null && String(t.orderId) === String(o.id));
  function paySummary(o) {
    if (o.transactionId || o.provider) return `${PROVIDER(o.provider) || '—'}${o.transactionId ? ` · ${o.transactionId}` : ''}`;
    const bad = txOf(o).filter((t) => t.status !== 'MATCHED' && !t.handled);
    return bad.length ? `${Finance.txMeta(bad[0].status).t} · ${bad[0].transactionId}` : 'Chưa có giao dịch';
  }
  const payBadge = (o) => {
    const isPaid = payStatusOf(o) === 'PAID';
    return isPaid ? badge('success', 'wallet', 'Đã thanh toán') : badge('neutral', 'clock', 'Chưa thanh toán');
  };
  const REVENUE_PAY = ['PAID'];
  const PAGE = 10;

  const view = { filter: 'all', statuses: null, pays: null, q: '', seller: '', range: '', sort: 'new', pay: '', provider: '', min: '', max: '', ticket: false, loading: false, error: null, limit: PAGE };
  const sellerById = (id) => (Store.data?.sellers || []).find((s) => String(s.id) === String(id));
  const sellerName = (id) => { const s = sellerById(id); return s ? (s.globalName || s.username) : (id ? shortId(id) : 'Chưa phân'); };
  const orderNo = (o) => o.orderNo || o.code || o.id;
  const me = () => Auth.me;
  const find = (id) => Store.orders.find((x) => String(x.id) === String(id));
  const visibleOrders = () => Store.orders.filter((o) => R.canSeeOrder(o, me()));

  function filtered() {
    const q = view.q.toLowerCase(); const since = view.range ? Date.now() - Number(view.range) * 864e5 : 0;
    const arr = visibleOrders().filter((o) => {
      if (view.statuses ? !view.statuses.includes(o.status) : view.filter !== 'all' && o.status !== view.filter) return false;
      if (view.pay && payStatusOf(o) !== view.pay) return false;
      if (view.pays && !view.pays.includes(payStatusOf(o))) return false;
      if (view.provider && (view.provider === 'NONE' ? !!o.provider : o.provider !== view.provider)) return false;
      if (view.min && Number(o.amount) < Number(view.min)) return false;
      if (view.max && Number(o.amount) > Number(view.max)) return false;
      if (view.ticket && !o.ticketOpen) return false;
      if (view.seller && String(o.sellerId) !== view.seller) return false;
      if (since && new Date(o.createdAt).getTime() < since) return false;
      if (q && ![orderNo(o), o.transactionId, ...txOf(o).map((t) => t.transactionId), o.customerName, o.discordId, o.service].some((v) => String(v || '').toLowerCase().includes(q))) return false;
      return true;
    });
    arr.sort((a, b) => view.sort === 'amount' ? b.amount - a.amount : (new Date(b.createdAt) - new Date(a.createdAt)) * (view.sort === 'old' ? -1 : 1));
    return arr;
  }

  // ----- Actions
  function openTicket(o) {
    if (!o?.ticketChannelId) { toast('Đơn này không có ticket Discord.', 'info'); return; }
    const guild = Store.data?.guildId;
    if (guild) window.open(`https://discord.com/channels/${encodeURIComponent(guild)}/${encodeURIComponent(o.ticketChannelId)}`, '_blank', 'noopener');
    else toast(`Demo: sẽ mở #${o.ticketChannelName || o.ticketChannelId} trên Discord`, 'info');
  }
  // Non-mutating primaries for unpaid orders
  function checkPayment(o) { openDetail(o.id); setTimeout(() => $('#od-payment')?.scrollIntoView({ block: 'start' }), 60); }
  function checkRecon(o) {
    const t = txOf(o).sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt))[0];
    if (t && window.Finance && !$('#orderEditModal').hidden) { Finance.openTx(t.id, false, false, { back: { label: `Quay lại đơn ${orderNo(o)}`, crumb: ['Đơn hàng', orderNo(o), t.transactionId], onClick: () => openDetail(o.id) } }); return; }
    if (window.Finance) { Finance.focusOrder(orderNo(o)); App.go('recon'); } }
  // Each action has its own confirmation; money actions require a reason (saved to the audit log). Mock only.
  async function runAction(id, o, btn) {
    if (id === 'checkPayment') return checkPayment(o);
    if (id === 'checkRecon') return checkRecon(o);
    const a = R.ACTIONS[id]; if (!a || !R.canRun(id, o, me())) { toast('Bạn không đủ quyền thực hiện thao tác này.', 'error'); return; }
    const who = o.customerName || 'khách'; let reason = ''; let txId = '';
    if (id === 'manualApprove') {
      const t = txOf(o).filter((x) => R.txGroup(x.status) === 'review').sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt))[0];
      txId = t?.transactionId || '';
      const extra = `<div class="readonly-box stack" style="gap:6px"><div class="kv"><span>Mã giao dịch</span><span class="mono">${esc(t?.transactionId || 'Không có')}</span></div><div class="kv"><span>Số tiền nhận</span><span class="mono">${t ? esc(vnd(t.amount)) : '—'}</span></div><div class="kv"><span>Số tiền đơn</span><span class="mono">${esc(vnd(o.amount))}</span></div><div class="kv"><span>Tài khoản nhận</span><span class="mono">${esc(t?.receiverAccount || '—')}</span></div></div>`;
      reason = await reasonDialog({ title: `Duyệt thanh toán thủ công · ${orderNo(o)}?`, message: 'Đơn sẽ chuyển sang Chờ xử lý và thanh toán ghi nhận là Thủ công.', warning: t && Number(t.amount) !== Number(o.amount) ? `Số tiền nhận khác số tiền đơn (${vnd(t.amount - o.amount)}).` : 'Chỉ duyệt khi đã kiểm tra sao kê ngân hàng.', extra, ack: 'Tôi đã kiểm tra tiền vào đúng tài khoản', confirmText: 'Duyệt thanh toán', tone: 'warning', icon: 'shield', twoStep: true });
      if (reason === null) return;
    } else {
      const cfg = {
        cancel: { message: `Đơn ${orderNo(o)} sẽ bị hủy và ${who} được thông báo trong ticket.`, warning: payStatusOf(o) === 'PAID' ? `Đơn đã nhận ${vnd(o.amount)}. Hủy đơn không tự chuyển tiền lại cho khách.` : '', tone: 'danger' },
      }[id];
      if (cfg) { reason = await reasonDialog({ title: `${a.label}?`, extra: summary(o), confirmText: id === 'cancel' ? 'Xác nhận hủy đơn' : a.label, icon: a.icon, tone: cfg.tone || 'warning', ...cfg }); if (reason === null) return; }
      else {
        const msg = { start: `Bắt đầu xử lý ${o.service} cho ${who}.`, complete: `Xác nhận đã giao xong ${o.service} cho ${who} và đóng đơn ${orderNo(o)}.` }[id];
        if (!(await confirmDialog({ title: `${a.label}?`, message: msg, extra: summary(o, id !== 'start'), confirmText: id === 'complete' ? 'Hoàn tất đơn' : a.label, icon: a.icon, tone: 'brand' }))) return;
      }
    }
    const go = async () => {
      try { await API.runOrderAction(o.id, id, { reason, transactionId: txId }); toast(`${orderNo(o)} · ${a.label}`); await reloadAll(); if (current && String(current.id) === String(o.id) && !$('#orderEditModal').hidden) openDetail(o.id, true); }
      catch (e) { toast(e.message, 'error'); }
    };
    btn ? await withLoading(btn, go) : await go();
  }
  async function reloadAll() { if (Auth.isAdmin()) await Finance.loadRecon(true); await load(); if (Auth.isAdmin()) await Finance.loadAudit(true); }
  async function archive(o) {
    if (!R.canArchive(me())) return;
    if (!(await confirmDialog({ title: 'Lưu trữ đơn?', message: `Đơn ${orderNo(o)} sẽ bị ẩn khỏi danh sách. Dữ liệu tài chính và audit vẫn được giữ nguyên.`, extra: summary(o), confirmText: 'Lưu trữ đơn', tone: 'danger', icon: 'archive' }))) return;
    try { await API.archiveOrder(o.id); toast('Đã lưu trữ đơn'); closeModal('orderEditModal'); reloadAll(); } catch (e) { toast(e.message, 'error'); }
  }
  function menuItems(o, inDetail) {
    const pa = R.primaryAction(o, me());
    const acts = trimActs(R.allowedActions(o, me()), o).filter((id) => id !== pa).map((id) => ({ label: R.ACTIONS[id].label, icon: R.ACTIONS[id].icon, tone: R.ACTIONS[id].tone, onClick: () => runAction(id, o) }));
    return [!inDetail && { label: 'Xem chi tiết', icon: 'receipt', onClick: () => openDetail(o.id) }, Auth.isAdmin() && txOf(o).length && { label: 'Kiểm tra đối soát', icon: 'scale', onClick: () => checkRecon(o) }, ...(acts.length ? ['-', ...acts] : []), '-',
      o.ticketChannelId && { label: 'Mở ticket Discord', icon: 'link', onClick: () => openTicket(o) },
      o.transactionId && { label: 'Copy mã giao dịch', icon: 'copy', onClick: () => copy(o.transactionId, 'Đã sao chép mã giao dịch') },
      { label: 'Copy mã đơn', icon: 'copy', onClick: () => copy(orderNo(o), 'Đã sao chép mã đơn') },
      R.canArchive(me()) && '-', R.canArchive(me()) && { label: 'Lưu trữ đơn', icon: 'archive', tone: 'danger', onClick: () => archive(o) }];
  }
  const trimActs = (ids) => ids;
  const summary = (o, money = true) => `<div class="readonly-box stack" style="gap:6px"><div class="kv"><span>Mã đơn</span><span class="mono">${esc(orderNo(o))}</span></div><div class="kv"><span>Khách hàng</span><span>${esc(cleanCustomerName(o.customerName))}</span></div><div class="kv"><span>Dịch vụ</span><span>${esc(o.service || '—')}</span></div>${money ? `<div class="kv"><span>Số tiền</span><span class="mono">${esc(vnd(o.amount))}</span></div>` : ''}</div>`;
  const PSEUDO = { checkPayment: { label: 'Kiểm tra thanh toán', icon: 'search' }, checkRecon: { label: 'Kiểm tra đối soát', icon: 'scale' } };
  function rowActions(o, compact) {
    const primary = R.primaryAction(o, me());
    const a = primary && (R.ACTIONS[primary] || PSEUDO[primary]);
    return `${a ? `<button class="btn btn-sm ${primary === 'checkRecon' ? 'btn-warn' : ''}" data-act="run" data-action="${primary}" data-id="${esc(o.id)}" aria-label="${esc(a.label)}" title="${esc(a.label)}">${I(a.icon, 'sm')}<span class="action-label">${esc(a.label)}</span></button>` : ''}
      <button class="btn btn-sm btn-ghost btn-icon" data-act="more" data-id="${esc(o.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="Thao tác khác cho đơn ${esc(orderNo(o))}">${I('moreH', 'sm')}</button>`;
  }
  const ticketCell = (o) => o.ticketChannelId ? `<button class="badge b-${o.ticketOpen ? 'info' : 'neutral'}" style="cursor:pointer" data-act="ticket" data-id="${esc(o.id)}" aria-label="Mở ticket ${esc(o.ticketChannelName || '')}">${I('hash')}${o.ticketOpen ? 'Đang mở' : 'Đã đóng'}</button>` : '<span class="muted">—</span>';

  function render() {
    const all = visibleOrders();
    const counts = { all: all.length }; Object.keys(STATUS).forEach((s) => (counts[s] = all.filter((o) => o.status === s).length));
    $('#orderStatusFilters').innerHTML = FILTERS.map(([k, full]) => { const n = counts[k] || 0; const on = !view.statuses && view.filter === k; return `<button id="filterBtn_${k}" data-filter="${k}" class="${n || on ? '' : 'zero'}" aria-pressed="${on}" aria-label="${full}: ${n} đơn">${full} <span class="n" id="filterCount_${k}">${n}</span></button>`; }).join('');
    const adv = [view.pay, view.provider, view.min, view.max, view.ticket, view.pays].filter(Boolean).length; const ac = $('#orderAdvCount'); ac.hidden = !adv; ac.textContent = adv;
    renderKpis(all);
    const tb = $('#ordersTableBody'), mob = $('#ordersCardsMobile'); const cols = 6; const more = $('#btnOrdersLoadMore');
    more.hidden = true;
    if (view.loading && !Store.orders.length) { tb.innerHTML = state.skeletonRows(cols); mob.innerHTML = state.skeletonBlock(4); return; }
    if (view.error) { tb.innerHTML = `<tr><td colspan="${cols}">${state.error(view.error, 'btnRetryOrders')}</td></tr>`; mob.innerHTML = state.error(view.error); $('#btnRetryOrders')?.addEventListener('click', load); return; }
    const arr = filtered(); const page = arr.slice(0, view.limit);
    $('#ordersFootText').textContent = arr.length ? `Hiển thị ${page.length} / ${arr.length} đơn` : '0 đơn';
    more.hidden = page.length >= arr.length; more.lastChild.textContent = `Tải thêm (${Math.min(PAGE, arr.length - page.length)})`;
    if (!arr.length) { const e = all.length ? state.empty('Không có đơn phù hợp', 'Thử thay đổi bộ lọc hoặc từ khóa tìm kiếm', `<div class="row" style="gap:8px;justify-content:center"><button class="btn" data-orders-clear>${I('x', 'sm')}Xóa bộ lọc</button><button class="btn btn-primary" data-orders-all>Xem tất cả đơn</button></div>`) : state.empty('Chưa có đơn nào', Auth.isAdmin() ? 'Đơn mới từ ticket Discord sẽ xuất hiện ở đây.' : 'Chưa có đơn nào được giao cho bạn.'); tb.innerHTML = `<tr><td colspan="${cols}">${e}</td></tr>`; mob.innerHTML = e; return; }
    tb.innerHTML = page.map((o) => `<tr>
      <td class="col-order"><button class="mono cell-main" style="background:none;border:0;padding:0;cursor:pointer;color:inherit" data-act="open" data-id="${esc(o.id)}">${esc(orderNo(o))}</button><div class="cell-sub order-reference">${esc(paySummary(o))}</div></td>
      <td class="col-subject"><div class="order-subject"><div class="person">${avatar(o.customerAvatar, cleanCustomerName(o.customerName), 'sm')}<div><div class="cell-main">${esc(cleanCustomerName(o.customerName))}</div><div class="cell-sub mono">${esc(shortId(o.discordId))}</div></div></div><div class="order-product">${esc(o.service)}</div></div></td>
      <td class="col-owner"><div class="owner-stack">${Auth.isAdmin() ? `<span class="secondary">${esc(sellerName(o.sellerId))}</span>` : ''}${ticketCell(o)}</div></td>
      <td class="col-state"><div class="status-stack">${statusBadge(o.status)}${payBadge(o)}</div></td>
      <td class="num col-value"><div class="mono cell-main">${esc(vnd(o.amount))}</div><div class="cell-sub mono order-created">${esc(dShort(o.createdAt))}</div></td>
      <td class="col-actions"><div class="row-actions">${rowActions(o)}</div></td></tr>`).join('');
    mob.innerHTML = page.map((o) => `<article class="ocard">
      <div class="top"><button class="mono cell-main" style="background:none;border:0;padding:0;color:inherit;cursor:pointer" data-act="open" data-id="${esc(o.id)}">${esc(orderNo(o))}</button><span class="spacer"></span><div class="status-stack" style="align-items:flex-end;gap:4px">${statusBadge(o.status)}${payBadge(o)}</div></div>
      <div class="row wrap" style="gap:6px"><span class="cell-sub">${esc(paySummary(o))}</span></div>
      <div class="row"><div style="flex:1;min-width:0"><div class="cell-main">${esc(o.service)}</div><div class="cell-sub">${esc(cleanCustomerName(o.customerName))}${Auth.isAdmin() ? ` · ${esc(sellerName(o.sellerId))}` : ''} · ${esc(dShort(o.createdAt))}</div></div><span class="amt">${esc(vnd(o.amount))}</span></div>
      <div class="row wrap">${ticketCell(o)}<span class="spacer"></span>${rowActions(o, true)}</div></article>`).join('');
  }

  // Owner KPIs: each one filters the list below.
  const KPI = [
    { id: 'rev', label: 'Doanh thu đã nhận', icon: 'wallet', tone: 'accent', f: { pays: ['PAID'] }, sub: 'Đơn đã thanh toán' },
    { id: 'proc', label: 'Đang xử lý', icon: 'rotate', f: { status: 'PROCESSING' }, sub: 'Đang trong luồng xử lý' },
    { id: 'comp', label: 'Hoàn tất', icon: 'checkCircle', f: { status: 'COMPLETED' }, sub: 'Đã giao thành công' },
    { id: 'canc', label: 'Đã hủy', icon: 'ban', f: { status: 'CANCELLED' }, sub: 'Đơn hủy hoặc hoàn tiền' },
  ];
  function renderKpis(all) {
    const box = $('#orderKpis'); if (!box) return;
    if (!Auth.isAdmin()) { box.hidden = true; return; }
    const sum = (a) => a.reduce((s, o) => s + Number(o.amount || 0), 0);
    const val = {
      rev: `${UI.num(sum(all.filter((o) => REVENUE_PAY.includes(payStatusOf(o)))))}<small>VNĐ</small>`,
      proc: all.filter((o) => o.status === 'PROCESSING').length,
      comp: all.filter((o) => o.status === 'COMPLETED').length,
      canc: all.filter((o) => o.status === 'CANCELLED').length
    };
    const active = (k) => JSON.stringify({ status: view.statuses ? undefined : view.filter === 'all' ? undefined : view.filter, pays: view.pays || undefined }) === JSON.stringify({ status: k.f.status, pays: k.f.pays });
    box.innerHTML = KPI.map((k) => `<button class="metric clickable ${k.tone || ''}" data-kpi="${k.id}" aria-pressed="${active(k)}"><div class="k">${I(k.icon)}${esc(k.label)}</div><div class="v">${val[k.id]}</div><div class="s">${esc(k.sub)}</div></button>`).join('');
  }

  async function load() {
    view.loading = true; view.error = null; render();
    try { Store.orders = R.reconcile(API.list(await API.orders(), 'orders', 'items', 'data').filter((o) => !o.archived), Store.tx); $('#ordersLastUpdated').textContent = new Date().toLocaleTimeString('vi-VN'); }
    catch (e) { if (e.status !== 401) view.error = e.status === 403 ? 'Bạn không đủ quyền xem danh sách đơn.' : e.message; }
    view.loading = false; render(); window.App?.refreshCounts();
  }

  // ----- Detail modal
  let current = null;
  function openDetail(id, keepOpen, ctx) {
    const o = find(id); if (!o || !R.canSeeOrder(o, me())) return; current = o;
    const admin = Auth.isAdmin(); const canNote = R.canEditNotes(o, me());
    $('#editModalOrderNo').textContent = orderNo(o);
    $('#editModalStatusChip').innerHTML = statusBadge(o.status);
    $('#editModalPayChip').innerHTML = payBadge(o);
    $('#editModalCreatedAt').textContent = `${dt(o.createdAt)} · cập nhật ${dt(o.updatedAt)}`;
    const setRO = (sel, ro) => { const el = $(sel); el.disabled = ro; el.readOnly = ro; };
    $('#editInputService').value = o.service || ''; setRO('#editInputService', !admin);
    const cancelled = o.status === 'CANCELLED'; const cur = STEPS.indexOf(o.status);
    $('#editStepper').innerHTML = STEPS.map((k, i) => `<li class="${!cancelled && i < cur ? 'done' : !cancelled && i === cur ? 'current' : ''}" ${!cancelled && i === cur ? 'aria-current="step"' : ''}><span class="dot"></span>${esc(STATUS[k].t)}</li>`).join('') + (cancelled ? `<li class="current exc" aria-current="step"><span class="dot"></span>Đã hủy</li>` : '');
    const pa = R.primaryAction(o, me());
    $('#editStatusHint').textContent = pa === 'checkPayment' ? 'Đang chờ khách chuyển khoản. Đơn tự ghi nhận thanh toán khi giao dịch khớp.' : pa ? `Bước tiếp theo: ${R.ACTIONS[pa].label}.` : ['COMPLETED', 'CANCELLED'].includes(o.status) ? 'Đơn đã ở trạng thái cuối.' : 'Bạn không có thao tác nào cho đơn ở trạng thái này.';
    const linked = txOf(o);
    const main = linked.find((t) => t.transactionId === o.transactionId) || linked[0];
    const paidTotal = payStatusOf(o) === 'PAID' ? Number(o.amount) : 0;
    $('#editPayExtra').innerHTML = `<div class="kv"><span>Số tiền đơn</span><span class="mono">${esc(vnd(o.amount))}</span></div><div class="kv"><span>Đã ghi nhận</span><span class="mono">${esc(vnd(paidTotal))}</span></div><div class="kv"><span>Tài khoản nhận</span><span class="mono">${esc(main?.receiverAccount || (o.provider === 'MANUAL' ? 'Thủ công' : '—'))}</span></div>`;
    $('#od-refund').hidden = true;
    $('#editInputAmount').value = o.amount ?? ''; setRO('#editInputAmount', !R.canEditMoney(me()));
    $('#editAmountFormatted').textContent = vnd(o.amount);
    $('#editPayProvider').textContent = PROVIDER(o.provider) || '—'; $('#editPayTxn').textContent = o.transactionId || '—'; $('#editPayStatus').innerHTML = payBadge(o);
    $('#btnCopyTxn').hidden = !o.transactionId;
    $('#editInputCustomerName').value = cleanCustomerName(o.customerName); setRO('#editInputCustomerName', !admin);
    $('#editInputDiscordId').value = o.discordId || ''; setRO('#editInputDiscordId', !admin);
    $('#editSelectSeller').innerHTML = `<option value="">Chưa phân</option>` + (Store.data?.sellers || []).map((s) => `<option value="${esc(s.id)}" ${String(s.id) === String(o.sellerId) ? 'selected' : ''}>${esc(s.globalName || s.username)}</option>`).join('');
    setRO('#editSelectSeller', !admin);
    $('#editTicketChannelName').textContent = o.ticketChannelName ? `#${o.ticketChannelName}` : 'Không có ticket';
    $('#editTicketChannelId').textContent = o.ticketChannelId || '—';
    $('#editTicketChannelBadge').innerHTML = o.ticketChannelId ? badge(o.ticketOpen ? 'info' : 'neutral', '', o.ticketOpen ? 'Đang mở' : 'Đã đóng') : '';
    $('#btnOpenTicket').hidden = !o.ticketChannelId;
    $('#editInputNotes').value = o.notes || ''; setRO('#editInputNotes', !canNote);
    const notify = $('#editNotifyDiscord').closest('label'); if (notify) notify.hidden = !admin;
    $('#btnCompleteOwn').hidden = true;
    $('#btnSaveOrderEdit').hidden = !(admin || canNote);
    $('#btnSaveOrderEdit').lastChild.textContent = admin ? 'Lưu thay đổi' : 'Lưu ghi chú';
    const pab = pa && pa !== 'checkPayment' ? `<button class="btn btn-primary" data-act="run" data-action="${pa}" data-id="${esc(o.id)}">${I((R.ACTIONS[pa] || PSEUDO[pa]).icon, 'sm')}${esc((R.ACTIONS[pa] || PSEUDO[pa]).label)}</button>` : '';
    const others = trimActs(R.allowedActions(o, me()), o).filter((id) => id !== pa);
    $('#orderActionBar').innerHTML = pab + (others.length ? `<button class="btn" data-act="more" data-id="${esc(o.id)}" aria-haspopup="menu" aria-expanded="false">${I('moreH', 'sm')}Thao tác khác</button>` : '');
    // Payment history
    const ph = $('#editPayHistory');
    if (ph) { const txs = (Store.tx || []).filter((t) => String(t.orderId) === String(o.id) || t.orderCode === orderNo(o)); ph.innerHTML = txs.length ? txs.map((t) => { const m = Finance.txMeta(t.status); return `<div class="history-row"><span class="t">${esc(dShort(t.createdAt))}</span><span class="row wrap" style="gap:8px">${badge(m.k, m.i, m.t)}<span class="mono">${esc(t.transactionId)}</span><span class="muted">${esc(t.provider || '')} · ${esc(t.source || '')}</span>${t.transactionId === o.transactionId ? badge('brand', '', 'Giao dịch chính') : ''}${t.handled ? '<span class="muted">Đã xử lý</span>' : ''}${t.status !== 'MATCHED' ? `<span class="cell-sub" style="flex-basis:100%">${esc(R.txReason(t, o, vnd))}</span>` : ''}</span><span class="mono cell-main">${esc(vnd(t.amount))}</span></div>`; }).join('') : `<p class="muted" style="margin:0">${Store.tx.length ? 'Chưa có giao dịch nào gắn với đơn này.' : 'Chưa tải dữ liệu đối soát.'}</p>`; }
    const hist = $('#editHistory');
    if (hist) { const logs = (Store.audit || []).filter((a) => a.orderId === orderNo(o) || a.orderId === o.id); hist.innerHTML = logs.length ? logs.map((a) => `<div class="history-row"><span class="t">${esc(dShort(a.createdAt))}</span><span class="row wrap" style="gap:8px">${Finance.actBadge(a.action)}<span class="secondary">${esc(a.actorId)} (${esc(a.actorType)})</span></span><span class="mono muted" style="font-size:12px">${esc(Object.values(a.before || {}).flat().join(','))} → ${esc(Object.values(a.after || {}).flat().join(','))}${a.metadata?.reason ? `<span class="cell-sub" style="display:block">Lý do: ${esc(a.metadata.reason)}</span>` : ''}</span></div>`).join('') : '<p class="muted" style="margin:0">Chưa có lịch sử cho đơn này.</p>'; }
    if (!keepOpen) openModal('orderEditModal', { focus: '[data-close]', back: ctx?.back });
  }

  async function saveDetail() {
    const o = current; if (!o) return; const admin = Auth.isAdmin();
    await withLoading($('#btnSaveOrderEdit'), async () => {
      try {
        if (admin) {
          const amount = Number(String($('#editInputAmount').value).replace(/\D/g, ''));
          const notify = $('#editNotifyDiscord').checked;
          if (amount !== Number(o.amount)) {
            if (!amount) { toast('Số tiền không hợp lệ.', 'error'); return; }
            const r = await reasonDialog({ title: 'Đổi số tiền đơn?', message: `${vnd(o.amount)} → ${vnd(amount)}`, warning: payStatusOf(o) === 'PAID' ? 'Đơn đã thanh toán — số tiền mới sẽ không khớp với giao dịch đã nhận.' : 'Khách cần chuyển đúng số tiền mới để hệ thống tự xác nhận.', confirmText: 'Đổi số tiền', tone: 'warning', icon: 'wallet' });
            if (r === null) return; await API.setAmount(o.id, amount, r);
          }
          await API.updateOrder(o.id, { service: $('#editInputService').value, customerName: $('#editInputCustomerName').value, discordId: $('#editInputDiscordId').value, sellerId: $('#editSelectSeller').value || null, notes: $('#editInputNotes').value, notify });
        } else if (R.canEditNotes(o, me())) {
          await API.updateOrder(o.id, { notes: $('#editInputNotes').value });
        }
        toast(admin ? 'Đã lưu đơn hàng' : 'Đã lưu ghi chú'); closeModal('orderEditModal'); reloadAll();
      } catch (e) { toast(e.message, 'error'); }
    });
  }

  // ----- Manual order
  function openCreate() {
    const d = Store.data || {};
    $('#coProduct').innerHTML = `<option value="">— Khác —</option>` + (d.products || []).map((p) => `<option value="${esc(p.key)}" data-seller="${esc(p.sellerId || '')}">${esc(p.name)}</option>`).join('');
    $('#coSeller').innerHTML = `<option value="">Chưa phân</option>` + (d.sellers || []).map((s) => `<option value="${esc(s.id)}">${esc(s.globalName || s.username)}</option>`).join('');
    $('#createOrderForm').reset(); $('#coAmountFmt').textContent = '';
    openModal('createOrderModal');
  }
  async function submitCreate(e) {
    e.preventDefault();
    const amount = Number($('#coAmount').value.replace(/\D/g, ''));
    if (!$('#coService').value.trim() || !$('#coCustomer').value.trim() || !amount) { toast('Điền sản phẩm, tên khách và số tiền.', 'error'); return; }
    await withLoading($('#btnSubmitCreateOrder'), async () => {
      try { await API.createOrder({ productKey: $('#coProduct').value, service: $('#coService').value.trim(), amount, sellerId: $('#coSeller').value || null, customerName: $('#coCustomer').value.trim(), discordId: $('#coDiscordId').value.trim(), status: $('#coStatus').value, notes: $('#coNotes').value }); toast('Đã tạo đơn'); closeModal('createOrderModal'); load(); }
      catch (er) { toast(er.message, 'error'); }
    });
  }

  function init() {
    const reset = () => { view.limit = PAGE; render(); };
    $('#orderStatusFilters').addEventListener('click', (e) => { const b = e.target.closest('[data-filter]'); if (!b) return; view.filter = b.dataset.filter; view.statuses = null; reset(); $(`#filterBtn_${view.filter}`)?.focus(); });
    $('#btnOrderMoreFilters').addEventListener('click', (e) => { const p = $('#orderAdvFilters'); p.hidden = !p.hidden; e.currentTarget.setAttribute('aria-expanded', String(!p.hidden)); });
    const numv = (el) => el.value.replace(/\D/g, '');
    $('#orderPayFilter').addEventListener('change', (e) => { view.pay = e.target.value; reset(); });
    $('#orderProviderFilter').addEventListener('change', (e) => { view.provider = e.target.value; reset(); });
    $('#orderAmountMin').addEventListener('input', UI.debounce((e) => { view.min = numv(e.target); reset(); }, 300));
    $('#orderAmountMax').addEventListener('input', UI.debounce((e) => { view.max = numv(e.target); reset(); }, 300));
    $('#orderTicketOpen').addEventListener('change', (e) => { view.ticket = e.target.checked; reset(); });
    $('#btnClearOrderFilters').addEventListener('click', () => setFilter({}));
    const clear = () => setFilter({});
    document.addEventListener('click', (e) => { if (e.target.closest('[data-orders-clear]')) clear(); if (e.target.closest('[data-orders-all]')) clear(); const k = e.target.closest('#orderKpis [data-kpi]'); if (k) setFilter(KPI.find((x) => x.id === k.dataset.kpi).f); });
    $('#orderSearchInput').addEventListener('input', UI.debounce((e) => { view.q = e.target.value.trim(); reset(); }, 200));
    $('#orderSellerFilter')?.addEventListener('change', (e) => { view.seller = e.target.value; reset(); });
    $('#orderRangeFilter').addEventListener('change', (e) => { view.range = e.target.value; reset(); });
    $('#orderSort').addEventListener('change', (e) => { view.sort = e.target.value; reset(); });
    $('#btnOrdersLoadMore').addEventListener('click', () => { view.limit += PAGE; render(); });
    $('#btnRefreshOrders').addEventListener('click', (e) => withLoading(e.currentTarget, load));
    $('#btnCreateOrder')?.addEventListener('click', openCreate);
    $('#createOrderForm').addEventListener('submit', submitCreate);
    $('#coAmount').addEventListener('input', (e) => { $('#coAmountFmt').textContent = e.target.value ? vnd(e.target.value.replace(/\D/g, '')) : ''; });
    $('#coProduct').addEventListener('change', (e) => { const s = e.target.selectedOptions[0]?.dataset.seller; if (s) $('#coSeller').value = s; });
    $('#editInputAmount').addEventListener('input', (e) => { $('#editAmountFormatted').textContent = vnd(e.target.value.replace(/\D/g, '')); });
    $('#btnSaveOrderEdit').addEventListener('click', saveDetail);
    $('#btnDeleteOrderInModal')?.addEventListener('click', () => archive(current));
    $('#btnCopyTxn').addEventListener('click', () => current?.transactionId && copy(current.transactionId, 'Đã sao chép mã giao dịch'));
    $('#btnOpenTicket').addEventListener('click', () => openTicket(current));
    $$('.od-nav a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); document.querySelector(a.getAttribute('href'))?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }));
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return; const { act, id } = b.dataset; const o = find(id);
      if (act === 'open') openDetail(id);
      else if (!o) return;
      else if (act === 'run') runAction(b.dataset.action, o, b);
      else if (act === 'more') UI.menu(b, menuItems(o, !!b.closest('#orderEditModal')));
      else if (act === 'ticket') openTicket(o);
    });
  }
  // Used by overview KPIs: setFilter({ status, statuses, pay, ticket })
  function setFilter(p = {}) {
    Object.assign(view, { filter: p.status || 'all', statuses: p.statuses || null, pays: p.pays || null, q: '', seller: '', range: '', pay: p.pay || '', provider: '', min: '', max: '', ticket: !!p.ticket, limit: PAGE });
    $('#orderSearchInput').value = ''; ['#orderSellerFilter', '#orderRangeFilter', '#orderPayFilter', '#orderProviderFilter'].forEach((s) => { const el = $(s); if (el) el.value = view[{ '#orderSellerFilter': 'seller', '#orderRangeFilter': 'range', '#orderPayFilter': 'pay', '#orderProviderFilter': 'provider' }[s]]; });
    $('#orderAmountMin').value = ''; $('#orderAmountMax').value = ''; $('#orderTicketOpen').checked = view.ticket;
    if (p.statuses || p.pay || p.ticket) { $('#orderAdvFilters').hidden = false; $('#btnOrderMoreFilters').setAttribute('aria-expanded', 'true'); }
    render();
  }
  function fillSellerFilter() { const s = $('#orderSellerFilter'); if (!s) return; s.innerHTML = `<option value="">Mọi seller</option>` + (Store.data?.sellers || []).map((x) => `<option value="${esc(x.id)}">${esc(x.globalName || x.username)}</option>`).join(''); }

  window.Orders = { init, load, render, setFilter, paySummary, openDetail, openTicket, statusBadge, payBadge, STATUS, PAY, sellerName, orderNo, fillSellerFilter, runAction };
  window.loadOrders = load; window.openOrderEditModal = openDetail;
})();
