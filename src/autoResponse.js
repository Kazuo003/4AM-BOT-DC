const fs = require('fs');
const path = require('path');
const { nanoid } = require('nanoid');

const jsonPath = path.resolve(__dirname, 'autoResponses.json');

// Cache in-memory
let responsesCache = null;
const cooldownMap = new Map(); // key: `${channelId}:${responseId}` -> timestamp

function loadAutoResponses() {
  try {
    if (!fs.existsSync(jsonPath)) {
      fs.writeFileSync(jsonPath, '[]', 'utf8');
      responsesCache = [];
      return responsesCache;
    }
    const raw = fs.readFileSync(jsonPath, 'utf8');
    responsesCache = JSON.parse(raw);
    if (!Array.isArray(responsesCache)) responsesCache = [];
    return responsesCache;
  } catch (err) {
    console.error('Lỗi đọc autoResponses.json:', err);
    responsesCache = [];
    return responsesCache;
  }
}

function saveAutoResponses(list) {
  try {
    responsesCache = list;
    fs.writeFileSync(jsonPath, JSON.stringify(list, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Lỗi ghi autoResponses.json:', err);
    return false;
  }
}

function getAutoResponses() {
  if (!responsesCache) {
    loadAutoResponses();
  }
  return responsesCache;
}

/**
 * Tìm câu trả lời tự động khớp với nội dung tin nhắn
 */
function findMatchingAutoResponse(content, channelId) {
  if (!content) return null;
  const list = getAutoResponses();
  const trimmed = content.trim();
  const lower = trimmed.toLowerCase();

  for (const item of list) {
    if (item.enabled === false) continue;
    if (item.channels && Array.isArray(item.channels) && item.channels.length > 0) {
      if (!item.channels.includes(channelId)) continue;
    }

    const triggerTrimmed = String(item.trigger || '').trim();
    const triggerLower = triggerTrimmed.toLowerCase();
    if (!triggerLower) continue;

    let isMatch = false;
    const matchType = (item.matchType || 'exact').toLowerCase();

    if (matchType === 'exact') {
      // Khớp chính xác (không phân biệt hoa thường)
      isMatch = (lower === triggerLower);
    } else if (matchType === 'contains') {
      // Tin nhắn có chứa từ khóa
      isMatch = lower.includes(triggerLower);
    } else if (matchType === 'startswith') {
      // Bắt đầu bằng từ khóa
      isMatch = lower.startsWith(triggerLower);
    }

    if (isMatch) {
      // Kiểm tra cooldown (3 giây mỗi kênh)
      const cdKey = `${channelId}:${item.id || triggerLower}`;
      const now = Date.now();
      const lastTrigger = cooldownMap.get(cdKey) || 0;
      const cooldownMs = (item.cooldownSec || 3) * 1000;

      if (now - lastTrigger < cooldownMs) {
        // Đang trong cooldown, bỏ qua tránh spam
        return null;
      }

      cooldownMap.set(cdKey, now);
      return item;
    }
  }

  return null;
}

/**
 * Thêm hoặc cập nhật Auto Response
 */
function addOrUpdateAutoResponse({ id, trigger, response, imageUrl, matchType = 'exact', replyMode = 'reply' }) {
  const list = getAutoResponses();
  const cleanTrigger = String(trigger || '').trim();
  if (!cleanTrigger) throw new Error('Từ khóa trigger không được để trống.');

  let existingIdx = -1;
  if (id) {
    existingIdx = list.findIndex(x => x.id === id);
  }
  if (existingIdx === -1) {
    existingIdx = list.findIndex(x => x.trigger.trim().toLowerCase() === cleanTrigger.toLowerCase());
  }

  const entry = {
    id: existingIdx >= 0 ? list[existingIdx].id : (id || nanoid(8)),
    trigger: cleanTrigger,
    response: response ? String(response).trim() : '',
    imageUrl: imageUrl ? String(imageUrl).trim() : '',
    matchType: matchType === 'contains' ? 'contains' : 'exact',
    replyMode: replyMode === 'send' ? 'send' : 'reply',
    enabled: true,
    updatedAt: new Date().toISOString()
  };

  if (existingIdx >= 0) {
    entry.createdAt = list[existingIdx].createdAt || new Date().toISOString();
    list[existingIdx] = entry;
  } else {
    entry.createdAt = new Date().toISOString();
    list.push(entry);
  }

  saveAutoResponses(list);
  return entry;
}

/**
 * Xóa Auto Response theo trigger hoặc id
 */
function deleteAutoResponse(triggerOrId) {
  const list = getAutoResponses();
  const target = String(triggerOrId || '').trim().toLowerCase();
  const filtered = list.filter(x => x.id.toLowerCase() !== target && x.trigger.trim().toLowerCase() !== target);

  if (filtered.length === list.length) {
    return false; // Không tìm thấy
  }

  saveAutoResponses(filtered);
  return true;
}

module.exports = {
  loadAutoResponses,
  saveAutoResponses,
  getAutoResponses,
  findMatchingAutoResponse,
  addOrUpdateAutoResponse,
  deleteAutoResponse
};
