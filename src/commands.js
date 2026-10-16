require('dotenv').config();
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const commands = [

  // Shop: user-facing
  new SlashCommandBuilder()
    .setName('shop')
    .setDescription('Open the in-Discord Shop'),

  // Orders: staff view
  new SlashCommandBuilder()
    .setName('orders')
    .setDescription('List recent orders (staff)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),



  // Live Menu sync
  new SlashCommandBuilder()
    .setName('sync-menu')
    .setDescription('Admin: Cập nhật hoặc đẩy bảng giá vào kênh Menu')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // Ticket Panel sync
  new SlashCommandBuilder()
    .setName('ticket-panel')
    .setDescription('Admin: Gửi panel mở Ticket vào kênh Ticket')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // Send Bank Accounts (Staff/Admin)
  new SlashCommandBuilder()
    .setName('send-bank')
    .setDescription('Staff: Gửi thông tin STK của người bán vào kênh chat')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(opt =>
      opt.setName('seller')
        .setDescription('Tên hoặc mã người bán (bỏ trống để chọn danh sách)')
        .setRequired(false)),

  // Catalog management
  new SlashCommandBuilder()
    .setName('add-product')
    .setDescription('Admin: Thêm sản phẩm mới vào danh mục')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(opt =>
      opt.setName('name').setDescription('Tên sản phẩm').setRequired(true))
    .addStringOption(opt =>
      opt.setName('sku').setDescription('Mã SKU duy nhất').setRequired(true))
    .addIntegerOption(opt =>
      opt.setName('price').setDescription('Giá sản phẩm (VNĐ)').setRequired(true))
    .addStringOption(opt =>
      opt.setName('type')
        .setDescription('Loại sản phẩm')
        .setRequired(false)
        .addChoices(
          { name: 'VPS', value: 'VPS' },
          { name: 'Discord Bot', value: 'BOT' },
          { name: 'Web Hosting', value: 'WEB' },
          { name: 'Khác', value: 'OTHER' }
        ))
    .addStringOption(opt =>
      opt.setName('description').setDescription('Mô tả ngắn hoặc cấu hình').setRequired(false)),

  new SlashCommandBuilder()
    .setName('set-price')
    .setDescription('Admin: Cập nhật giá sản phẩm')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(opt =>
      opt.setName('sku').setDescription('Mã SKU sản phẩm').setRequired(true))
    .addIntegerOption(opt =>
      opt.setName('price').setDescription('Giá mới (VNĐ)').setRequired(true)),

  new SlashCommandBuilder()
    .setName('toggle-plan')
    .setDescription('Admin: Bật hoặc tắt mở bán sản phẩm')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(opt =>
      opt.setName('sku').setDescription('Mã SKU sản phẩm').setRequired(true))
    .addBooleanOption(opt =>
      opt.setName('enabled').setDescription('Bật (true) hoặc Tắt (false)').setRequired(true)),

  new SlashCommandBuilder()
    .setName('list-products')
    .setDescription('Admin: Xem tất cả sản phẩm trong kho')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // Announcements
  new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Admin: Post an announcement embed to the announcements channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o =>
      o.setName('title').setDescription('Announcement title').setRequired(true))
    .addStringOption(o =>
      o.setName('message').setDescription('Announcement message body').setRequired(true))
    .addStringOption(o =>
      o.setName('image').setDescription('Optional image URL').setRequired(false))
    .addStringOption(o =>
      o.setName('color').setDescription('Hex color, e.g. #5865F2').setRequired(false)),
      
  new SlashCommandBuilder().setName('my-subscriptions').setDescription('View your active subscriptions'),

  // 1-Click Bilingual Server Setup
  new SlashCommandBuilder()
    .setName('setup-bilingual')
    .setDescription('Admin: Tự động khởi tạo & phân quyền hệ thống server song ngữ (Roles, Kênh, Permissions)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // Auto Response management
  new SlashCommandBuilder()
    .setName('autoresponse')
    .setDescription('Admin: Quản lý tự động trả lời tin nhắn theo từ khóa (Auto Response)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Thêm hoặc cập nhật phản hồi tự động')
        .addStringOption(opt => opt.setName('trigger').setDescription('Từ khóa kích hoạt (VD: A, stk, owo...)').setRequired(true))
        .addStringOption(opt => opt.setName('response').setDescription('Nội dung văn bản phản hồi').setRequired(true))
        .addStringOption(opt => opt.setName('image').setDescription('Link ảnh hoặc GIF đính kèm (tùy chọn)').setRequired(false))
        .addStringOption(opt => opt.setName('match_type').setDescription('Cách so khớp (mặc định: chính xác)')
          .setRequired(false)
          .addChoices(
            { name: 'Khớp chính xác (exact)', value: 'exact' },
            { name: 'Tin nhắn có chứa (contains)', value: 'contains' }
          ))
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Xem danh sách các phản hồi tự động')
    )
    .addSubcommand(sub =>
      sub.setName('delete')
        .setDescription('Xóa phản hồi tự động theo từ khóa')
        .addStringOption(opt => opt.setName('trigger').setDescription('Từ khóa cần xóa').setRequired(true))
    ),

  // Giveaway system
  new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Quản lý và tổ chức sự kiện Giveaway (Staff/Admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub =>
      sub.setName('start')
        .setDescription('Bắt đầu một sự kiện Giveaway mới')
        .addStringOption(opt =>
          opt.setName('prize')
            .setDescription('Phần thưởng giveaway (VD: 1 Tháng Spotify, 50M OwO Cash...)')
            .setRequired(true))
        .addStringOption(opt =>
          opt.setName('duration')
            .setDescription('Thời gian giveaway (VD: 10m, 1h, 24h, 3d...)')
            .setRequired(true))
        .addIntegerOption(opt =>
          opt.setName('winners')
            .setDescription('Số lượng người thắng giải (Mặc định: 1)')
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(20))
        .addChannelOption(opt =>
          opt.setName('channel')
            .setDescription('Kênh tổ chức giveaway (Mặc định: kênh hiện tại)')
            .setRequired(false))
        .addStringOption(opt =>
          opt.setName('description')
            .setDescription('Ghi chú hoặc điều kiện tham gia (tùy chọn)')
            .setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('end')
        .setDescription('Kết thúc sớm giveaway và bốc thăm người chiến thắng')
        .addStringOption(opt =>
          opt.setName('message_id')
            .setDescription('ID tin nhắn của Giveaway cần kết thúc')
            .setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('reroll')
        .setDescription('Bốc lại người thắng mới cho Giveaway đã kết thúc')
        .addStringOption(opt =>
          opt.setName('message_id')
            .setDescription('ID tin nhắn của Giveaway cần reroll')
            .setRequired(true))
        .addIntegerOption(opt =>
          opt.setName('winners')
            .setDescription('Số lượng người cần reroll (Mặc định: 1)')
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(10))
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Xem danh sách các Giveaway đang diễn ra')
    )
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

(async () => {
  try {
    console.log('Registering slash commands…');

    await rest.put(
      Routes.applicationGuildCommands(
        process.env.DISCORD_CLIENT_ID,
        process.env.GUILD_ID
      ),
      { body: commands.map(c => c.toJSON()) }
    );

    console.log('Done ✅');
  } catch (error) {
    console.error(error);
  }
})();