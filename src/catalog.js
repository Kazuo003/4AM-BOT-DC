const CURRENCY = "VNĐ";
const CATALOG = {
  VPS: [
    { name: "VPS Basic (2 Core / 4GB)", sku: "VPS_2C4G", priceCents: 100000, spec: { vcpu: 2, ramGB: 4, diskGB: 50, os: "Ubuntu / Debian / Windows" } },
    { name: "VPS Pro (4 Core / 8GB)", sku: "VPS_4C8G", priceCents: 200000, spec: { vcpu: 4, ramGB: 8, diskGB: 100, os: "Ubuntu / Debian / Windows" } }
  ],
  BOT: [
    { name: "Bot Hosting 1GB", sku: "BOT_1GB", priceCents: 30000, spec: { ramGB: 1, runtime: "Node.js / Python", uptime: "24/7" } },
    { name: "Bot Hosting 2GB", sku: "BOT_2GB", priceCents: 60000, spec: { ramGB: 2, runtime: "Node.js / Python / Java", uptime: "24/7" } }
  ],
  WEB: [
    { name: "Web Hosting Starter", sku: "WEB_START", priceCents: 50000, spec: { storageGB: 10, panel: "cPanel", ssl: "Miễn phí" } },
    { name: "Web Hosting Business", sku: "WEB_BUS", priceCents: 100000, spec: { storageGB: 30, panel: "cPanel", ssl: "Miễn phí" } }
  ],
  VPS_TRIAL: [
    { name: "TRIAL 2-1 (SSD 30GB)", sku: "TRIAL_2_1", priceCents: 55000, spec: { vcpu: 2, ramGB: 1, diskGB: 30, os: "Windows / Linux" } },
    { name: "TRIAL 1-2 (SSD 50GB)", sku: "TRIAL_1_2", priceCents: 70000, spec: { vcpu: 1, ramGB: 2, diskGB: 50, os: "Windows / Linux" } },
    { name: "TRIAL 2-4 (SSD 30-80GB)", sku: "TRIAL_2_4", priceCents: 100000, spec: { vcpu: 2, ramGB: 4, diskGB: 80, os: "Windows / Linux" } },
    { name: "TRIAL 2-8 (SSD 30-60GB)", sku: "TRIAL_2_8", priceCents: 140000, spec: { vcpu: 2, ramGB: 8, diskGB: 60, os: "Windows / Linux" } },
    { name: "TRIAL 4-8 (SSD 160GB)", sku: "TRIAL_4_8", priceCents: 160000, spec: { vcpu: 4, ramGB: 8, diskGB: 160, os: "Windows / Linux" } },
    { name: "TRIAL 4-16 (SSD 120GB)", sku: "TRIAL_4_16", priceCents: 220000, spec: { vcpu: 4, ramGB: 16, diskGB: 120, os: "Windows / Linux" } },
    { name: "TRIAL 6-16 (SSD 320GB)", sku: "TRIAL_6_16", priceCents: 260000, spec: { vcpu: 6, ramGB: 16, diskGB: 320, os: "Windows / Linux" } },
    { name: "TRIAL 8-16 (SSD 200-350GB)", sku: "TRIAL_8_16", priceCents: 300000, spec: { vcpu: 8, ramGB: 16, diskGB: 350, os: "Windows / Linux" } },
    { name: "TRIAL 8-32 (SSD 250-640GB)", sku: "TRIAL_8_32", priceCents: 380000, spec: { vcpu: 8, ramGB: 32, diskGB: 640, os: "Windows / Linux" } }
  ],
  CHATGPT: [
    { name: "1 Tháng (Riêng Tư - BH 24H)", sku: "CHATGPT_PLUS_24H", priceCents: 170000, spec: { duration: "1 tháng", type: "Riêng tư", warranty: "24h" } },
    { name: "1 Tháng (Riêng Tư - BH Full)", sku: "CHATGPT_PLUS_FULL", priceCents: 300000, spec: { duration: "1 tháng", type: "Riêng tư", warranty: "Full tháng" } }
  ],
  GEMINI: [
    { name: "Gemini 5TB (18T - Ko BH)", sku: "GEMINI_5TB_NO_WARRANTY", priceCents: 60000, spec: { duration: "18 tháng", storage: "5TB", warranty: "Không BH", type: "Up acc khách" } },
    { name: "Gemini 5TB (18T - BH Full)", sku: "GEMINI_5TB_FULL_WARRANTY", priceCents: 250000, spec: { duration: "18 tháng", storage: "5TB", warranty: "Full 18 tháng", type: "Up acc khách" } },
    { name: "Add Fam 5TB (18T - Ko BH)", sku: "GEMINI_FAM_NO_WARRANTY", priceCents: 30000, spec: { duration: "18 tháng", storage: "5TB", warranty: "Không BH", type: "Add acc khách vào Fam" } },
    { name: "Add Fam 5TB (18T - BH Full)", sku: "GEMINI_FAM_FULL_WARRANTY", priceCents: 150000, spec: { duration: "18 tháng", storage: "5TB", warranty: "Full 18 tháng", type: "Add acc khách vào Fam" } }
  ],
  SPOTIFY: [
    { name: "1 Tháng", sku: "SPOTIFY_1M", priceCents: 30000, spec: { duration: "1 tháng", warranty: "Full thời gian", type: "Chính chủ" } },
    { name: "6 Tháng", sku: "SPOTIFY_6M", priceCents: 165000, spec: { duration: "6 tháng", warranty: "Full thời gian", type: "Chính chủ" } },
    { name: "12 Tháng", sku: "SPOTIFY_12M", priceCents: 300000, spec: { duration: "12 tháng", warranty: "Full thời gian", type: "Chính chủ" } }
  ],
  CANVA: [
    { name: "1 Tháng (BH Full)", sku: "CANVA_PRO_1M", priceCents: 20000, spec: { duration: "1 tháng", warranty: "Full 1 tháng", type: "Chính chủ" } },
    { name: "1 Năm (BH Full)", sku: "CANVA_PRO_1Y", priceCents: 100000, spec: { duration: "1 năm", warranty: "Full 1 năm", type: "Chính chủ" } }
  ],
  FACEBOOK: [
    { name: "1 Facebook Link", sku: "FB_DAME_LINK", priceCents: 100000, spec: { unit: "1 link", processTime: "30ph-15h" } }
  ]
};
module.exports = { CATALOG, CURRENCY };