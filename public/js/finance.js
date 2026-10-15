/* Payment reconciliation + Audit log (admin only) */
(function () {
  const { $, $$, esc, I, vnd, dt, dShort, shortId, badge, state } = UI;
  const R = window.OrderRules;
  const reason = (t) => R.txReason(t, null, vnd);

  // Transaction status (technical) → label. Shown as "Lý do" detail, not as top-level state.
  const TX = {
    MATCHED: { k: 'success', i: 'checkCircle', t: 'Khớp tự động' },
    SUCCESS: { k: 'success', i: 'checkCircle', t: 'Khớp tự động' },
    PAID: { k: 'success', i: 'checkCircle', t: 'Khớp tự động' },
    AMOUNT_MISMATCH: { k: 'warning', i: 'alert', t: 'Không khớp số tiền' },
    ORDER_ALREADY_PAID: { k: 'warning', i: 'copy', t: 'Đơn đã thanh toán' },
    UNKNOWN_ORDER_CODE: { k: 'warning', i: 'help', t: 'Sai mã đơn' },
    ORDER_NOT_FOUND: { k: 'warning', i: 'search', t: 'Không tìm thấy đơn' },
    UNAUTHORIZED_RECEIVER_ACCOUNT: { k: 'danger', i: 'shield', t: 'Sai tài khoản nhận' },
    MISSING_RECEIVING_ACCOUNT: { k: 'danger', i: 'bank', t: 'Thiếu tài khoản nhận' },
    PAYMENT_CONFIG_ERROR: { k: 'danger', i: 'settings', t: 'Lỗi cấu hình' },
  };
  const GROUPS = [
    { id: 'all', t: 'Tất cả giao dịch', i: 'list', sub: (n) => `${n} giao dịch` },
    { id: 'review', t: 'Cần xử lý', i: 'scale', sub: (n, u) => `${u} chưa xử lý` },
    { id: 'matched', t: 'Khớp tự động', i: 'checkCircle', sub: () => 'Đã tự cập nhật đơn' },
    { id: 'config', t: 'Lỗi cấu hình', i: 'settings', sub: (n, u) => `${u} chưa xử lý` },
  ];
  const meta = (s) => ({ ...(TX[s] || { k: 'neutral', i: 'help', t: s }), g: R.txGroup(s) });
  const rv = { group: 'review', reason: '', handled: '', q: '', range: '', loading: false, error: null, limit: 10 };
  const findTx = (id) => Store.tx.find((t) => String(t.id) === String(id));
  const orderOf = (t) => t.orderId != null && Store.orders.find((x) => String(x.id) === String(t.orderId));
  const inGroup = (t, g) => g === 'all' || meta(t.status).g === g;
  const reasonsFor = (g) => Object.keys(TX).filter((k) => k !== 'MATCHED' && (g === 'all' || R.txGroup(k) === g));

  function filteredTx() {
    const since = rv.range ? Date.now() - Number(rv.range) * 864e5 : 0;
    return Store.tx.filter((t) => inGroup(t, rv.group) && (!rv.reason || t.status === rv.reason)
      && (!rv.handled || (rv.handled === 'yes') === !!t.handled)
      && (!since || new Date(t.createdAt).getTime() >= since)
      && (!rv.q || [t.transactionId, t.orderCode, t.description].some((v) => String(v || '').toLowerCase().includes(rv.q))))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
  // Selecting a group resets a reason that no longer belongs to it.
  function setGroup(g) { rv.group = g; if (rv.reason && !reasonsFor(g).includes(rv.reason)) rv.reason = ''; rv.limit = 10; }
  function focusOrder(code) { rv.group = 'all'; rv.reason = ''; rv.handled = ''; rv.q = String(code).toLowerCase(); rv.limit = 10; }

  // ----- Actions (mock; each opens a modal, money-related ones need a reason)
  async function after(t) { await loadRecon(true); await Orders.load(); renderRecon(); if (t && !$('#txDetailModal').hidden) openTx(t.id, false, true); App.refreshCounts(); loadAudit(true); }
  async function setHandled(t, value, opts = {}) {
    const r = await UI.reasonDialog(value
      ? { title: 'Đánh dấu đã xử lý?', message: `${t.transactionId} · ${reason(t)}`, warning: 'Không tự đổi trạng thái đơn. Đảm bảo bạn đã liên hệ khách hoặc hoàn tiền nếu cần.', confirmText: 'Đánh dấu đã xử lý', tone: 'warning', icon: 'check' }
      : { title: 'Đánh dấu chưa xử lý?', message: `${t.transactionId} sẽ quay lại danh sách cần xử lý.`, warning: opts.exception ? 'Giao dịch đã khớp tự động. Thao tác ngoại lệ — trạng thái đơn KHÔNG thay đổi.' : '', confirmText: 'Đánh dấu chưa xử lý', tone: opts.exception ? 'danger' : 'warning', icon: 'rotate', twoStep: !!opts.exception, ack: opts.exception ? 'Tôi hiểu thao tác này được ghi vào audit log' : '' });
    if (r === null) return;
    try { const res = await API.markTxHandled(t.id, value, r); Object.assign(t, res || { handled: value }); UI.toast(value ? 'Đã đánh dấu đã xử lý' : 'Đã chuyển về chưa xử lý'); await after(t); } catch (e) { UI.toast(e.message, 'error'); }
  }
  async function attach(t, opts = {}) {
    const suggest = (q) => {
      const ql = q.toLowerCase(); const hits = ql.length < 2 ? [] : Store.orders.filter((x) => Orders.orderNo(x).toLowerCase().includes(ql) || String(x.customerName || '').toLowerCase().includes(ql)).slice(0, 5);
      const head = `<div class="readonly-box row wrap" style="gap:8px"><span class="muted">Giao dịch</span><span class="mono cell-main">${esc(t.transactionId)}</span><span class="spacer"></span><span class="mono">${esc(vnd(t.amount))}</span></div>`;
      if (ql.length < 2) return head + '<p class="hint" style="margin:0">Nhập ít nhất 2 ký tự mã đơn hoặc tên khách.</p>';
      if (!hits.length) return head + '<p class="hint" style="margin:0">Không có đơn phù hợp.</p>';
      return head + hits.map((x) => { const mm = Number(x.amount) !== Number(t.amount); return `<button type="button" class="suggest-item" data-pick="${esc(Orders.orderNo(x))}"><span class="mono cell-main">${esc(Orders.orderNo(x))}</span>${Orders.statusBadge(x.status)}<span class="cell-sub" style="flex:1">${esc(x.customerName || '—')}</span><span class="mono">${esc(vnd(x.amount))}</span>${mm ? `<span class="badge b-warning">Lệch ${esc(vnd(t.amount - x.amount))}</span>` : ''}</button>`; }).join('');
    };
    const code = await UI.promptDialog({ title: 'Gắn giao dịch vào đơn', message: `${opts.exception ? 'Thao tác ngoại lệ · ' : ''}${t.transactionId} · ${vnd(t.amount)}. Tìm và chọn đơn cần gắn.`, label: 'Mã đơn hoặc tên khách', value: '', placeholder: '4AM000123', icon: 'link', confirmText: 'Tiếp tục', suggest });
    if (!code) return;
    const o = Store.orders.find((x) => Orders.orderNo(x).toLowerCase() === code.toLowerCase());
    if (!o) { UI.toast('Không tìm thấy đơn với mã này.', 'error'); return; }
    const mismatch = Number(o.amount) !== Number(t.amount);
    const r = await UI.reasonDialog({ title: `Gắn ${t.transactionId} vào ${Orders.orderNo(o)}?`, message: `Đơn: ${o.service} · ${o.customerName || ''} · ${Orders.STATUS[o.status]?.t}.`, warning: opts.exception ? 'Giao dịch đang là thanh toán chính của đơn khác. Đơn cũ sẽ mất giao dịch này.' : mismatch ? `Số tiền giao dịch không khớp số tiền đơn. Payment vẫn giữ trạng thái Chưa thanh toán.` : 'Giao dịch được gắn vào đơn.', confirmText: 'Gắn vào đơn', tone: opts.exception || mismatch ? 'danger' : 'warning', icon: 'link', twoStep: !!(opts.exception || mismatch) });
    if (r === null) return;
    try { const res = await API.attachTx(t.id, o.id, r); Object.assign(t, res || {}); UI.toast(`Đã gắn vào đơn ${Orders.orderNo(o)}`); await after(t); } catch (e) { UI.toast(e.message, 'error'); }
  }
  async function manualApprove(t) {
    const o = orderOf(t); if (!o) { UI.toast('Gắn giao dịch vào đơn trước khi duyệt.', 'info'); return attach(t); }
    await Orders.runAction('manualApprove', o); await after(t);
  }
  const toSeller = () => { UI.closeModal('txDetailModal'); App.go('sellers'); };
  const viewOrder = (t, o) => Orders.openDetail(o.id, false, { back: { label: `Quay lại giao dịch ${t.transactionId}`, crumb: ['Đối soát', t.transactionId, `Đơn ${Orders.orderNo(o)}`], onClick: () => openTx(t.id) } });
  function txActions(t) {
    const g = meta(t.status).g; const o = orderOf(t);
    const base = [{ label: 'Xem chi tiết', icon: 'receipt', onClick: () => openTx(t.id) }, { label: 'Xem raw payload', icon: 'note', onClick: () => openTx(t.id, true) }];
    const acts = g === 'matched' ? [{ label: 'Thao tác ngoại lệ: gắn sang đơn khác', icon: 'link', tone: 'danger', onClick: () => attach(t, { exception: true }) }, t.handled && { label: 'Thao tác ngoại lệ: đánh dấu chưa xử lý', icon: 'rotate', tone: 'danger', onClick: () => setHandled(t, false, { exception: true }) }]
      : g === 'config' ? [{ label: 'Mở seller', icon: 'users', onClick: toSeller }, { label: 'Kiểm tra tài khoản nhận', icon: 'bank', onClick: toSeller }, { label: t.handled ? 'Đánh dấu chưa xử lý' : 'Đánh dấu đã xử lý', icon: 'check', onClick: () => setHandled(t, !t.handled) }]
      : [{ label: t.orderId ? 'Gắn sang đơn khác' : 'Gắn vào đơn', icon: 'link', onClick: () => attach(t) }, o && o.status === 'PENDING_PAYMENT' && { label: 'Duyệt thủ công', icon: 'shield', onClick: () => manualApprove(t) }, { label: t.handled ? 'Đánh dấu chưa xử lý' : 'Đánh dấu đã xử lý', icon: 'check', onClick: () => setHandled(t, !t.handled) }];
    return [...base, '-', ...acts, o && '-', o && { label: 'Xem đơn liên quan', icon: 'chevronRight', onClick: () => Orders.openDetail(o.id) }, o?.ticketChannelId && { label: 'Mở ticket', icon: 'hash', onClick: () => Orders.openTicket(o) }, { label: 'Copy mã giao dịch', icon: 'copy', onClick: () => UI.copy(t.transactionId, 'Đã sao chép mã giao dịch') }];
  }

  function openTx(id, raw, keep, ctx) {
    const t = findTx(id); if (!t) return; const m = meta(t.status); const o = orderOf(t);
    $('#txDetailTitle').textContent = t.transactionId; $('#txDetailSub').innerHTML = `${badge(m.k, m.i, m.t)} ${t.handled ? badge('success', 'check', 'Đã xử lý') : badge('neutral', 'clock', 'Chưa xử lý')}`;
    $('#txDetailBody').innerHTML = `
      ${m.g === 'matched' ? `<div class="alert alert-info">${I('checkCircle')}<span><b>Đã tự động cập nhật đơn.</b> Khớp mã đơn, đủ số tiền, đúng tài khoản nhận.</span></div>` : `<div class="alert ${m.g === 'config' ? 'alert-danger' : 'alert-warning'}">${I('alert')}<span><b>${m.g === 'config' ? 'Lỗi cấu hình:' : 'Cần xử lý:'}</b> ${esc(reason(t))}${m.g !== 'matched' ? ' Đơn không bị tự động thay đổi.' : ''}</span></div>`}
      <div style="display:grid;grid-template-columns:minmax(190px, 1fr) minmax(280px, 1.4fr);gap:12px">
        <div class="readonly-box stack" style="gap:10px">
          <div class="kv">
            <span style="white-space:nowrap;flex-shrink:0;color:var(--text-muted);font-size:12.5px">Số tiền giao dịch</span>
            <span class="mono cell-main" style="font-weight:700;font-size:15px;color:var(--success, #10B981)">+${esc(vnd(t.amount))}</span>
          </div>
          <div class="kv">
            <span style="white-space:nowrap;flex-shrink:0;color:var(--text-muted);font-size:12.5px">Số tiền đơn</span>
            <span class="mono" style="font-size:13px">${t.expectedAmount != null ? esc(vnd(t.expectedAmount)) : '—'}</span>
          </div>
          <div class="kv" style="border-top:1px dashed var(--border-default);padding-top:8px">
            <span style="white-space:nowrap;flex-shrink:0;color:var(--text-muted);font-size:12px">Thời gian</span>
            <span class="mono" style="font-size:12px;color:var(--text-secondary)">${esc(dt(t.createdAt))}</span>
          </div>
        </div>
        <div class="readonly-box stack" style="gap:7px;font-size:12.5px">
          <div class="kv" style="align-items:flex-start">
            <span style="white-space:nowrap;flex-shrink:0;color:var(--text-muted);font-size:12px;padding-top:2px">Nội dung CK</span>
            <span class="mono" style="font-size:11.5px;word-break:break-all;text-align:right;max-width:240px;line-height:1.4;color:var(--text-primary);background:var(--surface-2, rgba(255,255,255,0.03));padding:3px 6px;border-radius:4px;border:1px solid var(--border-default)" title="${esc(t.description || '—')}">${esc(t.description || '—')}</span>
          </div>
          <div class="kv">
            <span style="white-space:nowrap;flex-shrink:0;color:var(--text-muted);font-size:12px">Mã đơn</span>
            <span class="mono" style="font-weight:700;font-size:12.5px;color:var(--text-primary)">${t.orderCode ? `#${esc(t.orderCode)}` : '—'}</span>
          </div>
          <div class="kv">
            <span style="white-space:nowrap;flex-shrink:0;color:var(--text-muted);font-size:12px">TK nhận</span>
            <span class="mono" style="font-size:12px">${esc(t.receiverAccount || '—')}</span>
          </div>
          <div class="kv">
            <span style="white-space:nowrap;flex-shrink:0;color:var(--text-muted);font-size:12px">Cổng thanh toán</span>
            <span style="font-size:12px;text-align:right;font-weight:500">${esc(formatProvider(t))}</span>
          </div>
        </div>
      </div>
      <div><p class="section-title">Đơn liên kết</p>${o ? `<div class="readonly-box row wrap"><span class="mono cell-main">${esc(Orders.orderNo(o))}</span>${Orders.statusBadge(o.status)}${Orders.payBadge(o)}<span class="cell-sub" style="flex:1">${esc(o.service)} · ${esc(o.customerName || '')}</span><button class="btn btn-sm" id="txOpenOrder">Xem đơn</button></div>` : `<p class="muted" style="margin:0">Chưa gắn với đơn nào.</p>`}</div>
      <details ${raw ? 'open' : ''} id="txRaw"><summary class="label" style="cursor:pointer">Raw payload</summary><div class="row" style="justify-content:flex-end;margin-top:6px"><button class="btn btn-sm btn-ghost" id="txCopyRaw">${I('copy', 'sm')}Copy JSON</button></div><pre class="json">${esc(JSON.stringify(t.raw ?? t, null, 2))}</pre></details>`;
    const B = (id2, label, icon, cls = '') => `<button class="btn ${cls}" id="${id2}">${I(icon, 'sm')}${label}</button>`;
    let foot = '';
    if (m.g === 'matched') foot = `<span class="spacer"></span><button class="btn btn-ghost" id="txExcMenu" aria-haspopup="menu">${I('alert', 'sm')}Thao tác ngoại lệ</button>`;
    else if (m.g === 'config') foot = `<span class="spacer"></span>${B('txSeller', 'Mở seller', 'users')}${B('txBank', 'Kiểm tra tài khoản nhận', 'bank')}${t.handled ? '' : B('txHandled', 'Đánh dấu đã xử lý', 'check', 'btn-primary')}`;
    else foot = `${o?.ticketChannelId ? B('txTicket', 'Mở ticket', 'hash') : ''}<span class="spacer"></span>${B('txAttach', t.orderId ? 'Gắn sang đơn khác' : 'Gắn vào đơn', 'link')}${o && o.status === 'PROCESSING' && o.paymentStatus !== 'PAID' ? B('txApprove', 'Duyệt thủ công', 'shield') : ''}${B('txHandled', t.handled ? 'Đánh dấu chưa xử lý' : 'Đánh dấu đã xử lý', t.handled ? 'rotate' : 'check', t.handled ? '' : 'btn-primary')}`;
    $('#txDetailFoot').innerHTML = foot;
    $('#txOpenOrder')?.addEventListener('click', () => viewOrder(t, o));
    $('#txTicket')?.addEventListener('click', () => Orders.openTicket(o));
    $('#txAttach')?.addEventListener('click', () => attach(t));
    $('#txApprove')?.addEventListener('click', () => manualApprove(t));
    $('#txHandled')?.addEventListener('click', () => setHandled(t, !t.handled));
    $('#txSeller')?.addEventListener('click', toSeller); $('#txBank')?.addEventListener('click', toSeller);
    $('#txExcMenu')?.addEventListener('click', (e) => UI.menu(e.currentTarget, [{ label: 'Gắn sang đơn khác', icon: 'link', tone: 'danger', onClick: () => attach(t, { exception: true }) }, t.handled && { label: 'Đánh dấu chưa xử lý', icon: 'rotate', tone: 'danger', onClick: () => setHandled(t, false, { exception: true }) }]));
    $('#txCopyRaw').addEventListener('click', () => UI.copy(JSON.stringify(t.raw ?? t, null, 2), 'Đã sao chép payload'));
    if (!keep) UI.openModal('txDetailModal', { focus: '[data-close]', back: ctx?.back });
    if (raw) setTimeout(() => $('#txRaw')?.scrollIntoView({ block: 'nearest' }), 50);
  }

  function formatProvider(t) {
    const p = (t.provider || '').trim();
    const s = (t.source || '').trim();
    if (s === 'PAYOS_POLLING') return p ? `${p} (Tự động)` : 'PayOS (Tự động)';
    if (s === 'PAYOS_CHECK_BUTTON') return p ? `${p} (Kiểm tra)` : 'PayOS (Kiểm tra)';
    if (s === 'PAYOS_WEBHOOK') return p ? `${p} (Webhook)` : 'PayOS';
    if (s === 'MANUAL_VERIFY') return 'Duyệt thủ công';
    if (p && s && p.toLowerCase() === s.toLowerCase()) return p;
    if (p && s) return `${p} · ${s}`;
    return p || s || 'VietQR';
  }

  function renderRecon() {
    const el = $('#tabRecon'); const tx = Store.tx;
    const cnt = Object.fromEntries(GROUPS.map((g) => [g.id, tx.filter((t) => inGroup(t, g.id)).length]));
    const un = Object.fromEntries(GROUPS.map((g) => [g.id, tx.filter((t) => inGroup(t, g.id) && !t.handled).length]));
    const all = filteredTx(); const list = all.slice(0, rv.limit); const focus = document.activeElement?.id;
    const rowCls = (t) => t.handled ? 'opacity-70' : '';
    el.innerHTML = `
      <div class="page-head"><div><h1>Đối soát thanh toán</h1><p>Giao dịch nhận qua webhook và polling. Giao dịch khớp sẽ tự chuyển đơn sang Chờ xử lý.</p></div>
        <div class="actions"><button class="btn" id="btnRefreshTx">${I('refresh')}Làm mới</button></div></div>
      <div class="recon-groups" role="group" aria-label="Nhóm giao dịch">${GROUPS.map((g) => `<button type="button" class="rg ${g.id}" id="rg_${g.id}" data-group="${g.id}" aria-pressed="${rv.group === g.id}"><div class="k">${I(g.i)}${g.t}</div><div class="v">${cnt[g.id]}</div><div class="cell-sub">${g.sub(cnt[g.id], un[g.id])}</div></button>`).join('')}</div>
      <div class="card">
        <div class="toolbar adv-filters">
          <div class="field" style="flex:2 1 240px"><label for="txSearch">Tìm giao dịch</label><input class="input" id="txSearch" placeholder="Mã giao dịch, mã đơn, nội dung CK…" value="${esc(rv.q)}" /></div>
          <div class="field"><label for="txReason">Lý do</label><select class="select" id="txReason" ${rv.group === 'matched' ? 'disabled' : ''}><option value="">${rv.group === 'matched' ? 'Không áp dụng' : 'Mọi lý do'}</option>${reasonsFor(rv.group).map((k) => `<option value="${k}" ${rv.reason === k ? 'selected' : ''}>${TX[k].t}</option>`).join('')}</select></div>
          <div class="field"><label for="txHandledF">Xử lý</label><select class="select" id="txHandledF"><option value="">Tất cả</option><option value="no" ${rv.handled === 'no' ? 'selected' : ''}>Chưa xử lý</option><option value="yes" ${rv.handled === 'yes' ? 'selected' : ''}>Đã xử lý</option></select></div>
          <div class="field"><label for="txRange">Thời gian</label><select class="select" id="txRange"><option value="">Mọi thời gian</option>${[['1', 'Hôm nay'], ['7', '7 ngày'], ['30', '30 ngày']].map(([v, t]) => `<option value="${v}" ${rv.range === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
          <button class="btn btn-ghost" id="txClear" style="align-self:flex-end">${I('x')}Xóa bộ lọc</button>
        </div>
        <div class="table-wrap"><table class="data"><thead><tr><th>Giao dịch</th><th>Phân loại</th><th>Nội dung chuyển khoản</th><th class="num">Số tiền nhận</th><th class="num"><span class="sr-only">Thao tác</span></th></tr></thead>
        <tbody>${rv.loading && !tx.length ? state.skeletonRows(5) : rv.error ? `<tr><td colspan="5">${state.error(rv.error, 'btnRetryTx')}</td></tr>` : !list.length ? `<tr><td colspan="5">${emptyTx()}</td></tr>` : list.map((t) => { const m = meta(t.status); return `<tr class="${rowCls(t)}">
          <td><button class="mono cell-main linkish" style="color:inherit" data-tx="${esc(t.id)}" title="${esc(t.transactionId)}">${esc(shortId(t.transactionId))}</button><div class="cell-sub mono">${esc(dShort(t.createdAt))}</div></td>
          <td>${badge(m.k, m.i, m.t)}<div class="cell-sub" style="margin-top:3px">${t.handled ? 'Đã xử lý' : 'Chưa xử lý'}</div></td>
          <td>${t.orderCode ? `<div class="mono" style="font-weight:600;color:var(--text-primary)">${esc(t.orderCode)}</div>` : ''}<div class="cell-sub" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(t.description || '')}">${esc(t.description || '—')}</div></td>
          <td class="num"><div class="num mono cell-main" style="font-weight:700">${esc(vnd(t.amount))}</div><div class="cell-sub">${esc(formatProvider(t))}</div></td>
          <td class="num"><div class="row-actions" style="justify-content:flex-end"><button class="btn btn-sm" data-tx="${esc(t.id)}">Chi tiết</button><button class="btn btn-sm btn-ghost btn-icon" data-txmore="${esc(t.id)}" aria-haspopup="menu" aria-label="Thao tác khác cho ${esc(t.transactionId)}">${I('moreH', 'sm')}</button></div></td></tr>`; }).join('')}</tbody></table></div>
        <div class="cards-mobile">${!list.length && !rv.loading ? emptyTx() : list.map((t) => { const m = meta(t.status); return `<article class="ocard"><div class="top"><button class="mono cell-main linkish" style="color:inherit" data-tx="${esc(t.id)}" title="${esc(t.transactionId)}">${esc(shortId(t.transactionId))}</button><span class="spacer"></span>${badge(m.k, m.i, m.t)}</div><div class="row" style="gap:8px;align-items:baseline"><div style="flex:1;min-width:0">${t.orderCode ? `<div class="cell-main mono" style="font-weight:600">${esc(t.orderCode)}</div>` : ''}<div class="cell-sub" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(t.description || '')}">${esc(t.description || 'Không có nội dung')}</div><div class="cell-sub">${esc(dShort(t.createdAt))} · ${esc(formatProvider(t))} · ${t.handled ? 'Đã xử lý' : 'Chưa xử lý'}</div></div><span class="amt">${esc(vnd(t.amount))}</span></div><div class="row"><span class="spacer"></span><button class="btn btn-sm" data-tx="${esc(t.id)}">Chi tiết</button><button class="btn btn-sm btn-ghost btn-icon" data-txmore="${esc(t.id)}" aria-haspopup="menu" aria-label="Thao tác khác cho ${esc(t.transactionId)}">${I('moreH', 'sm')}</button></div></article>`; }).join('')}</div>
        <div class="table-foot"><span aria-live="polite">Hiển thị ${list.length} / ${all.length} giao dịch</span><span class="spacer"></span>${list.length < all.length ? `<button class="btn btn-sm" id="btnTxMore">${I('chevronDown', 'sm')}Tải thêm (${Math.min(10, all.length - list.length)})</button>` : ''}</div>
      </div>`;
    const re = () => { rv.limit = 10; renderRecon(); };
    $$('.rg', el).forEach((b) => b.addEventListener('click', () => { setGroup(b.dataset.group); renderRecon(); $(`#rg_${b.dataset.group}`)?.focus(); }));
    $('#btnRefreshTx').addEventListener('click', (e) => UI.withLoading(e.currentTarget, loadRecon));
    $('#btnRetryTx')?.addEventListener('click', loadRecon);
    $('#btnTxMore')?.addEventListener('click', () => { rv.limit += 10; renderRecon(); });
    $('#txReason').addEventListener('change', (e) => { rv.reason = e.target.value; re(); });
    $('#txHandledF').addEventListener('change', (e) => { rv.handled = e.target.value; re(); });
    $('#txRange').addEventListener('change', (e) => { rv.range = e.target.value; re(); });
    const clear = () => { Object.assign(rv, { reason: '', handled: '', q: '', range: '' }); re(); };
    $('#txClear').addEventListener('click', clear);
    $$('[data-txclear]', el).forEach((b) => b.addEventListener('click', clear));
    $$('[data-txall]', el).forEach((b) => b.addEventListener('click', () => { Object.assign(rv, { group: 'all', reason: '', handled: '', q: '', range: '' }); re(); }));
    $$('[data-tx]', el).forEach((b) => b.addEventListener('click', () => openTx(b.dataset.tx)));
    $$('[data-txmore]', el).forEach((b) => b.addEventListener('click', () => UI.menu(b, txActions(findTx(b.dataset.txmore)))));
    $('#txSearch').addEventListener('input', UI.debounce((e) => { rv.q = e.target.value.trim().toLowerCase(); re(); }, 300));
    if (focus === 'txSearch') { const i = $('#txSearch'); i.focus(); i.setSelectionRange(99, 99); }
  }
  const emptyTx = () => state.empty('Không có giao dịch phù hợp', 'Thử thay đổi bộ lọc hoặc từ khóa tìm kiếm', `<div class="row" style="gap:8px;justify-content:center"><button class="btn" data-txclear>${I('x', 'sm')}Xóa bộ lọc</button><button class="btn btn-primary" data-txall>Xem tất cả giao dịch</button></div>`);
  async function loadRecon(silent) {
    rv.loading = true; rv.error = null; if (!silent) renderRecon();
    try { Store.tx = API.list(await API.transactions(), 'transactions', 'items', 'data').map(R.migrateTx); } catch (e) { if (e.status !== 401) rv.error = e.message; }
    rv.loading = false; Store.orders = R.reconcile(Store.orders, Store.tx);
    if (!$('#tabRecon').hidden) renderRecon();
    if ($('#tabBalance') && !$('#tabBalance').hidden) renderBalance();
    App.refreshCounts();
  }

  // ----- Biến động số dư (Balance fluctuations)
  const bv = { q: '', range: '', status: '', limit: 25 };

  function balanceList() {
    const since = bv.range ? Date.now() - Number(bv.range) * 864e5 : 0;
    const q = (bv.q || '').toLowerCase();
    return (Store.tx || []).filter((t) => {
      if (Number(t.amount || 0) <= 0) return false;
      if (since && new Date(t.createdAt).getTime() < since) return false;
      if (bv.status === 'matched' && t.status !== 'MATCHED' && t.status !== 'SUCCESS') return false;
      if (bv.status === 'review' && (t.status === 'MATCHED' || t.status === 'SUCCESS')) return false;
      if (q) {
        const str = [
          t.transactionId,
          t.orderCode,
          t.orderNo,
          t.description,
          t.receiverAccount,
          t.receivingAccount,
          String(t.amount || '')
        ].filter(Boolean).join(' ').toLowerCase();
        if (!str.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  function balanceStatusBadge(s, handled) {
    if (s === 'MATCHED' || s === 'SUCCESS') {
      return badge('success', 'checkCircle', 'Khớp tự động');
    }
    if (handled) {
      return badge('neutral', 'check', 'Không có đơn');
    }
    if (s === 'ORDER_ALREADY_PAID') {
      return badge('warning', 'copy', 'Đơn đã thanh toán');
    }
    if (s === 'AMOUNT_MISMATCH') {
      return badge('warning', 'alert', 'Lệch số tiền');
    }
    if (s === 'UNKNOWN_ORDER_CODE' || s === 'ORDER_NOT_FOUND') {
      return badge('neutral', 'search', 'Chưa khớp đơn');
    }
    if (s === 'UNAUTHORIZED_RECEIVER_ACCOUNT' || s === 'MISSING_RECEIVING_ACCOUNT') {
      return badge('danger', 'shield', 'Sai tài khoản nhận');
    }
    return badge('neutral', '', s || 'Đã nhận tiền');
  }

  function shortMemo(str, head = 12, tail = 8) {
    if (!str) return '—';
    const s = String(str).trim();
    if (s.length <= head + tail + 3) return s;
    return `${s.slice(0, head)}...${s.slice(-tail)}`;
  }

  function openBalanceDetail(id) {
    const t = findTx(id);
    if (!t) return;
    const o = orderOf(t);
    const targetOrder = t.orderCode || t.orderNo || t.order?.orderNo || (o ? Orders.orderNo(o) : '');
    const dateStr = new Date(t.createdAt).toLocaleString('vi-VN', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      day: '2-digit', month: '2-digit', year: 'numeric'
    });

    const isMatched = (t.status === 'MATCHED' || t.status === 'SUCCESS');
    const unpaidOrders = (Store.orders || [])
      .filter((ord) => ord.status === 'PENDING' || (Orders.payStatusOf && Orders.payStatusOf(ord) === 'UNPAID'))
      .sort((a, b) => {
        const aCode = (targetOrder && (Orders.orderNo(a) === targetOrder || String(a.id) === targetOrder)) ? 2 : 0;
        const bCode = (targetOrder && (Orders.orderNo(b) === targetOrder || String(b.id) === targetOrder)) ? 2 : 0;
        if (aCode !== bCode) return bCode - aCode;
        const aMatch = Number(a.amount) === Number(t.amount) ? 1 : 0;
        const bMatch = Number(b.amount) === Number(t.amount) ? 1 : 0;
        if (aMatch !== bMatch) return bMatch - aMatch;
        return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
      });

    $('#balDetailTitle').textContent = 'Chi tiết giao dịch';
    $('#balDetailSub').textContent = `Mã GD: ${t.transactionId}`;

    const body = `
      <div style="background:var(--surface-2, rgba(255,255,255,0.03));border:1px solid var(--border-default);border-radius:12px;padding:18px;text-align:center">
        <div class="cell-sub" style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">Số tiền biến động</div>
        <div class="mono" style="font-size:28px;font-weight:800;color:var(--success, #10B981)">+${esc(vnd(t.amount))}</div>
        <div class="cell-sub" style="margin-top:6px;font-size:13px">${esc(dateStr)}</div>
      </div>

      <div class="stack" style="gap:12px;background:var(--surface-sunken, rgba(0,0,0,0.2));border:1px solid var(--border-default);border-radius:12px;padding:16px">
        <div>
          <div class="cell-sub" style="font-size:11.5px;text-transform:uppercase;font-weight:600;margin-bottom:4px">Nội dung chuyển khoản (Memo)</div>
          <div class="row wrap" style="gap:8px;align-items:flex-start">
            <div style="flex:1;font-weight:600;font-size:14px;word-break:break-word;color:var(--text-primary);line-height:1.5">
              ${esc(t.description || '(Không có nội dung)')}
            </div>
            ${t.description ? `<button class="btn btn-ghost btn-sm btn-icon" data-copy="${esc(t.description)}" title="Sao chép nội dung">${I('copy', 'sm')}</button>` : ''}
          </div>
        </div>

        <div style="border-top:1px solid var(--border-default);padding-top:12px">
          <div class="cell-sub" style="font-size:11.5px;text-transform:uppercase;font-weight:600;margin-bottom:4px">Mã giao dịch ngân hàng</div>
          <div class="row wrap" style="gap:8px;align-items:center">
            <span class="mono" style="font-weight:600;font-size:13.5px">${esc(t.transactionId)}</span>
            <button class="btn btn-ghost btn-sm btn-icon" data-copy="${esc(t.transactionId)}" title="Sao chép mã giao dịch">${I('copy', 'sm')}</button>
          </div>
        </div>

        <div style="border-top:1px solid var(--border-default);padding-top:12px">
          <div class="cell-sub" style="font-size:11.5px;text-transform:uppercase;font-weight:600;margin-bottom:4px">Tài khoản nhận tiền</div>
          <div style="font-size:13.5px">
            <b class="mono">${esc(t.receiverAccount || t.receivingAccount || '—')}</b>
            <span class="muted">(${esc(formatProvider(t))})</span>
          </div>
        </div>

        <div style="border-top:1px solid var(--border-default);padding-top:12px">
          <div class="cell-sub" style="font-size:11.5px;text-transform:uppercase;font-weight:600;margin-bottom:6px">Đơn hàng liên kết</div>
          <div>
            ${isMatched && targetOrder ? `
              <div class="row wrap" style="gap:8px;align-items:center">
                <button class="mono linkish" data-bal-open-order="${esc(targetOrder)}" style="font-weight:700;font-size:14px">#${esc(targetOrder)}</button>
                <span class="cell-sub">${o ? `(${esc(o.service || o.product?.name || '')})` : ''}</span>
                <span class="badge b-success">Đã khớp</span>
              </div>
            ` : `
              <div class="stack" style="gap:10px;background:rgba(255,255,255,0.02);border:1px dashed var(--border-default);border-radius:10px;padding:12px;margin-top:2px">
                <div class="row wrap" style="gap:8px;align-items:center">
                  <span class="muted" style="font-size:13px">
                    ${t.handled ? 'ℹ️ Giao dịch đã được đánh dấu không có đơn.' : (targetOrder ? `⚠️ Phát hiện mã đơn #${esc(targetOrder)} trong nội dung nhưng chưa khớp.` : '⚠️ Chưa khớp với đơn hàng nào.')}
                  </span>
                  ${targetOrder ? `<button class="mono linkish" data-bal-open-order="${esc(targetOrder)}" style="font-size:12px;text-decoration:underline">Xem đơn #${esc(targetOrder)}</button>` : ''}
                </div>

                ${!t.handled ? `
                  <div style="display:flex;flex-direction:column;gap:8px">
                    <label for="selBalAttachOrder" class="cell-sub" style="font-size:12px;font-weight:600">Chọn đơn hàng đang chờ để khớp tiền:</label>
                    <div class="row wrap" style="gap:8px;align-items:center">
                      <select class="select" id="selBalAttachOrder" style="flex:1;min-width:200px;font-size:13px">
                        <option value="">-- ${unpaidOrders.length ? `Chọn đơn hàng (${unpaidOrders.length} đơn chờ)` : 'Không có đơn nào đang chờ'} --</option>
                        ${unpaidOrders.map(uo => {
                          const isTargetMatch = targetOrder && (Orders.orderNo(uo) === targetOrder || String(uo.id) === targetOrder);
                          const isSameAmount = Number(uo.amount) === Number(t.amount);
                          return `
                            <option value="${esc(uo.id)}" ${isTargetMatch || isSameAmount ? 'selected' : ''}>
                              #${esc(Orders.orderNo(uo))} · ${esc(vnd(uo.amount))} ${uo.service || uo.product?.name ? `(${esc(uo.service || uo.product?.name)})` : ''} ${isTargetMatch ? '⭐ Đúng mã đơn' : (isSameAmount ? '⚡ Khớp tiền' : '')}
                            </option>
                          `;
                        }).join('')}
                      </select>
                      <button class="btn btn-primary btn-sm" id="btnBalDoAttach" ${!unpaidOrders.length ? 'disabled' : ''}>
                        ${I('check', 'sm')}Khớp vào đơn
                      </button>
                    </div>
                  </div>
                  <div style="display:flex;justify-content:flex-end;margin-top:2px">
                    <button class="btn btn-ghost btn-sm" id="btnBalMarkNoOrder" style="color:var(--text-muted);font-size:12px">
                      ${I('x', 'sm')}Không có đơn
                    </button>
                  </div>
                ` : `
                  <div class="row wrap" style="gap:8px;justify-content:flex-end">
                    <button class="btn btn-ghost btn-sm" id="btnBalUnmarkHandled" style="font-size:12px">
                      ${I('rotate', 'sm')}Đánh dấu chưa xử lý (Khớp lại)
                    </button>
                  </div>
                `}
              </div>
            `}
          </div>
        </div>

        <div style="border-top:1px solid var(--border-default);padding-top:12px">
          <div class="cell-sub" style="font-size:11.5px;text-transform:uppercase;font-weight:600;margin-bottom:4px">Trạng thái</div>
          <div>${balanceStatusBadge(t.status, t.handled)}</div>
        </div>
      </div>
    `;

    $('#balDetailBody').innerHTML = body;

    $$('[data-copy]', $('#balDetailBody')).forEach((b) => b.addEventListener('click', () => UI.copy(b.dataset.copy, 'Đã sao chép')));
    $$('[data-bal-open-order]', $('#balDetailBody')).forEach((b) => b.addEventListener('click', () => {
      UI.closeModal('balanceDetailModal');
      const code = b.dataset.balOpenOrder;
      const order = Store.orders.find((x) => Orders.orderNo(x) === code || String(x.id) === code || String(x.orderNo) === code);
      if (order) Orders.openDetail(order.id);
      else UI.toast('Không tìm thấy đơn hàng trong danh sách hoạt động.', 'info');
    }));

    $('#btnBalDoAttach')?.addEventListener('click', async (e) => {
      const orderId = $('#selBalAttachOrder')?.value;
      if (!orderId) {
        UI.toast('Vui lòng chọn đơn hàng cần khớp.', 'warning');
        return;
      }
      try {
        await UI.withLoading(e.currentTarget, async () => {
          await API.attachTx(t.id, orderId, 'Khớp thủ công qua chi tiết giao dịch');
          UI.toast('Đã khớp giao dịch vào đơn hàng thành công!', 'success');
          UI.closeModal('balanceDetailModal');
          await loadRecon(true);
          await Orders.load();
          renderBalance();
        });
      } catch (err) {
        UI.toast(err.message || 'Lỗi khi khớp đơn hàng', 'error');
      }
    });

    $('#btnBalMarkNoOrder')?.addEventListener('click', async (e) => {
      try {
        await UI.withLoading(e.currentTarget, async () => {
          await API.markTxHandled(t.id, true, 'Xác nhận không có đơn hàng nào');
          t.handled = true;
          UI.toast('Đã đánh dấu không có đơn.', 'success');
          openBalanceDetail(t.id);
          renderBalance();
        });
      } catch (err) {
        UI.toast(err.message || 'Lỗi cập nhật giao dịch', 'error');
      }
    });

    $('#btnBalUnmarkHandled')?.addEventListener('click', async (e) => {
      try {
        await UI.withLoading(e.currentTarget, async () => {
          await API.markTxHandled(t.id, false, 'Chuyển về chưa xử lý để khớp lại');
          t.handled = false;
          UI.toast('Đã chuyển về trạng thái chưa xử lý.', 'success');
          openBalanceDetail(t.id);
          renderBalance();
        });
      } catch (err) {
        UI.toast(err.message || 'Lỗi cập nhật giao dịch', 'error');
      }
    });

    UI.openModal('balanceDetailModal');
  }

  function renderBalance() {
    const el = $('#tabBalance');
    if (!el) return;
    const rawTx = Store.tx || [];
    const tx = rawTx.filter(t => Number(t.amount || 0) > 0);
    const all = balanceList();
    const list = all.slice(0, bv.limit);
    const focusId = document.activeElement?.id;

    // Calculate KPIs
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();

    const txToday = tx.filter(t => new Date(t.createdAt).getTime() >= todayMs);
    const totalToday = txToday.reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const countToday = txToday.length;

    const totalAll = tx.reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const matchedCount = tx.filter(t => t.status === 'MATCHED' || t.status === 'SUCCESS').length;

    el.innerHTML = `
      <div class="page-head">
        <div>
          <h1>Biến động số dư</h1>
          <p>Lịch sử dòng tiền và các biến động số dư chuyển khoản ngân hàng gần đây.</p>
        </div>
        <div class="actions">
          <button class="btn" id="btnRefreshBalance">${I('refresh')}Làm mới</button>
        </div>
      </div>

      <div class="metrics kpis" role="group" aria-label="Chỉ số dòng tiền" style="margin-bottom:16px">
        <div class="card metric" style="padding:16px">
          <div class="cell-sub" style="font-weight:600;margin-bottom:4px">HÔM NAY NHẬN</div>
          <div class="mono" style="font-size:22px;font-weight:700;color:var(--success, #10B981)">+${esc(vnd(totalToday))}</div>
          <div class="cell-sub" style="margin-top:4px">${countToday} giao dịch phát sinh hôm nay</div>
        </div>
        <div class="card metric" style="padding:16px">
          <div class="cell-sub" style="font-weight:600;margin-bottom:4px">TỔNG TIỀN NHẬN ĐƯỢC</div>
          <div class="mono" style="font-size:22px;font-weight:700;color:var(--text-primary)">+${esc(vnd(totalAll))}</div>
          <div class="cell-sub" style="margin-top:4px">${tx.length} giao dịch gần nhất</div>
        </div>
        <div class="card metric" style="padding:16px">
          <div class="cell-sub" style="font-weight:600;margin-bottom:4px">ĐÃ TỰ ĐỘNG KHỚP ĐƠN</div>
          <div class="mono" style="font-size:22px;font-weight:700;color:#38BDF8">${matchedCount} / ${tx.length}</div>
          <div class="cell-sub" style="margin-top:4px">${tx.length - matchedCount} giao dịch cần kiểm tra/lệch</div>
        </div>
      </div>

      <div class="card">
        <div class="toolbar adv-filters">
          <div class="field" style="flex:2 1 240px">
            <label for="balSearch">Tìm kiếm</label>
            <input class="input" id="balSearch" value="${esc(bv.q)}" placeholder="Mã giao dịch FT, mã đơn #4AM, số tài khoản, nội dung CK…" />
          </div>
          <div class="field">
            <label for="balStatus">Trạng thái</label>
            <select class="select" id="balStatus">
              <option value="" ${bv.status === '' ? 'selected' : ''}>Tất cả trạng thái</option>
              <option value="matched" ${bv.status === 'matched' ? 'selected' : ''}>Khớp tự động</option>
              <option value="review" ${bv.status === 'review' ? 'selected' : ''}>Cần xử lý / Ngoại lệ</option>
            </select>
          </div>
          <div class="field">
            <label for="balRange">Thời gian</label>
            <select class="select" id="balRange">
              <option value="" ${bv.range === '' ? 'selected' : ''}>Mọi thời gian</option>
              <option value="1" ${bv.range === '1' ? 'selected' : ''}>Hôm nay</option>
              <option value="7" ${bv.range === '7' ? 'selected' : ''}>7 ngày gần đây</option>
              <option value="30" ${bv.range === '30' ? 'selected' : ''}>30 ngày gần đây</option>
            </select>
          </div>
          <button class="btn btn-ghost" id="balClear" style="align-self:flex-end">${I('x')}Xóa bộ lọc</button>
          <span class="hint" style="align-self:flex-end" aria-live="polite">${all.length} biến động</span>
        </div>

        <div class="table-wrap" style="overflow-x:hidden">
          <table class="data" style="table-layout:fixed;width:100%;min-width:0">
            <colgroup>
              <col style="width:14%">
              <col style="width:15%">
              <col style="width:18%">
              <col style="width:26%">
              <col style="width:13%">
              <col style="width:14%">
            </colgroup>
            <thead>
              <tr>
                <th style="white-space:nowrap">Thời gian</th>
                <th class="num" style="text-align:left;white-space:nowrap">Biến động</th>
                <th style="white-space:nowrap">Tài khoản nhận</th>
                <th>Nội dung chuyển khoản</th>
                <th style="white-space:nowrap">Mã đơn</th>
                <th style="white-space:nowrap">Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              ${rv.loading && !tx.length ? state.skeletonRows(5) : !list.length ? `<tr><td colspan="6"><div class="state empty" style="padding:32px 16px"><span class="ic">${I('wallet')}</span><h3>Chưa có biến động số dư nào</h3><p>Các giao dịch chuyển khoản vào tài khoản ngân hàng sẽ hiển thị tại đây.</p></div></td></tr>` : list.map((t) => {
                const targetOrder = t.orderCode || t.orderNo || t.order?.orderNo || '';
                return `<tr class="clickable-row" data-bal-row="${esc(t.id)}" style="cursor:pointer" title="Bấm để xem chi tiết giao dịch">
                  <td style="white-space:nowrap">
                    <div class="cell-main mono" style="font-weight:600">${esc(dShort(t.createdAt))}</div>
                    <div class="cell-sub mono" style="font-size:11px">${esc(new Date(t.createdAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</div>
                  </td>
                  <td class="num" style="text-align:left;white-space:nowrap">
                    <div class="mono cell-main" style="font-weight:700;font-size:15px;color:var(--success, #10B981)">+${esc(vnd(t.amount))}</div>
                  </td>
                  <td style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                    <div class="cell-main mono" style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(t.receiverAccount || t.receivingAccount || '—')}">${esc(t.receiverAccount || t.receivingAccount || '—')}</div>
                    <div class="cell-sub" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(formatProvider(t))}</div>
                  </td>
                  <td style="overflow:hidden">
                    <div class="cell-main mono" style="max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600" title="${esc(t.description || '—')}">${esc(shortMemo(t.description))}</div>
                    <div class="cell-sub mono" style="font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Mã GD: <span class="muted">${esc(shortId(t.transactionId))}</span></div>
                  </td>
                  <td style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                    ${targetOrder ? `<button class="mono linkish" data-balance-order="${esc(targetOrder)}" style="font-weight:700;font-size:13px" title="Xem đơn hàng #${esc(targetOrder)}">#${esc(targetOrder)}</button>` : '<span class="muted mono">—</span>'}
                  </td>
                  <td style="white-space:nowrap">
                    ${balanceStatusBadge(t.status, t.handled)}
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>

        <div class="cards-mobile">
          ${!list.length && !rv.loading ? `<div class="state empty" style="padding:24px 16px"><span class="ic">${I('wallet')}</span><h3>Chưa có biến động số dư</h3><p>Giao dịch ngân hàng sẽ xuất hiện tại đây.</p></div>` : list.map((t) => {
            const targetOrder = t.orderCode || t.orderNo || t.order?.orderNo || '';
            return `<article class="ocard clickable-row" data-bal-row="${esc(t.id)}" style="cursor:pointer" title="Chạm để xem chi tiết">
              <div class="top">
                <span class="mono" style="font-size:12px;color:var(--text-muted)">${esc(dShort(t.createdAt))} ${esc(new Date(t.createdAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }))}</span>
                <span class="spacer"></span>
                ${balanceStatusBadge(t.status, t.handled)}
              </div>
              <div class="row" style="gap:10px;align-items:baseline;margin:4px 0">
                <div style="flex:1;min-width:0">
                  <div class="mono" style="font-size:16px;font-weight:700;color:var(--success, #10B981)">+${esc(vnd(t.amount))}</div>
                  <div class="cell-sub" style="margin-top:2px">Đến: <b class="mono">${esc(t.receiverAccount || t.receivingAccount || '—')}</b> (${esc(formatProvider(t))})</div>
                  <div class="cell-main mono" style="margin-top:4px;word-break:break-word;font-size:13px"><b>${esc(shortMemo(t.description))}</b></div>
                  <div class="cell-sub mono" style="font-size:11px;margin-top:2px">GD: ${esc(t.transactionId)}</div>
                </div>
              </div>
              <div class="row" style="margin-top:6px">
                ${targetOrder ? `<button class="mono linkish" data-balance-order="${esc(targetOrder)}" style="font-weight:600">Đơn #${esc(targetOrder)}</button>` : ''}
                <span class="spacer"></span>
                <span class="cell-sub" style="font-size:11.5px;color:var(--text-muted)">Chạm để xem chi tiết →</span>
              </div>
            </article>`;
          }).join('')}
        </div>

        <div class="table-foot">
          <span aria-live="polite">Hiển thị ${list.length} / ${all.length} biến động</span>
          <span class="spacer"></span>
          ${list.length < all.length ? `<button class="btn btn-sm" id="btnBalMore">${I('chevronDown', 'sm')}Tải thêm (${Math.min(25, all.length - list.length)})</button>` : ''}
        </div>
      </div>
    `;

    const re = () => { bv.limit = 25; renderBalance(); };
    $('#btnRefreshBalance')?.addEventListener('click', (e) => UI.withLoading(e.currentTarget, loadRecon));
    $('#balSearch')?.addEventListener('input', UI.debounce((e) => { bv.q = e.target.value.trim(); re(); }, 300));
    $('#balStatus')?.addEventListener('change', (e) => { bv.status = e.target.value; re(); });
    $('#balRange')?.addEventListener('change', (e) => { bv.range = e.target.value; re(); });
    $('#balClear')?.addEventListener('click', () => { Object.assign(bv, { q: '', status: '', range: '', limit: 25 }); re(); });
    $('#btnBalMore')?.addEventListener('click', () => { bv.limit += 25; renderBalance(); });

    $$('[data-bal-row]', el).forEach((row) => row.addEventListener('click', (e) => {
      if (e.target.closest('[data-balance-order]') || e.target.closest('[data-copy]')) {
        return;
      }
      openBalanceDetail(row.dataset.balRow);
    }));
    $$('[data-balance-order]', el).forEach((b) => b.addEventListener('click', () => {
      const code = b.dataset.balanceOrder;
      const o = Store.orders.find((x) => Orders.orderNo(x) === code || String(x.id) === code || String(x.orderNo) === code);
      if (o) Orders.openDetail(o.id);
      else UI.toast('Không tìm thấy đơn hàng trong danh sách hoạt động (có thể đã lưu trữ).', 'info');
    }));

    if (focusId && document.getElementById(focusId)) {
      const f = document.getElementById(focusId);
      f.focus();
      if (f.setSelectionRange && f.type !== 'select-one') f.setSelectionRange(99, 99);
    }
  }

  const ACT = {
    PAYMENT_CONFIRMED: ['success', 'checkCircle', 'Xác nhận thanh toán tự động'],
    PAYMENT_REJECTED: ['danger', 'ban', 'Giao dịch lỗi / bị từ chối'],
    PAYMENT_MANUALLY_APPROVED: ['warning', 'shield', 'Duyệt thanh toán thủ công'],
    REFUND_REQUESTED: ['warning', 'rotate', 'Yêu cầu hoàn tiền'],
    REFUND_CONFIRMED: ['neutral', 'checkCircle', 'Xác nhận đã hoàn tiền'],
    ORDER_STATUS_CHANGED: ['brand', 'rotate', 'Đổi trạng thái đơn'],
    ORDER_STATUS_OVERRIDDEN: ['danger', 'alert', 'Đổi trạng thái ngoại lệ'],
    ORDER_AMOUNT_CHANGED: ['warning', 'wallet', 'Đổi số tiền'],
    ORDER_UPDATED: ['neutral', 'edit', 'Cập nhật đơn'],
    ORDER_COMPLETED_BY_SELLER: ['success', 'check', 'Seller hoàn tất đơn'],
    ORDER_COMPLETED_BY_STAFF: ['success', 'check', 'Staff hoàn tất đơn'],
    CUSTOMER_FEEDBACK: ['warning', 'star', 'Khách hàng đánh giá'],
    ORDER_ARCHIVED: ['neutral', 'archive', 'Lưu trữ đơn'],
    TRANSACTION_ATTACHED: ['warning', 'link', 'Gắn giao dịch vào đơn'],
    TRANSACTION_HANDLED_CHANGED: ['neutral', 'check', 'Đổi trạng thái xử lý giao dịch'],
    SELLER_CREATED: ['brand', 'userPlus', 'Thêm seller'],
    SELLER_LOCKED: ['warning', 'lock', 'Khóa / mở khóa seller'],
    SELLER_DELETED: ['danger', 'trash', 'Xóa seller'],
    SELLER_PERMISSIONS_CHANGED: ['warning', 'key', 'Đổi quyền seller'],
    BANK_ACCOUNT_CHANGED: ['warning', 'bank', 'Đổi tài khoản nhận tiền'],
    DASHBOARD_ACCOUNT_CHANGED: ['neutral', 'key', 'Đổi tài khoản dashboard'],
    PRODUCT_CHANGED: ['neutral', 'box', 'Đổi sản phẩm'],
    DISCORD_DRAFT_SAVED: ['neutral', 'save', 'Lưu nháp Discord'],
    DISCORD_SYNCED: ['brand', 'send', 'Đồng bộ Discord'],
  };
  const actBadge = (a) => { const [k, , t] = ACT[a] || ['neutral', '', a]; return badge(k, '', t); };

  async function loadAudit(silent) {
    try { Store.audit = API.list(await API.auditLogs(), 'logs', 'items', 'data'); } catch (_) {}
  }
  function log(e) {
    if (window.Demo?.enabled) Demo.log(e);
    else Store.audit.unshift({ id: `local-${Date.now()}`, createdAt: new Date().toISOString(), actorType: Auth.isAdmin() ? 'ADMIN' : 'SELLER', actorId: Auth.me?.username, source: 'dashboard', result: 'SUCCESS', ...e });
  }
  const riskCount = () => Store.tx.filter((t) => meta(t.status).g !== 'matched' && !t.handled).length;
  window.Finance = { openTx, loadRecon, loadAudit, loadBalance: loadRecon, renderRecon, renderAudit: renderBalance, renderBalance, riskCount, txMeta: meta, actBadge, log, setGroup, focusOrder };
})();
