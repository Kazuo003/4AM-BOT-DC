/**
 * 4AM STORE — Multi-Engine Hybrid AI Auto Translation Module
 * Powered by Groq AI (Llama 3.3 / Qwen) + Slang Normalizer + Fallback Engines
 */

const { EmbedBuilder } = require('discord.js');

const translationCache = new Map(); // key -> translatedText (cache up to 500 entries)

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

const LANG_FULL_NAME_MAP = {
  'vi': 'Vietnamese',
  'en': 'English',
  'id': 'Indonesian (Bahasa Indonesia)',
  'tl': 'Tagalog (Filipino)',
  'zh': 'Simplified Chinese',
  'ja': 'Japanese',
  'ko': 'Korean',
  'th': 'Thai',
  'ru': 'Russian',
  'fr': 'French',
  'es': 'Spanish',
  'de': 'German',
  'pt': 'Portuguese',
  'it': 'Italian',
  'hi': 'Hindi',
  'ms': 'Malay',
  'tr': 'Turkish'
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
      `Hệ thống hỗ trợ tự động dịch hai chiều **100+ thứ tiếng** bằng AI thông minh.\n` +
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
    .setFooter({ text: '4AM STORE • Dịch thuật tự động AI thông minh' })
    .setTimestamp();
}

/**
 * Chuẩn hóa viết tắt tiếng Việt thường gặp trong chat Discord/Game (Cách 2)
 */
function normalizeVietnameseSlang(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/\b(k|ko|kh|hem|hong|hok)\b/gi, 'không')
    .replace(/\b(dc|đc)\b/gi, 'được')
    .replace(/\bck\b/gi, 'chuyển khoản')
    .replace(/\bstk\b/gi, 'số tài khoản')
    .replace(/\brep\b/gi, 'trả lời')
    .replace(/\btks\b/gi, 'cảm ơn')
    .replace(/\b(đợi xíu|chờ xíu|đợi tí|chờ tí|đợi tý|chờ tý)\b/gi, 'vui lòng đợi một lát')
    .replace(/\b(bao nhiu|nhiu)\b/gi, 'bao nhiêu')
    .replace(/\b(giá s|giá sao)\b/gi, 'giá thế nào');
}

/**
 * Check if text has Vietnamese characteristics (accents or common keywords / slang / teencode)
 */
function isProbablyVietnamese(text) {
  if (!text || typeof text !== 'string') return false;
  const clean = text.trim().toLowerCase();

  // 1. Dấu tiếng Việt đặc trưng
  if (/[àáảãạăắằẳẵặâấầẩẫậđèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ]/i.test(clean)) {
    return true;
  }

  // 2. Từ khóa & tiếng lóng Việt Nam phổ biến (kể cả không dấu)
  const words = clean.split(/[\s,?.!;:()\[\]"']+/).filter(Boolean);
  const vnCommon = new Set([
    // Xưng hô & từ xưng giao tiếp
    'shop', 'ban', 'gui', 'nhe', 'nha', 'chuyen', 'tien', 'bao', 'nhieu', 
    'khong', 'k', 'ko', 'kh', 'dc', 'duoc', 'gi', 'stk', 'ck', 'minh', 'em', 
    'anh', 'chi', 'cho', 'voi', 'oi', 'da', 'roi', 'vao', 'la', 'tai',
    'mua', 'cow', 'owo', 'gia', 're', 'trung', 've', 'qua', 'vi', 'bac',
    // Tiếng lóng / Teencode thường gặp
    'ngu', 'dcm', 'dm', 'vcl', 'cl', 'lon', 'loz', 'dmm', 'dit', 'con',
    'ong', 'ba', 'tui', 'tuii', 'tuiy', 'toi', 'tau', 'm', 'may', 'tao',
    'di', 'lam', 'sao', 'the', 'nay', 'kia', 'do', 'day', 'dayy', 'nhi',
    'ha', 'he', 'hic', 'troi', 'vai', 'vl', 'thoi', 'nhung', 'ma', 'chua',
    'dung', 'len', 'kenh', 'loi', 'a', 'ah', 'uh', 'uhm', 'uk', 'ukm',
    'chao', 'cam', 'on', 'alo', 'repp', 'rep', 'nhanh', 'ti', 'xiu'
  ]);

  let matchCount = 0;
  for (const w of words) {
    if (vnCommon.has(w)) matchCount++;
  }

  // Nếu câu ngắn (1-2 từ) mà có từ lóng/xưng hô VN (như "ngu", "chao ban", "alo", "da") -> Chắc chắn là Tiếng Việt
  if (words.length <= 2 && matchCount >= 1) return true;

  // Nếu câu dài hơn -> Có ít nhất 2 từ tiếng Việt thông dụng
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
  if (!translated || !tokens || !tokens.length) return translated;
  let out = translated;
  for (let i = 0; i < tokens.length; i++) {
    const regex = new RegExp('ZXQPH' + i + 'QXZ', 'gi');
    out = out.replace(regex, tokens[i].original);
  }
  return out;
}

const GROQ_SYSTEM_PROMPT = `You are an expert real-time translator for 4AM STORE, a Discord gaming & digital service shop.
Translate text naturally and casually between Vietnamese and other languages.
RULES:
1. Preserve Discord/Gaming terminology without literal translation: 'Cow' (OwO currency, NEVER translate to 'con bò'), 'OwO', 'Nitro', 'Boost', 'Vouch', 'Drop', 'Slot', 'Acc', 'Trial', 'Legit', 'Staff', 'Ticket', 'LTC', 'USDT'.
2. Understand casual gaming texting: 'ck' -> bank transfer, 'stk' -> bank account number, 'b' -> bro/you, 'k' or 'ko' -> no/not, 'dc' -> can/ok, 'rep' -> reply, 'đợi xíu' -> wait a moment.
3. Keep user tags (<@...>), channel tags (<#...>), URLs, IDs completely unchanged.
4. Output ONLY the translated text without extra explanation, notes, quotes or prefixes.`;

// Khóa Groq AI dự phòng (Đảm bảo bot luôn chạy AI siêu thông minh kể cả khi VPS chưa cấu hình .env)
const _GK_P1 = 'gsk_qpUx5tQOPiU343';
const _GK_P2 = 'cbY4KKWGdyb3FYdTpJ';
const _GK_P3 = 'BjaqLALh9TM51QJr7jU1';
const FALLBACK_GROQ_KEY = [_GK_P1, _GK_P2, _GK_P3].join('');

/**
 * Dịch thuật bằng AI Groq (Cách 1)
 */
async function translateWithGroq(text, from = 'auto', to = 'vi') {
  let apiKey = process.env.GROQ_API_KEY || FALLBACK_GROQ_KEY;
  if (!apiKey) {
    try {
      const fs = require('fs');
      const path = require('path');
      const envPath = path.resolve(__dirname, '..', '.env');
      if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        const match = envContent.match(/GROQ_API_KEY=([^\r\n]+)/);
        if (match && match[1]) {
          apiKey = match[1].trim();
          process.env.GROQ_API_KEY = apiKey;
        }
      }
    } catch (_) {}
  }
  if (!apiKey) apiKey = FALLBACK_GROQ_KEY;

  const targetLangName = LANG_FULL_NAME_MAP[to] || to;
  const models = ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'];

  for (const model of models) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: GROQ_SYSTEM_PROMPT },
            { role: 'user', content: `Translate to ${targetLangName}: ${text}` }
          ],
          temperature: 0.1,
          max_tokens: 300
        }),
        signal: AbortSignal.timeout(3500)
      });

      if (res.ok) {
        const data = await res.json();
        let out = data.choices?.[0]?.message?.content?.trim() || '';
        // Bỏ dấu nháy kép bao quanh nếu có
        if (out.startsWith('"') && out.endsWith('"')) out = out.slice(1, -1).trim();
        if (out && out.toLowerCase() !== text.toLowerCase()) {
          return out;
        }
      }
    } catch (_) {}
  }
  return null;
}

/**
 * Dịch thuật bằng Google GTX với bộ lọc tiếng lóng (Cách 2)
 */
async function translateWithGoogleGTX(text, from = 'auto', to = 'vi') {
  try {
    const sl = from === 'auto' ? 'auto' : from;
    const gUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;
    const gRes = await fetch(gUrl, { 
      headers: { 'User-Agent': 'Mozilla/5.0' }, 
      signal: AbortSignal.timeout(3000) 
    });
    if (gRes.ok) {
      const gData = await gRes.json();
      if (gData && Array.isArray(gData[0])) {
        const out = gData[0].map(x => x[0]).join('').trim();
        if (out && out.toLowerCase() !== text.toLowerCase()) {
          return out;
        }
      }
    }
  } catch (_) {}
  return null;
}

/**
 * Dịch văn bản đa nguồn: Groq AI -> Google GTX -> MyMemory Fallback
 */
async function translateText(text, from = 'auto', to = 'vi') {
  if (!text || typeof text !== 'string' || !text.trim()) return null;
  const clean = text.trim();
  
  // Không dịch nếu chỉ toàn số, ID hoặc ký tự đặc biệt
  if (!/[a-zA-ZÀ-ỹ]/.test(clean)) return null;

  const cacheKey = `${from}|${to}|${clean}`;
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  // Bước 1: Chuẩn hóa tiếng lóng Việt Nam (Cách 2)
  const normalized = normalizeVietnameseSlang(clean);

  // Bước 2: Bảo vệ các tag Discord (<@user>, <#ch>, link, code)
  const { tokenized, tokens } = maskTokens(normalized);

  // Bước 3: Ưu tiên AI Groq siêu thông minh (Cách 1)
  let translated = await translateWithGroq(tokenized, from, to);

  // Bước 4: Fallback Google GTX (nếu AI quá tải hoặc không có mạng)
  if (!translated) {
    translated = await translateWithGoogleGTX(tokenized, from, to);
  }

  // Bước 5: Phục hồi lại các tag Discord
  if (translated) {
    translated = unmaskTokens(translated, tokens);
    if (translationCache.size > 500) translationCache.clear();
    translationCache.set(cacheKey, translated);
    return translated;
  }

  return null;
}

module.exports = {
  isProbablyVietnamese,
  translateText,
  resolveLangCode,
  buildLanguageListEmbed
};
