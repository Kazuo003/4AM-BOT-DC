/* UI primitives: formatting, escaping, toast, modal (focus trap), confirm/prompt, states */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const I = (n, c) => Icons.svg(n, c);

  const vnd = (n) => `${new Intl.NumberFormat('vi-VN').format(Math.round(Number(n) || 0))} VNĐ`;
  const num = (n) => new Intl.NumberFormat('vi-VN').format(Number(n) || 0);
  const dt = (v) => { if (!v) return '—'; const d = new Date(v); return isNaN(d) ? '—' : d.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' }); };
  const dShort = (v) => { if (!v) return '—'; const d = new Date(v); return isNaN(d) ? '—' : d.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }); };
  const shortId = (id) => { const s = String(id || ''); return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s || '—'; };
  const maskAcc = (a) => { const s = String(a || ''); return s ? `•••• ${s.slice(-4)}` : '—'; };
  const initials = (n) => String(n || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const avatar = (url, name, cls = '') => url ? `<img class="avatar ${cls}" src="${esc(url)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'avatar ${cls}',textContent:'${esc(initials(name))}'}))" />` : `<span class="avatar ${cls}" aria-hidden="true">${esc(initials(name))}</span>`;
  const badge = (kind, icon, text) => `<span class="badge b-${kind}">${icon ? I(icon) : ''}${esc(text)}</span>`;
  const emojiHtml = (em, size = 20) => {
    if (!em) return '•';
    const match = String(em).trim().match(/^<(a)?:([a-zA-Z0-9_]+):(\d+)>$/);
    if (match) {
      const isAnim = !!match[1];
      const name = match[2];
      const id = match[3];
      const ext = isAnim ? 'gif' : 'png';
      const url = `https://cdn.discordapp.com/emojis/${id}.${ext}?size=64`;
      return `<img class="emoji-img" src="${esc(url)}" alt="${esc(name)}" title="${esc(name)}" style="width:${size}px;height:${size}px;vertical-align:middle;object-fit:contain;display:inline-block" onerror="this.outerHTML='•'" />`;
    }
    return esc(em);
  };

  // ---- Toast
  let toastTimer;
  function toast(msg, kind = 'success') {
    const t = $('#toast');
    $('#toastMsg').textContent = msg;
    $('#toastIcon').innerHTML = I(kind === 'error' ? 'alert' : kind === 'info' ? 'bell' : 'checkCircle');
    t.dataset.kind = kind; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  // ---- Overlay manager. One primary modal at a time; small confirmations/forms render as a step INSIDE it.
  // Stack entries: { m, kind: 'primary'|'dialog'|'step', ret, onClose, close? }. Only the top entry gets Esc/Tab.
  // z-index: primary 60 · standalone dialog 80 (backdrop) / 81 (panel) · menu 90 · toast 100.
  const stack = [];
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  const BG = ['#app', '#loginScreen'];
  let scrollY = 0, locked = false;
  function sync() {
    const on = stack.length > 0;
    if (on && !locked) { scrollY = window.scrollY; Object.assign(document.body.style, { position: 'fixed', top: `-${scrollY}px`, left: '0', right: '0', overflow: 'hidden' }); locked = true; }
    if (!on && locked) { Object.assign(document.body.style, { position: '', top: '', left: '', right: '', overflow: '' }); window.scrollTo(0, scrollY); locked = false; }
    BG.forEach((s) => { const el = $(s); if (!el) return; if (on) { el.setAttribute('inert', ''); el.setAttribute('aria-hidden', 'true'); } else { el.removeAttribute('inert'); el.removeAttribute('aria-hidden'); } });
  }
  const focusIn = (m, sel) => requestAnimationFrame(() => { const f = sel ? $$(sel, m).find((el) => el.matches(FOCUSABLE) && el.offsetParent !== null) : $$(FOCUSABLE, m).find((el) => !el.closest('[hidden]') && !el.hasAttribute('data-close')); (f || m).focus?.(); });
  const isPrimary = (m) => !m.classList.contains('dialog-layer');
  function setBack(m, back) {
    $('.modal-crumb', m)?.remove(); if (!back) return;
    const bar = document.createElement('div'); bar.className = 'modal-crumb';
    bar.innerHTML = `<button type="button" class="btn btn-ghost btn-sm">${I('chevronLeft', 'sm')}${esc(back.label)}</button>${back.crumb ? `<nav aria-label="Vị trí" class="crumb">${back.crumb.map((c) => `<span>${esc(c)}</span>`).join('<span aria-hidden="true">/</span>')}</nav>` : ''}`;
    $('button', bar).addEventListener('click', () => back.onClick());
    $('.modal-panel', m).prepend(bar);
  }
  function openModal(id, opts = {}) {
    const m = typeof id === 'string' ? document.getElementById(id) : id; if (!m) return;
    closeMenu();
    let ret = document.activeElement;
    if (isPrimary(m)) {
      // Swap: close every other primary (and its steps) without unlocking scroll; inherit the original trigger.
      for (let i = stack.length - 1; i >= 0; i--) { const s = stack[i]; if (s.kind === 'step') { s.close(null, true); continue; } if (s.kind === 'primary') { stack.splice(i, 1); if (s.m !== m) s.m.hidden = true; ret = s.ret; s.onClose?.(); } }
    } else if (stack.some((s) => s.m === m)) return;
    setBack(m, opts.back);
    stack.push({ m, kind: isPrimary(m) ? 'primary' : 'dialog', ret, onClose: opts.onClose });
    m.hidden = false; sync(); focusIn(m, opts.focus);
  }
  function closeModal(id) {
    const key = id && (typeof id === 'string' ? id : id.id);
    let idx = key ? stack.findIndex((s) => s.m.id === key && s.kind !== 'step') : stack.length - 1;
    if (idx < 0) return;
    if (stack[idx].kind === 'step') return stack[idx].close(null);
    for (let i = stack.length - 1; i > idx; i--) if (stack[i].kind === 'step' && stack[i].m === stack[idx].m) { stack[i].close(null, true); idx = Math.min(idx, stack.length - 1); }
    const [s] = stack.splice(idx, 1); closeMenu();
    s.m.hidden = true; if (s.kind === 'dialog' && s.m.dataset.temp) s.m.remove();
    sync(); s.onClose?.(); if (s.ret?.isConnected) s.ret.focus?.();
  }
  document.addEventListener('keydown', (e) => {
    const top = stack[stack.length - 1]; if (!top) return;
    if (e.key === 'Escape') { e.preventDefault(); top.kind === 'step' ? top.close(null) : closeModal(top.m.id); return; }
    if (e.key === 'Tab') {
      const f = $$(FOCUSABLE, top.m).filter((el) => el.offsetParent !== null); if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (!top.m.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  const shake = (m) => $('.modal-panel', m)?.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(1.015)' }, { transform: 'scale(1)' }], { duration: 180 });
  // Backdrop never closes destructive dialogs or an active step — only explicit buttons / Esc do.
  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-close]'); if (!c) return; const m = c.closest('.modal,.drawer'); if (!m) return;
    const top = stack[stack.length - 1];
    if (c.classList.contains('modal-backdrop') && (m.dataset.static === '1' || (top && top.kind === 'step' && top.m === m))) { shake(m); return; }
    closeModal(m.id);
  });

  // ---- Step host: renders a confirmation/form inside the open primary modal, or as a standalone dialog when none is open.
  function mountStep({ html, alert = false, labelId }) {
    closeMenu();
    const ret = document.activeElement;
    const host = [...stack].reverse().find((s) => s.kind === 'primary' && !s.m.hidden);
    if (host && stack[stack.length - 1].m === host.m) {
      const m = host.m, panel = $('.modal-panel', m);
      const saved = document.createDocumentFragment(); while (panel.firstChild) saved.appendChild(panel.firstChild);
      const attrs = { role: m.getAttribute('role'), lbl: m.getAttribute('aria-labelledby') };
      const root = document.createElement('div'); root.className = 'step-view'; root.innerHTML = html; panel.appendChild(root);
      m.setAttribute('role', alert ? 'alertdialog' : 'dialog'); m.setAttribute('aria-labelledby', labelId);
      const entry = { m, kind: 'step', back: m.dataset.backLabel || 'Quay lại' };
      entry.close = (v, silent) => { const i = stack.indexOf(entry); if (i < 0) return; stack.splice(i, 1); root.remove(); panel.appendChild(saved); m.setAttribute('role', attrs.role); m.setAttribute('aria-labelledby', attrs.lbl); entry.onDone?.(v); if (!silent && ret?.isConnected) ret.focus(); };
      stack.push(entry); focusIn(m, entry.focus);
      return { root, entry, inline: true };
    }
    const m = document.createElement('div'); m.className = 'modal dialog-layer'; m.id = `dlg${Date.now()}`; m.dataset.temp = '1'; m.dataset.static = '1';
    m.setAttribute('role', alert ? 'alertdialog' : 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', labelId);
    m.innerHTML = `<div class="modal-backdrop" data-close></div><div class="modal-panel sheet-sm" style="max-width:480px"><div class="step-view">${html}</div></div>`;
    document.body.appendChild(m);
    const entry = { m, kind: 'step', back: 'Hủy' };
    entry.close = (v, silent) => { const i = stack.indexOf(entry); if (i < 0) return; stack.splice(i, 1); m.remove(); sync(); entry.onDone?.(v); if (!silent && ret?.isConnected) ret.focus(); };
    stack.push(entry); sync(); focusIn(m);
    return { root: $('.step-view', m), entry, inline: false };
  }
  // Shared dialog: title, message, optional warning/extra/fields; resolves value or null. Never closes on backdrop click.
  function stepDialog({ title, message = '', warning = '', confirmText, tone = 'brand', icon = 'help', extra = '', fields = '', alert, valid = () => true, value = () => true, twoStep = false, onMount }) {
    return new Promise((resolve) => {
      const lid = `stepTitle${Date.now()}`;
      const danger = tone === 'danger', warn = tone === 'warning';
      const needsBody = !!(warning || extra || fields || twoStep);
      const host = mountStep({ alert: alert ?? (danger || warn), labelId: lid, html: `
        <div class="modal-head"><span class="modal-ic ${danger ? 'danger' : warn ? 'warning' : ''}">${I(icon)}</span><div style="flex:1;min-width:0"><h2 id="${lid}">${esc(title)}</h2>${message ? `<p>${esc(message)}</p>` : ''}</div></div>
        ${needsBody ? `<div class="modal-body stack">
          ${warning ? `<div class="alert alert-${danger ? 'danger' : 'warning'}">${I('alert')}<span>${esc(warning)}</span></div>` : ''}
          ${extra}${fields}<span class="hint err-text" data-err role="alert"></span>
        </div>` : ''}
        <div class="modal-foot"><button type="button" class="btn btn-ghost" data-back>${I('chevronLeft', 'sm')}<span></span></button><button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(confirmText)}</button></div>` });
      const { root, entry } = host;
      $('[data-back] span', root).textContent = entry.back;
      const ok = $('[data-ok]', root), errEl = $('[data-err]', root);
      let armed = false;
      const upd = () => { ok.disabled = !valid(root); if (armed && ok.disabled) { armed = false; ok.textContent = confirmText; } };
      root.addEventListener('input', upd); root.addEventListener('change', upd); upd();
      entry.onDone = resolve;
      $('[data-back]', root).onclick = () => entry.close(null);
      const submit = () => {
        if (!valid(root)) { if (errEl) errEl.textContent = 'Hoàn tất các bước xác nhận.'; return; }
        if (twoStep && !armed) { armed = true; ok.textContent = 'Nhấn lần nữa để xác nhận'; if (errEl) errEl.textContent = 'Bước 2/2: kiểm tra lại thông tin rồi nhấn xác nhận.'; ok.focus(); return; }
        entry.close(value(root));
      };
      ok.onclick = submit;
      root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') { e.preventDefault(); submit(); } });
      onMount?.(root, upd);
      entry.focus = '[data-autofocus]'; requestAnimationFrame(() => ($('[data-autofocus]', root) || $('[data-back]', root)).focus());
    });
  }
  function confirmDialog({ title, message, confirmText = 'Xác nhận', tone = 'brand', icon = 'help', extra = '' }) {
    return stepDialog({ title, message, confirmText, tone, icon, extra }).then((v) => v === true);
  }
  // suggest(query) -> html of results; elements with [data-pick] fill the input.
  function promptDialog({ title, message = '', value = '', placeholder = '', confirmText = 'Lưu', icon = 'edit', type = 'text', label = '', suggest }) {
    return stepDialog({ title, message, confirmText, icon, alert: false,
      fields: `<div class="field">${label ? `<label for="stepInput">${esc(label)}</label>` : ''}<input class="input" id="stepInput" data-autofocus type="${esc(type)}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" ${label ? '' : `aria-label="${esc(title)}"`} /></div>${suggest ? '<div data-suggest class="suggest-list" aria-live="polite"></div>' : ''}`,
      valid: (r) => !!$('#stepInput', r).value.trim(), value: (r) => $('#stepInput', r).value.trim(),
      onMount: (r, upd) => { if (!suggest) return; const inp = $('#stepInput', r), box = $('[data-suggest]', r); const draw = () => { box.innerHTML = suggest(inp.value.trim()); }; inp.addEventListener('input', draw); box.addEventListener('click', (e) => { const p = e.target.closest('[data-pick]'); if (p) { inp.value = p.dataset.pick; draw(); upd(); inp.focus(); } }); draw(); } });
  }
  // Reason dialog: required reason, optional warning, acknowledgement checkbox, type-to-confirm and two-step confirm.
  function reasonDialog({ title, message = '', warning = '', confirmText = 'Xác nhận', tone = 'warning', icon = 'alert', ack = '', typeText = '', twoStep = false, reasonLabel = 'Lý do (bắt buộc, lưu vào audit log)', reasonRequired = true, extra = '' }) {
    return stepDialog({ title, message, warning, confirmText, tone, icon, extra, twoStep, alert: true,
      fields: `<div class="field"><label for="reasonInput">${esc(reasonLabel)}</label><textarea class="textarea" id="reasonInput" data-autofocus rows="3" placeholder="Ví dụ: Đã kiểm tra sao kê ngân hàng lúc 14:20…" ${reasonRequired ? 'aria-required="true"' : ''}></textarea><span class="hint">${reasonRequired ? 'Tối thiểu 5 ký tự.' : ''}</span></div>
        ${typeText ? `<div class="field"><label for="reasonType">Gõ <b class="mono">${esc(typeText)}</b> để xác nhận</label><input class="input mono" id="reasonType" autocomplete="off" /></div>` : ''}
        ${ack ? `<label class="check"><input type="checkbox" id="reasonAck" /><span><strong>${esc(ack)}</strong></span></label>` : ''}`,
      valid: (r) => (!reasonRequired || $('#reasonInput', r).value.trim().length >= 5) && (!typeText || $('#reasonType', r).value.trim() === typeText) && (!$('#reasonAck', r) || $('#reasonAck', r).checked),
      value: (r) => $('#reasonInput', r).value.trim() || '—' });
  }
  const activeDialogs = () => stack.filter((s) => s.kind !== 'step' || !s.m.classList.contains('modal')).length;

  // ---- Button loading
  async function withLoading(btn, fn) {
    if (!btn) return fn(); const html = btn.innerHTML; btn.disabled = true; btn.setAttribute('aria-busy', 'true');
    btn.innerHTML = `<span class="spin" aria-hidden="true"></span>${esc(btn.textContent.trim())}`;
    try { return await fn(); } finally { btn.disabled = false; btn.removeAttribute('aria-busy'); btn.innerHTML = html; }
  }

  // ---- States
  const state = {
    empty: (title, text, action = '') => `<div class="state"><span class="ic">${I('box')}</span><h3>${esc(title)}</h3><p>${esc(text)}</p>${action}</div>`,
    error: (text, retryId) => `<div class="state err"><span class="ic">${I('cloudOff')}</span><h3>Không tải được dữ liệu</h3><p>${esc(text || 'Kiểm tra kết nối rồi thử lại.')}</p>${retryId ? `<button class="btn" id="${retryId}">${I('refresh')}Thử lại</button>` : ''}</div>`,
    denied: () => `<div class="state denied"><span class="ic">${I('lock')}</span><h3>Không đủ quyền</h3><p>Tài khoản của bạn không được phép thực hiện thao tác này.</p></div>`,
    skeletonRows: (cols, rows = 6) => Array.from({ length: rows }, () => `<tr>${Array.from({ length: cols }, (_, i) => `<td><div class="skel" style="width:${50 + ((i * 37) % 45)}%"></div></td>`).join('')}</tr>`).join(''),
    skeletonBlock: (n = 3) => `<div class="card-pad stack">${Array.from({ length: n }, (_, i) => `<div class="skel" style="width:${90 - i * 18}%"></div>`).join('')}</div>`,
  };

  async function copy(text, label = 'Đã sao chép') { try { await navigator.clipboard.writeText(String(text)); toast(label); } catch { toast('Không sao chép được', 'error'); } }
  const debounce = (fn, ms = 600) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ---- Action menu (popover). items: [{label, icon, tone, onClick}] or '-' for divider
  let menuAnchor = null;
  function closeMenu() { const m = $('#actionMenu'); if (!m || m.classList.contains('hidden')) return; m.classList.add('hidden'); menuAnchor?.setAttribute('aria-expanded', 'false'); menuAnchor?.focus(); menuAnchor = null; }
  function menu(anchor, items) {
    const m = $('#actionMenu'); if (menuAnchor === anchor) { closeMenu(); return; }
    closeMenu(); menuAnchor = anchor; anchor.setAttribute('aria-expanded', 'true');
    const acts = items.filter((x) => x && x !== '-');
    m.innerHTML = items.filter(Boolean).map((it, i) => it === '-' ? '<hr />' : `<button role="menuitem" class="${it.tone || ''}" data-mi="${acts.indexOf(it)}">${I(it.icon || 'chevronRight', 'sm')}${esc(it.label)}</button>`).join('').replace(/^<hr \/>|<hr \/>$/g, '');
    m.classList.remove('hidden');
    const r = anchor.getBoundingClientRect(); const h = m.offsetHeight, w = m.offsetWidth;
    m.style.top = `${r.bottom + 6 + h > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
    m.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
    $$('button', m).forEach((b) => b.addEventListener('click', () => { const it = acts[Number(b.dataset.mi)]; closeMenu(); it.onClick?.(); }));
    $('button', m)?.focus();
  }
  document.addEventListener('mousedown', (e) => { const m = $('#actionMenu'); if (m && !m.contains(e.target) && !menuAnchor?.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', (e) => {
    const m = $('#actionMenu'); if (!m || m.classList.contains('hidden')) return;
    if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); }
    if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); const bs = $$('button', m); const i = bs.indexOf(document.activeElement); bs[(i + (e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length].focus(); }
  }, true);
  window.addEventListener('scroll', closeMenu, true);

  window.UI = { activeDialogs, menu, closeMenu, $, $$, esc, I, vnd, num, dt, dShort, shortId, maskAcc, initials, avatar, badge, emojiHtml, toast, openModal, closeModal, confirmDialog, promptDialog, reasonDialog, withLoading, state, copy, debounce };
  // Legacy adapters (old inline handlers may call these)
  window.showToast = toast; window.showConfirm = confirmDialog; window.showPrompt = promptDialog;
})();
