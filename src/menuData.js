const fs = require('fs');
const path = require('path');

const jsonPath = path.resolve(__dirname, 'menuData.json');

function loadData() {
  try {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('Lỗi khi đọc menuData.json:', e);
    return {};
  }
}

function saveData(data) {
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = loadData();
module.exports.loadData = loadData;
module.exports.saveData = saveData;
module.exports.jsonPath = jsonPath;

