/**
 * 4AM STORE — Multi-Engine Auto Translation Module
 * Supports 100+ languages with automatic fallback & Discord token preservation
 */

const translationCache = new Map(); // key -> translatedText (cache 500 entries)

/**
 * Check if text has Vietnamese characteristics (accents or common keywords)
 */
function isProbablyVietnamese(text) {
  if (!text || typeof text !== 'string') return false;
  // 1. Dấu tiếng Việt đặc trưng
  if (/[àáảãạăắằẳẵặâấầẩẫậđèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ]/i.test(text)) {
    return true;
  }
  // 2. Từ khóa tiếng Việt không dấu phổ biến
  const words = text.toLowerCase().split(/[\s,?.!;:()\[\]"']+/).filter(Boolean);
  const vnCommon = new Set([
    'shop', 'ban', 'gui', 'nhe', 'nha', 'chuyen', 'tien', 'bao', 'nhieu', 
    'khong', 'k', 'ko', 'dc', 'duoc', 'gi', 'stk', 'ck', 'minh', 'em', 
    'anh', 'chi', 'cho', 'voi', 'oi', 'da', 'roi', 'vao', 'la', 'tai',
    'mua', 'cow', 'owo', 'gia', 're', 'trung', 've', 'qua', 'vi'
  ]);
  let matchCount = 0;
  for (const w of words) {
    if (vnCommon.has(w)) matchCount++;
  }
  return matchCount >= 2;
}

/**
 * Tokenize Discord tags, links, emojis to prevent translation corruption
 */
function maskTokens(text) {
  const tokens = [];
  const tokenRegex = /(https?:\/\/[^\s]+|```[\s\S]*?```|`[^`]+`|\{[a-zA-Z0-9_]+\}|<@[!&]?\d+>|<#\d+>|<@&\d+>|<a?:[a-zA-Z0-9_~]+:\d+>|<t:\d+(?::[tTdDfFR])?>|<\/[a-zA-Z0-9_-]+:\d+>)/gu;
  const tokenized = text.replace(tokenRegex, (match) => {
    const placeholder = 'ZXQPH' + tokens.length + 'QXZ';
    tokens.push({ placeholder, original: match });
    return placeholder;
  });
  return { tokenized, tokens };
}

function unmaskTokens(translated, tokens) {
  if (!translated || !tokens.length) return translated;
  let out = translated;
  for (let i = 0; i < tokens.length; i++) {
    const regex = new RegExp('ZXQPH' + i + 'QXZ', 'gi');
    out = out.replace(regex, tokens[i].original);
  }
  return out;
}

/**
 * Dịch văn bản đa nguồn: MyMemory API với Fallback Google Translate
 */
async function translateText(text, from = 'auto', to = 'vi') {
  if (!text || typeof text !== 'string' || !text.trim()) return null;
  const clean = text.trim();
  
  // Don't translate if it's only numbers, IDs, symbols, or URLs
  if (!/[a-zA-ZÀ-ỹ]/.test(clean)) return null;

  const cacheKey = `${from}|${to}|${clean}`;
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  const { tokenized, tokens } = maskTokens(clean);

  // 1. Thử MyMemory API
  try {
    const pair = from === 'auto' ? `Autodetect|${to}` : `${from}|${to}`;
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(tokenized)}&langpair=${pair}`;
    const res = await fetch(url, { 
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, 
      signal: AbortSignal.timeout(3500) 
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.responseData && data.responseData.translatedText) {
        let out = data.responseData.translatedText.trim();
        // Không nhận kết quả nếu MyMemory báo lỗi quota hoặc trùng nguyên bản
        if (!out.startsWith('MYMEMORY WARNING') && out.toLowerCase() !== tokenized.toLowerCase()) {
          out = unmaskTokens(out, tokens);
          if (translationCache.size > 500) translationCache.clear();
          translationCache.set(cacheKey, out);
          return out;
        }
      }
    }
  } catch (_) {}

  // 2. Fallback: Google Translate GTX Endpoint
  try {
    const sl = from === 'auto' ? 'auto' : from;
    const gUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${to}&dt=t&q=${encodeURIComponent(tokenized)}`;
    const gRes = await fetch(gUrl, { 
      headers: { 'User-Agent': 'Mozilla/5.0' }, 
      signal: AbortSignal.timeout(3500) 
    });
    if (gRes.ok) {
      const gData = await gRes.json();
      if (gData && Array.isArray(gData[0])) {
        let out = gData[0].map(x => x[0]).join('').trim();
        if (out && out.toLowerCase() !== tokenized.toLowerCase()) {
          out = unmaskTokens(out, tokens);
          if (translationCache.size > 500) translationCache.clear();
          translationCache.set(cacheKey, out);
          return out;
        }
      }
    }
  } catch (_) {}

  return null;
}

module.exports = {
  isProbablyVietnamese,
  translateText
};
