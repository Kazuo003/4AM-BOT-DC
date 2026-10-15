# Discord Commerce Bot (Tickets · Payments · Staff Review · Subscriptions)

Sell VPS/Bot/Web hosting **entirely inside Discord**. Customers create a ticket, choose a plan, submit details, and pay. Staff verify and mark orders as paid. The bot logs sales, DMs receipts, posts stats, and (optionally) manages renewals.

---

## ✨ Features

- **/shop** flow
  - Buttons: **Buy VPS**, **Buy Bot**, **Buy Web**, **Contact Sales**
  - Customer details modal → **auto-creates a ticket channel**
  - Plan selection **inside the ticket** with plan summaries/specs
  - Final details modal (server name, notes), then **Review & Pay** embed

- **Payments**
  - UPI ID support + QR image (either local `assets/upi.png` or a hosted URL via `UPI_QR`)
  - Customer clicks **I Paid** → staff ping & controls show: **Mark as Paid / Reject**
  - When **Paid**:
    - Order marked as `PAID`
    - **Sales log** embed to a channel
    - **Receipt DM** to the buyer
    - (Optional) **Grant role** to buyer (e.g., Customer/Active Sub)
    - **Subscription** upsert/extend (`BILLING_DAYS` configurable)

- **Tickets**
  - Channel per order: permissions restrict visibility
  - Staff tools: **Close / Reopen** ticket buttons

- **Catalog & Admin**
  - Seeded from `src/catalog.js` into DB on boot
  - Staff commands:
    - `/add-product` (name, sku, price)
    - `/set-price` (sku, price)
    - `/toggle-plan` (sku, enabled)
    - `/orders` (list recent orders, ephemeral)
    - `/announce` (post an embed to an announcements channel)
    - `/stats view|post-daily|post-weekly|post-monthly`

- **Sales & Ops**
  - **Admin action log** (approvals, rejections, closes) to channel
  - **Sales log** (“Product Sold” embed: buyer, amount, SKU, spec lines, ticket link)
  - **Stats** posted daily/weekly/monthly to a channel
  - **Rate limiting**: one open ticket per user per X minutes (`RATE_LIMIT_MINUTES`)

- **Renewals (optional)**
  - `Subscription` model with `currentPeriodEnd`
  - Scheduler DMs **3 days before expiry** with **Renew Now** button
  - Renewal opens ticket + creates a fresh order for the same SKU

---

## 🧱 Tech Stack

- **Discord**: discord.js v14
- **DB**: Prisma + SQLite (easy local dev) — can be switched to Postgres in prod
- **Runtime**: Node.js ≥ 18
- **Web**: tiny Express app for health checks
- **Process**: nodemon (dev), pm2/systemd/Docker (prod)

---

## 🖥️ Dashboard UI

- Dashboard 4AM mới đã thay thế hoàn toàn dashboard cũ và được phục vụ ngay tại `/`.
- Chế độ xem dữ liệu mẫu: `/?demo=1`.
- UI là HTML/CSS/JavaScript tĩnh trong `public/`, không cần React hay bước build để chạy.
- Adapter tại `public/js/api.js` chuyển đổi an toàn giữa model UI và cấu trúc `menuData`/order legacy của bot.
- Hướng dẫn tích hợp và checklist kiểm thử: `docs/dashboard.md`.

---

## 📁 Project Structure

```
src/
  bot.js            # Main bot, interaction handlers, schedulers
  commands.js       # Slash command registration
  catalog.js        # Seed catalog into DB
  db.js             # Prisma client
  order.js          # Order/ticket/subscription helpers
  utils.js          # Helpers: formatting etc.
assets/
  upi.png           # Local QR image (optional if UPI_QR is set)
prisma/
  schema.prisma
  migrations/       # Checked-in migrations
.env                # Your secrets (ignored by git)
.env.example        # Safe template (committed)
```

---

## 🚀 Quick Start (Local)

> **Prereqs:** Node.js ≥ 18, a Discord App/Bot (token + client ID), guild where you have admin.

1) **Install**

```bash
git clone <your-org-or-user>/<repo>.git
cd <repo>
npm install
```

2) **Env**  
Create a local `.env` from the template and fill values:

```bash
cp .env.example .env
```

Minimal values to set:
```
DISCORD_BOT_TOKEN=
DISCORD_CLIENT_ID=
GUILD_ID=
DATABASE_URL="file:./prisma/dev.db"
UPI_ID=example@upi
```

3) **DB migrate & generate**

```bash
npm run db:migrate
```

4) **Register commands** (guild-scoped for fast updates)

```bash
npm run register
```

5) **Run**

```bash
npm run dev
```

Open Discord → use **/shop** in your server.

---

## 🧪 Test Checklist

- `/shop` opens the menu (buttons appear ephemeral)
- Clicking a product button shows customer details modal
- After submit → **ticket channel** is created under your category (optional)
- Bot lists plans with spec summaries → choose a plan
- Final details modal → bot posts **Review & Pay** with **UPI** + **I Paid**
- Click **I Paid** → staff gets pinged & sees **Mark as Paid / Reject**
- On **Mark as Paid**:
  - Bot posts “Payment approved”, logs to sales channel
  - Buyer gets a **receipt DM**
  - (If configured) buyer receives **CUSTOMER_ROLE_ID**
  - Subscription row is created/extended

---

## 🔐 Environment Variables

Create a **private** `.env` (do not commit). A public **`.env.example`** is included for reference.

**Discord**
- `DISCORD_BOT_TOKEN` — your bot token
- `DISCORD_CLIENT_ID` — your application (client) ID
- `GUILD_ID` — your server (guild) ID
- `STAFF_ROLE_ID` — role to ping when customer clicks “I Paid” *(optional)*
- `CUSTOMER_ROLE_ID` — role to grant after payment approved *(optional)*

**Channels** *(optional)*
- `ADMIN_LOG_CHANNEL_ID` — admin actions log
- `SALES_LOG_CHANNEL_ID` — sales “Product Sold” embeds
- `STATS_CHANNEL_ID` — stats posts (daily/weekly/monthly)
- `ANNOUNCEMENTS_CHANNEL_ID` — target channel for `/announce`
- `TICKETS_CATEGORY_ID` — category ID for ticket channels

**Payments**
- `UPI_ID` — display string for UPI
- `UPI_QR` — **public** image URL for QR (if not provided, bot uses `assets/upi.png`)

**Database**
- `DATABASE_URL="file:./prisma/dev.db"` (SQLite local)
  - For Postgres: `DATABASE_URL="postgresql://USER:PASS@HOST:5432/DB?schema=public"`

**Business Rules**
- `RATE_LIMIT_MINUTES=10` — time between user ticket openings
- `BILLING_DAYS=30` — renewal cycle for subscriptions

---

## 🏗️ Hosting / Deployment

### Option A: PM2 (bare metal / VM)

1) Copy project to server & set up Node.js ≥ 18.
2) Create a **production** `.env` on server (never commit it).
3) Install deps & migrate:
   ```bash
   npm ci
   npm run db:migrate
   npm run register
   ```
4) Start with **pm2**:
   ```bash
   npm i -g pm2
   pm2 start src/bot.js --name discord-commerce-bot
   pm2 save
   pm2 startup    # optional: auto-start on reboot
   ```

### Option B: Docker

**Dockerfile (example):**
```dockerfile
FROM node:20-alpine

WORKDIR /app

# Install deps first (better caching)
COPY package*.json ./
RUN npm ci

# Copy source
COPY . .

# Build prisma client & run migration at start
RUN npx prisma generate

# The bot uses an HTTP health port (default 3000)
ENV NODE_ENV=production
EXPOSE 3000

CMD ["sh", "-c", "npm run db:migrate && node src/bot.js"]
```

**docker-compose.yml (example):**
```yaml
version: "3.9"
services:
  bot:
    build: .
    restart: unless-stopped
    env_file:
      - .env
    volumes:
      - ./prisma:/app/prisma
      - ./assets:/app/assets
    ports:
      - "3000:3000"
```

Run:
```bash
docker compose up -d --build
```

> For Postgres in production, add a `postgres` service, update `DATABASE_URL`, and run `npm run db:migrate` within the bot container or through init scripts.

---

## 🔧 Switching to Postgres (Production)

1) Change datasource in `prisma/schema.prisma`:
```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```
2) Update `.env` with your Postgres URL.
3) Create a new migration:
```bash
npx prisma migrate dev --name switch_to_postgres
```
4) Redeploy.

---

## 🛡️ Permissions & Security

- **Never commit `.env` or DB files**  
  Keep `.env` local/secret. Share `.env.example` with placeholders.
- Restrict staff commands with `ManageGuild` and/or `STAFF_ROLE_ID` checks.
- Rotate tokens if leaked & remove old app tokens in Discord Developer Portal.
- Use **private** channels for logs (admin/sales/stats).
- Consider separate bot apps (tokens) per environment.

---

## ❗ Troubleshooting

- **Invalid token**  
  Check `DISCORD_BOT_TOKEN` and re-add your bot to the guild.

- **Used disallowed intents**  
  If you enable privileged intents (Members/Presence), update your discord.js usage or disable them in the Developer Portal.

- **`EADDRINUSE: :3000`**  
  Port busy. Kill the old process or change port. This repo includes an auto-fallback to 3001+ (if enabled in `bot.js`).

- **Prisma P2002 unique error (Ticket.channelId)**  
  When attaching a ticket, use `upsert` instead of `create` to avoid duplicates if code runs twice.

- **Images not showing**  
  - If using ephemeral + file upload, Discord may block files. The bot falls back to posting in the ticket channel.
  - If using `UPI_QR` (URL), ensure it’s a **public** HTTPS URL.

- **Stats didn’t post**  
  Ensure `STATS_CHANNEL_ID` is set, and your schedulers run. You can trigger manual posts via `/stats post-daily` etc.

---

## 🧰 Useful Scripts

```jsonc
// package.json
{
  "scripts": {
    "dev": "nodemon src/bot.js",
    "register": "node src/commands.js",
    "db:migrate": "prisma migrate dev --name init",
    "db:studio": "prisma studio",
    "lint": "eslint ."
  }
}
```

- `npm run db:studio` — quick DB view/edit
- `npm run register` — re-register slash commands after changes
- `npm run dev` — run with nodemon (auto-restart on changes)

---

## 📌 Roadmap Ideas

- Coupons / promo codes
- Stripe/PayPal payment integration
- Affiliate referrals
- Automated provisioning (Pterodactyl/WHMCS/Proxmox APIs)
- Fraud rules & abuse throttling
- Customer portal (outside Discord) that syncs with orders

---

## 📝 License

LICENSE

---

## 🤝 Contributing

- Fork & branch: `feat/whatever`
- Run lints/tests before PR
- Describe changes clearly; include screenshots of Discord flows where relevant

---

## 🙋 Support

Open an issue in this repository. For security concerns, use a private channel or security email per org policy.
