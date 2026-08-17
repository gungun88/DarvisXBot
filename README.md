# DarvisXBot

DarvisXBot is a Telegram group and channel management bot backend based on the MVP PRD in `DarvisXBot开发PRD.md`.

## Stack

- Node.js + TypeScript
- grammY for Telegram Bot API
- Fastify for webhook HTTP service
- PostgreSQL + Prisma. Local Docker maps PostgreSQL to `localhost:15433` to avoid conflicts with existing local PostgreSQL instances.
- Redis + BullMQ
- React + Vite for the admin console
- Docker Compose for local infrastructure

## Current Scope

This repository implements the bot and its operating console, including:

- Project bootstrap
- Telegram webhook endpoint
- `/start` inline menu
- `/bind` group/channel binding command
- `/permissions` Bot permission check command
- PostgreSQL schema for MVP entities
- Redis/BullMQ queue definitions
- Local Docker Compose for PostgreSQL, Redis, and the app
- Authenticated SaaS-style admin console and management API
- Scheduled-message and giveaway queues with retry/cancel controls
- Points products, code inventory, redemptions, delivery retry, and refunds
- Bot memberships, NOWPayments orders/IPN activation, and feature quotas
- Moderation events, runtime health, and audit logs

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from the example and fill `BOT_TOKEN`:

```bash
cp .env.example .env
```

3. Start PostgreSQL and Redis:

```bash
docker compose up -d postgres redis
```

4. Generate Prisma client and run the first migration:

```bash
npm run prisma:generate
npm run prisma:migrate
```

5. Start the development bot in local polling mode:

```bash
npm run dev
```

With `BOT_MODE=polling`, Telegram messages are received by long polling, so no public HTTPS webhook URL is needed. Send `/start` to the bot in Telegram to test the menu. The HTTP service still listens on `http://localhost:3000` for health checks and the admin console.

With `BOT_MODE=webhook`, the service listens on `http://localhost:3000` and exposes:

- `GET /health`
- `POST /telegram/webhook`

Production webhook mode requires `WEBHOOK_SECRET`. Configure Telegram with the same secret token so unauthenticated webhook requests are rejected.

## Admin Console

Set `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `ADMIN_JWT_SECRET` in `.env`. Production startup rejects missing or development-default admin credentials.

For frontend development, run the API and Vite server in separate terminals:

```bash
npm run dev:admin-api
npm run dev:admin
```

Open `http://localhost:5173/admin/`. The Vite server proxies `/api` to the Fastify service on port 3000.

For an integrated production-style build:

```bash
npm run build
npm start
```

`npm start` applies committed Prisma migrations before starting the service. The Docker image does the same on container startup.

Open `http://localhost:3000/admin/`. The console covers the dashboard, chats and settings, users and memberships, scheduled messages, giveaways, point adjustments, dependency/queue health, and audit logs. All `/api/admin/*` endpoints except login require a Bearer JWT.

To enable membership checkout, configure `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET`, and the public HTTPS `PUBLIC_BASE_URL` together. The callback endpoint is `POST /api/payments/nowpayments/ipn`; without all three values, the bot does not create payment orders.

For database backups, set `BACKUP_DIR` and ensure the PostgreSQL client tools are installed, then run `npm run db:backup` (or `npm run db:backup:prod` after building). Each custom-format archive is checked with `pg_restore --list` before retention cleanup. Run `npm run db:restore:verify` weekly to restore the newest archive into a temporary database, verify Prisma migrations, and remove the temporary database. The operations page reports missing, stale, or failed backups and restore drills; `RESTORE_MAX_AGE_HOURS` controls the drill deadline. Set `ALERT_WEBHOOK_URL` to receive rate-limited degraded-service notifications. The Docker runtime includes the required tools and persists `/app/backups` through `./backups`.

Before submitting changes, run:

```bash
npm run lint
npm test
npm run build
```

## Telegram Webhook

For production, set `BOT_MODE=webhook`, expose the service over HTTPS, and set the Telegram webhook URL to:

```text
https://your-domain.example/telegram/webhook
```

For local testing, use a tunnel such as Cloudflare Tunnel or ngrok, then call Telegram `setWebhook` with the public HTTPS URL.

## Bot Commands

- `/start`: Show the main menu.
- `/menu`: Show the management menu.
- `/groups`: Select a bound group to manage.
- `/link`: Create a tracked group invite link.
- `/sign_in`: Daily group sign-in for points.
- `/points`: Show your points, or adjust a replied user's points as an admin.
- `/points_rank`: Show the group points ranking.
- `/bind`: Bind the current group/channel after checking the user is an admin and the Bot has required permissions.
- `/permissions`: Show missing Bot admin permissions in the current group/channel.

## Notes

- BotFather privacy mode must be disabled before message filtering/statistics can work in groups.
- The Bot must be added as an administrator to managed groups/channels.
- AI moderation and multi-bot tenancy are outside the current scope. The management console supports owner, admin, operator, and read-only roles.
