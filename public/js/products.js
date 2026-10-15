/* Product/category editor: list | editor | Discord preview. Debounced auto-save via POST /api/save. */
(function () {
  const { $, $$, esc, I, vnd, avatar, toast, confirmDialog, debounce, emojiHtml } = UI;
  const pv = { selected: 0, saveState: 'idle', device: 'desktop', collapsed: new Set(), snapshot: null, savedAt: null };
  const products = () => (Store.data?.products || (Store.data && (Store.data.products = [])) || []);
  const sellers = () => Store.data?.sellers || [];
  const sById = (id) => sellers().find((s) => String(s.id) === String(id));
  const canEdit = () => Auth.isAdmin() || Auth.can('products.edit');
  const visible = () => Auth.isAdmin() ? products() : products().filter((p) => String(p.sellerId) === String(Auth.sellerId()) || (p.handlers || []).map(String).includes(String(Auth.sellerId())));

  function setSave(s, msg) {
    pv.saveState = s; const el = $('#prodSaveState'); if (!el) return;
    if (s === 'saved') pv.savedAt = new Date();
    if (s === 'saved') pv.version = (pv.version || 1) + 1;
    const pub = JSON.stringify(products()) !== pv.snapshot ? ' · chưa đồng bộ Discord' : '';
    const map = { idle: ['', pv.savedAt ? `Bản nháp v${pv.version} · lưu lúc ${pv.savedAt.toLocaleTimeString('vi-VN')}${pub}` : 'Tự động lưu nháp đang bật'], dirty: ['warn', 'Đang chỉnh sửa — tự lưu sau 1 giây'], saving: ['', 'Đang lưu nháp…'], saved: ['ok', `Đã lưu nháp v${pv.version} lúc ${pv.savedAt?.toLocaleTimeString('vi-VN')}${pub}`], error: ['err', msg || 'Lưu thất bại'] };
    const [d, t] = map[s]; el.innerHTML = `<span class="dot ${d}"></span>${esc(t)}${s === 'error' ? ' · <button class="btn btn-sm btn-ghost" id="btnProdRetry">Thử lại</button>' : ''}`;
    $('#btnProdRetry')?.addEventListener('click', () => { setSave('saving'); autoSave(); });
    const disc = $('#btnProdDiscard'); if (disc) disc.disabled = !pv.snapshot || JSON.stringify(products()) === pv.snapshot;
  }
  const autoSave = debounce(async () => {
    setSave('saving');
    try { await API.save({ products: products() }); setSave('saved'); Finance.log?.({ action: 'PRODUCT_CHANGED', targetId: products()[pv.selected]?.key || '', before: null, after: { version: pv.version, product: products()[pv.selected]?.name } }); } catch (e) { setSave('error', e.status === 403 ? 'Không đủ quyền lưu' : 'Lưu thất bại'); toast(e.message, 'error'); }
  }, 900);
  const touch = () => { if (!canEdit()) return; setSave('dirty'); renderPreview(); renderList(); autoSave(); };

  function renderList() {
    const list = visible(); $('#prodCardCountHeader').textContent = list.length;
    $('#productsList').innerHTML = list.length ? list.map((p) => { const i = products().indexOf(p); return `<button class="prod-item ${p.enabled === false ? 'disabled' : ''}" data-pidx="${i}" aria-current="${i === pv.selected}"><span class="em">${emojiHtml ? emojiHtml(p.emoji, 20) : esc(p.emoji || '•')}</span><span style="min-width:0"><span class="nm" style="display:block">${esc(p.name || 'Chưa đặt tên')}</span><span class="cell-sub">${(p.items || []).length} gói</span></span>${p.enabled === false ? '<span class="off">Tắt</span>' : ''}</button>`; }).join('') : '<p class="muted" style="padding:10px;margin:0">Chưa có danh mục.</p>';
    $('#prodPreviewSelect').innerHTML = list.map((p) => `<option value="${products().indexOf(p)}">${esc(p.name)}</option>`).join('');
    $$('#productsList [data-pidx]').forEach((b) => b.addEventListener('click', () => { pv.selected = Number(b.dataset.pidx); render(); }));
  }

  function sellerOptions(sel, allowEmpty = true) { return (allowEmpty ? '<option value="">— Chọn seller —</option>' : '') + sellers().map((s) => `<option value="${esc(s.id)}" ${String(s.id) === String(sel) ? 'selected' : ''}>${esc(s.globalName || s.username)}</option>`).join(''); }

  function renderEditor() {
    const box = $('#productsContainer'); const p = products()[pv.selected];
    if (!visible().length) { box.innerHTML = UI.state.empty('Chưa có danh mục', Auth.isAdmin() ? 'Thêm danh mục đầu tiên để hiển thị trên menu Discord.' : 'Bạn chưa được giao danh mục nào.'); return; }
    if (!p || !visible().includes(p)) { pv.selected = products().indexOf(visible()[0]); return renderEditor(); }
    const ro = canEdit() ? '' : 'disabled'; const admin = Auth.isAdmin();
    const main = sById(p.sellerId); const banks = main?.banks || [];
    box.innerHTML = `
      <div class="card-head"><button class="emoji-btn" id="prodEmojiBtn" ${ro} aria-label="Đổi emoji">${emojiHtml ? emojiHtml(p.emoji, 24) : esc(p.emoji || '•')}</button><div style="flex:1;min-width:0"><h3>${esc(p.name || 'Chưa đặt tên')}</h3><div class="cell-sub mono">key: ${esc(p.key || '—')}</div></div><label class="row" style="gap:8px;font-size:13px;font-weight:600;cursor:pointer" title="Bật/tắt bán trên menu Discord"><span class="switch"><input type="checkbox" id="pfEnabled" ${p.enabled !== false ? 'checked' : ''} ${ro} /><span></span></span><span id="pfEnabledLbl">${p.enabled !== false ? 'Đang bán' : 'Tạm ngưng'}</span></label>${admin ? `<button class="btn btn-sm btn-ghost btn-icon" id="btnDupProduct" aria-label="Nhân bản danh mục" title="Nhân bản">${I('copy', 'sm')}</button><button class="btn btn-danger btn-sm btn-icon" id="btnDeleteProduct" aria-label="Xóa danh mục" title="Xóa">${I('trash', 'sm')}</button>` : ''}</div>
      ${!canEdit() ? `<div class="alert alert-info" style="margin:16px 20px 0">${I('lock')}<span>Bạn chỉ có quyền xem danh mục này.</span></div>` : ''}
      <details class="editor-sec esec" data-sec="1" ${pv.collapsed.has('1') ? '' : 'open'}><summary><h4><span class="n">1</span>Thông tin hiển thị</h4>${I('chevronDown', 'sm chev')}</summary>
        <div class="grid-2">
          <div class="field"><label for="pfName">Tên hiển thị</label><input class="input" id="pfName" data-f="name" value="${esc(p.name)}" ${ro} /></div>
          <div class="field"><label for="pfKey">Category key</label><input class="input mono" id="pfKey" data-f="key" value="${esc(p.key)}" ${admin ? '' : 'disabled'} /><span class="hint">Dùng nội bộ, không dấu, không khoảng trắng.</span></div>
          <div class="field"><label for="pfTitle">Tiêu đề embed</label><input class="input" id="pfTitle" data-f="title" value="${esc(p.title)}" ${ro} /></div>
          <div class="field"><label for="pfSub">Phụ đề</label><textarea class="textarea" id="pfSub" data-f="subtitle" ${ro}>${esc(p.subtitle)}</textarea></div>
          <div class="field"><label for="pfBanner">Banner URL</label><input class="input" id="pfBanner" data-f="banner" value="${esc(p.banner)}" placeholder="https://…" ${ro} /></div>
          <div class="field"><label for="pfColor">Màu embed</label><div class="row"><input type="color" id="pfColorPick" value="${esc(p.color || '#5865F2')}" ${ro} style="width:44px;height:40px;border:1px solid var(--border-default);border-radius:10px;background:var(--surface-1);padding:3px" aria-label="Chọn màu" /><input class="input mono" id="pfColor" data-f="color" value="${esc(p.color || '#5865F2')}" ${ro} /></div></div>
        </div>
      </details>
      <details class="editor-sec esec" data-sec="2" ${pv.collapsed.has('2') ? '' : 'open'}><summary><h4><span class="n">2</span>Gói giá</h4>${I('chevronDown', 'sm chev')}</summary>
        <div class="stack" style="gap:8px" id="tierList">
          <div class="tier v2 label"><span>Tên gói / khoảng số lượng</span><span>Giá (VNĐ)</span><span></span><span></span><span></span></div>
          ${(p.items || []).map((it, i) => `<div class="tier v2"><label class="sr-only" for="tl${i}">Tên gói ${i + 1}</label><input class="input" id="tl${i}" data-tier="${i}" data-tf="label" value="${esc(it.label)}" ${ro} /><label class="sr-only" for="tp${i}">Giá gói ${i + 1}</label><input class="input mono" id="tp${i}" data-tier="${i}" data-tf="price" inputmode="numeric" value="${esc(it.price)}" ${ro} />${canEdit() ? `<button class="btn btn-ghost btn-icon btn-sm" data-movetier="${i}" data-dir="-1" aria-label="Đưa gói ${i + 1} lên" ${i === 0 ? 'disabled' : ''}>${I('chevronDown', 'sm')}</button><button class="btn btn-ghost btn-icon btn-sm" data-movetier="${i}" data-dir="1" aria-label="Đưa gói ${i + 1} xuống" ${i === p.items.length - 1 ? 'disabled' : ''}>${I('chevronDown', 'sm')}</button><button class="btn btn-ghost btn-icon btn-sm" data-deltier="${i}" aria-label="Xóa gói ${i + 1}">${I('x', 'sm')}</button>` : '<span></span><span></span><span></span>'}</div>`).join('')}
        </div>
        ${canEdit() ? `<button class="btn btn-sm" id="btnAddTier" style="margin-top:10px">${I('plus', 'sm')}Thêm gói</button>` : ''}
      </details>
      <details class="editor-sec esec" data-sec="3" ${pv.collapsed.has('3') ? '' : 'open'}><summary><h4><span class="n">3</span>Seller & nhận tiền</h4>${I('chevronDown', 'sm chev')}</summary>
        <div class="grid-2">
          <div class="field"><label for="pfSeller">Seller chính <span class="muted">(nhận đơn)</span></label><select class="select" id="pfSeller" ${admin ? '' : 'disabled'}>${sellerOptions(p.sellerId)}</select></div>
          <div class="field"><label for="pfBank">Tài khoản nhận tiền <span class="muted">(của seller chính)</span></label><select class="select" id="pfBank" ${admin ? '' : 'disabled'}>${banks.length ? banks.map((b, i) => `<option value="${i}" ${Number(p.bankIndex) === i ? 'selected' : ''}>${esc(b.bankName)} · ${esc(UI.maskAcc(b.account))}</option>`).join('') : '<option value="">Seller chưa có tài khoản</option>'}</select></div>
        </div>
        <div class="field" style="margin-top:14px"><span class="label">Người hỗ trợ (handlers)</span>
          <div class="row wrap" id="handlerChips">${(p.handlers || []).map((h) => { const s = sById(h); return `<span class="chip">${avatar(s?.avatar, s?.globalName || h, 'sm')}${esc(s ? s.globalName || s.username : UI.shortId(h))}${admin ? `<button class="x" data-delhandler="${esc(h)}" aria-label="Bỏ ${esc(s?.globalName || h)}">${I('x', 'sm')}</button>` : ''}</span>`; }).join('') || '<span class="muted">Chưa có</span>'}
          ${admin ? `<label class="sr-only" for="pfAddHandler">Thêm người hỗ trợ</label><select class="select" id="pfAddHandler" style="width:auto;min-height:32px;padding-top:4px;padding-bottom:4px"><option value="">+ Thêm</option>${sellers().filter((s) => String(s.id) !== String(p.sellerId) && !(p.handlers || []).map(String).includes(String(s.id))).map((s) => `<option value="${esc(s.id)}">${esc(s.globalName || s.username)}</option>`).join('')}</select>` : ''}</div>
        </div>
        <label class="check" style="margin-top:14px;align-items:center"><span class="switch"><input type="checkbox" id="pfPing" ${p.pingStaff ? 'checked' : ''} ${ro} /><span></span></span><span><strong>Ping staff khi mở ticket</strong><span class="hint">Gắn tag seller chính và người hỗ trợ trong ticket mới.</span></span></label>
      </details>`;
    $$('details.esec', box).forEach((d) => d.addEventListener('toggle', () => { d.open ? pv.collapsed.delete(d.dataset.sec) : pv.collapsed.add(d.dataset.sec); syncToggleAll(); }));
    $$('[data-movetier][data-dir="-1"] svg', box).forEach((sv) => (sv.style.transform = 'rotate(180deg)'));
    syncToggleAll();
    if (!canEdit()) return;
    $('#pfEnabled').addEventListener('change', async (e) => { if (!e.target.checked) { const ok = await confirmDialog({ title: `Tạm ngưng bán “${p.name}”?`, message: 'Danh mục sẽ ẩn khỏi menu Discord sau lần đồng bộ tiếp theo. Đơn đang xử lý không bị ảnh hưởng.', confirmText: 'Tạm ngưng', tone: 'warning', icon: 'ban' }); if (!ok) { e.target.checked = true; return; } } p.enabled = e.target.checked; $('#pfEnabledLbl').textContent = p.enabled ? 'Đang bán' : 'Tạm ngưng'; touch(); toast(p.enabled ? `Đã bật bán ${p.name}` : `Đã tạm ngưng ${p.name}`, 'info'); });
    $$('[data-movetier]', box).forEach((b) => b.addEventListener('click', () => { const i = Number(b.dataset.movetier), j = i + Number(b.dataset.dir); if (j < 0 || j >= p.items.length) return; [p.items[i], p.items[j]] = [p.items[j], p.items[i]]; renderEditor(); touch(); $(`[data-movetier="${j}"][data-dir="${b.dataset.dir}"]`)?.focus(); }));
    $('#btnDupProduct')?.addEventListener('click', async () => { if (!(await confirmDialog({ title: `Nhân bản “${p.name}”?`, message: 'Bản sao giữ nguyên bảng giá, seller và tài khoản nhận tiền, ở trạng thái tạm ngưng bán cho tới khi bạn bật.', confirmText: 'Nhân bản', icon: 'copy' }))) return; const c = JSON.parse(JSON.stringify(p)); c.id = `p${Date.now()}`; c.key = `${p.key || 'item'}_copy`; c.name = `${p.name} (bản sao)`; c.enabled = false; products().splice(pv.selected + 1, 0, c); pv.selected += 1; render(); touch(); toast('Đã nhân bản — bản sao đang tạm ngưng bán', 'info'); });
    $$('[data-f]', box).forEach((el) => el.addEventListener('input', () => { p[el.dataset.f] = el.value; if (el.dataset.f === 'color') $('#pfColorPick').value = el.value; if (el.dataset.f === 'name') box.querySelector('.card-head h3').textContent = el.value || 'Chưa đặt tên'; touch(); }));
    $('#pfColorPick').addEventListener('input', (e) => { p.color = e.target.value; $('#pfColor').value = e.target.value; touch(); });
    $$('[data-tier]', box).forEach((el) => el.addEventListener('input', () => { const it = p.items[el.dataset.tier]; it[el.dataset.tf] = el.dataset.tf === 'price' ? Number(el.value.replace(/\D/g, '')) : el.value; touch(); }));
    $$('[data-deltier]', box).forEach((b) => b.addEventListener('click', () => { p.items.splice(Number(b.dataset.deltier), 1); renderEditor(); touch(); }));
    $('#btnAddTier')?.addEventListener('click', () => { (p.items = p.items || []).push({ label: '', price: 0 }); renderEditor(); touch(); $(`#tl${p.items.length - 1}`)?.focus(); });
    $('#pfSeller')?.addEventListener('change', (e) => { p.sellerId = e.target.value; p.bankIndex = 0; renderEditor(); touch(); });
    $('#pfBank')?.addEventListener('change', (e) => { p.bankIndex = Number(e.target.value); touch(); });
    $('#pfAddHandler')?.addEventListener('change', (e) => { if (!e.target.value) return; (p.handlers = p.handlers || []).push(e.target.value); renderEditor(); touch(); });
    $$('[data-delhandler]', box).forEach((b) => b.addEventListener('click', () => { p.handlers = p.handlers.filter((h) => String(h) !== b.dataset.delhandler); renderEditor(); touch(); }));
    $('#pfPing').addEventListener('change', (e) => { p.pingStaff = e.target.checked; touch(); });
    const emojiBtn = $('#prodEmojiBtn');
    emojiBtn?.addEventListener('click', () => Emoji.open(emojiBtn, p.emoji, (em) => {
      p.emoji = em;
      emojiBtn.innerHTML = emojiHtml ? emojiHtml(em, 24) : esc(em);
      renderList();
      renderPreview();
      touch();
    }));
    $('#btnDeleteProduct')?.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: `Xóa danh mục “${p.name}”?`, message: 'Danh mục sẽ biến mất khỏi menu Discord sau lần đồng bộ tiếp theo. Đơn cũ không bị ảnh hưởng.', confirmText: 'Xóa danh mục', tone: 'danger', icon: 'trash' }))) return;
      products().splice(pv.selected, 1); pv.selected = 0; render(); touch(); toast('Đã xóa danh mục');
    });
  }

  function renderPreview() {
    const p = products()[pv.selected]; const box = $('#prodEmbedBox'); if (!box) return;
    $('#prodBotName').textContent = Store.data?.botName || '4AM STORE';
    $('#prodDiscordFrame').classList.toggle('mobile', pv.device === 'mobile');
    $('#btnPrevDesktop').setAttribute('aria-pressed', String(pv.device === 'desktop')); $('#btnPrevMobile').setAttribute('aria-pressed', String(pv.device === 'mobile'));
    if (!p) { $('#prodEmbedTitle').textContent = 'Chưa có danh mục'; $('#prodEmbedSub').textContent = ''; $('#prodEmbedItems').innerHTML = ''; return; }
    box.style.borderLeftColor = p.color || '#5865F2';
    const titleText = (p.title || p.name || '').trim();
    $('#prodEmbedTitle').innerHTML = `${emojiHtml ? emojiHtml(p.emoji, 18) : esc(p.emoji || '')} ${esc(titleText)}`.trim();
    $('#prodEmbedSub').textContent = p.subtitle || '';
    const handlers = (p.handlers || []).map((h) => sById(h)).filter(Boolean);
    const main = sById(p.sellerId);
    $('#prodEmbedHandlerPrefix').textContent = 'Người bán:';
    $('#prodEmbedHandlerNames').textContent = [main, ...handlers].filter(Boolean).map((s) => `@${s.globalName || s.username}`).join(', ') || '—';
    $('#previewSellerBadge').textContent = '';
    $('#prodEmbedItems').innerHTML = (p.items || []).map((it) => `<div><span>${esc(it.label || '—')}</span><span class="p">${esc(vnd(it.price))}</span></div>`).join('');
    const bn = $('#prodEmbedBanner'); bn.innerHTML = p.banner ? `<img src="${esc(p.banner)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:4px" onerror="this.remove()" />` : 'Chưa có banner';
    $('#prodEmbedPingLabel').hidden = !p.pingStaff;
    $('#prodEmbedPingList').textContent = [main, ...handlers].filter(Boolean).map((s) => `@${s.username}`).join(' ');
    $('#prodEmbedBtn').innerHTML = `${I('receipt', 'sm')}Mở ticket`;
  }

  function syncToggleAll() { const b = $('#btnProdToggleAll'); if (!b) return; const anyOpen = $$('#productsContainer details.esec').some((d) => d.open); b.querySelector('span').textContent = anyOpen ? 'Thu gọn tất cả' : 'Mở rộng tất cả'; b.dataset.mode = anyOpen ? 'collapse' : 'expand'; }
  function render() { if (!Store.data) return; if (pv.snapshot === null) { pv.snapshot = JSON.stringify(products()); pv.openedAt = new Date().toLocaleTimeString('vi-VN'); pv.version = 1; } renderList(); renderEditor(); renderPreview(); setSave(pv.saveState === 'error' ? 'error' : pv.saveState === 'saving' ? 'saving' : 'idle'); }

  async function addProduct() {
    const name = await UI.promptDialog({ title: 'Thêm danh mục', message: 'Tên hiển thị trên menu Discord.', placeholder: 'Ví dụ: Spotify Premium', confirmText: 'Thêm', icon: 'plus' });
    if (!name) return;
    const key = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    products().push({ id: `p${Date.now()}`, key, name, emoji: '🛒', title: name, subtitle: '', banner: '', color: '#5865F2', sellerId: '', handlers: [], bankIndex: 0, pingStaff: false, items: [{ label: 'Gói cơ bản', price: 0 }] });
    pv.selected = products().length - 1; render(); touch(); $('#pfName')?.focus();
  }

  function init() {
    $('#btnAddProduct')?.addEventListener('click', addProduct);
    $('#btnProdToggleAll').addEventListener('click', (e) => { const collapse = e.currentTarget.dataset.mode !== 'expand'; ['1', '2', '3'].forEach((n) => (collapse ? pv.collapsed.add(n) : pv.collapsed.delete(n))); $$('#productsContainer details.esec').forEach((d) => (d.open = !collapse)); syncToggleAll(); });
    $('#btnProdDiscard').addEventListener('click', async () => {
      if (!pv.snapshot || !(await confirmDialog({ title: 'Hủy thay đổi?', message: `Quay về phiên bản lúc mở trang (${pv.openedAt || '—'}). Mọi bản nháp đã tự lưu sau đó sẽ bị ghi đè.`, confirmText: 'Hủy thay đổi', tone: 'danger', icon: 'rotate' }))) return;
      Store.data.products = JSON.parse(pv.snapshot); pv.selected = 0; render(); setSave('saving'); autoSave(); toast('Đã khôi phục mặt hàng', 'info');
    });
    $('#btnPrevDesktop').addEventListener('click', () => { pv.device = 'desktop'; renderPreview(); });
    $('#btnPrevMobile').addEventListener('click', () => { pv.device = 'mobile'; renderPreview(); });
    $('#prodPreviewSelect').addEventListener('change', (e) => { pv.selected = Number(e.target.value); render(); });
  }
  window.Products = { init, render };
  window.renderProducts = render;
})();

/* Emoji picker (server emojis from /api/bot-emojis + popular + unicode) */
(function () {
  const { $, $$, esc, emojiHtml } = UI;
  const POPULAR = ['🪙', '💎', '🖥️', '🤖', '🌐', '🎵', '🎮', '🛒', '⚡', '🔥', '⭐', '✅', '💳', '🎁', '📦', '🚀', '🔒', '💬', '📈', '🧾', '🎧', '📱', '💻', '🛡️'];
  const UNICODE = ['😀', '😎', '🤑', '🥳', '😺', '👑', '💰', '💵', '🏦', '🧧', '🎟️', '🔑', '🧩', '🪄', '📀', '🖱️', '⌨️', '🕹️', '📡', '☁️', '🌙', '☀️', '🌈', '❤️', '💜', '💙', '💚', '🧡', '🖤', '🤍', '🔔', '📣', '⏰', '⌛', '🧪', '🛠️', '⚙️', '🧠', '👾', '🐉'];
  const st = { tab: 'popular', server: null, cb: null, anchor: null, q: '', sel: '' };
  function grid() {
    let items = st.tab === 'server'
      ? (st.server || []).map((e) => ({
          v: e.format || (e.id ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : e.name),
          html: e.url ? `<img src="${esc(e.url)}" alt="" />` : esc(e.name),
          name: e.name
        }))
      : (st.tab === 'popular' ? POPULAR : UNICODE).map((e) => ({ v: e, html: e, name: e }));
    if (st.q) items = items.filter((i) => i.name.toLowerCase().includes(st.q));
    $('#emojiPickerStatus').textContent = st.tab === 'server' && st.server === null ? 'Đang tải emoji server…' : items.length ? '' : 'Không có emoji phù hợp.';
    $('#emojiScrollArea').innerHTML = items.map((i) => `<button type="button" data-ev="${esc(i.v)}" title="${esc(i.name)}" aria-label="${esc(i.name)}">${i.html}</button>`).join('');
    $$('#emojiScrollArea button').forEach((b) => {
      b.addEventListener('mouseenter', () => ($('#emojiHoverInfo').textContent = b.title));
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const val = b.dataset.ev;
        try {
          st.cb?.(val);
        } catch (err) {
          console.error('Lỗi khi gọi callback emoji:', err);
        }
        close();
      });
    });
    $$('#emojiPickerPopover [data-etab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.etab === st.tab)));
  }
  async function loadServer() { if (st.server) return; try { st.server = API.list(await API.botEmojis(), 'emojis', 'items'); } catch { st.server = []; } grid(); }
  function open(anchor, current, cb) {
    st.cb = cb; st.anchor = anchor; st.sel = current || '';
    $('#emojiCurrentSelection').innerHTML = emojiHtml ? emojiHtml(st.sel, 16) : esc(st.sel);
    const pop = $('#emojiPickerPopover'); pop.classList.remove('hidden');
    const r = anchor.getBoundingClientRect(); pop.style.top = `${Math.min(r.bottom + 6, innerHeight - 360)}px`; pop.style.left = `${Math.min(r.left, innerWidth - 350)}px`;
    grid(); if (st.tab === 'server') loadServer(); $('#emojiSearchInput').value = ''; st.q = ''; $('#emojiSearchInput').focus();
  }
  function close() { $('#emojiPickerPopover').classList.add('hidden'); st.anchor?.focus(); }
  document.addEventListener('DOMContentLoaded', () => {
    $$('#emojiPickerPopover [data-etab]').forEach((b) => b.addEventListener('click', () => { st.tab = b.dataset.etab; grid(); if (st.tab === 'server') loadServer(); }));
    $('#emojiSearchInput').addEventListener('input', (e) => { st.q = e.target.value.trim().toLowerCase(); grid(); });
    document.addEventListener('mousedown', (e) => { const p = $('#emojiPickerPopover'); if (!p.classList.contains('hidden') && !p.contains(e.target) && e.target !== st.anchor) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#emojiPickerPopover').classList.contains('hidden')) { e.stopPropagation(); close(); } }, true);
  });
  window.Emoji = { open, close };
})();
