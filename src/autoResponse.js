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

    // Hỗ trợ mảng triggers hoặc chuỗi trigger đơn / phân tách bằng dấu phẩy
    let triggers = [];
    if (Array.isArray(item.triggers) && item.triggers.length > 0) {
      triggers = item.triggers.map(t => String(t).trim().toLowerCase()).filter(Boolean);
    } else if (item.trigger) {
      triggers = String(item.trigger).split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    }
    if (triggers.length === 0) continue;

    let isMatch = false;
    const matchType = (item.matchType || 'exact').toLowerCase();

    for (const t of triggers) {
      if (matchType === 'exact') {
        if (lower === t) { isMatch = true; break; }
      } else if (matchType === 'contains') {
        if (lower.includes(t)) { isMatch = true; break; }
      } else if (matchType === 'startswith') {
        if (lower.startsWith(t)) { isMatch = true; break; }
      }
    }

    if (isMatch) {
      // Kiểm tra cooldown (3 giây mỗi kênh)
      const cdKey = `${channelId}:${item.id || triggers[0]}`;
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
function addOrUpdateAutoResponse({ id, trigger, triggers, response, imageUrl, matchType = 'exact', replyMode = 'reply' }) {
  const list = getAutoResponses();
  const cleanTrigger = String(trigger || (Array.isArray(triggers) ? triggers.join(', ') : '')).trim();
  if (!cleanTrigger) throw new Error('Từ khóa trigger không được để trống.');

  let existingIdx = -1;
  if (id) {
    existingIdx = list.findIndex(x => x.id === id);
  }
  if (existingIdx === -1) {
    existingIdx = list.findIndex(x => x.trigger.trim().toLowerCase() === cleanTrigger.toLowerCase());
  }

  const parsedTriggers = Array.isArray(triggers) && triggers.length > 0 
    ? triggers.map(s => String(s).trim()).filter(Boolean)
    : cleanTrigger.split(',').map(s => s.trim()).filter(Boolean);

  const entry = {
    id: existingIdx >= 0 ? list[existingIdx].id : (id || nanoid(8)),
    trigger: cleanTrigger,
    triggers: parsedTriggers,
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
