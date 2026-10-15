/* Auto Response UI manager: List, add, edit, and delete keyword auto responses. */
(function () {
  const { $, $$, esc, I, badge, toast, openModal, closeModal, confirmDialog, withLoading } = UI;

  let state = {
    list: [],
    loading: false
  };

  async function loadData() {
    state.loading = true;
    try {
      const data = await API.autoResponses();
      state.list = Array.isArray(data) ? data : [];
    } catch (e) {
      toast(e.message || 'Lỗi khi tải danh sách tự động trả lời.', 'error');
    } finally {
      state.loading = false;
    }
  }

  function renderTable() {
    const tbody = $('#autoResponseTableBody');
    const emptyBox = $('#autoResponseEmpty');
    const table = $('#autoResponseTable');
    if (!tbody) return;

    if (!state.list.length) {
      tbody.innerHTML = '';
      if (emptyBox) emptyBox.classList.remove('hidden');
      if (table) table.classList.add('hidden');
      return;
    }

    if (emptyBox) emptyBox.classList.add('hidden');
    if (table) table.classList.remove('hidden');

    tbody.innerHTML = state.list.map((item, idx) => {
      const isExact = (item.matchType || 'exact').toLowerCase() === 'exact';
      const typeBadge = badge(isExact ? 'info' : 'warning', '', isExact ? 'Khớp chính xác' : 'Có chứa');
      
      const imgHtml = item.imageUrl ? `
        <a href="${esc(item.imageUrl)}" target="_blank" rel="noreferrer" style="display:inline-flex;align-items:center;gap:6px;text-decoration:none;color:var(--brand)">
          <img src="${esc(item.imageUrl)}" alt="" style="width:34px;height:34px;object-fit:cover;border-radius:4px;border:1px solid var(--border-default)" onerror="this.style.display='none'" />
          <span style="font-size:12px">Xem ảnh</span>
        </a>
      ` : '<span class="muted">—</span>';

      return `
        <tr>
          <td>
            <span style="font-size:13px;font-weight:600;color:var(--text-primary);background:var(--surface-3);padding:3px 9px;border-radius:6px;border:1px solid var(--border-subtle);display:inline-block">${esc(item.trigger)}</span>
          </td>
          <td>${typeBadge}</td>
          <td>
            <div style="max-width:340px;line-height:1.4">
              <span style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word" title="${esc(item.response || '')}">
                ${item.response ? esc(item.response) : '<span class="muted">*(Chỉ gửi hình ảnh)*</span>'}
              </span>
            </div>
          </td>
          <td>${imgHtml}</td>
          <td style="text-align:right">
            <div class="row" style="justify-content:flex-end;gap:6px">
              <button type="button" class="btn btn-sm btn-ghost" data-edit-ar="${esc(item.id || item.trigger)}" title="Chỉnh sửa">
                ${I('edit', 'sm')}<span>Sửa</span>
              </button>
              <button type="button" class="btn btn-sm btn-ghost btn-icon text-danger" data-del-ar="${esc(item.id || item.trigger)}" data-trigger="${esc(item.trigger)}" title="Xóa" aria-label="Xóa">
                ${I('trash', 'sm')}
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    // Bind action buttons
    $$('[data-edit-ar]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.editAr;
        const item = state.list.find(x => (x.id || x.trigger) === id);
        if (item) openEditor(item);
      });
    });

    $$('[data-del-ar]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.delAr;
        const trigger = btn.dataset.trigger || id;
        const ok = await confirmDialog({
          title: 'Xóa phản hồi tự động?',
          message: `Bạn có chắc muốn xóa phản hồi tự động cho từ khóa "${trigger}" không?`,
          confirmText: 'Xóa ngay',
          tone: 'danger',
          icon: 'trash'
        });
        if (!ok) return;

        try {
          await API.deleteAutoResponse(id);
          toast(`Đã xóa phản hồi tự động "${trigger}" thành công.`);
          await render();
        } catch (e) {
          toast(e.message || 'Lỗi khi xóa phản hồi tự động.', 'error');
        }
      });
    });
  }

  function openEditor(item = null) {
    const isEdit = !!item;
    $('#autoResponseModalTitle').textContent = isEdit ? 'Sửa phản hồi tự động' : 'Thêm phản hồi tự động';
    $('#arId').value = item ? (item.id || '') : '';
    $('#arTrigger').value = item ? item.trigger : '';
    $('#arMatchType').value = item ? (item.matchType || 'exact') : 'exact';
    $('#arResponse').value = item ? (item.response || '') : '';
    $('#arImageUrl').value = item ? (item.imageUrl || '') : '';

    updateImagePreview(item ? item.imageUrl : '');
    openModal('autoResponseModal', { focus: '#arTrigger' });
  }

  function updateImagePreview(url) {
    const box = $('#arPreviewBox');
    const img = $('#arPreviewImg');
    const cleanUrl = String(url || '').trim();
    if (cleanUrl && /^https?:\/\//i.test(cleanUrl)) {
      img.src = cleanUrl;
      box.classList.remove('hidden');
    } else {
      img.src = '';
      box.classList.add('hidden');
    }
  }

  function initEvents() {
    $('#btnOpenAddAutoResponse')?.addEventListener('click', () => {
      openEditor(null);
    });

    $('#arImageUrl')?.addEventListener('input', (e) => {
      updateImagePreview(e.target.value);
    });

    $('#autoResponseForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = $('#arId').value.trim();
      const trigger = $('#arTrigger').value.trim();
      const matchType = $('#arMatchType').value;
      const response = $('#arResponse').value.trim();
      const imageUrl = $('#arImageUrl').value.trim();

      if (!trigger) {
        toast('Vui lòng nhập từ khóa kích hoạt (Trigger).', 'error');
        $('#arTrigger').focus();
        return;
      }

      if (!response && !imageUrl) {
        toast('Vui lòng nhập nội dung văn bản hoặc link hình ảnh để bot phản hồi.', 'error');
        $('#arResponse').focus();
        return;
      }

      await withLoading($('#btnSaveAutoResponse'), async () => {
        try {
          await API.saveAutoResponse({
            id: id || undefined,
            trigger,
            matchType,
            response,
            imageUrl,
            replyMode: 'reply'
          });

          toast(id ? `Đã cập nhật phản hồi "${trigger}".` : `Đã thêm phản hồi tự động "${trigger}".`);
          closeModal('autoResponseModal');
          await render();
        } catch (err) {
          toast(err.message || 'Lỗi khi lưu phản hồi tự động.', 'error');
        }
      });
    });
  }

  async function render() {
    await loadData();
    renderTable();
  }

  // Khởi tạo sự kiện khi load script
  document.addEventListener('DOMContentLoaded', initEvents);
  if (document.readyState !== 'loading') {
    initEvents();
  }

  window.AutoResponseUI = {
    render,
    openEditor
  };
})();
