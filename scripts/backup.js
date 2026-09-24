const fs = require('fs');
const path = require('path');

function createBackup() {
  const rootDir = path.resolve(__dirname, '..');
  const backupDir = path.resolve(rootDir, 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sessionDir = path.resolve(backupDir, `backup_${timestamp}`);
  fs.mkdirSync(sessionDir, { recursive: true });

  const filesToBackup = [
    { src: path.resolve(rootDir, 'prisma/dev.db'), dest: path.resolve(sessionDir, 'dev.db') },
    { src: path.resolve(rootDir, 'src/menuData.json'), dest: path.resolve(sessionDir, 'menuData.json') },
    { src: path.resolve(rootDir, '.dashboard-users.json'), dest: path.resolve(sessionDir, 'dashboard-users.json') },
    { src: path.resolve(rootDir, '.env'), dest: path.resolve(sessionDir, '.env') }
  ];

  let backedUpCount = 0;
  for (const item of filesToBackup) {
    if (fs.existsSync(item.src)) {
      fs.copyFileSync(item.src, item.dest);
      backedUpCount++;
    }
  }

  console.log(`[Backup] Đã tạo bản sao lưu thành công tại: ${sessionDir} (${backedUpCount} files)`);
  return sessionDir;
}

if (require.main === module) {
  createBackup();
}

module.exports = { createBackup };
