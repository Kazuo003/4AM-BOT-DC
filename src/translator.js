/**
 * 4AM STORE — Multi-Engine Auto Translation Module
 * Supports 100+ languages with automatic fallback & Discord token preservation
 */

const { EmbedBuilder } = require('discord.js');

const translationCache = new Map(); // key -> translatedText (cache 500 entries)

const LANG_NAME_MAP = {
  // Tiếng Anh (Mặc định)
  'en': 'en', 'eng': 'en', 'english': 'en', 'anh': 'en', 'us': 'en', 'uk': 'en',
  // Indonesia
  'id': 'id', 'indo': 'id', 'indonesia': 'id', 'bahasa': 'id',
  // Philippines
  'tl': 'tl', 'fil': 'tl', 'phil': 'tl', 'philippines': 'tl', 'pinoy': 'tl', 'tagalog': 'tl',
  // Trung Quốc
  'zh': 'zh', 'cn': 'zh', 'china': 'zh', 'chinese': 'zh', 'trung': 'zh', 'tau': 'zh',
  // Nhật Bản
  'ja': 'ja', 'jp': 'ja', 'japan': 'ja', 'japanese': 'ja', 'nhat': 'ja',
  // Hàn Quốc
  'ko': 'ko', 'kr': 'ko', 'korea': 'ko', 'korean': 'ko', 'han': 'ko',
  // Thái Lan
  'th': 'th', 'thai': 'th', 'thailan': 'th', 'thailand': 'th',
  // Nga
  'ru': 'ru', 'russia': 'ru', 'russian': 'ru', 'nga': 'ru',
  // Pháp
  'fr': 'fr', 'france': 'fr', 'french': 'fr', 'phap': 'fr',
  // Tây Ban Nha
  'es': 'es', 'spain': 'es', 'spanish': 'es', 'taybannha': 'es',
  // Đức
  'de': 'de', 'germany': 'de', 'german': 'de', 'duc': 'de',
  // Bồ Đào Nha / Brazil
  'pt': 'pt', 'portugal': 'pt', 'brazil': 'pt', 'portuguese': 'pt', 'bodoanha': 'pt',
  // Ý
  'it': 'it', 'italy': 'it', 'italian': 'it', 'y': 'it',
  // Ấn Độ
  'hi': 'hi', 'india': 'hi', 'hindi': 'hi', 'ando': 'hi',
  // Malaysia
  'ms': 'ms', 'malaysia': 'ms', 'malay': 'ms',
  // Thổ Nhĩ Kỳ
  'tr': 'tr', 'turkey': 'tr', 'turkish': 'tr', 'thonhiki': 'tr',
  // Việt Nam
  'vi': 'vi', 'vietnam': 'vi', 'viet': 'vi', 'vietnamese': 'vi'
};

function resolveLangCode(input) {
  if (!input || typeof input !== 'string') return null;
  const clean = input.trim().toLowerCase();
  if (LANG_NAME_MAP[clean]) return LANG_NAME_MAP[clean];
  if (/^[a-z]{2,5}$/.test(clean)) return clean;
  return null;
}

function buildLanguageListEmbed() {
  return new EmbedBuilder()
    .setTitle('🌐 BẢNG TRA CỨU MÃ NGÔN NGỮ QUỐC TẾ (AUTO-TRANSLATE)')
    .setDescription(
      `Hệ thống hỗ trợ tự động dịch hai chiều **100+ thứ tiếng**.\n` +
      `Staff có thể gõ mã 2 chữ cái hoặc tên nước để chuyển: \`!lang <mã/tên>\`\n` +
      `*(Ví dụ: \`!lang id\` hoặc \`!lang indo\`, \`!lang tl\` hoặc \`!lang phil\`)*`
    )
    .setColor(0x00C2A8)
    .addFields(
      {
        name: '🌏 Đông Nam Á & Châu Á (Cộng đồng OwO / Game)',
        value: 
          '• 🇺🇸 **`en`** (hoặc `!lang anh`) : Tiếng Anh (Mặc định toàn cầu)\n' +
          '• 🇮🇩 **`id`** (hoặc `!lang indo`) : Indonesia (Indo / Bahasa Indonesia)\n' +
          '• 🇵🇭 **`tl`** (hoặc `!lang phil`) : Philippines (Tagalog / Pinoy)\n' +
          '• 🇹🇭 **`th`** (hoặc `!lang thai`) : Thái Lan (Thai)\n' +
          '• 🇨🇳 **`zh`** (hoặc `!lang trung`) : Trung Quốc (Chinese)\n' +
          '• 🇯🇵 **`ja`** (hoặc `!lang nhat`) : Nhật Bản (Japanese)\n' +
          '• 🇰🇷 **`ko`** (hoặc `!lang han`) : Hàn Quốc (Korean)\n' +
          '• 🇮🇳 **`hi`** (hoặc `!lang ando`) : Ấn Độ (Hindi)\n' +
          '• 🇲🇾 **`ms`** (hoặc `!lang malay`) : Malaysia (Malay)'
      },
      {
        name: '🌍 Châu Âu & Mỹ La-tinh',
        value:
          '• 🇷🇺 **`ru`** (hoặc `!lang nga`) : Nga (Russian)\n' +
          '• 🇪🇸 **`es`** (hoặc `!lang taybannha`) : Tây Ban Nha (Spanish)\n' +
          '• 🇫🇷 **`fr`** (hoặc `!lang phap`) : Pháp (French)\n' +
          '• 🇩🇪 **`de`** (hoặc `!lang duc`) : Đức (German)\n' +
          '• 🇧🇷 **`pt`** (hoặc `!lang bodoanha`) : Bồ Đào Nha / Brazil (Portuguese)\n' +
          '• 🇮🇹 **`it`** (hoặc `!lang y`) : Ý (Italian)\n' +
          '• 🇹🇷 **`tr`** (hoặc `!lang thonhiki`) : Thổ Nhĩ Kỳ (Turkish)'
      },
      {
        name: '⚡ Cú pháp & Phím tắt nhanh trong Ticket',
        value:
          '• `!lang <mã/tên>` : Đổi ngôn ngữ dịch mục tiêu (Ví dụ: `!lang indo`, `!lang ru`)\n' +
          '• `!tr on` : Bật dịch tự động hai chiều\n' +
          '• `!tr off` : Tắt tạm thời dịch tự động\n' +
          '• `!langs` hoặc `!lang` : Xem lại bảng tra cứu này bất cứ lúc nào'
      }
    )
    .setFooter({ text: '4AM STORE • Hệ thống dịch thuật quốc tế đa nguồn' })
    .setTimestamp();
}

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
  translateText,
  resolveLangCode,
  buildLanguageListEmbed
};
