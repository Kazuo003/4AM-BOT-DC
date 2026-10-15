/* Business rules — single source of truth for order workflow, payment status and seller permissions. Pure, no DOM.
   orderStatus  : PURCHASED | PROCESSING | CANCELLED
   paymentStatus: UNPAID | PAID (independent of orderStatus) */
(function (root) {
  const ORDER_STATUSES = ['PROCESSING', 'COMPLETED', 'CANCELLED'];
  const PAYMENT_STATUSES = ['UNPAID', 'PAID'];

  // Order transitions. kind:'payment' actions change paymentStatus instead of / in addition to orderStatus.
  const ACTIONS = {
    manualApprove: { label: 'Đánh dấu đã thanh toán', icon: 'wallet', from: ['PROCESSING'], to: 'PROCESSING', pay: 'PAID', seller: false, tone: 'warning' },
    complete: { label: 'Hoàn tất đơn', icon: 'checkCircle', from: ['PROCESSING'], to: 'COMPLETED', needPay: ['PAID'], seller: true, perm: 'orders.complete_own', tone: 'brand' },
    cancel: { label: 'Hủy đơn', icon: 'ban', from: ['PROCESSING'], to: 'CANCELLED', seller: false, tone: 'danger' },
  };
  const PRIMARY = { PROCESSING: 'complete' };

  const PERMISSIONS = {
    'orders.read': { label: 'Xem đơn được giao', desc: 'Xem danh sách và chi tiết các đơn được giao cho mình.', locked: true },
    'orders.complete_own': { label: 'Xử lý đơn được giao', desc: 'Hoàn tất đơn đã thanh toán được giao cho mình.', sensitive: 'Seller có thể chuyển đơn đã thanh toán sang Hoàn tất.' },
    'orders.edit': { label: 'Cập nhật ghi chú', desc: 'Sửa ghi chú nội bộ của đơn được giao. Không sửa được giá hay trạng thái.' },
    'products.edit': { label: 'Chỉnh sửa sản phẩm', desc: 'Sửa nội dung, bảng giá của danh mục mình phụ trách.', sensitive: 'Thay đổi giá sẽ hiển thị cho khách sau lần đồng bộ Discord tiếp theo.' },
    'autoresponse': { label: 'Tự động trả lời', desc: 'Cài đặt và quản lý tin nhắn tự động phản hồi cho shop.' },
  };

  // Transaction status → reconciliation group. Reasons are details, not top-level states.
  const TX_GROUP = {
    MATCHED: 'matched', SUCCESS: 'matched', PAID: 'matched',
    AMOUNT_MISMATCH: 'review', ORDER_ALREADY_PAID: 'review', UNKNOWN_ORDER_CODE: 'review', ORDER_NOT_FOUND: 'review',
    UNAUTHORIZED_RECEIVER_ACCOUNT: 'config', MISSING_RECEIVING_ACCOUNT: 'config', PAYMENT_CONFIG_ERROR: 'config',
  };
  const txGroup = (s) => TX_GROUP[s] || 'review';

  const isAdmin = (u) => !!u && (u.role === 'admin' || u.role === 'owner');
  const isAssigned = (o, u) => !!u && !!u.sellerId && String(o.sellerId) === String(u.sellerId);
  const has = (u, p) => (u?.permissions || []).includes(p);

  function canRun(id, order, user) {
    const a = ACTIONS[id]; if (!a || !order || !user) return false;
    if (!a.from.includes(order.status)) return false;
    if (a.needPay && !a.needPay.includes(order.paymentStatus)) return false;
    if (id === 'manualApprove' && order.paymentStatus === 'PAID') return false;
    if (id === 'cancel' && order.status === 'CANCELLED') return false;
    if (isAdmin(user)) return true;
    if (!a.seller || !isAssigned(order, user)) return false;
    return !a.perm || has(user, a.perm);
  }
  const allowedActions = (order, user) => Object.keys(ACTIONS).filter((id) => canRun(id, order, user));
  // Unpaid processing orders expose the payment check to the owner.
  function primaryAction(order, user) {
    if (order?.status === 'PROCESSING' && order.paymentStatus !== 'PAID') return isAdmin(user) ? 'checkPayment' : null;
    const id = PRIMARY[order?.status]; return id && canRun(id, order, user) ? id : null;
  }
  const canEditNotes = (order, user) => isAdmin(user) || (isAssigned(order, user) && has(user, 'orders.edit'));
  const canSeeOrder = (order, user) => isAdmin(user) || (isAssigned(order, user) && has(user, 'orders.read'));
  const canEditMoney = (user) => isAdmin(user);
  const canArchive = (user) => isAdmin(user);

  // Convert legacy order states to the 3-state model: PROCESSING | COMPLETED | CANCELLED
  function migrateOrder(o) {
    const n = { ...o };
    const paidLegacy = ['PAID', 'DELIVERED', 'COMPLETED', 'REFUND_PENDING', 'REFUNDED'].includes(o.status)
      || ['PAID', 'REFUND_PENDING', 'REFUNDED'].includes(o.paymentStatus);
    const st = String(o.status || '').toUpperCase();
    if (['COMPLETED', 'DELIVERED', 'DONE'].includes(st)) {
      n.status = 'COMPLETED';
    } else if (['CANCELLED', 'FAILED', 'REFUNDED', 'REFUND_PENDING', 'REJECTED'].includes(st)) {
      n.status = 'CANCELLED';
    } else {
      n.status = 'PROCESSING';
    }
    n.paymentStatus = (o.paymentStatus === 'PAID' || paidLegacy) ? 'PAID' : 'UNPAID';
    return n;
  }
  const migrateTx = (t) => {
    if (['UNDERPAID', 'OVERPAID'].includes(t.status)) return { ...t, status: 'AMOUNT_MISMATCH' };
    if (t.status === 'SUCCESS' || t.status === 'PAID') return { ...t, status: t.expectedAmount != null && Number(t.amount) !== Number(t.expectedAmount) ? 'AMOUNT_MISMATCH' : 'MATCHED' };
    return t;
  };

  const validMatch = (t) => (t.status === 'MATCHED' || t.status === 'SUCCESS' || t.status === 'PAID') && t.orderId != null && Number(t.amount) === Number(t.expectedAmount);

  // Make orders consistent with their transactions. Mutates tx.handled (matched / superseded tx become handled).
  //  - valid MATCHED tx ⇒ paymentStatus PAID; order status stays independent
  //  - every non-matching transaction leaves paymentStatus UNPAID
  //  - config-error tx ⇒ order untouched
  function reconcile(orders, txs) {
    const list = (txs || []).map(migrateTx);
    return orders.map((raw) => {
      const o = migrateOrder(raw);
      const linked = list.filter((t) => t.orderId != null && String(t.orderId) === String(o.id));
      const ok = linked.filter(validMatch).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
      if (ok) {
        // Auto-handle once; an admin may later reopen it as an exception without it snapping back.
        if (!ok.autoHandled) { ok.handled = true; ok.autoHandled = true; }
        linked.filter((t) => txGroup(t.status) === 'review' && !t.autoHandled && new Date(t.createdAt) < new Date(ok.createdAt)).forEach((t) => { t.handled = true; t.autoHandled = true; });
        o.paymentStatus = 'PAID'; o.transactionId = ok.transactionId; o.provider = ok.provider || o.provider;
        return o;
      }
      if (o.provider === 'MANUAL' && o.paymentStatus === 'PAID') return o;
      if (o.status === 'PROCESSING' && o.paymentStatus !== 'PAID') {
        if (!linked.length && o.provider !== 'MANUAL') { o.transactionId = ''; o.provider = ''; }
      }
      return o;
    });
  }

  function txReason(t, order, fmt = (n) => `${n}`) {
    switch (t.status) {
      case 'MATCHED': return 'Khớp mã đơn, đủ số tiền, đúng tài khoản nhận.';
      case 'AMOUNT_MISMATCH': return `Số tiền giao dịch không khớp với đơn ${t.orderCode || ''}; đơn vẫn chưa thanh toán.`;
      case 'ORDER_ALREADY_PAID': return `Đơn ${t.orderCode || ''} đã được thanh toán trước đó — có thể khách chuyển trùng.`;
      case 'UNKNOWN_ORDER_CODE': return `Nội dung chuyển khoản “${t.description || ''}” không chứa mã đơn hợp lệ.`;
      case 'ORDER_NOT_FOUND': return `Có mã “${t.orderCode || ''}” nhưng không tìm thấy đơn tương ứng.`;
      case 'UNAUTHORIZED_RECEIVER_ACCOUNT': return `Tiền vào tài khoản ${t.receiverAccount || ''} không thuộc seller của đơn.`;
      case 'MISSING_RECEIVING_ACCOUNT': return 'Seller chưa có tài khoản nhận tiền nên không đối chiếu được.';
      case 'PAYMENT_CONFIG_ERROR': return 'Cấu hình cổng thanh toán lỗi (sai khóa webhook hoặc tài khoản).';
      default: return '';
    }
  }

  const api = { ORDER_STATUSES, PAYMENT_STATUSES, ACTIONS, PRIMARY, PERMISSIONS, TX_GROUP, txGroup, canRun, allowedActions, primaryAction, canEditNotes, canSeeOrder, canEditMoney, canArchive, migrateOrder, migrateTx, reconcile, txReason };
  root.OrderRules = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
