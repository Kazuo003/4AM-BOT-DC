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
  ]
};
module.exports = { CATALOG, CURRENCY };