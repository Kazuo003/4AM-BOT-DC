const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Thời gian kiểm tra GitHub (mặc định: mỗi 20 giây)
const CHECK_INTERVAL_MS = parseInt(process.env.UPDATE_INTERVAL_MS, 10) || 20 * 1000;
const ROOT_DIR = path.resolve(__dirname, '..');

function run(cmd) {
  return execSync(cmd, { cwd: ROOT_DIR, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function log(msg) {
  const time = new Date().toLocaleString('vi-VN', { hour12: false });
  console.log(`[${time}] [AutoUpdater] ${msg}`);
}

let isUpdating = false;

async function checkAndUpdate() {
  if (isUpdating) return;

  try {
    // 1. Fetch thông tin mới nhất từ GitHub nhánh main
    run('git fetch origin main');

    // 2. Lấy hash commit hiện tại và commit mới nhất trên GitHub
    const localHash = run('git rev-parse HEAD');
    const remoteHash = run('git rev-parse origin/main');

    if (localHash === remoteHash) {
      // Đang ở phiên bản mới nhất, không cần làm gì
      return;
    }

    // Kiểm tra xem local có đang bị chậm hơn remote không
    const behindCount = parseInt(run('git rev-list HEAD..origin/main --count'), 10) || 0;
    if (behindCount === 0) {
      return;
    }

    isUpdating = true;
    log(`🚀 Phát hiện ${behindCount} commit mới trên GitHub! Đang cập nhật code...`);

    // 3. Kiểm tra xem các file quan trọng có thay đổi trong đợt commit này không
    const changedFiles = run('git diff --name-only HEAD origin/main');
    const hasPackageChanges = changedFiles.includes('package.json');
    const hasPrismaChanges = changedFiles.includes('prisma/schema.prisma');

    // 4. Kéo code mới về (Tự động bảo toàn dữ liệu giveaways trên VPS)
    let savedGiveaways = null;
    const giveawaysPath = path.join(ROOT_DIR, 'src', 'giveaways.json');
    if (fs.existsSync(giveawaysPath)) {
      try {
        savedGiveaways = fs.readFileSync(giveawaysPath, 'utf8');
      } catch (_) {}
    }

    try {
      run('git checkout -- src/autoResponses.json');
    } catch (_) {}

    let pullOutput;
    try {
      pullOutput = run('git pull origin main');
      log(`📥 Git pull:\n${pullOutput}`);
    } catch (pullErr) {
      log(`⚠️ Git pull gặp lỗi (${pullErr.message}), đang force reset về origin/main...`);
      pullOutput = run('git reset --hard origin/main');
      log(`📥 Git reset:\n${pullOutput}`);
    }

    // Khôi phục và hợp nhất dữ liệu người tham gia giveaway từ runtime VPS
    if (savedGiveaways) {
      try {
        const currentOnDisk = fs.existsSync(giveawaysPath) ? JSON.parse(fs.readFileSync(giveawaysPath, 'utf8')) : [];
        const localSaved = JSON.parse(savedGiveaways);
        if (Array.isArray(localSaved) && Array.isArray(currentOnDisk)) {
          for (const diskGa of currentOnDisk) {
            const matchingLocal = localSaved.find(g => (g.messageId && g.messageId === diskGa.messageId) || (g.id && g.id === diskGa.id));
            if (matchingLocal && Array.isArray(matchingLocal.participants) && matchingLocal.participants.length > (diskGa.participants?.length || 0)) {
              diskGa.participants = matchingLocal.participants;
            }
          }
          // Giữ thêm các giveaway chỉ có trên local VPS
          for (const localGa of localSaved) {
            if (!currentOnDisk.some(g => (g.messageId && g.messageId === localGa.messageId) || (g.id && g.id === localGa.id))) {
              currentOnDisk.push(localGa);
            }
          }
          fs.writeFileSync(giveawaysPath, JSON.stringify(currentOnDisk, null, 2), 'utf8');
        } else if (Array.isArray(localSaved) && localSaved.length > 0) {
          fs.writeFileSync(giveawaysPath, savedGiveaways, 'utf8');
        }
      } catch (gaErr) {
        try { fs.writeFileSync(giveawaysPath, savedGiveaways, 'utf8'); } catch (_) {}
      }
    }

    // 5. Cập nhật thư viện nếu package.json thay đổi
    if (hasPackageChanges) {
      log('📦 Phát hiện package.json thay đổi -> Đang chạy npm install...');
      run('npm install --no-audit --no-fund');
    }

    // 6. Cập nhật Prisma client nếu schema thay đổi
    if (hasPrismaChanges) {
      log('🗄️ Phát hiện schema.prisma thay đổi -> Đang chạy prisma generate...');
      run('npx prisma generate');
    }

    // 7. Restart Bot bằng PM2
    log('🔄 Đang khởi động lại Bot (PM2 restart 4am-bot)...');
    try {
      run('pm2 restart 4am-bot');
      log('✅ Đã restart Bot thành công với phiên bản code mới nhất!');
    } catch (pm2Err) {
      log(`⚠️ Lưu ý khi chạy lệnh PM2: ${pm2Err.message}`);
      log('👉 Nếu bạn chưa chạy bot bằng PM2, hãy chạy: pm2 start src/bot.js --name "4am-bot"');
    }

  } catch (err) {
    // Không crash updater nếu lỗi mạng hoặc git conflict tạm thời
    log(`⚠️ Lỗi kiểm tra/cập nhật: ${err.message}`);
  } finally {
    isUpdating = false;
  }
}

log(`Bắt đầu dịch vụ Auto-Updater (Kiểm tra GitHub mỗi ${CHECK_INTERVAL_MS / 1000}s)...`);
// Chạy kiểm tra định kỳ
setInterval(checkAndUpdate, CHECK_INTERVAL_MS);

// Chạy thử lần đầu ngay khi mở
checkAndUpdate();
