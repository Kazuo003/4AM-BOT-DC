# 4AM STORE Control Panel — Hướng dẫn tích hợp

## 1. Vị trí trong project Express

UI mới đã thay thế hoàn toàn dashboard cũ, nằm trực tiếp trong `public/` và được truy cập tại `/`.

- `public/index.html`: khung giao diện.
- `public/css/`: source CSS và bản CSS dùng khi chạy.
- `public/js/`: các module theo từng khu vực chức năng cùng adapter API.
- `tailwind.config.js`: cấu hình build CSS duy nhất ở thư mục gốc.

`/logo.png` giữ nguyên ở `public/logo.png`. Nếu thiếu logo, UI tự hiện chữ "4AM" làm phương án dự phòng.
`public/js/demo.js` **chỉ chạy khi URL có `?demo=1`**. Khi không có tham số này, dashboard dùng API thật của bot.

## 2. Build Tailwind (không bắt buộc)
```
npm i -D tailwindcss@3
npx tailwindcss -i ./public/css/input.css -o ./public/css/dashboard.css --minify
```

## 3. Dữ liệu frontend cần từ API
- `POST /api/login` → `{ token, user? }`. Token lưu ở `localStorage['4am_admin_token']`.
- `GET /api/me` → `{ username, displayName?, role: 'admin'|'owner'|'seller', sellerId?, permissions: [] }` (có thể bọc trong `{ user }`).
- `GET /api/data` → `{ botName?, botOnline?, sellers[], products[], menu{}, ticket{} }`.
  - seller: `{ id, username, globalName, avatar, banks:[{ bankName, account, owner, qr }] }`
  - product: `{ key, name, emoji, title, titleEn, subtitle, subtitleEn, banner, color, sellerId, handlers[], bankIndex, pingStaff, items:[{ label, price }] }`
- `GET /api/orders` → mảng hoặc `{ orders: [] }`. Mỗi đơn: `{ id, orderNo, status, paymentStatus?, service, amount, customerName, discordId, customerAvatar?, sellerId, ticketChannelId, ticketChannelName, ticketOpen, createdAt, updatedAt, provider, transactionId, notes }`
  - `paymentStatus` chỉ có `UNPAID` (Chưa thanh toán) hoặc `PAID` (Đã thanh toán).
- `GET /api/payment-transactions` → `{ transactionId, orderCode, orderId, amount, expectedAmount, receiverAccount, source, createdAt, status }`
- `GET /api/audit-logs` → `{ createdAt, actorType, actorId, action, orderId, before, after, metadata }`

Nếu backend dùng tên trường khác, chỉ cần map lại trong `js/api.js`.

## 4. API dùng ở từng màn hình
| Màn hình | API |
|---|---|
| Đăng nhập / phiên | `/api/login`, `/api/me`, `/api/logout` |
| Tổng quan | `/api/orders`, `/api/data`, `/api/payment-transactions` |
| Đơn hàng | `GET /api/orders`, `POST /api/orders/create`, `/:id/status`, `/:id/amount`, `/:id/update`, `/:id/complete-own`, `DELETE /api/orders/:id` (lưu trữ) |
| Đối soát | `GET /api/payment-transactions[?status=]` |
| Mặt hàng | `GET /api/data`, `POST /api/save` (tự lưu sau 0,9 giây), `GET /api/bot-emojis` |
| Người bán | `GET /api/discord-user/:id`, `POST /api/save`, `/api/dashboard-users` (GET/POST/PATCH/DELETE) |
| Cấu hình Discord | `POST /api/save-and-sync` |
| Audit log | `GET /api/audit-logs` |

### Trạng thái tích hợp backend

- Đã có `POST /api/payment-transactions/:id/handled`; trạng thái xử lý được lưu trong audit log.
- Đã có `POST /api/payment-transactions/:id/attach`; chỉ giao dịch khớp đúng số tiền mới gắn đơn và xác nhận thanh toán. Giao dịch không khớp không tạo thêm trạng thái payment và đơn vẫn là `UNPAID`.
- Đã nối workflow owner với trạng thái legacy và workflow seller `PAID → PROCESSING → COMPLETED` qua `/api/orders/:id/complete-own`.
- `POST /api/save` hiện đóng vai trò lưu bản cấu hình chưa đồng bộ Discord; chưa có lịch sử nhiều phiên bản draft riêng.
- Adapter `js/api.js` ánh xạ response/payload giữa UI mới và backend hiện tại, đồng thời luôn gộp đủ `menuData` trước khi lưu để tránh mất cấu hình.
- Còn có thể bổ sung `guildId` trong `GET /api/data` để nút "Mở ticket Discord" mở đúng server khi backend chạy thật.

Lỗi `401` → xóa token và tải lại trang về màn đăng nhập. Lỗi `403` → hiện thông báo không đủ quyền.

## 5. Các DOM ID cũ vẫn được giữ
Tất cả ID được liệt kê trong đặc tả đều được giữ, gồm: tab, nút điều hướng, metric, bộ lọc, bảng/card đơn, modal sửa đơn, modal thêm seller, form tài khoản dashboard, preview sản phẩm, emoji picker, sub-tab cấu hình, nút đồng bộ toàn cục, modal xác nhận/nhập liệu và toast.
Các hàm tương thích cho handler cũ: `showToast`, `showConfirm`, `showPrompt`, `loadOrders`, `openOrderEditModal`, `renderProducts`, `renderSellers`, `saveAndSync`, `switchTab`.

## 6. Checklist kiểm thử
**Owner**
- [ ] Đăng nhập, thấy đủ 7 mục trong sidebar
- [ ] Xác nhận đã thanh toán cho đơn PENDING (có hộp thoại xác nhận)
- [ ] Sửa số tiền, đổi seller, lưu trữ đơn
- [ ] Tạo đơn thủ công
- [ ] Đối soát: chuyển giữa 4 nhóm, mở đơn liên quan
- [ ] Audit: lọc theo hành động, mở phần dữ liệu trước/sau
- [ ] Thêm seller bằng Discord ID; thêm/sửa/xóa tài khoản ngân hàng; số tài khoản bị che mặc định
- [ ] Tạo, khóa, đổi quyền, đổi mật khẩu và xóa tài khoản dashboard
- [ ] Sửa sản phẩm và thấy xem trước cập nhật ngay; chuyển VI/EN; trạng thái lưu chuyển từ chưa lưu → đang lưu → đã lưu
- [ ] Cấu hình Discord → Lưu & Đồng bộ

**Seller**
- [ ] Chỉ thấy mục Đơn hàng và Mặt hàng
- [ ] Chỉ thấy đơn của mình; không có nút "Xác nhận TT", không sửa được giá, không đổi được seller, không có nút lưu trữ
- [ ] Hoàn tất được đơn PAID được giao cho mình
- [ ] Chỉ sửa được ghi chú khi có quyền `orders.edit`
- [ ] Sản phẩm ở chế độ chỉ xem nếu không có quyền `products.edit`

**Chung**
- [ ] Trên mobile: có thanh điều hướng dưới, đơn hàng hiển thị dạng thẻ, modal mở toàn màn hình
- [ ] Phím Esc đóng modal; focus quay về đúng chỗ; Tab không thoát ra khỏi modal
- [ ] Hết phiên (401) thì quay về màn đăng nhập
