/* Sellers, bank accounts (masked by default), dashboard accounts & permissions (admin only) */
(function () {
  const { $, esc, I, avatar, badge, shortId, maskAcc, toast, openModal, closeModal, confirmDialog, promptDialog, reasonDialog, withLoading, copy, state } = UI;
  const revealed = new Set();
  // Single permission model from rules.js (orders.read is always on)
  const PERMS = Object.fromEntries(Object.entries(OrderRules.PERMISSIONS).filter(([, v]) => !v.locked).map(([k, v]) => [k, v.label]));
  const name = (s) => s.globalName || s.username;
  const sellers = () => Store.data?.sellers || [];
  const persist = async (msg) => { try { await API.save({ sellers: sellers() }); toast(msg); } catch (e) { toast(e.message, 'error'); } };

  function render() {
    const box = $('#sellersContainer'); if (!box) return;
    if (!Store.data) { box.innerHTML = state.skeletonBlock(3); return; }
    if (!sellers().length) { box.innerHTML = `<div class="card" style="grid-column:1/-1">${state.empty('Chưa có seller', 'Thêm seller bằng Discord ID để bắt đầu nhận đơn.')}</div>`; return; }
    box.innerHTML = sellers().map((s, si) => {
      const acct = (Store.users || []).find((u) => String(u.sellerId) === String(s.id));
      const banks = s.banks || [];
      return `<article class="card seller-card" ${s.locked ? 'style="opacity:.75"' : ''}>
        <div class="hd">${avatar(s.avatar, s.globalName || s.username, 'lg')}<div style="min-width:0;flex:1"><div class="cell-main">${esc(s.globalName || s.username)}</div><div class="cell-sub">@${esc(s.username || '—')} · <span class="mono" title="${esc(s.id)}">${esc(shortId(s.id))}</span></div></div>
          <button class="btn btn-ghost btn-icon btn-sm" data-copyid="${esc(s.id)}" aria-label="Sao chép Discord ID">${I('copy', 'sm')}</button>
          <button class="btn btn-ghost btn-icon btn-sm" data-syncone="${si}" aria-label="Đồng bộ ${esc(s.globalName || s.username)} từ Discord" title="Đồng bộ từ Discord">${I('refresh', 'sm')}</button></div>
        <div class="bd">
          <div class="row wrap" style="gap:6px">${s.locked ? badge('danger', 'lock', 'Seller bị khóa') : badge('success', 'checkCircle', 'Đang nhận đơn')}${acct ? (acct.locked ? badge('warning', 'lock', 'Dashboard bị khóa') : badge('brand', 'key', 'Có tài khoản dashboard')) : badge('neutral', 'key', 'Chưa có tài khoản')}</div>
          ${acct ? `<div class="row wrap" style="gap:6px">${Object.entries(PERMS).filter(([k]) => (acct.permissions || []).includes(k)).map(([, t]) => `<span class="badge b-neutral">${esc(t)}</span>`).join('') || '<span class="hint">Chỉ xem đơn</span>'}</div>` : ''}
          <div class="row"><span class="label" style="flex:1">Tài khoản nhận tiền · ${banks.length}</span><button class="btn btn-sm btn-ghost" data-addbank="${si}">${I('plus', 'sm')}Thêm</button></div>
          <div class="stack" style="gap:8px">${banks.length ? banks.map((b, bi) => { const key = `${si}:${bi}`; const show = revealed.has(key); return `<div class="bank-row">${I('bank')}<div style="flex:1;min-width:0"><div class="bn">${esc(b.bankName || 'Ngân hàng')}</div><div class="cell-sub"><span class="mono">${esc(show ? b.account : maskAcc(b.account))}</span> · ${esc(b.owner || '')}</div></div>
            <button class="btn btn-ghost btn-icon btn-sm" data-reveal="${key}" aria-label="${show ? 'Ẩn' : 'Hiện'} số tài khoản" aria-pressed="${show}">${I(show ? 'eyeOff' : 'eye', 'sm')}</button>
            <button class="btn btn-ghost btn-icon btn-sm" data-copybank="${key}" aria-label="Sao chép số tài khoản">${I('copy', 'sm')}</button>
            <button class="btn btn-ghost btn-icon btn-sm" data-bankmore="${key}" aria-haspopup="menu" aria-label="Thao tác tài khoản">${I('moreH', 'sm')}</button></div>`; }).join('')
            : `<div class="bank-row" style="justify-content:center;flex-direction:column;gap:6px;padding:16px;text-align:center"><span class="muted">${I('bank')}</span><span class="secondary" style="font-size:13px">Chưa có tài khoản nhận tiền.<br/>Danh mục của seller này chưa thể nhận thanh toán.</span><button class="btn btn-sm" data-addbank="${si}">${I('plus', 'sm')}Thêm tài khoản</button></div>`}</div>
        </div>
        <div class="ft"><button class="btn btn-sm" data-lockseller="${si}">${I(s.locked ? 'unlock' : 'lock', 'sm')}${s.locked ? 'Mở khóa' : 'Khóa seller'}</button><span class="spacer"></span><button class="btn btn-sm btn-danger" data-delseller="${si}">${I('trash', 'sm')}Xóa seller</button></div>
      </article>`;
    }).join('');
  }

  const bankAt = (key) => { const [si, bi] = key.split(':').map(Number); return { s: sellers()[si], b: sellers()[si]?.banks?.[bi], bi }; };
  let bankCtx = null;
  function openBank(s, bi) {
    const b = bi != null ? s.banks[bi] : null; bankCtx = { s, bi };
    $('#bankModalTitle').textContent = b ? 'Sửa tài khoản nhận tiền' : 'Thêm tài khoản nhận tiền';
    $('#bankModalSub').textContent = s.globalName || s.username;
    $('#bfBank').value = b?.bankName || ''; $('#bfAccount').value = b?.account || ''; $('#bfOwner').value = b?.owner || ''; $('#bfQr').value = b?.qr || '';
    openModal('bankModal', { focus: '#bfBank' });
  }
  function showQr(s, b) {
    $('#qrModalTitle').textContent = `${b.bankName} · ${s.globalName || s.username}`;
    $('#qrModalSub').textContent = `${maskAcc(b.account)} · ${b.owner || ''}`;
    $('#qrModalBody').innerHTML = b.qr ? `<img src="${esc(b.qr)}" alt="Mã QR ${esc(b.bankName)}" style="width:240px;height:240px;object-fit:contain;border-radius:12px;background:#fff" onerror="this.outerHTML='<div class=&quot;qr-ph&quot;>Không tải được ảnh QR</div>'" />` : `<div class="qr-ph">${I('image')}<span>Chưa có ảnh QR.<br/>Bot sẽ tự tạo VietQR từ số tài khoản khi gửi cho khách.</span></div>`;
    openModal('qrModal');
  }
  async function syncOne(s, btn) {
    await withLoading(btn, async () => { try { const u = await API.discordUser(s.id); Object.assign(s, { username: u.username || s.username, globalName: u.globalName || u.global_name || s.globalName, avatar: u.avatar || u.avatarUrl || s.avatar }); await API.save({ sellers: sellers() }); render(); toast(`Đã đồng bộ ${s.globalName || s.username}`); } catch (e) { toast(e.message, 'error'); } });
  }

  function bind() {
    const box = $('#sellersContainer');
    box.addEventListener('click', async (e) => {
      const t = e.target.closest('button'); if (!t) return; const d = t.dataset;
      if (d.copyid) copy(d.copyid, 'Đã sao chép Discord ID');
      else if (d.reveal) { revealed.has(d.reveal) ? revealed.delete(d.reveal) : revealed.add(d.reveal); render(); box.querySelector(`[data-reveal="${d.reveal}"]`)?.focus(); }
      else if (d.copybank) copy(bankAt(d.copybank).b.account, 'Đã sao chép số tài khoản');
      else if (d.bankmore) { const { s, b, bi } = bankAt(d.bankmore); const key = d.bankmore; UI.menu(t, [
        { label: revealed.has(key) ? 'Ẩn số tài khoản' : 'Xem số tài khoản', icon: revealed.has(key) ? 'eyeOff' : 'eye', onClick: () => { revealed.has(key) ? revealed.delete(key) : revealed.add(key); render(); } },
        { label: 'Copy số tài khoản', icon: 'copy', onClick: () => copy(b.account, 'Đã sao chép số tài khoản') },
        { label: 'Xem QR', icon: 'image', onClick: () => showQr(s, b) }, '-',
        { label: 'Sửa tài khoản', icon: 'edit', onClick: () => openBank(s, bi) },
        { label: 'Xóa tài khoản', icon: 'trash', tone: 'danger', onClick: async () => { if (await confirmDialog({ title: 'Xóa tài khoản nhận tiền?', message: `${b.bankName} ${maskAcc(b.account)} của ${s.globalName || s.username}. Danh mục đang dùng tài khoản này cần chọn lại.`, confirmText: 'Xóa', tone: 'danger', icon: 'trash' })) { s.banks.splice(bi, 1); revealed.clear(); render(); await persist('Đã xóa tài khoản'); Finance.log({ action: 'BANK_ACCOUNT_CHANGED', targetId: s.id, before: { bank: b.bankName, account: maskAcc(b.account) }, after: null }); } } }]); }
      else if (d.addbank) openBank(sellers()[d.addbank]);
      else if (d.syncone) syncOne(sellers()[d.syncone], t);
      else if (d.lockseller) { const s = sellers()[d.lockseller]; const open = Store.orders.filter((o) => String(o.sellerId) === String(s.id) && ['READY', 'PROCESSING'].includes(o.status)).length;
        const r = await reasonDialog(s.locked ? { title: `Mở khóa seller ${name(s)}?`, message: 'Seller sẽ được giao đơn mới và danh mục hiển thị lại trong menu sau lần đồng bộ Discord tiếp theo.', confirmText: 'Mở khóa', tone: 'warning', icon: 'unlock' } : { title: `Khóa seller ${name(s)}?`, message: 'Seller sẽ không được giao đơn mới và danh mục của họ tạm ẩn khỏi menu.', warning: open ? `Seller đang có ${open} đơn chưa hoàn tất — các đơn này vẫn giữ nguyên, cần theo dõi.` : '', confirmText: 'Khóa seller', tone: 'danger', icon: 'lock' });
        if (r === null) return; s.locked = !s.locked; render(); await persist(s.locked ? 'Đã khóa seller' : 'Đã mở khóa seller'); Finance.log({ action: 'SELLER_LOCKED', targetId: s.id, before: { locked: !s.locked }, after: { locked: s.locked }, metadata: { reason: r, seller: name(s) } }); }
      else if (d.delseller) { const s = sellers()[d.delseller]; const used = (Store.data?.products || []).filter((p) => String(p.sellerId) === String(s.id)).map((p) => p.name);
        const confirmed = await confirmDialog({ title: `Xóa seller ${name(s)}?`, message: used.length ? `Đơn cũ vẫn giữ lịch sử. Cần gán seller khác cho: ${used.join(', ')}.` : 'Đơn cũ vẫn giữ lịch sử. Thao tác này không thể hoàn tác.', confirmText: 'Xóa seller', tone: 'danger', icon: 'trash' });
        if (confirmed) { sellers().splice(d.delseller, 1); render(); fillSelect(); await persist('Đã xóa seller'); Finance.log({ action: 'SELLER_DELETED', targetId: s.id, before: { seller: name(s) }, after: null, metadata: { affectedProducts: used } }); } }
    });

    $('#bankForm').addEventListener('submit', async (e) => {
      e.preventDefault(); if (!bankCtx) return;
      const nb = { bankName: $('#bfBank').value.trim(), account: $('#bfAccount').value.replace(/\s/g, ''), owner: $('#bfOwner').value.trim().toUpperCase(), qr: $('#bfQr').value.trim() };
      if (!nb.bankName || !/^\d{6,20}$/.test(nb.account) || !nb.owner) { toast('Nhập ngân hàng, số tài khoản (6–20 số) và chủ tài khoản.', 'error'); return; }
      const { s, bi } = bankCtx; s.banks = s.banks || []; if (bi != null) s.banks[bi] = nb; else s.banks.push(nb);
      await withLoading($('#btnBankSave'), () => persist(bi != null ? 'Đã cập nhật tài khoản' : 'Đã thêm tài khoản nhận'));
      Finance.log({ action: 'BANK_ACCOUNT_CHANGED', targetId: s.id, before: null, after: { bank: nb.bankName, account: maskAcc(nb.account) } });
      closeModal('bankModal'); render();
    });
    // Add seller modal
    let found = null;
    const resetModal = () => { found = null; ['modalSellerDiscordId', 'modalBankName', 'modalBankAccount', 'modalBankOwner', 'modalBankQr'].forEach((id) => ($(`#${id}`).value = '')); $('#modalDiscordPreview').classList.add('hidden'); $('#btnConfirmAdd').disabled = true; };
    $('#btnOpenAddSeller').addEventListener('click', () => { resetModal(); openModal('addSellerModal', { focus: '#modalSellerDiscordId' }); });
    $('#modalSellerDiscordId').addEventListener('input', () => { found = null; $('#btnConfirmAdd').disabled = true; $('#modalDiscordPreview').classList.add('hidden'); });
    $('#btnCheckId').addEventListener('click', (e) => withLoading(e.currentTarget, async () => {
      const id = $('#modalSellerDiscordId').value.trim();
      if (!/^\d{15,20}$/.test(id)) { toast('Discord ID gồm 15–20 chữ số.', 'error'); return; }
      if (sellers().some((s) => String(s.id) === id)) { toast('Seller này đã có trong danh sách.', 'info'); return; }
      try { const u = await API.discordUser(id); found = { id: u.id || id, username: u.username, globalName: u.globalName || u.global_name || u.username, avatar: u.avatar || u.avatarUrl || '' };
        $('#previewAvatar').src = found.avatar || '/logo.png'; $('#previewUsername').textContent = found.username; $('#previewGlobalName').textContent = found.globalName; $('#previewId').textContent = found.id;
        $('#modalDiscordPreview').classList.remove('hidden'); $('#btnConfirmAdd').disabled = false;
      } catch (er) { toast(er.status === 404 ? 'Không tìm thấy người dùng Discord này.' : er.message, 'error'); }
    }));
    $('#btnConfirmAdd').addEventListener('click', (e) => withLoading(e.currentTarget, async () => {
      if (!found) return; const acc = $('#modalBankAccount').value.replace(/\s/g, '');
      const s = { ...found, banks: acc ? [{ bankName: $('#modalBankName').value.trim(), account: acc, owner: $('#modalBankOwner').value.trim().toUpperCase(), qr: $('#modalBankQr').value.trim() }] : [] };
      sellers().push(s); await persist('Đã thêm seller'); Finance.log({ action: 'SELLER_CREATED', targetId: s.id, before: null, after: { seller: s.globalName, banks: s.banks.length } }); closeModal('addSellerModal'); render(); fillSelect();
    }));
    $('#btnResyncSellers').addEventListener('click', (e) => withLoading(e.currentTarget, async () => {
      try { for (const s of sellers()) { try { const u = await API.discordUser(s.id); Object.assign(s, { username: u.username || s.username, globalName: u.globalName || u.global_name || s.globalName, avatar: u.avatar || u.avatarUrl || s.avatar }); } catch { /* skip */ } } await API.save({ sellers: sellers() }); render(); toast('Đã đồng bộ seller từ Discord'); } catch (er) { toast(er.message, 'error'); }
    }));

    // Dashboard accounts
    $('#dashboardAccountForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = $('#dashboardUsername').value.trim(), password = $('#dashboardPassword').value, sellerId = $('#dashboardSellerSelect').value;
      if (!sellerId || username.length < 3 || password.length < 6) { toast('Chọn seller, tên ≥ 3 ký tự, mật khẩu ≥ 6 ký tự.', 'error'); return; }
      const permissions = ['orders.read', 'autoresponse']; if ($('#dashboardCompletePermission').checked) permissions.push('orders.complete_own'); if ($('#dashboardEditPermission').checked) permissions.push('orders.edit'); if ($('#dashboardProductPermission').checked) permissions.push('products.edit'); if ($('#dashboardAutoResponsePermission')?.checked && !permissions.includes('autoresponse')) permissions.push('autoresponse');
      await withLoading($('#btnCreateDashboardAccount'), async () => { try { await API.createDashboardUser({ username, password, sellerId, permissions, role: 'seller' }); toast('Đã tạo tài khoản dashboard'); e.target.reset(); $('#dashboardCompletePermission').checked = true; if ($('#dashboardAutoResponsePermission')) $('#dashboardAutoResponsePermission').checked = true; await loadUsers(); } catch (er) { toast(er.message, 'error'); } });
    });
    $('#dashboardUsersList').addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b) return; const u = (Store.users || []).find((x) => x.username === b.dataset.u); if (!u) return;
      try {
        if (b.dataset.ua === 'lock') { const r = await reasonDialog({ title: `${u.locked ? 'Mở khóa' : 'Khóa'} tài khoản ${u.username}?`, message: u.locked ? 'Người này sẽ đăng nhập lại được.' : 'Người này bị đăng xuất và không đăng nhập được cho tới khi mở khóa.', confirmText: u.locked ? 'Mở khóa' : 'Khóa tài khoản', tone: u.locked ? 'warning' : 'danger', icon: u.locked ? 'unlock' : 'lock' }); if (r === null) return; await API.updateDashboardUser(u.username, { locked: !u.locked }); toast(u.locked ? 'Đã mở khóa' : 'Đã khóa tài khoản'); Finance.log({ action: 'DASHBOARD_ACCOUNT_CHANGED', targetId: u.username, before: { locked: u.locked }, after: { locked: !u.locked }, metadata: { reason: r } }); }
        else if (b.dataset.ua === 'pw') { const pw = await promptDialog({ title: `Đổi mật khẩu cho ${u.username}`, message: 'Tối thiểu 6 ký tự.', type: 'password', icon: 'key', confirmText: 'Đổi mật khẩu' }); if (!pw) return; if (pw.length < 6) { toast('Mật khẩu quá ngắn', 'error'); return; } await API.updateDashboardUser(u.username, { password: pw }); toast('Đã đổi mật khẩu'); }
        else if (b.dataset.ua === 'del') { if (!(await confirmDialog({ title: `Xóa tài khoản ${u.username}?`, message: 'Người này sẽ không đăng nhập dashboard được nữa. Seller vẫn giữ nguyên.', confirmText: 'Xóa tài khoản', tone: 'danger', icon: 'trash' }))) return; await API.deleteDashboardUser(u.username); toast('Đã xóa tài khoản'); Finance.log({ action: 'DASHBOARD_ACCOUNT_CHANGED', targetId: u.username, before: { exists: true }, after: { exists: false } }); }
        await loadUsers();
      } catch (er) { toast(er.message, 'error'); }
    });
    $('#dashboardUsersList').addEventListener('change', async (e) => {
      const c = e.target.closest('input[data-perm-toggle]'); if (!c) return; const u = Store.users.find((x) => x.username === c.dataset.u);
      const set = new Set(u.permissions || []); c.checked ? set.add(c.dataset.permToggle) : set.delete(c.dataset.permToggle);
      const P = OrderRules.PERMISSIONS[c.dataset.permToggle];
      const r = await reasonDialog({ title: `${c.checked ? 'Cấp' : 'Thu hồi'} quyền “${P.label}” cho ${u.username}?`, message: P.desc, warning: c.checked && P.sensitive ? P.sensitive : '', confirmText: c.checked ? 'Cấp quyền' : 'Thu hồi quyền', tone: c.checked && P.sensitive ? 'danger' : 'warning', icon: 'key' });
      if (r === null) { c.checked = !c.checked; return; }
      const before = [...(u.permissions || [])];
      try { Finance.log({ action: 'SELLER_PERMISSIONS_CHANGED', targetId: u.username, before: { permissions: before }, after: { permissions: [...set] }, metadata: { reason: r } }); await API.updateDashboardUser(u.username, { permissions: [...set] }); u.permissions = [...set]; toast('Đã cập nhật quyền'); render(); } catch (er) { c.checked = !c.checked; toast(er.message, 'error'); }
    });
  }

  function renderUsers(err) {
    const box = $('#dashboardUsersList'); if (!box) return;
    if (err) { box.innerHTML = err === 403 ? state.denied() : state.error(err); return; }
    const users = Store.users || [];
    if (!users.length) { box.innerHTML = `<p class="muted" style="margin:0">Chưa có tài khoản seller nào.</p>`; return; }
    box.innerHTML = users.map((u) => { const s = sellers().find((x) => String(x.id) === String(u.sellerId)); return `<div class="bank-row" style="flex-direction:column;align-items:stretch;gap:10px">
      <div class="row">${avatar(s?.avatar, s?.globalName || u.username, 'sm')}<div style="flex:1;min-width:0"><div class="cell-main mono">${esc(u.username)}</div><div class="cell-sub">${esc(s ? s.globalName || s.username : 'Seller đã xóa')}</div></div>${u.locked ? badge('warning', 'lock', 'Đã khóa') : badge('success', '', 'Hoạt động')}</div>
      <div class="row wrap" style="gap:12px">${Object.entries(PERMS).map(([k, t]) => `<label class="row perm-chip" title="${esc(OrderRules.PERMISSIONS[k].desc)}"><input type="checkbox" data-perm-toggle="${k}" data-u="${esc(u.username)}" ${(u.permissions || []).includes(k) ? 'checked' : ''} />${esc(t)}${OrderRules.PERMISSIONS[k].sensitive ? `<span class="sr-only"> (quyền nhạy cảm)</span>${I('alert', 'sm')}` : ''}</label>`).join('')}</div>
      <div class="row" style="gap:6px"><button class="btn btn-sm" data-ua="lock" data-u="${esc(u.username)}">${I(u.locked ? 'unlock' : 'lock', 'sm')}${u.locked ? 'Mở khóa' : 'Khóa'}</button><button class="btn btn-sm" data-ua="pw" data-u="${esc(u.username)}">${I('key', 'sm')}Đổi mật khẩu</button><span class="spacer"></span><button class="btn btn-sm btn-danger btn-icon" data-ua="del" data-u="${esc(u.username)}" aria-label="Xóa tài khoản ${esc(u.username)}">${I('trash', 'sm')}</button></div></div>`; }).join('');
  }
  async function loadUsers() { try { Store.users = API.list(await API.dashboardUsers(), 'users', 'items'); renderUsers(); render(); } catch (e) { if (e.status !== 401) renderUsers(e.status === 403 ? 403 : e.message); } }
  function fillSelect() { const s = $('#dashboardSellerSelect'); if (s) s.innerHTML = '<option value="">— Chọn seller —</option>' + sellers().map((x) => `<option value="${esc(x.id)}">${esc(x.globalName || x.username)}</option>`).join(''); }
  function init() { bind(); }
  window.Sellers = { init, render, loadUsers, fillSelect };
  window.renderSellers = render;
})();
