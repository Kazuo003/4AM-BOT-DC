/* Discord configuration: Menu + Ticket panel with live preview.
   Actions: Lưu nháp (/api/save draft), Đồng bộ Menu (/api/sync), Đồng bộ Ticket (/api/sync-ticket), Lưu & đồng bộ tất cả (/api/save-and-sync), Khôi phục. */
(function () {
  const { $, $$, esc, I, toast, withLoading, confirmDialog, promptDialog, reasonDialog, openModal } = UI;
  const cv = { tab: 'menu', dirty: false, snapshot: null, published: null, draftAt: null, busy: false };
  const D = () => Store.data || {};
  const lines = (a) => (Array.isArray(a) ? a.join('\n') : a || '');

  function setStatus(kind, text) {
    $('#saveStatusIndicator').className = `dot ${kind}`; $('#saveStatusText').textContent = text;
    $('#btnCfgRestore').disabled = !cv.dirty;
  }
  const snap = () => JSON.stringify({ menu: D().menu, ticket: D().ticket });
  function markDirty() { cv.dirty = snap() !== cv.snapshot; setStatus(cv.dirty ? 'warn' : '', cv.dirty ? 'Có thay đổi chưa lưu' : cv.snapshot !== cv.published ? 'Nháp đã lưu, chưa đồng bộ' : 'Đã khớp với Discord'); renderPanel(); }
  // Flatten to leaf paths to count / list differences between two JSON snapshots
  const flat = (o, pre = '', out = {}) => { if (o && typeof o === 'object') Object.keys(o).forEach((k) => flat(o[k], pre ? `${pre}.${k}` : k, out)); else out[pre] = o; return out; };
  function diff(a, b) { const A = flat(JSON.parse(a || '{}')), B = flat(JSON.parse(b || '{}')); return [...new Set([...Object.keys(A), ...Object.keys(B)])].filter((k) => A[k] !== B[k]).map((k) => ({ k, from: A[k], to: B[k] })); }
  const LABEL = { menu: 'Menu', ticket: 'Ticket', lines: 'nội dung 1', payMethods: 'nội dung 2', payTitle: 'tiêu đề 2', shopName: 'tên shop', title: 'tiêu đề 1', color: 'màu', banner: 'banner', logo: 'logo', footer: 'footer', placeholder: 'placeholder', subtitle: 'phụ đề', buttonLabel: 'nút', thumbnail: 'thumbnail' };
  const pretty = (k) => k.split('.').map((x) => /^\d+$/.test(x) ? `#${Number(x) + 1}` : LABEL[x] || x).join(' › ');
  const when = (v) => v ? new Date(v).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '—';
  function renderPanel() {
    const el = $('#cfgPublishPanel'); if (!el || !Store.data) return;
    const pub = D().publish || {}; const n = diff(cv.published, snap()).length;
    const st = cv.dirty ? ['warning', 'edit', 'Đang chỉnh sửa'] : n ? ['info', 'save', 'Bản nháp chưa xuất bản'] : ['success', 'checkCircle', 'Đã xuất bản'];
    el.innerHTML = `<div class="pp-state">${UI.badge(st[0], st[1], st[2])}<span class="secondary">${n ? `${n} thay đổi so với bản đang chạy trên Discord` : 'Nội dung trùng với bản đang chạy trên Discord'}</span></div>
      <dl class="pp-grid">
        <div><dt>Nháp lưu lúc</dt><dd class="mono">${esc(when(cv.draftAt))}</dd></div>
        <div><dt>Menu xuất bản</dt><dd class="mono">${esc(when(pub.menu?.at))}${pub.menu?.by ? ` · ${esc(pub.menu.by)}` : ''}</dd></div>
        <div><dt>Ticket xuất bản</dt><dd class="mono">${esc(when(pub.ticket?.at))}${pub.ticket?.by ? ` · ${esc(pub.ticket.by)}` : ''}</dd></div>
        <div><dt>Bot</dt><dd>${D().botMode === 'ui-test' ? '<span class="dot warn"></span> Online · Test UI' : D().botMode === 'dashboard-only' ? '<span class="dot warn"></span> Chế độ test UI' : D().botOnline !== false ? '<span class="dot ok"></span> Trực tuyến' : '<span class="dot err"></span> Ngoại tuyến'} · ${esc(D().botName || '—')}</dd></div>
        <div><dt>Server</dt><dd>${esc(D().guildName || D().guildId || 'Chưa cấu hình')}</dd></div>
        <div><dt>Kênh</dt><dd class="mono">${esc(D().menuChannelName || D().menu?.menuChannelId || '—')} · ${esc(D().ticketChannelName || D().ticket?.channelId || '—')}</dd></div>
      </dl>`;
    $('#btnCfgDiff').disabled = !n;
  }
  function showDiff() {
    const d = diff(cv.published, snap());
    let m = document.getElementById('cfgDiffModal');
    if (!m) { m = document.createElement('div'); m.className = 'modal'; m.id = 'cfgDiffModal'; m.hidden = true; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'cfgDiffTitle'); document.body.appendChild(m); }
    m.innerHTML = `<div class="modal-backdrop" data-close></div><div class="modal-panel md"><div class="modal-head"><span class="modal-ic">${I('list')}</span><div style="flex:1"><h2 id="cfgDiffTitle">Thay đổi chưa xuất bản</h2><p>${d.length} mục khác với bản đang chạy trên Discord.</p></div><button class="btn btn-ghost btn-icon" data-close aria-label="Đóng">${I('x')}</button></div>
      <div class="modal-body stack" style="gap:8px">${d.length ? d.map((x) => `<div class="history-row"><span class="t" style="min-width:140px">${esc(pretty(x.k))}</span><span class="mono diff-neg" style="text-decoration:line-through">${esc(x.from ?? '∅')}</span><span class="mono">${esc(x.to ?? '∅')}</span></div>`).join('') : '<p class="muted">Không có thay đổi.</p>'}</div>
      <div class="modal-foot"><button class="btn" data-close>Đóng</button></div></div>`;
    openModal('cfgDiffModal', { focus: '[data-close]' });
  }

  const f = (id, label, val, opt = {}) => `<div class="field" ${opt.span ? 'style="grid-column:1/-1"' : ''}><label for="${id}">${label}</label>${opt.area ? `<textarea class="textarea" id="${id}" data-k="${opt.k}">${esc(val)}</textarea>` : `<input class="input ${opt.mono ? 'mono' : ''}" id="${id}" data-k="${opt.k}" value="${esc(val)}" placeholder="${esc(opt.ph || '')}" />`}${opt.hint ? `<span class="hint">${opt.hint}</span>` : ''}</div>`;
  const colorField = (id, k, val) => `<div class="field"><label for="${id}">Màu embed</label><div class="row"><input type="color" value="${esc(val || '#5865F2')}" data-colorfor="${id}" aria-label="Chọn màu" style="width:44px;height:40px;border:1px solid var(--border-default);border-radius:10px;background:var(--surface-1);padding:3px" /><input class="input mono" id="${id}" data-k="${k}" value="${esc(val || '#5865F2')}" /></div></div>`;
  const lineList = (key, label, arr, ph, scope = cv.scope) => `<div class="field" style="grid-column:1/-1"><span class="label">${label}</span><div class="line-list" data-lines="${key}">${(arr || []).map((v, i) => `<div class="line-row"><span class="idx">${i + 1}</span><label class="sr-only" for="${scope}-ln-${key}-${i}">${label} ${i + 1}</label><input class="input" id="${scope}-ln-${key}-${i}" data-line="${i}" value="${esc(v)}" placeholder="${esc(ph)}" /><button type="button" class="btn btn-ghost btn-icon btn-sm" data-delline="${i}" aria-label="Xóa dòng ${i + 1}">${I('x', 'sm')}</button></div>`).join('') || '<p class="hint" style="margin:0">Chưa có dòng nào.</p>'}</div><button type="button" class="btn btn-sm" data-addline="${key}" style="align-self:flex-start">${I('plus', 'sm')}Thêm dòng</button></div>`;
  const media = (key, label, val, kind) => `<div class="field" style="min-width:0"><span class="label">${label}</span><div class="media-field" style="min-width:0"><span class="media-thumb">${val ? `<img src="${esc(val)}" alt="" onerror="this.remove()" />` : I('image', 'sm')}</span><span class="url" title="${esc(val || '')}">${val ? esc(val) : 'Chưa chọn'}</span><button type="button" class="btn btn-sm" data-pickmedia="${key}" data-kind="${kind}">${val ? 'Đổi' : 'Chọn'}</button>${val ? `<button type="button" class="btn btn-sm btn-ghost btn-icon" data-clearmedia="${key}" aria-label="Xóa ${label}">${I('trash', 'sm')}</button>` : ''}</div></div>`;

  function renderMenu() {
    const m = D().menu || (D().menu = {}); cv.scope = 'menu';
    $('#subTabMenu').innerHTML = `<div class="card">
      <div class="editor-sec"><h4><span class="n">1</span>Nội dung</h4><div class="grid-2">
        ${f('cmShop', 'Tên shop', m.shopName, { k: 'shopName' })}${f('cmPlaceholder', 'Placeholder menu chọn', m.placeholder, { k: 'placeholder' })}
        ${f('cmTitle', 'Tiêu đề 1', m.title, { k: 'title', span: 1, ph: 'Ví dụ: BẢNG GIÁ DỊCH VỤ' })}
        ${lineList('lines', 'Nội dung 1 (các dòng text)', m.lines, 'Ví dụ: Dòng nội dung 1')}
        ${f('cmPayTitle', 'Tiêu đề 2', m.payTitle, { k: 'payTitle', span: 1, ph: 'Ví dụ: LƯU Ý / QUY ĐỊNH / THANH TOÁN' })}
        ${lineList('payMethods', 'Nội dung 2 (các dòng text)', m.payMethods, 'Ví dụ: Dòng nội dung 2')}
        ${f('cmFooter', 'Footer', m.footer, { k: 'footer', span: 1 })}
      </div></div>
      <div class="editor-sec"><h4><span class="n">2</span>Hình ảnh & màu</h4><div class="grid-2">
        ${media('logo', 'Logo', m.logo, 'logo')}${media('banner', 'Banner', m.banner, 'banner')}${colorField('cmColor', 'color', m.color)}
      </div></div>
      <div class="editor-sec"><h4><span class="n">3</span>Kênh Discord</h4><div class="grid-2">
        ${f('cmMenuCh', 'Menu channel ID', m.menuChannelId, { k: 'menuChannelId', mono: 1, hint: 'Kênh bot đăng menu bán hàng.' })}${f('cmTicketCh', 'Ticket channel ID', m.ticketChannelId, { k: 'ticketChannelId', mono: 1 })}
      </div></div></div>
      <aside class="prev-pane stack"><span class="label">Xem trước menu</span><div class="discord" id="cfgMenuPreview"></div></aside>`;
    bindFields('#subTabMenu', m, renderMenuPreview, renderMenu); renderMenuPreview();
  }
  function renderMenuPreview() {
    const m = D().menu || {};
    const lines1 = Array.isArray(m.lines) ? m.lines : (m.lines ? [m.lines] : []);
    const lines2 = Array.isArray(m.payMethods) ? m.payMethods : (m.payMethods ? [m.payMethods] : []);
    const formatBullet = (x) => {
      const s = String(x || '').trim();
      if (!s) return '';
      return s.startsWith('•') || s.startsWith('-') || s.startsWith('*') ? esc(s) : `• ${esc(s)}`;
    };
    const s1 = lines1.map(formatBullet).filter(Boolean).join('\n');
    const s2 = lines2.map(formatBullet).filter(Boolean).join('\n');

    const showFooter = m.footer && m.footer.trim() && m.footer.trim().toLowerCase() !== (m.shopName || '4AM STORE').toLowerCase();
    $('#cfgMenuPreview').innerHTML = `<div class="d-msg">${m.logo ? `<img class="avatar" src="${esc(m.logo)}" alt="" onerror="this.outerHTML='<span class=&quot;avatar&quot;>4AM</span>'" />` : '<span class="avatar">4AM</span>'}<div style="flex:1;min-width:0"><div class="d-name">${esc(m.shopName || '4AM STORE')}<span class="d-bot">APP</span><span class="d-time">Hôm nay</span></div>
      <div class="d-embed" style="border-left-color:${esc(m.color || '#5865F2')}">
        <div class="row" style="align-items:flex-start"><div style="flex:1;min-width:0">
          ${m.title ? `<div class="t" style="font-size:18px;font-weight:700">${esc(m.title)}</div>` : ''}
          ${s1 ? `<div class="s">${s1}</div>` : ''}
          ${(m.payTitle || s2) ? `<div class="f" style="margin-top:4px">${m.payTitle ? `<b>${esc(m.payTitle)}</b>` : ''}${s2 ? `<div class="s" style="margin-top:2px">${s2}</div>` : ''}</div>` : ''}
        </div>${m.logo ? `<img src="${esc(m.logo)}" alt="" style="width:64px;height:64px;border-radius:6px;object-fit:cover" onerror="this.remove()" />` : ''}</div>
        <div class="d-banner" style="margin-top:8px">${m.banner ? `<img src="${esc(m.banner)}" alt="" style="width:100%;height:100%;object-fit:cover;object-position:center;border-radius:4px" onerror="this.remove()" />` : 'Chưa có banner'}</div>
        ${showFooter ? `<div class="d-foot" style="margin-top:6px">${esc(m.footer)}</div>` : ''}</div>
      <div class="d-select"><span>${esc(m.placeholder || 'Chọn sản phẩm…')}</span>${I('chevronDown', 'sm')}</div></div></div>`;
  }

  function renderTicket() {
    const t = D().ticket || (D().ticket = {}); cv.scope = 'ticket';
    $('#subTabTicket').innerHTML = `<div class="card">
      <div class="editor-sec"><h4><span class="n">1</span>Panel mở ticket</h4><div class="grid-2">
        ${f('ctTitle', 'Tiêu đề', t.title, { k: 'title' })}${f('ctSub', 'Phụ đề', t.subtitle, { k: 'subtitle' })}
        ${lineList('lines', 'Các dòng mô tả', t.lines, 'Ví dụ: Mỗi ticket chỉ xử lý một đơn')}
        ${f('ctBtn', 'Nhãn nút mở ticket', t.buttonLabel, { k: 'buttonLabel' })}${f('ctPrefix', 'Tiền tố tên ticket', t.prefix, { k: 'prefix', mono: 1, hint: 'Ví dụ: ticket → #ticket-0123' })}
      </div></div>
      <div class="editor-sec"><h4><span class="n">2</span>Tin nhắn chào trong ticket</h4><div class="grid-2">
        ${f('ctWTitle', 'Welcome title', t.welcomeTitle, { k: 'welcomeTitle', hint: 'Dùng {user} để nhắc tên khách.' })}${f('ctWNote', 'Welcome note', t.welcomeNote, { k: 'welcomeNote' })}
        ${f('ctWMsg', 'Welcome message', t.welcomeMessage, { k: 'welcomeMessage', area: 1, span: 1 })}
      </div></div>
      <div class="editor-sec"><h4><span class="n">3</span>Hình ảnh & kênh</h4><div class="grid-2">
        ${media('thumbnail', 'Thumbnail', t.thumbnail, 'logo')}${media('banner', 'Banner', t.banner, 'banner')}${colorField('ctColor', 'color', t.color)}
        ${f('ctCh', 'Ticket channel ID', t.channelId, { k: 'channelId', mono: 1 })}${f('ctCat', 'Category chứa ticket', t.categoryId, { k: 'categoryId', mono: 1 })}
      </div></div></div>
      <aside class="prev-pane stack"><span class="label">Xem trước panel</span><div class="discord" id="cfgTicketPreview"></div><span class="label">Tin nhắn chào</span><div class="discord" id="cfgWelcomePreview"></div></aside>`;
    bindFields('#subTabTicket', t, renderTicketPreview, renderTicket); renderTicketPreview();
  }
  function renderTicketPreview() {
    const t = D().ticket || {}; const name = D().menu?.shopName || '4AM STORE';
    const head = `<span class="avatar">4AM</span><div style="flex:1;min-width:0"><div class="d-name">${esc(name)}<span class="d-bot">APP</span></div>`;
    const authorHead = (t.banner && t.thumbnail)
      ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><img src="${esc(t.thumbnail)}" alt="" style="width:20px;height:20px;border-radius:50%;object-fit:cover" onerror="this.remove()" /><span style="font-size:12px;font-weight:600;color:#DBDEE1">${esc(name)}</span></div>`
      : '';
    const sideThumb = (!t.banner && t.thumbnail)
      ? `<img src="${esc(t.thumbnail)}" alt="" style="width:56px;height:56px;border-radius:6px;object-fit:cover" onerror="this.remove()" />`
      : '';
    const formatBullet = (x) => {
      const s = String(x || '').trim();
      if (!s) return '';
      return s.startsWith('•') || s.startsWith('-') || s.startsWith('*') ? esc(s) : `• ${esc(s)}`;
    };
    const ticketLines = (t.lines || []).map(formatBullet).filter(Boolean).join('\n');
    $('#cfgTicketPreview').innerHTML = `<div class="d-msg">${head}<div class="d-embed" style="border-left-color:${esc(t.color || '#5865F2')}">${authorHead}<div class="row" style="align-items:flex-start"><div style="flex:1"><div class="t">${esc(t.title || '')}</div><div class="s">${esc(t.subtitle || '')}</div></div>${sideThumb}</div><div class="s" style="margin-top:6px">${ticketLines}</div>${t.banner ? `<img class="d-banner" src="${esc(t.banner)}" alt="" style="width:100%;aspect-ratio:16/6;object-fit:cover;object-position:center;border-radius:4px;margin-top:8px" onerror="this.remove()" />` : ''}</div><button class="d-btn" tabindex="-1">${I('receipt', 'sm')}${esc(t.buttonLabel || 'Mở ticket')}</button></div></div>`;
    $('#cfgWelcomePreview').innerHTML = `<div class="hint mono" style="color:#949BA4;margin-bottom:8px"># ${esc(t.prefix || 'ticket')}-0123</div><div class="d-msg">${head}<div class="d-embed" style="border-left-color:${esc(t.color || '#5865F2')}"><div class="t">${esc((t.welcomeTitle || '').replace('{user}', '@khach'))}</div><div class="s">${esc(t.welcomeMessage || '')}</div><div class="d-foot">${esc(t.welcomeNote || '')}</div></div></div></div>`;
  }

  function bindFields(root, obj, onChange, rerender) {
    $$(`${root} [data-k]`).forEach((el) => el.addEventListener('input', () => { obj[el.dataset.k] = el.value; const c = $(`${root} [data-colorfor="${el.id}"]`); if (c && /^#[0-9a-f]{6}$/i.test(el.value)) c.value = el.value; markDirty(); onChange(); }));
    $$(`${root} [data-colorfor]`).forEach((c) => c.addEventListener('input', () => { const t = $(`#${c.dataset.colorfor}`); t.value = c.value; t.dispatchEvent(new Event('input')); }));
    $$(`${root} [data-lines]`).forEach((list) => {
      const key = list.dataset.lines;
      $$('[data-line]', list).forEach((inp) => inp.addEventListener('input', () => { obj[key][Number(inp.dataset.line)] = inp.value; markDirty(); onChange(); }));
      $$('[data-delline]', list).forEach((b) => b.addEventListener('click', () => { obj[key].splice(Number(b.dataset.delline), 1); markDirty(); rerender(); $(`${root} [data-lines="${key}"] [data-line]`)?.focus(); }));
    });
    $$(`${root} [data-addline]`).forEach((b) => b.addEventListener('click', () => { const key = b.dataset.addline; (obj[key] = Array.isArray(obj[key]) ? obj[key] : []).push(''); markDirty(); rerender(); const inputs = $$(`${root} [data-lines="${key}"] [data-line]`); inputs[inputs.length - 1]?.focus(); }));
    $$(`${root} [data-pickmedia]`).forEach((b) => b.addEventListener('click', () => pickMedia(b.dataset.pickmedia, obj, rerender)));
    $$(`${root} [data-clearmedia]`).forEach((b) => b.addEventListener('click', () => { obj[b.dataset.clearmedia] = ''; markDirty(); rerender(); toast('Đã xóa ảnh', 'info'); }));
  }
  async function pickMedia(key, obj, rerender) {
    const url = await promptDialog({ title: key === 'banner' ? 'Chọn banner' : key === 'logo' ? 'Chọn logo' : 'Chọn thumbnail', message: 'Dán URL ảnh (https://…). Nên dùng link ảnh Discord CDN hoặc host ổn định.', value: obj[key] || '', placeholder: 'https://…', icon: 'image', confirmText: 'Dùng ảnh này' });
    if (url === null) return;
    if (url && !/^(https?:\/\/|\/)/.test(url)) { toast('URL ảnh phải bắt đầu bằng https:// hoặc /', 'error'); return; }
    obj[key] = url; markDirty(); rerender();
  }

  function switchTab(tab) {
    cv.tab = tab; $('#btnSubTabMenu').setAttribute('aria-selected', String(tab === 'menu')); $('#btnSubTabTicket').setAttribute('aria-selected', String(tab === 'ticket'));
    $('#subTabMenu').hidden = tab !== 'menu'; $('#subTabTicket').hidden = tab !== 'ticket';
  }
  function render() { if (!Store.data) return; if (cv.snapshot === null) { cv.snapshot = snap(); cv.published = cv.snapshot; } renderMenu(); renderTicket(); switchTab(cv.tab); if (!cv.busy) markDirty(); }

  async function run(btn, label, fn, after) {
    if (cv.busy) return; cv.busy = true; setStatus('', `${label}…`);
    await withLoading(btn, async () => {
      try { await fn(); after(); toast(`${label} thành công`); }
      catch (er) { setStatus('err', `${label} thất bại — ${er.message}`); toast(er.message, 'error'); }
    });
    cv.busy = false;
  }
  const time = () => new Date().toLocaleTimeString('vi-VN');
  const payload = () => ({ menu: D().menu, ticket: D().ticket, products: D().products, sellers: D().sellers });
  const saved = (msg) => () => { cv.snapshot = snap(); cv.dirty = false; setStatus('ok', `${msg} lúc ${time()}`); };

  function init() {
    $('#btnSubTabMenu').addEventListener('click', () => switchTab('menu'));
    $('#btnSubTabTicket').addEventListener('click', () => switchTab('ticket'));
    $$('#tabConfig .subtabs [role=tab]').forEach((b, i, all) => b.addEventListener('keydown', (e) => { if (['ArrowRight', 'ArrowLeft'].includes(e.key)) { const n = all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length]; n.focus(); n.click(); } }));
    const draft = () => API.saveDraft({ menu: D().menu, ticket: D().ticket }).then(() => { cv.snapshot = snap(); cv.dirty = false; cv.draftAt = new Date().toISOString(); Finance.log({ action: 'DISCORD_DRAFT_SAVED', targetId: 'config', before: null, after: { changes: diff(cv.published, cv.snapshot).length } }); });
    $('#btnCfgDraft')?.addEventListener('click', (e) => run(e.currentTarget, 'Lưu nháp', draft, () => setStatus('ok', `Đã lưu nháp lúc ${time()} · chưa đồng bộ Discord`)));
    $('#btnCfgDiff')?.addEventListener('click', showDiff);
    // Direct 1-click publishing without annoying reason modals
    async function sync(scope, btn) {
      const label = { menu: 'Đồng bộ Menu', ticket: 'Đồng bộ Ticket', all: 'Đồng bộ tất cả' }[scope];
      const ch = scope === 'ticket' ? [D().ticketChannelName || D().ticket?.channelId] : scope === 'menu' ? [D().menuChannelName || D().menu?.menuChannelId] : [D().menuChannelName || D().menu?.menuChannelId, D().ticketChannelName || D().ticket?.channelId];
      const n = diff(cv.published, snap()).length;
      if (ch.some((c) => !c)) { toast('Chưa cấu hình kênh Discord cho mục này.', 'error'); return; }
      run(btn, label, async () => {
        if (cv.dirty) await draft();
        const res = scope === 'menu' ? await API.sync() : scope === 'ticket' ? await API.syncTicket() : await API.saveAndSync(payload());
        if (res?.publish) Store.data.publish = res.publish;
        Finance.log({ action: 'DISCORD_SYNCED', targetId: scope, before: null, after: { scope, changes: n } });
      },
      () => {
        cv.snapshot = snap();
        cv.published = cv.snapshot;
        cv.dirty = false;
        setStatus('ok', `${label} lúc ${time()}`);
        renderPanel();
      });
    }
    $('#btnSyncMenu')?.addEventListener('click', (e) => sync('menu', e.currentTarget));
    $('#btnSyncTicket')?.addEventListener('click', (e) => sync('ticket', e.currentTarget));
    $('#btnGlobalSync')?.addEventListener('click', (e) => sync('all', e.currentTarget));
    $('#btnCfgRestore')?.addEventListener('click', async () => {
      if (!cv.dirty || !(await confirmDialog({ title: 'Khôi phục thay đổi?', message: `Các chỉnh sửa chưa lưu ở Menu và Ticket sẽ bị bỏ, quay về bản nháp lưu lúc ${when(cv.draftAt) === '—' ? 'mở trang' : when(cv.draftAt)}.`, confirmText: 'Khôi phục', tone: 'danger', icon: 'rotate' }))) return;
      const s = JSON.parse(cv.snapshot); Store.data.menu = s.menu; Store.data.ticket = s.ticket; cv.dirty = false; render(); toast('Đã khôi phục', 'info');
    });
    window.addEventListener('beforeunload', (e) => { if (cv.dirty) { e.preventDefault(); e.returnValue = ''; } });
    window.syncAllDiscord = (btn) => sync('all', btn || $('#btnGlobalSync') || $('#btnProdSync') || $('#btnHeaderSync'));
  }
  window.DiscordConfig = { init, render };
  window.saveAndSync = () => window.syncAllDiscord?.() || $('#btnGlobalSync')?.click();
})();
